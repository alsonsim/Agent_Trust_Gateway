# Local POC

The local profile runs the React/Fastify control plane on Windows, macOS, or
Linux and starts every Codex turn in a disposable Docker, Colima, or Podman
container. Only the Volcengine Ark model API is remote.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- An Ark API key and Responses-capable endpoint
- Git for Windows when starting from Windows PowerShell or Git Bash

Copy `.env.example` to `.env`, then set `AUTH_MODE=demo`, `HOST=127.0.0.1`,
`ARK_API_KEY`, and `ARK_MODEL`. For a real model Run, also set:

```dotenv
LOCAL_INSECURE_RUNTIME_KEY_PASSTHROUGH=true
LOCAL_INSECURE_RUNTIME_NETWORK=true
```

```bash
npm run poc
```

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman` in `.env`. Colima uses the Docker CLI.

On Windows, the Node launcher deliberately selects Git for Windows Bash rather
than an unrelated WSL installation. Set `LOCAL_POC_BASH` to the full path of
`bash.exe` only for a nonstandard Git installation. WSL works when Node.js 22
and Docker integration are installed inside that distribution.

## Data and Runtime

Persistent state defaults to:

```text
.local/data/          JSON control-plane state
.local/workspaces/    Frontend, Backend, and QA workspaces
.local/codex-home/    Generated Codex configuration
```

The script reads root `.env` as dotenv data without executing it. Exported
caller values take precedence, while the host control plane always uses
`<repository>/.local/` for metadata, workspaces, and Codex state.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

The Runtime has no network and receives no Ark key by default. If a disposable
local demo must call ModelArk directly, explicitly accept both reduced
boundaries:

Set both values in `.env`, then run `npm run poc`.

These flags are rejected in production. Prefer a trusted model proxy with
short-lived credentials for a deployed system.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Set `CONTAINER_ENGINE=podman` in
`.env`, then run `npm run poc`.

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

Set the following in `.env`, then run `npm run poc`:

```dotenv
CONTAINER_RUNTIME_APT_PACKAGES=ca-certificates git ripgrep python3 build-essential
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3000/api/system
```

If a bind mount is rejected, configure the container VM to share the repository
directory. On Linux, the startup script automatically uses the host UID/GID and
validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
