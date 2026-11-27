---
title: "How Atomic works"
sidebarTitle: "How Atomic works"
description: "Understand Atomic's agent loop, two-process terminal architecture, context assembly, session trees, compaction, and trust boundaries."
---

Atomic coordinates model requests, tool execution, context assembly, and session persistence. A **session** is Atomic's durable record of a conversation, including messages, tool calls and results, model changes, worktree snapshots, and compaction boundaries.

<Warning>
**Tools run with your OS permissions.** Atomic checks **project trust** before loading project settings, instructions, extensions, skills, subagents, or MCP servers, but project trust is not a sandbox. Enabled tools and extensions execute with your operating-system user permissions. Review [Security](/security) and [Containerization](/containerization) before running Atomic on untrusted code or unattended automation.
</Warning>

## The agent loop

Messages and events in a session form a tree. Each path from the root to an entry is a **branch**. The branch ending at the current entry is the **active branch** and supplies conversation history for the next model request.

When you submit a message, Atomic runs a turn loop:

<Steps>
  <Step title="Record and assemble the request">
    Atomic appends your message to the active branch, builds the system prompt and model-compatible conversation history, attaches active tool definitions and model settings, and sends the request to the selected provider.
  </Step>
  <Step title="Stream the response and execute tools">
    The provider streams assistant text, optional reasoning blocks, and tool calls. Atomic records the response, runs each tool call in your environment, and records each tool result. That completes one turn.
  </Step>
  <Step title="Continue or finish">
    If tool results or queued messages require another model call, Atomic starts another turn automatically. Otherwise, the run finishes and waits for your next prompt.
  </Step>
</Steps>

### Steering, follow-ups, and cancellation

You do not have to wait for a run to finish before guiding it:

| Action | Default shortcut | When it takes effect |
| --- | --- | --- |
| **Steer the active run** | `Enter` | Enters after the current assistant turn and its tool calls settle, redirecting work mid-run. |
| **Queue a follow-up** | `Alt+Enter` (`Ctrl+Q` on Windows and WSL) | Waits until the agent finishes all pending turns, then starts the next task. |
| **Pull queued messages back** | `Alt+Up` (`Alt+Q` on Windows and WSL) | Returns queued messages to the editor so you can edit or discard them. |
| **Cancel the current run** | `Esc` | Stops the active model stream or tool execution and restores queued messages to the editor. |

See [Interactive mode](/usage) and [Keybindings](/keybindings) for full queueing and shortcut details.

## Two-process interactive architecture

In interactive mode, Atomic runs two cooperating processes:

- **The terminal UI host** owns your screen, input editor, scrolling transcript, overlays, and keyboard shortcuts.
- **The background session engine** owns model requests, tool execution, extensions, and session storage.

Keeping the UI separate from the session engine lets you type, scroll, inspect `/tasks`, queue messages, or cancel a stuck turn even while a model call, tool, or extension is busy. If a cancellation stalls or the background engine exits unexpectedly, the terminal host recovers cleanly and preserves any unsent text in your editor.

## Context assembly pipeline

Before every model request, Atomic builds two inputs: the **system prompt** and the **conversation history**.

### System prompt order

Atomic assembles system prompt sections in cache-friendly order so stable instructions stay cached across turns and sessions:

1. **Base prompt, tools, and guidelines:** Atomic's default instructions (or a replacement from `SYSTEM.md` or `--system-prompt`), summaries of active tools, coding guidelines, and any `APPEND_SYSTEM.md` or `--append-system-prompt` addendum.
2. **Built-in documentation pointers:** Paths to Atomic's local guides so the agent can look up Atomic features accurately when asked.
3. **Project context files:** Discovered `AGENTS.override.md`, `AGENTS.md`, or `CLAUDE.md` files concatenated top-down from global config and ancestor directories to your working directory (see [Add project instructions](/getting-started/project-instructions)).
4. **Skill catalog:** Short descriptions of discovered skills. Full `SKILL.md` instructions load on demand only when you invoke `/skill:<name>` or the agent reads the skill.
5. **Dynamic session metadata:** The active model and reasoning level, current working directory, session folder, and current date. Placing these last prevents directory or date changes from invalidating earlier prompt-cache prefixes.

### Conversation history and input expansion

Atomic reconstructs conversation history from the active branch on each turn:

- **Input expansion:** Prompt templates (`/template`) and skill commands (`/skill:<name>`) expand before reaching the model. `@file` references, pasted images, and `!` shell command outputs attach directly to the conversation, while `!!` shell commands run locally without entering model context.
- **Active branch conversion:** Session entries convert into model-compatible user, assistant, and tool-result messages, stopping at the most recent compaction boundary and skipping failed turns that Atomic automatically recovered from (while keeping them in raw history for inspection).
- **Extension hooks:** Extensions can inspect or transform input and context before a request leaves Atomic.

## Sessions, trees, snapshots, and persistence

