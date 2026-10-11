
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ===== config / accounts =====
alter table public.whatsapp_config add column worker_secret text not null default replace(gen_random_uuid()::text,'-','') || replace(gen_random_uuid()::text,'-','');
alter table public.whatsapp_config alter column api_version set default 'v23.0';
update public.whatsapp_config set api_version = 'v23.0' where api_version = 'v21.0';
alter table public.whatsapp_accounts add column portfolio_id text;
alter table public.whatsapp_accounts add column template_cap int not null default 250 check (template_cap > 0);

-- ===== durable queue columns =====
alter table public.message_logs add column attempts int not null default 0;
alter table public.message_logs add column next_attempt_at timestamptz not null default now();
alter table public.message_logs add column locked_until timestamptz;
alter table public.message_logs add column last_error text;
alter table public.message_logs add column sent_at timestamptz;
create index message_logs_queue_idx on public.message_logs (next_attempt_at) where status = 'QUEUED';
create index message_logs_pair_idx on public.message_logs (entity_id, phone_number, sent_at);

-- ===== template mirror of Meta state =====
alter table public.whatsapp_templates add column meta_status text;
alter table public.whatsapp_templates add column meta_status_prev text;
alter table public.whatsapp_templates add column meta_status_at timestamptz;
alter table public.whatsapp_templates add column meta_approved_once boolean not null default false;
alter table public.whatsapp_templates add column parameter_format text not null default 'NAMED' check (parameter_format in ('NAMED','POSITIONAL'));
update public.whatsapp_templates set meta_status = 'APPROVED', meta_approved_once = true, meta_status_at = now() where status = 'APPROVED';

