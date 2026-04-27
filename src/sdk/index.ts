/**
 * @bastani/atomic — SDK barrel.
 *
 * Public API for authoring and running workflows. Composition primitives
 * are pure functions; consumers wire them into their own CLI shape (via
 * Commander, citty, yargs, an OpenTUI app, etc.). The SDK itself ships
 * no opinionated CLI wrapper.
 */

// ─── Typed errors ───────────────────────────────────────────────────────────
export {
  MissingDependencyError,
  WorkflowNotCompiledError,
  InvalidWorkflowError,
} from "./errors.ts";

// ─── Authoring ──────────────────────────────────────────────────────────────
export { defineWorkflow, WorkflowBuilder } from "./define-workflow.ts";
export { createRegistry } from "./registry.ts";
export type { Registry } from "./registry.ts";

// ─── Shared types ───────────────────────────────────────────────────────────
export type {
  AgentType,
  Transcript,
  SavedMessage,
  SaveTranscript,
  SessionContext,
  SessionRef,
  SessionHandle,
  SessionRunOptions,
  WorkflowContext,
  WorkflowOptions,
  WorkflowDefinition,
  WorkflowInput,
  WorkflowInputType,
  StageClientOptions,
  StageSessionOptions,
  ProviderClient,
  ProviderSession,
} from "./types.ts";

// ─── Metadata accessors ─────────────────────────────────────────────────────
export {
  getName,
  getDescription,
  getAgent,
  getInputSchema,
  getSource,
  getMinSDKVersion,
} from "./primitives/metadata.ts";

// ─── Registry iteration helpers ─────────────────────────────────────────────
import type { AgentType, Registry, WorkflowDefinition } from "./types.ts";

/** Snapshot every workflow registered in `registry`. */
export function listWorkflows(registry: Registry): readonly WorkflowDefinition[] {
  return registry.list();
}

/** Resolve a workflow by `(name, agent)`; returns `undefined` when not found. */
export function getWorkflow(
  registry: Registry,
  agent: AgentType,
  name: string,
): WorkflowDefinition | undefined {
  return registry.resolve(name, agent);
}

// ─── Input validation ───────────────────────────────────────────────────────
export { validateInputs } from "./primitives/inputs.ts";
export type { ResolvedInputs } from "./primitives/inputs.ts";

// ─── Run a workflow ─────────────────────────────────────────────────────────
export { runWorkflow } from "./primitives/run.ts";
export type {
  RunWorkflowOptions,
  RunWorkflowResult,
} from "./primitives/run.ts";

// ─── Session management ─────────────────────────────────────────────────────
export {
  listSessions,
  getSession,
  stopSession,
  attachSession,
  getSessionStatus,
  getSessionTranscript,
} from "./primitives/sessions.ts";
export type {
  SessionInfo,
  SessionScope,
  StatusSnapshot,
  ListSessionsOptions,
} from "./primitives/sessions.ts";
