
-- Approval by an administrator is the check, so approving a person also confirms their email address.
create or replace function public.confirm_email_on_approval()
returns trigger language plpgsql security definer set search_path = public, auth as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    update auth.users set email_confirmed_at = coalesce(email_confirmed_at, now()) where id = new.id and email_confirmed_at is null;
  end if;
  return new;
end $$;
revoke all on function public.confirm_email_on_approval() from public, anon, authenticated;

drop trigger if exists confirm_email_on_approval on public.profiles;
create trigger confirm_email_on_approval
  after insert or update of status on public.profiles
  for each row execute function public.confirm_email_on_approval();
