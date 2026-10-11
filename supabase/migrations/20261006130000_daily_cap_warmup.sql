-- Daily send cap and warm-up mode, per company WhatsApp number.
-- daily_cap: most live messages one company may send per day (empty = no cap).
-- warmup_started_on: when set, the number is in warm-up and its daily limit follows a gentle ramp for 14 days.
alter table public.whatsapp_accounts
  add column if not exists daily_cap integer check (daily_cap is null or daily_cap > 0),
  add column if not exists warmup_started_on date;

-- "today" is a Cairo day, because that is when the people sending think a day starts and ends
create or replace function public.cairo_today() returns date
language sql stable set search_path = public as $$ select (now() at time zone 'Africa/Cairo')::date $$;

-- messages allowed per day on each warm-up day; after day 14 the warm-up is finished and only the daily cap (if any) applies
create or replace function public.warmup_limit(p_day int) returns int
language sql immutable set search_path = public as $$
  select case
    when p_day < 1 then 50
    when p_day = 1 then 50
    when p_day = 2 then 100
    when p_day = 3 then 150
    when p_day = 4 then 250
    when p_day = 5 then 400
    when p_day = 6 then 600
    when p_day = 7 then 800
    when p_day <= 14 then 1000
    else null end
$$;

-- How much a company may still send today. Only real (live) messages that did not fail count.
create or replace function public.send_allowance(p_entity uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  a public.whatsapp_accounts;
  day int; wl int; lim int; why text; used int; today_start timestamptz;
begin
  if (select auth.uid()) is not null
     and not (public.is_superadmin() or public.has_perm(p_entity, 'message.send') or public.has_perm(p_entity, 'member.manage')) then
    raise exception 'Not allowed';
  end if;
  select * into a from public.whatsapp_accounts where entity_id = p_entity;
  if a.warmup_started_on is not null then
    day := greatest(1, (public.cairo_today() - a.warmup_started_on) + 1);
    wl := public.warmup_limit(day);
  end if;
  lim := case when wl is null then a.daily_cap when a.daily_cap is null then wl else least(wl, a.daily_cap) end;
  why := case when lim is null then null when wl is not null and (a.daily_cap is null or wl <= a.daily_cap) then 'warmup' else 'cap' end;
  today_start := (public.cairo_today()::timestamp) at time zone 'Africa/Cairo';
  select count(*) into used from public.message_logs
    where entity_id = p_entity and status <> 'FAILED' and coalesce(sent_from, '') <> 'demo' and created_at >= today_start;
  return jsonb_build_object(
    'warmup_on', a.warmup_started_on is not null,
    'warmup_day', day,
    'warmup_done', a.warmup_started_on is not null and wl is null,
    'warmup_limit', wl,
    'daily_cap', a.daily_cap,
    'limit', lim,
    'reason', why,
    'used', used,
    'remaining', case when lim is null then null else greatest(lim - used, 0) end
  );
end $$;

-- Superadmin sets the cap and switches warm-up on or off. Switching it on starts day 1 today.
create or replace function public.save_send_limits(p_entity uuid, p_daily_cap int, p_warmup boolean, p_restart boolean default false)
returns void language plpgsql security definer set search_path = public as $$
declare cur public.whatsapp_accounts;
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  if p_daily_cap is not null and p_daily_cap < 1 then raise exception 'The daily limit must be at least 1'; end if;
  select * into cur from public.whatsapp_accounts where entity_id = p_entity;
  insert into public.whatsapp_accounts as a (entity_id, daily_cap, warmup_started_on, updated_by)
  values (p_entity, p_daily_cap, case when p_warmup then public.cairo_today() end, (select auth.uid()))
  on conflict (entity_id) do update set
    daily_cap = p_daily_cap,
    warmup_started_on = case
      when not p_warmup then null
      when p_restart or a.warmup_started_on is null then public.cairo_today()
      else a.warmup_started_on end,
    updated_at = now(), updated_by = (select auth.uid());
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values ((select auth.uid()), p_entity, 'update', 'whatsapp_accounts', p_entity::text,
          jsonb_build_object('daily_cap', p_daily_cap, 'warmup', p_warmup, 'restarted', p_restart));
end $$;

revoke execute on function public.send_allowance(uuid), public.save_send_limits(uuid, int, boolean, boolean) from public, anon;
grant execute on function public.send_allowance(uuid), public.save_send_limits(uuid, int, boolean, boolean) to authenticated;
