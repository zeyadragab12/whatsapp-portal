
-- Only the superadmin can view a full number, and only the superadmin can see who did.
create or replace function public.reveal_message_phone(p_log uuid) returns text
language plpgsql security definer set search_path = public as $$
declare l public.message_logs; recent int;
begin
  if not public.is_superadmin() then raise exception 'Not allowed'; end if;
  select * into l from public.message_logs where id = p_log;
  if l.id is null then raise exception 'Not found'; end if;
  select count(*) into recent from public.audit_events
    where actor_id = (select auth.uid()) and action = 'phone_revealed' and created_at > now() - interval '1 hour';
  if recent >= 200 then raise exception 'Too many numbers viewed in the last hour. Try again later.'; end if;
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details)
    values ((select auth.uid()), l.entity_id, 'phone_revealed', 'message_log', l.id::text,
            jsonb_build_object('phone_masked', l.phone_masked, 'template_id', l.template_id));
  return l.phone_number;
end $$;

drop policy audit_select on public.audit_events;
create policy audit_select on public.audit_events for select
  using (public.is_superadmin() or (entity_id is not null and action <> 'phone_revealed' and public.has_perm(entity_id, 'member.manage')));
