<h1 align="center">Atomic Workflows</h1>

<p align="center">
  <b>Turn coding agents into reliable engineering workflows.</b><br>
  Atomic's typed workflow authoring API, runtime extension, and bundled workflows.
</p>

This workspace package ships as raw TypeScript bundled inside [`@bastani/atomic`](../coding-agent/README.md); it is not published or installed independently. It registers the `workflow` tool, the `/workflow` command family, live workflow UI, durable execution, and the four builtins `deep-research-codebase`, `goal`, `ralph`, and `open-claude-design`.

## Create a workflow

Save a TypeScript module such as `.atomic/workflows/summarize-pr.ts`:

```typescript
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

export default workflow({
  name: "summarize-pr",
  description: "Summarize a pull request in one task.",
  inputs: {
    pr_url: Type.String({ description: "URL of the pull request to summarize." }),
  },
  outputs: {
    summary: Type.String({ description: "One-task summary of the pull request." }),
  },
  run: async (ctx) => {
    const summary = await ctx.task("summarize", {
      prompt: `Summarize the pull request at ${String(ctx.inputs.pr_url)} clearly and concisely.`,
    });
    return { summary: summary.text };
  },
});
```

Reload, inspect, and run it:

```text
/workflow reload
/workflow inputs summarize-pr
/workflow summarize-pr pr_url="https://github.com/example/project/pull/123"
```

For additional discovery paths and package resources, see [discovery, configuration, and distribution](../coding-agent/docs/workflow-discovery.md).

## Public surfaces

- `@bastani/workflows`: `workflow`, registries, direct execution helpers, and public workflow types.
- `@bastani/workflows/builtin` and `@bastani/workflows/builtin/*`: bundled workflow definitions for composition.
- `/workflow` and the LLM-callable `workflow` tool: discovery, execution, inspection, messaging, control, and reload.

## Canonical documentation

The coding-agent documentation is the canonical manual. Package-specific details removed from this README are preserved at these precise destinations:

- [Overview and five-minute quick start](../coding-agent/docs/workflows.md)
- [Authoring workflows and TypeBox contracts](../coding-agent/docs/workflow-authoring.md)
- [Running, monitoring, lifecycle notices, and human input](../coding-agent/docs/workflow-running.md)
- [Composition and child-output contracts](../coding-agent/docs/workflow-composition.md)
- [Durability, persistence, privacy, and cross-session resume](../coding-agent/docs/workflow-durability.md)
- [Primitives, task options, worktrees, model fallback, tool schema, and programmatic APIs](../coding-agent/docs/workflow-reference.md)
- [Discovery, configuration, package setup, trust, and reload](../coding-agent/docs/workflow-discovery.md)
- [Context engineering](../coding-agent/docs/workflow-context.md) and [best-practice cookbook](../coding-agent/docs/workflow-best-practices.md)
- [Builtins index](../coding-agent/docs/workflow-builtins.md): [deep research](../coding-agent/docs/workflow-builtin-deep-research-codebase.md), [Goal](../coding-agent/docs/workflow-builtin-goal.md), [Ralph](../coding-agent/docs/workflow-builtin-ralph.md), and [Open Claude Design](../coding-agent/docs/workflow-builtin-open-claude-design.md)
- [Builder-API migration](../coding-agent/docs/workflow-migration.md)

## Development

See [DEV_SETUP.md](../../DEV_SETUP.md) for repository setup, testing, package layout, and the local-extension development loop.

## License

[MIT](./LICENSE)
