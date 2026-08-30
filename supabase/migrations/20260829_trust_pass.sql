-- Agent Trust Pass persistence for Supabase/PostgreSQL.
--
-- This migration deliberately exposes no table or RPC access to browser roles.
-- The application service role is the only intended caller. Lifecycle policy
-- denials are returned as JSON so their denial evidence commits. Invalid request
-- or issuance parameters and unexpected errors raise and roll the transaction
-- back; the adapter must validate and audit issuance denials before calling.

begin;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

do $prerequisites$
begin
  if pg_catalog.to_regclass('auth.users') is null then
    raise exception 'Trust Pass migration requires auth.users';
  end if;
  if pg_catalog.to_regclass('public.profiles') is null then
    raise exception 'Trust Pass migration requires public.profiles';
  end if;
  if pg_catalog.to_regclass('public.protected_resources') is null then
    raise exception 'Trust Pass migration requires public.protected_resources';
  end if;
  if pg_catalog.to_regclass('public.authorization_decisions') is null then
    raise exception 'Trust Pass migration requires public.authorization_decisions';
  end if;
end
$prerequisites$;

create or replace function public._trust_pass_capability_department(capability text)
returns text
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select case capability
    when 'frontend.interface-implementation' then 'frontend'
    when 'backend.service-implementation' then 'backend'
    when 'qa.release-validation' then 'qa'
    else null
  end
$function$;

create or replace function public._trust_pass_contains_personal_information(value text)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select
    value ~* '[[:alnum:]._%+-]+@[[:alnum:].-]+[.][[:alpha:]]{2,}'
    or value ~* '(^|[^[:alnum:]_])[STFGM][0-9]{7}[A-Z]([^[:alnum:]_]|$)'
    or value ~ '(^|[^0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}([^0-9]|$)'
    or value ~ '[+]?[0-9]{1,3}[ .-]([0-9()]{2,4}[ .-]){1,3}[0-9]{3,4}'
    or value ~* '(employee|staff|passport|national)[[:space:]]*(id|number)[[:space:]]*[:#=-][[:space:]]*[[:alnum:]-]{3,}'
    or value ~* '(full[[:space:]]+name|employee[[:space:]]+name)[[:space:]]*:[[:space:]]*[^,;[:cntrl:]]{2,80}'
$function$;

create or replace function public._trust_pass_sanitize_task_summary(value text)
returns text
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $function$
declare
  sanitized text := value;
begin
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '[[:alnum:]._%+-]+@[[:alnum:].-]+[.][[:alpha:]]{2,}',
    '[personal information redacted]',
    'gi'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '(^|[^[:alnum:]_])[STFGM][0-9]{7}[A-Z]([^[:alnum:]_]|$)',
    '\1[personal information redacted]\2',
    'gi'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '(^|[^0-9])[0-9]{3}-[0-9]{2}-[0-9]{4}([^0-9]|$)',
    '\1[personal information redacted]\2',
    'g'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '[+]?[0-9]{1,3}[ .-]([0-9()]{2,4}[ .-]){1,3}[0-9]{3,4}',
    '[personal information redacted]',
    'g'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '(employee|staff|passport|national)[[:space:]]*(id|number)[[:space:]]*[:#=-][[:space:]]*[[:alnum:]-]{3,}',
    '[personal information redacted]',
    'gi'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '(full[[:space:]]+name|employee[[:space:]]+name)[[:space:]]*:[[:space:]]*[^,;[:cntrl:]]{2,80}',
    '[personal information redacted]',
    'gi'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    '(api[ _-]?key|access[ _-]?token|password|secret)[[:space:]]*[:=][[:space:]]*[^[:space:],;]+',
    '[secret redacted]',
    'gi'
  );
  sanitized := pg_catalog.regexp_replace(
    sanitized,
    'Bearer[[:space:]]+[[:alnum:]._-]+',
    '[secret redacted]',
    'gi'
  );
  sanitized := pg_catalog.regexp_replace(sanitized, '[[:cntrl:]]+', ' ', 'g');
  sanitized := pg_catalog.regexp_replace(sanitized, '[[:space:]]+', ' ', 'g');
  sanitized := pg_catalog.btrim(sanitized);
  if sanitized = '' then
    return '(empty task)';
  end if;
  return pg_catalog.left(sanitized, 280);
end
$function$;

create or replace function public._trust_pass_uuid_set_is_canonical(values_to_check uuid[])
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select
    pg_catalog.cardinality(values_to_check) <= 20
    and pg_catalog.array_position(values_to_check, null) is null
    and values_to_check = array(
      select distinct item
      from pg_catalog.unnest(values_to_check) as items(item)
      order by item
    )
$function$;

create or replace function public._trust_pass_resource_digests_are_valid(
  resource_ids uuid[],
  resource_digests jsonb
)
returns boolean
language sql
immutable
strict
parallel safe
set search_path = ''
as $function$
  select
    pg_catalog.jsonb_typeof(resource_digests) = 'object'
    and (
      select pg_catalog.count(*)
      from pg_catalog.jsonb_object_keys(resource_digests)
    ) = pg_catalog.cardinality(resource_ids)
    and not exists (
      select 1
      from pg_catalog.unnest(resource_ids) as resources(resource_id)
      where not (resource_digests ? resource_id::text)
        or resource_digests ->> resource_id::text !~ '^[0-9a-f]{64}$'
    )
    and not exists (
      select 1
      from pg_catalog.jsonb_object_keys(resource_digests) as keys(resource_id)
      where not (
        resource_id = any (
          array(
            select scoped_id::text
            from pg_catalog.unnest(resource_ids) as scoped(scoped_id)
          )
        )
      )
    )
$function$;

