
-- p_entities lets "all my companies" mean exactly the companies the person can open, not everything the database holds.
drop function public.analytics_summary(uuid, uuid, integer);
create or replace function public.analytics_summary(p_entity uuid default null, p_project uuid default null, p_days integer default 30, p_entities uuid[] default null)
returns jsonb language sql stable set search_path = public as $$
  with base as (
    select * from public.message_logs
    where created_at >= now() - make_interval(days => greatest(1, least(p_days, 365)))
      and (p_entity is null or entity_id = p_entity) and (p_project is null or project_id = p_project)
      and (p_entities is null or entity_id = any(p_entities))
  )
  select jsonb_build_object(
    'total', count(*),
    'sent', count(*) filter (where status in ('SENT','DELIVERED','READ')),
    'delivered', count(*) filter (where status in ('DELIVERED','READ')),
    'read', count(*) filter (where status = 'READ'),
    'failed', count(*) filter (where status = 'FAILED'),
    'queued', count(*) filter (where status = 'QUEUED'),
    'cost', coalesce(sum(cost_estimate) filter (where status <> 'FAILED'), 0),
    'daily', coalesce((
      select jsonb_agg(d order by d.day) from (
        select created_at::date as day, count(*) as total,
               count(*) filter (where status in ('DELIVERED','READ')) as delivered,
               count(*) filter (where status = 'READ') as read,
               count(*) filter (where status = 'FAILED') as failed
        from base group by 1) d), '[]'::jsonb)
  ) from base;
$$;
grant execute on function public.analytics_summary(uuid, uuid, integer, uuid[]) to authenticated;
revoke execute on function public.analytics_summary(uuid, uuid, integer, uuid[]) from anon, public;
