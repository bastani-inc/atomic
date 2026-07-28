---
description: Use subagents to gather codebase context, then ask clarifying questions
---

## Goal

Build enough grounded codebase context to ask only the unresolved questions needed before planning or implementation. Use a small parallel fan-out, typically two or three specialists with distinct angles.

Additional request context:

$@

## Constraints and tools

Choose specialists according to what is unknown: `codebase-locator` for relevant files, directories, tests, and configs; `codebase-analyzer` for current behavior with `file:line` references; `codebase-pattern-finder` for implementations or patterns to model; `codebase-research-locator` for relevant prior docs, tickets, notes, or specs in `research/` and `specs/`; `codebase-research-analyzer` for applicable historical decisions, constraints, and trade-offs; and `codebase-online-researcher` for authoritative external evidence only when it could materially change the answer.

Give each specialist a specific meta-prompt and keep every specialist read-only. Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

## Output

Synthesize a concise, user-facing brief of roughly 300–600 words: established facts with evidence, remaining implementation-relevant uncertainties, and focused questions. Then use the `interview` tool to ask those unresolved questions so we reach shared understanding. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means the specialists have returned concise findings and remaining clarification questions, their evidence has been synthesized, and the unresolved questions have been sent through `interview`. Do not plan or implement in this step.