create table public.delegation_requests (
  id uuid primary key,
  requester_human_id uuid not null references auth.users(id) on delete restrict,
  requester_email text not null,
  requester_display_name text not null,
  requester_department text not null,
  provider_department text not null,
  required_capability text not null,
  sanitized_task_summary text not null,
  personal_information text not null,
  task_digest text not null,
  status text not null default 'pending',
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  reviewed_at timestamptz,
  contract_id uuid,
  constraint delegation_requests_email_length check (
    pg_catalog.char_length(requester_email) between 3 and 320
  ),
  constraint delegation_requests_display_name_length check (
    pg_catalog.char_length(requester_display_name) between 1 and 200
  ),
  constraint delegation_requests_department check (
    requester_department in ('frontend', 'backend', 'qa')
    and provider_department in ('frontend', 'backend', 'qa')
    and requester_department <> provider_department
  ),
  constraint delegation_requests_capability check (
    provider_department = public._trust_pass_capability_department(required_capability)
  ),
  constraint delegation_requests_summary_length check (
    pg_catalog.char_length(sanitized_task_summary) between 1 and 500
  ),
  constraint delegation_requests_personal_information check (
    personal_information in ('none_detected', 'possible')
  ),
  constraint delegation_requests_digest check (task_digest ~ '^[0-9a-f]{64}$'),
  constraint delegation_requests_status check (
    status in ('pending', 'approved', 'rejected', 'expired')
  ),
  constraint delegation_requests_expiry check (
    expires_at > created_at and expires_at <= created_at + interval '30 minutes'
  ),
  constraint delegation_requests_state check (
    (status = 'pending' and reviewed_at is null and contract_id is null)
    or (status = 'approved' and reviewed_at is not null and contract_id is not null)
    or (status in ('rejected', 'expired') and reviewed_at is not null and contract_id is null)
  )
);

create table public.delegation_contracts (
  id uuid primary key,
  request_id uuid unique references public.delegation_requests(id) on delete restrict,
  required_capability text not null,
  provider_department text not null,
  sanitized_task_summary text not null,
  personal_information text not null,
  approving_human_id uuid not null references auth.users(id) on delete restrict,
  grantee_human_id uuid not null references auth.users(id) on delete restrict,
  grantee_email text not null,
  grantee_display_name text not null,
  grantee_department text not null,
  agent_id uuid not null,
  agent_name text not null,
  approved_prompt text not null,
  exact_prompt_digest text not null,
  approved_resource_ids uuid[] not null default '{}'::uuid[],
  approved_resource_digests jsonb not null default '{}'::jsonb,
  allowed_actions text[] not null default array['agent.invoke']::text[],
  result_visibility text not null default 'final_output_only',
  maximum_uses integer not null default 1,
  uses_consumed integer not null default 0,
  expires_at timestamptz not null,
  status text not null default 'active',
  run_id uuid,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  consumed_at timestamptz,
  revoked_at timestamptz,
  constraint delegation_contracts_capability check (
    provider_department = public._trust_pass_capability_department(required_capability)
  ),
  constraint delegation_contracts_departments check (
    provider_department in ('frontend', 'backend', 'qa')
    and grantee_department in ('frontend', 'backend', 'qa')
    and provider_department <> grantee_department
    and approving_human_id <> grantee_human_id
  ),
  constraint delegation_contracts_grantee_snapshot check (
    pg_catalog.char_length(grantee_email) between 3 and 320
    and pg_catalog.char_length(grantee_display_name) between 1 and 200
  ),
  constraint delegation_contracts_agent_name_length check (
    pg_catalog.char_length(agent_name) between 1 and 200
  ),
  constraint delegation_contracts_summary_length check (
    pg_catalog.char_length(sanitized_task_summary) between 1 and 500
  ),
  constraint delegation_contracts_personal_information check (
    personal_information in ('none_detected', 'possible')
  ),
  constraint delegation_contracts_prompt_length check (
    pg_catalog.char_length(approved_prompt) between 1 and 50000
  ),
  constraint delegation_contracts_prompt_digest check (
    exact_prompt_digest ~ '^[0-9a-f]{64}$'
  ),
  constraint delegation_contracts_resource_scope check (
    public._trust_pass_uuid_set_is_canonical(approved_resource_ids)
    and public._trust_pass_resource_digests_are_valid(
      approved_resource_ids,
      approved_resource_digests
    )
  ),
  constraint delegation_contracts_action_scope check (
    allowed_actions = array['agent.invoke']::text[]
  ),
  constraint delegation_contracts_visibility check (
    result_visibility = 'final_output_only'
  ),
  constraint delegation_contracts_one_use check (
    maximum_uses = 1 and uses_consumed between 0 and 1
  ),
  constraint delegation_contracts_status check (
    status in ('active', 'consumed', 'revoked', 'expired')
  ),
  constraint delegation_contracts_expiry check (
    expires_at > created_at and expires_at <= created_at + interval '10 minutes'
  ),
  constraint delegation_contracts_state check (
    (
      status = 'active' and uses_consumed = 0 and run_id is null
      and consumed_at is null and revoked_at is null
    )
    or (
      status = 'consumed' and uses_consumed = 1 and run_id is not null
      and consumed_at is not null and revoked_at is null
    )
    or (
      status = 'revoked' and uses_consumed = 0 and run_id is null
      and consumed_at is null and revoked_at is not null
    )
    or (
      status = 'expired' and uses_consumed = 0 and run_id is null
      and consumed_at is null and revoked_at is null
    )
  )
);

alter table public.delegation_requests
  add constraint delegation_requests_contract_fk
  foreign key (contract_id)
  references public.delegation_contracts(id)
  on delete restrict
  deferrable initially deferred;

create index delegation_requests_requester_created_idx
  on public.delegation_requests (requester_human_id, created_at desc);
create index delegation_requests_inbox_idx
  on public.delegation_requests (provider_department, status, created_at desc);
create index delegation_requests_pending_expiry_idx
  on public.delegation_requests (expires_at)
  where status = 'pending';

create index delegation_contracts_grantee_created_idx
  on public.delegation_contracts (grantee_human_id, created_at desc);
create index delegation_contracts_approver_created_idx
  on public.delegation_contracts (approving_human_id, created_at desc);
create index delegation_contracts_agent_active_idx
  on public.delegation_contracts (agent_id, expires_at)
  where status = 'active';
create index delegation_contracts_active_expiry_idx
  on public.delegation_contracts (expires_at)
  where status = 'active';
