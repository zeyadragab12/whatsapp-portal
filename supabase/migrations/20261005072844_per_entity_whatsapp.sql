
create table public.whatsapp_accounts (
  entity_id uuid primary key references public.entities(id) on delete cascade,
  label text,
  display_phone text check (display_phone is null or display_phone ~ '^\+[1-9][0-9]{7,14}$'),
  phone_number_id text unique,
  waba_id text,
  access_token text,
  app_secret text,
  api_version text,
  mode text not null default 'demo' check (mode in ('demo','live')),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
alter table public.whatsapp_accounts enable row level security; -- no policies: service role and security-definer functions only

create table public.owner_optouts (
  owner_id uuid not null references public.owners(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (owner_id, entity_id)
);
create index on public.owner_optouts (entity_id);
alter table public.owner_optouts enable row level security;
create policy optouts_select on public.owner_optouts for select to authenticated using (public.has_perm(entity_id, 'owner.read'));

alter table public.message_logs add column sent_from text;

alter table public.whatsapp_config drop column phone_number_id;
alter table public.whatsapp_config drop column waba_id;
drop function public.get_whatsapp_status();
drop function public.save_whatsapp_config(text,text,text,text,text,text);

create or replace function public.entity_effective_mode(eid uuid) returns text
language sql stable security definer set search_path = public as $$
  select case when c.mode = 'live' and a.mode = 'live' and a.phone_number_id is not null and a.waba_id is not null
                   and coalesce(a.access_token, c.access_token) is not null then 'live' else 'demo' end
  from public.whatsapp_config c left join public.whatsapp_accounts a on a.entity_id = eid
  where c.id = 1;
$$;

create or replace function public.entity_connections()
returns table (entity_id uuid, display_phone text, label text, connected boolean, mode text)
language sql stable security definer set search_path = public as $$
  select e.id, a.display_phone, a.label, (a.phone_number_id is not null), public.entity_effective_mode(e.id)
  from public.entities e left join public.whatsapp_accounts a on a.entity_id = e.id
  where public.is_entity_member(e.id)
  order by e.name;
$$;

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
        'effective_mode', public.entity_effective_mode(e.id)) order by e.name)
      from public.entities e left join public.whatsapp_accounts a on a.entity_id = e.id), '[]'::jsonb));
end $$;

