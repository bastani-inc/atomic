---
date: 2026-08-07 13:54:13 UTC
researcher: Claude Opus 5
git_commit: 3090c32597567c4358ddb3feccfae01fb3e725c4
branch: remove-subagent-chain
repository: atomic-monorepo
topic: "@bastani/subagents CHAIN removal and the resulting divergence from upstream pi-subagents"
tags:
    [
        research,
        codebase,
        subagents,
        chain-removal,
        upstream-divergence,
        breaking-change,
    ]
status: complete
last_updated: 2026-08-07
last_updated_by: Claude Opus 5
---

# Subagents CHAIN removal — upstream divergence record

## Why this file exists

`@bastani/subagents` removed CHAIN execution mode entirely on branch `remove-subagent-chain`; the
`git_commit` above is `3090c3259`, the commit that performed the removal. Later commits on the branch
repair regressions and documentation but do not change what this record describes.
Several dated specs and RFCs in `specs/` describe pi-subagents as having a chain mode. Those
documents are historical records of decisions taken at their own dates and are deliberately left
byte-identical to their pre-removal state. This is the new dated record that supersedes their
subagent-chain claims, rather than a rewrite of them.

## What was removed

From the `subagent` tool in `packages/subagents`:

- the `chain` parameter and its TypeBox schema, plus `chainName` and `chainDir`;
- sequential chain steps, and static parallel steps nested inside a chain (`{parallel: [...]}`);
- dynamic fan-out steps (`expand` / `collect` / `as` / `{outputs.name}`), **not** ported to
  top-level PARALLEL mode;
- the chain template variables `{previous}` and `{chain_dir}`, and chain-scoped `{task}` substitution;
- saved chain definitions (`.chain.md` / `.chain.json`), their discovery, parsing, serialization,
  and management actions;
- the `/chain` and `/run-chain` slash commands;
- chain TUI graph rendering, the chain workflow-graph model, chain async/background handling,
  chain reporting in `subagent doctor`, and the chain types, results, settings, and formatters;
- structured output (`outputSchema` / `structured_output`), which existed only on chain items,
  in-chain parallel steps, and fan-out templates — never on top-level parallel `TaskItem`.

Removal is hard: `chain` is absent from the schema, so a call that still passes it is rejected by
ordinary schema validation. There is no deprecation shim, stub, or bespoke error path.

## What survives unchanged

SINGLE (`{agent, task?, progress?}`) and top-level PARALLEL
(`{tasks: [...], concurrency?, worktree?}`, including per-task `count`), MANAGEMENT actions,
CONTROL actions, `doctor`, fork vs fresh context, async execution, intercom group inheritance,
worktree isolation, and subagent depth limits.

## Divergence from upstream

Upstream `earendil-works/pi` still ships the equivalent chain surface in
`packages/coding-agent/examples/extensions/subagent/index.ts`, verified at the time of writing:

```text
452: chain: Type.Optional(Type.Array(ChainItem, { description: "Array of {agent, task} for sequential execution" })),
466: "Modes: single (agent + task), parallel (tasks array), chain (sequential with {previous} placeholder).",
530: if (params.chain && params.chain.length > 0) {
```

So statements in older `specs/` documents about `pi-subagents` chain mode remain **true of
upstream** and are false only of Atomic's `@bastani/subagents`. Read them with this record.

## Known consequence: legacy `.chain.md` files

Saved-chain discovery is gone, so `agent-loaders.ts` no longer special-cases `.chain.md`. A
leftover `.chain.md` file left in an agents directory carries `name` and `description` frontmatter
and therefore now registers as an ordinary agent. Delete or move such files. Restoring a
`.chain.md` exclusion was considered and rejected: it would reintroduce saved-chain knowledge into
shipped source, which the removal contract forbids, and an obfuscated filter is worse than none.

## Workflow chain is a different, untouched concept

`@bastani/workflows` keeps `ctx.chain(...)`, `WorkflowChainStep`, `chainDir`, and the run-level
`mode: "chain"` label. None of that is subagent chain mode and none of it changed. Sequential
composition remains available there.
