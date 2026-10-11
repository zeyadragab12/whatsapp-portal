
-- the History list shows this masked copy; the full number is only given out one row at a time, and every time is recorded
alter table public.message_logs add column phone_masked text generated always as (
  case when length(phone_number) > 6 then left(phone_number, 3) || repeat('•', length(phone_number) - 7) || right(phone_number, 4) else phone_number end
) stored;

create or replace function public.reveal_message_phone(p_log uuid) returns text
language plpgsql security definer set search_path = public as $$
declare l public.message_logs; recent int;
begin
  select * into l from public.message_logs where id = p_log;
  if l.id is null
     or not public.can_access_project(l.project_id, 'log.read')
     or not (l.owner_id is null or public.can_see_owner(l.project_id, l.owner_id)) then
    raise exception 'Not allowed';
  end if;
  select count(*) into recent from public.audit_events
    where actor_id = (select auth.uid()) and action = 'phone_revealed' and created_at > now() - interval '1 hour';
  if recent >= 200 then raise exception 'Too many numbers viewed in the last hour. Try again later.'; end if;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
    values ((select auth.uid()), l.entity_id, 'phone_revealed', 'message_log', l.id::text,
            jsonb_build_object('phone_masked', l.phone_masked, 'template_id', l.template_id));
  return l.phone_number;
end $$;
revoke all on function public.reveal_message_phone(uuid) from public, anon;
grant execute on function public.reveal_message_phone(uuid) to authenticated;
