
-- Anyone can view the full number of a message they are allowed to see in History
-- (their own messages; an entity admin sees the whole company; the superadmin everything).
-- Every view is recorded, and only the superadmin can read those audit lines.
create or replace function public.reveal_message_phone(p_log uuid) returns text
language plpgsql security definer set search_path = public as $$
declare l public.message_logs; recent int;
begin
  select * into l from public.message_logs where id = p_log;
  if l.id is null
     or not public.can_access_project(l.project_id, 'log.read')
     or not (l.owner_id is null or public.can_see_owner(l.project_id, l.owner_id))
     or not (l.sender_id = (select auth.uid()) or public.has_perm(l.entity_id, 'member.manage')) then
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
