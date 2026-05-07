/**
 * `hostLocalWorkflows` — explicit host-side dispatch helper.
 *
 * Call this AFTER all `defineWorkflow().compile()` calls in your entry
 * point. It checks `process.argv` for the `_emit-workflow-meta` and
 * `_atomic-run` internal sub-commands and, when found + token-gated,
 * handles them against the `workflows` array you pass in, then exits.
 *
 * Unlike the module-level side-effect in `auto-dispatch.ts`, this runs
 * synchronously after ESM evaluation completes — so the registry is
 * guaranteed to be populated before the dispatch logic inspects it.
 *
 * When neither sub-command is present, or when the dispatch token is
 * absent/invalid, the function returns without side-effects and the
 * caller's own `main()` continues normally.
 *
 * @example
 * ```typescript
 * import { defineWorkflow, hostLocalWorkflows } from "@bastani/atomic";
 *
 * const myWorkflow = defineWorkflow({ name: "my-wf", source: import.meta.path })
 *   .for("claude")
 *   .run(async (ctx) => { ... })
 *   .compile();
 *
 * await hostLocalWorkflows([myWorkflow]);
 * // user main() continues here when not dispatched
 * await main();
 * ```
 */

import type { AgentType, WorkflowInput } from "../types.ts";
import type { runWorkflow as RealRunWorkflow } from "../primitives/run.ts";
import {
  validateDispatchToken,
  parseAtomicRunArgv,
} from "./auto-dispatch.ts";

/**
 * Structural shape accepted by `hostLocalWorkflows()`.
 *
 * Uses `run: (...args: never[]) => Promise<void>` (the bivariant trick from
 * `RegistrableWorkflow`) so that narrowly-typed `WorkflowDefinition<"claude",
 * readonly []>` values produced by `.for("claude").compile()` are assignable
 * without an `as unknown as WorkflowDefinition` cast at the call site.
 */
type HostableLocalWorkflow = {
  readonly __brand: "WorkflowDefinition";
  readonly name: string;
  readonly agent: AgentType;
  readonly description: string;
  readonly inputs: readonly WorkflowInput[];
  readonly source: string;
  readonly minSDKVersion: string | null;
  readonly run: (...args: never[]) => Promise<void>;
};

/** Sub-commands handled exclusively by `hostLocalWorkflows()`. */
const HOST_SUBS = new Set(["_emit-workflow-meta", "_atomic-run"]);

/**
 * Module-scoped registry of workflows passed to `hostLocalWorkflows([…])`.
 *
 * Populated at every `hostLocalWorkflows()` call (before any argv inspection).
 * `runOrchestratorEntry` consults this registry by `(agent, name)` after
 * dynamic-importing the workflow source path, so consumers don't need to
 * `export default` the compiled workflow alongside the `hostLocalWorkflows()`
 * call — the array argument is the single declaration.
 *
 * Keyed by `${agent}:${name}` because (name, agent) is the dispatch
 * identity and a single source file may register multiple workflows.
 */
const localWorkflowRegistry = new Map<string, HostableLocalWorkflow>();

function registryKey(agent: string, name: string): string {
  return `${agent}:${name}`;
}

/**
 * Look up a workflow registered via `hostLocalWorkflows([…])` by
 * `(name, agent)`. Returns `undefined` if no workflow has been
 * registered for that pair in the current process.
 *
 * Used by `runOrchestratorEntry` (and unit tests). Consumers should call
 * `hostLocalWorkflows()` to register; this function is a read-only accessor.
 */
export function lookupLocalWorkflow(
  name: string,
  agent: string,
): HostableLocalWorkflow | undefined {
  return localWorkflowRegistry.get(registryKey(agent, name));
}

/** Test seam: clear the host-workflow registry between tests. */
export function _clearLocalWorkflowRegistry(): void {
  localWorkflowRegistry.clear();
}

/** Scan `argv` from index 2 for the first HOST_SUBS token. */
function findHostSub(argv: readonly string[]): { sub: string; index: number } | null {
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i]!;
    if (HOST_SUBS.has(tok)) return { sub: tok, index: i };
  }
  return null;
}

/** Serialize a HostableLocalWorkflow into the JSON shape emitted on the meta line. */
function serializeMeta(w: HostableLocalWorkflow): Record<string, unknown> {
  return {
    name: w.name,
    description: w.description,
    agent: w.agent,
    inputs: w.inputs,
    source: w.source,
    minSDKVersion: w.minSDKVersion ?? null,
  };
}

/** Options for `hostLocalWorkflows()`. */
export interface HostLocalWorkflowsOptions {
  /** Override `process.argv`. Defaults to `process.argv`. */
  argv?: readonly string[];
  /** Override `process.env`. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Inject the run primitive. Defaults to the real `runWorkflow` from
   * `../primitives/run.ts`. Tests pass a fake to assert call args without
   * touching `mock.module()`.
   */
  runWorkflow?: typeof RealRunWorkflow;
}

