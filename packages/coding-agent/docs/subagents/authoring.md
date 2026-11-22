---
title: Custom subagents
description: Define, scope, and configure your own subagents.
---

# Custom subagents

## Custom agents

Define a custom agent as a Markdown file with YAML frontmatter and a self-contained system prompt body.

Atomic discovers agents in the scopes below. Later scopes and later directories inside a scope override earlier ones on matching names. See [Agent discovery](/subagents/reference#agent-discovery) for the full rules.

| Scope | Locations (increasing precedence) |
| --- | --- |
| Builtin | Bundled with Atomic |
| Package | `agents` field in an installed package, qualified as `<namespace>.<name>` ([package subagents](/packages/authoring#subagents)) |
| User | `~/.pi/agent/agents/**/*.md` (omitted when `ATOMIC_CODING_AGENT_DIR` is set), then `~/.agents/**/*.md`, then `~/.atomic/agent/agents/**/*.md` (or `<ATOMIC_CODING_AGENT_DIR>/agents/**/*.md`) |
| Project (trusted only) | Nearest ancestor project root: `.agents/**/*.md`, then `.pi/agents/**/*.md`, then `.atomic/agents/**/*.md` |

Example read-only inspection agent (`.atomic/agents/strict-inspector.md`):

```markdown
---
name: strict-inspector
description: Inspect code for correctness and regressions
tools: read, search, bash
model: anthropic/claude-sonnet-4-6:high
fallbackModels: openai/gpt-5-mini:medium
inheritProjectContext: true
---

## Role and goal
Inspect the current diff for correctness and regressions without editing files.

## Success criteria
Cite each actionable issue with file:line evidence and the observed failure or risk.

## Output and stop rule
Return only issues worth fixing now. Stop when the relevant diff and affected call paths have been inspected, or name the evidence you could not access.
```

Tips for writing agent prompts:

- Lead with the role, goal, and observable success criteria.
- Specify constraints, tool rules, output shape, and an explicit stop rule.
- Reserve strict wording for true invariants. Ask for evidence and conclusions instead of private reasoning or repeated self-checks.

To run an agent on your default model, set `model: auto`. Atomic uses the model you last chose with `/model` at the agent's `thinking` level or the default thinking level, falling back to the launching session's model if no default is set. A per-call `model` argument always overrides `auto`. See [Automatic model selection](/subagents/reference#automatic-model-selection).
