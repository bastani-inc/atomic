---
title: "Create prompt templates"
sidebarTitle: "Create prompt templates"
description: "Create reusable Markdown slash commands with bash-style argument placeholders, defaults, and slicing."
---

Prompt templates are reusable Markdown snippets that expand into full prompts when you type `/name` in Atomic, where `name` is the filename without `.md`.

Use prompt templates for recurring prompts you invoke yourself with no code or build step. Use a [skill](/skills) when the model should decide when to load instructions, or an [extension](/extensions) when you need TypeScript code.

## Create your first template

<Steps>
  <Step title="Save a Markdown file">
    Create `.atomic/prompts/review.md` for your project (or `~/.atomic/agent/prompts/review.md` for every project):

    ```markdown
    ---
    description: Review staged git changes
    argument-hint: "[focus area]"
    ---
    Review the staged changes (`git diff --cached`).
    Focus: ${1:-correctness, security, and error handling}.
    ```
  </Step>
  <Step title="Reload your session">
    Run `/reload` in an active Atomic session so it picks up the new template without restarting.
  </Step>
  <Step title="Invoke the command">
    Type `/review` or `/review "auth edge cases"` in the editor. Autocomplete shows the command, its `argument-hint`, and its `description`.
  </Step>
</Steps>

## Format and frontmatter

- The filename becomes the slash command: `review.md` registers `/review`.
- `description` is optional. If omitted (or set to a non-string YAML value), Atomic uses the first non-empty line of the template body, truncated to 60 characters with `...`.
- `argument-hint` is optional (non-string YAML values are ignored). Use `<angle brackets>` for required arguments and `[square brackets]` for optional ones; Atomic shows the hint before the description in autocomplete:

```markdown
---
description: Review PRs from URLs with structured issue and code analysis
argument-hint: "<PR-URL>"
---
```

```text
→ pr   <PR-URL>       Review PRs from URLs with structured issue and code analysis
  is   <issue>        Analyze GitHub issues (bugs or feature requests)
  wr   [instructions] Finish the current task end-to-end
  cl                  Audit changelog entries before release
```

<Warning>
Invalid YAML frontmatter (such as an unquoted colon in `description: Broken: value`) skips only that template and reports a warning with the filename and parse position. Valid sibling templates still load.
</Warning>

## Use prompt templates

Type `/` followed by the template name and any arguments:

```text
/review                           # Expands review.md
/component Button                 # Expands with one argument
/component Button "click handler" # Expands with multiple arguments
```

