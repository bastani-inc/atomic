---
description: Parallel external + local research builders into an implementation handoff plan
---

## Goal

Produce a grounded implementation handoff plan and implementation-ready meta-prompt by comparing applicable external evidence, local behavior, established patterns, and prior decisions.

Primary request, target, or focus:

$@

## Constraints and tools

First read or fetch every URL, issue, PR, screenshot, plan, doc, or local file named in the request; these define primary scope. Use the `subagent` tool in chain mode with `context: "fresh"` unless I explicitly request forked context. Run one parallel discovery step, then synthesize parent-side rather than launching a synthesizer subagent.

Choose specialists by evidence need:

- Use `codebase-online-researcher` when external projects, libraries, docs, APIs, recent changes, or best practices could shape the plan. It should inspect linked projects, docs, issues, examples, source, or prompt guidance; identify behavior, APIs, implementation files, constraints, and transferable ideas; use `fetch_content` first, then `/llms.txt`, then `Accept: text/markdown`, and fall back to `browser` only for required JS or auth; persist high-value sources to `research/web/<YYYY-MM-DD>-<topic>.md`; and return links, repo paths, evidence, risks, and implementation implications.
- Use `codebase-locator` for non-trivial code changes to map relevant local files, tests, fixtures, and configs by purpose.
- Use `codebase-analyzer` when local behavior matters to trace the located implementation, control flow, transformations, and constraints with `file:line` citations. Locator and analyzer cover where the work lives and how it works without overlap.
- Add `codebase-pattern-finder` when analogous implementations or conventions could shape the plan; include useful snippets with `file:line` references.
- Add `codebase-research-locator` then `codebase-research-analyzer` when prior `research/` or `specs/` may apply. The locator finds relevant dated docs; the analyzer extracts current decisions, constraints, and lessons while flagging superseded guidance. Run them sequentially, or pair them in the parallel step with distinct outputs when the dependency is already resolved.

Give tasks distinct `output` paths, `label` values, and `as` names under the chain directory, for example:

- `handoff/external-reference.md`
- `handoff/local-files.md`
- `handoff/local-flow.md`
- `handoff/local-patterns.md`
- `handoff/prior-research.md`

Use phases such as `Research`, `Local context`, and `Synthesis` for readable async status. In synthesis, prefer `{outputs.externalReference}`, `{outputs.localContext}`, and `{outputs.implementationStrategy}` when available; use `{previous}` only for the whole parallel fan-in. Do not persist these artifacts in the repository unless I explicitly request it.

Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

## Output

Compare external evidence with local architecture and write `handoff/final-handoff-plan.md` yourself, or summarize inline when no persisted artifact was requested. The downstream writer needs roughly 700–1,200 words covering: intended behavior; lessons from external references; local implications; recommended approach; likely files; constraints and non-goals; edge cases, validation commands, risks, and approval decisions; unresolved questions; and a compact implementation-ready meta-prompt.

Then give the user a concise summary with the recommendation, artifact paths, final meta-prompt, and remaining questions or assumptions. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means discovery evidence has been compared, the final handoff exists at the requested destination or inline, and the user has the recommendation, paths, meta-prompt, and unresolved decisions. Do not start implementation unless I explicitly ask.
