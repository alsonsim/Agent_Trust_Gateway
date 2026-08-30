-- Run after supabase/migrations/20260829_trust_pass.sql.
-- This is a read-only catalog/privilege shape check; the surrounding transaction
-- makes it safe to run against a development project repeatedly.

begin;

do $shape_test$
declare
  rpc regprocedure;
  rpc_name text;
  helper regprocedure;
  helper_name text;
  browser_role text;
  table_name text;
  privilege_name text;
begin
  if not exists (
    select 1
    from pg_catalog.pg_class as relation
    join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
    where namespace.nspname = 'public'
      and relation.relname in ('delegation_requests', 'delegation_contracts')
      and relation.relrowsecurity
      and relation.relforcerowsecurity
    group by namespace.nspname
    having pg_catalog.count(*) = 2
  ) then
    raise exception 'Trust Pass tables must have forced row-level security';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.delegation_requests'::regclass
      and attribute.attname = 'requested_prompt'
      and not attribute.attisdropped
  ) then
    raise exception 'Delegation requests must not retain the raw requester prompt';
  end if;

  if (
    select pg_catalog.count(*)
    from pg_catalog.pg_attribute as attribute
    where attribute.attrelid = 'public.delegation_requests'::regclass
      and attribute.attname in ('sanitized_task_summary', 'task_digest')
      and attribute.attnotnull
      and not attribute.attisdropped
  ) <> 2 then
    raise exception 'Delegation requests require a sanitized summary and task digest';
  end if;

  foreach browser_role in array array['anon', 'authenticated'] loop
    foreach table_name in array array[
      'public.delegation_requests',
      'public.delegation_contracts'
    ] loop
      foreach privilege_name in array array[
        'SELECT',
        'INSERT',
        'UPDATE',
        'DELETE',
        'TRUNCATE',
        'REFERENCES',
        'TRIGGER'
      ] loop
        if pg_catalog.has_table_privilege(
          browser_role,
          table_name,
          privilege_name
        ) then
          raise exception '% must not have % on %',
            browser_role,
            privilege_name,
            table_name;
        end if;
      end loop;
    end loop;
  end loop;

  if exists (
    select 1
    from pg_catalog.pg_policies
    where schemaname = 'public'
      and tablename in ('delegation_requests', 'delegation_contracts')
  ) then
    raise exception 'Trust Pass tables must not expose row policies to client roles';
  end if;

  if not pg_catalog.has_table_privilege(
    'service_role',
    'public.delegation_requests',
    'SELECT'
  ) or not pg_catalog.has_table_privilege(
    'service_role',
    'public.delegation_contracts',
    'SELECT'
  ) then
    raise exception 'service_role must be able to read Trust Pass state';
  end if;

  if pg_catalog.has_table_privilege('service_role', 'public.delegation_requests', 'INSERT')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_requests', 'UPDATE')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_requests', 'DELETE')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_requests', 'TRUNCATE')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_requests', 'REFERENCES')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_requests', 'TRIGGER')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_contracts', 'INSERT')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_contracts', 'UPDATE')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_contracts', 'DELETE')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_contracts', 'TRUNCATE')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_contracts', 'REFERENCES')
    or pg_catalog.has_table_privilege('service_role', 'public.delegation_contracts', 'TRIGGER')
  then
    raise exception 'service_role must mutate Trust Pass state only through RPCs';
  end if;

  foreach rpc_name in array array[
    'public.create_delegation_request(uuid,text,text,timestamp with time zone,text)',
    'public.approve_delegation_request(uuid,uuid,uuid,text,uuid[],timestamp with time zone,text)',
    'public.reject_delegation_request(uuid,uuid,text)',
    'public.create_delegation_contract(uuid,uuid,text,uuid,text,text,uuid[],timestamp with time zone,text)',
    'public.consume_delegation_contract(uuid,uuid,text,uuid,text)',
    'public.revoke_delegation_contract(uuid,uuid,text)'
  ] loop
    rpc := pg_catalog.to_regprocedure(rpc_name);
    if rpc is null then
      raise exception 'Missing Trust Pass RPC: %', rpc_name;
    end if;
    if not pg_catalog.has_function_privilege('service_role', rpc, 'EXECUTE') then
      raise exception 'service_role cannot execute %', rpc_name;
    end if;
    if pg_catalog.has_function_privilege('anon', rpc, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', rpc, 'EXECUTE')
    then
      raise exception 'Browser role can execute %', rpc_name;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_proc as procedure
      where procedure.oid = rpc
        and procedure.prosecdef
        and exists (
          select 1
          from pg_catalog.unnest(procedure.proconfig) as setting(value)
          where value = 'search_path=""'
        )
    ) then
      raise exception '% must be SECURITY DEFINER with an empty search_path', rpc_name;
    end if;
  end loop;

  foreach helper_name in array array[
    'public._trust_pass_capability_department(text)',
    'public._trust_pass_contains_personal_information(text)',
    'public._trust_pass_sanitize_task_summary(text)',
    'public._trust_pass_uuid_set_is_canonical(uuid[])',
    'public._trust_pass_resource_digests_are_valid(uuid[],jsonb)',
    'public._trust_pass_guard_request_update()',
    'public._trust_pass_guard_contract_update()',
    'public._trust_pass_human(uuid)',
    'public._trust_pass_owned_resource_digests(uuid,uuid[])',
    'public._trust_pass_lock_owned_resource_inputs(uuid,uuid[])',
    'public._trust_pass_record_decision(text,uuid,text,text,uuid,text,text,text,text,text,text,text,text,timestamp with time zone)',
    'public._trust_pass_insert_contract(uuid,text,uuid,uuid,uuid,text,text,uuid[],timestamp with time zone)'
  ] loop
    helper := pg_catalog.to_regprocedure(helper_name);
    if helper is null then
      raise exception 'Missing internal Trust Pass helper: %', helper_name;
    end if;
    if pg_catalog.has_function_privilege('service_role', helper, 'EXECUTE')
      or pg_catalog.has_function_privilege('anon', helper, 'EXECUTE')
      or pg_catalog.has_function_privilege('authenticated', helper, 'EXECUTE')
    then
      raise exception 'Internal helper is directly executable: %', helper_name;
    end if;
    if not exists (
      select 1
      from pg_catalog.pg_proc as procedure
      where procedure.oid = helper
        and exists (
          select 1
          from pg_catalog.unnest(procedure.proconfig) as setting(value)
          where value = 'search_path=""'
        )
    ) then
      raise exception '% must have an empty search_path', helper_name;
    end if;
  end loop;

  if not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.delegation_requests'::regclass
      and tgname = 'delegation_requests_guard_update'
      and not tgisinternal
  ) or not exists (
    select 1 from pg_catalog.pg_trigger
    where tgrelid = 'public.delegation_contracts'::regclass
      and tgname = 'delegation_contracts_guard_update'
      and not tgisinternal
  ) then
    raise exception 'Immutable-scope triggers are missing';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'delegation_requests_pending_expiry_idx'
  ) or not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'delegation_contracts_active_expiry_idx'
  ) or not exists (
    select 1 from pg_catalog.pg_indexes
    where schemaname = 'public' and indexname = 'delegation_contracts_run_id_idx'
  ) then
    raise exception 'Trust Pass lifecycle indexes are missing';
  end if;
end
$shape_test$;

rollback;
