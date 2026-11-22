---
title: Prompt templates
description: Create reusable Markdown prompts that expand from slash commands with argument substitution.
---

# Prompt templates

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`.

**Prerequisites:** Atomic installed and running in a project. See the [Quickstart](/quickstart). No code or build step is required.

Use prompt templates when you repeat the same instructions and want a slash command for them. They are Atomic's lightest customization option. Use a [skill](/skills) if the agent should decide when to load the instructions, or an [extension](/extensions) if you need to run code.

## Locations

Atomic loads prompt templates from:

- Global: `~/.atomic/agent/prompts/*.md` (legacy `~/.pi/agent/prompts/*.md`)
- Project: `.atomic/prompts/*.md` (legacy `.pi/prompts/*.md`, only after the project is trusted)
- Packages: `prompts/` directories, `atomic.prompts`, or legacy `pi.prompts` entries in `package.json`
- Settings: `prompts` array with files or directories
- CLI: `--prompt-template <path>` (repeatable)

Disable default discovery with `--no-prompt-templates`. Explicit `--prompt-template` paths still load.

## Format

```markdown
---
description: Review staged git changes
---
Review the staged changes (`git diff --cached`). Focus on:
- Bugs and logic errors
- Security issues
- Error handling gaps
```

- The filename becomes the command name. `review.md` becomes `/review`.
- `description` is optional. If missing, the first non-empty line is used (truncated to 60 characters).
- `argument-hint` is optional. When set, the hint appears before the description in the autocomplete dropdown.
- Invalid YAML frontmatter (for example an unquoted `description: Broken: value`) skips only that template and reports a warning naming the file and the parse position. Valid sibling templates still load.

### Argument hints

Use `argument-hint` in frontmatter to show expected arguments in autocomplete. Use `<angle brackets>` for required arguments and `[square brackets]` for optional ones:

```markdown
---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
```

This renders in the autocomplete dropdown as:

```
→ pr   <PR-URL>       — Review PRs from URLs with structured issue and code analysis
  is   <issue>        — Analyze GitHub issues (bugs or feature requests)
  wr   [instructions] — Finish the current task end-to-end
  cl   — Audit changelog entries before release
```

## Usage

Type `/` followed by the template name in the editor. Autocomplete shows available templates with descriptions.

```
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

The template name ends at the first space, tab, or line break, so arguments can also start on a new line with Shift+Enter. Line breaks inside the arguments are kept. The same rule applies to extension commands and `/skill:name` commands.

## Arguments

Templates support positional arguments, defaults, and simple slicing. Substitution is not recursive, so argument values containing `$1` or `$@` stay as literal text:

- `$1`, `$2`, ... for positional arguments
- `$@` or `$ARGUMENTS` for all arguments joined with spaces
- `${1:-default}` uses argument 1 when present and non-empty, otherwise `default` (up to 1,024 characters)
- `${@:-default}` or `${ARGUMENTS:-default}` uses all arguments when present and non-empty, otherwise `default`
- `${@:N}` for arguments from the Nth position (1-indexed)
- `${@:N:L}` for `L` arguments starting at N

Example:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Default values help with optional arguments:

```markdown
Summarize the current state in ${1:-7} bullet points.
```

Usage: `/component Button "onClick handler" "disabled support"`

Use `""` or `''` to pass an empty argument without shifting later positions. For a template containing `Review $2. Focus: ${1:-correctness}.`, `/review "" src/index.ts` expands to `Review src/index.ts. Focus: correctness.`

A quote only starts quoting at the beginning of an argument, so apostrophes inside words such as `doesn't` stay as text, and a quote with no closing match is kept as text. Inside a quoted argument, a backslash before the same quote character keeps it as text, so `/review "the \"fast\" path"` supplies `the "fast" path`. Other backslashes stay as typed.

## Loading rules

- Template discovery in `prompts/` is non-recursive.
- If you want templates in subdirectories, add them explicitly via `prompts` settings or a package manifest.

## Next steps

- [Skills](/skills). Provide instructions the agent loads on its own when a task matches, instead of requiring an explicit slash command.
- [Subagents](/subagents). Delegate a focused, bounded task to a child agent.
- [Atomic packages](/packages). Bundle your prompt templates with skills, themes, and extensions to share them.
- [Build with Atomic](/build). Compare every customization option.
