# Backend backup

This folder is a copy of everything that lives in Supabase project `lylcugsxxidcbldedmyp`, so the project can be rebuilt.

## What is here

- `migrations/` – the database, in the order it was built (29 files, oldest first). Run them in order on an empty project.
- `functions/` – the seven Edge Functions. Deploy each folder with `supabase functions deploy <name>`.
- `config.toml` – which functions check the user's login (`verify_jwt`).

## Not in the migration files

These were set up by hand and are not in the migration history:

1. **Scheduled jobs** (pg_cron). Run once after the migrations. They read the worker secret from the
   `whatsapp_config` table, so no secret is stored in the job:

   ```sql
   select cron.schedule('wa-process-queue', '* * * * *', $$
     select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/process-queue',
       headers := jsonb_build_object('Content-Type','application/json','x-worker-secret',(select worker_secret from public.whatsapp_config where id = 1)),
       body := '{}'::jsonb, timeout_milliseconds := 5000);
   $$);
   select cron.schedule('wa-health', '7 * * * *', $$
     select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/whatsapp-health',
       headers := jsonb_build_object('Content-Type','application/json','x-worker-secret',(select worker_secret from public.whatsapp_config where id = 1)),
       body := '{}'::jsonb, timeout_milliseconds := 20000);
   $$);
   select cron.schedule('wa-sync-templates', '23 3 * * *', $$
     select net.http_post(
       url := 'https://<PROJECT_REF>.supabase.co/functions/v1/sync-whatsapp-templates',
       headers := jsonb_build_object('Content-Type','application/json','x-worker-secret',(select worker_secret from public.whatsapp_config where id = 1)),
       body := '{}'::jsonb, timeout_milliseconds := 30000);
   $$);
   ```

   (`wa-alert-checks` is already created by the `inbox_and_alerts` migration.)

2. **Secrets and data are not saved here.** The WhatsApp access tokens, app secrets, the worker secret and the verify token
   live in the `whatsapp_config` and `whatsapp_accounts` tables, and all clients, templates and messages are data, not schema.
   Back those up from the Supabase dashboard if you need them.

3. **Supabase Auth settings** (the "Confirm email" switch, leaked-password protection) are dashboard settings.

## Notes

- The early migrations (`core_schema`, `seed_data`) describe the first version of the system and are later reshaped by `v2_schema` and the files after it. They are kept so the history replays exactly.
- `seed_data` creates the seven companies and some sample rows; the sample rows were deleted from the live project afterwards, so a rebuilt project will contain them until they are removed.
