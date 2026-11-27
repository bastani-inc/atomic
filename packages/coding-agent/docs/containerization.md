---
title: "Run Atomic in containers"
sidebarTitle: "Run in Containers"
description: "Isolate Atomic or its built-in tools using Gondolin micro-VMs, Docker containers, or NVIDIA OpenShell sandboxes."
---

Atomic runs with all of your local user permissions by default. To restrict which directories and processes it can reach, choose one of two isolation models:

1. Run the whole `atomic` process inside a container or managed sandbox.
2. Run `atomic` on your host and route built-in file and shell tools into a micro-VM.

Containerization is the outer boundary, not the only one. Read [Manage security and project trust](/security) alongside this page to see how project trust gates project extensions, skills, and settings before work starts.

## Choose an isolation pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin micro-VM | Selected file tools, `bash`, and `!` commands | Local VM tool routing while keeping credentials on the host | `search` and custom host extensions stay on the host. See [`examples/extensions/gondolin/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin). |
| Docker | Whole `atomic` process in a local container | Straightforward local process and filesystem isolation | Provider API keys enter the container. |
| NVIDIA OpenShell | Whole `atomic` process in a policy-controlled sandbox | Local or remote managed sandboxes with upstream credential injection | Requires an OpenShell gateway. |

Extensions run wherever the `atomic` process runs. When you run host `atomic` with a tool-routing extension, other loaded extensions still run on your host unless they also route their work into the VM. To route built-in file tools and `!` commands to a remote machine over SSH instead of a local micro-VM, see `examples/extensions/ssh.ts` in [Extension examples](/extensions/examples#remote-execution-and-sandboxes).

## Gondolin micro-VM

[Gondolin](https://github.com/earendil-works/gondolin) runs a local Linux micro-VM. Use the [Gondolin example extension](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin) when you want `atomic` on your host with selected file tools and shell commands routed into the VM. This does not isolate the entire session.

**Requirements:** npm, Node.js 23.6.0 or newer (required by `@earendil-works/gondolin`), and QEMU installed through your system package manager.

<Steps>
  <Step title="Copy the extension outside your global extensions directory">
    Copy `examples/extensions/gondolin` to a standalone path such as `~/.local/share/atomic-gondolin` for opt-in use with `-e`, then install its dependencies:

    ```bash
    cp -R "$(npm root -g)/@bastani/atomic/examples/extensions/gondolin" ~/.local/share/atomic-gondolin
    cd ~/.local/share/atomic-gondolin
    npm ci --ignore-scripts
    ```
  </Step>
  <Step title="Launch Atomic from your project directory">
    Start Atomic with `-e` from the project directory you want mounted at `/workspace` inside the VM:

    ```bash
    cd /path/to/project
    atomic -e ~/.local/share/atomic-gondolin
    ```
  </Step>
</Steps>

<Warning>
Do **not** copy the extension into `~/.atomic/agent/extensions/gondolin` unless you want **every** `atomic` session on your machine to boot a Gondolin VM automatically. Because that directory contains both `index.ts` and `package.json`, Atomic auto-loads it globally even without `-e`.
</Warning>

### What the Gondolin extension routes and omits

- **Workspace mount:** Mounts your current host working directory at `/workspace` inside the VM. Edits under `/workspace` write through to your host files.
- **Routed tools and status:** Overrides `read`, `write`, `edit`, `bash`, `find`, and `ls`, plus interactive `!` commands. Registers the `/gondolin` command (shows VM ID, host workspace, guest workspace, and guest shell) and a footer status item (`Gondolin: <id> (/workspace)`).
- **Environment isolation:** Does not forward host shell environment variables into VM commands, keeping host API keys out of the VM.
- **Guest shell and tool caveats:** Probes `bash` first inside the guest and falls back to `/bin/sh`. Routed `find` skips `.git` and `node_modules` only and does not apply `.gitignore`. Routed `read` detects images by filename extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), and routed `write` writes UTF-8 text.
- **Unrouted tools:** `search` stays on the host and is not routed into the VM. Run searches inside the guest through `bash` or `!`.

To expose only the routed built-in tools and prevent host MCP connections in a session:

```bash
atomic --no-mcp --tools read,write,edit,bash,find,ls -e ~/.local/share/atomic-gondolin
```

`ls` is a built-in tool that is off by default unless listed. Adding `--no-mcp` disables host MCP server connections; without `--no-mcp`, a `--tools` allowlist that omits `mcp__*` still connects host MCP servers and keeps their tools registered (and callable if you also enable `codemode` or `tool_search`). Restricting [`--tools`](/reference/cli#tool-options) disables `intercom`, `subagent`, and other extension tools, though other loaded host extensions can still run code on the host — use whole-process isolation when host filesystem access must be prevented completely.

## Docker

Run the whole `atomic` process inside Docker for a clean local container boundary.

Create `Dockerfile.atomic` using Node.js and npm:

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates git ripgrep \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts @bastani/atomic

WORKDIR /workspace
ENTRYPOINT ["atomic"]
```

For an image without Node.js or npm, use the release-archive installer instead:

```dockerfile
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep tar \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://raw.githubusercontent.com/bastani-inc/atomic/main/install.sh | sh

ENV PATH="/root/.local/bin:${PATH}"
WORKDIR /workspace
ENTRYPOINT ["atomic"]
```

The archive installer unpacks a self-contained bundle with no JavaScript runtime required. If you adapt this Dockerfile to a minimal base image, keep standard POSIX core utilities plus `curl` (or `wget`), `tar`/`gzip`, `sha256sum` (or `shasum`/`openssl`), and `ldd` on non-Alpine Linux; `debian:bookworm-slim` already includes them.

For Alpine Linux (`musl`), `install.sh` detects `/etc/alpine-release` and downloads the musl release archive (`atomic-linux-x64-musl.tar.gz` or `atomic-linux-arm64-musl.tar.gz`). Those archives bundle `libgcc` and `libstdc++`, so stock Alpine needs no extra C++ runtime libraries; install `bash`, `ca-certificates`, `curl`, `git`, and `ripgrep` for the installer and built-in tools ([Alpine and musl Linux archives](/getting-started/installation#alpine-and-musl-linux-archives)).

Build and run the container:

```bash
docker build -t atomic-sandbox -f Dockerfile.atomic .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v atomic-home:/root/.atomic \
  atomic-sandbox
```

`-v "$PWD:/workspace"` mounts your current directory at `/workspace`, so edits under `/workspace` write directly to your host files.

### Persisting settings and sessions in Docker

Mount a named volume on `/root/.atomic` (`-v atomic-home:/root/.atomic`) to persist both container-local settings (`/root/.atomic/agent`) and the default SQLite session database (`/root/.atomic/workflows/journal.sqlite`).

<Warning>
Mounting only `/root/.atomic/agent` loses session history when the container exits — even if you set `ATOMIC_CODING_AGENT_DIR=/root/.atomic/agent`. Because that path matches the default agent directory, Atomic still writes `journal.sqlite` outside the volume at `/root/.atomic/workflows/journal.sqlite`.

To persist sessions when mounting only `/root/.atomic/agent`, either mount `/root/.atomic` instead, pass `--session-store /root/.atomic/agent/journal.sqlite` (or set `ATOMIC_STORAGE` / `ATOMIC_SESSIONS_STORAGE`; see [Selecting storage per process](/storage#selecting-storage-per-process)), or set [`ATOMIC_CODING_AGENT_DIR`](/environment-variables) to a non-default subdirectory such as `/root/.atomic/agent/state`.
</Warning>

<Warning>
Do **not** bind-mount your host `~/.atomic` or `~/.atomic/agent` into a running container. Beyond exposing host credentials, settings, and sessions, OS file locks on `settings.json`, `auth.json`, `trust.json`, and session claims do not coordinate safely across a host path and a container mount of the same directory ([Locks in the agent directory](/storage#locks-in-the-agent-directory)). Give each container its own agent directory and share sessions through a remote database instead ([Sharing storage across hosts](/storage#sharing-storage-across-hosts), [SDK storage](/sdk/storage)).
</Warning>

### Container runtime, network, and CI options

| Need | Flag or env var | Notes |
| --- | --- | --- |
| Node.js heap sizing | `ATOMIC_HEAP_MB` | On npm/Node.js installs, Atomic sizes the heap to half the cgroup memory limit when larger than Node's default; set `0` to keep Node's default ([Diagnostics and performance](/environment-variables#diagnostics-and-performance)). |
| Background shell cgroups | `ATOMIC_TASK_CGROUP=0` | On Linux with user-owned cgroup v2, Atomic contains background shell trees in cgroups; set `0` if container cgroup policies block it ([Background tasks reference](/background-tasks/reference#lifetime-retention-and-cleanup)). |
| Restricted egress / offline | `--offline` or `ATOMIC_OFFLINE=1` | Disables automatic update checks, telemetry, and binary downloads. |
| Proxies and private CAs | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` | Or set `httpProxy` in [Network proxy settings](/settings#network-proxy). See [TLS certificates](/environment-variables#tls-certificates) and [PostgreSQL through an HTTP proxy](/storage/postgres#through-an-http-proxy). |
| Reading container-local URLs | `ATOMIC_ALLOW_PRIVATE_URL_READS=1` | Set only if `read` must reach localhost or private-network services inside the container. |
| Headless and CI runs | `-p` / `--mode json` / `--mode rpc`, `--no-session`, `--approve` / `--no-approve` | Run without `-it` ([Non-interactive usage](/guides/non-interactive)). For shared CI fleets, set `ATOMIC_STORAGE` ([Team and CI setup](/guides/team-setup#ci-and-swarms)) and pre-warm environments with `.atomic/blueprint.yaml` and `atomic blueprint prebuild` ([Resume on any machine](/guides/resume-on-any-machine#set-the-environment-up-with-a-blueprint)). |

## NVIDIA OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) for a policy-controlled sandbox with filesystem, process, network, credential, and inference controls. OpenShell runs sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

<Steps>
  <Step title="Register and select an OpenShell gateway">
    ```bash
    openshell gateway add <gateway-url> --name <name>
    openshell gateway select <name>
    ```
  </Step>
  <Step title="Launch Atomic inside a sandbox">
    ```bash
    openshell sandbox create --name atomic-sandbox --from atomic -- atomic
    ```
  </Step>
  <Step title="Transfer files for remote gateways (optional)">
    With a remote gateway, host files are not bind-mounted, so sandbox edits do not touch your local checkout. Clone inside the sandbox or copy files explicitly:

    ```bash
    openshell sandbox upload atomic-sandbox ./repo /workspace
    openshell sandbox download atomic-sandbox /workspace/repo ./repo-out
    ```
  </Step>
</Steps>

The whole `atomic` process runs inside the sandbox, so built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

### Routing inference through OpenShell

OpenShell providers can keep raw model API keys outside the sandbox. When inference routing is enabled, tools inside the sandbox call `https://inference.local` and the OpenShell gateway injects provider credentials upstream.

Point Atomic at `https://inference.local` by adding a provider entry to `~/.atomic/agent/models.json` inside the sandbox. For example, to route an OpenAI-compatible gateway endpoint:

```json
{
  "providers": {
    "openshell": {
      "baseUrl": "https://inference.local/v1",
      "api": "openai-completions",
      "apiKey": "openshell-managed",
      "models": [
        { "id": "your-model-id" }
      ]
    }
  }
}
```

Use `"api": "anthropic-messages"` when your OpenShell gateway exposes an Anthropic-compatible endpoint, or override `baseUrl` on a built-in provider entry. See [Configure custom models](/models) and [Build custom providers](/custom-provider) for full `models.json` and extension options.