create table public.template_meta_events (
  id bigint generated always as identity primary key,
  template_id uuid not null references public.whatsapp_templates(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  waba_id text,
  kind text not null check (kind in ('create','edit','delete')),
  was_approved boolean not null default false,
  created_at timestamptz not null default now()
);
create index on public.template_meta_events (waba_id, kind, created_at desc);
create index on public.template_meta_events (template_id, kind, created_at desc);
create index on public.template_meta_events (entity_id);
alter table public.template_meta_events enable row level security;

create table public.whatsapp_health (
  entity_id uuid primary key references public.entities(id) on delete cascade,
  checked_at timestamptz not null default now(),
  token_ok boolean, management_ok boolean, messaging_ok boolean,
  quality_rating text, phone_status text, name_status text,
  limit_tier text, limit_value bigint, review_status text, error text
);
alter table public.whatsapp_health enable row level security;

-- ===== queue functions (service role only) =====
create or replace function public.claim_messages(p_limit int, p_lock_seconds int default 120)
returns table (id uuid, entity_id uuid, payload jsonb, phone_number text, attempts int, sent_from text)
language sql security definer set search_path = public as $$
  with cand as (
    select distinct on (m.entity_id, m.phone_number) m.id
    from public.message_logs m
    where m.status = 'QUEUED' and m.next_attempt_at <= now() and (m.locked_until is null or m.locked_until < now())
      and not exists (
        select 1 from public.message_logs r
        where r.entity_id = m.entity_id and r.phone_number = m.phone_number and r.id <> m.id
          and ((r.sent_at is not null and r.sent_at > now() - interval '7 seconds')
               or (r.status = 'QUEUED' and r.locked_until is not null and r.locked_until > now())))
    order by m.entity_id, m.phone_number, m.next_attempt_at, m.created_at
    limit p_limit
  ), picked as (
    select m.id from public.message_logs m where m.id in (select c.id from cand c) for update skip locked
  )
  update public.message_logs u
     set locked_until = now() + make_interval(secs => p_lock_seconds), attempts = u.attempts + 1
    from picked
   where u.id = picked.id
  returning u.id, u.entity_id, u.payload, u.phone_number, u.attempts, u.sent_from;
$$;

create or replace function public.demo_advance() returns int
language plpgsql security definer set search_path = public as $$
declare pending int;
begin
  update public.message_logs set status = 'DELIVERED', updated_at = now()
   where status = 'SENT' and wamid like 'demo.%' and sent_at < now() - interval '1.5 seconds';
  update public.message_logs set status = 'READ', updated_at = now()
   where status = 'DELIVERED' and wamid like 'demo.%' and updated_at < now() - interval '2 seconds' and (abs(hashtext(id::text)) % 10) < 7;
  select count(*) into pending from public.message_logs
   where wamid like 'demo.%' and (status = 'SENT' or (status = 'DELIVERED' and (abs(hashtext(id::text)) % 10) < 7));
  return pending;
end $$;

create or replace function public.apply_status_updates(p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare it jsonb; n int := 0;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    n := n + public.apply_status_update(it->>'wamid', it->>'status', it->'errors');
  end loop;
  return n;
end $$;

-- ===== template status from Meta (webhook and sync) =====
create or replace function public.apply_template_status(p_meta_id text, p_event text, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare ev text := upper(coalesce(p_event,'')); n int;
begin
  if ev not in ('PENDING','APPROVED','REJECTED','IN_APPEAL','PAUSED','DISABLED','ARCHIVED','UNARCHIVED','PENDING_DELETION','DELETED','LIMIT_EXCEEDED','REINSTATED','FLAGGED') then
    return 0;
  end if;
  update public.whatsapp_templates t set
    meta_status_prev = case when ev = 'ARCHIVED' then t.meta_status else t.meta_status_prev end,
    meta_status = case ev when 'UNARCHIVED' then coalesce(t.meta_status_prev, 'APPROVED') when 'REINSTATED' then 'APPROVED' else ev end,
    meta_status_at = now(),
    meta_approved_once = t.meta_approved_once or ev in ('APPROVED','REINSTATED'),
    rejection_reason = case when ev = 'REJECTED' then p_reason when ev in ('APPROVED','REINSTATED') then null else t.rejection_reason end,
    previous_status = case when ev = 'DELETED' and t.status <> 'ARCHIVED' then t.status else t.previous_status end,
    status = case
      when ev in ('APPROVED','REINSTATED') then 'APPROVED'
      when ev = 'REJECTED' then 'REJECTED'
      when ev = 'PENDING' and t.status <> 'ARCHIVED' then 'PENDING_APPROVAL'
      when ev = 'UNARCHIVED' and coalesce(t.meta_status_prev, 'APPROVED') = 'APPROVED' and t.status <> 'ARCHIVED' then 'APPROVED'
      when ev = 'DELETED' then 'ARCHIVED'
      else t.status end
  where t.meta_template_id = p_meta_id;
  get diagnostics n = row_count;
  return n;
end $$;

-- ===== guard: templates keep their Meta identity and are edited in place =====
create or replace function public.guard_template() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  svc boolean := (select auth.uid()) is null;
  content_changed boolean;
  demo boolean := coalesce(public.entity_effective_mode(case when tg_op = 'UPDATE' then old.entity_id else new.entity_id end), 'demo') = 'demo';
begin
  if tg_op = 'INSERT' then
    if not svc then
      new.status := 'DRAFT'; new.version := 1;
      new.meta_template_id := null; new.meta_submitted_at := null; new.meta_name := null;
      new.meta_status := null; new.meta_status_prev := null; new.meta_approved_once := false; new.parameter_format := 'NAMED';
      new.rejection_reason := null; new.previous_status := null;
      new.created_by := (select auth.uid()); new.updated_by := (select auth.uid());
    end if;
  else
    new.updated_at := now();
    if not svc then
      new.updated_by := (select auth.uid());
      new.entity_id := old.entity_id;
      new.created_by := old.created_by;
      new.parameter_format := old.parameter_format;
      content_changed := (new.name, new.category, new.language, new.header_text, new.body_text, new.footer_text, new.variables, new.buttons)
        is distinct from (old.name, old.category, old.language, old.header_text, old.body_text, old.footer_text, old.variables, old.buttons);
      if old.meta_approved_once and new.category <> old.category then
        raise exception 'Meta does not allow changing the category of an approved template. Create a new template instead.';
      end if;
      if old.status = 'ARCHIVED' then
        if content_changed then raise exception 'Archived templates cannot be edited'; end if;
        if new.status <> 'ARCHIVED' then
          if not public.has_perm(old.entity_id, 'template.archive') then raise exception 'Not allowed to restore'; end if;
          new.status := coalesce(old.previous_status, 'DRAFT'); new.previous_status := null;
        end if;
      elsif new.status = 'ARCHIVED' then
        if not public.has_perm(old.entity_id, 'template.archive') then raise exception 'Not allowed to archive'; end if;
        new.previous_status := old.status;
      elsif content_changed then
        if not public.has_perm(old.entity_id, 'template.update') then raise exception 'Not allowed to edit'; end if;
        new.version := old.version + 1; new.status := 'DRAFT';
      elsif new.status <> old.status then
        if old.status = 'DRAFT' and new.status = 'PENDING_APPROVAL' and public.has_perm(old.entity_id,'template.update') then null;
        elsif old.status = 'PENDING_APPROVAL' and new.status = 'DRAFT' and old.meta_submitted_at is null
              and public.has_perm(old.entity_id,'template.update') then null;
        elsif old.status = 'REJECTED' and new.status = 'DRAFT' and public.has_perm(old.entity_id,'template.update') then null;
        elsif old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED','REJECTED') and demo
              and public.has_perm(old.entity_id,'template.submit') then
          new.meta_status := new.status; new.meta_status_at := now();
          new.meta_approved_once := old.meta_approved_once or new.status = 'APPROVED';
        else raise exception 'Invalid status change % to %', old.status, new.status;
        end if;
      end if;
      -- Meta identity belongs to the platform; an edit keeps the id and name so Meta edits it in place
      new.meta_template_id := old.meta_template_id; new.meta_name := old.meta_name;
      if not (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED','REJECTED') and demo) then
        new.meta_status := old.meta_status; new.meta_status_prev := old.meta_status_prev; new.meta_status_at := old.meta_status_at;
        new.meta_approved_once := old.meta_approved_once;
      end if;
      if content_changed then
        new.meta_submitted_at := null; new.rejection_reason := null;
      else
        new.meta_submitted_at := old.meta_submitted_at;
        if not (old.status = 'PENDING_APPROVAL' and new.status = 'REJECTED') then new.rejection_reason := old.rejection_reason; end if;
      end if;
    end if;
  end if;
  if cardinality(new.project_ids) > 0 and exists (
    select 1 from unnest(new.project_ids) pid where not exists (select 1 from public.projects p where p.id = pid and p.entity_id = new.entity_id)
  ) then raise exception 'Projects must belong to the template entity'; end if;
  return new;
end $$;

-- ===== read-only RPCs for the UI =====
create or replace function public.template_edit_budget(p_template uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare t public.whatsapp_templates; d1 int; d30 int; nxt timestamptz;
begin
  select * into t from public.whatsapp_templates where id = p_template;
  if t.id is null or not public.template_visible(t.entity_id, t.project_ids) then return null; end if;
  select count(*) filter (where created_at > now() - interval '24 hours'), count(*) filter (where created_at > now() - interval '30 days'),
         min(created_at) filter (where created_at > now() - interval '24 hours') + interval '24 hours'
    into d1, d30, nxt
    from public.template_meta_events where template_id = p_template and kind = 'edit' and was_approved;
  return jsonb_build_object('last_24h', d1, 'last_30d', d30, 'limit_24h', 1, 'limit_30d', 10, 'next_allowed_at', nxt,
    'limited', t.meta_status = 'APPROVED' and (d1 >= 1 or d30 >= 10));
end $$;

create or replace function public.template_quota()
returns table (entity_id uuid, waba_id text, used int, cap int, created_last_hour int)
language sql stable security definer set search_path = public as $$
  select e.id, a.waba_id,
    (select count(*)::int from public.whatsapp_templates t
       where t.meta_template_id is not null and t.meta_template_id not like 'demo\_%' and coalesce(t.meta_status,'') <> 'DELETED'
         and (t.entity_id = e.id or (a.waba_id is not null and exists (select 1 from public.whatsapp_accounts a2 where a2.entity_id = t.entity_id and a2.waba_id = a.waba_id)))),
    a.template_cap,
    (select count(*)::int from public.template_meta_events ev
       where ev.kind = 'create' and ev.created_at > now() - interval '1 hour'
         and (ev.entity_id = e.id or (a.waba_id is not null and ev.waba_id = a.waba_id)))
  from public.entities e join public.whatsapp_accounts a on a.entity_id = e.id
  where public.has_perm(e.id, 'template.submit');
$$;

create or replace function public.entity_health()
returns table (entity_id uuid, checked_at timestamptz, token_ok boolean, management_ok boolean, messaging_ok boolean,
               quality_rating text, phone_status text, name_status text, limit_tier text, limit_value bigint, review_status text, error text)
language sql stable security definer set search_path = public as $$
  select h.entity_id, h.checked_at, h.token_ok, h.management_ok, h.messaging_ok, h.quality_rating, h.phone_status, h.name_status,
         h.limit_tier, h.limit_value, h.review_status, h.error
  from public.whatsapp_health h where public.is_entity_member(h.entity_id);
$$;

-- pre-send check: messaging limit shared across a business portfolio, plus number health
create or replace function public.dispatch_preflight(p_project uuid, p_owner_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  eid uuid; mode text; portfolio text; lim bigint; h public.whatsapp_health;
  used int := 0; fresh int := 0; warnings jsonb := '[]'::jsonb; blocking boolean := false;
begin
  if not public.can_access_project(p_project, 'message.send') then raise exception 'Not allowed'; end if;
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

-- ===== account save: portfolio and template cap =====
drop function public.save_whatsapp_account(uuid,text,text,text,text,text,text,text,text);
create or replace function public.save_whatsapp_account(
  p_entity uuid, p_label text, p_display_phone text, p_phone_number_id text, p_waba_id text,
  p_access_token text, p_app_secret text, p_api_version text, p_mode text, p_portfolio text default null, p_template_cap int default 250)
returns void language plpgsql security definer set search_path = public as $$
declare cur public.whatsapp_accounts; g public.whatsapp_config;
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  if p_mode not in ('demo','live') then raise exception 'Invalid mode'; end if;
  select * into cur from public.whatsapp_accounts where entity_id = p_entity;
  select * into g from public.whatsapp_config where id = 1;
  if p_mode = 'live' and (
      coalesce(nullif(p_phone_number_id,''), cur.phone_number_id) is null
      or coalesce(nullif(p_waba_id,''), cur.waba_id) is null
      or coalesce(nullif(p_access_token,''), cur.access_token, g.access_token) is null) then
    raise exception 'Live needs a Phone Number ID, a WABA ID and an access token (its own or the shared one)';
  end if;
  insert into public.whatsapp_accounts as a (entity_id, label, display_phone, phone_number_id, waba_id, access_token, app_secret, api_version, mode, portfolio_id, template_cap, updated_by)
  values (p_entity, nullif(p_label,''), nullif(p_display_phone,''), nullif(p_phone_number_id,''), nullif(p_waba_id,''),
          nullif(p_access_token,''), nullif(p_app_secret,''), nullif(p_api_version,''), p_mode, nullif(p_portfolio,''), greatest(coalesce(p_template_cap,250),1), (select auth.uid()))
  on conflict (entity_id) do update set
    label = nullif(p_label,''), display_phone = nullif(p_display_phone,''),
    phone_number_id = coalesce(nullif(p_phone_number_id,''), a.phone_number_id),
    waba_id = coalesce(nullif(p_waba_id,''), a.waba_id),
    access_token = coalesce(nullif(p_access_token,''), a.access_token),
    app_secret = coalesce(nullif(p_app_secret,''), a.app_secret),
    api_version = nullif(p_api_version,''), mode = p_mode, portfolio_id = nullif(p_portfolio,''),
    template_cap = greatest(coalesce(p_template_cap,250),1), updated_at = now(), updated_by = (select auth.uid());
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values ((select auth.uid()), p_entity, 'update', 'whatsapp_accounts', p_entity::text, jsonb_build_object('mode', p_mode, 'token_changed', coalesce(p_access_token,'') <> ''));
end $$;

create or replace function public.get_whatsapp_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.whatsapp_config;
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  select * into c from public.whatsapp_config where id = 1;
  return jsonb_build_object(
    'mode', c.mode, 'api_version', c.api_version, 'has_token', c.access_token is not null, 'has_secret', c.app_secret is not null,
    'verify_token', c.verify_token,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'entity_id', e.id, 'entity', e.name, 'label', a.label, 'display_phone', a.display_phone, 'phone_number_id', a.phone_number_id,
        'waba_id', a.waba_id, 'has_token', a.access_token is not null, 'has_secret', a.app_secret is not null,
        'api_version', a.api_version, 'mode', coalesce(a.mode, 'demo'), 'configured', a.entity_id is not null,
        'portfolio_id', a.portfolio_id, 'template_cap', coalesce(a.template_cap, 250),
        'effective_mode', public.entity_effective_mode(e.id)) order by e.name)
      from public.entities e left join public.whatsapp_accounts a on a.entity_id = e.id), '[]'::jsonb));
end $$;

-- ===== grants =====
revoke execute on function public.claim_messages(int,int), public.demo_advance(), public.apply_status_updates(jsonb) from public, anon, authenticated;
grant execute on function public.claim_messages(int,int), public.demo_advance(), public.apply_status_updates(jsonb) to service_role;
revoke execute on function public.apply_template_status(text,text,text) from public, anon, authenticated;
grant execute on function public.apply_template_status(text,text,text) to service_role;
revoke execute on function public.guard_template() from public, anon, authenticated;
revoke execute on function public.template_edit_budget(uuid), public.template_quota(), public.entity_health(), public.dispatch_preflight(uuid,uuid[]),
  public.save_whatsapp_account(uuid,text,text,text,text,text,text,text,text,text,int), public.get_whatsapp_status() from public, anon;
grant execute on function public.template_edit_budget(uuid), public.template_quota(), public.entity_health(), public.dispatch_preflight(uuid,uuid[]),
  public.save_whatsapp_account(uuid,text,text,text,text,text,text,text,text,text,int), public.get_whatsapp_status() to authenticated;
