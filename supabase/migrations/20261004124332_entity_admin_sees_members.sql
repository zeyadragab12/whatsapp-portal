
create or replace function public.manages_user(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.entity_members t
    where t.user_id = uid and public.has_perm(t.entity_id, 'member.manage')
  );
$$;
revoke execute on function public.manages_user(uuid) from public, anon;
grant execute on function public.manages_user(uuid) to authenticated;

create policy profiles_select_managed on public.profiles for select to authenticated
  using (public.manages_user(id));
