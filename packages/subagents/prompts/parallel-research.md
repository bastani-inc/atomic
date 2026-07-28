---
description: Parallel research specialists for grounded answers
---

## Goal

Build a grounded answer to the current question or decision from distinct external, local, convention, or prior-decision evidence.

Primary question or focus:

$@

## Constraints and tools

Use fresh context unless I explicitly request forked context; specialists inspect sources directly rather than relying on the main conversation. Choose two or three strong specialists with distinct applicable angles, using my specified angles when provided:

- **External evidence — `codebase-online-researcher`:** current authoritative sources such as official docs, standards, release notes, benchmarks, issue threads, and primary explanations.
- **Local context — `codebase-locator` and/or `codebase-analyzer`:** relevant repository files and how they work, with `file:line` references.
- **Local conventions — `codebase-pattern-finder`:** analogous implementations and patterns the answer should respect.
- **Prior decisions — `codebase-research-locator` then `codebase-research-analyzer`:** applicable decisions and constraints from `research/` or `specs/`, with locator preceding analyzer.

For library/API questions, include official docs and recent examples. For architecture decisions, cover module boundaries and dependency direction. For debugging, cover call paths and authoritative information about the error. For UI/product questions, cover analogous components and design precedent. For time-sensitive topics, have the online researcher prefer 2026/2025 sources and persist findings to `research/web/`.

This is read-only research unless I explicitly request implementation. Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

## Output

Each specialist returns concise evidence: local paths and line ranges or external links, confidence and gaps, and the decision implication or next step. Synthesize a user-facing answer of roughly 400–800 words covering what is known, local implications, tradeoffs and risks, gaps or assumptions, and the recommended move. Name disagreements rather than smoothing them over. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means applicable specialists have returned direct evidence and the synthesis answers the question, identifies material uncertainty or disagreement, and recommends the next move. Do not edit files unless implementation was explicitly requested.
