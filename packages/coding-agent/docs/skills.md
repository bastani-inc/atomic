---
title: "Use and organize skills"
sidebarTitle: "Skills"
description: "Install, discover, and invoke reusable Agent Skills instructions, scripts, and reference documents in Atomic."
---

Skills are self-contained packages of instructions that the agent loads on demand. A skill can provide specialized procedures, setup instructions, helper scripts, and reference documentation for specific tasks.

Atomic implements the [Agent Skills standard](https://agentskills.io/specification), warning about validation issues while still loading valid skills leniently.

## Where to go next

Read this page to install, organize, and invoke skills, then continue:

- [Write a custom skill](/skills/authoring). Learn the directory structure and follow a complete worked example.
- [Skill format reference](/skills/reference). Check `SKILL.md` frontmatter fields, naming rules, and validation behavior.
- [SDK skills reference](/sdk/reference#skills). Load or override skills programmatically from `@bastani/atomic`.

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

Run `/reload` in an active session, then invoke `/skill:my-skill`. See [Write a custom skill](/skills/authoring) for directory layout, scripts, and reference files.

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code that the model invokes. Review skill content before use.
>
> Read [Security](/security) for the project-trust boundary that governs which project skills load.

Atomic loads skills from these sources:

- **Global directories:**
  - `~/.atomic/agent/skills/` (legacy `~/.pi/agent/skills/`)
  - `~/.agents/skills/`
- **Project directories** (only after you trust the project):
  - `.atomic/skills/` (legacy `.pi/skills/`)
  - `.agents/skills/` in `cwd` and ancestor directories up to the Git repository root, or the filesystem root when outside a repository
- **Packages:** `skills/` directories, `atomic.skills`, or legacy `pi.skills` entries in `package.json`
- **Settings:** `skills` array in global or project [`settings.json`](/settings), which accepts files, directories, and filter patterns (`!glob`, `+path`, `-path` with `~` expansion; see [Package filtering](/packages/reference#package-filtering))
- **CLI:** `--skill <path>` (repeatable; still loads even with `--no-skills` / `-ns`; see [CLI resource options](/reference/cli#resource-options))

### Discovery rules

- In `~/.atomic/agent/skills/` and `.atomic/skills/` (plus legacy `~/.pi/agent/skills/` and `.pi/skills/`), direct root `.md` files are discovered as individual skills when they have valid frontmatter with a non-empty `description`. Always set `name:` in frontmatter for standalone root `.md` files; otherwise they default to the parent directory name (`skills`) and collide with each other.
- In all skill locations, directories containing `SKILL.md` are discovered recursively. Once a directory contains `SKILL.md`, Atomic treats it as a skill root and does not recurse deeper into it.
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored. Place each skill in its own subdirectory containing `SKILL.md`.
- Non-skill Markdown files (such as `README.md` without skill frontmatter) are ignored silently.
- Scanning respects `.gitignore`, `.ignore`, and `.fdignore` files inside scanned directories, and automatically skips dotfiles, dot-directories, and `node_modules`.
- Symlinks are followed for both files and directories. Broken symlinks are skipped silently, and multiple symlinks pointing to the same real file are deduplicated silently.

Disable default and bundled skill discovery with `--no-skills` (short flag `-ns`). Skills from `-e` packages and explicit `--skill <path>` flags still load.

### Precedence order

When multiple distinct skill files declare the same name, bare `/skill:<name>` uses the first match in this order:

1. Packages passed with `-e` / `--extension`
2. Project `settings.json` `skills` array
3. Project auto-discovered directories (`.atomic/skills/`, then legacy `.pi/skills/`, then `.agents/skills/` walking up from `cwd` to the repository root, closest directory first)
4. Global `settings.json` `skills` array
5. Global auto-discovered directories (`~/.atomic/agent/skills/`, then legacy `~/.pi/agent/skills/`, then `~/.agents/skills/`)
6. Configured packages (project packages, then global packages)
7. Bundled packages (`@bastani/subagents`, `@bastani/intercom`)
8. Explicit CLI `--skill <path>` paths

Because explicit `--skill <path>` paths come last, pass `--no-skills` (`-ns`) if you want a CLI `--skill` file to win bare `/skill:<name>` over an existing or bundled skill with the same name.

<div id="using-skills-from-other-harnesses" />

### Using skills from other tools

To load skills stored in existing user directories, add their paths to `~/.atomic/agent/settings.json`:

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

### Using skills from the SDK

Configure skill discovery programmatically with `DefaultResourceLoader` and pass it to `createAgentSession()`:

```typescript
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";

const loader = new DefaultResourceLoader({
  additionalSkillPaths: ["/path/to/extra-skills"],
  noSkills: false,
  skillsOverride: (current) => ({
    skills: current.skills.filter((skill) => skill.name !== "unwanted"),
    diagnostics: current.diagnostics,
  }),
});
await loader.reload();

const { session } = await createAgentSession({ resourceLoader: loader });
```

Setting `builtins: { subagents: false }` on `createAgentSession()` removes the 21 bundled skills shipped by `@bastani/subagents`. Keep those 21 skills without exposing the `subagent` tool by leaving `builtins.subagents` enabled and passing `excludedTools: ["subagent"]`. See [SDK skills](/sdk/reference#skills) and [SDK tools](/sdk/reference#tools).

## How skills work

1. At startup, Atomic scans skill locations and reads each skill's name and description.
2. The system prompt includes available skills (except those with `disable-model-invocation: true`) in XML format per the [Agent Skills integration specification](https://agentskills.io/integrate-skills).
3. When a task matches, the agent uses `read` (or `bash` when `read` is unavailable) to load the skill from its `skill://` address. Models do not always load a skill automatically, so use explicit prompting or `/skill:name` to force it.
4. The agent follows the instructions. When they mention another file in the skill's folder, such as `references/guide.md`, the agent opens it as `skill://<name>/references/guide.md`.

This is progressive disclosure. Only descriptions stay in context by default, and full instructions load on demand.

## Skill addresses

Every loaded skill has a short address that starts with `skill://` followed by the skill's name, such as `skill://tdd`. The address names the skill, not the folder it is stored in. That has three benefits:

- The skill list in the model's instructions stays short.
- Your home folder and other private paths stay out of the model's instructions.
- The address keeps working if you move a skill or resume a session on another computer.

### What the model sees

The model's instructions list each skill by name, description, and address. With one skill installed, that part of the instructions reads:

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

Earlier versions gave the full file path, such as `/Users/you/.atomic/agent/skills/tdd/SKILL.md`, in place of `skill://tdd`.

### Reading a skill, a file inside it, or a few lines

The agent, or you in a prompt, can use these addresses with the `read`, `search`, and `find` tools:

| To get | Use |
| --- | --- |
| The skill's instructions (its `SKILL.md`) | `skill://tdd` |
| Another file in the skill's folder | `skill://tdd/references/mocking.md` |
| A few lines of either | `skill://tdd:10-40` or `skill://tdd/references/mocking.md:1-20` |
| Lines that mention a word | `search` for the word in `skill://tdd` |
| Files in the skill's folder | `find` with `skill://tdd/references/*.md` |

When the agent reads a whole skill, the result begins with `Base directory for this skill: skill://tdd/`. Paths in the skill's instructions are relative to that folder.

### Running a skill's scripts

Shell commands can use an address in place of a file path. Before the command runs, Atomic swaps each address for the file's real path:

```bash
bash skill://my-skill/scripts/check.sh
python3 skill://my-skill/scripts/report.py --summary
```

Write the address as a separate word, not inside quotes. Quoted text is passed to the shell as typed.

### Two skills with the same name

If only one skill uses a name, its address is `skill://<name>`.

Two skills can share a name. For example, you might have your own `tdd` skill while Atomic also ships one. In that case, the model's skill list shows each skill under a longer name with its source after an `@`, such as `tdd@user` and `tdd@builtin`. Their addresses are `skill://tdd@user` and `skill://tdd@builtin`. These are the same names the [`/skill:` commands](#skill-commands) use.

The short address `skill://tdd` still works. It opens the skill that wins under the [precedence order](#precedence-order).

A longer name must match exactly one skill. Suppose two project folders each have a `tdd` skill. Then `skill://tdd@project` could mean either, so Atomic refuses it and lists the addresses that tell them apart.

Some characters, such as a slash, a colon, or a space, would break an address. In a skill's name, Atomic writes them as percent codes, the way web addresses do. A skill named `acme:deploy` has the address `skill://acme%3Adeploy`. The skill list always shows the ready-to-use address.

### Addresses are read-only

A `skill://` address is only for reading. Atomic won't write or edit through it, and it refuses an address that leads outside the skill's folder, such as `skill://tdd/../other`. To change a skill, edit its files where they are stored.

### Subagents and older sessions

A subagent given a skill receives the skill's instructions together with its address. It opens the skill's other files the same way.

Sessions recorded by earlier versions list skills by their full file path. Those paths keep working when you resume such a session.

### Skills as workflows

A `SKILL.md` file can describe a procedure for the parent chat to carry out with codemode and subagents. No separate workflow file is needed. State the inputs, which steps depend on others, how to check the result, and when to stop. Loading a skill does not enable tools or grant permission for actions.

For example, a `review-guide` skill might say: "Ask one child per platform to check the guide against the CLI. Wait for their results, verify the commands they flag, then return a table of discrepancies. Do not edit the guide." Invoke it as `/skill:review-guide docs/install.md`. See [Orchestration](/orchestration) for the corresponding script and how work continues after a child finishes.

To migrate an earlier Atomic workflow file into a skill, invoke `/skill:workflow-files`. See [Converting workflows to skills](/orchestration/migrating-workflows) for the migration rules.

## Bundled skills

Atomic ships 22 bundled skills (21 from `@bastani/subagents` and `intercom` from `@bastani/intercom`). Skills marked **Explicit only** set `disable-model-invocation: true`, so they stay out of the model's automatic skill list and run only when you invoke `/skill:<name>`.

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

- **`skill-creator`:** Description-optimization and trigger-evaluation scripts run each query in a separate `atomic -p` subprocess with `--no-session --no-extensions --no-mcp --no-prompt-templates`. Pass `--model provider/id` (optionally with `:<thinking>`) to test against a specific model. An HTML review viewer (`eval-viewer/generate_review.py`) lets you inspect outputs and benchmark scores in a browser. On Windows, each evaluation runs in a hidden console that cannot accept interactive keyboard input, so configure an API key, environment variable, or non-interactive credential command.
- **`prompt-engineer`:** Uses a compact routing file pointing to separate model guides for current GPT and Claude models plus shared references on structure, tools, evaluation, and instruction audits. Load only the target model's guide, or both guides for a migration (for example, `/skill:prompt-engineer Improve this prompt for GPT-6.2 Sol: ...`). Use explicit output schemas and tools rather than response prefilling, and ask for observed evidence rather than reconstructed private reasoning.
- **`qlty`:** The `qlty` CLI is not bundled. Install it with `curl https://qlty.sh | sh` on macOS or Linux, or `powershell -c "iwr https://qlty.sh | iex"` on Windows, and keep `~/.qlty/bin` on `PATH`. Run `qlty init` to create `.qlty/qlty.toml`. Offline, `qlty metrics` and `qlty smells` run locally; `qlty check` and `qlty fmt` need network access on first use per repository to download plugins and runtimes.
- **`agent-browser`, `agent-desktop`, `herdr`, and `tmux`:** See [Computer use](/computer-use#desktop-automation-with-agent-desktop), [what agent-browser covers](/computer-use#what-agent-browser-covers), [coverage limits](/computer-use#coverage-and-limits), and [desktop safety](/computer-use#stay-safe) for installation, readiness checks, and workflow guidance. `agent-desktop` does not install its own executable and leaves OS permission prompts to you (on macOS, it opens `agent-desktop permissions --guide`). `herdr` requires an explicit Herdr request and `HERDR_ENV=1`, and stops outside a Herdr-managed pane.
- **`liteparse`:** Requires Node 18+ and `@llamaindex/liteparse` (`npm i -g @llamaindex/liteparse`), plus LibreOffice for Office files, ImageMagick for images, and `uv` for its bundled `search.py` helper.
- **`feedback`:** Run `/skill:feedback <what happened or what you want to change>` to draft an Atomic bug report or enhancement. Bugs run one debugger investigation; enhancements launch no subagent. Review the Markdown draft and its `Privacy scrubbed:` summary before asking Atomic to post it via your authenticated `gh` CLI login to `bastani-inc/atomic`. Scrubbing redacts recognized tokens, credentials, private keys, email addresses, and home paths, though custom secrets or business context may still appear and anything already sent to your model provider cannot be removed.

## Skill commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

When multiple distinct real skill files declare the same name, Atomic keeps the precedence winner for `/skill:name` and creates source-qualified commands for each distinct file:

```bash
/skill:review                  # Current precedence winner
/skill:review@project          # Unique project candidate
/skill:review@user             # Unique user candidate
/skill:review@builtin          # Unique bundled candidate
```

Source-qualified aliases exist only when two or more distinct files share the same skill name. If only one file defines `tdd`, `/skill:tdd` exists and `/skill:tdd@builtin` does not.

When a single family (`project`, `user`, or `builtin`) has multiple colliding candidates, Atomic qualifies them by package name (npm package name without leading `@`, or git `owner/repo`), then by the shortest unique parent directory suffix, and finally by `<family>-<8-hex-hash>` if paths still collide. If a qualifier collides across families, Atomic prefixes `<family>/<qualifier>`. Autocomplete, `atomic.getCommands()`, and RPC `get_commands` return the same advertised names.

Qualified selection is exact. An unknown or ambiguous qualified selector reports an error and never falls back to the bare winner. Aliases are recalculated on `/reload`, so a qualified alias disappears once its collision disappears. The model-visible skill list uses the same aliases.

Subagent definitions and per-call `skills` overrides accept these same selectors. Running subagents resolve them from their own loaded skill list; a missing or ambiguous selector is reported in the child result instead of falling back to the bare skill. The parent-only `subagent` orchestration skill cannot be injected into a child, including qualified aliases such as `subagent@builtin`. Extensions can read the same catalog through `ctx.getSkillCatalog()`.

When expanded, Atomic wraps the skill body in a `<skill>` block recording the selector, the skill's [address](#skill-addresses), a candidate ID, and the folder that relative references start from:

```xml
<skill name="brave-search" location="skill://brave-search" candidate="skill_0123456789abcdef0123">
References are relative to skill://brave-search/.

...skill instructions...
</skill>
```

Any arguments after the command are trimmed and appended after the closing `</skill>` tag separated by a blank line, without a `User:` prefix.

Toggle `/skill:` autocomplete suggestions via `/settings` in interactive mode or in [`settings.json`](/settings) (default `true`):

```json
{
  "enableSkillCommands": true
}
```

Setting `enableSkillCommands` to `false` only hides `/skill:` suggestions from autocomplete. Manually typed `/skill:<name>` commands still expand in both the main session and subagent views.

### Skills while viewing a subagent

Select a subagent from the agent panel or `/tasks` to view it on the chat screen. Its `/skill:` suggestions and path completions (`@` and `Tab`) use the subagent's own skills and working directory. A finished subagent keeps the skills and directory it had when it finished.

A `/skill:<selector>` command typed while viewing a subagent expands from its own skills. `Enter` starts a turn when idle or steers a streaming turn, and `app.message.followUp` (`Alt+Enter`, or `Ctrl+Q` on Windows and WSL) queues it as a follow-up. Skill-relative references resolve against the skill directory, while ordinary tools keep the subagent's working directory.

Unknown bare selectors pass through as plain text. Unknown or ambiguous qualified selectors and file-read failures show diagnostics under the subagent's transcript without selecting another skill.

If a skill command is queued while the session is paused, it may remain literal text after resume. Restore it to the editor and submit again after resuming to invoke the skill. When an interactive dialog or custom UI prompt is open, text starting with `/skill:` is treated as plain text. Skills do not grant extra tools, workspace access, or permission to start subagents.

## Skill repositories

- [Anthropic Skills](https://github.com/anthropics/skills). Document processing (`docx`, `pdf`, `pptx`, `xlsx`) and web development examples.

## Moved sections

<div id="frontmatter" />

- Skill directory structure, `SKILL.md` format, and a worked example moved to [Write a custom skill](/skills/authoring).
- Frontmatter fields, name rules, description best practices, and validation rules moved to [Skill format reference](/skills/reference).
