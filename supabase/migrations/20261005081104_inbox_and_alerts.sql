
-- ===== permissions =====
update public.roles set permissions = permissions || array['inbox.read','inbox.reply']
  where name in ('Entity Admin','Employee') and not ('inbox.read' = any(permissions));

-- ===== inbox tables =====
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references public.entities(id) on delete cascade,
  phone_number text not null,
  owner_id uuid references public.owners(id) on delete set null,
  contact_name text,
  project_ids uuid[] not null default '{}',
  last_inbound_at timestamptz,
  last_message_at timestamptz not null default now(),
  last_message_preview text,
  unread_count int not null default 0,
  status text not null default 'open' check (status in ('open','closed')),
  assigned_to uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (entity_id, phone_number)
);
create index on public.conversations (entity_id, last_message_at desc);
create index on public.conversations (assigned_to);
create index on public.conversations (owner_id);

create table public.conversation_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  type text not null default 'text',
  body text,
  wamid text unique,
  status text check (status in ('QUEUED','SENT','DELIVERED','READ','FAILED')),
  error text,
  sent_by uuid references public.profiles(id) on delete set null,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on public.conversation_messages (conversation_id, created_at);
create index on public.conversation_messages (sent_by);

-- ===== notifications =====
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid references public.entities(id) on delete cascade,
  kind text not null,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  title text not null,
  body text,
  link text,
  required_perm text,
  dedupe_key text unique,
  created_at timestamptz not null default now()
);
create index on public.notifications (created_at desc);
create index on public.notifications (entity_id);
create table public.notification_reads (
  user_id uuid not null references public.profiles(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (user_id, notification_id)
);
create index on public.notification_reads (notification_id);

alter table public.conversations enable row level security;
alter table public.conversation_messages enable row level security;
alter table public.notifications enable row level security;
alter table public.notification_reads enable row level security;

-- ===== visibility helpers =====
create or replace function public.can_view_conversation(eid uuid, pids uuid[]) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or (
    public.has_perm(eid, 'inbox.read') and (
      public.has_perm(eid, 'member.manage')
      or exists (select 1 from public.member_projects mp where mp.user_id = (select auth.uid()) and mp.project_id = any(pids))
    )
  );
$$;

create or replace function public.can_see_notification(eid uuid, perm text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_superadmin() or (eid is not null and perm is not null and public.has_perm(eid, perm));
$$;

create policy conversations_select on public.conversations for select to authenticated using (public.can_view_conversation(entity_id, project_ids));
create policy conv_messages_select on public.conversation_messages for select to authenticated
  using (exists (select 1 from public.conversations c where c.id = conversation_id));
create policy notifications_select on public.notifications for select to authenticated using (public.can_see_notification(entity_id, required_perm));
create policy notif_reads_own on public.notification_reads for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- ===== opt-out per entity (STOP / START) =====
create or replace function public.apply_opt_out_entity(p_entity uuid, p_phone text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.owner_optouts (owner_id, entity_id)
  select distinct o.id, p_entity from public.owners o
    join public.project_owners po on po.owner_id = o.id
    join public.projects pr on pr.id = po.project_id and pr.entity_id = p_entity
  where o.phone = p_phone
  on conflict do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.apply_opt_in_entity(p_entity uuid, p_phone text) returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.owner_optouts where entity_id = p_entity and owner_id in (
    select o.id from public.owners o join public.project_owners po on po.owner_id = o.id
      join public.projects pr on pr.id = po.project_id and pr.entity_id = p_entity where o.phone = p_phone);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.apply_opt_out(p_phone text, p_phone_number_id text) returns int
language plpgsql security definer set search_path = public as $$
declare eid uuid;
begin
  select entity_id into eid from public.whatsapp_accounts where phone_number_id = p_phone_number_id;
  if eid is null then return 0; end if;
  return public.apply_opt_out_entity(eid, p_phone);
end $$;

-- ===== inbound ingest =====
create or replace function public.ingest_inbound_core(p_entity uuid, p_phone text, p_name text, p_wamid text, p_type text, p_body text, p_raw jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  cid uuid; unread int; oid uuid; oname text; pids uuid[]; preview text;
  kw text := upper(trim(coalesce(p_body, '')));
  stop_words text[] := array['STOP','UNSUBSCRIBE','CANCEL','إلغاء','الغاء','إيقاف','ايقاف'];
  start_words text[] := array['START','SUBSCRIBE','UNSTOP','اشتراك'];
  who text; ename text;
begin
  if p_wamid is not null and exists (select 1 from public.conversation_messages where wamid = p_wamid) then return null; end if; -- webhook retry
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
    insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
    values (p_entity, 'optout', 'warning', who || ' opted out of ' || ename, 'They replied STOP. No more messages will be sent to them from this entity.', '/owners', 'owner.manage', 'optout:' || coalesce(p_wamid, gen_random_uuid()::text))
    on conflict (dedupe_key) do nothing;
  elsif p_type = 'text' and kw = any(start_words) then
    perform public.apply_opt_in_entity(p_entity, p_phone);
  end if;

  if unread = 1 then
    insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
    values (p_entity, 'inbox.reply', 'info', 'New reply from ' || who, preview, '/inbox?c=' || cid, 'inbox.read', 'reply:' || coalesce(p_wamid, gen_random_uuid()::text))
    on conflict (dedupe_key) do nothing;
  end if;
  return cid;
end $$;

create or replace function public.ingest_inbound_batch(p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare it jsonb; eid uuid; n int := 0;
begin
  for it in select * from jsonb_array_elements(p_items) loop
    select entity_id into eid from public.whatsapp_accounts where phone_number_id = it->>'pnid';
    if eid is null then continue; end if;
    perform public.ingest_inbound_core(eid, '+' || regexp_replace(it->>'from', '\D', '', 'g'), it->>'name', it->>'wamid',
      coalesce(it->>'type', 'text'), it->>'body', it->'raw');
    n := n + 1;
  end loop;
  return n;
end $$;

-- demo only: lets you try the inbox without Meta
create or replace function public.simulate_inbound(p_entity uuid, p_phone text, p_name text, p_text text) returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if not (public.is_superadmin() or public.has_perm(p_entity, 'template.submit')) then raise exception 'Not allowed'; end if;
  if public.entity_effective_mode(p_entity) <> 'demo' then raise exception 'Simulated replies are only available in demo mode'; end if;
  if p_phone !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Phone must be in E.164 format'; end if;
  if length(trim(coalesce(p_text, ''))) = 0 then raise exception 'Write a reply to simulate'; end if;
  return public.ingest_inbound_core(p_entity, p_phone, nullif(p_name, ''), null, 'text', left(p_text, 4096), '{"simulated":true}'::jsonb);
end $$;

-- ===== inbox actions =====
create or replace function public.inbox_mark_read(p_conversation uuid) returns void
language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  select * into c from public.conversations where id = p_conversation;
  if c.id is null or not public.can_view_conversation(c.entity_id, c.project_ids) then raise exception 'Not allowed'; end if;
  update public.conversations set unread_count = 0 where id = p_conversation;
end $$;

create or replace function public.inbox_set_status(p_conversation uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  if p_status not in ('open','closed') then raise exception 'Invalid status'; end if;
  select * into c from public.conversations where id = p_conversation;
  if c.id is null or not public.can_view_conversation(c.entity_id, c.project_ids) or not public.has_perm(c.entity_id, 'inbox.reply') then raise exception 'Not allowed'; end if;
  update public.conversations set status = p_status where id = p_conversation;
end $$;

create or replace function public.inbox_assign(p_conversation uuid, p_to_me boolean) returns void
language plpgsql security definer set search_path = public as $$
declare c public.conversations;
begin
  select * into c from public.conversations where id = p_conversation;
  if c.id is null or not public.can_view_conversation(c.entity_id, c.project_ids) or not public.has_perm(c.entity_id, 'inbox.reply') then raise exception 'Not allowed'; end if;
  update public.conversations set assigned_to = case when p_to_me then (select auth.uid()) else null end where id = p_conversation;
end $$;

-- status callbacks also cover free-text replies sent from the inbox
create or replace function public.apply_status_update(p_wamid text, p_status text, p_errors jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare n int; m int;
begin
  update public.message_logs set status = p_status,
    error_details = case when p_status = 'FAILED' then p_errors else error_details end, updated_at = now()
  where wamid = p_wamid and (
    (p_status = 'FAILED' and public.msg_rank(status) < 2)
    or (p_status <> 'FAILED' and status <> 'FAILED' and public.msg_rank(p_status) > public.msg_rank(status)));
  get diagnostics n = row_count;
  update public.conversation_messages set status = p_status,
    error = case when p_status = 'FAILED' then coalesce(p_errors->0->>'message', p_errors->0->>'title', 'Delivery failed') else error end, updated_at = now()
  where wamid = p_wamid and direction = 'out' and (
    (p_status = 'FAILED' and public.msg_rank(coalesce(status,'QUEUED')) < 2)
    or (p_status <> 'FAILED' and coalesce(status,'QUEUED') <> 'FAILED' and public.msg_rank(p_status) > public.msg_rank(coalesce(status,'QUEUED'))));
  get diagnostics m = row_count;
  return n + m;
end $$;

create or replace function public.demo_advance() returns int
language plpgsql security definer set search_path = public as $$
declare pending int; pending2 int;
begin
  update public.message_logs set status = 'DELIVERED', updated_at = now()
   where status = 'SENT' and wamid like 'demo.%' and sent_at < now() - interval '1.5 seconds';
  update public.message_logs set status = 'READ', updated_at = now()
   where status = 'DELIVERED' and wamid like 'demo.%' and updated_at < now() - interval '2 seconds' and (abs(hashtext(id::text)) % 10) < 7;
  update public.conversation_messages set status = 'DELIVERED', updated_at = now()
   where direction = 'out' and status = 'SENT' and wamid like 'demo.%' and created_at < now() - interval '1.5 seconds';
  update public.conversation_messages set status = 'READ', updated_at = now()
   where direction = 'out' and status = 'DELIVERED' and wamid like 'demo.%' and updated_at < now() - interval '2 seconds';
  select count(*) into pending from public.message_logs
   where wamid like 'demo.%' and (status = 'SENT' or (status = 'DELIVERED' and (abs(hashtext(id::text)) % 10) < 7));
  select count(*) into pending2 from public.conversation_messages
   where direction = 'out' and wamid like 'demo.%' and status in ('SENT','DELIVERED');
  return pending + pending2;
end $$;

-- ===== alerts =====
create or replace function public.notify_template_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare sev text; ttl text; bd text;
begin
  case new.meta_status
    when 'REJECTED' then sev := 'critical'; ttl := 'Template rejected: ' || new.name; bd := coalesce(new.rejection_reason, 'Meta rejected the template. Edit it and send the changes again.');
    when 'PAUSED' then sev := 'warning'; ttl := 'Template paused by Meta: ' || new.name; bd := 'Sending is blocked until Meta lifts the pause. Low read rates or negative feedback are the usual cause.';
    when 'DISABLED' then sev := 'critical'; ttl := 'Template disabled by Meta: ' || new.name; bd := 'It cannot be edited or sent again. Create a new template.';
    when 'ARCHIVED' then sev := 'warning'; ttl := 'Template archived by Meta: ' || new.name; bd := 'Meta deletes it on ' || to_char(now() + interval '28 days', 'DD Mon YYYY') || ' unless you unarchive it in WhatsApp Manager.';
    when 'PENDING_DELETION' then sev := 'critical'; ttl := 'Template pending deletion: ' || new.name; bd := 'Meta is deleting this template. Undelivered messages are retried for up to 30 days.';
    when 'DELETED' then sev := 'critical'; ttl := 'Template deleted on Meta: ' || new.name; bd := 'It no longer exists on WhatsApp and cannot be recovered.';
    when 'LIMIT_EXCEEDED' then sev := 'warning'; ttl := 'Template limit reached: ' || new.name; bd := 'The WhatsApp account is over its template quota. Remove unused templates.';
    when 'FLAGGED' then sev := 'warning'; ttl := 'Template flagged by Meta: ' || new.name; bd := 'Meta flagged this template and may disable it soon. Check feedback and read rates.';
    when 'IN_APPEAL' then sev := 'info'; ttl := 'Template appeal in review: ' || new.name; bd := 'Meta is reviewing your appeal.';
    when 'APPROVED' then sev := 'info'; ttl := 'Template approved: ' || new.name; bd := 'It can now be sent.';
    else return new;
  end case;
  insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
  values (new.entity_id, 'template.status', sev, ttl, bd, '/templates/' || new.id, 'template.update',
          'tpl:' || new.id || ':' || new.meta_status || ':' || extract(epoch from clock_timestamp())::bigint)
  on conflict (dedupe_key) do nothing;
  return new;
end $$;
create trigger notify_template_status after update of meta_status on public.whatsapp_templates
  for each row when (old.meta_status is distinct from new.meta_status) execute function public.notify_template_status();

create or replace function public.notify_health() returns trigger
language plpgsql security definer set search_path = public as $$
declare issues text[] := '{}'; sev text := 'warning'; ename text; state text;
begin
  select name into ename from public.entities where id = new.entity_id;
  if new.token_ok is false then issues := issues || 'The access token is invalid or expired.'; sev := 'critical';
  else
    if new.messaging_ok is false then issues := issues || 'The token cannot send messages.'; sev := 'critical'; end if;
    if new.management_ok is false then issues := issues || 'The token cannot manage templates.'; end if;
  end if;
  if new.phone_status is not null and new.phone_status <> 'CONNECTED' then issues := issues || ('The number status is ' || new.phone_status || '.'); sev := 'critical'; end if;
  if new.quality_rating = 'RED' then issues := issues || 'Number quality is Red. Meta may lower its limit.'; sev := 'critical';
  elsif new.quality_rating = 'YELLOW' then issues := issues || 'Number quality is Yellow.'; end if;
  if cardinality(issues) = 0 then return new; end if;
  state := md5(array_to_string(issues, '|'));
  insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
  values (new.entity_id, 'health', sev, 'WhatsApp connection needs attention: ' || ename, array_to_string(issues, ' '), '/admin/settings', 'member.manage',
          'health:' || new.entity_id || ':' || state || ':' || current_date)
  on conflict (dedupe_key) do nothing;
  return new;
end $$;
create trigger notify_health after insert or update on public.whatsapp_health for each row execute function public.notify_health();

create or replace function public.notify_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
  values (null, 'signup', 'info', 'New access request', new.email, '/admin/requests', null, 'signup:' || new.id) on conflict (dedupe_key) do nothing;
  return new;
end $$;
create trigger notify_signup after insert on public.profiles for each row when (new.status = 'pending') execute function public.notify_signup();

-- periodic checks: failed batches, limit and quota usage
create or replace function public.run_alert_checks() returns int
language plpgsql security definer set search_path = public as $$
declare n int := 0; r record; top text;
begin
  for r in
    select b.id, b.entity_id, count(*) as total,
           count(*) filter (where m.status = 'FAILED' and coalesce(m.error_details->>'code','') not in ('OPT_OUT','INACTIVE','MISSING_VARIABLE')) as tech_failed,
           count(*) filter (where m.status = 'QUEUED') as queued
    from public.dispatch_batches b join public.message_logs m on m.batch_id = b.id
    where b.created_at > now() - interval '3 hours' and b.mode = 'live'
    group by b.id, b.entity_id
  loop
    if r.queued = 0 and r.tech_failed >= 3 and r.tech_failed * 5 >= r.total then
      select coalesce(m.error_details->>'message', m.last_error, 'Unknown error') into top from public.message_logs m
        where m.batch_id = r.id and m.status = 'FAILED' group by 1 order by count(*) desc limit 1;
      insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
      values (r.entity_id, 'batch.failed', 'critical', r.tech_failed || ' of ' || r.total || ' messages failed', 'Most common reason: ' || top, '/log', 'log.read', 'batch:' || r.id)
      on conflict (dedupe_key) do nothing;
      get diagnostics n = row_count;
    end if;
  end loop;

  for r in
    select h.entity_id, e.name, h.limit_value,
      (select count(distinct ml.phone_number) from public.message_logs ml join public.whatsapp_accounts a2 on a2.entity_id = ml.entity_id
        where coalesce(a2.portfolio_id,'default') = coalesce(a.portfolio_id,'default') and ml.created_at > now() - interval '24 hours'
          and ml.status <> 'FAILED' and ml.sent_from is distinct from 'demo') as used
    from public.whatsapp_health h join public.whatsapp_accounts a on a.entity_id = h.entity_id join public.entities e on e.id = h.entity_id
    where h.limit_value is not null and h.limit_value < 1000000000000
  loop
    if r.used >= r.limit_value * 0.8 then
      insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
      values (r.entity_id, 'limit', case when r.used >= r.limit_value then 'critical' else 'warning' end, 'Messaging limit nearly used: ' || r.name,
              r.used || ' of ' || r.limit_value || ' unique recipients in the last 24 hours.', '/admin/settings', 'member.manage', 'limit:' || r.entity_id || ':' || current_date)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;

  for r in
    select q.entity_id, e.name, q.used, q.cap from (
      select a.entity_id, a.template_cap as cap,
        (select count(*)::int from public.whatsapp_templates t where t.meta_template_id is not null and t.meta_template_id not like 'demo\_%'
           and coalesce(t.meta_status,'') <> 'DELETED'
           and (t.entity_id = a.entity_id or (a.waba_id is not null and exists (select 1 from public.whatsapp_accounts a2 where a2.entity_id = t.entity_id and a2.waba_id = a.waba_id)))) as used
      from public.whatsapp_accounts a) q join public.entities e on e.id = q.entity_id
  loop
    if r.used >= r.cap * 0.8 then
      insert into public.notifications (entity_id, kind, severity, title, body, link, required_perm, dedupe_key)
      values (r.entity_id, 'quota', case when r.used >= r.cap then 'critical' else 'warning' end, 'Template limit nearly reached: ' || r.name,
              r.used || ' of ' || r.cap || ' templates on the WhatsApp account.', '/templates', 'template.submit', 'quota:' || r.entity_id || ':' || current_date)
      on conflict (dedupe_key) do nothing;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.unread_notifications() returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.notifications n
  where public.can_see_notification(n.entity_id, n.required_perm)
    and not exists (select 1 from public.notification_reads r where r.notification_id = n.id and r.user_id = (select auth.uid()));
$$;

create or replace function public.mark_notifications_read(p_ids uuid[] default null) returns int
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.notification_reads (user_id, notification_id)
  select (select auth.uid()), n.id from public.notifications n
   where public.can_see_notification(n.entity_id, n.required_perm) and (p_ids is null or n.id = any(p_ids))
  on conflict do nothing;
  get diagnostics c = row_count;
  return c;
end $$;

-- realtime
alter publication supabase_realtime add table public.conversations;
alter publication supabase_realtime add table public.conversation_messages;
alter publication supabase_realtime add table public.notifications;

-- grants
revoke execute on function public.notify_template_status(), public.notify_health(), public.notify_signup() from public, anon, authenticated;
revoke execute on function public.ingest_inbound_core(uuid,text,text,text,text,text,jsonb), public.ingest_inbound_batch(jsonb),
  public.apply_opt_out_entity(uuid,text), public.apply_opt_in_entity(uuid,text), public.run_alert_checks() from public, anon, authenticated;
grant execute on function public.ingest_inbound_core(uuid,text,text,text,text,text,jsonb), public.ingest_inbound_batch(jsonb),
  public.apply_opt_out_entity(uuid,text), public.apply_opt_in_entity(uuid,text), public.run_alert_checks() to service_role;
revoke execute on function public.can_view_conversation(uuid,uuid[]), public.can_see_notification(uuid,text), public.simulate_inbound(uuid,text,text,text),
  public.inbox_mark_read(uuid), public.inbox_set_status(uuid,text), public.inbox_assign(uuid,boolean), public.unread_notifications(),
  public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.can_view_conversation(uuid,uuid[]), public.can_see_notification(uuid,text), public.simulate_inbound(uuid,text,text,text),
  public.inbox_mark_read(uuid), public.inbox_set_status(uuid,text), public.inbox_assign(uuid,boolean), public.unread_notifications(),
  public.mark_notifications_read(uuid[]) to authenticated;

select cron.schedule('wa-alert-checks', '*/10 * * * *', 'select public.run_alert_checks()');
