
create extension if not exists pgcrypto;

-- ===== tables =====
create table public.entities (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  created_at timestamptz not null default now()
);

create table public.roles (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  permissions text[] not null default '{}',
  is_system boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null unique,
  full_name text,
  status text not null default 'pending' check (status in ('pending','approved','rejected','suspended')),
  is_superadmin boolean not null default false,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz,
  reviewed_by uuid references public.profiles(id)
);

create table public.entity_members (
  user_id uuid not null references public.profiles(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  role_id uuid not null references public.roles(id),
  created_at timestamptz not null default now(),
  primary key (user_id, entity_id)
);

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  name text not null,
  location text,
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.member_projects (
  user_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  primary key (user_id, project_id)
);

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null check (phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_sample boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.project_owners (
  project_id uuid not null references public.projects(id) on delete cascade,
  owner_id uuid not null references public.owners(id) on delete cascade,
  unit_no text,
  primary key (project_id, owner_id)
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  name text not null,
  language text not null default 'en' check (language in ('en','ar')),
  body text not null,
  meta_status text not null default 'draft' check (meta_status in ('draft','pending','approved','rejected')),
  version int not null default 1,
  archived_at timestamptz,
  created_by uuid references public.profiles(id),
  updated_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates(id),
  project_id uuid not null references public.projects(id),
  sent_by uuid not null references public.profiles(id),
  mode text not null check (mode in ('demo','live')),
  recipient_count int not null default 0,
  created_at timestamptz not null default now()
);

create table public.message_recipients (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  owner_id uuid not null references public.owners(id),
  phone text not null,
  rendered_body text not null,
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed')),
  error text,
  provider_message_id text,
  updated_at timestamptz not null default now()
);

create table public.app_settings (
  key text primary key,
  value text not null
);

create index on public.entity_members (entity_id);
create index on public.projects (entity_id);
create index on public.member_projects (project_id);
create index on public.project_owners (owner_id);
create index on public.templates (entity_id);
create index on public.messages (project_id);
create index on public.messages (sent_by);
create index on public.messages (template_id);
create index on public.message_recipients (message_id);
create index on public.message_recipients (owner_id);

-- ===== helper functions =====
create or replace function public.is_approved() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'approved');
$$;

create or replace function public.is_superadmin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.status = 'approved' and p.is_superadmin);
$$;

create or replace function public.has_perm(eid uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or exists (
    select 1
    from public.entity_members m
    join public.roles r on r.id = m.role_id
    join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid()) and m.entity_id = eid
      and p.status = 'approved' and perm = any(r.permissions)
  );
$$;

create or replace function public.is_entity_member(eid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or exists (
    select 1 from public.entity_members m join public.profiles p on p.id = m.user_id
    where m.user_id = (select auth.uid()) and m.entity_id = eid and p.status = 'approved'
  );
$$;

create or replace function public.can_send_project(pid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or exists (
    select 1 from public.member_projects mp
    join public.projects pr on pr.id = mp.project_id
    where mp.user_id = (select auth.uid()) and mp.project_id = pid
      and public.has_perm(pr.entity_id, 'message.send')
  );
$$;

-- ===== signup: domain restriction + profile creation =====
create or replace function public.enforce_company_domain() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email is null or lower(new.email) !~ '^[^@\s]+@thegdevelopments\.com$' then
    raise exception 'Only @thegdevelopments.com email addresses can register.' using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger enforce_company_domain before insert or update of email on auth.users
for each row execute function public.enforce_company_domain();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_admin boolean := lower(new.email) = 'zeyad.ragab@thegdevelopments.com';
begin
  insert into public.profiles (id, email, full_name, status, is_superadmin)
  values (new.id, lower(new.email),
          coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email,'@',1)),
          case when first_admin then 'approved' else 'pending' end,
          first_admin);
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
for each row execute function public.handle_new_user();

-- ===== RPCs =====
create or replace function public.preview_recipients(p_project uuid)
returns table (owner_id uuid, full_name text, phone text, unit_no text)
language sql stable security definer set search_path = public as $$
  select o.id, o.full_name, o.phone, po.unit_no
  from public.project_owners po join public.owners o on o.id = po.owner_id
  where po.project_id = p_project and public.can_send_project(p_project)
  order by o.full_name;
$$;

