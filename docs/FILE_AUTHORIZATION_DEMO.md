# Agent-to-File Authorization Demo

## What changed

The control plane now provides a server-enforced workspace-file read path:

```text
POST /api/agents/:id/files/read
{ "path": "README.md" }
```

The route authenticates the human user, confirms that user owns the Agent,
evaluates the requested path against the Agent's workspace policy, persists an
authorization decision, and returns content only for an `allow` decision.

Each decision uses action `file.read`, target type `file`, and one of these
policy reason codes:

- `WORKSPACE_PATH_ALLOWED`
- `PATH_OUTSIDE_WORKSPACE`
- `PROTECTED_SECRET_FILE`
- `FILE_TOO_LARGE`

Owner mismatches remain attributable as `HUMAN_AGENT_OWNER_MISMATCH`.

## Policy rules

The workspace policy resolves the Agent workspace and requested target through
canonical filesystem paths before authorizing a read. It allows ordinary files
that stay inside the assigned workspace and are no larger than 256 KiB.

It denies:

- Paths outside the workspace, including `..` traversal.
- Symlinks that resolve outside the workspace.
- Symlinks that resolve to protected files.
- `.env`, `.env.*`, `.npmrc`, `.pypirc`, `credentials.json`, `id_rsa`,
  `id_ed25519`, `id_dsa`, `.aws`, `.kube`, `.ssh`, `secrets`, `*.pem`, and
  `*.key` paths.
- Files larger than 256 KiB.

Errors and audit records contain a normalized target label and decision reason;
they never include file contents.

## Three-minute demo

1. Start the app in demo mode, sign in, create an Agent, and open **Access &
   audit**.
2. Start with the selected-Agent summary: owner, Runtime state, Trust Gateway
   state, actual allowed/denied totals, and the latest persisted decision are
   visible before any interaction.
3. In **Four-step security demo**, run **Safe file read**. `README.md` is
   allowed, returned only by the server, and shown in the authorization result.
4. Run **Protected secret** and **Path traversal**. `.env` returns
   `PROTECTED_SECRET_FILE`; `../launchpad.json` returns
   `PATH_OUTSIDE_WORKSPACE`. Both cards report that no Run was created.
5. Run **Dangerous shell command**. The Runtime Action Firewall returns
   `RUNTIME_COMMAND_DENIED` for `rm -rf` before Codex starts, and the result
   confirms that no Run was created.
6. Use the prominent latest-decision inspector to show action, target, policy
   code, explanation, Run creation state, and expandable request metadata.
   Then filter the newest-first timeline by denied, file, shell, or network
   events. Consecutive repeated decisions are grouped without discarding their
   audit evidence.

## Security console presentation

The Access & audit screen is deliberately a demo console, not a mock dashboard.
Each scenario invokes the same Fastify file-read or Playground message endpoint
used by the application. Actual results are rendered only after the backend
returns an authorization decision or error. The UI never hard-codes an allow or
deny outcome, file contents, a policy reason, or whether a Run was created.

## Adversarial coverage

`apps/server/src/workspace-file-policy.test.ts` verifies safe reads, `.env`,
traversal, a symlink to `.env`, a symlink outside the workspace, and oversized
files. `apps/server/src/app.test.ts` verifies the authenticated HTTP route,
secret non-disclosure, traversal denial, and persisted decisions.

## Security boundary

The file authorization middleware protects the explicit Fastify endpoint above.
It is enforced by the backend, not by the browser UI, and an allowed decision is
persisted before the backend releases file content. If an allow decision cannot
be persisted, access fails closed.

## Runtime Action Firewall

The next Track 1 increment adds a pre-dispatch Runtime Action Firewall to the
Playground path. Before a Run is created, explicit file reads and writes named
in the user turn are checked with the workspace policy, dangerous shell commands
are denied, and direct network clients (`curl`, `wget`, and `ssh`) are denied.
Every decision is persisted before the runner is called, so a denied action does
not create a Run or start Codex.

The generated Codex execpolicy rules provide a separate pre-execution boundary
for model-generated shell commands. They allow `npm test`, `npm run test`,
`npm run build`, `git status`, and `git diff`; they block `rm -rf`, `sudo`,
`chmod 777`, `curl`, `wget`, `ssh`, `docker run`, and `git push`.

This does not yet provide universal tool interception. The pinned Codex CLI
does not expose a stable general pre-tool callback for every later file or
network operation. Those later operations remain constrained by Codex sandboxing
and, in container mode, the mount/capability boundary. A future Runtime adapter
must use a CLI tool hook or an agent protocol with externally hosted file, shell,
and network tools to make all actions mandatory through this policy path.

## Agent revocation demo

The Agent header includes a **Revoke** control with confirmation. As the owner,
send an allowed Playground request, revoke the Agent, then attempt another
Playground request or `file.read`. The Agent remains visibly stopped and marked
**Revoked**; both future requests are denied with `AGENT_REVOKED`, no new runner
is started, and the audit timeline records the allowed `agent.revoke` decision
and denied attempted action. Stop/start is still available for Agents that have
not been revoked. A different signed-in user receives
`HUMAN_AGENT_OWNER_MISMATCH` when attempting the revoke endpoint.
