
alter table public.projects add column is_default boolean not null default false;
create unique index projects_one_default_per_entity on public.projects (entity_id) where is_default;

insert into public.projects (entity_id, name, code, location, is_default, is_sample)
select e.id, e.name || ' clients', 'L-' || upper(left(regexp_replace(e.slug, '[^a-z0-9]', '', 'g'), 10)) || '-' || substr(e.id::text, 1, 4), null, true, false
from public.entities e where not exists (select 1 from public.projects p where p.entity_id = e.id and p.is_default);

-- fold every client into the entity's list (a client who was in several projects becomes one row)
insert into public.project_owners (project_id, owner_id, unit_no, extra)
select distinct on (d.id, po.owner_id) d.id, po.owner_id, po.unit_no, po.extra
from public.project_owners po
join public.projects p on p.id = po.project_id and not p.is_default
join public.projects d on d.entity_id = p.entity_id and d.is_default
order by d.id, po.owner_id, po.unit_no nulls last
on conflict (project_id, owner_id) do nothing;
delete from public.project_owners po using public.projects p where p.id = po.project_id and not p.is_default;
update public.projects set status = 'archived' where not is_default;

update public.whatsapp_templates set project_ids = '{}' where cardinality(project_ids) > 0;
update public.conversations set project_ids = '{}';
update public.notifications set project_ids = '{}', admin_only = false;

create or replace function public.ensure_default_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.projects (entity_id, name, code, is_default, is_sample)
  values (new.id, new.name || ' clients', 'L-' || upper(left(regexp_replace(new.slug, '[^a-z0-9]', '', 'g'), 10)) || '-' || substr(new.id::text, 1, 4), true, false);
  return new;
end $$;
create trigger entity_default_project after insert on public.entities for each row execute function public.ensure_default_project();
revoke execute on function public.ensure_default_project() from public, anon, authenticated;

create or replace function public.can_access_project(pid uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or exists (
    select 1
    from public.projects pr
    join public.entity_members m on m.entity_id = pr.entity_id and m.user_id = (select auth.uid())
    join public.roles r on r.id = m.role_id
    join public.profiles p on p.id = m.user_id and p.status = 'approved'
    where pr.id = pid and (perm is null or perm = any(r.permissions))
  );
$$;

create or replace function public.template_visible(eid uuid, pids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or public.has_perm(eid, 'template.read');
$$;

create or replace function public.can_view_conversation(eid uuid, pids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or public.has_perm(eid, 'inbox.read');
$$;

create or replace function public.can_see_notification(eid uuid, perm text, pids uuid[], admins_only boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or (eid is not null and perm is not null and public.has_perm(eid, perm));
$$;
