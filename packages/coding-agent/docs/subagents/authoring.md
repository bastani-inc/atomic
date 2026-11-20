---
title: Custom subagents
description: Define, scope, and configure your own subagents.
---

# Custom subagents

## Custom agents

Define a custom agent as a Markdown file with YAML frontmatter and a self-contained system prompt body.

Where Atomic discovers custom agents (later rows override earlier ones on matching names; see [Agent discovery](/subagents/reference#agent-discovery)):

| Scope | Location |
| --- | --- |
| Builtin | Bundled with Atomic |
| Package | `agents` field in an installed package ([package subagents](/packages/authoring#subagents)) |
| User | `~/.atomic/agent/agents/**/*.md` |
| Project | `.atomic/agents/**/*.md` |

Example read-only inspection agent (`.atomic/agents/strict-inspector.md`):

```markdown
---
name: strict-inspector
description: Inspect code for correctness and regressions
tools: read, search, bash
model: anthropic/claude-sonnet-4:high
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

**Writing effective agent prompts:**
- Lead with the role, goal, and observable success criteria.
- Specify constraints, tool rules, output shape, and an explicit stop rule.
- Reserve strict wording for true invariants; ask for evidence and conclusions rather than private reasoning or repeated self-checks.

**Using your default model:** Set `model: auto` to run the agent on the model you last chose with `/model` (at the agent's `thinking` level or the default thinking level, falling back to the launching session's model if no default is set). A per-call `model` argument always overrides it. See [Automatic model selection](/subagents/reference#automatic-model-selection).
