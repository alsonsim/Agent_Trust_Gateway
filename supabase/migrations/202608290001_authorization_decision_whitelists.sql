-- Keep persisted authorization evidence aligned with every middleware decision.
-- This migration must run after public.authorization_decisions is created and
-- before the Trust Pass migration adds delegation RPCs.

alter table public.authorization_decisions
  drop constraint if exists authorization_decisions_action_check,
  drop constraint if exists authorization_decisions_target_type_check,
  drop constraint if exists authorization_decisions_reason_code_check;

alter table public.authorization_decisions
  add constraint authorization_decisions_action_check check (
    action::text in (
      'agent.create',
      'agent.read',
      'agent.update',
      'agent.delete',
      'agent.revoke',
      'agent.start',
      'agent.stop',
      'agent.invoke',
      'run.read',
      'resource.read',
      'file.read',
      'file.write',
      'shell.execute',
      'network.request',
      'delegation.request',
      'delegation.approve',
      'delegation.reject',
      'delegation.revoke',
      'access-request.create',
      'access-request.approve',
      'access-request.deny',
      'access-grant.revoke'
    )
  ),
  add constraint authorization_decisions_target_type_check check (
    target_type::text in (
      'agent',
      'run',
      'resource',
      'file',
      'command',
      'network',
      'delegation',
      'capability',
      'access-request',
      'access-grant'
    )
  ),
  add constraint authorization_decisions_reason_code_check check (
    reason_code::text in (
      'OWNER_MATCH',
      'HUMAN_AGENT_OWNER_MISMATCH',
      'HUMAN_AGENT_DEPARTMENT_MISMATCH',
      'AGENT_REVOKED',
      'AGENT_RESOURCE_OWNER_MISMATCH',
      'DEPARTMENT_MATCH',
      'CROSS_DEPARTMENT_GRANT_REQUIRED',
      'CROSS_DEPARTMENT_GRANT_ACTIVE',
      'ACCESS_REQUEST_PENDING',
      'ACCESS_REQUEST_APPROVED',
      'ACCESS_REQUEST_DENIED',
      'ACCESS_GRANT_REVOKED',
      'WORKSPACE_PATH_ALLOWED',
      'PATH_OUTSIDE_WORKSPACE',
      'PROTECTED_SECRET_FILE',
      'FILE_TOO_LARGE',
      'RUNTIME_COMMAND_ALLOWED',
      'RUNTIME_COMMAND_DENIED',
      'RUNTIME_NETWORK_DENIED',
      'DELEGATION_REQUESTED',
      'DELEGATION_APPROVED',
      'DELEGATION_REJECTED',
      'DELEGATION_ACTIVE',
      'DELEGATION_CONSUMED',
      'DELEGATION_REVOKED',
      'DELEGATION_EXPIRED',
      'DELEGATION_PROMPT_MISMATCH',
      'DELEGATION_GRANTEE_MISMATCH',
      'DELEGATION_ACTION_NOT_ALLOWED',
      'DELEGATION_RESOURCE_CHANGED'
    )
  );
