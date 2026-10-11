-- fields belong to a list: the Add client form only shows the fields of the chosen list
create table public.client_list_fields (
  list_id uuid not null references public.client_lists(id) on delete cascade,
  key text not null,
  primary key (list_id, key)
);
alter table public.client_list_fields enable row level security;
create policy client_list_fields_select on public.client_list_fields for select to authenticated
  using (exists (select 1 from public.client_lists l where l.id = list_id));

-- existing lists keep the fields their clients actually have
insert into public.client_list_fields (list_id, key)
select distinct m.list_id, k.key
from public.client_list_members m
join public.project_owners po on po.owner_id = m.owner_id
cross join lateral jsonb_object_keys(po.extra) as k(key)
join public.client_lists l on l.id = m.list_id
join public.owner_fields f on f.entity_id = l.entity_id and f.key = k.key
on conflict do nothing;

create or replace function public.create_client_list(p_project uuid, p_name text, p_fields jsonb default '{}')
returns uuid language plpgsql security definer set search_path = public as $$
declare eid uuid; lid uuid; k text; v text; keys text[] := '{}'; nm text := trim(coalesce(p_name, ''));
        reserved text[] := array['owner_name','unit_number','phone','email','project_name','project_code','entity_name'];
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  if length(nm) = 0 then raise exception 'The list needs a name'; end if;
  select entity_id into eid from public.projects where id = p_project;
  for k, v in select key, value from jsonb_each_text(coalesce(p_fields, '{}'::jsonb)) loop
    if k = any(reserved) or k !~ '^[a-z][a-z0-9_]{0,40}$' then raise exception 'Invalid field name %', v; end if;
    if coalesce(trim(v), '') = '' then continue; end if;
    if (select count(*) from public.owner_fields where entity_id = eid) >= 30
       and not exists (select 1 from public.owner_fields where entity_id = eid and key = k) then
      raise exception 'A company can have at most 30 custom fields';
    end if;
    insert into public.owner_fields (entity_id, key, label) values (eid, k, left(trim(v), 80))
    on conflict (entity_id, key) do nothing;
    keys := keys || k;
  end loop;
  insert into public.client_lists (entity_id, name, created_by) values (eid, left(nm, 80), (select auth.uid())) returning id into lid;
  insert into public.client_list_fields (list_id, key) select lid, x from unnest(keys) x;
  return lid;
exception when unique_violation then raise exception 'A list with this name already exists';
end $$;
