---
title: "Task guides"
sidebarTitle: "Task guides"
description: "Task guides for everyday terminal work, sessions, compaction, subagents, models, and security."
---

New to Atomic? Start with the [Quickstart](/quickstart) to install, authenticate, run your first session, and add project instructions, or read [How Atomic works](/how-atomic-works) for the complete mental model.

## Use Atomic daily

<Columns cols={2}>
  <Card title="Use interactive mode" href="/usage">
    Terminal editor, `@` file references, `!` shell commands, message queueing, and prompt history search.
  </Card>
  <Card title="Run non-interactively" href="/guides/non-interactive">
    One-shot prompts with `-p`, piped stdin, JSON event streams, and headless scripting.
  </Card>
  <Card title="Configure Atomic" href="/guides/configuration">
    Set up global defaults in `~/.atomic/agent/settings.json` and project-level overrides.
  </Card>
  <Card title="Manage sessions" href="/sessions">
    Resume, name, search, branch with `/tree`, fork, clone, and recall past sessions.
  </Card>
  <Card title="Worktree snapshots" href="/worktree-snapshots">
    Capture and restore Git repository state alongside your session history.
  </Card>
  <Card title="Resume on any machine" href="/guides/resume-on-any-machine">
    Continue sessions across hosts over shared PostgreSQL and rebuild environments with `.atomic/blueprint.yaml`.
  </Card>
  <Card title="Context and compaction" href="/compaction">
    Keep long runs within context limits with zero-call memory compaction or custom remote compactors.
  </Card>
  <Card title="Custom compaction models" href="/compaction/custom-compactors">
    Use built-in Morph compaction or connect your own remote compactor endpoint with automatic fallback.
  </Card>
</Columns>

## Delegate and automate

<Columns cols={2}>
  <Card title="Orchestrate multi-step work" href="/orchestration">
    Combine skills, subagents, and verification loops to plan and validate larger tasks.
  </Card>
  <Card title="Run subagents" href="/subagents">
    Delegate independent work to fresh or forked subagents, isolate edits in worktrees, and control runs.
  </Card>
  <Card title="Background tasks" href="/background-tasks">
    Launch, inspect, steer, pause, and stop background subagents and shells in `/tasks`.
  </Card>
  <Card title="Coordinate sessions with Intercom" href="/intercom">
    Message and ask live sessions or sibling subagents on one machine or across a shared database.
  </Card>
  <Card title="Team and CI setup" href="/guides/team-setup">
    Share Intercom across a team with PostgreSQL while keeping sessions private, and set up CI runners.
  </Card>
  <Card title="Computer use" href="/computer-use">
    Automate browsers, native desktop apps, and terminals across macOS, Linux, and Windows.
  </Card>
  <Card title="Verification" href="/verification">
    Reproduce bugs and gather verifiable evidence across terminal, browser, and desktop workflows.
  </Card>
</Columns>

## Models and providers

<Columns cols={2}>
  <Card title="Choose a model" href="/models/choose-a-model">
    Decide between subscriptions, API keys, local models, and custom endpoints, and configure model cycling.
  </Card>
  <Card title="Model providers" href="/providers">
    Connect subscription logins, API keys, and cloud gateways (Bedrock, Vertex AI, Azure, NIM).
  </Card>
  <Card title="Local models with llama.cpp" href="/llama-cpp">
    Run local GGUF models with a `llama.cpp` router and manage them with `/llama`.
  </Card>
</Columns>

## Security and isolation

<Columns cols={2}>
  <Card title="Security" href="/security">
    Review project trust boundaries, OS tool permissions, and credential guarantees.
  </Card>
  <Card title="Containerization" href="/containerization">
    Isolate Atomic or its tool execution inside Gondolin, Docker, or OpenShell.
  </Card>
</Columns>

## Build and reference

Looking to extend, embed, or look up exact flags and schemas?

- **[Build with Atomic](/build):** Write [skills](/skills), [prompt templates](/prompt-templates), [themes](/themes), [extensions](/extensions), [custom models](/models) and [providers](/custom-provider), [Atomic packages](/packages), or embed Atomic via the [TypeScript SDK, RPC, or JSON mode](/programmatic).
- **[Reference index](/reference):** Look up [CLI options](/reference/cli), [Slash commands](/slash-commands), [Settings](/settings), [Environment variables](/environment-variables), [Keybindings](/keybindings), [Built-in tools](/tools), [Codemode](/codemode), [MCP servers](/mcp-servers), [Web access](/web-access), [Storage](/storage), [Platform setup](/reference#platform-setup), and [Diagnostics and debugging](/development).
