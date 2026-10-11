
-- Deletes a company with its clients, groups, templates, access and WhatsApp connection.
-- A company that has sent messages cannot be deleted: its history must stay for the audit trail (deactivate it instead).
create or replace function public.delete_entity(p_entity uuid) returns void
language plpgsql security definer set search_path = public as $$
declare ename text;
begin
  if not public.is_superadmin() then raise exception 'Superadmin only'; end if;
  select name into ename from public.entities where id = p_entity;
  if ename is null then raise exception 'Company not found'; end if;
  if exists (select 1 from public.message_logs where entity_id = p_entity)
     or exists (select 1 from public.dispatch_batches where entity_id = p_entity) then
    raise exception 'This company has sent messages, so its history must be kept. Deactivate it instead of deleting it.';
  end if;
  -- clients that belong to no other company go with it
  delete from public.owners o
   where o.id in (select po.owner_id from public.project_owners po join public.projects p on p.id = po.project_id where p.entity_id = p_entity)
     and not exists (select 1 from public.project_owners po2 join public.projects p2 on p2.id = po2.project_id
                      where po2.owner_id = o.id and p2.entity_id <> p_entity);
  delete from public.entities where id = p_entity;
end $$;
revoke all on function public.delete_entity(uuid) from public, anon;
grant execute on function public.delete_entity(uuid) to authenticated;
