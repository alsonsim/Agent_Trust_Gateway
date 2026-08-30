# Supabase Trust Pass persistence

## Wiring status

`supabase/migrations/20260829_trust_pass.sql` defines the durable PostgreSQL
contract for Trust Pass requests and one-use delegation contracts. It is checked
in for deployment and adapter work, but it is **not currently wired into the
Node.js runtime**.

The current `DelegationService` still stores its request and contract state in
the local `JsonStore`, including when Supabase supplies authentication and
protected resources. Applying this migration alone does not move that state to
Supabase, and the Node.js runtime does not call these RPCs yet. This distinction
is intentional: using ordinary REST inserts and updates would weaken the local
service's atomic one-use guarantee. A future adapter must use the RPCs below as
its only mutation boundary and must address the durable dispatch requirement
described below before this becomes the runtime source of truth.

## Prerequisites

Apply the migration after the existing Supabase objects used by the application
are present:

- `auth.users`
- `public.profiles(id, display_name, department)`
- `public.protected_resources(id, owner_id, content, ...)`
- `public.authorization_decisions` with the columns written by
  `SupabaseSecurityRepository.appendDecision()`

The audit table must accept the delegation actions, target types, and reason
codes used by the migration. The migration fails early if a prerequisite table
is absent.

## Security boundary

Both delegation tables have row-level security enabled and forced. The
migration explicitly removes Supabase's possible default grants from `anon`,
`authenticated`, and `service_role`. Browser roles receive no table policy or
privilege and cannot execute any Trust Pass function. `service_role` is then
given table `SELECT` only and execution on the public mutation RPCs. It cannot
execute internal helpers. Inserts and state transitions therefore go through a
`SECURITY DEFINER` function with a fixed empty `search_path`.

Scope fields are protected twice:

1. table constraints fix the capability mapping, exact action
   (`agent.invoke`), output visibility (`final_output_only`), one-use limit,
   canonical resource set, SHA-256 formats, expiry bounds, and valid state;
2. triggers prevent scope changes and permit only monotonic lifecycle
   transitions.

The functions derive human snapshots from `auth.users` and `profiles`. The
sanitized request summary, personal-information assessment, and SHA-256 task
digest are generated from the submitted prompt inside PostgreSQL; none is
accepted from the requester as derived metadata. The raw requester prompt is
used only while creating that record and is not retained in
`delegation_requests`. Resource content digests are calculated inside PostgreSQL
from owner-matched rows, so a caller cannot supply a forged resource digest.

For requester-initiated approval, the exact executable task is the redacted,
server-generated summary shown to the owner. Approval neither stores nor
authorizes a hidden suffix from the requester's submitted prompt. The owner
therefore reviews every byte that the pass later authorizes; changing those
bytes produces a prompt digest mismatch.

## RPC contract

The service-role-only entry points are:

| Function | Purpose |
| --- | --- |
| `create_delegation_request` | Persist a requester-approved capability request and its audit row. |
| `approve_delegation_request` | Lock one pending request, create its contract, resolve the request, and audit approval. |
| `reject_delegation_request` | Lock and resolve one pending request as rejected with audit evidence. |
| `create_delegation_contract` | Issue the same contract shape through the owner-initiated path and audit approval. |
| `consume_delegation_contract` | Lock, re-check, and consume at most one use while inserting ALLOW or DENY evidence. |
| `revoke_delegation_contract` | Lock and revoke an active contract while inserting ALLOW or DENY evidence. |

Every successfully completed RPC returns JSON with an `allowed` boolean and
`reasonCode`. Lifecycle denials handled by request review, consumption, and
revocation return normally so their DENY audit insert commits. The adapter must
inspect `allowed`; an HTTP 200 response from PostgREST is not by itself an
authorization grant.

Invalid request or issuance parameters, including an unsupported capability,
invalid participant relationship, or resource not owned by the approver, raise
an exception and roll back the transaction. The adapter must validate and audit
those denials before calling an issuance RPC. A race-time database rejection
still fails closed and must be treated as an unsuccessful authorization, never
as permission to fall back to a direct table write. Unexpected database errors
also abort the transaction, including every lifecycle change and audit insert
made by that RPC.

