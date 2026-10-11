-- Reusable images and videos a template can carry as its header. The files live in Storage; this table is the company's media library.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('template-media', 'template-media', true, 16777216, array['image/jpeg', 'image/png', 'video/mp4', 'video/3gpp'])
on conflict (id) do update set public = true, file_size_limit = 16777216, allowed_mime_types = excluded.allowed_mime_types;

create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  kind text not null check (kind in ('IMAGE', 'VIDEO')),
  name text not null check (length(trim(name)) between 1 and 120),
  path text not null unique,
  mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 16777216),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check ((kind = 'IMAGE' and mime_type in ('image/jpeg', 'image/png') and size_bytes <= 5242880) or (kind = 'VIDEO' and mime_type in ('video/mp4', 'video/3gpp'))),
  check (path like entity_id::text || '/%')
);
create index on public.media_assets (entity_id, created_at desc);
create index on public.media_assets (created_by);
alter table public.media_assets enable row level security;
create policy media_select on public.media_assets for select to authenticated using (public.has_perm(entity_id, 'template.read'));
create policy media_insert on public.media_assets for insert to authenticated
  with check (public.has_perm(entity_id, 'template.create') and created_by = (select auth.uid()));
create policy media_delete on public.media_assets for delete to authenticated using (public.has_perm(entity_id, 'template.update'));

-- only people who can create or edit templates in a company may add or remove files in that company's folder
create policy template_media_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'template-media' and public.has_perm(((storage.foldername(name))[1])::uuid, 'template.create'));
create policy template_media_delete on storage.objects for delete to authenticated
  using (bucket_id = 'template-media' and public.has_perm(((storage.foldername(name))[1])::uuid, 'template.update'));

alter table public.whatsapp_templates add column header_media_id uuid references public.media_assets(id) on delete restrict;
create index on public.whatsapp_templates (header_media_id);

-- the media header counts as template content: changing it needs approval again
do $$
declare d text;
begin
  d := pg_get_functiondef('public.guard_template()'::regprocedure);
  d := replace(d, 'new.variables, new.buttons)', 'new.variables, new.buttons, new.header_media_id)');
  d := replace(d, 'old.variables, old.buttons)', 'old.variables, old.buttons, old.header_media_id)');
  execute d;
end $$;

-- a template can only use media from its own company
create or replace function public.check_template_media() returns trigger language plpgsql set search_path = public as $$
begin
  if new.header_media_id is not null and not exists (select 1 from public.media_assets m where m.id = new.header_media_id and m.entity_id = new.entity_id) then
    raise exception 'That image or video belongs to another company';
  end if;
  return new;
end $$;
create trigger wt_media_check before insert or update of header_media_id on public.whatsapp_templates
  for each row execute function public.check_template_media();
