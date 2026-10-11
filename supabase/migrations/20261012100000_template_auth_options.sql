-- Authentication templates keep their Meta-defined options (code button type, expiry, security note, Android apps) here.
-- Marketing and Utility templates leave it null.
alter table public.whatsapp_templates add column if not exists auth_options jsonb;
alter table public.whatsapp_templates drop constraint if exists whatsapp_templates_auth_options_shape;
alter table public.whatsapp_templates add constraint whatsapp_templates_auth_options_shape
  check (auth_options is null or (jsonb_typeof(auth_options) = 'object' and category = 'AUTHENTICATION'));
