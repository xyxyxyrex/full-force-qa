insert into auth.users values ('00000000-0000-4000-8000-000000000001'), ('00000000-0000-4000-8000-000000000002'), ('00000000-0000-4000-8000-000000000003');
do $$
declare a parity_accounts; b parity_accounts; r jsonb; original_notes jsonb; table_name text;
begin
  select data into original_notes from parity_notes where owner_key = 'monday:7';
  -- The same email alone creates an independent owner.
  b := initialize_parity_account('00000000-0000-4000-8000-000000000002','same@example.com','New');
  assert b.owner_key = 'parity:00000000-0000-4000-8000-000000000002';
  assert (select auth_user_id is null from parity_accounts where owner_key = 'monday:7');
  a := initialize_parity_account('00000000-0000-4000-8000-000000000001','other@example.com','Restored','7');
  assert a.owner_key = 'monday:7';
  a := initialize_parity_account('00000000-0000-4000-8000-000000000001','other@example.com','Restored','7');
  assert a.owner_key = 'monday:7';
  assert (select data = original_notes from parity_notes where owner_key = a.owner_key);
  assert (select data->>'folderId' = 'folder-1' from parity_projects where owner_key = a.owner_key);
  assert (select data->'settings'->>'theme' = 'dark' from parity_user_state where owner_key = a.owner_key);
  begin
    perform initialize_parity_account('00000000-0000-4000-8000-000000000003','same@example.com','Claim','7');
    raise exception 'Duplicate claim was accepted';
  exception when raise_exception then
    if sqlerrm not like '%already linked%' then raise; end if;
  end;
  begin
    perform initialize_parity_account('00000000-0000-4000-8000-000000000002','same@example.com','Merge','7');
    raise exception 'Merge was accepted';
  exception when raise_exception then
    if sqlerrm not like '%cannot be merged%' then raise; end if;
  end;
  assert (select count(*) = 2 from parity_accounts);
  r := save_parity_ticket(a.owner_key,'{"id":"ticket-42","source":{"provider":"opsmosis","connectionId":"manual","externalId":"42"},"title":"Local"}',0);
  assert r->>'revision' = '1';
  r := save_parity_ticket(a.owner_key,'{"id":"ticket-42","title":"Conflict"}',0);
  assert (r->>'conflict')::boolean;
  assert r->'ticket'->>'title' = 'Local';
  r := save_parity_ticket(a.owner_key,'{"id":"ticket-42","title":"Resolved"}',1);
  assert r->>'revision' = '2';
  r := save_parity_ticket(b.owner_key,'{"id":"ticket-42","title":"Private second owner"}',0);
  assert r->>'revision' = '1';
  assert (select count(*) = 2 from parity_tickets);
  foreach table_name in array array['parity_accounts','parity_projects','parity_notes','parity_user_state','parity_tickets'] loop
    assert not has_table_privilege('anon',table_name,'SELECT');
    assert not has_table_privilege('authenticated',table_name,'SELECT');
    assert not has_table_privilege('authenticated',table_name,'INSERT');
    assert (select relrowsecurity from pg_class where oid = table_name::regclass);
  end loop;
  assert not has_function_privilege('authenticated','initialize_parity_account(uuid,text,text,text)','EXECUTE');
  assert not has_function_privilege('anon','save_parity_ticket(text,jsonb,bigint)','EXECUTE');
  assert has_function_privilege('service_role','initialize_parity_account(uuid,text,text,text)','EXECUTE');
end;
$$;
