---
title: "Convert an earlier workflow into a skill"
description: "Keep the procedure in a reusable skill without running or changing the old workflow file."
---

# Convert an earlier workflow into a skill

Ask Atomic in chat or invoke `/skill:workflow-files`:

```text
Convert .atomic/workflows/triage.ts into a skill
```

```text
/skill:workflow-files .atomic/workflows/triage.ts
```

To convert and run immediately, include your inputs (for example: *"Run the triage workflow on these reports."*). Startup notices may mention legacy workflow files, but nothing is written automatically.

**How conversion works:**
- Atomic reads the workflow file and helpers as plain text and uses `skill-creator` to write `SKILL.md` plus deterministic scripts under `scripts/`.
- The original workflow file is never imported, executed, edited, or deleted.
- Existing skills are never overwritten (pick a new name or reuse the existing skill).
- Untrusted projects' workflow files are never offered for conversion (global workflows still convert; for an explicit trusted external source inside an untrusted project, Atomic asks before saving globally).

| Workflow source | Output skill location |
| --- | --- |
| Trusted project `.atomic/workflows/`, `.pi/workflows/`, project settings paths, project-installed packages | `.atomic/skills/<name>/` |
| `~/.atomic/agent/workflows/`, global settings paths, globally installed packages | `~/.atomic/agent/skills/<name>/` (or `skills/` in your agent directory) |
| Package via `-e`, or trusted borrowed project folder | Current trusted project's `.atomic/skills/<name>/` (never the external tree) |

After reviewing the generated skill and scripts, run `/reload`, then invoke `/skill:<name>` with your inputs. See [skills as workflows](/skills#skills-as-workflows) and [orchestration](/orchestration).

## What conversion preserves

| Earlier workflow API | Equivalent in the converted skill |
| --- | --- |
| `ctx.stage`, `ctx.task`, model & thinking | Codemode `tools.subagent()` launches in the parent chat preserving prompts, inputs, and model pins. |
| Stage `fallbackModels`, `tools`, `mcp` | Named [custom subagent](/subagents/authoring) launched without per-call `model` ([Pinned stages](#pinned-stages)). |
| `ctx.parallel`, loops, retries | `tasks` batches, explicit round caps, and checks between notices (plus Intercom `group` for peers). |
| `ctx.tool`, deterministic helpers | Reviewed scripts in `scripts/` with validated args, timeouts, and exit checks. |
| Inputs, `ctx.ui`, approvals | Skill arguments/defaults plus `ask_user_question` steps (unanswered approval is never a pass). |
| Nested `ctx.workflow` | Separately converted skill called by name (parent still owns all subagent launches). |
| Structured outputs, `ctx.exit`, blocked states | Per-child output files validated by codemode, stopping on failure or missing prerequisites. |

Running the new skill starts fresh work—earlier workflow run IDs cannot resume old checkpoints. Verify which external side effects already ran before repeating them. See [What survives interruption?](/orchestration#what-survives-interruption).

### Pinned stages

When a stage pinned `fallbackModels`, exact `tools`, or `mcp` servers, conversion writes a companion agent file in `.atomic/agents/` (project) or `~/.atomic/agent/agents/` (global) without overwriting existing agents, and asks before adding any MCP server to config:

```markdown
---
name: triage-reviewer
description: Review one triage report and classify it
model: anthropic/claude-sonnet-4:high
fallbackModels: openai/gpt-5:medium
tools: read, search, mcp:issue-tracker
---

Classify the report you are given as bug, feature, or question, with file:line evidence.
```

The skill launches it without a `model` override so the agent's pins apply:

```js
const launch = await tools.subagent({ agent: "triage-reviewer", task: report });
```

Package maintainers can ask Atomic to place the skill and agents directly in the package's [`agents` manifest field](/packages/authoring#subagents), where they run as `<namespace>.<name>` (for example `acme.triage.triage-reviewer`).

## If you used a builtin name

- `classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `generate-and-filter`, `tournament`, `loop-until-done` → use the matching [orchestration pattern](/orchestration/patterns).
- `ralph` → research, implementation, and review loop in the parent chat with an explicit round limit.
- `goal` → combine [loop-until-done](/orchestration/patterns#loop-until-done) with [adversarial verification](/orchestration/patterns#adversarial-verification).
- `open-claude-design` → `/skill:impeccable` with your design brief and target artifact.

## Old data on disk

Old workflow data is safe to leave alone. To reclaim space, back it up and stop any older Atomic binaries first, then remove only workflow-only directories under `~/.atomic/workflows/`:

- Safe to delete if unused: `runs/`, `pool/`, and `journal/`.
- **Do not delete:** `~/.atomic/workflows/journal.sqlite` (and its sidecar files—they store sessions), the entire `~/.atomic/workflows/` directory, shared databases, or your workflow source files. Custom storage paths may differ.