/**
 * Inspect `argv` for `_emit-workflow-meta` / `_atomic-run` sub-commands
 * (atomic dispatch) or a direct `--name <X>` invocation (manual CLI use)
 * and handle them against the provided `workflows` array.
 *
 * Must be called **after** all `.compile()` calls so that `workflows` is
 * fully populated.
 *
 * Three execution modes:
 *   1. Atomic-dispatched `_emit-workflow-meta` (token-gated) — emits
 *      the metadata line and exits 0.
 *   2. Atomic-dispatched `_atomic-run` (token-gated) — runs the named
 *      workflow via `runWorkflow` and exits 0.
 *   3. Direct CLI invocation — `bun run script.ts --name <X> [--agent <Y>]
 *      [--<input> <v>]… [--detach]`. No dispatch token required; runs the
 *      workflow via `runWorkflow` and exits 0. When `--agent` is omitted
 *      it auto-resolves if exactly one workflow matches the name.
 *
 * When none of these match, `hostLocalWorkflows` returns silently so the
 * caller's own `main()` can continue.
 *
 * @param workflows - Compiled workflow definitions to expose/dispatch.
 * @param options   - Optional argv/env overrides (useful in tests).
 */
export async function hostLocalWorkflows(
  workflows: readonly HostableLocalWorkflow[],
  options?: HostLocalWorkflowsOptions,
): Promise<void> {
  const argv = options?.argv ?? process.argv;
  const env = options?.env ?? (process.env as Record<string, string | undefined>);

  // Register supplied workflows into the host registry BEFORE any argv
  // inspection. This runs on every call — including when the dispatcher
  // pane re-imports this file under `_orchestrator-entry`, where the
  // function returns silently below but the registry side-effect lets
  // `runOrchestratorEntry` resolve the definition without requiring the
  // consumer to also `export default` the workflow.
  for (const w of workflows) {
    localWorkflowRegistry.set(registryKey(w.agent, w.name), w);
  }

  const found = findHostSub(argv);
  if (found && validateDispatchToken(env, argv)) {
    if (found.sub === "_emit-workflow-meta") {
      const meta = workflows.map(serializeMeta);
      process.stdout.write(`ATOMIC_WORKFLOW_META: ${JSON.stringify(meta)}\n`);
      process.exit(0);
    }

    // found.sub === "_atomic-run"
    const { name, agent, detach, inputs } = parseAtomicRunArgv(
      argv.slice(found.index + 1),
    );

    if (!name || !agent) {
      const missing = [!name && "--name", !agent && "--agent"].filter(Boolean).join(" ");
      process.stderr.write(`[atomic-sdk:_atomic-run] Missing required flag(s): ${missing}\n`);
      process.exit(1);
    }

    const workflow = workflows.find((d) => d.name === name && d.agent === agent);
    if (!workflow) {
      process.stderr.write(
        `[atomic-sdk:_atomic-run] No compiled workflow found for name="${name}" agent="${agent}"\n`,
      );
      process.exit(1);
    }

    const runWorkflow =
      options?.runWorkflow ??
      (await import("../primitives/run.ts")).runWorkflow;
    try {
      await runWorkflow({ workflow, inputs, detach });
    } catch (err) {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`[atomic-sdk:_atomic-run] ${msg}\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // ─── Direct CLI mode ──────────────────────────────────────────────────
  // No dispatch sub-command (or token failed validation). Fall through to
  // direct `bun run script.ts --name <X> …` style invocation so consumers
  // can run their custom workflow as a standalone CLI without going
  // through atomic at all.
  await maybeRunDirectCLI(workflows, argv, options);
}

/**
 * Direct-CLI handler. Triggers when `argv` carries `--name <X>` (and
 * optional `--agent <Y>`) outside of a token-gated dispatch context.
 * Otherwise returns without side-effect so the caller's own `main()`
 * continues normally.
 *
 * Argument shape mirrors `_atomic-run`'s flags exactly so consumers
 * learn one syntax for both invocation modes:
 *   `--name <X> [--agent <Y>] [--detach] [--<input> <value>…]`
 *
 * `--agent` is optional when exactly one registered workflow matches
 * `--name`; when multiple agents register the same name, `--agent` is
 * required to disambiguate.
 */
async function maybeRunDirectCLI(
  workflows: readonly HostableLocalWorkflow[],
  argv: readonly string[],
  options: HostLocalWorkflowsOptions | undefined,
): Promise<void> {
  const cli = parseAtomicRunArgv(argv.slice(2));
  if (!cli.name) return;

  const matches = workflows.filter((w) => w.name === cli.name);
  if (matches.length === 0) {
    process.stderr.write(
      `[hostLocalWorkflows] No registered workflow named "${cli.name}". ` +
        `Available: ${workflows.map((w) => `${w.name}/${w.agent}`).join(", ") || "(none)"}\n`,
    );
    process.exit(1);
  }

  let workflow: HostableLocalWorkflow;
  if (cli.agent) {
    const exact = matches.find((w) => w.agent === cli.agent);
    if (!exact) {
      process.stderr.write(
        `[hostLocalWorkflows] Workflow "${cli.name}" is not registered for agent "${cli.agent}". ` +
          `Registered agents: ${matches.map((w) => w.agent).join(", ")}\n`,
      );
      process.exit(1);
    }
    workflow = exact;
  } else if (matches.length === 1) {
    workflow = matches[0]!;
  } else {
    process.stderr.write(
      `[hostLocalWorkflows] Workflow "${cli.name}" is registered for multiple agents ` +
        `(${matches.map((w) => w.agent).join(", ")}). Specify --agent <name>.\n`,
    );
    process.exit(1);
  }

  const runWorkflow =
    options?.runWorkflow ??
    (await import("../primitives/run.ts")).runWorkflow;
  try {
    await runWorkflow({ workflow, inputs: cli.inputs, detach: cli.detach });
  } catch (err) {
    const msg = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(`[hostLocalWorkflows] ${msg}\n`);
    process.exit(1);
  }
  process.exit(0);
}
