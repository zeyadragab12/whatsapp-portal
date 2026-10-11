
-- ===== access helpers =====
create or replace function public.can_access_project(pid uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or exists (
    select 1
    from public.projects pr
    join public.entity_members m on m.entity_id = pr.entity_id and m.user_id = (select auth.uid())
    join public.roles r on r.id = m.role_id
    join public.profiles p on p.id = m.user_id and p.status = 'approved'
    where pr.id = pid
      and (perm is null or perm = any(r.permissions))
      and ('member.manage' = any(r.permissions)
           or exists (select 1 from public.member_projects mp where mp.user_id = m.user_id and mp.project_id = pr.id))
  );
$$;

create or replace function public.can_send_project(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.can_access_project(pid, 'message.send');
$$;

create or replace function public.template_visible(eid uuid, pids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or (
    public.has_perm(eid, 'template.read') and (
      public.has_perm(eid, 'member.manage') or cardinality(pids) = 0
      or exists (select 1 from public.member_projects mp where mp.user_id = (select auth.uid()) and mp.project_id = any(pids))
    )
  );
$$;

create or replace function public.manages_user(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.entity_members t where t.user_id = uid and public.has_perm(t.entity_id, 'member.manage'));
$$;

-- ===== policies =====
drop policy projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated using (public.can_access_project(id, null));

drop policy owners_select on public.owners;
drop policy powners_select on public.project_owners;
create policy powners_select on public.project_owners for select to authenticated
  using (public.can_access_project(project_id, 'owner.read'));
create policy owners_select on public.owners for select to authenticated
  using (public.is_superadmin() or exists (select 1 from public.project_owners po where po.owner_id = owners.id and public.can_access_project(po.project_id, 'owner.read')));

drop policy templates_select on public.whatsapp_templates;
drop policy templates_insert on public.whatsapp_templates;
drop policy templates_update on public.whatsapp_templates;
create policy wt_select on public.whatsapp_templates for select to authenticated using (public.template_visible(entity_id, project_ids));
create policy wt_insert on public.whatsapp_templates for insert to authenticated with check (public.has_perm(entity_id, 'template.create'));
create policy wt_update on public.whatsapp_templates for update to authenticated
  using (public.template_visible(entity_id, project_ids) and (public.has_perm(entity_id,'template.update') or public.has_perm(entity_id,'template.archive')))
  with check (public.has_perm(entity_id,'template.update') or public.has_perm(entity_id,'template.archive'));

alter table public.dispatch_batches enable row level security;
alter table public.message_logs enable row level security;
alter table public.whatsapp_config enable row level security;
alter table public.message_pricing enable row level security;
alter table public.audit_events enable row level security;

create policy batches_select on public.dispatch_batches for select to authenticated using (public.can_access_project(project_id, 'log.read'));
create policy logs_select on public.message_logs for select to authenticated using (public.can_access_project(project_id, 'log.read'));
create policy pricing_select on public.message_pricing for select to authenticated using (public.is_approved());
create policy pricing_write on public.message_pricing for all to authenticated using (public.is_superadmin()) with check (public.is_superadmin());
create policy audit_select on public.audit_events for select to authenticated
  using (public.is_superadmin() or (entity_id is not null and public.has_perm(entity_id, 'member.manage')));
-- whatsapp_config: no policies, service role and security-definer RPCs only

-- ===== template guard =====
create or replace function public.guard_template() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  svc boolean := (select auth.uid()) is null;
  content_changed boolean;
  demo boolean := coalesce((select mode = 'demo' from public.whatsapp_config where id = 1), true);
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
    if svc then return new; end if;
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
      new.meta_template_id := null; new.meta_submitted_at := null; new.meta_name := null; new.rejection_reason := null;
    elsif new.status <> old.status then
      if old.status = 'DRAFT' and new.status = 'PENDING_APPROVAL' and public.has_perm(old.entity_id,'template.update') then null;
      elsif old.status in ('PENDING_APPROVAL','REJECTED') and new.status = 'DRAFT' and old.meta_submitted_at is null
            and public.has_perm(old.entity_id,'template.update') then null;
      elsif old.status = 'REJECTED' and new.status = 'DRAFT' and public.has_perm(old.entity_id,'template.update') then
        new.meta_template_id := null; new.meta_submitted_at := null; new.meta_name := null;
      elsif old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED','REJECTED') and demo
            and public.has_perm(old.entity_id,'template.submit') then null;
      else raise exception 'Invalid status change % to %', old.status, new.status;
      end if;
    end if;
    -- meta fields are written by the platform only
    if new.status is not distinct from old.status or new.status = 'DRAFT' then
      new.meta_template_id := case when new.status = 'DRAFT' then null else old.meta_template_id end;
    end if;
    if not (old.status = 'PENDING_APPROVAL' and new.status in ('APPROVED','REJECTED')) then
      new.rejection_reason := case when new.status = 'DRAFT' then null else old.rejection_reason end;
    end if;
    new.meta_name := case when new.status = 'DRAFT' and content_changed then null else old.meta_name end;
    new.meta_submitted_at := case when new.status = 'DRAFT' and (content_changed or old.status <> 'DRAFT') then null else old.meta_submitted_at end;
    if new.status = 'DRAFT' and not content_changed and old.status = 'DRAFT' then
      new.meta_name := old.meta_name; new.meta_submitted_at := old.meta_submitted_at; new.meta_template_id := old.meta_template_id;
    end if;
  end if;

  if cardinality(new.project_ids) > 0 and exists (
    select 1 from unnest(new.project_ids) pid where not exists (select 1 from public.projects p where p.id = pid and p.entity_id = new.entity_id)
  ) then raise exception 'Projects must belong to the template entity'; end if;
  return new;
end $$;
create trigger wt_guard before insert or update on public.whatsapp_templates
for each row execute function public.guard_template();

-- ===== owners RPCs =====
create or replace function public.upsert_owner(p_project uuid, p_owner uuid, p_name text, p_phone text, p_email text, p_unit text, p_opt_in boolean)
returns uuid language plpgsql security definer set search_path = public as $$
declare oid uuid := p_owner;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage owners for this project'; end if;
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone must be in E.164 format, for example +201010354164'; end if;
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
  insert into public.project_owners (project_id, owner_id, unit_no) values (p_project, oid, nullif(trim(coalesce(p_unit,'')),''))
  on conflict (project_id, owner_id) do update set unit_no = excluded.unit_no;
  return oid;
end $$;

create or replace function public.import_owners(p_project uuid, p_rows jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; ok int := 0; bad jsonb := '[]'; i int := 0; oid uuid;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage owners for this project'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Import up to 2000 rows at a time'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select o.id into oid from public.owners o join public.project_owners po on po.owner_id = o.id
        where po.project_id = p_project and o.phone = (r->>'phone') and o.full_name = trim(r->>'full_name') limit 1;
      perform public.upsert_owner(p_project, oid, r->>'full_name', r->>'phone', r->>'email', r->>'unit_number', true);
      ok := ok + 1;
    exception when others then
      bad := bad || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('imported', ok, 'failed', bad);
end $$;

create or replace function public.remove_owner(p_project uuid, p_owner uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage owners for this project'; end if;
  delete from public.project_owners where project_id = p_project and owner_id = p_owner;
end $$;

-- ===== config RPCs =====
create or replace function public.whatsapp_mode() returns text
language sql stable security definer set search_path = public as $$
  select mode from public.whatsapp_config where id = 1 and public.is_approved();
$$;

create or replace function public.get_whatsapp_status() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare c public.whatsapp_config;
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  select * into c from public.whatsapp_config where id = 1;
  return jsonb_build_object('mode', c.mode, 'api_version', c.api_version, 'phone_number_id', c.phone_number_id,
    'waba_id', c.waba_id, 'has_token', c.access_token is not null, 'has_secret', c.app_secret is not null,
    'verify_token', c.verify_token, 'updated_at', c.updated_at);
end $$;

create or replace function public.save_whatsapp_config(p_mode text, p_api_version text, p_phone_number_id text, p_waba_id text, p_access_token text, p_app_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  if p_mode not in ('demo','live') then raise exception 'Invalid mode'; end if;
  if p_mode = 'live' and (coalesce(nullif(p_phone_number_id,''), (select phone_number_id from public.whatsapp_config)) is null
     or coalesce(nullif(p_access_token,''), (select access_token from public.whatsapp_config)) is null
     or coalesce(nullif(p_app_secret,''), (select app_secret from public.whatsapp_config)) is null
     or coalesce(nullif(p_waba_id,''), (select waba_id from public.whatsapp_config)) is null) then
    raise exception 'Live mode needs Phone Number ID, WABA ID, access token and app secret';
  end if;
  update public.whatsapp_config set
    mode = p_mode,
    api_version = coalesce(nullif(p_api_version,''), api_version),
    phone_number_id = coalesce(nullif(p_phone_number_id,''), phone_number_id),
    waba_id = coalesce(nullif(p_waba_id,''), waba_id),
    access_token = coalesce(nullif(p_access_token,''), access_token),
    app_secret = coalesce(nullif(p_app_secret,''), app_secret),
    updated_at = now(), updated_by = (select auth.uid())
  where id = 1;
  insert into public.audit_events (actor_id, action, target_type, details)
  values ((select auth.uid()), 'update', 'whatsapp_config', jsonb_build_object('mode', p_mode, 'token_changed', coalesce(p_access_token,'') <> ''));
end $$;

-- ===== webhook helpers (service role only) =====
create or replace function public.msg_rank(s text) returns int language sql immutable set search_path = public as $$
  select case s when 'QUEUED' then 0 when 'SENT' then 1 when 'DELIVERED' then 2 when 'READ' then 3 else 4 end;
$$;

create or replace function public.apply_status_update(p_wamid text, p_status text, p_errors jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.message_logs set status = p_status,
    error_details = case when p_status = 'FAILED' then p_errors else error_details end, updated_at = now()
  where wamid = p_wamid and (
    (p_status = 'FAILED' and public.msg_rank(status) < 2)
    or (p_status <> 'FAILED' and status <> 'FAILED' and public.msg_rank(p_status) > public.msg_rank(status)));
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.apply_template_status(p_meta_id text, p_event text, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.whatsapp_templates set
    status = case upper(p_event) when 'APPROVED' then 'APPROVED' when 'REJECTED' then 'REJECTED' else status end,
    rejection_reason = case when upper(p_event) = 'REJECTED' then p_reason else null end
  where meta_template_id = p_meta_id and status in ('PENDING_APPROVAL','APPROVED','REJECTED');
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.apply_opt_out(p_phone text)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.owners set whatsapp_opt_in = false, opted_out_at = now() where phone = p_phone and whatsapp_opt_in;
  get diagnostics n = row_count;
  return n;
end $$;

-- ===== analytics =====
create or replace function public.analytics_summary(p_entity uuid default null, p_project uuid default null, p_days int default 30)
returns jsonb language sql stable security invoker set search_path = public as $$
  with base as (
    select * from public.message_logs
    where created_at >= now() - make_interval(days => greatest(1, least(p_days, 365)))
      and (p_entity is null or entity_id = p_entity) and (p_project is null or project_id = p_project)
  )
  select jsonb_build_object(
    'total', count(*),
    'sent', count(*) filter (where status in ('SENT','DELIVERED','READ')),
    'delivered', count(*) filter (where status in ('DELIVERED','READ')),
    'read', count(*) filter (where status = 'READ'),
    'failed', count(*) filter (where status = 'FAILED'),
    'queued', count(*) filter (where status = 'QUEUED'),
    'cost', coalesce(sum(cost_estimate) filter (where status <> 'FAILED'), 0),
    'daily', coalesce((
      select jsonb_agg(d order by d.day) from (
        select created_at::date as day, count(*) as total,
               count(*) filter (where status in ('DELIVERED','READ')) as delivered,
               count(*) filter (where status = 'READ') as read,
               count(*) filter (where status = 'FAILED') as failed
        from base group by 1) d), '[]'::jsonb)
  ) from base;
$$;

-- ===== audit =====
create or replace function public.audit_row() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r jsonb := to_jsonb(coalesce(new, old));
  o jsonb := case when tg_op = 'INSERT' then '{}'::jsonb else to_jsonb(old) end;
  n jsonb := to_jsonb(coalesce(new, old));
  eid uuid; det jsonb := '{}'; keys text[];
begin
  eid := case tg_table_name
    when 'entities' then (r->>'id')::uuid
    when 'member_projects' then (select entity_id from public.projects where id = (r->>'project_id')::uuid)
    when 'profiles' then null when 'owners' then null
    else nullif(r->>'entity_id','')::uuid end;
  if tg_op = 'UPDATE' then
    select array_agg(k) into keys from jsonb_object_keys(n) as k
      where k not in ('updated_at','updated_by') and n->k is distinct from o->k;
    if keys is null then return new; end if;
    det := jsonb_build_object('changed', to_jsonb(keys));
    if n->>'status' is distinct from o->>'status' then
      det := det || jsonb_build_object('from', o->>'status', 'to', n->>'status');
    end if;
  end if;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
  values ((select auth.uid()), eid, lower(tg_op), tg_table_name,
          coalesce(r->>'id', concat_ws(':', r->>'user_id', r->>'project_id', r->>'entity_id')), det);
  return coalesce(new, old);
end $$;

create trigger audit_entities after insert or update or delete on public.entities for each row execute function public.audit_row();
create trigger audit_projects after insert or update or delete on public.projects for each row execute function public.audit_row();
create trigger audit_templates after insert or update or delete on public.whatsapp_templates for each row execute function public.audit_row();
create trigger audit_members after insert or update or delete on public.entity_members for each row execute function public.audit_row();
create trigger audit_member_projects after insert or delete on public.member_projects for each row execute function public.audit_row();
create trigger audit_profiles after update on public.profiles for each row execute function public.audit_row();
create trigger audit_owners after insert or update or delete on public.owners for each row execute function public.audit_row();

-- ===== realtime =====
alter publication supabase_realtime add table public.message_logs;
alter publication supabase_realtime add table public.whatsapp_templates;

-- ===== execute grants =====
revoke execute on function public.guard_template() from public, anon, authenticated;
revoke execute on function public.audit_row() from public, anon, authenticated;
revoke execute on function public.apply_status_update(text,text,jsonb) from public, anon, authenticated;
revoke execute on function public.apply_template_status(text,text,text) from public, anon, authenticated;
revoke execute on function public.apply_opt_out(text) from public, anon, authenticated;
revoke execute on function public.msg_rank(text) from public, anon;
revoke execute on function public.can_access_project(uuid,text), public.template_visible(uuid,uuid[]), public.manages_user(uuid), public.can_send_project(uuid) from public, anon;
revoke execute on function public.upsert_owner(uuid,uuid,text,text,text,text,boolean), public.import_owners(uuid,jsonb), public.remove_owner(uuid,uuid) from public, anon;
revoke execute on function public.whatsapp_mode(), public.get_whatsapp_status(), public.save_whatsapp_config(text,text,text,text,text,text) from public, anon;
revoke execute on function public.analytics_summary(uuid,uuid,int) from public, anon;
grant execute on function public.can_access_project(uuid,text), public.template_visible(uuid,uuid[]), public.manages_user(uuid), public.can_send_project(uuid) to authenticated;
grant execute on function public.upsert_owner(uuid,uuid,text,text,text,text,boolean), public.import_owners(uuid,jsonb), public.remove_owner(uuid,uuid) to authenticated;
grant execute on function public.whatsapp_mode(), public.get_whatsapp_status(), public.save_whatsapp_config(text,text,text,text,text,text) to authenticated;
grant execute on function public.analytics_summary(uuid,uuid,int) to authenticated;
grant execute on function public.apply_status_update(text,text,jsonb), public.apply_template_status(text,text,text), public.apply_opt_out(text) to service_role;
