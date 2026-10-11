-- History shows one line per send. A send remembers which groups it went to (null = sent before this was recorded, empty = everyone).
alter table public.dispatch_batches add column group_names text[];

create or replace function public.send_history(p_entities uuid[], p_from timestamptz default null, p_limit int default 51, p_offset int default 0)
returns table (id uuid, created_at timestamptz, entity_id uuid, template_id uuid, sender_id uuid, mode text, total int, group_names text[],
               sent int, delivered int, read int, failed int, queued int)
language sql stable security invoker set search_path = public as $$
  select b.id, b.created_at, b.entity_id, b.template_id, b.sender_id, b.mode, b.total, b.group_names,
         count(m.id) filter (where m.status = 'SENT')::int,
         count(m.id) filter (where m.status = 'DELIVERED')::int,
         count(m.id) filter (where m.status = 'READ')::int,
         count(m.id) filter (where m.status = 'FAILED')::int,
         count(m.id) filter (where m.status = 'QUEUED')::int
  from public.dispatch_batches b
  left join public.message_logs m on m.batch_id = b.id
  where b.entity_id = any(p_entities) and (p_from is null or b.created_at >= p_from)
  group by b.id
  order by b.created_at desc
  limit p_limit offset p_offset;
$$;
revoke all on function public.send_history(uuid[], timestamptz, int, int) from public, anon;
grant execute on function public.send_history(uuid[], timestamptz, int, int) to authenticated;
