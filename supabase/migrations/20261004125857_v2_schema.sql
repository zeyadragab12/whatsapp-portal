
-- entities / projects / owners
alter table public.entities add column status text not null default 'active' check (status in ('active','inactive'));
alter table public.projects add column code text;
alter table public.projects add column status text not null default 'active' check (status in ('active','archived'));
update public.projects set code = 'P-' || upper(substr(id::text,1,6)) where code is null;
alter table public.projects alter column code set not null;
create unique index projects_code_key on public.projects (code);

alter table public.owners add column email text;
alter table public.owners add column whatsapp_opt_in boolean not null default true;
alter table public.owners add column opted_out_at timestamptz;
alter table public.owners add column status text not null default 'active' check (status in ('active','inactive'));

-- remove v1 messaging tables
drop function if exists public.send_message(uuid, uuid);
drop function if exists public.preview_recipients(uuid);
drop table public.message_recipients;
drop table public.messages;
drop table public.app_settings;

-- templates -> whatsapp_templates
alter table public.templates rename to whatsapp_templates;
alter table public.whatsapp_templates rename column body to body_text;
drop trigger templates_touch on public.whatsapp_templates;
drop function public.touch_template();

alter table public.whatsapp_templates
  add column category text not null default 'UTILITY' check (category in ('UTILITY','MARKETING','AUTHENTICATION')),
  add column header_text text,
  add column footer_text text,
  add column variables jsonb not null default '[]',
  add column buttons jsonb not null default '[]',
  add column project_ids uuid[] not null default '{}',
  add column status text,
  add column previous_status text,
  add column meta_name text,
  add column meta_template_id text,
  add column meta_submitted_at timestamptz,
  add column rejection_reason text;

update public.whatsapp_templates set status = case
  when archived_at is not null then 'ARCHIVED'
  when meta_status = 'pending' then 'PENDING_APPROVAL'
  when meta_status = 'approved' then 'APPROVED'
  when meta_status = 'rejected' then 'REJECTED'
  else 'DRAFT' end;
alter table public.whatsapp_templates alter column status set not null;
alter table public.whatsapp_templates alter column status set default 'DRAFT';
alter table public.whatsapp_templates add check (status in ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','ARCHIVED'));
alter table public.whatsapp_templates drop column meta_status;
alter table public.whatsapp_templates drop column archived_at;

update public.whatsapp_templates set
  meta_name = 'sample_welcome_notice', meta_template_id = 'demo_sample', meta_submitted_at = now(),
  variables = '[{"name":"owner_name","example":"Zeyad Ragab","source":"owner.full_name"},{"name":"entity_name","example":"G Communities","source":"entity.name"},{"name":"project_name","example":"G-Riverside","source":"project.name"},{"name":"unit_number","example":"Unit 101","source":"owner.unit_number"}]'::jsonb
where name = 'Sample welcome notice';
update public.whatsapp_templates set body_text = replace(body_text, '{{unit_no}}', '{{unit_number}}');

-- dispatch + logs
create table public.dispatch_batches (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id),
  project_id uuid not null references public.projects(id),
  template_id uuid not null references public.whatsapp_templates(id),
  sender_id uuid not null references public.profiles(id),
  variable_map jsonb not null default '{}',
  mode text not null check (mode in ('demo','live')),
  total int not null default 0,
  created_at timestamptz not null default now()
);

create table public.message_logs (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid references public.dispatch_batches(id) on delete set null,
  entity_id uuid not null references public.entities(id),
  project_id uuid not null references public.projects(id),
  template_id uuid not null references public.whatsapp_templates(id),
  sender_id uuid not null references public.profiles(id),
  owner_id uuid references public.owners(id) on delete set null,
  phone_number text not null,
  payload jsonb not null,
  wamid text,
  status text not null default 'QUEUED' check (status in ('QUEUED','SENT','DELIVERED','READ','FAILED')),
  error_details jsonb,
  cost_estimate numeric(12,4) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.message_logs (wamid);
create index on public.message_logs (batch_id);
create index on public.message_logs (entity_id, created_at desc);
create index on public.message_logs (project_id, created_at desc);
create index on public.message_logs (template_id);
create index on public.message_logs (sender_id);
create index on public.message_logs (owner_id);
create index on public.dispatch_batches (project_id);
create index on public.dispatch_batches (template_id);
create index on public.dispatch_batches (sender_id);
create index on public.dispatch_batches (entity_id);

-- config, pricing, audit
create table public.whatsapp_config (
  id int primary key default 1 check (id = 1),
  mode text not null default 'demo' check (mode in ('demo','live')),
  api_version text not null default 'v21.0',
  phone_number_id text,
  waba_id text,
  access_token text,
  app_secret text,
  verify_token text not null default replace(gen_random_uuid()::text,'-',''),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);
insert into public.whatsapp_config (id) values (1);

create table public.message_pricing (
  category text primary key check (category in ('UTILITY','MARKETING','AUTHENTICATION')),
  rate numeric(12,4) not null default 0,
  currency text not null default 'USD',
  updated_at timestamptz not null default now()
);
insert into public.message_pricing (category) values ('UTILITY'),('MARKETING'),('AUTHENTICATION');

create table public.audit_events (
  id bigint generated always as identity primary key,
  actor_id uuid,
  entity_id uuid,
  action text not null,
  target_type text not null,
  target_id text,
  details jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index on public.audit_events (created_at desc);
create index on public.audit_events (entity_id, created_at desc);

-- sample projects named in the brief
insert into public.projects (entity_id, name, code, location, is_sample)
select id, 'G-Riverside', 'GC-RIV', 'Sample location', true from public.entities where slug = 'g-communities';
insert into public.projects (entity_id, name, code, location, is_sample)
select id, 'G-Heights', 'GC-HTS', 'Sample location', true from public.entities where slug = 'g-communities';
insert into public.project_owners (project_id, owner_id, unit_no)
select p.id, o.id, 'Unit ' || (200 + row_number() over (partition by p.id order by o.full_name))
from public.projects p cross join lateral (select * from public.owners order by full_name limit 5) o
where p.code in ('GC-RIV','GC-HTS');

-- roles
delete from public.roles where name in ('Editor','Sender');
update public.roles set permissions = array['template.read','template.create','template.update','template.archive','template.submit','message.send','owner.read','owner.manage','member.manage','log.read','analytics.read'],
  description = 'Full control of an entity and its projects' where name = 'Entity Admin';
insert into public.roles (name, description, permissions, is_system) values
 ('Employee','Community operator: templates, owners and dispatch for assigned projects',
  array['template.read','template.create','template.update','template.archive','message.send','owner.read','owner.manage','log.read'], true);
update public.roles set permissions = array['template.read','log.read'] where name = 'Viewer';