create unique index delegation_contracts_run_id_idx
  on public.delegation_contracts (run_id)
  where run_id is not null;

alter table public.delegation_requests enable row level security;
alter table public.delegation_requests force row level security;
alter table public.delegation_contracts enable row level security;
alter table public.delegation_contracts force row level security;

revoke all on table public.delegation_requests
  from public, anon, authenticated, service_role;
revoke all on table public.delegation_contracts
  from public, anon, authenticated, service_role;
grant select on table public.delegation_requests to service_role;
grant select on table public.delegation_contracts to service_role;

comment on table public.delegation_requests is
  'Service-only consent requests retaining a sanitized task summary and digest, never the raw prompt.';
comment on table public.delegation_contracts is
  'Service-only immutable one-use Agent Trust Pass scopes.';

create or replace function public._trust_pass_guard_request_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if row(
    new.id,
    new.requester_human_id,
    new.requester_email,
    new.requester_display_name,
    new.requester_department,
    new.provider_department,
    new.required_capability,
    new.sanitized_task_summary,
    new.personal_information,
    new.task_digest,
    new.created_at,
    new.expires_at
  ) is distinct from row(
    old.id,
    old.requester_human_id,
    old.requester_email,
    old.requester_display_name,
    old.requester_department,
    old.provider_department,
    old.required_capability,
    old.sanitized_task_summary,
    old.personal_information,
    old.task_digest,
    old.created_at,
    old.expires_at
  ) then
    raise exception 'Delegation request scope is immutable';
  end if;

  if old.status <> new.status
    and not (old.status = 'pending' and new.status in ('approved', 'rejected', 'expired'))
  then
    raise exception 'Invalid delegation request status transition: % -> %', old.status, new.status;
  end if;

  if old.status <> 'pending'
    and row(new.status, new.reviewed_at, new.contract_id)
      is distinct from row(old.status, old.reviewed_at, old.contract_id)
  then
    raise exception 'Resolved delegation requests are immutable';
  end if;
  return new;
end
$function$;

create trigger delegation_requests_guard_update
before update on public.delegation_requests
for each row execute function public._trust_pass_guard_request_update();

create or replace function public._trust_pass_guard_contract_update()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  if row(
    new.id,
    new.request_id,
    new.required_capability,
    new.provider_department,
    new.sanitized_task_summary,
    new.personal_information,
    new.approving_human_id,
    new.grantee_human_id,
    new.grantee_email,
    new.grantee_display_name,
    new.grantee_department,
    new.agent_id,
    new.agent_name,
    new.approved_prompt,
    new.exact_prompt_digest,
    new.approved_resource_ids,
    new.approved_resource_digests,
    new.allowed_actions,
    new.result_visibility,
    new.maximum_uses,
    new.created_at,
    new.expires_at
  ) is distinct from row(
    old.id,
    old.request_id,
    old.required_capability,
    old.provider_department,
    old.sanitized_task_summary,
    old.personal_information,
    old.approving_human_id,
    old.grantee_human_id,
    old.grantee_email,
    old.grantee_display_name,
    old.grantee_department,
    old.agent_id,
    old.agent_name,
    old.approved_prompt,
    old.exact_prompt_digest,
    old.approved_resource_ids,
    old.approved_resource_digests,
    old.allowed_actions,
    old.result_visibility,
    old.maximum_uses,
    old.created_at,
    old.expires_at
  ) then
    raise exception 'Delegation contract scope is immutable';
  end if;

  if old.status <> new.status
    and not (old.status = 'active' and new.status in ('consumed', 'revoked', 'expired'))
  then
    raise exception 'Invalid delegation contract status transition: % -> %', old.status, new.status;
  end if;

  if old.status <> 'active'
    and row(new.status, new.uses_consumed, new.run_id, new.consumed_at, new.revoked_at)
      is distinct from row(
        old.status,
        old.uses_consumed,
        old.run_id,
        old.consumed_at,
        old.revoked_at
      )
  then
    raise exception 'Final delegation contract state is immutable';
  end if;
  return new;
end
$function$;

create trigger delegation_contracts_guard_update
before update on public.delegation_contracts
for each row execute function public._trust_pass_guard_contract_update();

create or replace function public._trust_pass_human(p_human_id uuid)
returns table(email text, display_name text, department text)
language sql
stable
security definer
set search_path = ''
as $function$
  select
    users.email::text,
    profiles.display_name::text,
    profiles.department::text
  from auth.users as users
  join public.profiles as profiles on profiles.id = users.id
  where users.id = p_human_id
  limit 1
$function$;

create or replace function public._trust_pass_owned_resource_digests(
  p_owner_id uuid,
  p_resource_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare
  matching_count integer;
  digests jsonb;
begin
  select
    pg_catalog.count(*)::integer,
    pg_catalog.coalesce(
      pg_catalog.jsonb_object_agg(
        resources.id::text,
        pg_catalog.encode(
          extensions.digest(
            pg_catalog.convert_to(pg_catalog.coalesce(resources.content, ''), 'UTF8'),
            'sha256'
          ),
          'hex'
        )
        order by resources.id
      ),
      '{}'::jsonb
    )
  into matching_count, digests
  from pg_catalog.unnest(p_resource_ids) as requested(resource_id)
  join public.protected_resources as resources
    on resources.id = requested.resource_id
   and resources.owner_id = p_owner_id;

  if matching_count <> pg_catalog.cardinality(p_resource_ids) then
    return null;
  end if;
  return digests;
end
$function$;

create or replace function public._trust_pass_lock_owned_resource_inputs(
  p_owner_id uuid,
  p_resource_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  resource_row record;
  resource_count integer := 0;
  resource_content_bytes bytea;
  resource_digest text;
  resource_digests jsonb := '{}'::jsonb;
  approved_inputs jsonb := '[]'::jsonb;
begin
  for resource_row in
    select
      requested.position,
      resources.id,
      pg_catalog.coalesce(resources.content, '') as content
    from pg_catalog.unnest(p_resource_ids) with ordinality
      as requested(resource_id, position)
    join public.protected_resources as resources
      on resources.id = requested.resource_id
     and resources.owner_id = p_owner_id
    order by requested.position
    for share of resources
  loop
    resource_count := resource_count + 1;
    resource_content_bytes := pg_catalog.convert_to(resource_row.content, 'UTF8');
    resource_digest := pg_catalog.encode(
      extensions.digest(
        resource_content_bytes,
        'sha256'
      ),
      'hex'
    );
    resource_digests := resource_digests || pg_catalog.jsonb_build_object(
      resource_row.id::text,
      resource_digest
    );
    approved_inputs := approved_inputs || pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'resourceId', resource_row.id,
        'contentUtf8Base64', pg_catalog.encode(resource_content_bytes, 'base64'),
        'sha256', resource_digest
      )
    );
  end loop;

  if resource_count <> pg_catalog.cardinality(p_resource_ids) then
    return null;
  end if;

  return pg_catalog.jsonb_build_object(
    'digests', resource_digests,
    'inputs', approved_inputs
  );
