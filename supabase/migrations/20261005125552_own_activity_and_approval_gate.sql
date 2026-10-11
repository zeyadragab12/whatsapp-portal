
-- 1. Message history: everyone sees what they sent; an entity admin sees the whole company; the superadmin sees everything.
drop policy logs_select on public.message_logs;
create policy logs_select on public.message_logs for select
  using (public.can_access_project(project_id, 'log.read')
         and (owner_id is null or public.can_see_owner(project_id, owner_id))
         and (sender_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage')));

drop policy batches_select on public.dispatch_batches;
create policy batches_select on public.dispatch_batches for select
  using (public.can_access_project(project_id, 'log.read')
         and (sender_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage')));

-- 2. Templates written by someone who cannot approve go straight to "waiting for approval";
--    only people with template.submit (entity admins, superadmin) can send them to Meta or approve them.
create or replace function public.guard_template() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  svc boolean := (select auth.uid()) is null;
  content_changed boolean;
  demo boolean := coalesce(public.entity_effective_mode(case when tg_op = 'UPDATE' then old.entity_id else new.entity_id end), 'demo') = 'demo';
  start_status text;
begin
  if tg_op = 'INSERT' then
    if not svc then
      new.status := case when public.has_perm(new.entity_id, 'template.submit') then 'DRAFT' else 'PENDING_APPROVAL' end;
      new.version := 1;
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
      start_status := case when public.has_perm(old.entity_id, 'template.submit') then 'DRAFT' else 'PENDING_APPROVAL' end;
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
        new.version := old.version + 1; new.status := start_status;
      elsif new.status <> old.status then
        if old.status = 'DRAFT' and new.status = 'PENDING_APPROVAL' and public.has_perm(old.entity_id,'template.update') then null;
        elsif old.status = 'PENDING_APPROVAL' and new.status = 'DRAFT' and old.meta_submitted_at is null
              and public.has_perm(old.entity_id,'template.update') then null;
        elsif old.status = 'REJECTED' and new.status = 'DRAFT' and public.has_perm(old.entity_id,'template.update') then
          new.status := start_status;
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
revoke execute on function public.guard_template() from public, anon, authenticated;
