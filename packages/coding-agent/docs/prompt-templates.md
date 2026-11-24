---
title: "Prompt templates"
sidebarTitle: "Prompt templates"
description: "Create reusable Markdown slash commands with bash-style argument placeholders, defaults, and slicing."
---

Prompt templates are Markdown snippets that expand into full prompts. Type `/name` in the editor to invoke a template, where `name` is the filename without `.md`.

**Prerequisites:** Atomic installed and running in a project. See the [Quickstart](/quickstart). No code or build step is required.

Use prompt templates when you repeat the same instructions and want a slash command for them. They are Atomic's lightest customization option. Use a [skill](/skills) if the agent should decide when to load the instructions, or an [extension](/extensions) if you need to run code.

## Locations and loading rules

Atomic loads prompt templates from these sources:

- **Global:** `~/.atomic/agent/prompts/*.md` (legacy `~/.pi/agent/prompts/*.md`)
- **Project** (only after you grant [project trust](/security#project-trust)): `.atomic/prompts/*.md` (legacy `.pi/prompts/*.md`)
- **Packages:** `prompts/` directories, `atomic.prompts`, or legacy `pi.prompts` entries in `package.json`
- **Settings:** `prompts` array in global or project `settings.json` ([Resource settings](/settings#resources)), which accepts files, directories, and filter patterns (`!glob`, `+path`, `-path` with `~` expansion; see [Package filtering](/packages/reference#package-filtering))
- **CLI:** `--prompt-template <path>` (repeatable; accepts either a `.md` file or a directory, and still loads with `--no-prompt-templates`; see [CLI resource options](/reference/cli#resource-options))

Disable default discovery with `--no-prompt-templates` (short flag `-np`). Explicit `--prompt-template` paths and `-e` package prompts still load.

### Discovery and precedence rules

- Auto-discovery in `~/.atomic/agent/prompts/` and `.atomic/prompts/` is non-recursive. To load templates from subdirectories, add them explicitly in `settings.json` `prompts` or in a package manifest.
- Scanning skips dotfiles, `node_modules`, broken symlinks, and files matched by `.gitignore`, `.ignore`, or `.fdignore` inside the `prompts/` directory. Direct symlinks to `.md` files are followed.
- When multiple templates share a filename, Atomic keeps the first match in this order:
  1. Packages passed with `-e` / `--extension`
  2. Project `settings.json` `prompts` array
  3. Project auto-discovered directories (`.atomic/prompts/`, then legacy `.pi/prompts/`)
  4. Global `settings.json` `prompts` array
  5. Global auto-discovered directories (`~/.atomic/agent/prompts/`, then legacy `~/.pi/agent/prompts/`)
  6. Configured packages (project packages, then global packages)
  7. Bundled packages
  8. Explicit CLI `--prompt-template <path>` paths
- Exception: if an inherited legacy `.pi` template collides with a bundled template, the bundled template wins.
- Built-in interactive commands and extension slash commands take precedence over prompt templates with the same name.

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
- `description` is optional. If omitted, Atomic uses the first non-empty line of the template body, truncated to 60 characters with `...` appended when longer.
- `argument-hint` is optional. When set, the hint appears before the description in the autocomplete dropdown.
- Invalid YAML frontmatter (for example an unquoted `description: Broken: value`) skips only that template and reports a warning naming the file and parse position. Valid sibling templates still load.

### Argument hints

Use `argument-hint` in frontmatter to show expected arguments in autocomplete. Use `<angle brackets>` for required arguments and `[square brackets]` for optional ones:

```markdown
---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
```

This renders in the autocomplete dropdown as:

```text
→ pr   <PR-URL>       Review PRs from URLs with structured issue and code analysis
  is   <issue>        Analyze GitHub issues (bugs or feature requests)
  wr   [instructions] Finish the current task end-to-end
  cl                  Audit changelog entries before release
```

## Usage

Type `/` followed by the template name in the editor. Autocomplete shows available templates with hints and descriptions.

```text
/review                           # Expands review.md
/component Button                 # Expands with argument
/component Button "click handler" # Multiple arguments
```

The template name ends at the first space, tab, or line break, so arguments can also start on a new line with Shift+Enter. Line breaks inside the arguments are preserved. The same rule applies to extension commands and `/skill:name` commands.

Run `/reload` after adding or editing `.md` template files to pick up changes without restarting Atomic. While viewing a subagent, invoking a prompt template expands and sends the prompt to that viewed subagent rather than `main` ([Commands while viewing a subagent](/background-tasks#commands-while-viewing-a-subagent)).

## Arguments and placeholders

Templates support bash-style positional arguments, defaults, and slicing. Substitution is single-pass (not recursive), so argument values containing `$1` or `$@` remain literal text.

| Placeholder | Expansion |
| --- | --- |
| `$1`, `$2`, `$10`, ... | Positional argument by 1-based index. Missing arguments and `$0` expand to `""` (empty string). |
| `$@` or `$ARGUMENTS` | All arguments joined with single spaces. Interchangeable except for slicing. |
| `${N:-default}` | Argument `N` when present and non-empty; otherwise `default`. Empty defaults like `${1:-}` expand to `""`. |
| `${@:-default}` or `${ARGUMENTS:-default}` | All arguments joined with spaces when present and non-empty; otherwise `default`. |
| `${@:N}` | Arguments from 1-based position `N` to the end, joined with spaces. `N = 0` clamps to `1`; `N` past the last argument expands to `""`. |
| `${@:N:L}` | Up to `L` arguments starting at 1-based position `N`, joined with spaces. `L = 0` expands to `""`. Slicing works with `@` only (not `${ARGUMENTS:N}`). |

Default-value syntax rules:

- `default` inside `${N:-default}` or `${@:-default}` cannot contain a closing `}`.
- If `default` is longer than 1,024 characters, the placeholder does not match and remains literal text in the expanded prompt.

Example with positional arguments and `$@`:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Usage: `/component Button "onClick handler" "disabled support"`

Example with a default value:

```markdown
Summarize the current state in ${1:-7} bullet points.
```

Use `""` or `''` to pass an empty argument without shifting later positions. For a template containing `Review $2. Focus: ${1:-correctness}.`, `/review "" src/index.ts` expands to `Review src/index.ts. Focus: correctness.`

### Quoting and splitting rules

- Arguments split on space (` `) and tab (`\t`) only, **not on newlines (`\n`)**. If arguments span multiple lines (via Shift+Enter) without spaces or tabs between them, the newline stays inside the same positional argument.
- Quotes (`"` or `'`) start a quoted argument only at the beginning of a token. Apostrophes inside words such as `doesn't` remain ordinary characters.
- An unclosed quote is treated as a literal character, and the rest of the text is tokenized normally.
- Backslash escaping works only for a matching quote inside a quoted argument (`\"` inside `"..."` or `\'` inside `'...'`). For example, `/review "the \"fast\" path"` passes `the "fast" path`. All other backslashes (including `\\` and backslashes outside quotes) remain literal.

## Next steps

- [Use and organize skills](/skills). Provide instructions the agent loads on its own when a task matches, instead of requiring an explicit slash command.
- [Subagents](/subagents). Delegate a focused, bounded task to a child agent.
- [Install and manage packages](/packages). Bundle your prompt templates with skills, themes, and extensions to share them.
- [Build with Atomic](/build). Compare every customization option.
