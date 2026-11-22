---
title: Skills
description: Load on-demand Agent Skills instructions, helper scripts, and reference documents in Atomic sessions.
---

# Skills

Skills are self-contained packages of instructions that the agent loads on demand. A skill can provide specialized procedures, setup instructions, helper scripts, and reference documentation for specific tasks.

Atomic implements the [Agent Skills standard](https://agentskills.io/specification), warning about validation issues while still loading skills leniently.

## Where to go next

Read this page to install and use skills, then continue:

- [Writing skills](/skills/authoring). Learn the directory structure and follow a complete worked example.
- [Skill reference](/skills/reference). Check `SKILL.md` frontmatter fields and validation rules.

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code that the model invokes. Review skill content before use.
>
> Read [Security](/security) for the project-trust boundary that governs which project skills load.

Atomic loads skills from:

- Global:
  - `~/.atomic/agent/skills/` (legacy `~/.pi/agent/skills/`)
  - `~/.agents/skills/`
- Project (only after the project is trusted):
  - `.atomic/skills/` (legacy `.pi/skills/`)
  - `.agents/skills/` in `cwd` and ancestor directories up to the Git repository root, or the filesystem root when outside a repository
- Packages: `skills/` directories, `atomic.skills`, or legacy `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:

- In `~/.atomic/agent/skills/` and `.atomic/skills/` (plus legacy `~/.pi/agent/skills/` and `.pi/skills/`), direct root `.md` files are discovered as individual skills when they have valid skill frontmatter with a non-empty `description`.
- In all skill locations, directories containing `SKILL.md` are discovered recursively. Once a directory contains `SKILL.md`, Atomic treats it as a skill root and does not recurse deeper into it.
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored.
- Root Markdown files other than `SKILL.md` that do not look like skills are ignored silently.

Disable default discovery with `--no-skills`. Explicit `--skill` paths still load.

<a id="using-skills-from-other-harnesses" />

### Using skills from other tools

To load skills stored in existing user directories, add their paths to `settings.json`:

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

## How skills work

1. At startup, Atomic scans skill locations and reads each skill's name and description.
2. The system prompt includes available skills in XML format per the [Agent Skills integration specification](https://agentskills.io/integrate-skills).
3. When a task matches, the agent uses `read` (or `bash` when `read` is unavailable) to load the full `SKILL.md`. Models do not always load a skill automatically, so use explicit prompting or `/skill:name` to force it.
4. The agent follows the instructions and resolves relative paths against the skill's directory.

This is progressive disclosure. Only descriptions stay in context by default, and full instructions load on demand.

### Skills as workflows

A `SKILL.md` file can describe a procedure for the parent chat to carry out with codemode and subagents. No workflow definition is needed. State the inputs, which steps depend on others, how to check the result, and when to stop. Loading a skill does not enable tools or grant permission for actions.

For example, a `review-guide` skill might say: "Ask one child per platform to check the guide against the CLI. Wait for their results, verify the commands they flag, then return a table of discrepancies. Do not edit the guide." Invoke it as `/skill:review-guide docs/install.md`. See [Orchestration](/orchestration) for the corresponding script and how work continues after a child finishes.

To migrate an earlier Atomic workflow file into a skill, invoke `/skill:workflow-files`. See [Converting workflows to skills](/orchestration/migrating-workflows) for the migration rules.

### Creating and evaluating skills

Use `/skill:skill-creator` to draft a new skill, improve an existing one, run test cases, or optimize a skill's description for triggering accuracy.

Its description-optimization and trigger-evaluation scripts run each query in an isolated `atomic -p` child with `--no-session --no-extensions --no-mcp --no-prompt-templates`. Pass `--model provider/id` (optionally with `:<thinking>`) to test against a specific model. The skill also includes an HTML review viewer (`eval-viewer/generate_review.py`) so you can inspect qualitative outputs and benchmark scores in a browser between iterations.

On Windows, each evaluation query runs `atomic -p` in a hidden console that cannot accept interactive keyboard input. Give the evaluation model an API key, an environment variable, or a credential command that reads a cached token without prompting.

### Built-in prompt engineering guidance

The bundled `/skill:prompt-engineer` creates, optimizes, evaluates, and troubleshoots prompts for GPT and Claude models. Its small routing file points to separate, source-attributed guides for GPT-6.2 Astra and Sol, GPT-6.1 Sol, GPT-6.1 Terra, GPT-6 Astra and Luna, GPT-5.6, GPT-5.5, Claude Fable 5.2, Claude Fable 5.1, Claude Fable 5, Claude Opus 5.5, Claude Opus 5, Claude Opus 4.8, Claude Sonnet 5.5, Claude Sonnet 5, and Claude Haiku 5.5.

Read only the target model's page, or both pages for a migration, rather than loading every guide. Shared references cover prompt structure, tools, evaluation, and instruction audits. Model defaults, effort, verification, and API compatibility stay in their own pages. For example, run `/skill:prompt-engineer Improve this prompt for GPT-6.2 Sol: ...`.

Each model guide pairs an observed behavior with a prompt adjustment, example wording, and caveats. Choose the patterns that address your task instead of copying the whole guide. Compatibility notes explain when a prompt also needs provider or application support.

Astra guidance distills [OpenAI's model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) into completion and permission rules, proportionate verification, useful parallel delegation, concise writing, and API migration checks. An instruction audit based on OpenAI's [Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) explains how to shorten skill descriptions, use small routing files with optional references, remove obsolete recipes, and define safe local work and stopping points.

Opus 5.5 guidance covers its always-on thinking and medium-effort API default, progress updates returned in thinking blocks, bounded continuations for unattended work, and pasted-content boundaries. Sonnet 5.5 guidance covers recalibrated effort levels, coding runs that check in early or add unrequested files, progress notes hidden by default, searching instead of answering from memory, checks before reporting code done, and mid-turn user message placement.

The skill no longer recommends response prefilling, which returns an error on Claude 4.6 and later, or visible chain-of-thought as a primary technique. Use explicit output instructions, schemas, tools, or post-processing instead of prefilling. Request conclusions, citations, commands, and observed results rather than reconstructed private reasoning, which can trigger Claude Fable 5's `reasoning_extraction` safeguard and force a model fallback.

### Built-in visual explanation guidance

The bundled `/skill:show-me` from [HumanLayer](https://github.com/humanlayer/skills) explains the current topic visually with concise diagrams, code-shape sketches, and focused HTML artifacts. It runs only when you type `/skill:show-me`; the model does not load it on its own. It is distributed under the MIT License.

### Built-in code quality guidance

The bundled `/skill:qlty` uses the [qlty](https://qlty.sh) CLI for code-quality verification across 70+ linters, auto-formatters, and security scanners in 40+ languages:

- `qlty check` runs linters.
- `qlty fmt` formats code.
- `qlty metrics` measures complexity, lines, and cohesion.
- `qlty smells` finds duplication, deep nesting, and overly complex code.

The skill triggers on requests for verifiers or high code quality and prefers one CLI over ad-hoc linter commands. It directs the agent to [docs.qlty.sh/llms.txt](https://docs.qlty.sh/llms.txt) and enables plugins and linter extensions that fit the codebase before checking.

The CLI is not bundled. Install it with `curl https://qlty.sh | sh` on macOS or Linux, or `powershell -c "iwr https://qlty.sh | iex"` on Windows, and keep `~/.qlty/bin` on `PATH`. Running `qlty init` writes `.qlty/qlty.toml` into the repository. Offline, `qlty metrics` and `qlty smells` work through built-in static analysis; `qlty check` and `qlty fmt` need network access on first use per repository to download plugins and runtimes.

### Built-in computer-use and automation guidance

Use `/skill:agent-browser` for web apps in Chrome or Chromium, Mobile Safari in the iOS Simulator, and CDP-enabled desktop apps. Use `/skill:agent-desktop` for native desktop apps, OS dialogs, menus, and non-Chromium browsers. For terminal automation, use `/skill:herdr` on macOS, Linux, and Windows, or fall back to `/skill:tmux` when Herdr is unavailable. See [Computer use](/computer-use#desktop-automation-with-agent-desktop), [what agent-browser covers](/computer-use#what-agent-browser-covers), [coverage limits](/computer-use#coverage-and-limits), and [desktop safety](/computer-use#stay-safe) for installation, readiness checks, and workflow guidance.

The bundled [agent-desktop skill](https://github.com/vercel-labs/agent-desktop/tree/v1.3.1/skills/agent-desktop) is Apache-2.0 licensed. Detailed guides and references ship inside the CLI via `agent-desktop skills get desktop` and `agent-desktop skills get platform`. The skill does not install the `agent-desktop` executable, and permission prompts stay with you. On macOS, the agent opens `agent-desktop permissions --guide` for you to approve.

The bundled [Herdr skill](https://github.com/herdrdev/herdr/blob/v0.9.5/skills/herdr/SKILL.md) requires an explicit Herdr request and `HERDR_ENV=1`. It stops outside a Herdr-managed pane and does not install Herdr or touch unrelated panes.

### Report feedback

Use `/skill:feedback <what happened or what you want to change>` to draft an Atomic bug report or enhancement. For a bug, the skill runs one debugger investigation and waits for its result. For an enhancement, it launches no subagent. It summarizes findings and unknowns rather than attaching files or transcripts.

Review the Markdown draft and its `Privacy scrubbed:` summary. Ask for changes to get a revised, re-scrubbed draft, or tell Atomic to post it. An unrelated reply continues the conversation without creating an issue. Posting uses your own authenticated `gh` CLI login to create an issue in `bastani-inc/atomic`. If posting fails, Atomic reports the error and keeps the draft in the conversation.

The scrubber replaces recognized API tokens, bearer credentials, credential assignments, URL credentials, private keys, and email addresses with `[REDACTED]`, and replaces home-directory prefixes with `~`. Review before posting because arbitrary secrets, sensitive business context, or secret text inside Markdown links may remain. Blank lines and Markdown headings stop multiline credential matching. Scrubbing cannot remove information already sent to your model provider.

## Skill commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

When multiple real skill files declare the same name, Atomic keeps the precedence winner for the bare command and retains every distinct file as an exact candidate. Use a source-qualified command to select one explicitly:

```bash
/skill:review                  # Current precedence winner
/skill:review@project          # Unique project candidate
/skill:review@user             # Unique user candidate
/skill:review@builtin          # Unique bundled candidate
```

`@project`, `@user`, and `@builtin` are available only when that family has one candidate in the collision. If a family contains multiple package candidates, Atomic advertises package-qualified aliases instead, such as `/skill:review@team-review` and `/skill:review@company-review`. Autocomplete, `atomic.getCommands()`, and RPC `get_commands` return the same advertised names.

Qualified selection is exact. An unknown or ambiguous qualified selector reports an error and never falls back to the bare winner. Aliases are recalculated on reload, so a qualified alias disappears when its collision disappears. The model-visible skill list uses the same aliases.

Subagent definitions and per-call `skills` overrides accept these same selectors. Live in-process children resolve them from their own loader catalog after resource reload; a missing or ambiguous selector is reported in the child result instead of silently selecting the bare skill. The parent-only `subagent` orchestration skill cannot be injected into a child, including qualified aliases such as `subagent@builtin`. Extensions can read the same catalog through `ctx.getSkillCatalog()`.

Arguments after the command are trimmed and appended after the expanded skill block without a `User:` prefix. The block records the selected skill's file location, candidate identity, and base directory for relative references.

Toggle skill command autocomplete via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

### Skills while viewing a subagent

Select a subagent from the agent panel or `/tasks` to view it on the chat screen. Its `/skill:` suggestions and path completions (`@` and `Tab`) use the subagent's own skills and working directory. A finished subagent keeps the skills and directory it had when it finished.

A `/skill:<selector>` command typed while viewing a subagent expands from its own skills. Enter starts a turn when idle or steers a streaming turn, and `app.message.followUp` (`Alt+Enter`, or `Ctrl+Q` on Windows and WSL) queues it as a follow-up. Skill-relative references resolve against the skill directory, while ordinary tools keep the subagent's working directory. Turning off `enableSkillCommands` hides suggestions but does not disable manually typed skill commands.

Unknown bare selectors pass through as text. Unknown or ambiguous qualified selectors and file-read failures show diagnostics under the subagent's transcript without selecting another skill.

If a skill command is queued while the session is paused, it may remain literal text after resume. Restore it to the editor and submit again after resuming to invoke the skill. Mounted human-input and custom prompts own their input, so answers starting with `/skill:` remain literal. Skills do not grant additional tools, workspace access, or permission to start subagents.

## Skill repositories

- [Anthropic Skills](https://github.com/anthropics/skills). Document processing (`docx`, `pdf`, `pptx`, `xlsx`) and web development examples.

## Moved sections

<a id="skill-structure" />
<a id="skill-md-format" />
<a id="example" />

- Skill directory structure, `SKILL.md` format, and a worked example moved to [Writing skills](/skills/authoring).

<a id="frontmatter" />
<a id="name-rules" />
<a id="description-best-practices" />
<a id="validation" />

- Frontmatter fields, name rules, description best practices, and validation rules moved to [Skill reference](/skills/reference).
