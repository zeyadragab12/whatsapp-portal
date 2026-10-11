-- Audit fixes (written, NOT applied: review it, then run it yourself).
--
-- 1. Opt-out is decided per PHONE, not per client row. Before this, importing a file could (a) switch an opted-out client back on, because the
--    import passed opt_in = true, and (b) create a second client row for the same phone with different details that started opted in.
-- 2. A send carries a request id, so a double click or a retried request cannot create a second batch.

-- true when this phone has opted out for the company: any client row with this phone is opted out, or has an opt-out recorded for the company
create or replace function public.is_suppressed(p_entity uuid, p_phone text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.owners o
      join public.project_owners po on po.owner_id = o.id
      join public.projects pr on pr.id = po.project_id and pr.entity_id = p_entity
    where o.phone = p_phone
      and (o.whatsapp_opt_in = false
           or exists (select 1 from public.owner_optouts x where x.owner_id = o.id and x.entity_id = p_entity))
  );
$$;
revoke execute on function public.is_suppressed(uuid, text) from public, anon, authenticated;
grant execute on function public.is_suppressed(uuid, text) to service_role;

-- import_owners: a row can only keep or remove consent. It can never grant it back to a number that has opted out.
create or replace function public.import_owners(p_project uuid, p_rows jsonb, p_labels jsonb default '{}', p_list_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb; ok int := 0; bad jsonb := '[]'; i int := 0; oid uuid; eid uuid; lid uuid; ids uuid[] := '{}'; nm text := nullif(trim(coalesce(p_list_name, '')), ''); opt boolean;
begin
  if not public.can_access_project(p_project, 'owner.manage') then raise exception 'Not allowed to manage clients for this list'; end if;
  if jsonb_array_length(p_rows) > 2000 then raise exception 'Import up to 2000 rows at a time'; end if;
  select entity_id into eid from public.projects where id = p_project;
  -- two imports into the same list run one after the other, so the same phone arriving in both cannot be inserted twice
  perform pg_advisory_xact_lock(hashtextextended('import_owners:' || p_project::text, 0));
  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    begin
      select o.id into oid from public.owners o join public.project_owners po on po.owner_id = o.id
        where po.project_id = p_project and o.phone = (r->>'phone') and o.full_name = trim(r->>'full_name')
          and coalesce(po.unit_no, '') = coalesce(nullif(trim(coalesce(r->>'unit_number', '')), ''), '')
          and coalesce(po.extra, '{}'::jsonb) = coalesce(r->'extra', '{}'::jsonb) limit 1;
      opt := coalesce((r->>'opt_in')::boolean, true) and not public.is_suppressed(eid, r->>'phone');
      oid := public.upsert_owner(p_project, oid, r->>'full_name', r->>'phone', r->>'email', r->>'unit_number', opt, coalesce(r->'extra', '{}'::jsonb), p_labels);
      ids := ids || oid;
      ok := ok + 1;
    exception when others then
      bad := bad || jsonb_build_object('row', i, 'error', sqlerrm);
    end;
  end loop;
  if nm is not null and ok > 0 then
    select id into lid from public.client_lists where entity_id = eid and lower(name) = lower(nm);
    if lid is null then
      insert into public.client_lists (entity_id, name, source_file, created_by) values (eid, nm, nm, (select auth.uid())) returning id into lid;
    end if;
    insert into public.client_list_members (list_id, owner_id) select lid, x from unnest(ids) x on conflict do nothing;
    insert into public.client_list_fields (list_id, key)
      select distinct lid, k from jsonb_array_elements(p_rows) e, jsonb_object_keys(coalesce(e->'extra', '{}'::jsonb)) k
      where exists (select 1 from public.owner_fields f where f.entity_id = eid and f.key = k) on conflict do nothing;
  end if;
  return jsonb_build_object('imported', ok, 'failed', bad, 'list_id', lid, 'list_name', nm);
end $$;
revoke execute on function public.import_owners(uuid,jsonb,jsonb,text) from public, anon;
grant execute on function public.import_owners(uuid,jsonb,jsonb,text) to authenticated;

-- one batch per request: the same request id from the same person returns the batch that already exists
alter table public.dispatch_batches add column if not exists request_id uuid;
create unique index if not exists dispatch_batches_request_key on public.dispatch_batches (sender_id, request_id) where request_id is not null;

-- the phones (from a list) that are opted out for the company, for checking a whole send in one call
create or replace function public.suppressed_phones(p_entity uuid, p_phones text[])
returns setof text language sql stable security definer set search_path = public as $$
  select distinct o.phone from public.owners o
    join public.project_owners po on po.owner_id = o.id
    join public.projects pr on pr.id = po.project_id and pr.entity_id = p_entity
  where o.phone = any (p_phones)
    and (o.whatsapp_opt_in = false
         or exists (select 1 from public.owner_optouts x where x.owner_id = o.id and x.entity_id = p_entity));
$$;
revoke execute on function public.suppressed_phones(uuid, text[]) from public, anon, authenticated;
grant execute on function public.suppressed_phones(uuid, text[]) to service_role;

-- A worker that dies after calling Meta but before saving the result must not send the same message again when its lock runs out.
-- The worker stamps the row just before it calls Meta; a row still QUEUED with a stamp and an expired lock is marked UNCONFIRMED instead of being claimed.
alter table public.message_logs add column if not exists send_started_at timestamptz;

create or replace function public.claim_messages(p_limit int, p_lock_seconds int default 120)
returns table (id uuid, entity_id uuid, payload jsonb, phone_number text, attempts int, sent_from text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  update public.message_logs m
     set status = 'FAILED', locked_until = null, updated_at = now(),
         last_error = 'Could not confirm whether WhatsApp received this message, so it was not sent again. Check before resending.',
         error_details = jsonb_build_object('code', 'UNCONFIRMED', 'message', 'The worker stopped before the result was saved.')
   where m.status = 'QUEUED' and m.send_started_at is not null and m.locked_until is not null and m.locked_until < now();
  return query
  with cand as (
    select distinct on (m.entity_id, m.phone_number) m.id
    from public.message_logs m
    where m.status = 'QUEUED' and m.next_attempt_at <= now() and (m.locked_until is null or m.locked_until < now())
      and not exists (
        select 1 from public.message_logs r
        where r.entity_id = m.entity_id and r.phone_number = m.phone_number and r.id <> m.id
          and ((r.sent_at is not null and r.sent_at > now() - interval '7 seconds')
               or (r.status = 'QUEUED' and r.locked_until is not null and r.locked_until > now())))
    order by m.entity_id, m.phone_number, m.next_attempt_at, m.created_at
    limit p_limit
  ), picked as (
    select m.id from public.message_logs m where m.id in (select c.id from cand c) for update skip locked
  )
  update public.message_logs u
     set locked_until = now() + make_interval(secs => p_lock_seconds), attempts = u.attempts + 1
    from picked
   where u.id = picked.id
  returning u.id, u.entity_id, u.payload, u.phone_number, u.attempts, u.sent_from;
end $$;
revoke execute on function public.claim_messages(int,int) from public, anon, authenticated;
grant execute on function public.claim_messages(int,int) to service_role;