end
$function$;

create or replace function public._trust_pass_record_decision(
  p_audit_request_id text,
  p_human_user_id uuid,
  p_human_email text,
  p_human_department text,
  p_agent_id uuid,
  p_agent_name text,
  p_action text,
  p_target_type text,
  p_target_id text,
  p_target_label text,
  p_decision text,
  p_reason_code text,
  p_reason text,
  p_created_at timestamptz
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  decision_id uuid := pg_catalog.gen_random_uuid();
begin
  insert into public.authorization_decisions (
    id,
    request_id,
    human_user_id,
    human_email,
    human_department,
    agent_id,
    agent_name,
    action,
    target_type,
    target_id,
    target_label,
    decision,
    reason_code,
    reason,
    created_at
  ) values (
    decision_id,
    p_audit_request_id,
    p_human_user_id,
    p_human_email,
    p_human_department,
    p_agent_id,
    p_agent_name,
    p_action,
    p_target_type,
    p_target_id,
    p_target_label,
    p_decision,
    p_reason_code,
    p_reason,
    p_created_at
  );
  return decision_id;
end
$function$;

revoke all on function public._trust_pass_capability_department(text)
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_contains_personal_information(text)
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_sanitize_task_summary(text)
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_uuid_set_is_canonical(uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_resource_digests_are_valid(uuid[], jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_guard_request_update()
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_guard_contract_update()
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_human(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_owned_resource_digests(uuid, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_lock_owned_resource_inputs(uuid, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public._trust_pass_record_decision(
  text, uuid, text, text, uuid, text, text, text, text, text, text, text, text, timestamptz
) from public, anon, authenticated, service_role;

create or replace function public._trust_pass_insert_contract(
  p_request_id uuid,
  p_required_capability text,
  p_approving_human_id uuid,
  p_grantee_human_id uuid,
  p_agent_id uuid,
  p_agent_name text,
  p_approved_prompt text,
  p_approved_resource_ids uuid[],
  p_expires_at timestamptz
)
returns public.delegation_contracts
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_provider_department text;
  v_approver_email text;
  v_approver_display_name text;
  v_approver_department text;
  v_grantee_email text;
  v_grantee_display_name text;
  v_grantee_department text;
  v_resource_ids uuid[];
  v_resource_digests jsonb;
  v_contract public.delegation_contracts%rowtype;
begin
  v_provider_department := public._trust_pass_capability_department(p_required_capability);
  if v_provider_department is null then
    raise exception 'Unsupported Trust Pass capability';
  end if;

  select human.email, human.display_name, human.department
  into v_approver_email, v_approver_display_name, v_approver_department
  from public._trust_pass_human(p_approving_human_id) as human;
  if not found then
    raise exception 'Approving human profile not found';
  end if;

  select human.email, human.display_name, human.department
  into v_grantee_email, v_grantee_display_name, v_grantee_department
  from public._trust_pass_human(p_grantee_human_id) as human;
  if not found then
    raise exception 'Grantee human profile not found';
  end if;

  if v_approver_department <> v_provider_department then
    raise exception 'Only the capability-owning department can issue this Trust Pass';
  end if;
  if p_approving_human_id = p_grantee_human_id then
    raise exception 'A Trust Pass must delegate to another authenticated human';
  end if;
  if v_grantee_department = v_provider_department then
    raise exception 'A Trust Pass must cross the capability boundary';
  end if;
  if p_expires_at <= v_now or p_expires_at > v_now + interval '10 minutes' then
    raise exception 'Trust Pass expiry must be in the next ten minutes';
  end if;
  if p_approved_prompt is null
    or pg_catalog.char_length(p_approved_prompt) not between 1 and 50000
  then
    raise exception 'The exact approved prompt must contain between 1 and 50000 characters';
  end if;

  if p_approved_resource_ids is null
    or pg_catalog.array_position(p_approved_resource_ids, null) is not null
    or pg_catalog.cardinality(p_approved_resource_ids) > 20
  then
    raise exception 'Approved resource scope is invalid';
  end if;
  select pg_catalog.coalesce(
    pg_catalog.array_agg(scoped.resource_id order by scoped.resource_id),
    '{}'::uuid[]
  )
  into v_resource_ids
  from (
    select distinct resource_id
    from pg_catalog.unnest(p_approved_resource_ids) as requested(resource_id)
  ) as scoped;

  v_resource_digests := public._trust_pass_owned_resource_digests(
    p_approving_human_id,
    v_resource_ids
  );
  if v_resource_digests is null then
    raise exception 'Every approved resource must belong to the approving human';
  end if;

  insert into public.delegation_contracts (
    id,
    request_id,
    required_capability,
    provider_department,
    sanitized_task_summary,
    personal_information,
    approving_human_id,
    grantee_human_id,
    grantee_email,
    grantee_display_name,
    grantee_department,
    agent_id,
    agent_name,
    approved_prompt,
    exact_prompt_digest,
    approved_resource_ids,
    approved_resource_digests,
    allowed_actions,
    result_visibility,
    maximum_uses,
    uses_consumed,
    expires_at,
    status,
    run_id,
    created_at,
    consumed_at,
    revoked_at
  ) values (
    pg_catalog.gen_random_uuid(),
    p_request_id,
    p_required_capability,
    v_provider_department,
    public._trust_pass_sanitize_task_summary(p_approved_prompt),
    case
      when public._trust_pass_contains_personal_information(p_approved_prompt)
        then 'possible'
      else 'none_detected'
    end,
    p_approving_human_id,
    p_grantee_human_id,
    v_grantee_email,
    v_grantee_display_name,
    v_grantee_department,
    p_agent_id,
    p_agent_name,
    p_approved_prompt,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(p_approved_prompt, 'UTF8'), 'sha256'),
      'hex'
    ),
    v_resource_ids,
    v_resource_digests,
    array['agent.invoke']::text[],
    'final_output_only',
    1,
    0,
    p_expires_at,
    'active',
    null,
    v_now,
    null,
    null
  )
  returning * into v_contract;

  return v_contract;
end
$function$;

revoke all on function public._trust_pass_insert_contract(
  uuid, text, uuid, uuid, uuid, text, text, uuid[], timestamptz
) from public, anon, authenticated, service_role;

create or replace function public.create_delegation_request(
  p_requester_human_id uuid,
  p_required_capability text,
  p_requested_prompt text,
  p_expires_at timestamptz,
  p_audit_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_display_name text;
  v_department text;
  v_provider_department text;
  v_request public.delegation_requests%rowtype;
begin
  select human.email, human.display_name, human.department
  into v_email, v_display_name, v_department
  from public._trust_pass_human(p_requester_human_id) as human;
  if not found then
    raise exception 'Requester human profile not found';
  end if;

  v_provider_department := public._trust_pass_capability_department(p_required_capability);
  if v_provider_department is null then
    raise exception 'Unsupported Trust Pass capability';
  end if;
  if v_department = v_provider_department then
    raise exception 'Delegation requests must target another capability-owning department';
  end if;
  if p_expires_at <= v_now or p_expires_at > v_now + interval '30 minutes' then
    raise exception 'Delegation request expiry must be in the next thirty minutes';
  end if;
  if p_requested_prompt is null
    or pg_catalog.char_length(p_requested_prompt) not between 1 and 50000
  then
    raise exception 'The requested prompt must contain between 1 and 50000 characters';
  end if;

  insert into public.delegation_requests (
    id,
    requester_human_id,
    requester_email,
    requester_display_name,
    requester_department,
    provider_department,
    required_capability,
    sanitized_task_summary,
    personal_information,
    task_digest,
    status,
    created_at,
    expires_at,
    reviewed_at,
    contract_id
  ) values (
    pg_catalog.gen_random_uuid(),
    p_requester_human_id,
    v_email,
    v_display_name,
    v_department,
    v_provider_department,
    p_required_capability,
    public._trust_pass_sanitize_task_summary(p_requested_prompt),
    case
      when public._trust_pass_contains_personal_information(p_requested_prompt)
        then 'possible'
      else 'none_detected'
    end,
    pg_catalog.encode(
      extensions.digest(pg_catalog.convert_to(p_requested_prompt, 'UTF8'), 'sha256'),
      'hex'
    ),
    'pending',
    v_now,
    p_expires_at,
    null,
    null
  )
  returning * into v_request;

  perform public._trust_pass_record_decision(
    p_audit_request_id,
    p_requester_human_id,
    v_email,
    v_department,
    null,
    null,
    'delegation.request',
    'capability',
    v_request.id::text,
    p_required_capability,
    'allow',
    'DELEGATION_REQUESTED',
    'The capability broker forwarded a consented request without exposing an Agent.',
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'reasonCode', 'DELEGATION_REQUESTED',
    'request', pg_catalog.to_jsonb(v_request)
  );
end
$function$;

revoke all on function public.create_delegation_request(
  uuid, text, text, timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_delegation_request(
  uuid, text, text, timestamptz, text
) to service_role;

create or replace function public.create_delegation_contract(
  p_approving_human_id uuid,
  p_grantee_human_id uuid,
  p_required_capability text,
  p_agent_id uuid,
  p_agent_name text,
  p_approved_prompt text,
  p_approved_resource_ids uuid[],
  p_expires_at timestamptz,
  p_audit_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_display_name text;
  v_department text;
  v_contract public.delegation_contracts%rowtype;
begin
  select human.email, human.display_name, human.department
  into v_email, v_display_name, v_department
  from public._trust_pass_human(p_approving_human_id) as human;
  if not found then
    raise exception 'Approving human profile not found';
  end if;

  v_contract := public._trust_pass_insert_contract(
    null,
    p_required_capability,
    p_approving_human_id,
    p_grantee_human_id,
    p_agent_id,
    p_agent_name,
    p_approved_prompt,
    p_approved_resource_ids,
    p_expires_at
  );

  perform public._trust_pass_record_decision(
    p_audit_request_id,
    p_approving_human_id,
    v_email,
    v_department,
    p_agent_id,
    p_agent_name,
    'delegation.approve',
    'delegation',
    v_contract.id::text,
    'One-use Agent Trust Pass',
    'allow',
    'DELEGATION_APPROVED',
    'The Agent owner approved one exact task, grantee, Run, and bounded resource scope.',
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'reasonCode', 'DELEGATION_APPROVED',
    'contract', pg_catalog.to_jsonb(v_contract)
  );
end
$function$;

revoke all on function public.create_delegation_contract(
  uuid, uuid, text, uuid, text, text, uuid[], timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.create_delegation_contract(
  uuid, uuid, text, uuid, text, text, uuid[], timestamptz, text
) to service_role;

create or replace function public.approve_delegation_request(
  p_request_id uuid,
  p_approving_human_id uuid,
  p_agent_id uuid,
  p_agent_name text,
  p_approved_resource_ids uuid[],
  p_expires_at timestamptz,
  p_audit_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_display_name text;
  v_department text;
  v_reason_code text;
  v_reason text;
  v_effective_expiry timestamptz;
  v_request public.delegation_requests%rowtype;
  v_contract public.delegation_contracts%rowtype;
begin
  select human.email, human.display_name, human.department
  into v_email, v_display_name, v_department
  from public._trust_pass_human(p_approving_human_id) as human;
  if not found then
    raise exception 'Approving human profile not found';
  end if;

  select * into v_request
  from public.delegation_requests
  where id = p_request_id
  for update;
  v_now := pg_catalog.clock_timestamp();

  if not found or v_request.provider_department <> v_department then
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      null,
      null,
      'delegation.approve',
      'delegation',
      p_request_id::text,
      'Permission request',
      'deny',
      'HUMAN_AGENT_OWNER_MISMATCH',
      'The authenticated human is not an approver for this capability request.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'HUMAN_AGENT_OWNER_MISMATCH'
    );
  end if;

  if v_request.status = 'pending' and v_request.expires_at <= v_now then
    update public.delegation_requests
    set status = 'expired', reviewed_at = v_now
    where id = v_request.id
    returning * into v_request;
  end if;

  if v_request.status <> 'pending' then
    v_reason_code := case
      when v_request.status = 'expired' then 'DELEGATION_EXPIRED'
      when v_request.status = 'rejected' then 'DELEGATION_REJECTED'
      else 'DELEGATION_CONSUMED'
    end;
    v_reason := 'This permission request is no longer pending.';
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      p_agent_id,
      p_agent_name,
      'delegation.approve',
      'delegation',
      p_request_id::text,
      'Permission request',
      'deny',
      v_reason_code,
      v_reason,
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', v_reason_code,
      'requestStatus', v_request.status
    );
  end if;

  v_effective_expiry := pg_catalog.least(p_expires_at, v_request.expires_at);
  v_contract := public._trust_pass_insert_contract(
    v_request.id,
    v_request.required_capability,
    p_approving_human_id,
    v_request.requester_human_id,
    p_agent_id,
    p_agent_name,
    v_request.sanitized_task_summary,
    p_approved_resource_ids,
    v_effective_expiry
  );

  update public.delegation_requests
  set status = 'approved', reviewed_at = v_now, contract_id = v_contract.id
  where id = v_request.id
  returning * into v_request;

  perform public._trust_pass_record_decision(
    p_audit_request_id,
    p_approving_human_id,
    v_email,
    v_department,
    p_agent_id,
    p_agent_name,
    'delegation.approve',
    'delegation',
    v_contract.id::text,
    'One-use Agent Trust Pass',
    'allow',
    'DELEGATION_APPROVED',
    'The capability owner approved one exact task, grantee, Run, and bounded resource scope.',
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'reasonCode', 'DELEGATION_APPROVED',
    'contract', pg_catalog.to_jsonb(v_contract)
  );
end
$function$;

revoke all on function public.approve_delegation_request(
  uuid, uuid, uuid, text, uuid[], timestamptz, text
) from public, anon, authenticated, service_role;
grant execute on function public.approve_delegation_request(
  uuid, uuid, uuid, text, uuid[], timestamptz, text
) to service_role;

create or replace function public.reject_delegation_request(
  p_request_id uuid,
  p_approving_human_id uuid,
  p_audit_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_display_name text;
  v_department text;
  v_reason_code text;
  v_request public.delegation_requests%rowtype;
begin
  select human.email, human.display_name, human.department
  into v_email, v_display_name, v_department
  from public._trust_pass_human(p_approving_human_id) as human;
  if not found then
    raise exception 'Approving human profile not found';
  end if;

  select * into v_request
  from public.delegation_requests
  where id = p_request_id
  for update;
  v_now := pg_catalog.clock_timestamp();

  if not found or v_request.provider_department <> v_department then
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      null,
      null,
      'delegation.reject',
      'delegation',
      p_request_id::text,
      'Permission request',
      'deny',
      'HUMAN_AGENT_OWNER_MISMATCH',
      'The authenticated human is not an approver for this capability request.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'HUMAN_AGENT_OWNER_MISMATCH'
    );
  end if;

  if v_request.status = 'pending' and v_request.expires_at <= v_now then
    update public.delegation_requests
    set status = 'expired', reviewed_at = pg_catalog.clock_timestamp()
    where id = v_request.id
      and status = 'pending'
      and expires_at <= pg_catalog.clock_timestamp()
    returning * into v_request;
  end if;

  if v_request.status <> 'pending' then
    v_reason_code := case
      when v_request.status = 'expired' then 'DELEGATION_EXPIRED'
      when v_request.status = 'rejected' then 'DELEGATION_REJECTED'
      else 'DELEGATION_CONSUMED'
    end;
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      null,
      null,
      'delegation.reject',
      'delegation',
      p_request_id::text,
      'Permission request',
      'deny',
      v_reason_code,
      'This permission request is no longer pending.',
      pg_catalog.clock_timestamp()
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', v_reason_code,
      'requestStatus', v_request.status
    );
  end if;

  update public.delegation_requests
  set status = 'rejected', reviewed_at = pg_catalog.clock_timestamp()
  where id = v_request.id
    and status = 'pending'
    and expires_at > pg_catalog.clock_timestamp()
  returning * into v_request;

  if not found then
    update public.delegation_requests
    set status = 'expired', reviewed_at = pg_catalog.clock_timestamp()
    where id = p_request_id
      and status = 'pending'
      and expires_at <= pg_catalog.clock_timestamp()
    returning * into v_request;
    v_now := pg_catalog.clock_timestamp();
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      null,
      null,
      'delegation.reject',
      'delegation',
      p_request_id::text,
      'Permission request',
      'deny',
      'DELEGATION_EXPIRED',
      'This permission request expired before rejection was committed.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'DELEGATION_EXPIRED',
      'requestStatus', 'expired'
    );
  end if;

  v_now := v_request.reviewed_at;
  perform public._trust_pass_record_decision(
    p_audit_request_id,
    p_approving_human_id,
    v_email,
    v_department,
    null,
    null,
    'delegation.reject',
    'delegation',
    v_request.id::text,
    'Permission request',
    'allow',
    'DELEGATION_REJECTED',
    'The capability owner rejected the pending permission request.',
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'reasonCode', 'DELEGATION_REJECTED',
    'request', pg_catalog.to_jsonb(v_request)
  );
end
$function$;

revoke all on function public.reject_delegation_request(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.reject_delegation_request(uuid, uuid, text)
  to service_role;

create or replace function public.consume_delegation_contract(
  p_contract_id uuid,
  p_grantee_human_id uuid,
  p_submitted_prompt text,
  p_run_id uuid,
  p_audit_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_display_name text;
  v_department text;
  v_reason_code text;
  v_reason text;
  v_submitted_prompt_digest text;
  v_locked_resource_inputs jsonb;
  v_current_resource_digests jsonb;
  resource_input jsonb;
  v_contract public.delegation_contracts%rowtype;
begin
  select human.email, human.display_name, human.department
  into v_email, v_display_name, v_department
  from public._trust_pass_human(p_grantee_human_id) as human;
  if not found then
    raise exception 'Grantee human profile not found';
  end if;

  select * into v_contract
  from public.delegation_contracts
  where id = p_contract_id
  for update;
  v_now := pg_catalog.clock_timestamp();

  if not found then
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_grantee_human_id,
      v_email,
      v_department,
      null,
      null,
      'agent.invoke',
      'delegation',
      p_contract_id::text,
      'Approved delegated task',
      'deny',
      'DELEGATION_GRANTEE_MISMATCH',
      'The approved delegated task was not found for this human.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'DELEGATION_GRANTEE_MISMATCH'
    );
  end if;

  if v_contract.grantee_human_id <> p_grantee_human_id then
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_grantee_human_id,
      v_email,
      v_department,
      null,
      null,
      'agent.invoke',
      'delegation',
      p_contract_id::text,
      'Approved delegated task',
      'deny',
      'DELEGATION_GRANTEE_MISMATCH',
      'This Trust Pass belongs to another authenticated human.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'DELEGATION_GRANTEE_MISMATCH'
    );
  end if;

  if v_contract.status = 'active' and v_contract.expires_at <= v_now then
    update public.delegation_contracts
    set status = 'expired'
    where id = v_contract.id
      and status = 'active'
      and expires_at <= pg_catalog.clock_timestamp()
    returning * into v_contract;
  end if;

  if p_submitted_prompt is not null
    and pg_catalog.char_length(p_submitted_prompt) between 1 and 50000
  then
    v_submitted_prompt_digest := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(p_submitted_prompt, 'UTF8'),
        'sha256'
      ),
      'hex'
    );
  end if;

  if v_contract.status <> 'active' then
    v_reason_code := case v_contract.status
      when 'consumed' then 'DELEGATION_CONSUMED'
      when 'revoked' then 'DELEGATION_REVOKED'
      else 'DELEGATION_EXPIRED'
    end;
    v_reason := case v_contract.status
      when 'consumed' then 'This one-use Trust Pass has already admitted its approved Run.'
      when 'revoked' then 'The Agent owner revoked this Trust Pass before use.'
      else 'This Trust Pass expired before the approved Run started.'
    end;
  elsif v_submitted_prompt_digest is null
    or v_contract.exact_prompt_digest is distinct from v_submitted_prompt_digest
  then
    v_reason_code := 'DELEGATION_PROMPT_MISMATCH';
    v_reason := 'The submitted prompt bytes do not match the exact owner-approved task.';
  elsif v_contract.allowed_actions <> array['agent.invoke']::text[] then
    v_reason_code := 'DELEGATION_ACTION_NOT_ALLOWED';
    v_reason := 'The Trust Pass does not authorize Agent invocation.';
  else
    v_locked_resource_inputs := public._trust_pass_lock_owned_resource_inputs(
      v_contract.approving_human_id,
      v_contract.approved_resource_ids
    );
    v_current_resource_digests := v_locked_resource_inputs -> 'digests';
    if v_locked_resource_inputs is null
      or v_current_resource_digests is null
      or v_current_resource_digests <> v_contract.approved_resource_digests
    then
      v_reason_code := 'DELEGATION_RESOURCE_CHANGED';
      v_reason := 'An owner-approved input changed after approval, so execution failed closed.';
    end if;
  end if;

  if v_reason_code is not null then
    v_now := pg_catalog.clock_timestamp();
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_grantee_human_id,
      v_email,
      v_department,
      v_contract.agent_id,
      v_contract.agent_name,
      'agent.invoke',
      'delegation',
      v_contract.id::text,
      'Approved delegated task',
      'deny',
      v_reason_code,
      v_reason,
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', v_reason_code,
      'contractStatus', v_contract.status
    );
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.delegation_contracts
  set
    status = 'consumed',
    uses_consumed = 1,
    run_id = p_run_id,
    consumed_at = v_now
  where id = v_contract.id
    and status = 'active'
    and uses_consumed = 0
    and run_id is null
    and expires_at > pg_catalog.clock_timestamp()
  returning * into v_contract;

  if not found then
    v_now := pg_catalog.clock_timestamp();
    update public.delegation_contracts
    set status = 'expired'
    where id = p_contract_id
      and status = 'active'
      and expires_at <= pg_catalog.clock_timestamp()
    returning * into v_contract;
    if not found then
      raise exception 'Trust Pass state changed before atomic consumption';
    end if;
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_grantee_human_id,
      v_email,
      v_department,
      v_contract.agent_id,
      v_contract.agent_name,
      'agent.invoke',
      'delegation',
      v_contract.id::text,
      'Approved delegated task',
      'deny',
      'DELEGATION_EXPIRED',
      'This Trust Pass expired before the approved Run was atomically admitted.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'DELEGATION_EXPIRED',
      'contractStatus', v_contract.status
    );
  end if;

  for resource_input in
    select inputs.value
    from pg_catalog.jsonb_array_elements(
      v_locked_resource_inputs -> 'inputs'
    ) as inputs(value)
  loop
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_grantee_human_id,
      v_email,
      v_department,
      v_contract.agent_id,
      v_contract.agent_name,
      'resource.read',
      'resource',
      resource_input ->> 'resourceId',
      'Approved delegated input',
      'allow',
      'DELEGATION_ACTIVE',
      'The Agent owner approved these exact immutable bytes for the one-use Run.',
      v_now
    );
  end loop;

  perform public._trust_pass_record_decision(
    p_audit_request_id,
    p_grantee_human_id,
    v_email,
    v_department,
    v_contract.agent_id,
    v_contract.agent_name,
    'agent.invoke',
    'delegation',
    v_contract.id::text,
    'One-use Agent Trust Pass',
    'allow',
    'DELEGATION_ACTIVE',
    'The grantee, exact task, action, approved resources, expiry, and remaining use matched.',
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'reasonCode', 'DELEGATION_ACTIVE',
    'contract', pg_catalog.to_jsonb(v_contract),
    'approvedInputs', v_locked_resource_inputs -> 'inputs'
  );
