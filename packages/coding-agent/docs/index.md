---
title: "Atomic documentation"
sidebarTitle: "Introduction"
description: "Install Atomic, connect a model provider, and explore guides, customization APIs, and CLI references."
---

Atomic is an extensible coding agent that runs in your terminal. Give it a goal and a repository, and it inspects files, runs commands, edits code, delegates work to subagents, and saves full session history you can resume or branch anytime.

<Warning>
**Permissions and project trust.** Atomic's tools and loaded extensions run with your operating-system user permissions. **Project trust** controls which repository settings, instructions, extensions, skills, subagents, and MCP servers Atomic loads automatically, but it is not a sandbox. Review [Security](/security) and [Containerization](/containerization) before running Atomic on untrusted code or unattended automation.
</Warning>

## Quick start

Install with a package manager (requires [Node.js 24.20.0 or newer](/getting-started/installation#nodejs-version) at runtime) or use the self-contained [release archive](/getting-started/installation#release-archive) with no Node.js required:

```bash
npm install -g @bastani/atomic
atomic
```

Sign in inside Atomic with `/login`, from your shell with `atomic auth login <provider>`, or by exporting an API key such as `ANTHROPIC_API_KEY`. Follow the [Quickstart](/quickstart) for the complete four-step walkthrough, or see [Install Atomic](/getting-started/installation) for pnpm, Bun, macOS/Linux/Windows archives, and troubleshooting.

## Start here

<Columns cols={2}>
  <Card title="Quickstart" href="/quickstart">
    Install Atomic, connect a provider, run your first task, and add project instructions.
  </Card>
  <Card title="How Atomic works" href="/how-atomic-works">
    Learn the agent loop, two-process terminal architecture, context assembly, compaction, and trust model.
  </Card>
  <Card title="Choose a model" href="/models/choose-a-model">
    Pick between subscriptions, API keys, local llama.cpp models, and compatible custom endpoints.
  </Card>
  <Card title="Use interactive mode" href="/usage">
    Master the terminal editor, file references, shell commands, message queueing, and shortcuts.
  </Card>
</Columns>

## Explore by capability

<Columns cols={2}>
  <Card title="Sessions and branching" href="/sessions">
    Resume conversations, search past history, and explore alternatives with `/tree`, `/fork`, and `/clone`.
  </Card>
  <Card title="Worktree snapshots and resume" href="/worktree-snapshots">
    Capture repository state alongside session turns and restore checkouts locally or across machines.
  </Card>
  <Card title="Context and compaction" href="/compaction">
    Keep long sessions within budget with zero-call memory compaction or custom remote compactors.
  </Card>
  <Card title="Subagents and orchestration" href="/subagents">
    Delegate independent tasks to fresh or forked background subagents and verify multi-step results.
  </Card>
  <Card title="Intercom and background tasks" href="/intercom">
    Coordinate live sessions across one host or a shared database and inspect background work in `/tasks`.
  </Card>
  <Card title="MCP servers and extensibility" href="/mcp-servers">
    Connect external tools over Model Context Protocol or extend Atomic with skills, themes, and extensions.
  </Card>
</Columns>

## Documentation paths

<Columns cols={3}>
  <Card title="Learn" href="/guides">
    Onboarding, everyday terminal workflows, sessions, compaction, subagents, models, and security.
  </Card>
  <Card title="Build" href="/build">
    Skills, prompt templates, themes, extensions, packages, custom providers, SDK, RPC, and JSON mode.
  </Card>
  <Card title="Reference" href="/reference">
    CLI flags, slash commands, settings, environment variables, keybindings, tools, storage, and schemas.
  </Card>
</Columns>

Looking for a specific topic? Jump directly to [Slash commands](/slash-commands), [CLI reference](/reference/cli), [Custom compaction models](/compaction/custom-compactors), [Resume on any machine](/guides/resume-on-any-machine), [Storage](/storage), [Structured decisions](/sdk/structured-decisions), [Terminal setup](/terminal-setup), [Platform setup](/reference#platform-setup), or [Diagnostics and debugging](/development).
