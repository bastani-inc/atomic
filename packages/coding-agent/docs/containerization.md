---
title: "Containerization"
description: "Run Atomic or its tools inside Gondolin, Docker, or OpenShell containers."
---

# Containerization

Atomic runs with all local permissions by default. To restrict which directories it can write to and what it can access, choose one of two approaches:

1. Run the whole `atomic` process inside an isolated environment.
2. Run `atomic` on the host and route tool execution into an isolated environment.

Containerization is the outer boundary, not the only one. Read [Security](/security) alongside this page to see how project trust gates which project-scoped extensions, skills, and settings load in the first place.

## Choose a pattern

| Pattern | What is isolated | Best for | Notes |
| --- | --- | --- | --- |
| Gondolin extension | Selected file tools, shell execution, and `!` commands | Local micro-VM tool routing while keeping auth on the host | Other tools, including `search`, remain on the host. See [`examples/extensions/gondolin/`](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin). |
| Plain Docker | Whole `atomic` process in a local container | Simple local isolation | Provider API keys enter the container. |
| OpenShell | Whole `atomic` process in a policy-controlled sandbox | Local or remote managed sandbox | Requires an OpenShell gateway. |

Extensions run wherever the `atomic` process runs. If you run host `atomic` with a tool-routing extension, other custom extension tools still run on the host unless they also delegate their operations.

## Gondolin

[Gondolin](https://github.com/earendil-works/gondolin) is a local Linux micro-VM. Use the [Gondolin example extension](https://github.com/bastani-inc/atomic/tree/main/packages/coding-agent/examples/extensions/gondolin) when you want `atomic` on the host with selected file tools and shell execution routed into the VM. This does not isolate the entire session.

Copy the `examples/extensions/gondolin` folder into `~/.atomic/agent/extensions/gondolin` from your installed `@bastani/atomic` package (or download it from the GitHub link above), then install its dependencies:

```bash
cp -R "$(npm root -g)/@bastani/atomic/examples/extensions/gondolin" ~/.atomic/agent/extensions/gondolin
cd ~/.atomic/agent/extensions/gondolin
npm ci --ignore-scripts
```

Run Atomic from the project you want mounted:

```bash
cd /path/to/project
atomic -e ~/.atomic/agent/extensions/gondolin
```

The extension mounts your host working directory at `/workspace` in the VM and overrides `read`, `write`, `edit`, `bash`, `find`, and `ls`, along with interactive `!` commands. File changes under `/workspace` write through to the host.

`search` remains a host tool and is not redirected into the VM. For guest-only content searches, run a shell command through the routed `bash` tool or `!`. To expose only the routed built-in tools, launch with `atomic --tools read,write,edit,bash,find,ls -e ~/.atomic/agent/extensions/gondolin`. Other loaded extensions can still supply host tools; use whole-process isolation when host filesystem access must be prevented.

Requirements: npm for installing dependencies, Node.js 23.6.0 or newer for `@earendil-works/gondolin`, and QEMU installed through your system package manager.

## Plain Docker

Run the whole `atomic` process in Docker for a simple local container boundary.

`Dockerfile.atomic`:

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

The archive installer unpacks the self-contained payload and needs no JavaScript runtime or package manager. The extra apt packages support Atomic's shell and common coding tasks.

Build and run:

```bash
docker build -t atomic-sandbox -f Dockerfile.atomic .

docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v atomic-home:/root/.atomic \
  atomic-sandbox
```

`-v "$PWD:/workspace"` mounts your current directory at `/workspace` inside the container, so edits under `/workspace` write directly to your host files.

Mount a named volume on `/root/.atomic` to persist both container-local agent settings (`/root/.atomic/agent`) and default SQLite sessions (`/root/.atomic/workflows/journal.sqlite`). If you mount only `/root/.atomic/agent`, point `--session-store` or `ATOMIC_CODING_AGENT_DIR` inside that volume so sessions persist too. Avoid mounting your host `~/.atomic` or `~/.atomic/agent` unless the container should have access to host credentials and sessions.

## OpenShell

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

In this setup, the whole `atomic` process runs inside the sandbox, so built-in tools, `!` commands, and extension tools execute within the OpenShell boundary.

With a remote gateway, project files are not bind-mounted from the host, so writes in the sandbox do not modify your local checkout. Clone the repository inside the sandbox or transfer files with OpenShell:

```bash
openshell sandbox upload atomic-sandbox ./repo /workspace
openshell sandbox download atomic-sandbox /workspace/repo ./repo-out
```

OpenShell providers can keep raw model API keys outside the sandbox. When inference routing is configured, code inside the sandbox calls `https://inference.local` and the gateway injects provider credentials upstream. Configure Atomic with the matching OpenAI-compatible or Anthropic-compatible endpoint to route model traffic through the gateway.
