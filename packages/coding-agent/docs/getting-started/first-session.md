---
title: First session
description: Start Atomic, run a first task, and inspect background work.
---

# First session

**Outcome:** You complete one interactive task and know where to find its saved session.

**Prerequisites:** [Authentication](/getting-started/authentication) is complete.

## First session

On a fresh install with no prior startup state, Atomic shows a one-time explanation of the coding agent. It appears after any What's New notes, directly above the input box. Returning users with prior startup state skip it automatically; stored credentials alone do not skip it.

The normal Atomic input is ready from the start. Type a message, run `/login` if no provider is connected, or use `/agents` to browse the available subagents. No separate onboarding step is required.

## Verify the session

Run one bounded task and watch it complete. In a repository you know, type:

```text
List the top-level directories in this repository and say what each one holds.
```

Expected result: Atomic streams a response, calls `read` on a directory, `find`, or `bash` at least once — each tool call is shown inline as it runs — and finishes with a summary naming directories that actually exist in your checkout. A response that names nothing from your repository means the session started outside the directory you meant; quit, `cd` to the right place, and start Atomic again.

Then confirm the session was recorded:

```bash
atomic -r
```

Expected result: the session picker lists the run you just finished. That session is what `atomic -c` resumes.

## Go further

With a session working, these are the fuller capabilities to reach for next. None of them is required for a first successful session.

### Delegate a larger task

Ask Atomic to split independent work between [subagents](/subagents). For example:

```text
Ask one subagent to trace the retry logic and another to find its tests. Compare their findings and show me any gaps.
```

Open `/tasks` to inspect background work and read a subagent's output. Use `/resume` to return to a saved conversation.

Workflows are now skills. To use an older workflow, give Atomic the path and ask it to convert the file to a skill. In a trusted project, Atomic reads the definition as text and uses `skill-creator` to save a skill under `.atomic/skills/<name>/` for a project workflow, or `~/.atomic/agent/skills/<name>/` for a global one. The new skill uses codemode and subagents, with deterministic helper code in `scripts/`. Nothing is converted at startup. The old file is never executed, edited or deleted, and the conversion does not overwrite existing skills.

### Top skills to invoke directly

Skills are reusable expert instructions. Trigger one with `/skill:<name>` followed by a request:

| Skill | When to use | Example |
|---|---|---|
| `research-codebase` | Scoped research that writes a grounded artifact for one subsystem or question. | `/skill:research-codebase how the rate limiter works in src/middleware/` |
| `create-spec` | Turn research into an implementation-ready plan. | `/skill:create-spec from research/docs/2026-03-rate-limit.md` |
| `prompt-engineer` | Write, evaluate, migrate, or troubleshoot GPT and Claude prompts using separate model guides. | `/skill:prompt-engineer Draft a sharper repo-research prompt for payment retries end to end.` |
| `tdd` | Test-first feature or bug work. | `/skill:tdd` |
| `impeccable` | Critique or refine web/native frontend and product UI; includes detector hooks, framework-aware live review, and mount-failure recovery. | `/skill:impeccable` |
| `agent-browser` | Drive a real browser for end-to-end UI checks, screenshots, and reviewable proof videos. | `/skill:agent-browser` |
| `agent-desktop` | Drive a native desktop app through its accessibility tree with the agent-desktop CLI: snapshot, act on a ref, and wait for the postcondition to verify. | `/skill:agent-desktop` |
| `qlty` | Lint, auto-format, and measure code quality — complexity, duplication, and code smells — through one CLI across the repository's languages. | `/skill:qlty check this branch before I hand it off` |
| `liteparse` | Pull text, tables, or values out of PDF, DOCX, PPTX, XLSX, and image files locally. | `/skill:liteparse` |
| `show-me` | Explain a topic visually with concise diagrams, code-shape sketches, or focused HTML artifacts. HumanLayer, MIT licensed. | `/skill:show-me` |

Impeccable 4.9.1 runs its commands (`context`, `live`, `detect`, hooks, and the rest) through a self-contained engine binary instead of Node scripts. The bundled launcher, `scripts/impeccable` (`impeccable.cmd` on Windows), looks for a binary next to itself, then in `~/.impeccable/bin/`, and otherwise downloads the pinned engine release for your platform into `~/.impeccable/bin/<version>/` and verifies it against the SHA-256 digest that ships with the skill (`scripts/engine-checksums.txt`) before running it, so the first use needs network access. A download or a cached engine that does not match its digest is refused, and a binary next to the launcher that reports a different engine version is skipped. Point `IMPECCABLE_BIN` at a preinstalled engine or set `IMPECCABLE_HOME` to a writable cache when that is not possible. Atomic's launcher keeps the engine's anonymous telemetry pings and its `npx impeccable update` check switched off, since the skill ships with each Atomic release. A concept roll still fetches its catalog with a `GET /api/roll` request to `impeccable.style`, which carries the scope, mode, a short seed key, and a re-roll counter, but no project files, prompts, code, or conversation. Live sessions resolve to the selected app root and support SvelteKit, Nuxt, TanStack Start, Astro, Next.js, Vite, and static HTML injection. The image fallback runs only with `OPENAI_API_KEY`, sends prompts and optional reference images to OpenAI, or to the endpoint in `OPENAI_BASE_URL` when that variable is set, and spends that account's API credit. Generated image prompts are embedded in the image or a sidecar, so do not include secrets.

### Default tools and prompts

If you'd rather start with a plain prompt, just type a request and press Enter:

```text
Summarize this repository and tell me how to run its checks.
```

By default, Atomic gives the model these tools:

- `read` - read files
- `bash` - run shell commands
- `kill` - cancel owned background shell tasks by task ID
- `edit` - patch files
- `write` - create or overwrite files
- `find` - discover files by glob pattern
- `search` - search file contents
- `ask_user_question` - ask structured questions in the TUI
- `todo` - manage file-based todos
- `codemode` - compose permitted tool calls in a script

On native Windows, `powershell` is also enabled when a PowerShell executable is available.

Normal coding sessions include file discovery and content search through `find` and `search` in addition to `read`, `bash`, `edit`, and `write`. Atomic runs in your current working directory and can modify files there. Use git or another checkpointing workflow if you want easy rollback.

## Next step

Continue to [Project instructions](/getting-started/project-instructions).
