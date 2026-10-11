
-- Repeating sends: a schedule can repeat every day or every week at the same clock time (daylight saving included).
alter table public.scheduled_sends
  add column repeat text not null default 'none' check (repeat in ('none', 'daily', 'weekly')),
  add column repeat_until timestamptz,                  -- no more sends after this moment; null = until cancelled
  add column timezone text not null default 'UTC',      -- the person's time zone, so "9:00 AM" stays 9:00 AM all year
  add column run_count int not null default 0,          -- how many times it has gone out
  add column fail_streak int not null default 0,        -- runs that failed one after another (3 stops the repeat)
  add column last_run_at timestamptz;

-- the next time a repeating send is due: the same wall-clock time, one day or one week on, and always in the future
create or replace function public.next_run_at(p_from timestamptz, p_repeat text, p_tz text) returns timestamptz
language plpgsql stable set search_path = public as $$
declare n timestamptz := p_from; step interval := case p_repeat when 'daily' then interval '1 day' when 'weekly' then interval '7 days' end; i int := 0;
begin
  if step is null then return null; end if;
  loop
    n := ((n at time zone p_tz) + step) at time zone p_tz;
    i := i + 1;
    exit when n > now() or i > 4000;
  end loop;
  return n;
end $$;

-- called by the sending function when a run is over: one-off sends are done; repeating ones move to their next time
create or replace function public.finish_scheduled_send(p_id uuid, p_ok boolean, p_batch uuid default null, p_result jsonb default null, p_error text default null) returns void
language plpgsql security definer set search_path = public as $$
declare s public.scheduled_sends; nxt timestamptz; streak int;
begin
  select * into s from public.scheduled_sends where id = p_id for update;
  if s.id is null or s.status <> 'sending' then return; end if;
  streak := case when p_ok then 0 else s.fail_streak + 1 end;
  if s.repeat = 'none' then
    update public.scheduled_sends set status = case when p_ok then 'sent' else 'failed' end, batch_id = coalesce(p_batch, batch_id),
      result = p_result, error = p_error, finished_at = now(), last_run_at = now(), run_count = run_count + case when p_ok then 1 else 0 end, fail_streak = streak
     where id = p_id;
    return;
  end if;
  nxt := public.next_run_at(s.run_at, s.repeat, s.timezone);
  if streak >= 3 then
    update public.scheduled_sends set status = 'failed', batch_id = coalesce(p_batch, batch_id), result = coalesce(p_result, result),
      error = 'Stopped after 3 failed runs in a row. ' || coalesce(p_error, ''), finished_at = now(), last_run_at = now(), fail_streak = streak where id = p_id;
  elsif s.repeat_until is not null and nxt > s.repeat_until then
    update public.scheduled_sends set status = 'sent', batch_id = coalesce(p_batch, batch_id), result = coalesce(p_result, result), error = p_error,
      finished_at = now(), last_run_at = now(), run_count = run_count + case when p_ok then 1 else 0 end, fail_streak = streak where id = p_id;
  else
    update public.scheduled_sends set status = 'scheduled', run_at = nxt, batch_id = coalesce(p_batch, batch_id), result = coalesce(p_result, result), error = p_error,
      started_at = null, last_run_at = now(), run_count = run_count + case when p_ok then 1 else 0 end, fail_streak = streak where id = p_id;
  end if;
end $$;

-- scheduling now takes the repeat choice
drop function public.schedule_send(uuid, uuid, uuid[], boolean, timestamptz);
create or replace function public.schedule_send(p_project uuid, p_template uuid, p_list_ids uuid[], p_all boolean, p_run_at timestamptz,
                                                p_repeat text default 'none', p_until timestamptz default null, p_timezone text default 'UTC')
