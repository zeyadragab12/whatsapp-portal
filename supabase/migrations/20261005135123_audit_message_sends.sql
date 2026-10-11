
-- Every send (a batch of messages) now leaves a line in the Activity log: who, when, which message, how many clients.
create or replace function public.audit_dispatch() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details, created_at)
  values (new.sender_id, new.entity_id, 'messages_sent', 'dispatch_batch', new.id::text,
          jsonb_build_object('total', new.total, 'mode', new.mode, 'template_id', new.template_id,
                             'template', (select t.name from public.whatsapp_templates t where t.id = new.template_id)),
          new.created_at);
  return new;
end $$;
revoke execute on function public.audit_dispatch() from public, anon, authenticated;

create trigger audit_dispatch after insert on public.dispatch_batches
  for each row execute function public.audit_dispatch();

-- sends made before this existed
insert into public.audit_events (actor_id, entity_id, action, target_type, target_id, details, created_at)
select b.sender_id, b.entity_id, 'messages_sent', 'dispatch_batch', b.id::text,
       jsonb_build_object('total', b.total, 'mode', b.mode, 'template_id', b.template_id, 'template', t.name), b.created_at
from public.dispatch_batches b join public.whatsapp_templates t on t.id = b.template_id
where not exists (select 1 from public.audit_events a where a.action = 'messages_sent' and a.target_id = b.id::text);
