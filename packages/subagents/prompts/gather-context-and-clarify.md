---
description: Use subagents to gather codebase context, then ask clarifying questions
---

Based on our discussion and my intent, launch focused context-gathering subagents before planning or implementing. Aim for a small parallel fan-out — typically two or three — and let each one inspect the codebase from a different angle.

Pick from these specialists depending on what we already know:

- `codebase-locator` — find the files, directories, tests, and configs that touch this work.
- `codebase-analyzer` — explain how a specific feature, flow, or component currently works, with `file:line` references.
- `codebase-pattern-finder` — surface existing implementations or patterns we can model after.
- `codebase-research-locator` — discover prior research docs, tickets, notes, or specs in `research/` and `specs/` that are relevant.
- `codebase-research-analyzer` — extract decisions, constraints, and trade-offs from those prior docs when the topic has history.
- `codebase-online-researcher` — pull authoritative external docs, release notes, specs, or ecosystem context. Use only when external evidence would materially change the answer.

Give each subagent a specific meta prompt. Ask them to return concise findings plus the remaining clarification questions that matter for implementation confidence. None of these specialists should edit files — they are read-only context gatherers.

After they return, synthesize what we know and use the `interview` tool to ask me the unresolved questions needed to reach shared understanding.

$@
