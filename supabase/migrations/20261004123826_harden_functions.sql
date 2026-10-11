
revoke execute on function public.enforce_company_domain() from public, anon, authenticated;
revoke execute on function public.handle_new_user() from public, anon, authenticated;
alter function public.touch_template() set search_path = public;
