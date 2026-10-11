-- Only the superadmin gives or changes roles.
-- A company admin can still add a person to their company, but only as Employee, and can remove people who are not admins.
drop policy if exists members_write on public.entity_members;

create policy members_insert on public.entity_members for insert to authenticated
  with check (
    public.is_superadmin()
    or (public.has_perm(entity_id, 'member.manage') and role_id = (select id from public.roles where name = 'Employee'))
  );

create policy members_update on public.entity_members for update to authenticated
  using (public.is_superadmin()) with check (public.is_superadmin());

create policy members_delete on public.entity_members for delete to authenticated
  using (
    public.is_superadmin()
    or (public.has_perm(entity_id, 'member.manage')
        and not exists (select 1 from public.roles r where r.id = role_id and 'member.manage' = any(r.permissions)))
  );
