do $$
declare reporter uuid := '00000000-0000-4000-8000-000000000099'; report_id uuid;
begin
  if has_table_privilege('anon', 'public.parity_feedback', 'select') or
    has_table_privilege('anon', 'public.parity_feedback', 'insert') or
    has_table_privilege('authenticated', 'public.parity_feedback', 'select') or
    has_table_privilege('authenticated', 'public.parity_feedback', 'insert') then
    raise exception 'Feedback must not be accessible directly by client roles';
  end if;
  if not has_table_privilege('service_role', 'public.parity_feedback', 'insert') then
    raise exception 'Feedback service needs insert access';
  end if;

  insert into auth.users(id) values (reporter);
  insert into public.parity_feedback(auth_user_id, contact_email, kind, title, details, area, app_version, platform)
    values (reporter, 'reporter@example.com', 'bug', 'Audit preview fails', 'The preview fails after selecting an image.', 'audit', '1.4.6', 'win32')
    returning id into report_id;
  if (select status from public.parity_feedback where id = report_id) <> 'new' then
    raise exception 'New feedback must be ready for triage';
  end if;
  delete from auth.users where id = reporter;
  if exists (select 1 from public.parity_feedback where id = report_id) then
    raise exception 'Deleting a user must delete their feedback';
  end if;
end $$;
select 'PASS: private feedback permissions, insert, triage default, and account deletion cleanup.';