`consume_delegation_contract` takes a server-generated Run ID and the raw
submitted prompt. PostgreSQL rejects a null or empty prompt and hashes its exact
UTF-8 bytes itself. Do not trim, normalize line endings, change case, or apply
Unicode normalization before calling the RPC. It also locks and re-hashes all
approved resource rows under the approving owner. A changed prompt, resource,
grantee, status, action, expiry, or remaining-use count returns a DENY result
without admitting a Run.

An allowed consume response includes `approvedInputs`, an ordered array of the
exact UTF-8 bytes (base64 encoded) and SHA-256 digests that were checked while
the resource rows were locked. The adapter must decode and pass those returned
bytes to the isolated Run. It must not fetch the resources again after
authorization, because doing so would reintroduce a time-of-check/time-of-use
gap. Resource-read ALLOW decisions and the invocation ALLOW decision are
inserted in the same transaction as one-use consumption. `approvedInputs` is an
internal service response and must never be returned to the grantee as resource
access.

The consume and revoke functions take a row lock. If consumption and revocation
race, one transition wins and the other caller observes the final state and gets
a DENY decision. Two concurrent consumes cannot both return `allowed: true`.

## Required adapter checks

All actor identifiers are trusted RPC parameters, not proof of identity. The
adapter must derive `p_requester_human_id`, every acting
`p_approving_human_id`, and the consuming `p_grantee_human_id` from the verified
authenticated session. It must never copy those actor values from request JSON.
An owner-selected grantee must resolve to an authenticated human before direct
issuance. The capability broker may prepare a request, but it must never call an
approval or issuance RPC on its own authority.

Agent records and runtime Runs remain in the application store. PostgreSQL
therefore cannot independently verify Agent ownership, revocation, readiness,
or whether the selected Agent supports the named capability. Before calling an
issuance RPC, the future adapter must verify that the authenticated approver owns
the selected, non-revoked Agent. Before consumption, it must preflight the Agent
and runtime policy. After an allowed RPC response it must dispatch only the Run
ID, exact raw prompt, and `approvedInputs` returned by that response.

Database consumption and a Run created in the current local `JsonStore` cannot
form one transaction. A process crash after an allowed consume could otherwise
leave a consumed pass with no Run, while creating the Run first could leave an
unauthorized queued Run after a database denial. The production adapter must add
a durable database outbox or equivalent pending-admission record in the same
transaction as consumption, then idempotently create and launch the Run from
that record with reconciliation after crashes. Until that dispatch mechanism is
wired and tested, this migration is a persistence contract rather than a claim
of end-to-end Supabase atomicity.

Raw request and contract rows, table query results, and RPC results are server
records, not API response objects. Request records contain only the sanitized
summary and SHA-256 digest of the submitted task, never the raw requester
prompt. Contracts and consume results still contain the approved prompt, Agent
identity, grantee snapshot, resource IDs, and possibly approved input bytes. The
adapter must never pass these records through to a browser. It must use
participant-specific response objects so a grantee never receives the
underlying Agent, workspace, settings, thread, history, resource contents, or
other Runs, and an approver receives only the sanitized request summary. The
same rule applies to audit views: internal Agent and resource identifiers must
be redacted for principals who do not own them.

## Verification

After applying the migration to a Supabase development database, run:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f supabase/tests/20260829_trust_pass_shape.sql
```

The shape check verifies that request rows have no raw prompt column and require
the sanitized summary and digest. It also verifies forced RLS, browser-role
denial, SELECT-only service table access, top-level RPC grants, internal-helper
denial, exact empty search paths, immutable-scope triggers, and expected
indexes. Behavioral concurrency and crash-recovery tests must be added with the
runtime adapter; the checked-in SQL intentionally does not pretend that an
unwired adapter has been integration-tested.
