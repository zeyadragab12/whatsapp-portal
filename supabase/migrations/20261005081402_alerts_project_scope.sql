
alter table public.notifications add column project_ids uuid[] not null default '{}';
alter table public.notifications add column admin_only boolean not null default false;

drop policy notifications_select on public.notifications;
drop function public.unread_notifications();
drop function public.mark_notifications_read(uuid[]);
drop function public.can_see_notification(uuid, text);

-- visible to the superadmin, or to holders of the required permission; project-scoped alerts follow project access like conversations do
create or replace function public.can_see_notification(eid uuid, perm text, pids uuid[], admins_only boolean) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or (
    eid is not null and perm is not null and public.has_perm(eid, perm) and (
      public.has_perm(eid, 'member.manage')
      or (not admins_only and (cardinality(pids) = 0 or exists (
            select 1 from public.member_projects mp where mp.user_id = (select auth.uid()) and mp.project_id = any(pids))))
    )
  );
$$;

create policy notifications_select on public.notifications for select to authenticated
  using (public.can_see_notification(entity_id, required_perm, project_ids, admin_only));

create or replace function public.unread_notifications() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.notifications n
  where public.can_see_notification(n.entity_id, n.required_perm, n.project_ids, n.admin_only)
    and not exists (select 1 from public.notification_reads r where r.notification_id = n.id and r.user_id = (select auth.uid()));
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.notification_reads (user_id, notification_id)
  select (select auth.uid()), n.id from public.notifications n
   where public.can_see_notification(n.entity_id, n.required_perm, n.project_ids, n.admin_only) and (p_ids is null or n.id = any(p_ids))
  on conflict do nothing;
  get diagnostics c = row_count;
  return c;
end $$;

-- reply and opt-out alerts carry the project scope of the owner (unmatched numbers are admin-only)
create or replace function public.ingest_inbound_core(p_entity uuid, p_phone text, p_name text, p_wamid text, p_type text, p_body text, p_raw jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  cid uuid; unread int; oid uuid; oname text; pids uuid[]; preview text;
  kw text := upper(trim(coalesce(p_body, '')));
  stop_words text[] := array['STOP','UNSUBSCRIBE','CANCEL','إلغاء','الغاء','إيقاف','ايقاف'];
  start_words text[] := array['START','SUBSCRIBE','UNSTOP','اشتراك'];
  who text; ename text;
begin
  if p_wamid is not null and exists (select 1 from public.conversation_messages where wamid = p_wamid) then return null; end if;
  select o.id, o.full_name into oid, oname from public.owners o
    join public.project_owners po on po.owner_id = o.id join public.projects pr on pr.id = po.project_id and pr.entity_id = p_entity
   where o.phone = p_phone order by o.full_name limit 1;
  select coalesce(array_agg(distinct po.project_id), '{}') into pids from public.owners o
    join public.project_owners po on po.owner_id = o.id join public.projects pr on pr.id = po.project_id and pr.entity_id = p_entity
   where o.phone = p_phone;
  preview := left(coalesce(nullif(p_body, ''), '[' || p_type || ']'), 120);

  insert into public.conversations as c (entity_id, phone_number, owner_id, contact_name, project_ids, last_inbound_at, last_message_at, last_message_preview, unread_count, status)
  values (p_entity, p_phone, oid, coalesce(oname, nullif(p_name, '')), pids, now(), now(), preview, 1, 'open')
  on conflict (entity_id, phone_number) do update set
    owner_id = coalesce(excluded.owner_id, c.owner_id), contact_name = coalesce(excluded.contact_name, c.contact_name),
    project_ids = excluded.project_ids, last_inbound_at = now(), last_message_at = now(), last_message_preview = preview,
    unread_count = c.unread_count + 1, status = 'open'
  returning c.id, c.unread_count into cid, unread;

  insert into public.conversation_messages (conversation_id, direction, type, body, wamid, raw)
  values (cid, 'in', p_type, p_body, p_wamid, p_raw);

  who := coalesce(oname, nullif(p_name, ''), p_phone);
  select name into ename from public.entities where id = p_entity;
  if p_type = 'text' and kw = any(stop_words) then
    perform public.apply_opt_out_entity(p_entity, p_phone);
    insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, project_ids, admin_only, dedupe_key)
    values (p_entity, 'optout', 'warning', who || ' opted out of ' || ename, 'They replied STOP. No more messages will be sent to them from this entity.', '/owners', 'owner.manage',
            pids, cardinality(pids) = 0, 'optout:' || coalesce(p_wamid, gen_random_uuid()::text))
    on conflict (dedupe_key) do nothing;
  elsif p_type = 'text' and kw = any(start_words) then
    perform public.apply_opt_in_entity(p_entity, p_phone);
  end if;

  if unread = 1 then
    insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, project_ids, admin_only, dedupe_key)
    values (p_entity, 'inbox.reply', 'info', 'New reply from ' || who, preview, '/inbox?c=' || cid, 'inbox.read', pids, cardinality(pids) = 0,
            'reply:' || coalesce(p_wamid, gen_random_uuid()::text))
    on conflict (dedupe_key) do nothing;
  end if;
  return cid;
end $$;

revoke execute on function public.can_see_notification(uuid,text,uuid[],boolean), public.unread_notifications(), public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.can_see_notification(uuid,text,uuid[],boolean), public.unread_notifications(), public.mark_notifications_read(uuid[]) to authenticated;
revoke execute on function public.ingest_inbound_core(uuid,text,text,text,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.ingest_inbound_core(uuid,text,text,text,text,text,jsonb) to service_role;