create or replace function public.send_message(p_template uuid, p_project uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  t public.templates;
  pr public.projects;
  mid uuid;
  cnt int;
begin
  select * into t from public.templates where id = p_template;
  select * into pr from public.projects where id = p_project;
  if t.id is null or pr.id is null then raise exception 'Template or project not found'; end if;
  if t.archived_at is not null then raise exception 'Archived templates cannot be sent'; end if;
  if t.entity_id <> pr.entity_id then raise exception 'Template and project belong to different entities'; end if;
  if not public.has_perm(t.entity_id, 'message.send') or not public.can_send_project(p_project) then
    raise exception 'You are not allowed to send for this project';
  end if;

  insert into public.messages (template_id, project_id, sent_by, mode)
  values (t.id, pr.id, (select auth.uid()), 'demo') returning id into mid;

  insert into public.message_recipients (message_id, owner_id, phone, rendered_body, status)
  select mid, o.id, o.phone,
    replace(replace(replace(replace(t.body,
      '{{owner_name}}', o.full_name),
      '{{unit_no}}', coalesce(po.unit_no,'')),
      '{{project_name}}', pr.name),
      '{{entity_name}}', (select e.name from public.entities e where e.id = pr.entity_id)),
    'delivered'
  from public.project_owners po join public.owners o on o.id = po.owner_id
  where po.project_id = pr.id;

  get diagnostics cnt = row_count;
  update public.messages set recipient_count = cnt where id = mid;
  return mid;
end $$;

create or replace function public.touch_template() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  if tg_op = 'UPDATE' and new.body is distinct from old.body then
    new.version := old.version + 1;
    new.meta_status := 'draft';
  end if;
  return new;
end $$;
create trigger templates_touch before update on public.templates
for each row execute function public.touch_template();

-- ===== RLS =====
alter table public.entities enable row level security;
alter table public.roles enable row level security;
alter table public.profiles enable row level security;
alter table public.entity_members enable row level security;
alter table public.projects enable row level security;
alter table public.member_projects enable row level security;
alter table public.owners enable row level security;
alter table public.project_owners enable row level security;
alter table public.templates enable row level security;
alter table public.messages enable row level security;
alter table public.message_recipients enable row level security;
alter table public.app_settings enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or public.is_superadmin());
create policy profiles_update on public.profiles for update to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- entities
create policy entities_select on public.entities for select to authenticated
  using (public.is_entity_member(id));
create policy entities_write on public.entities for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- roles
create policy roles_select on public.roles for select to authenticated using (public.is_approved());
create policy roles_write on public.roles for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- entity_members
create policy members_select on public.entity_members for select to authenticated
  using (user_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage'));
create policy members_write on public.entity_members for all to authenticated
  using (public.has_perm(entity_id, 'member.manage')) with check (public.has_perm(entity_id, 'member.manage'));

-- projects
create policy projects_select on public.projects for select to authenticated
  using (public.is_entity_member(entity_id));
create policy projects_write on public.projects for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- member_projects
create policy mproj_select on public.member_projects for select to authenticated
  using (user_id = (select auth.uid()) or exists (select 1 from public.projects p where p.id = project_id and public.has_perm(p.entity_id,'member.manage')));
create policy mproj_write on public.member_projects for all to authenticated
  using (exists (select 1 from public.projects p where p.id = project_id and public.has_perm(p.entity_id,'member.manage')))
  with check (exists (select 1 from public.projects p where p.id = project_id and public.has_perm(p.entity_id,'member.manage')));

-- owners and project_owners (read by senders of that project, write superadmin)
create policy powners_select on public.project_owners for select to authenticated
  using (public.can_send_project(project_id) or public.is_superadmin());
create policy powners_write on public.project_owners for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());
create policy owners_select on public.owners for select to authenticated
  using (public.is_superadmin() or exists (select 1 from public.project_owners po where po.owner_id = id and public.can_send_project(po.project_id)));
create policy owners_write on public.owners for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- templates
create policy templates_select on public.templates for select to authenticated
  using (public.has_perm(entity_id,'template.read'));
create policy templates_insert on public.templates for insert to authenticated
  with check (public.has_perm(entity_id,'template.create'));
create policy templates_update on public.templates for update to authenticated
  using (public.has_perm(entity_id,'template.update') or public.has_perm(entity_id,'template.archive'))
  with check (public.has_perm(entity_id,'template.update') or public.has_perm(entity_id,'template.archive'));

-- messages (inserted only via send_message)
create policy messages_select on public.messages for select to authenticated
  using (sent_by = (select auth.uid()) or public.is_superadmin()
         or exists (select 1 from public.projects p where p.id = project_id and public.has_perm(p.entity_id,'log.read')));
create policy recipients_select on public.message_recipients for select to authenticated
  using (exists (select 1 from public.messages m where m.id = message_id));

-- app_settings
create policy settings_select on public.app_settings for select to authenticated using (public.is_approved());
create policy settings_write on public.app_settings for all to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

-- lock down function execution
revoke execute on function public.send_message(uuid,uuid) from public, anon;
revoke execute on function public.preview_recipients(uuid) from public, anon;
grant execute on function public.send_message(uuid,uuid) to authenticated;
grant execute on function public.preview_recipients(uuid) to authenticated;
revoke execute on function public.is_approved(), public.is_superadmin(), public.has_perm(uuid,text), public.is_entity_member(uuid), public.can_send_project(uuid) from public, anon;
grant execute on function public.is_approved(), public.is_superadmin(), public.has_perm(uuid,text), public.is_entity_member(uuid), public.can_send_project(uuid) to authenticated;
