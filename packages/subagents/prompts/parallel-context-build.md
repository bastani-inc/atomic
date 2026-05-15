---
description: Parallel codebase specialists building handoff context for planning
---

Launch fresh-context codebase specialists in parallel to build grounded handoff context for planning or implementation.

Use the `subagent` tool in chain mode with a single parallel step, not top-level parallel tasks, so relative output files live under the temporary chain directory. Use `context: "fresh"` unless I explicitly ask for forked context. Give every parallel task a distinct `output` path, for example:

- `context-build/where-it-lives.md`
- `context-build/how-it-works.md`
- `context-build/existing-patterns.md`
- `context-build/prior-research.md`

Do not write these artifacts into the repository unless I explicitly ask for persistent files.

Treat the slash command arguments as the primary request, target, or focus:

$@

If the invocation provides a URL, issue link, file path, plan path, or freeform request, read or fetch that target before assigning angles, then pass the target explicitly into every subagent task.

Choose two to four specialists based on the request. These are examples, not fixed defaults:

1. Locate — `codebase-locator`
   Find every file, directory, test, fixture, config, and doc that touches the change. Group by purpose and return full paths from repo root.

2. Analyze — `codebase-analyzer`
   Explain how the relevant feature or flow currently works. Trace entry points, control flow, data transformations, side effects, and error handling with `file:line` citations.

3. Pattern-find — `codebase-pattern-finder`
   Surface comparable implementations, test patterns, and conventions already in the codebase that the next agent should model after.

4. Prior research — `codebase-research-locator` followed by `codebase-research-analyzer`
   When the topic has history in `research/` or `specs/`, locate relevant prior docs and then extract the decisions, constraints, and rationale that still apply.

Adapt the specialists when the request calls for it:

- Issue or PR URL: include locator and analyzer for files mentioned in the linked discussion.
- Plan file: include locator (files mentioned by the plan) and analyzer (current behavior of those files).
- External API/library work: add `codebase-online-researcher` for current docs or primary sources.
- Large refactor: lean on `codebase-pattern-finder` for module-boundary and dependency-direction examples.
- UI/product work: add `codebase-pattern-finder` for analogous components and `codebase-analyzer` for the surrounding render path.

Ask each specialist to produce a compact handoff file with the information their role uniquely provides — locator returns file maps, analyzer returns flow narratives with `file:line` refs, pattern-finder returns code snippets, research agents return decision histories. Each file should end with a short `## Open Questions` section.

None of these specialists should edit files. This is a read-only context-build pass.

After the specialists return, synthesize their outputs yourself into:

- the most important context the next agent needs;
- a compact implementation-ready meta-prompt for the next planner or writer;
- open questions or assumptions;
- the output artifact paths.

Do not start implementation from this command unless I explicitly ask for it.
