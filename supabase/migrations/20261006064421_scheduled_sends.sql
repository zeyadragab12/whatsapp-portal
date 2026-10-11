
-- ===== scheduled sends =====
create table public.scheduled_sends (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  template_id uuid not null references public.whatsapp_templates(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  list_ids uuid[] not null default '{}',          -- the client groups chosen; the clients are looked up when the message goes out
  all_clients boolean not null default false,     -- true = the whole company list (only when the company has no groups)
  run_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled','sending','sent','failed','cancelled')),
  batch_id uuid references public.dispatch_batches(id) on delete set null,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index on public.scheduled_sends (status, run_at);
create index on public.scheduled_sends (sender_id);
create index on public.scheduled_sends (entity_id);
create index on public.scheduled_sends (template_id);
create index on public.scheduled_sends (project_id);
create index on public.scheduled_sends (batch_id);
alter table public.scheduled_sends enable row level security;
-- people see the sends they scheduled; entity admins and people with "see everyone's messages" see the company's. Changes go through the functions below.
create policy scheduled_sends_select on public.scheduled_sends for select
  using (sender_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage') or public.has_perm(entity_id, 'log.all'));

-- ===== the pre-send check, usable without a signed-in user (for the timer) =====
create or replace function public.dispatch_preflight_core(p_project uuid, p_owner_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  eid uuid; mode text; portfolio text; lim bigint; h public.whatsapp_health;
  used int := 0; fresh int := 0; warnings jsonb := '[]'::jsonb; blocking boolean := false;
begin
  select entity_id into eid from public.projects where id = p_project;
  mode := public.entity_effective_mode(eid);
  select coalesce(portfolio_id, 'default') into portfolio from public.whatsapp_accounts where entity_id = eid;
  portfolio := coalesce(portfolio, 'default');
  select * into h from public.whatsapp_health where entity_id = eid;
  select count(distinct ml.phone_number) into used
    from public.message_logs ml join public.whatsapp_accounts a on a.entity_id = ml.entity_id
   where coalesce(a.portfolio_id, 'default') = portfolio and ml.created_at > now() - interval '24 hours'
     and ml.status <> 'FAILED' and ml.sent_from is distinct from 'demo';
  select count(distinct o.phone) into fresh from public.owners o
   where o.id = any(p_owner_ids) and o.phone not in (
     select ml.phone_number from public.message_logs ml join public.whatsapp_accounts a on a.entity_id = ml.entity_id
      where coalesce(a.portfolio_id, 'default') = portfolio and ml.created_at > now() - interval '24 hours'
        and ml.status <> 'FAILED' and ml.sent_from is distinct from 'demo');
  if mode = 'live' then
    lim := h.limit_value;
    if h.entity_id is null or h.checked_at < now() - interval '6 hours' then warnings := warnings || '"HEALTH_STALE"'::jsonb; end if;
    if lim is null then warnings := warnings || '"LIMIT_UNKNOWN"'::jsonb;
    elsif used + fresh > lim then warnings := warnings || '"LIMIT_EXCEEDED"'::jsonb; blocking := true; end if;
    if h.phone_status is not null and h.phone_status not in ('CONNECTED') then warnings := warnings || '"PHONE_NOT_CONNECTED"'::jsonb; blocking := true; end if;
    if h.quality_rating in ('YELLOW','RED') then warnings := warnings || to_jsonb('QUALITY_' || h.quality_rating); end if;
    if h.messaging_ok is false then warnings := warnings || '"TOKEN_CANNOT_SEND"'::jsonb; blocking := true; end if;
  end if;
  return jsonb_build_object('mode', mode, 'portfolio', portfolio, 'limit', lim, 'unique_24h', used, 'new_unique', fresh,
    'quality', h.quality_rating, 'phone_status', h.phone_status, 'checked_at', h.checked_at, 'warnings', warnings, 'blocking', blocking);
end $$;

create or replace function public.dispatch_preflight(p_project uuid, p_owner_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.can_access_project(p_project, 'message.send') then raise exception 'Not allowed'; end if;
  return public.dispatch_preflight_core(p_project, p_owner_ids);
end $$;

-- ===== schedule, change the time, cancel =====
create or replace function public.schedule_send(p_project uuid, p_template uuid, p_list_ids uuid[], p_all boolean, p_run_at timestamptz)
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
  if p_run_at < now() + interval '1 minute' then raise exception 'Choose a time at least a few minutes from now'; end if;
  if p_run_at > now() + interval '1 year' then raise exception 'Schedules can be at most one year ahead'; end if;
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

  insert into public.scheduled_sends (entity_id, project_id, template_id, sender_id, list_ids, all_clients, run_at)
  values (pr.entity_id, p_project, p_template, uid, case when coalesce(p_all, false) then '{}' else p_list_ids end, coalesce(p_all, false), p_run_at)
  returning id into sid;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values (uid, pr.entity_id, 'messages_scheduled', 'scheduled_send', sid::text,
          jsonb_build_object('template', t.name, 'run_at', p_run_at, 'groups', case when coalesce(p_all, false) then 0 else cardinality(p_list_ids) end));
  return sid;
end $$;

create or replace function public.reschedule_send(p_id uuid, p_run_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare s public.scheduled_sends; uid uuid := (select auth.uid());
begin
  select * into s from public.scheduled_sends where id = p_id;
  if s.id is null or not (s.sender_id = uid or public.has_perm(s.entity_id, 'member.manage')) then raise exception 'Not allowed'; end if;
  if s.status <> 'scheduled' then raise exception 'This send can no longer be changed'; end if;
  if p_run_at < now() + interval '1 minute' then raise exception 'Choose a time at least a few minutes from now'; end if;
  if p_run_at > now() + interval '1 year' then raise exception 'Schedules can be at most one year ahead'; end if;
  update public.scheduled_sends set run_at = p_run_at where id = p_id;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values (uid, s.entity_id, 'messages_rescheduled', 'scheduled_send', p_id::text,
          jsonb_build_object('template', (select name from public.whatsapp_templates where id = s.template_id), 'run_at', p_run_at));
end $$;

create or replace function public.cancel_scheduled_send(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.scheduled_sends; uid uuid := (select auth.uid());
begin
  select * into s from public.scheduled_sends where id = p_id;
  if s.id is null or not (s.sender_id = uid or public.has_perm(s.entity_id, 'member.manage')) then raise exception 'Not allowed'; end if;
  if s.status <> 'scheduled' then raise exception 'This send can no longer be cancelled'; end if;
  update public.scheduled_sends set status = 'cancelled', finished_at = now() where id = p_id;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values (uid, s.entity_id, 'messages_schedule_cancelled', 'scheduled_send', p_id::text,
          jsonb_build_object('template', (select name from public.whatsapp_templates where id = s.template_id), 'run_at', s.run_at));
end $$;

-- ===== the timer: every minute, hand each due send to the sending function =====
create or replace function public.run_due_scheduled_sends() returns int
language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; sec text;
begin
  select worker_secret into sec from public.whatsapp_config where id = 1;
  -- a send that started but never finished (the function died) is marked failed instead of hanging forever
  update public.scheduled_sends set status = 'failed', error = 'The send did not finish. Check History to see what went out.', finished_at = now()
   where status = 'sending' and started_at < now() - interval '10 minutes';
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

revoke all on function public.dispatch_preflight_core(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.dispatch_preflight_core(uuid, uuid[]) to service_role;
revoke all on function public.schedule_send(uuid, uuid, uuid[], boolean, timestamptz), public.reschedule_send(uuid, timestamptz), public.cancel_scheduled_send(uuid) from public, anon;
grant execute on function public.schedule_send(uuid, uuid, uuid[], boolean, timestamptz), public.reschedule_send(uuid, timestamptz), public.cancel_scheduled_send(uuid) to authenticated;
revoke all on function public.run_due_scheduled_sends() from public, anon, authenticated;

select cron.schedule('wa-scheduled-sends', '* * * * *', 'select public.run_due_scheduled_sends()');
