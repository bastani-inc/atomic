---
title: First session
description: Start Atomic, run a first task, and inspect background work.
---

# First session

**Outcome:** You complete one interactive task and verify its saved session.

**Prerequisites:** [Authentication](/getting-started/authentication) is complete.

## First session

Start Atomic in a repository directory:

```bash
cd /path/to/project
atomic
```

On a fresh install with no prior startup state, Atomic displays a one-time overview above the input box (after any What's New notes). Returning users skip it automatically; stored credentials alone do not skip it.

The prompt is ready immediately. Type a request, run `/login` to connect a provider, or run `/agents` to browse available subagents.

## Verify the session

Run a bounded task in a repository you know:

```text
List the top-level directories in this repository and say what each one holds.
```

Expected result: Atomic streams a response, calls `read` on a directory, `find`, or `bash` at least once — each tool call is shown inline as it runs — and finishes with a summary naming directories that actually exist in your checkout. If it names nothing from your repository, quit, `cd` into the repository, and start Atomic again.

Exit Atomic (`/exit`) and verify the session was saved:

```bash
atomic -r
```

Expected result: the session picker lists the run you just finished. Run `atomic -c` to resume it.

## Go further

Once your first session works, reach for these capabilities as needed.

### Delegate a larger task

Ask Atomic to split independent work across [subagents](/subagents):

```text
Ask one subagent to trace the retry logic and another to find its tests. Compare their findings and show me any gaps.
```

- Run `/tasks` to inspect background subagents and read their output.
- Run `/resume` to return to a saved session.

**Converting older workflows:** Workflows are now skills. Give Atomic an older workflow file path and ask it to convert it. In a trusted project, Atomic reads the file as text and uses `skill-creator` to write a skill under `.atomic/skills/<name>/` (project) or `~/.atomic/agent/skills/<name>/` (global), combining codemode, subagents, and helper scripts in `scripts/`. Nothing converts automatically at startup, the original file is never executed or modified, and existing skills are not overwritten.

### Top skills to invoke directly

Skills are reusable expert instructions invoked with `/skill:<name>`:

| Skill | When to use | Example |
| --- | --- | --- |
| `research-codebase` | Scoped research writing a grounded artifact for one subsystem or question. | `/skill:research-codebase how the rate limiter works in src/middleware/` |
| `create-spec` | Turn research into an implementation-ready plan. | `/skill:create-spec from research/docs/2026-03-rate-limit.md` |
| `prompt-engineer` | Write, evaluate, migrate, or troubleshoot GPT and Claude prompts with model-specific guides. | `/skill:prompt-engineer Draft a sharper repo-research prompt for payment retries end to end.` |
| `tdd` | Test-first feature or bug work. | `/skill:tdd` |
| `impeccable` | Critique or refine web/native frontend and product UI (detector hooks, live review, mount-failure recovery). | `/skill:impeccable` |
| `agent-browser` | Drive a real browser for end-to-end UI checks, screenshots, and proof videos. | `/skill:agent-browser` |
| `agent-desktop` | Drive a native desktop app via its accessibility tree: snapshot, act on a ref, wait for postcondition. | `/skill:agent-desktop` |
| `qlty` | Lint, auto-format, and measure complexity, duplication, and smells across languages. | `/skill:qlty check this branch before I hand it off` |
| `liteparse` | Extract text, tables, or values from PDF, DOCX, PPTX, XLSX, and images locally. | `/skill:liteparse` |
| `show-me` | Explain topics visually with diagrams, code sketches, or focused HTML artifacts (HumanLayer, MIT). | `/skill:show-me` |

Impeccable 4.10.0 runs its commands (`context`, `live`, `detect`, hooks, and the rest) through a self-contained engine binary instead of Node scripts. The bundled launcher, `scripts/impeccable` (`impeccable.cmd` on Windows), looks for a binary next to itself, then in `~/.impeccable/bin/`, and otherwise downloads the pinned engine release for your platform into `~/.impeccable/bin/<version>/` and verifies it against the SHA-256 digest that ships with the skill (`scripts/engine-checksums.txt`) before running it, so the first use needs network access. A download or a cached engine that does not match its digest is refused, and a binary next to the launcher that reports a different engine version is skipped. Point `IMPECCABLE_BIN` at a preinstalled engine or set `IMPECCABLE_HOME` to a writable cache when that is not possible. Atomic's launcher keeps the engine's anonymous telemetry pings and its `npx impeccable update` check switched off, since the skill ships with each Atomic release. A concept roll still fetches its catalog with a `GET /api/roll` request to `impeccable.style`, which carries the scope, mode, a short seed key, and a re-roll counter, but no project files, prompts, code, or conversation. Live sessions resolve to the selected app root and support SvelteKit, Nuxt, TanStack Start, Astro, Next.js, Vite, and static HTML injection. The image fallback runs only with `OPENAI_API_KEY`, sends prompts and optional reference images to OpenAI, or to the endpoint in `OPENAI_BASE_URL` when that variable is set, and spends that account's API credit. Generated image prompts are embedded in the image or a sidecar, so do not include secrets.

### Default tools and prompts

Type any plain request and press Enter:

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

Normal coding sessions include file discovery and content search through `find` and `search` in addition to `read`, `bash`, `edit`, and `write`. Atomic runs in your current working directory and can modify files there, so use git or another checkpointing flow for easy rollback.

## Next step

Continue to [Project instructions](/getting-started/project-instructions).
