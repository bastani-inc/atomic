---
description: Parallel external + local research builders into an implementation handoff plan
---

Use parallel subagents to understand the request, compare any external references, inspect the local codebase, and produce a grounded implementation handoff plan with a final implementation-ready meta-prompt.

Primary request, target, or focus:

$@

Use `context: "fresh"` unless I explicitly ask for forked context. First read or fetch any URLs, issue links, PRs, screenshots, plans, docs, or local files mentioned in the request. Treat them as primary scope, not optional context.

Use the `subagent` tool in chain mode. The chain has one parallel discovery step followed by a parent-side synthesis pass (there is no dedicated synthesizer subagent in this skill):

Parallel discovery step. Choose the specialists that apply:

- `codebase-online-researcher` — required whenever the request mentions external projects, libraries, docs, APIs, recent changes, or best-practice guidance. It web-searches, fetches authoritative sources, and persists keepers under `research/web/`.
- `codebase-locator` — required for any non-trivial code change. Find the local files, tests, fixtures, and configs the change would touch.
- `codebase-analyzer` — required when the local behavior matters. Trace the relevant flow with `file:line` references.
- `codebase-pattern-finder` — add when transferable conventions or analogous implementations would shape the plan.
- `codebase-research-locator` and `codebase-research-analyzer` — add when prior `research/` or `specs/` docs likely apply. Run them sequentially (locator first, then analyzer) or pair them inside the parallel step with distinct output paths.

Use distinct output paths under the chain directory. Example outputs:

- `handoff/external-reference.md`
- `handoff/local-files.md`
- `handoff/local-flow.md`
- `handoff/local-patterns.md`
- `handoff/prior-research.md`

Do not write these artifacts into the repository unless I explicitly ask for persistent files.

Role guidance:

External researcher (`codebase-online-researcher`):

- Study linked projects, docs, issues, examples, source code, or prompt guidance.
- Identify the behavior, API, implementation files, constraints, and transferable ideas.
- Use `fetch_content` first, then `/llms.txt`, then `Accept: text/markdown`, and only fall back to `playwright-cli` when JS execution or auth is required.
- Persist any high-value fetch to `research/web/<YYYY-MM-DD>-<topic>.md`.
- Return source links, repo paths, key evidence, risks, and what matters for this implementation.

Local locator + analyzer (`codebase-locator`, `codebase-analyzer`):

- Locator returns the full file map grouped by purpose.
- Analyzer reads the located files and traces the current implementation, control flow, transformations, and constraints with `file:line` citations.
- Together they cover "where it lives" and "how it works today" without overlap.

Local pattern-finder (`codebase-pattern-finder`), when used:

- Find similar implementations or conventions worth modeling after. Include working snippets with `file:line` references.

Prior research (`codebase-research-locator` → `codebase-research-analyzer`), when used:

- Locator surfaces the relevant dated docs from `research/` and `specs/`.
- Analyzer extracts the decisions, constraints, and lessons that are still applicable, flagging anything superseded by newer docs.

Parent-side synthesis after the discovery step returns:

- Compare external evidence against the local architecture.
- Propose the safest implementation shape, the likely files to change, edge cases, validation commands, and decisions that need approval.
- Write `handoff/final-handoff-plan.md` yourself, or summarize inline if I didn't ask for a persisted artifact.

Include in the final handoff:

- what the feature or change should do;
- what the external reference teaches;
- what the local codebase implies;
- the recommended approach;
- likely files to change;
- constraints, non-goals, validation, risks;
- unresolved questions;
- a compact implementation-ready meta-prompt for the next writer.

After the chain returns, summarize the result for me with the recommended approach, artifact paths, the final meta-prompt, and any questions or assumptions that remain.

Do not start implementation from this command unless I explicitly ask for it.