end
$function$;

revoke all on function public.consume_delegation_contract(uuid, uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.consume_delegation_contract(uuid, uuid, text, uuid, text)
  to service_role;

create or replace function public.revoke_delegation_contract(
  p_contract_id uuid,
  p_approving_human_id uuid,
  p_audit_request_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_email text;
  v_display_name text;
  v_department text;
  v_reason_code text;
  v_contract public.delegation_contracts%rowtype;
begin
  select human.email, human.display_name, human.department
  into v_email, v_display_name, v_department
  from public._trust_pass_human(p_approving_human_id) as human;
  if not found then
    raise exception 'Approving human profile not found';
  end if;

  select * into v_contract
  from public.delegation_contracts
  where id = p_contract_id
  for update;
  v_now := pg_catalog.clock_timestamp();

  if not found or v_contract.approving_human_id <> p_approving_human_id then
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      null,
      null,
      'delegation.revoke',
      'delegation',
      p_contract_id::text,
      'One-use Agent Trust Pass',
      'deny',
      'HUMAN_AGENT_OWNER_MISMATCH',
      'Only the approving Agent owner can revoke this Trust Pass.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'HUMAN_AGENT_OWNER_MISMATCH'
    );
  end if;

  if v_contract.status = 'active' and v_contract.expires_at <= v_now then
    update public.delegation_contracts
    set status = 'expired'
    where id = v_contract.id
      and status = 'active'
      and expires_at <= pg_catalog.clock_timestamp()
    returning * into v_contract;
  end if;

  if v_contract.status <> 'active' then
    v_reason_code := case v_contract.status
      when 'consumed' then 'DELEGATION_CONSUMED'
      when 'revoked' then 'DELEGATION_REVOKED'
      else 'DELEGATION_EXPIRED'
    end;
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      v_contract.agent_id,
      v_contract.agent_name,
      'delegation.revoke',
      'delegation',
      v_contract.id::text,
      'One-use Agent Trust Pass',
      'deny',
      v_reason_code,
      'Only an active Trust Pass can be revoked.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', v_reason_code,
      'contractStatus', v_contract.status
    );
  end if;

  v_now := pg_catalog.clock_timestamp();
  update public.delegation_contracts
  set status = 'revoked', revoked_at = v_now
  where id = v_contract.id
    and status = 'active'
    and expires_at > pg_catalog.clock_timestamp()
  returning * into v_contract;

  if not found then
    v_now := pg_catalog.clock_timestamp();
    update public.delegation_contracts
    set status = 'expired'
    where id = p_contract_id
      and status = 'active'
      and expires_at <= pg_catalog.clock_timestamp()
    returning * into v_contract;
    if not found then
      raise exception 'Trust Pass state changed before atomic revocation';
    end if;
    perform public._trust_pass_record_decision(
      p_audit_request_id,
      p_approving_human_id,
      v_email,
      v_department,
      v_contract.agent_id,
      v_contract.agent_name,
      'delegation.revoke',
      'delegation',
      v_contract.id::text,
      'One-use Agent Trust Pass',
      'deny',
      'DELEGATION_EXPIRED',
      'The Trust Pass expired before revocation was atomically committed.',
      v_now
    );
    return pg_catalog.jsonb_build_object(
      'allowed', false,
      'reasonCode', 'DELEGATION_EXPIRED',
      'contractStatus', v_contract.status
    );
  end if;

  perform public._trust_pass_record_decision(
    p_audit_request_id,
    p_approving_human_id,
    v_email,
    v_department,
    v_contract.agent_id,
    v_contract.agent_name,
    'delegation.revoke',
    'delegation',
    v_contract.id::text,
    'One-use Agent Trust Pass',
    'allow',
    'DELEGATION_REVOKED',
    'The Agent owner revoked the Trust Pass before use.',
    v_now
  );

  return pg_catalog.jsonb_build_object(
    'allowed', true,
    'reasonCode', 'DELEGATION_REVOKED',
    'contract', pg_catalog.to_jsonb(v_contract)
  );
end
$function$;

revoke all on function public.revoke_delegation_contract(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_delegation_contract(uuid, uuid, text)
  to service_role;

comment on function public.create_delegation_request(
  uuid, text, text, timestamptz, text
) is 'Service-only request creation with audit evidence in the same transaction.';
comment on function public.approve_delegation_request(
  uuid, uuid, uuid, text, uuid[], timestamptz, text
) is 'Locks a pending request, issues one immutable Trust Pass, and records approval atomically.';
comment on function public.create_delegation_contract(
  uuid, uuid, text, uuid, text, text, uuid[], timestamptz, text
) is 'Owner-initiated Trust Pass issuance using the same immutable contract representation.';
comment on function public.reject_delegation_request(uuid, uuid, text)
  is 'Locks and rejects one pending capability request while recording the decision atomically.';
comment on function public.consume_delegation_contract(uuid, uuid, text, uuid, text)
  is 'Hashes the exact raw prompt, locks immutable inputs, and consumes at most one valid pass use.';
comment on function public.revoke_delegation_contract(uuid, uuid, text)
  is 'Locks and revokes an active pass while recording ALLOW or DENY evidence.';

commit;
