# Three-minute Trust Pass demo

## Story

This demo stays entirely inside **Bouncer — Identity and Authorization**.

> The Trust Gateway lets Agents privately discover missing capabilities and
> request a narrowly scoped, owner-approved Agent Pass—without exposing or
> sharing the underlying Agent.

Finance owns a Finance Agent and an aggregate quarterly-budget resource. HR
needs a cost analysis but cannot normally invoke Finance's Agent or read the
resource. A consent-based Trust Pass authorizes exactly one approved Run and
nothing else.

Start the local POC with a container engine and a model key:

```bash
AUTH_MODE=demo ARK_API_KEY=your-key ARK_MODEL=your-model npm run poc
```

## 0:00 — Establish the owner boundary

1. Sign in as **Finance**.
2. Create a Finance Agent; newly created Agents are ready immediately.
3. Open **Access & audit** and show Finance's aggregate budget resource.
4. Sign in as **HR**, create an HR Agent, and open **Access & audit**.
5. Run the **Cross-owner resource** scenario. The server privately selects a
   foreign fixture and returns `DENY — AGENT_RESOURCE_OWNER_MISMATCH` without
   exposing its ID, name, or contents.

State the boundary: the human and Agent are separate principals, and an Agent
acts only for its authenticated owner unless middleware admits a valid pass.

## 0:35 — Discover and request a capability

1. As HR, open **Trust passes** and enter:

   ```text
   Analyze the approved quarterly launch budget and contingency, then summarize the available budget capacity.
   ```

2. Select **Check required capability**.
3. The broker recommends a privately managed Finance cost-analysis capability.
4. Select **Request permission**.

Point out that HR sees no Finance Agent name, settings, workspace, history, or
resource identity. The broker can recommend and forward the request, but it
cannot approve it or issue a pass.

## 1:05 — Owner review and approval

1. Sign in as Finance and open the **Approval inbox**.
2. Show the requester, exact redacted executable task, personal-information
   assessment, requested single use, and expiry.
3. Explicitly select the ready Finance Agent and aggregate budget resource.
4. Approve the request.

The backend verifies that Finance owns the selected Agent and resources, then
issues the same `DelegationContract` used by owner-initiated delegation. The
contract binds HR, that Agent, the exact reviewed task digest, locked resource
digests, `agent.invoke`, final output only, one use, and the expiry.

## 1:45 — Run the approved task

1. Sign back in as HR and open **Approved tasks**.
2. Show the locked prompt, countdown, one approved input, one remaining use,
   and final-output-only visibility.
3. Run the task.
4. Show the permitted final result and the `ALLOW — DELEGATION_ACTIVE` audit
   evidence.

The serialized middleware attempt verifies the locked resource bytes, prepares
a fresh isolated workspace containing only those bytes, and then commits pass
consumption, the one Run, and ALLOW evidence in one local-store write. HR never
receives direct resource access or an owner Agent session.

## 2:30 — Prove replay denial and recovery

1. Try the same pass again and show
   `DENY — DELEGATION_CONSUMED`.
2. Create another pass, revoke it as Finance before use, and show
   `DENY — DELEGATION_REVOKED` by opening **Demo denial checks** and selecting
   **Try revoked pass** as HR.
3. Run the Finance Agent normally as Finance to show that revoking a pass does
   not disable the Agent.

Optionally open **Demo denial checks** on an unused pass, select **Try altered
prompt**, and show `DENY — DELEGATION_PROMPT_MISMATCH`.

## Middleware guarantees to call out

- Identity comes from the authenticated session, never request JSON.
- The broker cannot approve or issue a pass.
- Requester- and owner-initiated paths share one authorization contract.
- Exact task, Agent ownership, capability, action, resource digests, grantee,
  status, expiry, and remaining uses are checked server-side.
- One-use admission and ALLOW evidence are atomic within the single-process
  local store.
- Revocation and invocation race through the same transition lock.
- Audit evidence records the human, Agent, action, resource, result, and reason
  while participant views hide foreign identifiers.
- The grantee receives only the approved Run and permitted final result.

## Automated evidence

Run:

```bash
npm run check
```

The tests cover cross-user denial, private discovery, owner-only approval,
prompt and resource binding, expiry, revocation, one-use concurrency, atomic
audit failure handling, runtime firewall checks, isolated input loading,
final-output filtering, verified container removal, crash-residue recovery, and
cleanup.

The local demo stores contracts in JSON and supports one server process. The
checked-in Supabase migration defines forced-RLS tables and service-only atomic
RPCs, but the runtime adapter and durable Run outbox are intentionally not
claimed as complete. See [Supabase Trust Pass persistence](SUPABASE_TRUST_PASS.md).
