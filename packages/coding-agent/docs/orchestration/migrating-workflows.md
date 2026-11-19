---
title: "Use an earlier workflow file"
description: "Turn an old Atomic workflow definition into a task for the parent chat without executing its module."
---

# Use an earlier workflow file

Ask **“Read `.atomic/workflows/triage.ts` and carry out its steps on these reports”**, or give the path to `/skill:workflow-files`. Interactive startup can flag earlier files in trusted project `.atomic/workflows/` (or `.pi/workflows/`), `~/.atomic/agent/workflows/`, configured workflow paths, and enabled packages. A notice doesn't run anything. If more than one file matches, name the path you mean.

The parent reads the definition and any relevant helpers **as text**. It confirms missing inputs, follows branches and stop conditions, and uses the tools available in this session. The file is not imported or rewritten. To reuse its instructions without the TypeScript, turn them into a [skill](/skills#skills-as-workflows).

| Earlier definition | How the task works now |
| --- | --- |
| `ctx.stage`, `ctx.task` | Launch a child with the stage prompt and its inputs. Pass the original model when it is available and required. |
| `ctx.parallel`, `Promise.all` | Launch independent children together with `tasks`. Join on their actual results. Use an Intercom `group` when they need to communicate. |
| `ctx.tool` | Use a permitted direct tool or codemode call with the original timeout and success check. |
| Output schema | Ask the child for JSON, parse it, and check its required fields before using it. |
| Approval, `ctx.exit`, blocked state | Ask the user for the decision, or stop and report what is missing. Don't turn a blocked step into a pass. |

**This starts a new task.** An old workflow run ID cannot resume an old checkpoint. Confirm which external actions already happened before repeating any. Each new child has a saved session, but the JavaScript orchestrating the work does not replay; see [recovery](/orchestration#what-survives-interruption).

## If you used a builtin name

`classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `generate-and-filter`, `tournament`, and `loop-until-done` map to the [patterns of the same name](/orchestration/patterns). For `ralph`, give the parent a research, implementation, and review loop with a round limit. For `goal`, combine [loop-until-done](/orchestration/patterns#loop-until-done) with [adversarial verification](/orchestration/patterns#adversarial-verification) against the original objective. For `open-claude-design`, use `/skill:impeccable` with a design brief and the artifact you want. These instructions don't need an old file or start a registered workflow.

## Old data on disk

Leaving old data in place is safe. If you choose to reclaim space, first back it up and stop any earlier Atomic version using it. In the default local store, the old run artifacts are under `~/.atomic/workflows/runs/`, the worker pool under `~/.atomic/workflows/pool/`, and the workflow journal shards under `~/.atomic/workflows/journal/`. Remove only the workflow-only directories you no longer need. **Keep `~/.atomic/workflows/journal.sqlite` and its sidecar files: they also hold sessions.** Do not remove the whole `~/.atomic/workflows/` directory, a shared database, or the recipe files you want to keep. Custom storage paths can differ.