- **Multiline arguments.** The command name ends at the first space, tab, or line break, so arguments can start on the next line with `Shift+Enter`, and line breaks inside arguments are preserved.
- **Subagent views.** While viewing a subagent, invoking a prompt template expands and sends the prompt to that subagent instead of `main` ([Commands while viewing a subagent](/background-tasks/reference#commands-while-viewing-a-subagent)).
- **Non-interactive and queued inputs.** Prompt templates also expand in print (`-p`), JSON, and RPC modes as well as queued `steer` and `followUp` messages. From extensions, `atomic.sendUserMessage()` expands templates only when `{ expandPromptTemplates: true }` is passed. Skill commands (`/skill:...`) expand before prompt templates.

## Arguments and placeholders

Templates support bash-style positional arguments, defaults, and slicing. Substitution runs in a single pass (not recursively), so argument values containing `$1` or `$@` stay literal text.

| Placeholder | Expansion |
| --- | --- |
| `$1`, `$2`, `$10`, ... | 1-based positional argument. Missing arguments and `$0` expand to `""`. |
| `$@` or `$ARGUMENTS` | All arguments joined with single spaces. Interchangeable except for slicing. |
| `${N:-default}` | Argument `N` when present and non-empty; otherwise `default`. `${0:-default}` always expands to `default`; empty defaults like `${1:-}` expand to `""`. |
| `${@:-default}` or `${ARGUMENTS:-default}` | All arguments joined with spaces when present and non-empty; otherwise `default`. `${@:-1}` uses `"1"` as the default (not negative slicing). |
| `${@:N}` | Arguments from 1-based position `N` to the end, joined with spaces. `N = 0` clamps to `1`; `N` past the last argument expands to `""`. |
| `${@:N:L}` | Up to `L` arguments starting at 1-based position `N`, joined with spaces. `L = 0` expands to `""`. Works with `@` only (not `${ARGUMENTS:N}`). |

Default-value limits: `default` inside `${N:-default}` or `${@:-default}` cannot contain `}`, and defaults longer than 1,024 characters do not match and stay literal text.

Example with positional arguments and `$@`:

```markdown
---
description: Create a component
---
Create a React component named $1 with features: $@
```

Invoking `/component Button "onClick handler" "disabled support"` fills `$1` with `Button` and `$@` with `Button onClick handler disabled support`.

Use `""` or `''` to pass an empty positional argument without shifting later positions. For `Review $2. Focus: ${1:-correctness}.`, `/review "" src/index.ts` expands to `Review src/index.ts. Focus: correctness.`

### Quoting and splitting rules

- Arguments split on space (` `) and tab (`\t`) only, **not on newlines (`\n`)**. Multiline text without spaces or tabs between lines stays in one argument.
- Quotes (`"` or `'`) start a quoted argument only at the start of a token, so apostrophes inside words (`doesn't`) stay literal. Unquoted characters immediately after a closing quote stay in the same argument (`"hello"world` becomes `helloworld`).
- An unclosed quote is treated as a literal character and the remaining text tokenizes normally.
- Backslash escaping applies only to a matching quote inside a quoted argument (`\"` inside `"..."` or `\'` inside `'...'`). All other backslashes (including `\\` and unquoted backslashes) stay literal.

## Locations and loading rules

Atomic loads prompt templates from these sources:

- **Global:** `~/.atomic/agent/prompts/*.md`
- **Project** (requires [project trust](/security#project-trust)): `.atomic/prompts/*.md`
- **Packages:** `prompts/` directories or `atomic.prompts` entries in `package.json`
- **Settings:** `prompts` array in global or project `settings.json` ([Resource settings](/settings#resources)), accepting files, directories, and filter patterns (`!glob`, `+path`, `-path` with `~` expansion; see [Package filtering](/packages/reference#package-filtering))
- **CLI:** `--prompt-template <path>` (repeatable; accepts a `.md` file or a directory and still loads with `--no-prompt-templates` / `-np`; see [CLI resource options](/reference/cli#resource-options))

Discovery and precedence behavior:

- Auto-discovery in `~/.atomic/agent/prompts/` and `.atomic/prompts/` is non-recursive and skips dotfiles, `node_modules`, broken symlinks, and files matched by `.gitignore`, `.ignore`, or `.fdignore` inside `prompts/` (direct symlinks to `.md` files are followed).
- Explicit `--prompt-template <dir>` paths read all `.md` files in that directory without applying dotfile or `.gitignore` filters, and passing a non-`.md` file path to `--prompt-template` is ignored silently.
- Built-in [slash commands](/slash-commands) and extension slash commands always take precedence over prompt templates with the same name. Among templates themselves, `-e` packages win first, then project overrides global, both override configured and bundled packages, and explicit `--prompt-template` paths apply last—see [Resource precedence order](/packages/reference#resource-precedence-order).

<Note>
Legacy `.pi` paths (`~/.pi/agent/prompts/*.md`, `.pi/prompts/*.md`, and `pi.prompts` in `package.json`) continue to load alongside `.atomic` paths. If an inherited legacy `.pi` template collides with a bundled template, the bundled template wins.
</Note>

## Next steps

<Columns cols={2}>
  <Card title="Use skills" href="/skills">
    Provide instructions that the agent loads automatically when a task matches.
  </Card>
  <Card title="Subagents" href="/subagents">
    Delegate a focused, bounded task to a child agent.
  </Card>
  <Card title="Install and manage packages" href="/packages">
    Bundle prompt templates with skills, themes, and extensions to share with your team.
  </Card>
  <Card title="Build with Atomic" href="/build">
    Compare every customization option in Atomic.
  </Card>
</Columns>
