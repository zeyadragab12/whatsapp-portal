
-- Lets a superadmin or an entity admin find an approved person by email, so they can add them to their companies.
create or replace function public.find_person(p_email text)
returns table (id uuid, email text, full_name text, status text)
language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_superadmin() or exists (
    select 1 from public.entity_members m
    join public.roles r on r.id = m.role_id
    join public.profiles p on p.id = m.user_id and p.status = 'approved'
    where m.user_id = (select auth.uid()) and 'member.manage' = any(r.permissions)
  )) then raise exception 'Not allowed'; end if;
  return query
    select p.id, p.email, p.full_name, p.status::text from public.profiles p
    where lower(p.email) = lower(trim(p_email)) and p.status = 'approved' and not p.is_superadmin
    limit 1;
end $$;
revoke all on function public.find_person(text) from public, anon;
grant execute on function public.find_person(text) to authenticated;
