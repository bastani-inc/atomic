---
title: "Convert an earlier workflow into a skill"
description: "Keep the procedure in a reusable skill without running or changing the old workflow file."
---

# Convert an earlier workflow into a skill

Ask **“Convert `.atomic/workflows/triage.ts` into a skill”** or use `/skill:workflow-files .atomic/workflows/triage.ts`. To both convert and run it, say what inputs to use: **“Run the triage workflow on these reports.”** Startup can tell you that files exist, but doesn't write anything. If more than one file matches, give the path.

The parent reads the definition and its helpers as text. It uses `skill-creator` to write a `SKILL.md` with the procedure and `scripts/` for deterministic work. The original file is never imported, executed, modified, or deleted during conversion. If a skill of that name already exists, choose another name or ask to use the existing skill; conversion must not overwrite it.

| Where the workflow came from | Where the skill goes |
| --- | --- |
| Trusted project `.atomic/workflows/` or `.pi/workflows/`, project settings paths, project-installed packages | `.atomic/skills/<name>/` in the current project |
| `~/.atomic/agent/workflows/`, global settings paths, globally installed packages | `~/.atomic/agent/skills/<name>/` (or `skills/` in your configured agent directory) |
| A package supplied with `-e`, or a trusted borrowed project folder | The current trusted project's `.atomic/skills/<name>/`, never the external source tree |

An untrusted project's own files aren't offered for conversion. You can still convert your global workflows. If you explicitly supplied a trusted external source but the current project is untrusted, Atomic can offer to save globally instead; it should ask you first.

Review the new skill and its scripts. Use `/reload`, then `/skill:<name>` with your inputs. From then on the skill, not the TypeScript file, is the reusable procedure. See [skills as workflows](/skills#skills-as-workflows) and [orchestration with codemode](/orchestration).

## What conversion preserves

| Earlier definition | In the new skill |
| --- | --- |
| `ctx.stage`, `ctx.task`, pinned model and thinking level | Steps launching subagents from codemode in the parent chat, with the original prompt, inputs, and model requirements. |
| Stage `fallbackModels`, `tools`, and `mcp` servers | A named [custom subagent](/subagents/authoring) that pins them, launched by name with no per-call `model`. See [Pinned stages](#pinned-stages). |
| `ctx.parallel`, loops, retries | `tasks` batches, explicit round limits and checks between completion notices. Use an Intercom `group` when peers communicate. |
| `ctx.tool`, deterministic helpers | Reviewed scripts in `scripts/`, called with validated arguments, original timeouts and success checks. |
| Inputs, `ctx.ui`, human approval | Skill arguments and defaults; `ask_user_question` steps for missing information or decisions. A missing approval is not a pass. |
| Nested `ctx.workflow` | A separately converted skill referenced by name. The parent still owns every subagent launch. |
| Structured results, `ctx.exit` and blocked states | Per-child output files; codemode parses and validates them, preserves the output shape, and stops on failure or a missing prerequisite. |

**Running the skill starts new work.** An old workflow run ID cannot resume a checkpoint. Confirm which external actions already happened before repeating any. New children have saved sessions; their orchestration script does not replay. See [recovery](/orchestration#what-survives-interruption).

### Pinned stages

When a stage pinned more than a model, the conversion writes an agent definition next to the skill, in `.atomic/agents/` for a project skill or `~/.atomic/agent/agents/` for a global one. The agent carries the effort on `model` and each `fallbackModels` entry, the stage's exact `tools`, and `mcp:<server>` (or `mcp:<server>/<tool>`) for each MCP server the stage used. It never overwrites an existing agent, and asks before adding an MCP server to your configuration.

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

The skill launches it from codemode without a `model`, so the agent's model and fallback chain apply:

```js
const launch = await tools.subagent({ agent: "triage-reviewer", task: report });
```

If you maintain the package the workflow came from, you can ask Atomic to add the skill and its agents to the package source instead. The agents go in its [`agents` manifest field](/packages/authoring#subagents) and run as `<namespace>.<name>`: in a package named `@acme/triage`, this agent would be `acme.triage.triage-reviewer`.

## If you used a builtin name

`classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `generate-and-filter`, `tournament`, and `loop-until-done` map to the [patterns of the same name](/orchestration/patterns). For `ralph`, give the parent a research, implementation, and review loop with a round limit. For `goal`, combine [loop-until-done](/orchestration/patterns#loop-until-done) with [adversarial verification](/orchestration/patterns#adversarial-verification) against the original objective. For `open-claude-design`, use `/skill:impeccable` with a design brief and the artifact you want. These instructions don't need an old file or start a registered workflow.

## Old data on disk

Leaving old data in place is safe. If you choose to reclaim space, first back it up and stop any earlier Atomic version using it. In the default local store, the old run artifacts are under `~/.atomic/workflows/runs/`, the worker pool under `~/.atomic/workflows/pool/`, and the workflow journal shards under `~/.atomic/workflows/journal/`. Remove only the workflow-only directories you no longer need. **Keep `~/.atomic/workflows/journal.sqlite` and its sidecar files: they also hold sessions.** Do not remove the whole `~/.atomic/workflows/` directory, a shared database, or the workflow files themselves. Custom storage paths can differ.
