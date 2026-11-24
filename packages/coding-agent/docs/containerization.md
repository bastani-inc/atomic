---
title: "Run Atomic in containers"
sidebarTitle: "Containers"
description: "Isolate Atomic or its built-in tools using Gondolin micro-VMs, Docker containers, or NVIDIA OpenShell sandboxes."
---

Atomic runs with all of your local user permissions by default. To restrict which directories it can access and modify, choose one of two isolation models:

1. Run the whole `atomic` process inside a container or managed sandbox.
2. Run `atomic` on your host and route built-in file and shell tools into a micro-VM.

Containerization is the outer boundary, not the only one. Read [Security and project trust](/security) alongside this page to see how project trust gates which project extensions, skills, and settings load before work starts.

## Choose an isolation pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin micro-VM | Selected file tools, `bash`, and `!` commands | Local VM tool routing while keeping credentials on the host | `search` and custom host extensions remain on the host. See [`examples/extensions/gondolin/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin). |
| Docker | Whole `atomic` process in a local container | Simple local isolation | Provider API keys enter the container. |
| NVIDIA OpenShell | Whole `atomic` process in a policy-controlled sandbox | Local or remote managed sandboxes with upstream credential injection | Requires an OpenShell gateway. |

Extensions run wherever the `atomic` process runs. If you run host `atomic` with a tool-routing extension, other loaded extensions still run on your host unless they also route their work into the VM.

## Gondolin micro-VM

[Gondolin](https://github.com/earendil-works/gondolin) runs a local Linux micro-VM. Use the [Gondolin example extension](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin) when you want `atomic` on your host with selected file tools and shell execution routed into the VM. This does not isolate the entire session.

Copy `examples/extensions/gondolin` to a directory **outside** `~/.atomic/agent/extensions/` (for example `~/.local/share/atomic-gondolin`) when you want opt-in per-session use with `-e`, then install its dependencies:

```bash
cp -R "$(npm root -g)/@bastani/atomic/examples/extensions/gondolin" ~/.local/share/atomic-gondolin
cd ~/.local/share/atomic-gondolin
npm ci --ignore-scripts
```

Launch Atomic with `-e` from the project directory you want mounted inside the VM:

```bash
cd /path/to/project
atomic -e ~/.local/share/atomic-gondolin
```

Do not copy the extension into `~/.atomic/agent/extensions/gondolin` unless you want **every** `atomic` session on your machine to boot a Gondolin VM automatically. Because that directory contains both `index.ts` and `package.json`, placing it inside `~/.atomic/agent/extensions/` causes Atomic to auto-load it globally even without `-e`.

### What the Gondolin extension routes and omits

- **Workspace mount:** Mounts your current host working directory at `/workspace` inside the VM. Edits under `/workspace` write through to your host files.
- **Routed tools and status:** Overrides `read`, `write`, `edit`, `bash`, `find`, and `ls`, plus interactive `!` commands. Registers the `/gondolin` command (prints VM ID, host workspace, guest workspace, and guest shell) and a footer status item (`Gondolin: <id> (/workspace)`).
- **Environment isolation:** Does not forward host shell environment variables into VM commands, keeping host API keys out of the VM.
- **Guest shell and tool caveats:** Probes `bash` first inside the guest and falls back to `/bin/sh`. Routed `find` skips `.git` and `node_modules` only and does not apply `.gitignore`. Routed `read` detects images by filename extension (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`), and routed `write` writes UTF-8 text.
- **Unrouted tools:** `search` stays on the host and is not routed into the VM. Run searches inside the guest through `bash` or `!`.

To expose only the routed built-in tools in a session:

```bash
atomic --tools read,write,edit,bash,find,ls -e ~/.local/share/atomic-gondolin
```

`ls` is a built-in tool that is off by default unless listed. Restricting `--tools` to this allowlist also disables `intercom`, `subagent`, and other extension tools; MCP tools stay hidden unless a `mcp__*` pattern is listed. Other loaded host extensions can still run code on the host, so use whole-process isolation when host filesystem access must be prevented completely.

**Requirements:** npm to install dependencies, Node.js 23.6.0 or newer for `@earendil-works/gondolin`, and QEMU installed through your system package manager.

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

The archive installer unpacks a self-contained bundle with no JavaScript runtime required. If you adapt this Dockerfile to a smaller base image, make sure `install.sh` has `uname`, `tar` with `gzip`, core file utilities (`mkdir`, `mv`, `chmod`, `ln`, `rm`, `rmdir`), `curl` or `wget`, `sha256sum` (or `shasum` or `openssl`), and `ldd` on non-Alpine Linux. `debian:bookworm-slim` already includes these tools.

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

If you mount only `/root/.atomic/agent`, setting `ATOMIC_CODING_AGENT_DIR=/root/.atomic/agent` does **not** keep sessions inside that volume. Because `/root/.atomic/agent` matches the default agent directory, Atomic still places `journal.sqlite` outside the volume at `/root/.atomic/workflows/journal.sqlite`.

When mounting only `/root/.atomic/agent`, persist sessions with one of these options:

- Pass `--session-store /root/.atomic/agent/journal.sqlite` (or configure `ATOMIC_STORAGE` or `ATOMIC_SESSIONS_STORAGE` to point inside `/root/.atomic/agent`).
- Set `ATOMIC_CODING_AGENT_DIR` to a non-default subdirectory inside the volume, such as `/root/.atomic/agent/state`, so Atomic stores sessions at `/root/.atomic/agent/state/workflows/journal.sqlite`.
- Mount `/root/.atomic` instead of only `/root/.atomic/agent`.

Avoid mounting your host `~/.atomic` or `~/.atomic/agent` directory unless the container should have access to your host credentials, settings, and sessions.

## NVIDIA OpenShell

Use [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) for a policy-controlled sandbox with filesystem, process, network, credential, and inference controls. OpenShell runs sandboxes through a local gateway backed by Docker, Podman, or a VM runtime, or through a remote Kubernetes gateway.

Register and select an active gateway before creating a sandbox:

```bash
openshell gateway add <gateway-url> --name <name>
openshell gateway select <name>
```

Launch `atomic` inside an OpenShell sandbox:

```bash
openshell sandbox create --name atomic-sandbox --from atomic -- atomic
```

The whole `atomic` process runs inside the sandbox, so built-in tools, `!` commands, and extension tools execute inside the OpenShell boundary.

With a remote gateway, project files are not bind-mounted from the host, so writes in the sandbox do not modify your local checkout. Clone the repository inside the sandbox or transfer files with OpenShell:

```bash
openshell sandbox upload atomic-sandbox ./repo /workspace
openshell sandbox download atomic-sandbox /workspace/repo ./repo-out
```

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

Use `"api": "anthropic-messages"` when your OpenShell gateway exposes an Anthropic-compatible endpoint, or override `baseUrl` on a built-in provider entry. See [Custom models](/models) and [Custom providers](/custom-provider) for full `models.json` options.
