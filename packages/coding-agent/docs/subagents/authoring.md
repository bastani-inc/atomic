---
title: "Create custom subagents"
sidebarTitle: "Custom subagents"
description: "Define custom Markdown subagents, configure YAML frontmatter fields, and override or disable built-in agents."
---

Define a custom subagent as a Markdown file with YAML frontmatter and a self-contained system prompt body. Run `/reload` after adding or editing files on disk so Atomic picks up your changes.

## Where agent files live {#custom-agents}

Atomic discovers `.md` files recursively (`**/*.md`, following symlinks and sorted lexicographically) across four scopes. Later scopes and later directories inside a scope override earlier ones on matching names. Project scopes resolve from the nearest ancestor directory containing `.atomic/`, `.pi/`, or `.agents/` (not necessarily the Git root). See [Agent discovery](/subagents/reference#agent-discovery) for complete rules.

| Scope | Locations (increasing precedence) |
| --- | --- |
| Package | `agents` field in an installed package, qualified as `<namespace>.<name>` ([package subagents](/packages/authoring#subagents)) |
| Builtin | Bundled with Atomic |
| User | `~/.pi/agent/agents/**/*.md` (omitted when `ATOMIC_CODING_AGENT_DIR` or legacy `PI_CODING_AGENT_DIR` is set), then `~/.agents/**/*.md`, then `~/.atomic/agent/agents/**/*.md` (or `<ATOMIC_CODING_AGENT_DIR>/agents/**/*.md`) |
| Project (trusted only) | Nearest ancestor project root: `.agents/**/*.md`, then `.pi/agents/**/*.md`, then `.atomic/agents/**/*.md` |

## Frontmatter reference

| Field | Required | Type / format | Default | Behavior |
| --- | --- | --- | --- | --- |
| `name` | Yes | Plain string | None | Agent identifier. Files missing `name` (or setting it to a YAML list) are skipped. Sanitized to `[a-z0-9-]` when created via the `subagent` tool. Package agents cannot contain `.`. |
| `description` | Yes | Plain string | None | Short summary shown in `/agents` and `subagent({ action: "list" })`. Files missing `description` (or setting it to a YAML list) are skipped. |
| `package` | No | Namespace string (`a-z`, `0-9`, `-`, `.`) | None | Optional namespace for user or project agents. The runtime name becomes `<package>.<name>` (used to override an installed package agent). Ignored inside installed packages where the manifest sets the namespace. |
| `model` | No | `"auto"`, `provider/id`, `provider/id:effort`, or bare `id` | Inherit | Selects the agent's primary model. `"auto"` uses your default model (`/model`) or the launching session's model. Omitting both `model` and `fallbackModels` inherits the launching session's model and thinking level. Effort suffixes are case-insensitive. |
| `fallbackModels` | No | Comma-separated string or YAML list | None | Ordered fallback models tried on retryable provider errors, with optional `:effort` suffixes (for example `[openai/gpt-5:medium, anthropic/claude-haiku-4-5:off]`). |
| `tools` | No | Comma-separated string or YAML list | Inherit | Restricts the subagent to named tools. Supports built-in tools plus `mcp:<server>` and `mcp:<server>/<tool>`. Omitting `tools` inherits tools from the launching session. |
| `defaultContext` | No | `"fresh"` or `"fork"` | `"fresh"` | Whether the subagent starts clean or forks the main conversation when `context` is omitted at launch. |
| `systemPromptMode` | No | `"replace"` or `"append"` | `"replace"` (`"append"` for `delegate`) | Whether the Markdown body replaces or appends to the base system prompt. |
| `inheritProjectContext` | No | Boolean | `false` (`true` for `delegate`) | Include `AGENTS.md` project context files in a `fresh` subagent. Has no effect on `fork`. |
| `inheritSkills` | No | Boolean | `false` | Include active skills from the launching session in a `fresh` subagent. Has no effect on `fork`. |
| `skills` (or `skill`) | No | Comma-separated string or YAML list | None | Named skills injected into the subagent. If both `skill` and `skills` appear, `skill` takes precedence. |
| `extensions` | No | Comma-separated string or YAML list | Inherit | Restricts loaded extensions by name. Set `extensions: ""` or `extensions: []` to disable extensions; omit to inherit. |
| `output` | No | File path string | None | Default output file path for results, resolved relative to the subagent's `cwd`. |
| `defaultReads` | No | Comma-separated string or YAML list | None | Files automatically prepended into context before the task runs, resolved relative to the subagent's `cwd`. |
| `defaultProgress` | No | Boolean | `false` | Enables run-scoped `progress.md` tracking in isolated artifact storage (suppressed for read-only tasks unless `progress: true` is passed at launch). |
| `interactive` | No | Boolean | `false` | Accepted in frontmatter and preserved when updating an agent through the `subagent` tool. |
| `thinking` | No | Thinking level string | None | Deprecated. Use `:effort` on `model` instead; applies only when `model` has no suffix. |
| `fallbackThinkingLevels` | No | Comma-separated string or YAML list | None | Deprecated. Index-aligned thinking levels for `fallbackModels`; prefer `:effort` suffixes directly on `fallbackModels`. |

<Warning>
When you omit `context` on a parallel `tasks` launch, if **any** requested agent declares `defaultContext: fork`, the **entire batch** runs in forked context. Keep `defaultContext: fresh` on review and research agents unless you want forked history.
</Warning>

### YAML syntax rules

Frontmatter is parsed by a strict YAML parser, not a loose line reader:

- **Quote colons followed by a space.** Write `description: "Deploy: verify staging first"` instead of `description: Deploy: verify staging first`. Invalid YAML (unquoted `: `, duplicate keys, unclosed brackets, or tab-indented lists) skips the entire agent file and records a load diagnostic.
- **Lists or comma-separated strings.** `tools`, `fallbackModels`, `fallbackThinkingLevels`, `skills`/`skill`, `defaultReads`, and `extensions` accept comma-separated strings (`read, search, bash`), YAML flow lists (`[read, search, bash]`), and YAML block lists.
- **Extra keys.** Nested YAML objects are ignored. Unknown scalar or string-array fields are preserved across tool-based updates (legacy `completionGuard` is stripped automatically).

## Example custom agent

Save a read-only inspection agent at `.atomic/agents/strict-inspector.md`:

```markdown
---
name: strict-inspector
description: Inspect code for correctness and regressions
tools:
  - read
  - search
  - bash
  - mcp:issue-tracker/get_issue
model: anthropic/claude-sonnet-4-6:high
fallbackModels:
  - openai/gpt-5-mini:medium
  - anthropic/claude-haiku-4-5:off
skills:
  - tdd
inheritProjectContext: true
defaultContext: fresh
---

## Role and goal
Inspect the current diff for correctness and regressions without editing files.

## Success criteria
Cite each actionable issue with file:line evidence and the observed failure or risk.

## Output and stop rule
Return only issues worth fixing now. Stop when the relevant diff and affected call paths have been inspected, or name the evidence you could not access.
```

## Tool and MCP allowlists

- **Built-in tools.** List tool names such as `read`, `search`, `find`, `ls`, `edit`, `write`, `bash`, `todo`, `web_search`, `fetch_content`, or `intercom`.
- **MCP tools.** Use `mcp:<server>` to allow every tool exposed by that MCP server, or `mcp:<server>/<tool>` to allow a single tool.
- **Parent restrictions still apply.** An agent's `tools` list can narrow what the subagent may use, but it cannot re-enable tools or packages excluded by the launching session.
- **Automatic Intercom tools.** By default (`intercomBridge.mode: "always"` in `config.json`), Atomic automatically adds `intercom` and `contact_supervisor` to every subagent whose launching session has Intercom active, even if the agent's `tools` list omits them.

## Managing agents with the `subagent` tool

You can inspect and manage user and project agents without editing Markdown files manually:

```ts
// List active agents (deduplicated across user/project/builtin/package scopes)
subagent({ action: "list" })

// Inspect one agent definition
subagent({ action: "get", agent: "strict-inspector" })

// Create a project-scoped agent
subagent({
  action: "create",
  config: {
    name: "strict-inspector",
    description: "Inspect diffs for regressions without editing",
    scope: "project",
    model: "auto",
    tools: "read, search, bash",
    systemPrompt: "Inspect the diff and return file:line evidence.",
  },
})

// Update an existing agent (pass false or "" to clear an optional field)
subagent({
  action: "update",
  agent: "strict-inspector",
  agentScope: "project",
  config: { model: "anthropic/claude-sonnet-4-6:high", output: false },
})

// Delete a user or project agent
subagent({ action: "delete", agent: "strict-inspector", agentScope: "project" })
```

Key management rules:

- **`scope` default.** `create` defaults `scope` to `"user"`. Pass `scope: "project"` to write into `.atomic/agents/`.
- **Disambiguation.** If an agent exists in both user and project scopes, pass `agentScope: "user"` or `"project"` to `update` or `delete`. User-scope directories deduplicate in the same precedence order as execution (`~/.atomic/agent/agents` > `~/.agents` > `~/.pi/agent/agents`).
- **Overriding a package agent.** Pass `package` separately in `config` (for example `{ name: "reviewer", package: "acme.review-kit", ... }`). Putting dots inside `config.name` strips them during name sanitization.
- **Built-in and package agents.** `update` and `delete` refuse built-in and package agents. Override built-ins via `settings.json` or by creating a user or project Markdown file with the same name.

## Overriding or disabling built-in agents

Override or disable bundled agents in user (`~/.atomic/agent/settings.json`) or trusted project (`.atomic/settings.json`) settings without copying their Markdown files. Project settings override user settings.

```json
{
  "subagents": {
    "disableBuiltins": false,
    "agentOverrides": {
      "worker": {
        "model": "anthropic/claude-sonnet-4-6:high",
        "fallbackModels": ["openai/gpt-5:medium"],
        "defaultContext": "fresh"
      },
      "code-simplifier": {
        "disabled": true
      }
    }
  }
}
```

- **`subagents.disableBuiltins`.** Set to `true` to disable all bundled agents. A trusted project setting `disableBuiltins: false` or per-agent overrides still apply on top.
- **`subagents.agentOverrides.<name>`.** Supports 12 fields:
  - `model` (string)
  - `fallbackModels` (string array, or `false` to clear)
  - `fallbackThinkingLevels` (deprecated string array, or `false` to clear)
  - `thinking` (deprecated string, or `""`/`false` to clear an inherited thinking level)
  - `systemPromptMode` (`"replace"` or `"append"`)
  - `inheritProjectContext` (boolean)
  - `inheritSkills` (boolean)
  - `defaultContext` (`"fresh"` or `"fork"`)
  - `disabled` (boolean)
  - `systemPrompt` (string)
  - `skills` (string array, or `false` to clear)
  - `tools` (string array supporting `mcp:<server>` and `mcp:<server>/<tool>`, or `false` to clear)

## Writing effective agent prompts

- Lead with the role, goal, and observable success criteria.
- Specify edit permissions, tool rules, output shape, and an explicit stop rule.
- Reserve strict wording for true invariants. Ask for evidence and conclusions rather than private reasoning or repeated self-checks.
- Set `model: auto` to run an agent on your default model (`/model`). See [Automatic model selection](/subagents/reference#automatic-model-selection) for the exact resolution chain.
