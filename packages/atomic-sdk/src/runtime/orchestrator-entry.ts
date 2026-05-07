/**
 * SDK-owned orchestrator entry point.
 *
 * Called by the CLI's hidden `_orchestrator-entry` sub-command in the tmux
 * pane that the workflow launcher script spawns. Two paths:
 *   - `runOrchestratorWithDefinition` — used in compiled-binary mode where
 *     the CLI has already resolved the workflow against its builtin
 *     registry. Avoids the dynamic-import-by-source path because Bun
 *     collapses every bundled module's `import.meta.path` to the binary's
 *     bunfs entry.
 *   - `runOrchestratorEntry` — dev / installed-package fallback. Imports
 *     the workflow module by `source` so third-party SDK consumers can
 *     spawn workflows whose definitions aren't in the builtin registry.
 *
 * This module is deliberately not its own executable. Mirroring OpenCode's
 * single-binary architecture, every fresh-process entry into atomic goes
 * through the CLI's command dispatcher (`atomic _<subcommand>`); the SDK
 * never ships a separately-runnable JS bundle that a sub-process would
 * `bun run` from outside the package's module resolution context.
 */
import { runOrchestrator } from "./executor.ts";
import type { AgentType, WorkflowDefinition } from "../types.ts";
import { isValidAgent } from "../services/config/definitions.ts";
import { InvalidWorkflowError } from "../errors.ts";
import { lookupLocalWorkflow } from "../lib/host-local-workflows.ts";

/** Runtime guard for any candidate WorkflowDefinition (mod.default OR registry hit). */
function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === "WorkflowDefinition"
  );
}

/**
 * Resolve a `WorkflowDefinition` for the given source path.
 *
 * Imports the source (which lets any top-level `await hostLocalWorkflows([wf])`
 * call register into the host registry) and then resolves the definition
 * in this order:
 *
 *   1. Host-workflows registry, keyed by `(agent, name)` — populated by
 *      `hostLocalWorkflows([…])`. This lets consumers declare the workflow
 *      once via the `hostLocalWorkflows` argument array, with no separate
 *      `export default` required.
 *   2. `mod.default` — backwards-compat for the traditional pattern
 *      where a workflow file directly default-exports the compiled
 *      definition (e.g. `examples/hello-world/claude/index.ts`) and a
 *      sibling worker calls `runWorkflow({ workflow, … })`.
 *
 * Throws `InvalidWorkflowError` when neither source resolves.
 *
 * Exported for unit testing; production callers should use
 * `runOrchestratorEntry`.
 */
export async function resolveWorkflowDefinition(
  sourcePath: string,
  workflowName: string,
  agent: AgentType,
): Promise<WorkflowDefinition> {
  const mod: unknown = await import(sourcePath);

  if (workflowName !== "") {
    const fromHost = lookupLocalWorkflow(workflowName, agent);
    if (fromHost && isWorkflowDefinition(fromHost)) {
      return fromHost;
    }
  }

  const def = (mod as { default?: unknown }).default;
  if (isWorkflowDefinition(def)) return def;

  throw new InvalidWorkflowError(sourcePath);
}

/**
 * Run the orchestrator panel against an already-resolved WorkflowDefinition.
 *
 * Used by the CLI's `_orchestrator-entry` sub-command in compiled-binary
 * mode, where every bundled module's `import.meta.path` collapses to the
 * binary's bunfs entry (`/$bunfs/root/<binary>`) and a dynamic
 * `await import(sourcePath)` of the captured `definition.source` would
 * re-import the CLI entry instead of the workflow file. The CLI looks the
 * workflow up in its builtin registry by `name + agent` and hands the
 * already-evaluated definition straight to this function.
 */
export async function runOrchestratorWithDefinition(
  def: WorkflowDefinition,
  inputsB64: string,
): Promise<void> {
  const inputs = decodeInputs(inputsB64);
  await runOrchestrator(def, inputs);
}

/** Decode the base64 inputs payload into a string-keyed record. */
function decodeInputs(b64: string): Record<string, string> {
  if (b64 === "") return {};
  let decoded: string;
  try {
    decoded = Buffer.from(b64, "base64").toString("utf-8");
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

/**
 * Load the workflow at `sourcePath`, validate the agent, and run the
 * orchestrator panel. Throws on validation failure so the calling
 * sub-command surfaces a non-zero exit.
 *
 * The remaining `ATOMIC_WF_*` env vars (ID, TMUX, AGENT, CWD) are set by
 * the launcher script written by `executeWorkflow()` — those describe the
 * runtime environment (which tmux session, which workflow run id, etc.).
 */
export async function runOrchestratorEntry(
  sourcePath: string,
  workflowName: string,
  agentRaw: string,
  inputsB64: string,
): Promise<void> {
  if (!isValidAgent(agentRaw)) {
    throw new Error(
      `[atomic/orchestrator-entry] Invalid agent "${agentRaw}". ` +
        `Expected one of: claude, copilot, opencode.`,
    );
  }
  const agent: AgentType = agentRaw;

  const def = await resolveWorkflowDefinition(sourcePath, workflowName, agent);

  if (def.agent !== agent) {
    throw new Error(
      `[atomic/orchestrator-entry] Workflow at "${sourcePath}" targets ` +
        `agent "${def.agent}" but the orchestrator was started for agent ` +
        `"${agent}". This usually means the wrong workflow file was passed ` +
        `to runWorkflow().`,
    );
  }

  const inputs = decodeInputs(inputsB64);
  await runOrchestrator(def, inputs);
}
