> Atomic can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Atomic implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient.

## Where to go next

Read this page to install and use skills, then continue:

- [Writing skills](/skills/authoring) — directory structure and a complete worked example.
- [Skill reference](/skills/reference) — `SKILL.md` frontmatter fields and validation rules.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Skill Structure](/skills/authoring#skill-structure)
- [Frontmatter](/skills/reference#frontmatter)
- [Validation](/skills/reference#validation)
- [Example](/skills/authoring#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.
>
> Read [Security](/security) for the project-trust boundary that governs which skills load at all.

Atomic loads skills from:

- Global:
  - `~/.atomic/agent/skills/` (legacy `~/.pi/agent/skills/`)
  - `~/.agents/skills/`
- Project (only after the project is trusted):
  - `.atomic/skills/` (legacy `.pi/skills/`)
  - `.agents/skills/` in `cwd` and ancestor directories (up to git repo root, or filesystem root when not in a repo)
- Packages: `skills/` directories, `atomic.skills`, or legacy `pi.skills` entries in `package.json`
- Settings: `skills` array with files or directories
- CLI: `--skill <path>` (repeatable, additive even with `--no-skills`)

Discovery rules:
- In `~/.atomic/agent/skills/` and `.atomic/skills/` (plus legacy `~/.pi/agent/skills/` and `.pi/skills/`), direct root `.md` files are discovered as individual skills when they have valid skill frontmatter with a non-empty `description`
- In all skill locations, directories containing `SKILL.md` are discovered recursively
- In `~/.agents/skills/` and project `.agents/skills/`, root `.md` files are ignored
- Root Markdown files other than `SKILL.md` that do not look like skills are ignored silently

Disable discovery with `--no-skills` (explicit `--skill` paths still load).

### Using Skills from Other Harnesses

To use skills from Claude Code or OpenAI Codex, add their directories to settings:

```json
{
  "skills": [
    "~/.claude/skills",
    "~/.codex/skills"
  ]
}
```

For project-level Claude Code skills, add to `.atomic/settings.json` (legacy `.pi/settings.json` is also supported):

```json
{
  "skills": ["../.claude/skills"]
}
```

## How Skills Work

1. At startup, Atomic scans skill locations and extracts names and descriptions
2. The system prompt includes available skills in XML format per the [specification](https://agentskills.io/integrate-skills)
3. When a task matches, the agent uses `read`, or `bash` when `read` is unavailable, to load the full SKILL.md (models don't always do this; use prompting or `/skill:name` to force it)
4. The agent follows the instructions, using relative paths to reference scripts and assets

This is progressive disclosure: only descriptions are always in context, full instructions load on-demand.

### Built-in prompt engineering guidance

The bundled `/skill:prompt-engineer` creates, optimizes, evaluates, and troubleshoots prompts for GPT and Claude models. Its small routing file points to separate, source-attributed guides for GPT-6 Astra, GPT-5.6, GPT-5.5, Claude Fable 5.1, Claude Fable 5, Claude Opus 5, Claude Opus 4.8, and Claude Sonnet 5. Read the target model's page, or both relevant pages for a migration, without loading every guide. Shared references cover prompt structure, tools, evaluation, and instruction audits; model defaults, effort, verification, and API compatibility stay in their own pages.

Astra guidance distills [OpenAI's model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra) into completion and permission rules, proportionate verification, useful parallel delegation, concise writing, and API migration checks. An instruction audit based on [Eric Provencher's advice](https://x.com/pvncher/status/2095991462416490862) explains how to shorten skill descriptions, use small routing files with optional references, remove obsolete recipes, and define safe local work and stopping points. It preserves binding repository requirements and separates API features from capabilities actually exposed by the host.

The skill no longer recommends response prefilling, which returns an error on Claude 4.6 and later, or visible chain-of-thought as a primary technique. Use explicit output instructions, schemas, tools, or post-processing instead of prefilling. Request conclusions, citations, commands, and observed results rather than reconstructed private reasoning; such requests can trigger Claude Fable 5's `reasoning_extraction` safeguard and force a model fallback.

### Built-in visual explanation guidance

The bundled `/skill:show-me` from [HumanLayer](https://github.com/humanlayer/skills) helps explain the current topic visually with concise diagrams, code-shape sketches, and focused HTML artifacts. It is distributed under the MIT License.

### Built-in code quality guidance

The bundled `/skill:qlty` uses the [qlty](https://qlty.sh) CLI for code-quality verification across 70+ linters, auto-formatters, and security scanners in 40+ languages:

- `qlty check` runs linters.
- `qlty fmt` formats code.
- `qlty metrics` measures complexity, lines, and cohesion.
- `qlty smells` finds duplication, deep nesting, and overly complex code.

The skill triggers on requests for verifiers or high code quality and prefers one CLI over ad-hoc linter commands. It directs the agent to [docs.qlty.sh/llms.txt](https://docs.qlty.sh/llms.txt), the authoritative documentation index, and tells it to enable plugins and linter extensions that fit the codebase before checking. Source-attributed reference excerpts ship beside `SKILL.md`.

The CLI is not bundled. Install it with `curl https://qlty.sh | bash` on macOS or Linux, or `powershell -c "iwr https://qlty.sh | iex"` on Windows, and keep `~/.qlty/bin` on `PATH`. Note that `qlty init` writes `.qlty/qlty.toml` into the repository.

Offline, `qlty metrics` and `qlty smells` still work through built-in static analysis. `qlty check` and `qlty fmt` need network access on first use per repository to download plugins and runtimes.

### Built-in computer-use and automation guidance

For desktop computer use, or CUA, use PyAutoGUI for mouse, keyboard and screenshots. For browser automation, load `/skill:agent-browser`. For terminal automation/testing, prefer `/skill:herdr` on macOS, Linux and Windows. Install Herdr if missing when network access and permissions permit; fall back to `/skill:tmux` or native Windows psmux when installation or use is not possible. Preserve the upstream skill's explicit-request and managed-pane requirements. These are separate interfaces, not interchangeable command names. See [verification and desktop safety](/workflows/verification) for installation, permissions, dedicated sessions and input cleanup.

The bundled [Herdr skill](https://github.com/herdrdev/herdr/blob/v0.9.0/skills/herdr/SKILL.md) requires an explicit Herdr mention or request and `HERDR_ENV=1`; it stops outside a Herdr-managed pane. It does not install Herdr or authorize control of unrelated panes. Use returned pane IDs, and check completion separately from command submission.

### Report feedback

Use `/skill:feedback <what happened or what you want to change>` to draft an Atomic bug report or enhancement. The bundled feedback skill runs one foreground debugger investigation for a bug and no subagent for an enhancement. It summarizes findings and unknowns rather than attaching files or transcripts.

Review the Markdown draft and its `Privacy scrubbed:` summary. Ask for changes to get a revised, re-scrubbed draft, or say you want it posted. An unrelated request continues the conversation without creating an issue. Posting uses your own authenticated `gh` CLI login to create an issue in `bastani-inc/atomic`; install GitHub CLI and run `gh auth login` if needed. If posting fails, Atomic reports the error and keeps the draft in the conversation.

The scrubber replaces recognized API tokens, bearer credentials, credential assignments, URL credentials, private keys and email addresses with `[REDACTED]`, and home-directory prefixes with `~`. Review before posting: arbitrary secrets and sensitive business context may remain. Blank lines and Markdown headings stop multiline credential matching; complete template placeholders and Markdown links are preserved. Content beyond those boundaries and secret text in links can therefore require manual removal. Scrubbing cannot remove information already sent to your model provider.

## Skill Commands

Skills register as `/skill:name` commands:

```bash
/skill:brave-search           # Load and execute the skill
/skill:pdf-tools extract      # Load skill with arguments
```

When multiple real skill files declare the same name, Atomic keeps the existing precedence winner for the bare command and retains every distinct file as an exact candidate. Use a source-qualified command to select one explicitly:

```bash
/skill:review                  # Current precedence winner
/skill:review@project          # Unique project candidate
/skill:review@user             # Unique user candidate
/skill:review@builtin          # Unique bundled candidate
```

`@project`, `@user`, and `@builtin` are available only when that family has one candidate in the collision. If a family contains multiple package candidates, Atomic advertises package-qualified aliases instead, such as `/skill:review@team-review` and `/skill:review@company-review`; the family selector is ambiguous and reports the exact choices. Autocomplete, `pi.getCommands()`, and RPC `get_commands` return the same advertised names.

Qualified selection is exact. An unknown or ambiguous qualified selector reports an error and never falls back to the bare winner. Aliases are recalculated on reload, so a qualified alias disappears when its collision disappears. The model-visible skill list uses the same aliases, while the opaque candidate IDs stored in transcripts and collision diagnostics are internal identity, not command names.

Subagent definitions and per-call `skills` overrides accept these same selectors. Live in-process children resolve them from their own loader catalog after resource reload; a missing or ambiguous selector is reported in the child result instead of silently selecting the bare skill. The parent-only `subagent` orchestration skill cannot be injected into a child, including qualified aliases such as `subagent@builtin`. Extensions can read the same catalog through `ctx.getSkillCatalog()`.

Arguments after the command are trimmed and appended after the expanded skill block, without a `User:` prefix. The block records the selected skill's file location, candidate identity, and base directory for relative references.

Toggle skill commands via `/settings` in interactive mode or in `settings.json`:

```json
{
  "enableSkillCommands": true
}
```

### Skills in workflow stage chats

An editable attached stage chat supports the same `/skill:<selector> [arguments]` commands. Its suggestions come from that stage's effective catalog and settings, not the main chat's catalog. Source tags use the main chat format: `[p]` for project, `[u]` for user, and `[t]` for temporary resources, with npm or Git source details when available. After the stage's resources reload, the next completion request reads the updated catalog and qualified aliases.

Stage chat supports `/skill:` discovery and Tab completion of paths relative to its working directory, but not `@` file-mention suggestions.

Enter starts a turn when idle or steers a streaming turn. Ctrl+F keeps follow-up intent. The stage session expands the command once through its admission route; skill-relative references use the skill directory while ordinary tools keep the stage cwd. Turning off `enableSkillCommands` hides suggestions but does not disable manually typed skill commands. Unknown bare selectors pass through as text; unknown or ambiguous qualified selectors and file-read failures show diagnostics in the attached chat without selecting another skill.

If a skill command is queued while the session is paused, it may remain literal text after resume. Restore it to the editor and submit again after resuming to invoke the skill.

Mounted human-input and custom prompts own their input, so answers starting `/skill:` remain literal. Blocked stages, read-only archives, and replay cannot admit skill messages. An explicitly opened editable post-mortem chat can invoke its own skills without restarting workflow execution. Skills do not grant tools, workspace access, or permission to launch workflows or subagents, and unrelated parent slash commands are not forwarded. A host without stage command metadata reports that discovery is unavailable rather than borrowing another session's catalog.

Custom stage hosts must expose admission-aware `sendUserMessage` for skill invocation. Without it, submission reports that user-message admission is unavailable.

See [workflow stage chat controls](/workflows/operations#skills-in-attached-stage-chats) for the distinction between skill messages and local view commands.

## Skill Structure

Moved to [Writing skills](/skills/authoring#skill-structure).

### SKILL.md Format

Moved to [Writing skills](/skills/authoring#skill-md-format).

## Frontmatter

Moved to [Skill reference](/skills/reference#frontmatter).

### Name Rules

Moved to [Skill reference](/skills/reference#name-rules).

### Description Best Practices

Moved to [Skill reference](/skills/reference#description-best-practices).

## Validation

Moved to [Skill reference](/skills/reference#validation).

## Example

Moved to [Writing skills](/skills/authoring#example).

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Upstream skill examples for web search, browser automation, Google APIs, and transcription
