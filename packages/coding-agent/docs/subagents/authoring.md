---
title: Custom subagents
description: Define, scope, and configure your own subagents.
---

# Custom subagents

## Custom agents

Custom agents are Markdown files with YAML frontmatter and a system prompt body. Make the body self-contained and lead with the outcome:

- State the role or goal and observable success criteria.
- Define constraints, context-dependent tool routes, and the required output shape.
- Say when the agent should stop.

Reserve absolute wording for true invariants. Request evidence and conclusions rather than private reasoning, and avoid repeated self-check instructions.

Common locations are:

| Scope | Path |
|---|---|
| User | `~/.atomic/agent/agents/**/*.md` |
| Project | `.atomic/agents/**/*.md` |
| Package | The `agents` field of an installed package; see [package subagents](/packages/authoring#subagents) |

A project agent replaces a user agent of the same name, and both replace package and builtin agents. See [Agent discovery](/subagents/reference#agent-discovery).

A small custom read-only inspection agent:

```markdown
---
name: strict-inspector
description: Inspect code for correctness and regressions
tools: read, search, bash
model: anthropic/claude-sonnet-4
fallbackModels: openai/gpt-5-mini
inheritProjectContext: true
---

## Role and goal
Inspect the current diff for correctness and regressions without editing files.

## Success criteria
Cite each actionable issue with file:line evidence and the observed failure or risk.

## Output and stop rule
Return only issues worth fixing now. Stop when the relevant diff and affected call paths have been inspected, or name the evidence you could not access.
```

To run the agent on your default model, set `model: auto` instead of a concrete model. The child runs the model you last chose with `/model` at the agent's `thinking` level or the default thinking level, or the launching session's model when no default model is configured. A concrete per-call override wins. See [Automatic model selection](/subagents/reference#automatic-model-selection).
