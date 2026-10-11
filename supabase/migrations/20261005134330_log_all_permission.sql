
-- New permission: see every message of the company, not only your own. Viewers and entity admins get it.
update public.roles set permissions = array_append(permissions, 'log.all')
  where name in ('Viewer', 'Entity Admin') and not ('log.all' = any(permissions));

drop policy logs_select on public.message_logs;
create policy logs_select on public.message_logs for select
  using (public.can_access_project(project_id, 'log.read')
         and (owner_id is null or public.can_see_owner(project_id, owner_id))
         and (sender_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage') or public.has_perm(entity_id, 'log.all')));

drop policy batches_select on public.dispatch_batches;
create policy batches_select on public.dispatch_batches for select
  using (public.can_access_project(project_id, 'log.read')
         and (sender_id = (select auth.uid()) or public.has_perm(entity_id, 'member.manage') or public.has_perm(entity_id, 'log.all')));

create or replace function public.reveal_message_phone(p_log uuid) returns text
language plpgsql security definer set search_path = public as $$
declare l public.message_logs; recent int;
begin
  select * into l from public.message_logs where id = p_log;
  if l.id is null
     or not public.can_access_project(l.project_id, 'log.read')
     or not (l.owner_id is null or public.can_see_owner(l.project_id, l.owner_id))
     or not (l.sender_id = (select auth.uid()) or public.has_perm(l.entity_id, 'member.manage') or public.has_perm(l.entity_id, 'log.all')) then
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
