create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

select cron.schedule(
  'qa-expired-assets-hourly',
  '17 * * * *',
  $$
    select net.http_post(
      url := 'https://hjrfvjvirdzdevzmcalp.supabase.co/functions/v1/cleanup-expired-qa-assets',
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('source', 'supabase-cron'),
      timeout_milliseconds := 10000
    );
  $$
);
