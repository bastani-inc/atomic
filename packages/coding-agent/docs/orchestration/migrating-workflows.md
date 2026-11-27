---
title: "Migrate an earlier workflow to a skill"
sidebarTitle: "Migrate workflows"
description: "Convert legacy Atomic workflow files into reusable skills without executing or modifying the originals."
---

Convert legacy `.ts`, `.js`, `.mjs`, or `.cjs` workflow files into reusable [skills](/skills#skills-as-workflows) without importing, running, or modifying the original files.

<Steps>
  <Step title="Start the conversion">
    Ask Atomic in chat or invoke `/skill:workflow-files` with the workflow path:

    ```text
    Convert .atomic/workflows/triage.ts into a skill
    ```

    ```text
    /skill:workflow-files .atomic/workflows/triage.ts
    ```

    To convert and run immediately, include your inputs (for example, "Run the triage workflow on these reports").
  </Step>
  <Step title="Review the generated skill and scripts">
    Atomic reads the workflow file and any local helpers as plain text and generates a new `SKILL.md` plus deterministic helper scripts under `scripts/`. It never imports, executes, edits, or deletes the original workflow file, and never overwrites an existing skill directory or follows symlinks into an occupied target path.
  </Step>
  <Step title="Reload and invoke">
    Run `/reload`, then invoke `/skill:<name>` with your inputs.
  </Step>
</Steps>

At startup, Atomic scans directly inside `workflows/` directories for legacy `.ts`, `.js`, `.mjs`, and `.cjs` files (excluding `.d.ts` files and subdirectories) and notes up to 20 discovered files (`+N more` if additional files exist). Nothing is converted or written automatically.

Workflow files in untrusted projects are never offered for conversion, and Atomic never writes into an untrusted project directory. Global workflows still convert; for an explicitly supplied trusted external source inside an untrusted project, Atomic asks before saving globally.

| Workflow source | Output skill location |
| --- | --- |
| Trusted project `.atomic/workflows/`, `.pi/workflows/`, project settings paths, project-installed packages | `.atomic/skills/<name>/` |
| `~/.atomic/agent/workflows/`, global settings paths, globally installed packages | `~/.atomic/agent/skills/<name>/` (or `skills/` in your agent directory) |
| Package loaded via `-e`, or a trusted external project directory | Current trusted project's `.atomic/skills/<name>/` (never the external tree) |

## What conversion preserves

| Earlier workflow API | Equivalent in the converted skill |
| --- | --- |
| `ctx.stage`, `ctx.task`, model and thinking | Codemode `tools.subagent()` launches in the main chat that keep prompts, inputs, and model pins. |
| Stage `fallbackModels`, `tools`, `mcp` | Named [custom subagent](/subagents/authoring) launched without per-call `model` ([Pinned stages](#pinned-stages)). |
| `ctx.parallel`, loops, retries | `tasks` batches, explicit round caps, and checks between notices (plus [Intercom](/intercom) `group` for peers). |
| `ctx.tool`, deterministic helpers | Reviewed scripts in `scripts/` with validated args, timeouts, and exit checks. |
| Inputs, `ctx.ui`, approvals | Skill arguments and defaults plus `ask_user_question` steps (an unanswered approval is never a pass). |
| Nested `ctx.workflow` | Separately converted skill called by name (the main session still owns all subagent launches). |
| Structured outputs, `ctx.exit`, blocked states | Per-subagent output files validated by codemode, stopping on failure or missing prerequisites. |

Running the new skill starts fresh work; earlier workflow run IDs cannot resume old checkpoints. Verify which external side effects already ran before repeating them ([What survives interruption](/orchestration#what-survives-interruption)).

### Pinned stages

When a stage pinned `fallbackModels`, exact `tools`, or `mcp` servers, conversion writes a companion agent file in `.atomic/agents/` (project) or `~/.atomic/agent/agents/` (global) without overwriting existing agents. Conversion never copies MCP secrets into agent definitions, and asks before adding any MCP server to config:

```markdown
---
name: triage-reviewer
description: Review one triage report and classify it
model: anthropic/claude-sonnet-4-6:high
fallbackModels: openai/gpt-5:medium
tools: read, search, mcp:issue-tracker
---

Classify the report you are given as bug, feature, or question, with file:line evidence.
```

Both comma-separated strings and YAML lists work for `fallbackModels` and `tools` in agent frontmatter. The skill launches the agent without a `model` override so the agent's pins apply:

```js
const launch = await tools.subagent({ agent: "triage-reviewer", task: report });
```

Package maintainers can ask Atomic to place the skill and agents directly in the package's [`agents` manifest field](/packages/authoring#subagents), where they run as `<namespace>.<name>` (derived from `package.json` `name`, so `@acme/triage` becomes `acme.triage.triage-reviewer`).

## Replacing removed built-in workflows

- `classify-and-act`, `fan-out-and-synthesize`, `adversarial-verification`, `generate-and-filter`, `tournament`, and `loop-until-done` map to the matching [orchestration patterns](/orchestration/patterns).
- `ralph` maps to a research, implementation, and review loop in the main chat with an explicit round limit.
- `goal` maps to combining [loop-until-done](/orchestration/patterns#loop-until-done) with [adversarial verification](/orchestration/patterns#adversarial-verification).
- `open-claude-design` maps to `/skill:impeccable` with your design brief and target artifact.

## Old data on disk

Old workflow data is safe to leave alone. To reclaim space, back it up and stop any older Atomic binaries first, then remove only workflow-only directories under `~/.atomic/workflows/`:

- Safe to delete if unused: `runs/`, `pool/`, and `journal/`.

<Warning>
Do not delete `~/.atomic/workflows/journal.sqlite` or its sidecar files (they store your Atomic sessions), the entire `~/.atomic/workflows/` directory, shared databases, or your workflow source files. Custom storage paths may differ. See [Workflow data from earlier releases](/storage#workflow-data-from-earlier-releases) for details on what Atomic keeps and ignores.
</Warning>
