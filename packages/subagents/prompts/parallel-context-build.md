---
description: Parallel codebase specialists building handoff context for planning
---

## Goal

Build grounded, implementation-ready handoff context for the next planner or writer without starting implementation.

Primary request, target, or focus:

$@

## Constraints and tools

Use the `subagent` tool in chain mode with one parallel step so relative outputs stay under the temporary chain directory. Use `context: "fresh"` unless I explicitly request forked context. Give every task a distinct `output` path, `label`, and `as` name, such as:

- `context-build/where-it-lives.md`
- `context-build/how-it-works.md`
- `context-build/existing-patterns.md`
- `context-build/prior-research.md`

Use one phase such as `phase: "Context build"` so async status is readable. A synthesis step can cite `{outputs.requestScope}`, `{outputs.codebasePatterns}`, and `{outputs.validationRisks}` when available, using `{previous}` only for the whole fan-in. Do not persist context artifacts in the repository unless I explicitly request it.

Read or fetch any supplied URL, issue link, file path, plan path, or freeform request before assigning angles, and pass that target into every specialist task. Choose two to four specialists according to the request:

- **Locate — `codebase-locator`:** map every relevant file, directory, test, fixture, config, and doc by purpose, using full repo-root paths.
- **Analyze — `codebase-analyzer`:** trace entry points, control flow, data transformations, side effects, and error handling with `file:line` citations.
- **Pattern-find — `codebase-pattern-finder`:** provide comparable implementations, test patterns, conventions, and useful code snippets.
- **Prior research — `codebase-research-locator` then `codebase-research-analyzer`:** when `research/` or `specs/` history applies, locate it before extracting current decisions, constraints, and rationale.

For an issue or PR URL, include locator and analyzer coverage of mentioned files. For a plan, cover its files and their current behavior. For external API/library work, add `codebase-online-researcher` for current primary sources. For a large refactor, emphasize module-boundary and dependency-direction patterns. For UI/product work, cover analogous components and the surrounding render path.

Every specialist is read-only and produces a compact handoff file containing only its unique contribution, ending with `## Open Questions`. Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

## Output

Synthesize the artifacts for the downstream planner or writer into roughly 500–900 words: the most important context, a compact implementation-ready meta-prompt, open questions or assumptions, and artifact paths. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means the selected specialists have returned their distinct handoff files and the downstream synthesis names its evidence and artifact paths. Do not implement unless I explicitly ask.
