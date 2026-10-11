
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

      -- Meta fields belong to the platform
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
