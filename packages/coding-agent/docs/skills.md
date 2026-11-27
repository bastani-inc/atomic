---
title: "Use and organize skills"
sidebarTitle: "Use skills"
description: "Install, discover, and invoke reusable Agent Skills instructions, scripts, and reference documents in Atomic."
---

Skills are self-contained folders or Markdown files of instructions that Atomic loads on demand. A skill can bundle specialized procedures, helper scripts, and reference docs without filling the context window until a task matches.

Atomic implements the [Agent Skills standard](https://agentskills.io/specification), warning about validation issues while still loading valid skills leniently.

<Columns cols={2}>
  <Card title="Write a custom skill" href="/skills/authoring">
    Structure a skill directory, reference helper scripts with `skill://`, and follow a complete example.
  </Card>
  <Card title="Skill format reference" href="/skills/reference">
    Check `SKILL.md` frontmatter fields, validation rules, collision qualifiers, and XML expansion format.
  </Card>
  <Card title="SDK skills reference" href="/sdk/reference#skills">
    Load, filter, or override skills programmatically from `@bastani/atomic`.
  </Card>
  <Card title="Install and manage packages" href="/packages">
    Install, update, and filter skill collections distributed as Atomic packages.
  </Card>
</Columns>

## Quick start

Invoke a bundled skill directly in chat:

```text
/skill:tdd Write a failing regression test before fixing the parser bug.
```

Create a project skill in `.atomic/skills/my-skill/SKILL.md`:

```markdown
---
name: my-skill
description: Check release readiness before tagging
---

Run `npm run check` and report any failing checks with file paths.
```

Run `/reload` in an active session, then invoke `/skill:my-skill`. See [Write a custom skill](/skills/authoring) for directory layouts, helper scripts, and reference files.

## Locations

<Warning>
Skills can instruct the model to run commands and may bundle executable scripts. Review third-party skill content before enabling it. Project skills load only after you grant [project trust](/security).
</Warning>

Atomic loads skills from these sources:

- **Global directories:** `~/.atomic/agent/skills/` (legacy `~/.pi/agent/skills/`) and `~/.agents/skills/`
- **Project directories** (trusted projects only): `.atomic/skills/` (legacy `.pi/skills/`), plus `.agents/skills/` in `cwd` and ancestor directories up to the Git repository root (or the filesystem root outside a repository)
- **Packages:** `skills/` directories, `atomic.skills`, or legacy `pi.skills` entries in `package.json`
- **Settings:** `skills` array in global or project [`settings.json`](/settings), accepting files, directories, and filter patterns (`!glob`, `+path`, `-path` with `~` expansion; see [Package filtering](/packages/reference#package-filtering))
- **CLI:** `--skill <path>` (repeatable; still loads even with `--no-skills` / `-ns`; see [CLI resource options](/reference/cli#resource-options))

### Discovery rules

- **Skill directories (`SKILL.md`).** In every skill location, directories containing `SKILL.md` are discovered recursively. Once a directory contains `SKILL.md`, Atomic treats it as a single skill root and stops recursing inside it.
  - **Root `SKILL.md` pitfall:** Never place a `SKILL.md` directly inside a top-level skills directory such as `~/.atomic/agent/skills/SKILL.md`. Doing so turns the entire directory into one skill and skips every sibling `.md` file and subdirectory.
- **Standalone `.md` files.** In `~/.atomic/agent/skills/`, `.atomic/skills/` (plus legacy `.pi/skills/`), and directories passed via `--skill` or `settings.json` `skills`, direct root `.md` files with valid skill frontmatter load as individual skills. Set `name:` explicitly in frontmatter so they do not default to `skills` and collide.
- **`.agents/skills/` directories.** Root `.md` files in `~/.agents/skills/` and `.agents/skills/` are ignored—put each skill in its own subdirectory with `SKILL.md`. Inside subdirectories that lack a `SKILL.md`, other `.md` files with valid skill frontmatter also load.
- **Filtering and symlinks.** Non-skill Markdown files (such as `README.md` without skill frontmatter) are ignored silently. Scanning respects `.gitignore`, `.ignore`, and `.fdignore`, skips dotfiles, dot-directories, and `node_modules`, follows symlinks, skips broken symlinks, and deduplicates multiple symlinks pointing to the same real file. Passing a non-`.md` file to `--skill` emits a `"skill path is not a markdown file"` warning.

Disable default and bundled skill discovery with `--no-skills` (`-ns`). Skills from `-e` packages and explicit `--skill <path>` flags still load.

### Precedence

When multiple distinct skill files share the same name, bare `/skill:<name>` uses the first match: packages passed with `-e` win first, then project skills override global skills, both override configured and bundled packages, and explicit CLI `--skill` paths apply last. Pass `--no-skills` (`-ns`) if you want a `--skill` path to win bare `/skill:<name>` over an existing or bundled skill.

See [Resource precedence order](/packages/reference#resource-precedence-order) for the complete 8-level precedence list.

<div id="using-skills-from-other-harnesses" />

### Use skills from other tools

To reuse skills already stored for other coding agents, add their directories to `~/.atomic/agent/settings.json`:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level shared skill directories, add a relative path to `.atomic/settings.json` (legacy `.pi/settings.json` is also supported):

```json
{
  "skills": ["../.claude/skills"]
}
```

<Note>
To load, filter, or override skills programmatically from Node.js—or to remove the 21 bundled `@bastani/subagents` skills (`builtins: { subagents: false }`) or keep them without exposing the `subagent` tool (`excludedTools: ["subagent"]`)—see [SDK skills](/sdk/reference#skills).
</Note>

## How skills work

1. At startup, Atomic scans skill locations and reads each skill's name and description.
2. The system prompt includes available skills (excluding skills with `disable-model-invocation: true`) in XML format per the [Agent Skills integration specification](https://agentskills.io/integrate-skills).
3. When a task matches, the agent opens the skill's `skill://` address with `read` (or `bash` if `read` is disabled). Models do not always load a skill on their own, so prompt explicitly or run `/skill:name` when you want a specific skill used.
4. When a skill mentions a supporting file such as `references/guide.md`, the agent reads it via `skill://<name>/references/guide.md`.

Only skill descriptions stay in context by default; full instructions load on demand.

<Note>
If both `read` and `bash` tools are disabled (for example with `--no-tools` or `--tools edit,write`), Atomic omits the automatic `<available_skills>` list from the system prompt because the model has no tool to open `skill://` files. Manual `/skill:<name>` invocation still expands into your prompt.
</Note>

## Skill addresses

Every loaded skill gets a short `skill://<name>` address (such as `skill://tdd`). Naming the skill instead of its filesystem path keeps the system prompt short, keeps local home paths out of model context, and keeps sessions portable across machines.

### What the model sees

With `read` enabled and one skill installed, the system prompt includes:

```xml
The following skills provide specialized instructions for specific tasks.
When the task matches a skill's description, use the read tool on the skill's location, skill://<name>, to load it.
A file the skill references relative to its own directory is skill://<name>/<relative path>. Shell commands accept an unquoted skill:// URI in place of the file's path, for example to run a script the skill includes.

<available_skills>
  <skill>
    <name>tdd</name>
    <description>Test-driven development with a red-green-refactor loop.</description>
    <location>skill://tdd</location>
  </skill>
</available_skills>
```

When `read` is disabled and `bash` is active, the instruction tells the model to run `cat skill://<name>` instead.

### Reading a skill or files inside it

Use `skill://` addresses with `read`, `search`, and `find`:

| To get | Use |
| --- | --- |
| The skill's instructions (`SKILL.md`) | `skill://tdd` |
| Another file inside the skill folder | `skill://tdd/references/mocking.md` |
| A specific line range | `skill://tdd:10-40` or `skill://tdd/references/mocking.md:1-20` |
| Matching lines inside a skill | `search` in `skill://tdd` |
| Files in the skill folder | `find` with `skill://tdd/references/*.md` |

Reading a full skill begins with `Base directory for this skill: skill://tdd/`. Relative paths inside the instructions resolve against that folder.

### Running a skill's scripts

Shell commands accept an unquoted `skill://` address wherever a file path is expected. Atomic replaces the address with the file's real path before running the command:

```bash
bash skill://my-skill/scripts/check.sh
python3 skill://my-skill/scripts/report.py --summary
```

- Write the address as a separate unquoted word. Quoted strings (`"skill://..."`) stay literal.
- `bash` also expands `skill://` addresses inside its `cwd` and `env` arguments.
- If a `skill://<name>` name is not in the loaded skill catalog, Atomic falls back to `<cwd>/.agents/skills/<name>/...` and `<cwd>/packages/subagents/skills/<name>/...`. In `bash`, an address that still does not resolve passes through as literal text rather than erroring.

### Two skills with the same name

When only one file declares a name, its address is `skill://<name>`.

When two or more distinct files share a name (for example your own `tdd` skill alongside Atomic's bundled `tdd`), Atomic assigns source-qualified addresses such as `skill://tdd@user` and `skill://tdd@builtin`, matching the [`/skill:` commands](#skill-commands). The bare address `skill://tdd` still opens the precedence winner.

A qualified address must match exactly one skill. If two project directories both define `tdd`, `skill://tdd@project` is refused with the disambiguating addresses. Characters that would break a URI (such as `:`, `/`, or spaces) are percent-encoded (for example `skill://acme%3Adeploy`); the skill list always shows the ready-to-use address.

### Addresses are read-only

`skill://` is read-only. Atomic refuses to write or edit through it and rejects traversal paths that leave the skill folder (such as `skill://tdd/../other`). Containment is checked lexically, so symlinks that a skill author intentionally places inside the skill folder are followed. To modify a skill, edit its files on disk.

### Subagents and older sessions

Subagents receive their assigned skills with the same `skill://` addresses and resolve supporting files the same way. Older sessions that recorded absolute skill file paths remain readable when resumed.

### Skills as workflows

A `SKILL.md` file can define a repeatable procedure for the main chat to run with codemode and subagents—no separate workflow file is needed. State the inputs, step dependencies, verification checks, and stop conditions. Loading a skill does not enable extra tools or grant new permissions.

For example, a `review-guide` skill can instruct: *"Ask one child per platform to check the guide against the CLI. Wait for their results, verify flagged commands, then return a table of discrepancies without editing the guide."* Run it with `/skill:review-guide docs/install.md`. See [Orchestration](/orchestration) for how codemode scripts launch and resume children.

To migrate an older Atomic workflow file into a skill, run `/skill:workflow-files` or follow [Converting workflows to skills](/orchestration/migrating-workflows).

## Bundled skills

Atomic ships 22 bundled skills (21 from `@bastani/subagents` and `intercom` from `@bastani/intercom`). Skills marked **Explicit only** set `disable-model-invocation: true`, so they stay out of the automatic skill list and run only when you invoke `/skill:<name>`.

| Skill | Invocation | Purpose |
| --- | --- | --- |
| `agent-browser` | Auto or `/skill:agent-browser` | Automate Chrome, Chromium, Mobile Safari in iOS Simulator, Electron apps, and cloud browsers via `agent-browser` |
| `agent-desktop` | Auto or `/skill:agent-desktop` | Operate native macOS, Windows, and Linux desktop GUIs via `agent-desktop` |
| `bro` | Explicit only (`/skill:bro`) | Restate the last message in plain human language with no jargon |
| `create-spec` | Auto or `/skill:create-spec` | Draft a detailed implementation specification or PRD around codebase entrypoints |
| `feedback` | Auto or `/skill:feedback` | Draft, privacy-scrub, and post an Atomic bug report or enhancement via `gh` |
| `herdr` | Auto or `/skill:herdr` | Inspect or control Herdr panes, tabs, workspaces, and commands inside a Herdr pane |
| `how` | Auto or `/skill:how` | Walk through how a subsystem works, its runtime flow, and package ownership |
| `impeccable` | Auto or `/skill:impeccable` | Design, audit, polish, and harden frontend web and mobile interfaces |
| `intercom` | Auto or `/skill:intercom` | Coordinate messages and tasks across live Atomic sessions with Intercom |
| `liteparse` | Auto or `/skill:liteparse` | Extract text, tables, and data from PDF, Office documents, and images locally with `lit` |
| `prompt-engineer` | Auto or `/skill:prompt-engineer` | Write, evaluate, migrate, or troubleshoot prompts for GPT and Claude models |
| `qlty` | Auto or `/skill:qlty` | Run linting, formatting, complexity metrics, and code-smell checks with the `qlty` CLI |
| `research-codebase` | Auto or `/skill:research-codebase` | Document a codebase as-is into a research directory for historical context |
| `show-me` | Explicit only (`/skill:show-me`) | Explain the current topic visually with diagrams, code sketches, and focused HTML artifacts |
| `skill-creator` | Auto or `/skill:skill-creator` | Create, edit, benchmark, and optimize custom skills and their trigger descriptions |
| `subagent` | Auto or `/skill:subagent` (parent only) | Delegate focused work to built-in or custom subagents in single, parallel, or forked runs |
| `tdd` | Auto or `/skill:tdd` | Follow red-green-refactor test-driven development and audit existing test suites |
| `teach` | Explicit only (`/skill:teach`) | Combine `how` and `why` analysis to explain a change or subsystem plainly |
| `tmux` | Auto or `/skill:tmux` | Control `tmux` (or `psmux` on Windows) sessions, windows, and panes for interactive CLIs |
| `unslop` | Auto or `/skill:unslop` | Cut AI writing tells and filler from prose |
| `why` | Auto or `/skill:why` | Investigate design rationale, regressions, and tradeoffs across git, issues, docs, and MCPs |
| `workflow-files` | Auto or `/skill:workflow-files` | Convert an earlier Atomic workflow file into a reusable skill |

### Setup notes for specific bundled skills

| Skill | External prerequisites and notes |
| --- | --- |
| `qlty` | Install the `qlty` CLI separately (`curl https://qlty.sh \| sh` on macOS/Linux, or `powershell -c "iwr https://qlty.sh \| iex"` on Windows) and keep `~/.qlty/bin` on `PATH`. Run `qlty init` per repository. `qlty metrics` and `qlty smells` run offline; `qlty check` and `qlty fmt` need network access on first use to download plugins. |
| `liteparse` | Requires Node.js 18+ and `@llamaindex/liteparse` (`npm i -g @llamaindex/liteparse`), plus LibreOffice for Office files, ImageMagick for images, and `uv` for local search helpers. |
| `agent-browser`, `agent-desktop`, `herdr`, `tmux` | See [Computer use](/computer-use) for install commands, readiness checks, coverage limits, and safety rules. `agent-desktop` leaves OS accessibility permissions to you (`agent-desktop permissions --guide` on macOS). `herdr` runs only inside a Herdr-managed pane (`HERDR_ENV=1`) when explicitly requested. |
| `feedback` | Run `/skill:feedback <summary>` to draft a bug report (runs a debugger pass) or enhancement (no subagent) and review the privacy-scrubbed Markdown before posting via your authenticated `gh` CLI login. Redaction strips recognized tokens, keys, emails, and home paths, though custom secrets or business details may remain and content already sent to your model provider cannot be undone. |
| `skill-creator` | Evaluates skill trigger descriptions in isolated non-interactive `atomic -p` runs (pass `--model provider/id` to test a specific model) and generates a browser review viewer. On Windows, configure an API key or non-interactive credential because evaluation runs cannot accept interactive login prompts. |
| `prompt-engineer` | Loads only the guide for your target GPT or Claude model (or both for migrations, for example `/skill:prompt-engineer Improve this prompt for Claude: ...`). |

## Skill commands

Every loaded skill registers a `/skill:name` slash command:

```text
/skill:brave-search           # Load and run the skill
/skill:pdf-tools extract      # Load the skill with extra instructions
```

When multiple distinct skill files share the same name, bare `/skill:name` runs the precedence winner and Atomic adds source-qualified commands for each candidate:

```text
/skill:review                 # Current precedence winner
/skill:review@project         # Project candidate
/skill:review@user            # User candidate
/skill:review@builtin         # Bundled candidate
```

Source-qualified aliases exist only while a name collision exists—if only one skill defines `tdd`, `/skill:tdd` exists and `/skill:tdd@builtin` does not. Aliases recalculate on `/reload`.

- **Qualified selection is exact.** An unknown or ambiguous qualified selector (such as `/skill:review@missing`) reports an error and never falls back to the bare winner. The original `/skill:...` text is left unexpanded and sent verbatim to the model.
- **Subagent overrides.** Subagent definitions and per-call `skills` overrides accept the same selectors and resolve them against the child's own loaded skills (reporting missing or ambiguous selectors in the child result). The parent-only `subagent` skill cannot be injected into a child, even via `subagent@builtin`.
- **Technical format.** See [Collision qualifiers and expansion](/skills/reference#collision-qualifiers-and-expansion) for the full tie-breaking qualifier rules, the `<skill>` XML wrapper format, and programmatic inspection from extensions and RPC.

Toggle `/skill:` autocomplete suggestions in `/settings` or [`settings.json`](/settings) (default `true`):

```json
{
  "enableSkillCommands": true
}
```

Setting `enableSkillCommands` to `false` hides `/skill:` suggestions from autocomplete only; manually typed `/skill:<name>` commands still expand in both the main chat and subagent views.

### Skills while viewing a subagent

When you select a subagent from the agent panel or `/tasks`, `/skill:` suggestions, `@`/`Tab` path completions, and `/skill:<selector>` expansion use that subagent's own skills and working directory (finished subagents keep the skills and directory they had when they ended).

- `Enter` starts a turn when idle or steers a streaming turn; `app.message.followUp` (`Alt+Enter`, or `Ctrl+Q` on Windows and WSL) queues the expanded skill as a follow-up.
- Unknown bare selectors pass through as plain text; unknown or ambiguous qualified selectors and file-read errors display diagnostics under the subagent transcript without falling back to another skill.
- If a skill command was queued while the session was paused, restore it to the editor and submit again after resuming so it expands.
- Inside an interactive dialog or custom UI prompt, text starting with `/skill:` is treated as plain text. Skills never grant extra tools, workspace access, or permission to start subagents.

## Skill repositories

- [Anthropic Skills](https://github.com/anthropics/skills) — document processing (`docx`, `pdf`, `pptx`, `xlsx`) and web development examples compatible with the Agent Skills standard.
