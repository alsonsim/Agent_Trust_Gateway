# Security policy

Agent Trust Gateway is a hackathon proof of concept. Only the latest revision
on the default branch is supported.

## Report a vulnerability

Send the repository owner or event organizer the affected revision,
reproduction steps, impact, and suggested mitigation. Do not publish
credentials, personal data, or exploit details in an issue.

## Known limitations

- Passwordless demo identities are loopback-only fixtures, not production auth
- Supabase sessions are not automatically refreshed in this hackathon POC
- SameSite=Strict cookies reduce CSRF exposure, but there is no separate CSRF token
- Local Trust Pass state and transition locks remain a single-process JSON store
- When `AUTH_MODE=supabase`, Trust Pass state remains local while audit evidence
  uses Supabase, so the two systems do not form one crash-atomic transaction
- No per-Agent container boundary in ECS mode
- Ordinary local containers, not hardened multi-tenant sandboxes
- The Runtime must reach the configured model endpoint; there is no dedicated
  model-egress proxy or destination allowlist
- Prompt-triggered command and file execution
- The Ark key is available to the server and Runtime parent process. Delegated
  shell subprocesses receive a filtered environment and request disabled
  workspace-write network access from the inner sandbox, but a short-lived
  proxy credential is still the recommended production boundary
- Ark key stored in Terraform POC state

## Safe use

- Use a dedicated development machine or disposable ECS instance.
- Use Supabase mode, HTTPS, `AUTH_COOKIE_SECURE=true`, and scoped provider keys
  for any network-accessible demo. Keep the Supabase secret key server-side.
- Use `APP_AUTH_TOKEN` only for the explicitly selected legacy compatibility mode.
- Keep local use on loopback and restrict ECS Web and SSH CIDRs.
- Add HTTPS before sending the shared token over an untrusted network.
- Never mount production data or provide Volcengine account AK/SK to Agents.
- Stop the POC, destroy test resources, and revoke keys after the event.

Codex uses `workspace-write` when Landlock is available. On unsupported kernels,
startup warns and relies on the outer Docker or rootless Podman boundary. This
fallback is not tenant isolation.

Delegated Runs additionally use a fresh allowlisted runtime home, an isolated
workspace containing only approved inputs, no resumable owner thread, disabled
workspace-write network access for spawned commands when the inner sandbox is
available, final-output-only result delivery, transformed-secret output
filtering, and verified container removal before cleanup. These controls reduce
exposure; they do not turn the POC into a hardened hostile multi-tenant service.

For the local repository, Trust Pass lifecycle changes and ALLOW evidence share
one durable JSON write. On startup, the container Runtime enumerates and verifies
removal of stale labeled containers before strictly sweeping leftover delegated
workspaces and runtime homes. If container absence or a managed path cannot be
verified, startup or cleanup fails closed and preserves the mounted data for
operator recovery.
