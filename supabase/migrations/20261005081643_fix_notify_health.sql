
create or replace function public.notify_health() returns trigger
language plpgsql security definer set search_path = public as $$
declare issues text[] := '{}'; sev text := 'warning'; ename text; state text;
begin
  select name into ename from public.entities where id = new.entity_id;
  if new.token_ok is false then
    issues := array_append(issues, 'The access token is invalid or expired.'); sev := 'critical';
  else
    if new.messaging_ok is false then issues := array_append(issues, 'The token cannot send messages.'); sev := 'critical'; end if;
    if new.management_ok is false then issues := array_append(issues, 'The token cannot manage templates.'); end if;
  end if;
  if new.phone_status is not null and new.phone_status <> 'CONNECTED' then
    issues := array_append(issues, 'The number status is ' || new.phone_status || '.'); sev := 'critical';
  end if;
  if new.quality_rating = 'RED' then
    issues := array_append(issues, 'Number quality is Red. Meta may lower its limit.'); sev := 'critical';
  elsif new.quality_rating = 'YELLOW' then
    issues := array_append(issues, 'Number quality is Yellow.');
  end if;
  if cardinality(issues) = 0 then return new; end if;
  state := md5(array_to_string(issues, '|'));
  insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
  values (new.entity_id, 'health', sev, 'WhatsApp connection needs attention: ' || ename, array_to_string(issues, ' '), '/admin/settings', 'member.manage',
          'health:' || new.entity_id || ':' || state || ':' || current_date)
  on conflict (dedupe_key) do nothing;
  return new;
end $$;
revoke execute on function public.notify_health() from public, anon, authenticated;
