
insert into public.roles (name, description, permissions, is_system) values
 ('Entity Admin','Manages members and templates inside an entity', array['template.read','template.create','template.update','template.archive','message.send','member.manage','log.read'], true),
 ('Editor','Creates, updates and archives templates', array['template.read','template.create','template.update','template.archive'], true),
 ('Sender','Sends approved templates for assigned projects', array['template.read','message.send','log.read'], true),
 ('Viewer','Read-only access', array['template.read','log.read'], true);

insert into public.entities (name, slug) values
 ('G Communities','g-communities'),('G Lifestyle','g-lifestyle'),('G Hotels','g-hotels'),
 ('G Clubs','g-clubs'),('G Utilities','g-utilities'),('G Investments','g-investments'),('BuildDora','builddora');

insert into public.projects (entity_id, name, location, is_sample)
select e.id, 'Sample project ' || n, 'Sample location', true
from public.entities e cross join generate_series(1,2) n;

insert into public.owners (full_name, phone, is_sample) values
 ('Zeyad Ragab','+201010354164', true),
 ('Sample Owner 02','+201010354164', true),('Sample Owner 03','+201010354164', true),
 ('Sample Owner 04','+201010354164', true),('Sample Owner 05','+201010354164', true),
 ('Sample Owner 06','+201010354164', true),('Sample Owner 07','+201010354164', true),
 ('Sample Owner 08','+201010354164', true);

-- link owners to every sample project (first owner in all, others spread)
insert into public.project_owners (project_id, owner_id, unit_no)
select p.id, o.id, 'Unit ' || (100 + (row_number() over (partition by p.id order by o.full_name)))
from public.projects p
join lateral (select * from public.owners order by full_name limit 4 offset ((abs(hashtext(p.id::text)) % 5))) o on true;

insert into public.app_settings (key, value) values ('whatsapp_mode','demo');

insert into public.templates (entity_id, name, language, body, meta_status)
select id, 'Sample welcome notice', 'en',
 'Hello {{owner_name}}, this is a message from {{entity_name}} about {{project_name}}, unit {{unit_no}}. Sample text.', 'approved'
from public.entities where slug = 'g-communities';
