---
description: Parallel research specialists for grounded answers
---

Launch parallel research specialists to build a grounded answer to the current question or decision.

Use fresh context, not forked context, unless I explicitly ask for forked context. Specialists should inspect sources directly instead of relying on the main conversation history.

Choose specialists based on the question:

- `codebase-online-researcher` — web, docs, standards, ecosystem, recent changes, benchmarks, and primary-source evidence.
- `codebase-locator` — repository files that touch the question.
- `codebase-analyzer` — how the relevant code currently works, with `file:line` references.
- `codebase-pattern-finder` — comparable implementations or conventions already in the codebase.
- `codebase-research-locator` and `codebase-research-analyzer` — prior `research/` or `specs/` docs that bear on the question (run locator first, then analyzer).

Give each specialist a distinct angle. Unless I specify angles, use three of these (skip the ones that don't apply):

1. External evidence — `codebase-online-researcher`
   Find current, authoritative sources: official docs, specs, release notes, benchmarks, issue threads, or primary explanations.

2. Local code context — `codebase-locator` and/or `codebase-analyzer`
   Locate the relevant files and trace how they work today.

3. Local conventions — `codebase-pattern-finder`
   Surface analogous implementations or patterns the answer should respect.

4. Prior decisions — `codebase-research-locator` followed by `codebase-research-analyzer`
   When the topic has history in `research/` or `specs/`, extract the decisions and constraints that still apply.

Adapt the angles when the question calls for it:

- Library/API questions: include `codebase-online-researcher` for official docs and recent examples.
- Architecture decisions: include `codebase-locator` and `codebase-pattern-finder` for module boundaries and dependency direction.
- Debugging questions: include `codebase-analyzer` for call paths and `codebase-online-researcher` for the error message.
- UI/product questions: include `codebase-pattern-finder` for analogous components and `codebase-online-researcher` for design precedent.
- Time-sensitive topics: have the online researcher prefer 2026/2025 sources and persist findings to `research/web/`.

Prefer two or three strong specialists over many vague ones. None of these agents should edit files — this is a research pass only unless I explicitly ask for implementation.

Ask each specialist to return concise findings with evidence:

- file paths and line ranges for local findings;
- source links for external findings;
- confidence level and gaps;
- recommended next step or decision implication.

After the specialists return, synthesize the answer into:

- what we know;
- what the local codebase implies;
- tradeoffs and risks;
- gaps or assumptions;
- the recommended next move.

If findings disagree, call out the disagreement instead of smoothing it over.

$@
