# Claude Opus 4.8 prompting

Use this reference for Opus 4.8 effort, literal instruction following, tool use, and design defaults. Distilled from [Anthropic's Opus 4.8 prompting guide](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-4-8), checked September 5, 2026. Existing Opus 4.7 prompts are a starting point; Opus 5 has different defaults, so use its separate guide when migrating onward.

## Set effort and thinking deliberately

Start at `xhigh` for coding and agentic work. Use at least `high` for most intelligence-sensitive tasks. Evaluate `max` for difficult work, watching for diminishing returns and overthinking. `medium` trades capability for cost; reserve `low` for short, scoped, latency-sensitive tasks.

Opus 4.8 follows low effort strictly and can under-investigate moderately complex work. Raise effort before adding elaborate reasoning instructions. If latency requires low effort, add a targeted instruction for the missing behavior and evaluate it.

Thinking is off unless the request explicitly sets `thinking: {type: "adaptive"}`. This differs from Opus 5 and Sonnet 5. With adaptive thinking enabled, effort is the first tuning lever; use task-specific prompting only when triggering remains poorly calibrated. Do not request private reasoning as visible response text.

## State scope literally

The model may apply an instruction only to the item named, especially at low effort. Specify the full scope when a rule applies across a document, set of files, or pipeline. Give the goal, intent, constraints, and authorized actions in the initial request rather than relying on later corrections to assemble the task.

```text
Apply the requested formatting to every section of the report. Preserve the factual claims and citations. Return the revised report within 800 words. Ask only if a missing decision prevents that result; do not add sections or change publication state.
```

Clear initial specifications can reduce unnecessary user turns in coding products. This is not a reason to remove required approvals or discourage a genuinely blocking question.

## Tune tools and communication

Opus 4.8 can favor reasoning over tool calls. If it misses required search or retrieval, explain when the tool is needed and what evidence it supplies. `high` and `xhigh` also tend to increase tool use. Avoid a universal search mandate for tasks that need no current evidence.

The model generally provides regular progress updates. Remove forced rules such as updates after every fixed number of tool calls when they duplicate that behavior. Describe useful updates and provide a positive example if their cadence or detail is wrong.

Response length follows perceived task complexity. Give explicit length and style expectations for open-ended analysis. Its default voice is direct and opinionated; specify warmth or conversational tone where the product requires it.

## Encourage useful delegation

Opus 4.8 spawns fewer subagents by default. If the host supports collaboration, identify independent tasks worth delegating, define ownership and expected evidence, and keep dependent work sequential. Do not import Opus 5's delegation damping as a universal rule for this model.

## Specify design alternatives

Open-ended designs can settle into cream backgrounds, serif headings, italic accents, and terracotta or amber. Generic bans may only substitute another fixed palette. Supply concrete colors, typography, spacing, component behavior, and reference examples when the brief requires a different style.

If choosing a direction is part of the task, request distinct options before implementation:

```text
Propose three visual directions for this enterprise dashboard, each with a palette, typography, and density rationale. Use the existing accessibility requirements. Wait for the requested design selection before implementing.
```

Use this approval step only when the user wants to choose; otherwise specify the authorized decision rule. Remove older, lengthy anti-generic design instructions if smaller concrete guidance performs better. Prompt for variety rather than relying on inherited sampling settings.

## Preserve code-review recall

Broad instructions such as "be conservative" or "only important issues" can suppress valid lower-severity findings. If coverage is the review stage's goal, separate supported bug discovery from later ranking and deduplication. If only one pass is available, specify a concrete threshold such as incorrect behavior, test failure, or misleading output, while excluding pure style preferences. Preserve explicit user severity limits.

## Computer use and validation

The source lists `computer_toolset_20260801` and `browser_toolset_20260801` on the Claude API and Google Cloud, plus the earlier `computer_20251124` computer tool. Verify provider and host support before using these versions. Tool availability in the API does not establish Atomic support.

For computer-use screenshots, the guide reports 1080p as a useful performance/cost balance; evaluate 720p or 1366×768 for cost-sensitive work. It describes a maximum of 2576px / 3.75MP. Select image detail and effort against actual task accuracy rather than increasing either blindly.

Test literal scope, tool triggering, review recall, and design adherence on representative cases. Measure effort changes separately from prompt changes, and retain required checks and permission boundaries throughout.
