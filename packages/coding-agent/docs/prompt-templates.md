> Atomic can create prompt templates. Ask it to build one for your workflow.

# Prompt Templates

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`.

**Prerequisites:** Atomic installed and running in a project — see the [Quickstart](/quickstart). No code and no build step are required.

**When to use this:** prompt templates are the lightest customization mechanism Atomic ships. Reach for them when you repeat the same instructions and want a slash command for them. If the agent should decide on its own when to load the instructions, use a [skill](/skills) instead; if you need to run code, use an [extension](/extensions).

## Locations

Atomic loads prompt templates from:

- Global: `~/.atomic/agent/prompts/*.md` (legacy `~/.pi/agent/prompts/*.md`)
- Project: `.atomic/prompts/*.md` (legacy `.pi/prompts/*.md`, only after the project is trusted)
- Packages: `prompts/` directories, `atomic.prompts`, or legacy `pi.prompts` entries in `package.json`
- Settings: `prompts` array with files or directories
- CLI: `--prompt-template <path>` (repeatable)

Disable discovery with `--no-prompt-templates`.

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
- `description` is optional. If missing, the first non-empty line is used.
- `argument-hint` is optional. When set, the hint is displayed before the description in the autocomplete dropdown.

### Argument Hints

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

## Arguments

Templates support positional arguments, defaults, and simple slicing:

- `$1`, `$2`, ... positional args
- `$@` or `$ARGUMENTS` for all args joined
- `${1:-default}` uses arg 1 when present/non-empty, otherwise `default`
- `${@:-default}` or `${ARGUMENTS:-default}` uses all arguments when present/non-empty, otherwise `default`
- `${@:N}` for args from the Nth position (1-indexed)
- `${@:N:L}` for `L` args starting at N

Example:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Default values are useful for optional arguments:

```markdown
Summarize the current state in ${1:-7} bullet points.
```

Usage: `/component Button "onClick handler" "disabled support"`

## Loading Rules

- Template discovery in `prompts/` is non-recursive.
- If you want templates in subdirectories, add them explicitly via `prompts` settings or a package manifest.

## Report feedback

Use `/feedback <what happened or what you want to change>` to draft an Atomic bug report or enhancement. The bundled feedback skill runs one foreground debugger investigation for a bug and no subagent for an enhancement. It summarizes findings and unknowns rather than attaching files or transcripts.

Review the Markdown draft and its `Privacy scrubbed:` summary. Ask for changes to get a revised, re-scrubbed draft, or say you want it posted. An unrelated request continues the conversation without creating an issue. Posting uses your own authenticated `gh` CLI login to create an issue in `bastani-inc/atomic`; install GitHub CLI and run `gh auth login` if needed. If posting fails, Atomic reports the error and keeps the draft in the conversation.

The scrubber replaces recognized API tokens, bearer credentials, credential assignments, URL credentials, private keys and email addresses with `[REDACTED]`, and home-directory prefixes with `~`. Review before posting: arbitrary secrets and sensitive business context may remain. Blank lines and Markdown headings stop multiline credential matching; complete template placeholders and Markdown links are preserved. Content beyond those boundaries and secret text in links can therefore require manual removal. Scrubbing cannot remove information already sent to your model provider.

## Next steps

- [Skills](/skills) — instructions the agent loads on its own when a task matches, instead of on an explicit slash command.
- [Subagents](/subagents) — delegate a focused, bounded task to a child agent.
- [Atomic packages](/packages) — bundle your prompt templates with skills, themes, and extensions and share them.
- [Build with Atomic](/build) — compare every customization mechanism.
