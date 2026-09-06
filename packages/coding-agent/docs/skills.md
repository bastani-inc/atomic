> Atomic can create skills. Ask it to build one for your use case.

# Skills

Skills are self-contained capability packages that the agent loads on-demand. A skill provides specialized workflows, setup instructions, helper scripts, and reference documentation for specific tasks.

Atomic implements the [Agent Skills standard](https://agentskills.io/specification), warning about violations but remaining lenient.

## Table of Contents

- [Locations](#locations)
- [How Skills Work](#how-skills-work)
- [Skill Commands](#skill-commands)
- [Skill Structure](#skill-structure)
- [Frontmatter](#frontmatter)
- [Validation](#validation)
- [Example](#example)
- [Skill Repositories](#skill-repositories)

## Locations

> **Security:** Skills can instruct the model to perform any action and may include executable code the model invokes. Review skill content before use.

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

The bundled `/skill:qlty` runs code-quality verification through the [qlty](https://qlty.sh) CLI, which drives 70+ linters, auto-formatters, and security scanners across 40+ languages: `qlty check` for linting, `qlty fmt` for auto-formatting, `qlty metrics` for complexity, lines, and cohesion, and `qlty smells` for duplication, deep nesting, and overly complex code. It triggers on requests for verifiers or high code quality and prefers one CLI over ad-hoc per-tool linter invocations. The skill directs the agent to [docs.qlty.sh/llms.txt](https://docs.qlty.sh/llms.txt) as the authoritative documentation index, tells it to enable the qlty plugins and linter extensions that fit the codebase before checking, and ships source-attributed reference excerpts beside `SKILL.md`. The CLI is not bundled; install it with `curl https://qlty.sh | bash` (macOS and Linux) or `powershell -c "iwr https://qlty.sh | iex"` (Windows), and keep `~/.qlty/bin` on `PATH`. Note that `qlty init` writes `.qlty/qlty.toml` into the repository. Offline, `qlty metrics` and `qlty smells` still work (built-in static analysis); `qlty check` and `qlty fmt` download plugins and runtimes on first use per repository and need network then.

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

Completion reuses an already attached session without reattaching or checkpointing it for each keystroke. If attachment is needed, overlapping requests share that attachment and then read the current catalog. This stage adapter provides skill-command discovery only; it does not provide `@` file-mention suggestions.

Enter starts a turn when idle or steers a streaming turn. Ctrl+F keeps follow-up intent. The stage session expands the command once through its admission route; skill-relative references use the skill directory while ordinary tools keep the stage cwd. Turning off `enableSkillCommands` hides suggestions but does not disable manually typed skill commands. Unknown bare selectors pass through as text; unknown or ambiguous qualified selectors and file-read failures show diagnostics in the attached chat without selecting another skill.

The native session pause gate still takes precedence over expansion. If that gate closes during asynchronous attachment, the command is queued as literal text, just as in main chat; releasing that queue does not retroactively expand it. A composer that observes the pause before submission resumes first and then uses normal skill expansion. To invoke a command retained literally by this race, restore it to the editor and submit after resuming.

Mounted human-input and custom prompts own their input, so answers starting `/skill:` remain literal. Blocked stages, read-only archives, and replay cannot admit skill messages. An explicitly opened editable post-mortem chat can invoke its own skills without restarting workflow execution. Skills do not grant tools, workspace access, or permission to launch workflows or subagents, and unrelated parent slash commands are not forwarded. A host without stage command metadata reports that discovery is unavailable rather than borrowing another session's catalog.

Custom stage hosts must expose admission-aware `sendUserMessage` to support invocation. Without it, skill submission reports that user-message admission is unavailable instead of falling back to unguarded `prompt`, `steer`, or `followUp` calls.

See [workflow stage chat controls](workflows/operations.md#skills-in-attached-stage-chats) for the distinction between skill messages and local view commands.

## Skill Structure

A skill is a directory with a `SKILL.md` file. Everything else is freeform.

```
my-skill/
├── SKILL.md              # Required: frontmatter + instructions
├── scripts/              # Helper scripts
│   └── process.sh
├── references/           # Detailed docs loaded on-demand
│   └── api-reference.md
└── assets/
    └── template.json
```

### SKILL.md Format

````markdown
---
name: my-skill
description: What this skill does and when to use it. Be specific.
---

# My Skill

## Setup

Run once before first use:
```bash
cd /path/to/skill && bun install
```

## Usage

```bash
./scripts/process.sh <input>
```
````

Use relative file paths from the skill directory (these are bundled skill files, not docs routes):

```markdown
See the API reference at `references/api-reference.md` for details.
```

Keep authored instructions outcome-first and concise. State observable completion and stop conditions, give a short reason for material constraints, and use decision rules for judgment calls instead of `ALWAYS`/`NEVER` language. Put detailed or model-specific material in `references/` so it loads only when needed. Do not ask models to reproduce private reasoning or repeatedly verify their own work; require evidence or validation results where correctness matters.

## Frontmatter

Per the [Agent Skills specification](https://agentskills.io/specification#frontmatter-required):

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase a-z, 0-9, hyphens. Must match parent directory. |
| `description` | Yes | Max 1024 chars. What the skill does and when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools (experimental). |
| `disable-model-invocation` | No | When `true`, skill is hidden from system prompt. Users must use `/skill:name`. |

### Name Rules

- 1-64 characters
- Lowercase letters, numbers, hyphens only
- No leading/trailing hyphens
- No consecutive hyphens
- Must match parent directory name

Valid: `pdf-processing`, `data-analysis`, `code-review`
Invalid: `PDF-Processing`, `-pdf`, `pdf--processing`

### Description Best Practices

The description determines when the agent loads the skill. Be specific.

Good:
```yaml
description: Extracts text and tables from PDF files, fills PDF forms, and merges multiple PDFs. Use when working with PDF documents.
```

Poor:
```yaml
description: Helps with PDFs.
```

## Validation

Atomic validates skills against the Agent Skills standard. Most issues produce warnings but still load the skill:

- Name doesn't match parent directory
- Name exceeds 64 characters or contains invalid characters
- Name starts/ends with hyphen or has consecutive hyphens
- Description exceeds 1024 characters

Unknown frontmatter fields are ignored.

Declared skills with missing descriptions are not loaded. Malformed `SKILL.md` files and `SKILL.md` files without a description produce warnings and are not loaded. Other Markdown files without valid skill frontmatter are ignored.

Name collisions (the same name from different real files) produce diagnostics and keep the existing first-winner precedence for `/skill:name`. Atomic also retains the other files as source-qualified candidates as described in [Skill Commands](#skill-commands).

## Example

```
brave-search/
├── SKILL.md
├── search.js
└── content.js
```

**SKILL.md:**
````markdown
---
name: brave-search
description: Web search and content extraction via Brave Search API. Use for searching documentation, facts, or any web content.
---

# Brave Search

## Setup

```bash
cd /path/to/brave-search && bun install
```

## Search

```bash
./search.js "query"              # Basic search
./search.js "query" --content    # Include page content
```

## Extract Page Content

```bash
./content.js https://example.com
```
````

## Skill Repositories

- [Anthropic Skills](https://github.com/anthropics/skills) - Document processing (docx, pdf, pptx, xlsx), web development
- [Pi Skills](https://github.com/badlogic/pi-skills) - Upstream skill examples for web search, browser automation, Google APIs, and transcription