returns uuid language plpgsql security definer set search_path = public as $$
declare pr public.projects; t public.whatsapp_templates; uid uuid := (select auth.uid()); sid uuid; scope uuid[]; valid int; pending int;
begin
  if not public.can_access_project(p_project, 'message.send') then raise exception 'You are not allowed to send to this client list'; end if;
  select * into pr from public.projects where id = p_project;
  select * into t from public.whatsapp_templates where id = p_template;
  if pr.id is null or t.id is null or t.entity_id <> pr.entity_id then raise exception 'Template or client list not found'; end if;
  if t.status <> 'APPROVED' or (t.meta_status is not null and t.meta_status not in ('APPROVED','FLAGGED')) then
    raise exception 'Only approved templates can be scheduled';
  end if;
  if p_repeat not in ('none', 'daily', 'weekly') then raise exception 'Choose how often it repeats'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then raise exception 'Unknown time zone'; end if;
  if p_run_at < now() + interval '1 minute' then raise exception 'Choose a time at least a few minutes from now'; end if;
  if p_run_at > now() + interval '1 year' then raise exception 'Schedules can be at most one year ahead'; end if;
  if p_repeat <> 'none' and p_until is not null and p_until <= p_run_at then raise exception 'The end date must be after the first send'; end if;
  scope := public.scope_lists(pr.entity_id);
  if coalesce(p_all, false) then
    if scope is not null then raise exception 'Choose one or more groups'; end if;
  else
    if coalesce(cardinality(p_list_ids), 0) = 0 then raise exception 'Choose at least one group'; end if;
    select count(*) into valid from public.client_lists l
     where l.id = any(p_list_ids) and l.entity_id = pr.entity_id and (scope is null or l.id = any(scope));
    if valid <> (select count(distinct x) from unnest(p_list_ids) x) then raise exception 'One of the groups is not available'; end if;
  end if;
  select count(*) into pending from public.scheduled_sends where sender_id = uid and status = 'scheduled';
  if pending >= 50 then raise exception 'You already have 50 scheduled sends. Cancel one first.'; end if;

  insert into public.scheduled_sends (entity_id, project_id, template_id, sender_id, list_ids, all_clients, run_at, repeat, repeat_until, timezone)
  values (pr.entity_id, p_project, p_template, uid, case when coalesce(p_all, false) then '{}' else p_list_ids end, coalesce(p_all, false), p_run_at,
          p_repeat, case when p_repeat = 'none' then null else p_until end, p_timezone)
  returning id into sid;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values (uid, pr.entity_id, 'messages_scheduled', 'scheduled_send', sid::text,
          jsonb_build_object('template', t.name, 'run_at', p_run_at, 'repeat', p_repeat, 'groups', case when coalesce(p_all, false) then 0 else cardinality(p_list_ids) end));
  return sid;
end $$;

-- the timer: a run that hung is now settled through the same function, so a repeating send is not lost
create or replace function public.run_due_scheduled_sends() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; sec text;
begin
  select worker_secret into sec from public.whatsapp_config where id = 1;
  for r in select id from public.scheduled_sends where status = 'sending' and started_at < now() - interval '10 minutes' loop
    perform public.finish_scheduled_send(r.id, false, null, null, 'The send did not finish. Check History to see what went out.');
  end loop;
  for r in update public.scheduled_sends set status = 'sending', started_at = now()
            where status = 'scheduled' and run_at <= now() returning id loop
    perform net.http_post(
      url := 'https://lylcugsxxidcbldedmyp.supabase.co/functions/v1/send-whatsapp-template',
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', sec),
      body := jsonb_build_object('scheduled_id', r.id), timeout_milliseconds := 30000);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.next_run_at(timestamptz, text, text) from public, anon, authenticated;
revoke all on function public.finish_scheduled_send(uuid, boolean, uuid, jsonb, text) from public, anon, authenticated;
grant execute on function public.next_run_at(timestamptz, text, text), public.finish_scheduled_send(uuid, boolean, uuid, jsonb, text) to service_role;
revoke all on function public.schedule_send(uuid, uuid, uuid[], boolean, timestamptz, text, timestamptz, text) from public, anon;
grant execute on function public.schedule_send(uuid, uuid, uuid[], boolean, timestamptz, text, timestamptz, text) to authenticated;
revoke all on function public.run_due_scheduled_sends() from public, anon, authenticated;