create or replace function public.save_whatsapp_global(p_mode text, p_api_version text, p_access_token text, p_app_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  if p_mode not in ('demo','live') then raise exception 'Invalid mode'; end if;
  update public.whatsapp_config set
    mode = p_mode,
    api_version = coalesce(nullif(p_api_version,''), api_version),
    access_token = coalesce(nullif(p_access_token,''), access_token),
    app_secret = coalesce(nullif(p_app_secret,''), app_secret),
    updated_at = now(), updated_by = (select auth.uid())
  where id = 1;
  insert into public.audit_events (actor_id, action, target_type, details)
  values ((select auth.uid()), 'update', 'whatsapp_config', jsonb_build_object('mode', p_mode, 'token_changed', coalesce(p_access_token,'') <> ''));
end $$;

create or replace function public.save_whatsapp_account(
  p_entity uuid, p_label text, p_display_phone text, p_phone_number_id text, p_waba_id text,
  p_access_token text, p_app_secret text, p_api_version text, p_mode text)
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
  insert into public.whatsapp_accounts as a (entity_id, label, display_phone, phone_number_id, waba_id, access_token, app_secret, api_version, mode, updated_by)
  values (p_entity, nullif(p_label,''), nullif(p_display_phone,''), nullif(p_phone_number_id,''), nullif(p_waba_id,''),
          nullif(p_access_token,''), nullif(p_app_secret,''), nullif(p_api_version,''), p_mode, (select auth.uid()))
  on conflict (entity_id) do update set
    label = nullif(p_label,''), display_phone = nullif(p_display_phone,''),
    phone_number_id = coalesce(nullif(p_phone_number_id,''), a.phone_number_id),
    waba_id = coalesce(nullif(p_waba_id,''), a.waba_id),
    access_token = coalesce(nullif(p_access_token,''), a.access_token),
    app_secret = coalesce(nullif(p_app_secret,''), a.app_secret),
    api_version = nullif(p_api_version,''), mode = p_mode, updated_at = now(), updated_by = (select auth.uid());
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values ((select auth.uid()), p_entity, 'update', 'whatsapp_accounts', p_entity::text, jsonb_build_object('mode', p_mode, 'token_changed', coalesce(p_access_token,'') <> ''));
end $$;

create or replace function public.delete_whatsapp_account(p_entity uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  delete from public.whatsapp_accounts where entity_id = p_entity;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id)
  values ((select auth.uid()), p_entity, 'delete', 'whatsapp_accounts', p_entity::text);
end $$;

drop function public.apply_opt_out(text);
create or replace function public.apply_opt_out(p_phone text, p_phone_number_id text)
returns int language plpgsql security definer set search_path = public as $$
declare n int; eid uuid;
begin
  select entity_id into eid from public.whatsapp_accounts where phone_number_id = p_phone_number_id;
  if eid is null then return 0; end if;
  insert into public.owner_optouts (owner_id, entity_id)
  select distinct o.id, eid from public.owners o
    join public.project_owners po on po.owner_id = o.id
    join public.projects pr on pr.id = po.project_id and pr.entity_id = eid
  where o.phone = p_phone
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.upsert_owner(p_project uuid, p_owner uuid, p_name text, p_phone text, p_email text, p_unit text, p_opt_in boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid := p_owner; eid uuid;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage owners for this project'; end if;
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone must be in E.164 format, for example +201010354164'; end if;
  select entity_id into eid from public.projects where id = p_project;
  if oid is null then
    insert into public.owners (full_name, phone, email, whatsapp_opt_in, opted_out_at)
    values (trim(p_name), p_phone, nullif(trim(coalesce(p_email,'')),''), p_opt_in, case when p_opt_in then null else now() end)
    returning id into oid;
  else
    if not exists (select 1 from public.project_owners where project_id = p_project and owner_id = oid) then
      raise exception 'Owner is not linked to this project';
    end if;
    update public.owners set full_name = trim(p_name), phone = p_phone, email = nullif(trim(coalesce(p_email,'')),''),
      whatsapp_opt_in = p_opt_in,
      opted_out_at = case when p_opt_in then null when whatsapp_opt_in then now() else opted_out_at end
    where id = oid;
  end if;
  if p_opt_in then delete from public.owner_optouts where owner_id = oid and entity_id = eid; end if;
  insert into public.project_owners (project_id, owner_id, unit_no) values (p_project, oid, nullif(trim(coalesce(p_unit,'')),''))
  on conflict (project_id, owner_id) do update set unit_no = excluded.unit_no;
  return oid;
end $$;

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
      new.rejection_reason := null; new.previous_status := null;
      new.created_by := (select auth.uid()); new.updated_by := (select auth.uid());
    end if;
  else
    new.updated_at := now();
    if not svc then
      new.updated_by := (select auth.uid());
      new.entity_id := old.entity_id;
      new.created_by := old.created_by;
      content_changed := (new.name, new.category, new.language, new.header_text, new.body_text, new.footer_text, new.variables, new.buttons)
        is distinct from (old.name, old.category, old.language, old.header_text, old.body_text, old.footer_text, old.variables, old.buttons);
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
              and public.has_perm(old.entity_id,'template.submit') then null;
        else raise exception 'Invalid status change % to %', old.status, new.status;
        end if;
      end if;
      if content_changed or (old.status = 'REJECTED' and new.status = 'DRAFT') then
        new.meta_template_id := null; new.meta_submitted_at := null; new.meta_name := null; new.rejection_reason := null;
      else
        new.meta_template_id := old.meta_template_id; new.meta_submitted_at := old.meta_submitted_at; new.meta_name := old.meta_name;
        if not (old.status = 'PENDING_APPROVAL' and new.status = 'REJECTED') then new.rejection_reason := old.rejection_reason; end if;
      end if;
    end if;
  end if;
  if cardinality(new.project_ids) > 0 and exists (
    select 1 from unnest(new.project_ids) pid where not exists (select 1 from public.projects p where p.id = pid and p.entity_id = new.entity_id)
  ) then raise exception 'Projects must belong to the template entity'; end if;
  return new;
end $$;

revoke execute on function public.guard_template() from public, anon, authenticated;
revoke execute on function public.apply_opt_out(text,text) from public, anon, authenticated;
grant execute on function public.apply_opt_out(text,text) to service_role;
revoke execute on function public.entity_effective_mode(uuid), public.entity_connections(), public.get_whatsapp_status(),
  public.save_whatsapp_global(text,text,text,text), public.save_whatsapp_account(uuid,text,text,text,text,text,text,text,text),
  public.delete_whatsapp_account(uuid), public.whatsapp_mode() from public, anon;
grant execute on function public.entity_connections(), public.get_whatsapp_status(), public.save_whatsapp_global(text,text,text,text),
  public.save_whatsapp_account(uuid,text,text,text,text,text,text,text,text), public.delete_whatsapp_account(uuid), public.whatsapp_mode() to authenticated;
grant execute on function public.entity_effective_mode(uuid) to service_role;