Because every session is a tree of entries linked to their parents, you can explore alternative approaches without losing earlier work:

- **Branching in place (`/tree`):** Jump back to any earlier entry and continue from there to create a new branch inside the same session.
- **Forking and cloning (`/fork`, `/clone`):** Create a new session starting from an earlier user message (`/fork`) or duplicating your current position (`/clone`). Forked sessions share their parent's stored history efficiently.
- **Subagent sessions:** [Subagents](/subagents) run in child sessions—either fresh or forked from the parent conversation—persisted in the same store so you can inspect, resume, and export them alongside your main session.
- **Storage backends:** By default, Atomic saves sessions in a local SQLite database (`~/.atomic/workflows/journal.sqlite`) with fast search and session memory recall. You can also choose per-session JSONL files or a shared PostgreSQL database to resume sessions across machines (see [Storage](/storage)).
- **Worktree snapshots:** In Git repositories, Atomic can record repository state alongside session turns so resuming a session—locally or on another machine—can restore matching files and run `.atomic/blueprint.yaml` setup steps (see [Worktree snapshots](/worktree-snapshots) and [Resume sessions on any machine](/guides/resume-on-any-machine)).

## Context limits and compaction

Every model has a finite context window. When active context nears the limit—or when you run `/compact`—Atomic writes a compaction boundary without deleting prior messages from session history:

- **Memory compaction (default):** Clears the active context window with no extra model call and inserts a recovery boundary pointing to session history (`history://`). The agent reads or searches exact earlier turns on demand instead of relying on a lossy summary.
- **Custom compaction models:** Sends the active context once to a dedicated remote compactor (such as built-in Morph or your own endpoint) and falls back automatically to memory compaction if that endpoint fails or times out.
- **Branch summaries:** When `/tree` leaves a branch, Atomic can optionally generate a separate summary of the abandoned branch and attach it to your new branch position.

See [Context and compaction](/compaction) for details and configuration.

## One runtime, five interfaces

Interactive chat, CLI automation, and embedded apps all run on the same agent loop, tool system, extensions, and session storage:

| Interface | How to start it | Best for |
| --- | --- | --- |
| **Interactive TUI** | `atomic` | Everyday coding, live tool inspection, `/tasks`, `/tree`, and subagents. |
| **Print mode** | `atomic -p "..."` or piped stdin | One-shot scripts, CI checks, and shell pipelines. |
| **JSON event stream** | `atomic --mode json` | Consuming structured turn, message, and tool events from stdout. |
| **RPC mode** | `atomic --mode rpc` | Driving a separate Atomic process over stdin/stdout JSON commands. |
| **TypeScript SDK** | `createAgentSession()` | Embedding Atomic directly inside a Node.js or TypeScript application. |

See [Non-interactive mode](/guides/non-interactive) and [Programmatic modes](/programmatic) to choose an integration path.

## Extensions and bundled capabilities

Extensions are TypeScript modules loaded into the session engine. They can register tools, slash commands, keyboard shortcuts, model providers, event handlers, and custom terminal views.

Atomic also ships its built-in integrations—[subagents](/subagents), [Intercom](/intercom), [MCP servers](/mcp-servers), [web access](/web-access), and [`llama.cpp`](/llama-cpp)—as **lazy bundled extensions**. Their tools and slash commands are visible immediately, while their full runtimes load only when first used so startup stays fast.

For lighter customization without writing TypeScript, use [skills](/skills), [prompt templates](/prompt-templates), [themes](/themes), and [Atomic packages](/packages).

## Project trust vs. OS permissions

Before loading project-controlled configuration, Atomic resolves a **project trust** decision for your working directory:

- **Blocked until trusted:** Project `settings.json`, extensions, skills, prompt templates, themes, subagents, `mcp.json`, `blueprint.yaml`, `SYSTEM.md`, `APPEND_SYSTEM.md`, and **project and ancestor context files** (`AGENTS.md` / `CLAUDE.md`).
- **Always loaded:** Your global configuration and global context files in `~/.atomic/agent/`.
- **Not a sandbox:** Trust controls which project files Atomic loads automatically—it does not restrict what enabled tools (`bash`, `read`, `edit`, `write`) or loaded extensions can access on your machine. Use `/trust` to update saved decisions, `--approve` / `--no-approve` for one-off CLI overrides, and containers when you need OS-level isolation.

## Next steps

<Columns cols={2}>
  <Card title="Use interactive mode" href="/usage">
    Learn the editor, queueing, file references, and everyday shortcuts.
  </Card>
  <Card title="Manage sessions" href="/sessions">
    Resume, search, branch with `/tree`, fork, and recall past sessions.
  </Card>
  <Card title="Context and compaction" href="/compaction">
    See how memory compaction and custom compactors keep long runs fast.
  </Card>
  <Card title="Slash commands" href="/slash-commands">
    Browse every built-in and bundled extension slash command.
  </Card>
</Columns>
