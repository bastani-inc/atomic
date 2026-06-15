/**
 * Main DAG executor: run(def, inputs, opts) → RunResult
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, createAskUserQuestionToolDefinition, isCodexFastModeCandidateModelId } from "@bastani/atomic";
import { stageUiBroker } from "../../shared/stage-ui-broker.js";
import { isBrandedWorkflowDefinition, stampWorkflowDefinition } from "../../workflows/define-workflow.js";
import { buildStagePromptAdapter } from "../../shared/stage-prompt.js";
import type {
  WorkflowDefinition,
  WorkflowRunContext,
  WorkflowUIContext,
  WorkflowUIAdapter,
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowInputSchema,
  StageContext,
  StageOptions,
  StagePromptOptions,
  WorkflowTaskContextInput,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
  WorkflowArtifact,
  WorkflowMaxOutput,
  WorkflowOutputMode,
  WorkflowChainOptions,
  WorkflowParallelOptions,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowChainStep,
  WorkflowMcpPort,
  WorkflowPersistencePort,
  WorkflowRuntimeConfig,
  WorkflowModelCatalogPort,
  WorkflowExecutionMode,
  WorkflowRunChildOptions,
  WorkflowChildResult,
  WorkflowExitOptions,
  WorkflowExitStatus,
  WorkflowOutputSchema,
  WorkflowOutputValues,
  WorkflowInputValues,
  WorkflowSerializableValue,
} from "../../shared/types.js";
import type { InternalStageContext, StageAdapters } from "./stage-runner.js";
import type * as AuthoringContract from "../../shared/authoring-contract.js";
import type {
  RunStatus,
  StageNotice,
  StageSnapshot,
  RunSnapshot,
  WorkflowOverlayAdapter,
  WorkflowFailureKind,
  WorkflowFailureCode,
  WorkflowFailureRecoverability,
  WorkflowFailureDisposition,
  PendingPrompt,
  CustomPromptIdentitySource,
  WorkflowChildReplaySnapshot,
  WorkflowChildRunRef,
} from "../../shared/store-types.js";
import type { StageControlHandle, StageControlRegistry, AgentSessionEventListener } from "./stage-control-registry.js";
import type { Store } from "../../shared/store.js";
import type { WorkflowRegistry } from "../../workflows/registry.js";
import type { CancellationRegistry } from "../background/cancellation-registry.js";
import { createStageContext } from "./stage-runner.js";
import { GraphFrontierTracker } from "../shared/graph-inference.js";
import { stageControlRegistry as defaultStageControlRegistry } from "./stage-control-registry.js";
import { createRunLimiter } from "../shared/concurrency.js";
import {
  cleanupWorktrees,
  createWorktrees,
  diffWorktrees,
  findWorktreeTaskCwdConflict,
  setupGitWorktree,
  formatWorktreeDiffSummary,
  formatWorktreeTaskCwdConflict,
  type WorktreeSetup,
} from "../shared/worktree.js";
import { store as defaultStore } from "../../shared/store.js";
import { elapsedStageMs } from "../../shared/timing.js";
import {
  appendRunStart,
  appendStageStart,
  appendStageEnd,
  appendRunEnd,
  appendRunBlocked,
} from "../../shared/persistence-session-entries.js";
import { buildModelCandidatesFromCatalog, validateWorkflowModels, workflowModelId } from "../shared/model-fallback.js";
import { validateInputs, type ValidationError } from "../shared/validate-inputs.js";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { schemaFieldKind, schemaChoices, schemaIsRequired } from "../../shared/schema-introspection.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import { classifyWorkflowFailure } from "../../shared/workflow-failures.js";
import { selectPromptCallsiteFrame } from "../shared/prompt-callsite.js";
import {
  WORKFLOW_SERIALIZABLE_DESCRIPTION,
  assertWorkflowSerializableObject,
  workflowSerializableValidationError,
  workflowSerializableTypeName,
} from "../../shared/serializable.js";

export interface ResolvedInputs extends WorkflowInputValues {}

export interface RunContinuationOpts {
  readonly source: RunSnapshot;
  readonly resumeFromStageId: string;
}

export interface RunOpts extends Omit<AuthoringContract.RunOpts, "adapters" | "store" | "cancellation" | "overlay" | "registry" | "stageControlRegistry" | "continuation" | "onRunStart" | "onStageStart" | "onStageEnd" | "onRunEnd" | "ui"> {
  adapters?: StageAdapters;
  /** Invocation working directory exposed to workflow definitions as ctx.cwd. */
  cwd?: string;
  /** HIL adapter injected by the pi runtime or test harness. */
  ui?: WorkflowUIAdapter;
  /** Runtime execution mode. Controls child session policy metadata. */
  executionMode?: WorkflowExecutionMode;
  /** Internal detached-run mode: surface ctx.ui.* as node-local workflow prompt stages. */
  usePromptNodesForUi?: boolean;
  /**
   * Readiness-gate confirmation seam (#1099). When an ask_user_question tool
   * call is observed during a stage, the executor calls this after the model
   * turn ends to ask whether to advance. Returning false keeps execution in the
   * stage (the executor steers the stage to continue and re-gates after the
   * next turn); true advances. When omitted, runs with usePromptNodesForUi
   * render the gate through the stage UI broker, and other runs proceed without
   * gating (tests/headless).
   */
  confirmStageReadiness?: (request: {
    readonly runId: string;
    readonly stageId: string;
    readonly stageName: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
  /** Store override (for testing; defaults to singleton store) */
  store?: Store;
  /** Persistence port for writing session entries (run.start, stage.start, etc.). */
  persistence?: WorkflowPersistencePort;
  /** MCP scope-gating port; forwards per-stage allow/deny to the MCP adapter. */
  mcp?: WorkflowMcpPort;
  /** Cancellation registry; the executor registers an ActiveRunController per run. */
  cancellation?: CancellationRegistry;
  /** Overlay adapter for displaying run progress in the UI layer. */
  overlay?: WorkflowOverlayAdapter;
  /** AbortSignal that requests cancellation from the caller side. */
  signal?: AbortSignal;
  /**
   * Internal background-runner seam. When true, the executor records the run
   * synchronously, then yields to the next event-loop turn before invoking user
   * workflow code so detached dispatch cannot be blocked by pre-await work.
   */
  deferWorkflowStart?: boolean;
  /**
   * Resolved runtime configuration. Injected by the composition root after
   * merging file config with defaults. Downstream tasks (maxDepth, concurrency,
   * status writer) consume this; values are threaded here but not yet acted on.
   */
  config?: WorkflowRuntimeConfig;
  /** Optional model catalog used for fallback validation/resolution. */
  models?: WorkflowModelCatalogPort;
  /** Registry metadata forwarded to workflow runs launched from discovery/tooling. */
  registry?: WorkflowRegistry;
  /**
   * Current nesting depth of this workflow run. Starts at 0 for top-level runs.
   * Callers that spawn nested runs must increment this by 1 before passing to
   * run()/runDetached() so the maxDepth guard can reject runs that exceed the
   * configured limit.
   */
  depth?: number;
  /**
   * Live stage-control registry. The executor registers a handle per
   * stage so attached panes can lazily prompt/steer/pause/resume the
   * underlying Pi session without going through the JSON snapshot.
   * Defaults to the process-wide singleton registered alongside the
   * default store.
   */
  stageControlRegistry?: StageControlRegistry;
  /**
   * Pre-allocated runId. When provided, the executor uses this ID instead of
   * generating a new UUID. The detached runner uses this seam to preallocate
   * the runId before starting the background promise.
   */
  runId?: string;
  /** Replay completed stages from a failed source run, then resume at this stage. */
  continuation?: RunContinuationOpts;
  /** Internal parent linkage for nested ctx.workflow(...) runs. */
  parentRun?: {
    readonly runId: string;
    readonly stageId: string;
    readonly rootRunId: string;
  };
  onRunStart?: (snapshot: RunSnapshot) => void;
  onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  onStageEnd?: (runId: string, snapshot: StageSnapshot) => void;
  onRunEnd?: (runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string, exitReason?: string) => void;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: WorkflowOutputValues;
  readonly error?: string;
  /** True when the run reached its terminal status through ctx.exit(). */
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly stages: StageSnapshot[];
}

const WORKFLOW_EXIT_SIGNAL = Symbol("atomic-workflows.workflow-exit-signal");
const WORKFLOW_EXIT_STATUSES: ReadonlySet<WorkflowExitStatus> = new Set([
  "completed",
  "skipped",
  "cancelled",
  "blocked",
]);

type WorkflowExitOutputSnapshot =
  | {
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly ok: false;
      readonly error: Error;
    };

interface WorkflowExitSignal {
  readonly [WORKFLOW_EXIT_SIGNAL]: true;
  readonly scope: symbol;
  readonly status: WorkflowExitStatus;
  readonly reason?: string;
  readonly outputSnapshot?: WorkflowExitOutputSnapshot;
  readonly validationError?: Error;
}

const WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE = Symbol("atomic-workflows.workflow-exit-snapshot-invalid-value");

interface WorkflowExitSnapshotInvalidValue {
  readonly [WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE]: true;
  readonly typeName: string;
}

type SafePropertyRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

function safeGetProperty(value: object, key: PropertyKey): SafePropertyRead {
  try {
    return { ok: true, value: (value as Record<PropertyKey, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

function unknownErrorMessage(error: unknown): string {
  if (error !== null && (typeof error === "object" || typeof error === "function")) {
    const message = safeGetProperty(error, "message");
    if (message.ok && typeof message.value === "string" && message.value.length > 0) {
      return message.value;
    }
  }
  if (typeof error === "string") return error;
  try {
    return String(error);
  } catch {
    return "<unprintable thrown value>";
  }
}

function workflowExitSnapshotError(message: string, cause: unknown): Error {
  return new Error(`${message}: ${unknownErrorMessage(cause)}`, { cause });
}

function workflowExitOptionReadError(key: "status" | "reason" | "outputs", cause: unknown): Error {
  return workflowExitSnapshotError(`atomic-workflows: ctx.exit() ${key} option could not be read`, cause);
}

function readWorkflowExitOption(
  options: { readonly status?: unknown; readonly reason?: unknown; readonly outputs?: unknown } | null | undefined,
  key: "status" | "reason" | "outputs",
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: Error } {
  try {
    return { ok: true, value: options?.[key] };
  } catch (err) {
    return { ok: false, error: workflowExitOptionReadError(key, err) };
  }
}

function describeWorkflowExitOptionValue(value: unknown): string {
  try {
    const json = JSON.stringify(value);
    if (json !== undefined) return json;
  } catch {
    // Fall back to a coarse type name below. This path is diagnostic only and
    // must never make ctx.exit() throw before workflow-exit cleanup can run.
  }
  return workflowSerializableTypeName(value);
}

function isPlainWorkflowExitSnapshotObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function makeWorkflowExitSnapshotInvalidValue(typeName: string): WorkflowExitSnapshotInvalidValue {
  const marker = {} as { [WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE]?: true; typeName?: string };
  Object.defineProperty(marker, WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE, {
    value: true,
    enumerable: false,
  });
  Object.defineProperty(marker, "typeName", {
    value: typeName,
    enumerable: false,
  });
  return Object.freeze(marker) as WorkflowExitSnapshotInvalidValue;
}

function isWorkflowExitSnapshotInvalidValue(value: unknown): value is WorkflowExitSnapshotInvalidValue {
  return value !== null && typeof value === "object" &&
    (value as Record<PropertyKey, unknown>)[WORKFLOW_EXIT_SNAPSHOT_INVALID_VALUE] === true;
}

function cloneWorkflowExitSnapshotValue(
  value: unknown,
  seen: Map<object, unknown>,
  stack: Set<object> = new Set(),
): unknown {
  if (value === null) return null;
  const valueType = typeof value;
  if (valueType !== "object") {
    return valueType === "function"
      ? makeWorkflowExitSnapshotInvalidValue("function")
      : value;
  }

  const objectValue = value as object;
  const previousClone = seen.get(objectValue);
  if (previousClone !== undefined) {
    return stack.has(objectValue)
      ? makeWorkflowExitSnapshotInvalidValue("circular object")
      : previousClone;
  }

  if (Array.isArray(value)) {
    const clone: unknown[] = [];
    seen.set(objectValue, clone);
    stack.add(objectValue);
    try {
      for (let index = 0; index < value.length; index += 1) {
        clone[index] = cloneWorkflowExitSnapshotValue(value[index], seen, stack);
      }
    } finally {
      stack.delete(objectValue);
    }
    return clone;
  }

  if (!isPlainWorkflowExitSnapshotObject(objectValue)) {
    return makeWorkflowExitSnapshotInvalidValue(workflowSerializableTypeName(value));
  }

  const clone: Record<string, unknown> = {};
  seen.set(objectValue, clone);
  stack.add(objectValue);
  try {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      clone[key] = cloneWorkflowExitSnapshotValue((value as Record<string, unknown>)[key], seen, stack);
    }
  } finally {
    stack.delete(objectValue);
  }
  return clone;
}

// Recursively freeze the (already-private) deep clone so the snapshot stored on
// the thrown WorkflowExitSignal is immutable. Combined with freezing the signal
// object itself, this stops author code that catches ctx.exit()'s signal from
// rewriting the captured outputs before finalization reads them (finalization
// recovers the same object via the abort reason / rethrow, and the reconstruction
// path reads `outputSnapshot.value` by reference). The clone is acyclic — cycles
// became frozen invalid-value markers — and the `Object.isFrozen` short-circuit
// keeps shared (DAG) nodes terminating.
function deepFreezeWorkflowExitSnapshotValue(value: unknown): void {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezeWorkflowExitSnapshotValue(item);
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    deepFreezeWorkflowExitSnapshotValue((value as Record<string, unknown>)[key]);
  }
}

function freezeWorkflowExitOutputSnapshot(snapshot: WorkflowExitOutputSnapshot): WorkflowExitOutputSnapshot {
  return Object.freeze(snapshot);
}

function captureWorkflowExitOutputSnapshot(rawOutputs: unknown): WorkflowExitOutputSnapshot {
  let snapshot: WorkflowExitOutputSnapshot;
  try {
    const value = cloneWorkflowExitSnapshotValue(rawOutputs, new Map());
    deepFreezeWorkflowExitSnapshotValue(value);
    snapshot = { ok: true, value };
  } catch (err) {
    snapshot = {
      ok: false,
      error: workflowExitSnapshotError("atomic-workflows: ctx.exit() outputs could not be snapshotted", err),
    };
  }
  return freezeWorkflowExitOutputSnapshot(snapshot);
}

function formatWorkflowExitSnapshotPath(parent: string, key: string): string {
  // `segment` already encodes the structure: bracketed for numeric/non-identifier keys,
  // dotted for identifiers with a parent, and the bare key for an identifier at the root
  // (where `parent === ""` so `segment === key`). Every case therefore reduces to the
  // concatenation below.
  const segment = /^\d+$/.test(key)
    ? `[${key}]`
    : /^[A-Za-z_$][\w$]*$/.test(key)
      ? (parent.length > 0 ? `.${key}` : key)
      : `[${JSON.stringify(key)}]`;
  return `${parent}${segment}`;
}

function findWorkflowExitSnapshotInvalidValue(
  value: unknown,
  path = "",
  seen = new Set<unknown>(),
): { readonly path: string; readonly typeName: string } | undefined {
  if (isWorkflowExitSnapshotInvalidValue(value)) {
    return { path, typeName: value.typeName };
  }
  if (value === null || typeof value !== "object") return undefined;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findWorkflowExitSnapshotInvalidValue(value[index], `${path}[${index}]`, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const key of Object.keys(value as Record<string, unknown>)) {
    const found = findWorkflowExitSnapshotInvalidValue(
      (value as Record<string, unknown>)[key],
      formatWorkflowExitSnapshotPath(path, key),
      seen,
    );
    if (found !== undefined) return found;
  }
  return undefined;
}

function workflowExitSnapshotInvalidValueMessage(label: string, value: unknown): string | undefined {
  const invalid = findWorkflowExitSnapshotInvalidValue(value);
  if (invalid === undefined) return undefined;
  const location = invalid.path.length > 0 ? ` at ${invalid.path}` : "";
  return `${label}${location} must be ${WORKFLOW_SERIALIZABLE_DESCRIPTION}, got ${invalid.typeName}`;
}

const PARENT_WORKFLOW_EXIT_ABORT = Symbol("atomic-workflows.parent-workflow-exit-abort");

interface ParentWorkflowExitAbortReason extends Error {
  readonly [PARENT_WORKFLOW_EXIT_ABORT]: true;
  readonly workflowExitReason?: string;
}

function parentWorkflowExitRunReason(reason?: string): string {
  return reason === undefined || reason.length === 0
    ? "parent workflow exited"
    : `parent workflow exited: ${reason}`;
}

function makeParentWorkflowExitAbortReason(reason?: string): ParentWorkflowExitAbortReason {
  const error = new Error(parentWorkflowExitRunReason(reason)) as ParentWorkflowExitAbortReason & {
    [PARENT_WORKFLOW_EXIT_ABORT]: true;
    workflowExitReason?: string;
  };
  Object.defineProperty(error, PARENT_WORKFLOW_EXIT_ABORT, {
    value: true,
    enumerable: false,
  });
  if (reason !== undefined) error.workflowExitReason = reason;
  return error;
}

interface ParentWorkflowExitAbortProbe {
  readonly workflowExitReason?: string;
}

function parentWorkflowExitAbortReason(value: unknown): ParentWorkflowExitAbortProbe | undefined {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const marker = safeGetProperty(value, PARENT_WORKFLOW_EXIT_ABORT);
  if (!marker.ok || marker.value !== true) return undefined;

  const reason = safeGetProperty(value, "workflowExitReason");
  return reason.ok && typeof reason.value === "string"
    ? { workflowExitReason: reason.value }
    : {};
}

function isWorkflowExitStatus(value: unknown): value is WorkflowExitStatus {
  return typeof value === "string" && WORKFLOW_EXIT_STATUSES.has(value as WorkflowExitStatus);
}

function safeErrorValue(value: unknown): Error {
  try {
    if (value instanceof Error) return value;
  } catch {
    // Fall through to a safe wrapper below.
  }
  return new Error(unknownErrorMessage(value));
}

function readWorkflowExitOutputSnapshot(value: unknown): WorkflowExitOutputSnapshot | undefined {
  if (value === undefined) return undefined;
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  const ok = safeGetProperty(value, "ok");
  if (!ok.ok) return undefined;
  if (ok.value === true) {
    const snapshotValue = safeGetProperty(value, "value");
    return snapshotValue.ok ? { ok: true, value: snapshotValue.value } : undefined;
  }
  if (ok.value === false) {
    const error = safeGetProperty(value, "error");
    return error.ok ? { ok: false, error: safeErrorValue(error.value) } : undefined;
  }
  return undefined;
}

function readWorkflowExitSignalCandidate(value: object, scope: symbol): WorkflowExitSignal | undefined {
  const marker = safeGetProperty(value, WORKFLOW_EXIT_SIGNAL);
  if (!marker.ok || marker.value !== true) return undefined;

  const signalScope = safeGetProperty(value, "scope");
  if (!signalScope.ok || signalScope.value !== scope) return undefined;

  const status = safeGetProperty(value, "status");
  if (!status.ok || !isWorkflowExitStatus(status.value)) return undefined;

  const reason = safeGetProperty(value, "reason");
  if (!reason.ok || (reason.value !== undefined && typeof reason.value !== "string")) return undefined;

  const outputSnapshotValue = safeGetProperty(value, "outputSnapshot");
  if (!outputSnapshotValue.ok) return undefined;
  const outputSnapshot = readWorkflowExitOutputSnapshot(outputSnapshotValue.value);
  if (outputSnapshotValue.value !== undefined && outputSnapshot === undefined) return undefined;

  const validationError = safeGetProperty(value, "validationError");
  if (!validationError.ok) return undefined;

  return {
    [WORKFLOW_EXIT_SIGNAL]: true,
    scope,
    status: status.value,
    ...(reason.value !== undefined ? { reason: reason.value } : {}),
    ...(outputSnapshot !== undefined ? { outputSnapshot } : {}),
    ...(validationError.value !== undefined ? { validationError: safeErrorValue(validationError.value) } : {}),
  };
}

function findWorkflowExitSignal(error: unknown, scope: symbol, seen = new Set<unknown>()): WorkflowExitSignal | undefined {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
  if (seen.has(error)) return undefined;
  seen.add(error);

  const directSignal = readWorkflowExitSignalCandidate(error, scope);
  if (directSignal !== undefined) return directSignal;

  const errors = safeExecutorAggregateErrorItems(error);
  for (const item of errors) {
    const signal = findWorkflowExitSignal(item, scope, seen);
    if (signal !== undefined) return signal;
  }

  const cause = safeGetProperty(error, "cause");
  if (cause.ok) {
    const causeSignal = findWorkflowExitSignal(cause.value, scope, seen);
    if (causeSignal !== undefined) return causeSignal;
  }

  const reason = safeGetProperty(error, "reason");
  return reason.ok ? findWorkflowExitSignal(reason.value, scope, seen) : undefined;
}

// ---------------------------------------------------------------------------
// Input resolution / validation
// ---------------------------------------------------------------------------

export function resolveInputs(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  provided: Readonly<Record<string, unknown>>,
): ResolvedInputs {
  const resolved: Record<string, WorkflowSerializableValue> = {};
  for (const [key, value] of Object.entries(provided)) {
    if (value !== undefined) resolved[key] = value as WorkflowSerializableValue;
  }

  // Apply declared TypeBox defaults (top-level and nested) for absent keys.
  const withDefaults = Value.Default(
    Type.Object(schema as Record<string, TSchema>, { additionalProperties: true }),
    resolved,
  ) as Record<string, WorkflowSerializableValue>;
  for (const [key, value] of Object.entries(withDefaults)) {
    if (value !== undefined) resolved[key] = value;
  }

  for (const [key, schemaDef] of Object.entries(schema)) {
    if (schemaIsRequired(schemaDef) && resolved[key] === undefined) {
      throw new TypeError(`atomic-workflows: required input "${key}" not provided`);
    }
  }

  return resolved;
}

function resolveInputConcurrency(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  resolvedInputs: ResolvedInputs,
): number | undefined {
  const concurrencySchema = schema["max_concurrency"];
  if (concurrencySchema === undefined || schemaFieldKind(concurrencySchema) !== "number") {
    return undefined;
  }

  const value = resolvedInputs["max_concurrency"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;

  return Math.floor(value);
}

function resolveInputRuntimeDefaults(
  def: Pick<WorkflowDefinition, "inputBindings">,
  resolvedInputs: ResolvedInputs,
): Partial<StageOptions> {
  const defaults: Partial<StageOptions> = {};
  const worktree = def.inputBindings?.worktree;
  if (worktree !== undefined) {
    const gitWorktreeDir = resolvedInputs[worktree.gitWorktreeDir];
    if (typeof gitWorktreeDir === "string" && gitWorktreeDir.trim().length > 0) {
      defaults.gitWorktreeDir = gitWorktreeDir;
      const baseBranch = worktree.baseBranch === undefined ? undefined : resolvedInputs[worktree.baseBranch];
      if (typeof baseBranch === "string") defaults.baseBranch = baseBranch;
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// HIL unavailable fallback — rejects with precise per-primitive error
// ---------------------------------------------------------------------------

type PrimitivePromptDescriptor =
  | { readonly kind: "input"; readonly message: string; readonly initial?: string }
  | { readonly kind: "confirm"; readonly message: string }
  | { readonly kind: "select"; readonly message: string; readonly choices: readonly string[] }
  | { readonly kind: "editor"; readonly message: string; readonly initial?: string };

interface CustomPromptDescriptor<T> {
  readonly kind: "custom";
  readonly message: string;
  readonly factory: WorkflowCustomUiFactory<T>;
  readonly options?: WorkflowCustomUiOptions;
  readonly customIdentityHash: string;
  readonly customIdentitySource: CustomPromptIdentitySource;
}

type PromptDescriptor<T = unknown> = PrimitivePromptDescriptor | CustomPromptDescriptor<T>;

function isCustomPromptDescriptor<T>(descriptor: PromptDescriptor<T>): descriptor is CustomPromptDescriptor<T> {
  return descriptor.kind === "custom";
}

function fallbackForPromptDescriptor(descriptor: PrimitivePromptDescriptor): unknown {
  switch (descriptor.kind) {
    case "input":
    case "editor":
      return descriptor.initial ?? "";
    case "confirm":
      return false;
    case "select":
      return descriptor.choices[0] ?? "";
  }
}

function makePrompt(descriptor: PromptDescriptor): PendingPrompt {
  return {
    id: `hil-${crypto.randomUUID()}`,
    kind: descriptor.kind,
    message: descriptor.message,
    ...(!isCustomPromptDescriptor(descriptor) && descriptor.kind === "select" ? { choices: descriptor.choices } : {}),
    ...(!isCustomPromptDescriptor(descriptor) && (descriptor.kind === "input" || descriptor.kind === "editor") && descriptor.initial !== undefined ? { initial: descriptor.initial } : {}),
    ...(isCustomPromptDescriptor(descriptor) ? {
      customIdentityHash: descriptor.customIdentityHash,
      customIdentitySource: descriptor.customIdentitySource,
    } : {}),
    createdAt: Date.now(),
  };
}

function stableHash(value: unknown): string {
  // 128 bits is plenty for replay-key identity while keeping graph labels compact.
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function promptDescriptorHash(descriptor: PromptDescriptor): string {
  if (isCustomPromptDescriptor(descriptor)) {
    return stableHash({
      kind: "custom",
      customIdentityHash: descriptor.customIdentityHash,
    });
  }
  return stableHash({
    kind: descriptor.kind,
    message: descriptor.message,
    choices: descriptor.kind === "select" ? descriptor.choices : [],
    // Include input/editor initial text because it is visible prompt context;
    // changing it should not replay a stale answer from the same callsite.
    initial: descriptor.kind === "input" || descriptor.kind === "editor" ? descriptor.initial ?? null : null,
  });
}

function promptReplayKey(descriptor: PromptDescriptor): string {
  return `prompt:${descriptor.kind}:${promptDescriptorHash(descriptor)}:${promptCallsiteHash()}`;
}

function promptCallsiteHash(): string {
  // Capturing an Error stack is intentional here: HIL prompts are an
  // interactive slow path, and the author callsite is part of the replay key.
  const frame = selectPromptCallsiteFrame(new Error().stack ?? "") ?? "unknown";
  return stableHash(frame);
}

function hilAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("atomic-workflows: HIL aborted");
}

function resolveCustomPromptIdentity<T>(
  factory: WorkflowCustomUiFactory<T>,
  options: WorkflowCustomUiOptions | undefined,
): Pick<CustomPromptDescriptor<T>, "customIdentityHash" | "customIdentitySource"> {
  const replayIdentity = options?.replayIdentity?.trim();
  if (replayIdentity !== undefined && replayIdentity.length > 0) {
    return {
      customIdentityHash: stableHash({ source: "caller", value: replayIdentity }),
      customIdentitySource: "caller",
    };
  }
  if (factory.name.trim().length > 0) {
    return {
      customIdentityHash: stableHash({ source: "factory", value: factory.name }),
      customIdentitySource: "factory",
    };
  }
  try {
    const source = Function.prototype.toString.call(factory);
    if (source.trim().length > 0) {
      return {
        customIdentityHash: stableHash({ source: "factory", value: source }),
        customIdentitySource: "factory",
      };
    }
  } catch {
    // Fall through to callsite-only identity below.
  }
  return {
    customIdentityHash: stableHash({ source: "callsite" }),
    customIdentitySource: "callsite",
  };
}

function customPromptDescriptor<T>(
  factory: WorkflowCustomUiFactory<T>,
  options: WorkflowCustomUiOptions | undefined,
): CustomPromptDescriptor<T> {
  const label = options?.label?.trim();
  return {
    kind: "custom",
    message: label && label.length > 0 ? label : "Custom TUI prompt",
    factory,
    ...(options !== undefined ? { options } : {}),
    ...resolveCustomPromptIdentity(factory, options),
  };
}

interface MergedHilSignal {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
}

function mergeHilSignals(primary: AbortSignal, secondary: AbortSignal | undefined): MergedHilSignal {
  if (secondary === undefined) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onPrimaryAbort = (): void => abortFrom(primary);
  const onSecondaryAbort = (): void => abortFrom(secondary);
  primary.addEventListener("abort", onPrimaryAbort, { once: true });
  secondary.addEventListener("abort", onSecondaryAbort, { once: true });
  if (primary.aborted) abortFrom(primary);
  else if (secondary.aborted) abortFrom(secondary);
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", onPrimaryAbort);
      secondary.removeEventListener("abort", onSecondaryAbort);
    },
  };
}

/**
 * Build a UI context whose every interactive primitive rejects with a clear,
 * actionable error. Parameterized by `msg` so the "no UI adapter" and
 * "headless mode" variants share one implementation and never drift (#1339).
 */
function makeRejectingUIContext(msg: (primitive: string) => string): WorkflowUIContext {
  return {
    input: () => Promise.reject(new Error(msg("input"))),
    confirm: () => Promise.reject(new Error(msg("confirm"))),
    select: () => Promise.reject(new Error(msg("select"))),
    editor: () => Promise.reject(new Error(msg("editor"))),
    custom: () => Promise.reject(new Error(msg("custom"))),
  };
}

function makeUnavailableUIContext(): WorkflowUIContext {
  return makeRejectingUIContext(
    (primitive) =>
      `atomic-workflows: HIL ctx.ui.${primitive} is unavailable because Atomic runtime did not provide a UI adapter`,
  );
}

/**
 * UI context for headless (non-interactive) runs without a UI adapter: every
 * interactive primitive fails with a clear, actionable error that names the
 * headless mode instead of surfacing a raw
 * `TypeError: ctx.ui.custom is not a function` from a missing TUI (#1339).
 */
function makeHeadlessUnavailableUIContext(): WorkflowUIContext {
  return makeRejectingUIContext(
    (primitive) =>
      `atomic-workflows: interactive ctx.ui.${primitive} is unavailable in headless (non-interactive) mode; run the workflow in interactive mode or remove the interactive prompt from this stage`,
  );
}

function normalizeUIContext(adapter: WorkflowUIAdapter | undefined): WorkflowUIContext {
  const unavailable = makeUnavailableUIContext();
  if (adapter === undefined) return unavailable;
  // Guard every method: loosely-typed callers can hand over partial adapters
  // (headless hosts especially), and an unguarded call would surface a raw
  // "x is not a function" TypeError that kills the whole run (#1339).
  return {
    input(prompt) {
      return typeof adapter.input === "function"
        ? adapter.input.call(adapter, prompt)
        : unavailable.input(prompt);
    },
    confirm(message) {
      return typeof adapter.confirm === "function"
        ? adapter.confirm.call(adapter, message)
        : unavailable.confirm(message);
    },
    select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      return typeof adapter.select === "function"
        ? adapter.select.call(adapter, message, options) as Promise<T>
        : unavailable.select(message, options);
    },
    editor(initial) {
      return typeof adapter.editor === "function"
        ? adapter.editor.call(adapter, initial)
        : unavailable.editor(initial);
    },
    custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      return typeof adapter.custom === "function"
        ? adapter.custom.call(adapter, factory, options) as Promise<T>
        : unavailable.custom(factory, options);
    },
  };
}

type AskUserQuestionToolEvent =
  | { phase: "start"; callId?: string; args?: unknown }
  | { phase: "end"; callId?: string; nameMatched: boolean };

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function isAskUserQuestionToolName(name: string | undefined): boolean {
  if (name === undefined) return false;
  return name.toLowerCase().replace(/[^a-z0-9]/g, "") === "askuserquestion";
}

function askUserQuestionToolEvent(event: unknown): AskUserQuestionToolEvent | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const toolName = stringField(record, ["toolName", "tool_name", "name"]);
  const callId = stringField(record, ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id"]);

  if (type === "tool_execution_start" && isAskUserQuestionToolName(toolName)) {
    return { phase: "start", callId, args: record["args"] };
  }
  if (type === "tool_execution_end" || type === "tool_execution_error" || type === "tool_result") {
    return { phase: "end", callId, nameMatched: isAskUserQuestionToolName(toolName) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Readiness gate (#1099)
// ---------------------------------------------------------------------------
// A stage's agent turn returns control to the user when it ends. If that turn
// issued no ask_user_question call, the stage completes and the workflow
// advances automatically. If the turn DID ask the user something, a
// deterministic readiness gate (the structured ask_user_question UI, rendered
// inline in the attached stage chat via the broker) is shown when the turn
// ends. Choosing "I'm ready to move on…" advances; anything else (the
// keep-exploring option, a typed answer, "Chat about this", or cancelling)
// returns control to the user, who keeps working in the normal stage composer.
// The same per-turn check re-applies after each subsequent user-driven turn.

export const READINESS_GATE_ADVANCE_LABEL = "I'm ready to move on to the next workflow stage.";

const READINESS_GATE_ADVANCE_NORMALIZED = READINESS_GATE_ADVANCE_LABEL.trim().toLowerCase();

export const READINESS_GATE_QUESTION_PARAMS = {
  questions: [
    {
      question: "Any additional points to explore before moving on?",
      header: "Continue?",
      options: [
        {
          label: READINESS_GATE_ADVANCE_LABEL,
          description: "Complete this stage and advance the workflow.",
        },
        {
          label: "I have more to explore or ask about.",
          description: "Stay in this stage and keep working in the chat composer.",
        },
      ],
    },
  ],
};

/**
 * Decide whether a brokered readiness-gate result selected the "advance"
 * option. Tolerant of case/whitespace and of the advance label arriving via a
 * multi-select `selected[]` entry, so a structured answer that canonicalized to
 * the advance option still completes the stage. Anything else (the explore
 * option, a typed answer, a cancelled/empty result) means "stay".
 */
export function readinessResultMeansAdvance(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const details = (result as {
    details?: {
      answers?: ReadonlyArray<{ answer?: unknown; selected?: ReadonlyArray<unknown> }>;
      cancelled?: boolean;
    };
  }).details;
  if (details === undefined || details.cancelled === true) return false;
  const first = details.answers?.[0];
  if (first === undefined) return false;
  const candidates: unknown[] = [first.answer];
  if (Array.isArray(first.selected)) candidates.push(...first.selected);
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.trim().toLowerCase() === READINESS_GATE_ADVANCE_NORMALIZED,
  );
}

/**
 * True when a raw tool-result record from an `ask_user_question` call carries a
 * `details.answers[].kind === "chat"` entry. Used by the readiness-gate watcher
 * to skip `confirmReadiness` and return control directly to the stage composer.
 */
export function toolResultHasChatAnswer(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const details = (result as Record<string, unknown>)["details"];
  if (details === null || typeof details !== "object") return false;
  const answers = (details as Record<string, unknown>)["answers"];
  if (!Array.isArray(answers)) return false;
  return answers.some(
    (a) => a !== null && typeof a === "object" && (a as Record<string, unknown>)["kind"] === "chat",
  );
}

let cachedReadinessGateTool: ReturnType<typeof createAskUserQuestionToolDefinition> | undefined;
function readinessGateTool(): ReturnType<typeof createAskUserQuestionToolDefinition> {
  return (cachedReadinessGateTool ??= createAskUserQuestionToolDefinition());
}

/**
 * Render the readiness gate inline in the attached stage chat by invoking the
 * ask_user_question tool with a pre-filled body, routing its custom UI through
 * the stage UI broker for (runId, stageId). Returns "advance" only when the
 * user chooses the move-on option; the keep-exploring option, "Chat about
 * this", a typed answer, or cancellation all mean "stay". If no stage chat host
 * is attached the broker request stays pending (the stage shows awaiting_input)
 * exactly like the tool itself.
 */
export async function askReadinessViaStageBroker(
  runId: string,
  stageId: string,
  signal: AbortSignal,
): Promise<"advance" | "stay"> {
  const execute = readinessGateTool().execute;
  if (execute === undefined) return "advance";
  const gateContext = {
    hasUI: true,
    ui: {
      custom: (factory: unknown, options?: unknown): Promise<unknown> =>
        stageUiBroker.requestCustomUi(
          runId,
          stageId,
          factory as Parameters<typeof stageUiBroker.requestCustomUi>[2],
          options as Parameters<typeof stageUiBroker.requestCustomUi>[3],
          signal,
        ),
    },
  };
  // Expose a headless-answer adapter for the gate so it can be answered
  // programmatically (e.g. `workflow send`) without a TUI host. The gate
  // question params are known statically here.
  const gatePromptId = `readiness-gate-${stageId}-${crypto.randomUUID()}`;
  const gateAdapter = buildStagePromptAdapter(
    gatePromptId,
    "readiness_gate",
    READINESS_GATE_QUESTION_PARAMS,
    Date.now(),
  );
  if (gateAdapter) stageUiBroker.provideStagePrompt(runId, stageId, gateAdapter);
  try {
    const result = await execute(
      gatePromptId,
      READINESS_GATE_QUESTION_PARAMS as Parameters<typeof execute>[1],
      signal,
      undefined,
      gateContext as unknown as Parameters<typeof execute>[4],
    );
    return readinessResultMeansAdvance(result) ? "advance" : "stay";
  } finally {
    stageUiBroker.clearStagePrompt(runId, stageId);
  }
}

// ---------------------------------------------------------------------------
// raceAbort — races a promise against an AbortSignal
// ---------------------------------------------------------------------------

function normalizeTaskContexts(
  previous: WorkflowTaskOptions["previous"],
): Array<{ readonly name?: string; readonly text: string }> {
  if (previous === undefined) return [];
  const items = Array.isArray(previous) ? previous : [previous];
  return items
    .map((item: WorkflowTaskContextInput) => {
      if (typeof item === "string") return { text: item };
      return item.name ? { name: item.name, text: item.text } : { text: item.text };
    })
    .filter((item) => item.text.trim().length > 0);
}

function renderTaskContext(contexts: readonly { readonly name?: string; readonly text: string }[]): string {
  if (contexts.length === 0) return "";
  if (contexts.length === 1 && contexts[0]?.name === undefined) return contexts[0]!.text;
  return contexts
    .map((context, index) => {
      const label = context.name ?? `context-${index + 1}`;
      return `--- ${label} ---\n${context.text}`;
    })
    .join("\n\n");
}

function applyTaskContext(prompt: string, previous: WorkflowTaskOptions["previous"]): string {
  const contexts = normalizeTaskContexts(previous);
  if (contexts.length === 0) return prompt;

  const lastPrevious = contexts[contexts.length - 1]?.text ?? "";
  const rendered = renderTaskContext(contexts);
  let next = prompt.replace(/\{previous\}/g, lastPrevious);

  if (next !== prompt) return next;
  next += `\n\n---\nContext:\n${rendered}`;
  return next;
}

function taskPrompt(options: WorkflowTaskOptions): string {
  const prompt = options.prompt ?? options.task;
  if (prompt === undefined) {
    throw new Error("atomic-workflows: ctx.task requires options.prompt or options.task");
  }
  return prompt;
}

function taskPrevious(options: WorkflowTaskOptions): WorkflowTaskOptions["previous"] {
  return options.previous;
}

type WorkflowTaskExecutionOptions = WorkflowTaskOptions & { chainDir?: string };

function resolveWorkflowPath(filePath: string, baseDir: string | undefined): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(baseDir ?? process.cwd(), filePath);
}

function taskBaseDir(options: Pick<WorkflowTaskExecutionOptions, "chainDir" | "cwd">): string | undefined {
  if (typeof options.chainDir === "string" && options.chainDir.length > 0) {
    return resolveWorkflowPath(options.chainDir, process.cwd());
  }
  if (typeof options.cwd === "string" && options.cwd.length > 0) {
    return resolveWorkflowPath(options.cwd, process.cwd());
  }
  return undefined;
}

function taskReadInstruction(options: WorkflowTaskExecutionOptions): string {
  if (options.reads === false || options.reads === undefined || options.reads.length === 0) return "";
  const baseDir = taskBaseDir(options);
  const files = options.reads.map((file) => resolveWorkflowPath(file, baseDir));
  return `[Read from: ${files.join(", ")}]\n\n`;
}

function taskPromptOptions(options: WorkflowTaskExecutionOptions): StagePromptOptions | undefined {
  const baseDir = taskBaseDir(options);
  const promptOptions: StagePromptOptions = {
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(baseDir !== undefined ? { cwd: baseDir } : options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxOutput !== undefined ? { maxOutput: options.maxOutput } : {}),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
  };
  return Object.keys(promptOptions).length === 0 ? undefined : promptOptions;
}

function taskStageOptions(options: WorkflowTaskExecutionOptions): StageOptions {
  const {
    prompt: _prompt,
    task: _task,
    previous: _previous,
    chainDir: _chainDir,
    output: _output,
    outputMode: _outputMode,
    reads: _reads,
    worktree: _worktree,
    gitWorktreeDir: _gitWorktreeDir,
    baseBranch: _baseBranch,
    maxOutput: _maxOutput,
    artifacts: _artifacts,
    ...stageOptions
  } = options;
  return stageOptions;
}

function taskOptionsFromStep(step: WorkflowTaskStep, prompt: string, previous?: WorkflowTaskOptions["previous"]): WorkflowTaskOptions {
  const {
    name: _name,
    prompt: _prompt,
    task: _task,
    previous: _previous,
    ...stepOptions
  } = step;
  return previous === undefined
    ? { ...stepOptions, prompt }
    : { ...stepOptions, prompt, previous };
}

function replaceTaskPlaceholder(prompt: string, task: string): string {
  return prompt.replace(/\{task\}/g, task);
}

function chainStepPrompt(step: WorkflowTaskStep, index: number): string {
  return step.prompt ?? step.task ?? (index === 0 ? "{task}" : "{previous}");
}

function parallelFallbackTask(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): string {
  if (options?.task !== undefined) return options.task;
  for (const step of steps) {
    const task = step.prompt ?? step.task;
    if (task !== undefined) return task;
  }
  return "";
}

function directTaskPrompt(item: WorkflowDirectTaskItem): string | undefined {
  return item.prompt ?? item.task;
}

function directModelRequestsFromChain(
  chain: readonly WorkflowChainStep[],
  options: WorkflowDirectOptions,
): Array<{ readonly model?: WorkflowDirectTaskItem["model"]; readonly fallbackModels?: readonly string[] }> {
  const requests: Array<{ readonly model?: WorkflowDirectTaskItem["model"]; readonly fallbackModels?: readonly string[] }> = [];
  for (const step of chain) {
    if ("parallel" in step) {
      requests.push(...step.parallel.map((item) => directTaskWithDefaults(item, options)));
    } else {
      requests.push(directTaskWithDefaults(step, options));
    }
  }
  return requests;
}

async function validateDirectModels(
  tasks: readonly WorkflowDirectTaskItem[],
  runOptions: RunOpts,
): Promise<readonly string[]> {
  return validateWorkflowModels({
    requests: tasks.map((task) => ({ model: task.model, fallbackModels: task.fallbackModels })),
    catalog: runOptions.models,
  });
}

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 5000;

function normalizeMaxOutput(maxOutput: WorkflowMaxOutput | undefined): Required<WorkflowMaxOutput> {
  return {
    bytes: maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    lines: maxOutput?.lines ?? DEFAULT_MAX_OUTPUT_LINES,
  };
}

function truncateByLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return { text: "", truncated: text.length > 0 };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { text: text.slice(0, low), truncated: true };
}

function structuredTaskOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`atomic-workflows: structured task output is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function truncateTaskOutput(text: string, maxOutput: WorkflowMaxOutput | undefined): string {
  const limits = normalizeMaxOutput(maxOutput);
  const byLines = truncateByLines(text, limits.lines);
  const byBytes = truncateByBytes(byLines.text, limits.bytes);
  if (!byLines.truncated && !byBytes.truncated) return text;
  return `${byBytes.text}\n\n[workflow output truncated; limits: ${limits.bytes} bytes, ${limits.lines} lines]`;
}

function withoutUndefinedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

function sharedTaskDefaultsFromOptions(
  options: WorkflowChainOptions | WorkflowParallelOptions,
): Partial<WorkflowTaskExecutionOptions> {
  const {
    task: _task,
    concurrency: _concurrency,
    failFast: _failFast,
    ...taskDefaults
  } = options as WorkflowParallelOptions;
  return withoutUndefinedProperties(taskDefaults);
}

function taskWithSharedDefaults(
  taskOptions: WorkflowTaskOptions,
  options: WorkflowChainOptions | WorkflowParallelOptions,
): WorkflowTaskExecutionOptions {
  return {
    ...sharedTaskDefaultsFromOptions(options),
    ...withoutUndefinedProperties(taskOptions),
  } as WorkflowTaskExecutionOptions;
}

function directTaskWithDefaults(
  item: WorkflowDirectTaskItem,
  options: WorkflowDirectOptions,
): WorkflowDirectTaskItem {
  const {
    task: _task,
    chainName: _chainName,
    concurrency: _concurrency,
    failFast: _failFast,
    chainDir: _chainDir,
    reads,
    output,
    outputMode,
    worktree,
    gitWorktreeDir,
    baseBranch,
    maxOutput,
    artifacts,
    ...stageDefaults
  } = options;

  const taskWithStageDefaults = {
    ...withoutUndefinedProperties(stageDefaults),
    ...withoutUndefinedProperties(item),
    name: item.name,
  } as WorkflowDirectTaskItem;

  return {
    ...taskWithStageDefaults,
    ...(item.reads === undefined && reads !== undefined ? { reads } : {}),
    ...(item.output === undefined && output !== undefined ? { output } : {}),
    ...(item.outputMode === undefined && outputMode !== undefined ? { outputMode } : {}),
    ...(item.worktree === undefined && worktree !== undefined ? { worktree } : {}),
    ...(item.gitWorktreeDir === undefined && gitWorktreeDir !== undefined ? { gitWorktreeDir } : {}),
    ...(item.baseBranch === undefined && baseBranch !== undefined ? { baseBranch } : {}),
    ...(item.maxOutput === undefined && maxOutput !== undefined ? { maxOutput } : {}),
    ...(item.artifacts === undefined && artifacts !== undefined ? { artifacts } : {}),
  };
}

function directTaskToStep(
  item: WorkflowDirectTaskItem,
  fallbackPrompt?: string,
  previous?: WorkflowTaskOptions["previous"],
): WorkflowTaskStep {
  const {
    count: _count,
    output: _output,
    outputMode: _outputMode,
    worktree: _worktree,
    prompt,
    task,
    previous: itemPrevious,
    ...stageOptions
  } = item;
  return {
    ...stageOptions,
    prompt: prompt ?? task ?? fallbackPrompt,
    previous: previous ?? itemPrevious,
  };
}

function positiveConcurrency(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

async function mapParallelSteps<T>(
  steps: readonly WorkflowTaskStep[],
  concurrency: number | undefined,
  failFast: boolean | undefined,
  mapper: (step: WorkflowTaskStep) => Promise<T>,
  onFirstFailure?: (error: unknown) => void,
  control?: {
    readonly beforeDequeue?: () => void;
    readonly beforeMap?: () => void;
    readonly isControlSignal?: (error: unknown) => boolean;
  },
): Promise<T[]> {
  const limit = positiveConcurrency(concurrency) ?? steps.length;
  const failFastEnabled = failFast !== false;
  const results = new Array<T>(steps.length);
  const failures: Array<{ readonly index: number; readonly error: unknown }> = [];
  let nextIndex = 0;
  let firstFailure: unknown;
  let controlSignal: unknown;
  let rejectFirstFailure: (reason: unknown) => void = () => {};
  const firstFailurePromise = new Promise<never>((_, reject) => {
    rejectFirstFailure = reject;
  });

  const isControlSignal = (error: unknown): boolean => control?.isControlSignal?.(error) === true;
  const selectControlSignal = (error: unknown): void => {
    if (controlSignal !== undefined) return;
    controlSignal = error;
    if (failFastEnabled) rejectFirstFailure(error);
  };
  const recordFailure = (index: number, error: unknown): void => {
    failures.push({ index, error });
    if (firstFailure === undefined) {
      firstFailure = error;
      onFirstFailure?.(error);
      if (failFastEnabled) rejectFirstFailure(error);
    }
  };

  async function worker(): Promise<void> {
    while (true) {
      if (controlSignal !== undefined) return;
      if (failFastEnabled && firstFailure !== undefined) return;
      try {
        control?.beforeDequeue?.();
      } catch (err) {
        if (isControlSignal(err)) {
          selectControlSignal(err);
          return;
        }
        recordFailure(nextIndex, err);
        return;
      }
      if (controlSignal !== undefined) return;
      const index = nextIndex;
      nextIndex += 1;
      const step = steps[index];
      if (step === undefined) return;
      try {
        control?.beforeMap?.();
        results[index] = await mapper(step);
      } catch (err) {
        if (isControlSignal(err)) {
          selectControlSignal(err);
          return;
        }
        recordFailure(index, err);
        if (failFastEnabled) return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, steps.length) }, () => worker());
  const allWorkers = Promise.all(workers);

  if (!failFastEnabled) {
    await allWorkers;
  } else {
    try {
      await Promise.race([allWorkers, firstFailurePromise]);
    } catch (err) {
      void allWorkers.catch(() => {});
      throw err;
    }
  }

  if (controlSignal !== undefined) {
    throw controlSignal;
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `atomic-workflows: ${failures.length} parallel ${failures.length === 1 ? "step" : "steps"} failed`,
    );
  }

  return results;
}

function expandedParallelTasks(tasks: readonly WorkflowDirectTaskItem[]): WorkflowDirectTaskItem[] {
  const expanded: WorkflowDirectTaskItem[] = [];
  for (const task of tasks) {
    const count = task.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`atomic-workflows: direct task "${task.name}" count must be a positive integer`);
    }
    for (let index = 0; index < count; index += 1) {
      expanded.push(count === 1 ? task : {
        ...task,
        name: `${task.name}-${index + 1}`,
        count: undefined,
        output: namespaceRepeatedOutput(task.output, index),
      });
    }
  }
  return expanded;
}

function namespaceRepeatedOutput(output: WorkflowDirectTaskItem["output"], index: number): WorkflowDirectTaskItem["output"] {
  if (typeof output !== "string") return output;
  const ext = extname(output);
  const base = basename(output, ext);
  return join(dirname(output), `${base}-${index + 1}${ext}`);
}

interface PreparedDirectWorktrees {
  readonly tasks: WorkflowDirectTaskItem[];
  readonly setup?: WorktreeSetup;
  readonly agents: string[];
  readonly diffsDir?: string;
}

function directRunId(runOptions: RunOpts): string {
  return runOptions.runId ?? crypto.randomUUID();
}

function hasDirectWorktreeIsolation(tasks: readonly WorkflowDirectTaskItem[], options: WorkflowDirectOptions): boolean {
  return options.worktree === true || tasks.some((task) => task.worktree === true);
}

function resolveSharedDirectWorktreeCwd(tasks: readonly WorkflowDirectTaskItem[]): string {
  const explicitCwd = tasks.find((task) => typeof task.cwd === "string")?.cwd;
  if (explicitCwd === undefined) return process.cwd();
  return isAbsolute(explicitCwd) ? explicitCwd : resolve(process.cwd(), explicitCwd);
}

function normalizeDirectTaskCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
}

function resolveWorktreeCwdOverride(cwd: string | undefined, worktreeCwd: string): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;
  return isAbsolute(cwd) ? cwd : resolve(worktreeCwd, cwd);
}

function stageOptionsWithInputDefaults<T extends StageOptions>(options: T | undefined, inputDefaults: Partial<StageOptions>): T | undefined {
  const defaults = withoutUndefinedProperties(inputDefaults);
  if (Object.keys(defaults).length === 0) return options;
  return { ...defaults, ...withoutUndefinedProperties(options ?? {}) } as T;
}

function stageOptionsWithGitWorktree<T extends StageOptions>(options: T | undefined, workflowInvocationCwd: string): T | undefined {
  if (options === undefined) return undefined;
  if (typeof options.gitWorktreeDir !== "string" || options.gitWorktreeDir.trim().length === 0) {
    return options;
  }
  const setup = setupGitWorktree({
    gitWorktreeDir: options.gitWorktreeDir,
    baseBranch: options.baseBranch,
    cwd: workflowInvocationCwd,
  });
  const explicitCwd = resolveWorktreeCwdOverride(options.cwd, setup.cwd);
  return { ...options, gitWorktreeDir: undefined, baseBranch: undefined, cwd: explicitCwd ?? setup.cwd };
}

function workflowCwdWithInputWorktree(inputDefaults: Partial<StageOptions>, workflowInvocationCwd: string): string {
  if (typeof inputDefaults.gitWorktreeDir !== "string" || inputDefaults.gitWorktreeDir.trim().length === 0) {
    return workflowInvocationCwd;
  }
  return setupGitWorktree({
    gitWorktreeDir: inputDefaults.gitWorktreeDir,
    baseBranch: inputDefaults.baseBranch,
    cwd: workflowInvocationCwd,
  }).cwd;
}

function directWorktreeDiffsDir(options: WorkflowDirectOptions, setup: WorktreeSetup, runId: string, scope: string): string {
  const baseDir = options.chainDir ?? join(setup.cwd, CONFIG_DIR_NAME, "workflows");
  return join(baseDir, "worktree-diffs", runId, scope);
}

function prepareDirectWorktrees(
  tasks: readonly WorkflowDirectTaskItem[],
  options: WorkflowDirectOptions,
  runId: string,
  scope: string,
): PreparedDirectWorktrees {
  if (!hasDirectWorktreeIsolation(tasks, options)) {
    return {
      tasks: [...tasks],
      agents: tasks.map((task) => task.name),
    };
  }

  if (typeof options.gitWorktreeDir === "string" || tasks.some((task) => typeof task.gitWorktreeDir === "string")) {
    throw new Error("atomic-workflows: worktree and gitWorktreeDir are mutually exclusive; use gitWorktreeDir for a reusable worktree or worktree:true for temporary isolated worktrees.");
  }

  const sharedCwd = resolveSharedDirectWorktreeCwd(tasks);
  const conflict = findWorktreeTaskCwdConflict(
    tasks.map((task) => ({ agent: task.name, cwd: normalizeDirectTaskCwd(task.cwd) })),
    sharedCwd,
  );
  if (conflict !== undefined) {
    throw new Error(formatWorktreeTaskCwdConflict(conflict, sharedCwd));
  }

  const agents = tasks.map((task) => task.name);
  const setup = createWorktrees(sharedCwd, runId, tasks.length, { agents });
  return {
    tasks: tasks.map((task, index) => ({
      ...task,
      cwd: setup.worktrees[index]!.agentCwd,
    })),
    setup,
    agents,
    diffsDir: directWorktreeDiffsDir(options, setup, runId, scope),
  };
}

function collectWorktreeDiffs(prepared: PreparedDirectWorktrees, enabled = true): {
  artifacts: WorkflowArtifact[];
  summary?: string;
} {
  if (!enabled || prepared.setup === undefined || prepared.diffsDir === undefined) {
    return { artifacts: [] };
  }

  const diffs = diffWorktrees(prepared.setup, prepared.agents, prepared.diffsDir);
  const artifacts = diffs.map((diff) => ({
    kind: "diff" as const,
    path: diff.patchPath,
    taskName: diff.agent,
    branch: diff.branch,
    diffStat: diff.diffStat,
    filesChanged: diff.filesChanged,
    insertions: diff.insertions,
    deletions: diff.deletions,
  }));
  const summary = formatWorktreeDiffSummary(diffs);
  return {
    artifacts,
    ...(summary.length > 0 ? { summary } : {}),
  };
}

function isRunOpts(value: WorkflowDirectOptions | RunOpts | undefined): value is RunOpts {
  if (value === undefined) return false;
  return (
    "adapters" in value ||
    "ui" in value ||
    "store" in value ||
    "persistence" in value ||
    "mcp" in value ||
    "cancellation" in value ||
    "overlay" in value ||
    "signal" in value ||
    "config" in value ||
    "depth" in value ||
    "stageControlRegistry" in value ||
    "runId" in value ||
    "onRunStart" in value ||
    "onStageStart" in value ||
    "onStageEnd" in value ||
    "onRunEnd" in value ||
    "models" in value
  );
}

async function writeDirectOutput(
  item: { readonly chainDir?: string; readonly cwd?: string; readonly output?: string | false; readonly outputMode?: WorkflowOutputMode },
  result: WorkflowTaskResult,
): Promise<{ result: WorkflowTaskResult; artifact?: WorkflowArtifact }> {
  if (typeof item.output !== "string") return { result };

  const outputPath = resolveWorkflowPath(item.output, taskBaseDir(item));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.text, "utf8");

  const visibleResult =
    item.outputMode === "file-only"
      ? { ...result, text: "" }
      : result;

  return {
    result: visibleResult,
    artifact: {
      kind: "output",
      path: outputPath,
      taskName: result.name,
    },
  };
}

function directFailureMessage(error: unknown): string {
  return classifyWorkflowFailure(error).userMessage;
}

function failedDirectDetails(
  mode: WorkflowDetails["mode"],
  runId: string,
  total: number,
  error: unknown,
  options: WorkflowDirectOptions = {},
): WorkflowDetails {
  return {
    mode,
    action: "run",
    runId,
    status: "failed",
    ...(options.context !== undefined ? { context: options.context } : {}),
    results: [],
    progress: { completed: 0, total },
    error: directFailureMessage(error),
  };
}

function workflowDetailsFromRun(
  mode: WorkflowDetails["mode"],
  runResult: RunResult,
  results: readonly WorkflowTaskResult[],
  options: WorkflowDirectOptions = {},
  warnings: readonly string[] = [],
): WorkflowDetails {
  const sessionArtifacts = options.artifacts === false ? [] : results.flatMap((result) =>
    result.sessionFile === undefined
      ? []
      : [{ kind: "session" as const, path: result.sessionFile, taskName: result.name }],
  );
  const outputArtifacts = Array.isArray(runResult.result?.["artifacts"])
    ? runResult.result["artifacts"] as WorkflowArtifact[]
    : [];
  const artifacts = [...outputArtifacts, ...sessionArtifacts];
  const resultWarnings = results.flatMap((result) => result.warnings ?? []);
  const allWarnings = [...warnings, ...resultWarnings];
  return {
    mode,
    action: "run",
    runId: runResult.runId,
    status: isWorkflowExitStatus(runResult.status)
      ? runResult.status
      : runResult.status === "failed"
        ? "failed"
        : runResult.status === "killed"
          ? "killed"
          : "running",
    ...(options.context !== undefined ? { context: options.context } : {}),
    results: [...results],
    output: runResult.result,
    progress: { completed: results.length, total: results.length },
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(runResult.error !== undefined ? { error: runResult.error } : {}),
    ...(runResult.exited !== undefined ? { exited: runResult.exited } : {}),
    ...(runResult.exitReason !== undefined ? { exitReason: runResult.exitReason } : {}),
  };
}

const EMPTY_WORKFLOW_GRAPH_ERROR_MESSAGE = "Workflow run completed without creating any workflow stages. Create at least one stage with ctx.stage(), ctx.task(), ctx.chain(), ctx.parallel(), or ctx.workflow().";

function assertWorkflowCreatedStage(runSnapshot: RunSnapshot): void {
  if (runSnapshot.stages.length > 0) return;
  throw new Error(EMPTY_WORKFLOW_GRAPH_ERROR_MESSAGE);
}

// Direct (task/parallel/chain) execution synthesizes ephemeral workflows that
// expose tool-parity outputs. They are declared explicitly like any other
// workflow so the fully-explicit output contract holds on the direct path too.
// `unknown` accepts any serializable value, and every key is optional because a
// given direct mode only returns the subset it produces (e.g. `count` for chain/
// parallel, `text` for single task, `worktreeSummary` only with worktrees).
const DIRECT_WORKFLOW_OUTPUTS: Readonly<Record<string, WorkflowOutputSchema>> = Object.freeze({
  results: Type.Optional(Type.Unknown()),
  text: Type.Optional(Type.Unknown()),
  count: Type.Optional(Type.Unknown()),
  artifacts: Type.Optional(Type.Unknown()),
  worktreeSummary: Type.Optional(Type.Unknown()),
});

function defineDirectWorkflow(
  name: string,
  runFn: WorkflowDefinition["run"],
): WorkflowDefinition {
  const definition = {
    __piWorkflow: true,
    name,
    normalizedName: name,
    description: "Direct workflow execution",
    inputs: Object.freeze({}),
    outputs: DIRECT_WORKFLOW_OUTPUTS,
    run: runFn,
  } as WorkflowDefinition;
  // Stamp before freezing so the WeakSet brand can be attached.
  stampWorkflowDefinition(definition);
  return Object.freeze(definition);
}

/**
 * SDK helper for direct single-task execution. It synthesizes an ephemeral
 * workflow and reuses the normal executor so store snapshots, cancellation,
 * persistence, and stage session behavior stay on the same runtime path.
 */
export function runTask(
  task: WorkflowDirectTaskItem,
  runOptions?: RunOpts,
): Promise<WorkflowDetails>;
export function runTask(
  task: WorkflowDirectTaskItem,
  options?: WorkflowDirectOptions,
  runOptions?: RunOpts,
): Promise<WorkflowDetails>;
export async function runTask(
  task: WorkflowDirectTaskItem,
  optionsOrRunOptions: WorkflowDirectOptions | RunOpts = {},
  maybeRunOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const options = isRunOpts(optionsOrRunOptions) ? {} : optionsOrRunOptions;
  const runOptions = isRunOpts(optionsOrRunOptions) ? optionsOrRunOptions : maybeRunOptions;
  const runId = directRunId(runOptions);
  const taskWithDefaults = directTaskWithDefaults(task, options);
  let validationWarnings: readonly string[] = [];
  try {
    validationWarnings = await validateDirectModels([taskWithDefaults], runOptions);
  } catch (err) {
    return failedDirectDetails("single", runId, 1, err, options);
  }
  const prepared = prepareDirectWorktrees([taskWithDefaults], options, runId, "single");
  const preparedTask = prepared.tasks[0]!;
  const direct = defineDirectWorkflow("direct-task", async (ctx) => {
    try {
      const rawResult = await ctx.task(preparedTask.name, directTaskToStep(preparedTask));
      const { result, artifact } = await writeDirectOutput(preparedTask, rawResult);
      const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
      return {
        results: [result],
        text: result.text,
        artifacts: [
          ...worktreeDiffs.artifacts,
          ...(artifact === undefined ? [] : [artifact]),
        ],
        ...(worktreeDiffs.summary === undefined ? {} : { worktreeSummary: worktreeDiffs.summary }),
      };
    } finally {
      if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
    }
  });
  const runResult = await run(direct, {}, { ...runOptions, runId });
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("single", runResult, results, options, validationWarnings);
}

/** SDK helper for direct top-level parallel task execution. */
export async function runParallel(
  tasks: readonly WorkflowDirectTaskItem[],
  options: WorkflowDirectOptions = {},
  runOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const tasksWithDefaults = tasks.map((task) => directTaskWithDefaults(task, options));
  const expanded = expandedParallelTasks(tasksWithDefaults);
  const runId = directRunId(runOptions);
  let validationWarnings: readonly string[] = [];
  try {
    validationWarnings = await validateDirectModels(expanded, runOptions);
  } catch (err) {
    return failedDirectDetails("parallel", runId, expanded.length, err, options);
  }
  const prepared = prepareDirectWorktrees(expanded, options, runId, "parallel");
  const direct = defineDirectWorkflow("direct-parallel", async (ctx) => {
    try {
      const steps = prepared.tasks.map((task) => directTaskToStep(task));
      const rawResults = await ctx.parallel(steps, {
        task: options.task,
        concurrency: options.concurrency,
        failFast: options.failFast,
      });
      const persisted = await Promise.all(
        rawResults.map((result, index) => writeDirectOutput(prepared.tasks[index]!, result)),
      );
      const results = persisted.map((item) => item.result);
      const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
      const artifacts = [
        ...worktreeDiffs.artifacts,
        ...persisted.flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
      ];
      return {
        results,
        count: results.length,
        artifacts,
        ...(worktreeDiffs.summary === undefined ? {} : { worktreeSummary: worktreeDiffs.summary }),
      };
    } finally {
      if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
    }
  });
  const runResult = await run(direct, {}, { ...runOptions, runId });
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("parallel", runResult, results, options, validationWarnings);
}

async function runDirectChainStep(
  ctx: WorkflowRunContext,
  step: WorkflowChainStep,
  index: number,
  rootTask: string,
  prior: WorkflowTaskResult | readonly WorkflowTaskResult[] | undefined,
  options: WorkflowDirectOptions,
  runId: string,
): Promise<{ results: WorkflowTaskResult[]; artifacts: WorkflowArtifact[] }> {
  if ("parallel" in step) {
    const stepOptions = {
      ...options,
      worktree: options.worktree === true || step.worktree === true,
      ...(step.gitWorktreeDir !== undefined ? { gitWorktreeDir: step.gitWorktreeDir } : {}),
      ...(step.baseBranch !== undefined ? { baseBranch: step.baseBranch } : {}),
    };
    const expanded = expandedParallelTasks(step.parallel.map((item) => directTaskWithDefaults(item, stepOptions)));
    const prepared = prepareDirectWorktrees(expanded, stepOptions, `${runId}-s${index}`, `step-${index}`);
    try {
      const steps = prepared.tasks.map((item) =>
        directTaskToStep(item, directTaskPrompt(item) ?? "{previous}", item.previous ?? prior),
      );
      const rawResults = await ctx.parallel(steps, {
        task: rootTask,
        concurrency: step.concurrency ?? options.concurrency,
        failFast: step.failFast ?? options.failFast,
        ...(typeof options.chainDir === "string" ? { chainDir: options.chainDir } : {}),
      } as WorkflowParallelOptions);
      const persisted = await Promise.all(
        rawResults.map((result, taskIndex) =>
          writeDirectOutput({ ...prepared.tasks[taskIndex]!, chainDir: options.chainDir }, result),
        ),
      );
      const worktreeDiffs = collectWorktreeDiffs(prepared, stepOptions.artifacts !== false);
      return {
        results: persisted.map((item) => item.result),
        artifacts: [
          ...worktreeDiffs.artifacts,
          ...persisted.flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
        ],
      };
    } finally {
      if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
    }
  }

  const prompt = directTaskPrompt(step) ?? (index === 0 ? "{task}" : "{previous}");
  const prepared = prepareDirectWorktrees([directTaskWithDefaults(step, options)], options, `${runId}-s${index}`, `step-${index}`);
  const preparedStep = prepared.tasks[0]!;
  try {
    const rawResult = await ctx.task(
      preparedStep.name,
      {
        ...directTaskToStep(preparedStep, replaceTaskPlaceholder(prompt, rootTask), preparedStep.previous ?? prior),
        ...(typeof options.chainDir === "string" ? { chainDir: options.chainDir } : {}),
      } as WorkflowTaskOptions,
    );
    const { result, artifact } = await writeDirectOutput({ ...preparedStep, chainDir: options.chainDir }, rawResult);
    const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
    return {
      results: [result],
      artifacts: [
        ...worktreeDiffs.artifacts,
        ...(artifact === undefined ? [] : [artifact]),
      ],
    };
  } finally {
    if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
  }
}

/** SDK helper for direct sequential/parallel chain execution. */
export async function runChain(
  chain: readonly WorkflowChainStep[],
  options: WorkflowDirectOptions = {},
  runOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const runId = directRunId(runOptions);
  let validationWarnings: readonly string[] = [];
  try {
    validationWarnings = await validateWorkflowModels({
      requests: directModelRequestsFromChain(chain, options),
      catalog: runOptions.models,
    });
  } catch (err) {
    return failedDirectDetails("chain", runId, chain.length, err, options);
  }
  const direct = defineDirectWorkflow("direct-chain", async (ctx) => {
    const results: WorkflowTaskResult[] = [];
    const artifacts: WorkflowArtifact[] = [];
    let prior: WorkflowTaskResult | readonly WorkflowTaskResult[] | undefined;
    for (let index = 0; index < chain.length; index += 1) {
      const step = await runDirectChainStep(ctx, chain[index]!, index, options.task ?? "", prior, options, runId);
      results.push(...step.results);
      artifacts.push(...step.artifacts);
      prior = step.results.length === 1 ? step.results[0] : step.results;
    }
    return { results, count: results.length, artifacts };
  });
  const runResult = await run(direct, {}, { ...runOptions, runId });
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("chain", runResult, results, options, validationWarnings);
}

export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // Callers invoke `raceAbort(call(), signal)`, so `call()` is evaluated —
    // and the underlying work (e.g. a stage prompt) is already in flight —
    // before this function observes an already-aborted signal. Attach a no-op
    // rejection handler so that in-flight promise can never surface as an
    // unhandled rejection. Without this, killing a workflow mid-prompt orphans
    // the prompt promise; its eventual rejection (commonly
    // "No API key found for ...") escapes every workflow error boundary and is
    // raised as a process-level uncaught exception that crashes the whole CLI.
    // The run is being aborted, so the orphaned settlement is intentionally
    // discarded here.
    void promise.catch(() => {});
    return Promise.reject(signal.reason ?? new DOMException("workflow killed", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("workflow killed", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

function appendRunEndWhenRecorded(
  persistence: WorkflowPersistencePort | undefined,
  recorded: boolean,
  payload: {
    readonly runId: string;
    readonly status: RunStatus;
    readonly result?: WorkflowOutputValues;
    readonly error?: string;
    readonly exited?: boolean;
    readonly exitReason?: string;
    readonly failureKind?: WorkflowFailureKind;
    readonly failureCode?: WorkflowFailureCode;
    readonly failureRecoverability?: WorkflowFailureRecoverability;
    readonly failureDisposition?: WorkflowFailureDisposition;
    readonly failureMessage?: string;
    readonly failedStageId?: string;
    readonly resumable?: boolean;
    readonly retryAfterMs?: number;
    readonly ts: number;
  },
): void {
  if (!persistence || !recorded) return;
  appendRunEnd(persistence, payload);
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "completed" ||
    status === "failed" ||
    status === "killed" ||
    status === "skipped" ||
    status === "cancelled" ||
    status === "blocked";
}

function runResultFromSnapshot(snapshot: RunSnapshot): RunResult {
  return {
    runId: snapshot.id,
    status: snapshot.status,
    ...(snapshot.result !== undefined ? { result: snapshot.result } : {}),
    ...(snapshot.error !== undefined ? { error: snapshot.error } : {}),
    ...(snapshot.exited !== undefined ? { exited: snapshot.exited } : {}),
    ...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
    stages: [...snapshot.stages],
  };
}

function reconcileTerminalRunResult(
  runId: string,
  runSnapshot: RunSnapshot,
  activeStore: Store,
  fallback: Omit<RunResult, "runId" | "stages">,
  onRunEnd: RunOpts["onRunEnd"],
): RunResult {
  const canonical = activeStore.runs().find((snapshot) =>
    snapshot.id === runId && isTerminalRunStatus(snapshot.status)
  );
  const result = canonical !== undefined
    ? runResultFromSnapshot(canonical)
    : {
        runId,
        ...fallback,
        stages: [...runSnapshot.stages],
      };
  // `recordRunEnd` is the terminal authority. If this finalizer lost because
  // an external kill or another terminal writer won while async cleanup was
  // pending, callbacks must observe the canonical store status, not the stale
  // intent that attempted this write. Persistence remains guarded separately by
  // the `recordRunEnd` boolean, so losing writes do not append duplicate
  // run-end entries.
  onRunEnd?.(runId, result.status, result.result, result.error, result.exitReason);
  return result;
}

interface RunFailureMetadata {
  readonly errorMessage: string;
  readonly failureKind: WorkflowFailureKind;
  readonly failureCode?: WorkflowFailureCode;
  readonly failureRecoverability?: WorkflowFailureRecoverability;
  readonly failureDisposition?: WorkflowFailureDisposition;
  readonly failureMessage: string;
  readonly failedStageId?: string;
  readonly resumable: boolean;
  readonly retryAfterMs?: number;
}

function applyFailureToStage(stage: StageSnapshot, failure: WorkflowFailure): void {
  stage.status = "failed";
  stage.error = failure.userMessage;
  stage.failureKind = failure.kind;
  stage.failureCode = failure.code;
  stage.failureRecoverability = failure.recoverability;
  stage.failureDisposition = failure.disposition;
  stage.retryAfterMs = failure.retryAfterMs;
  stage.failureMessage = failure.message;
}

function runFailureMetadata(
  failure: WorkflowFailure,
  stages: readonly StageSnapshot[],
): RunFailureMetadata {
  const failedStage = stages.find((stage) => stage.status === "failed");
  const failureKind = failedStage?.failureKind ?? failure.kind;
  const failureCode = failedStage?.failureCode ?? failure.code;
  const failureRecoverability = failedStage?.failureRecoverability ?? failure.recoverability;
  const failureDisposition = failedStage?.failureDisposition ?? failure.disposition;
  const retryAfterMs = failedStage?.retryAfterMs ?? failure.retryAfterMs;

  return {
    errorMessage: failedStage?.error ?? failure.userMessage,
    failureKind,
    ...(failureCode !== undefined ? { failureCode } : {}),
    failureRecoverability,
    failureDisposition,
    failureMessage: failedStage?.failureMessage ?? failure.message,
    ...(failedStage !== undefined ? { failedStageId: failedStage.id } : {}),
    resumable: failure.resumable,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

interface SelectedRunFailureMetadata extends RunFailureMetadata {
  readonly failedStageIds: readonly string[];
}

function stageDispositionResumable(
  disposition: WorkflowFailureDisposition | undefined,
  fallback: boolean,
): boolean {
  if (disposition === "terminal_killed") return false;
  if (disposition === "active_blocked") return true;
  return fallback;
}

function runFailureMetadataFromStage(
  fallbackFailure: WorkflowFailure,
  stage: StageSnapshot,
): RunFailureMetadata {
  const failureKind = stage.failureKind ?? fallbackFailure.kind;
  const failureCode = stage.failureCode ?? fallbackFailure.code;
  const failureRecoverability = stage.failureRecoverability ?? fallbackFailure.recoverability;
  const failureDisposition = stage.failureDisposition ?? fallbackFailure.disposition;
  const retryAfterMs = stage.retryAfterMs ?? fallbackFailure.retryAfterMs;

  return {
    errorMessage: stage.error ?? fallbackFailure.userMessage,
    failureKind,
    ...(failureCode !== undefined ? { failureCode } : {}),
    failureRecoverability,
    failureDisposition,
    failureMessage: stage.failureMessage ?? fallbackFailure.message,
    failedStageId: stage.id,
    resumable: stageDispositionResumable(failureDisposition, fallbackFailure.resumable),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

function runFailureMetadataFromFailure(
  failure: WorkflowFailure,
  failedStage: StageSnapshot | undefined,
): RunFailureMetadata {
  return {
    errorMessage: failedStage?.error ?? failure.userMessage,
    failureKind: failure.kind,
    ...(failure.code !== undefined ? { failureCode: failure.code } : {}),
    failureRecoverability: failure.recoverability,
    failureDisposition: failure.disposition,
    failureMessage: failedStage?.failureMessage ?? failure.message,
    ...(failedStage !== undefined ? { failedStageId: failedStage.id } : {}),
    resumable: failure.resumable,
    ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
  };
}

function safeArrayItems(value: unknown): readonly unknown[] {
  try {
    if (!Array.isArray(value)) return [];
    const items: unknown[] = [];
    const { length } = value;
    for (let index = 0; index < length; index += 1) {
      try {
        items.push(value[index]);
      } catch {
        // Treat an inaccessible aggregate item as no signal for that item while
        // preserving other readable items in the same aggregate branch.
      }
    }
    return items;
  } catch {
    return [];
  }
}

function safeExecutorAggregateErrorItems(error: unknown): readonly unknown[] {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return [];
  const errors = safeGetProperty(error, "errors");
  return errors.ok ? safeArrayItems(errors.value) : [];
}

function isAggregateWrapper(error: unknown): boolean {
  return safeExecutorAggregateErrorItems(error).length > 0;
}

function aggregateInnerFailures(
  error: unknown,
  classifyFailure: (error: unknown) => WorkflowFailure,
): readonly WorkflowFailure[] {
  return safeExecutorAggregateErrorItems(error).map((innerError) => classifyFailure(innerError));
}

type StageFailureCandidate = {
  readonly source: "stage";
  readonly stage: StageSnapshot;
  readonly disposition: WorkflowFailureDisposition;
  readonly recoverability: WorkflowFailureRecoverability;
};

type AggregateFailureCandidate = {
  readonly source: "aggregate";
  readonly failure: WorkflowFailure;
  readonly disposition: WorkflowFailureDisposition;
  readonly recoverability: WorkflowFailureRecoverability;
};

type OuterFailureCandidate = {
  readonly source: "outer";
  readonly failure: WorkflowFailure;
  readonly disposition: WorkflowFailureDisposition;
  readonly recoverability: WorkflowFailureRecoverability;
};

type FailureCandidate = StageFailureCandidate | AggregateFailureCandidate | OuterFailureCandidate;

function stageFailureCandidate(stage: StageSnapshot): StageFailureCandidate {
  return {
    source: "stage",
    stage,
    disposition: stage.failureDisposition ?? "terminal_failed",
    recoverability: stage.failureRecoverability ?? "unknown",
  };
}

function aggregateFailureCandidate(failure: WorkflowFailure): AggregateFailureCandidate {
  return {
    source: "aggregate",
    failure,
    disposition: failure.disposition,
    recoverability: failure.recoverability,
  };
}

function outerFailureCandidate(failure: WorkflowFailure): OuterFailureCandidate {
  return {
    source: "outer",
    failure,
    disposition: failure.disposition,
    recoverability: failure.recoverability,
  };
}

function isRecoverableActiveBlockedCandidate(candidate: FailureCandidate): boolean {
  return candidate.disposition === "active_blocked" && candidate.recoverability === "recoverable";
}

function runFailureMetadataFromCandidate(
  fallbackFailure: WorkflowFailure,
  candidate: FailureCandidate,
  thrownError: unknown,
): RunFailureMetadata {
  let metadata: RunFailureMetadata;
  switch (candidate.source) {
    case "stage":
      metadata = runFailureMetadataFromStage(fallbackFailure, candidate.stage);
      break;
    case "aggregate":
    case "outer":
      metadata = runFailureMetadataFromFailure(candidate.failure, undefined);
      break;
  }

  if (candidate.disposition === "terminal_failed" && isAggregateWrapper(thrownError)) {
    return { ...metadata, errorMessage: fallbackFailure.userMessage };
  }

  return metadata;
}

function failedStageIdsForCandidate(
  candidate: FailureCandidate,
  failedStages: readonly StageSnapshot[],
): readonly string[] {
  switch (candidate.source) {
    case "aggregate":
      return failedStages.map((stage) => stage.id);
    case "outer":
      return [];
    case "stage":
      return failedStages
        .filter((stage) => (stage.failureDisposition ?? "terminal_failed") === candidate.disposition)
        .map((stage) => stage.id);
  }
}

function selectedMetadata(
  metadata: RunFailureMetadata,
  failedStageIds: readonly string[],
): SelectedRunFailureMetadata {
  return {
    ...metadata,
    failedStageIds,
  };
}

function selectRunFailureDisposition(input: {
  readonly outerFailure: WorkflowFailure;
  readonly thrownError: unknown;
  readonly stages: readonly StageSnapshot[];
  readonly classifyFailure: (error: unknown) => WorkflowFailure;
}): SelectedRunFailureMetadata {
  const failedStages = input.stages.filter((stage) => stage.status === "failed");
  const failedStageIds = failedStages.map((stage) => stage.id);
  const aggregateFailures = aggregateInnerFailures(input.thrownError, input.classifyFailure);
  const candidates: readonly FailureCandidate[] = [
    ...failedStages.map(stageFailureCandidate),
    ...aggregateFailures.map(aggregateFailureCandidate),
    outerFailureCandidate(input.outerFailure),
  ];
  // Candidate precedence mirrors lifecycle severity: terminal killed is non-resumable
  // and wins first, terminal failed wins over recoverable blocks, and active-blocked
  // is only preserved when every observed failure is recoverable active-blocked.
  const terminalKilledCandidate = candidates.find((candidate) => candidate.disposition === "terminal_killed");
  if (terminalKilledCandidate !== undefined) {
    return selectedMetadata(
      runFailureMetadataFromCandidate(input.outerFailure, terminalKilledCandidate, input.thrownError),
      failedStageIdsForCandidate(terminalKilledCandidate, failedStages),
    );
  }

  const terminalFailedCandidate = candidates.find((candidate) => candidate.disposition === "terminal_failed");
  if (terminalFailedCandidate !== undefined) {
    return selectedMetadata(
      runFailureMetadataFromCandidate(input.outerFailure, terminalFailedCandidate, input.thrownError),
      failedStageIdsForCandidate(terminalFailedCandidate, failedStages),
    );
  }

  const recoverableBlockedCandidate = candidates.find(isRecoverableActiveBlockedCandidate);
  if (
    recoverableBlockedCandidate !== undefined &&
    candidates.every(isRecoverableActiveBlockedCandidate)
  ) {
    return selectedMetadata(
      runFailureMetadataFromCandidate(input.outerFailure, recoverableBlockedCandidate, input.thrownError),
      failedStageIds,
    );
  }

  return selectedMetadata(runFailureMetadata(input.outerFailure, input.stages), failedStageIds);
}

function stageReplayFields(stage: StageSnapshot): Partial<Pick<StageSnapshot, "replayKey" | "replayedFromStageId" | "replayed">> {
  return {
    ...(stage.replayKey !== undefined ? { replayKey: stage.replayKey } : {}),
    ...(stage.replayedFromStageId !== undefined ? { replayedFromStageId: stage.replayedFromStageId } : {}),
    ...(stage.replayed !== undefined ? { replayed: stage.replayed } : {}),
  };
}

type PromptAnswerReplaySafety = "allowed" | "unavailable" | "ambiguous";

function getPromptAnswerState(
  hasReplayAnswer: boolean,
  replaySourceId: string | undefined,
  answerReplay: PromptAnswerReplaySafety,
): StageSnapshot["promptAnswerState"] {
  if (replaySourceId === undefined) return undefined;
  if (hasReplayAnswer) return "available";
  if (answerReplay === "ambiguous") return "ambiguous";
  return "unavailable";
}

type ContinuationReplayDecision =
  | {
      readonly kind: "execute";
      readonly source?: StageSnapshot;
      readonly parentIds: readonly string[];
      readonly answerReplay: PromptAnswerReplaySafety;
    }
  | {
      readonly kind: "replay";
      readonly source: StageSnapshot;
      readonly parentIds: readonly string[];
      readonly answerReplay: PromptAnswerReplaySafety;
    };

interface ContinuationReplayInput {
  readonly displayName: string;
  readonly replayKey: string;
  readonly parentIds: readonly string[];
  readonly stageId: string;
  readonly kind: "stage" | "prompt" | "workflow";
}

interface ContinuationReplayIndex {
  decide(input: ContinuationReplayInput): ContinuationReplayDecision;
  markPromptAnswerReplayed(stageId: string): void;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sortedIdentity(values: readonly string[]): string {
  return [...values].sort().join("\u0000");
}

function createContinuationReplayIndex(continuation: RunContinuationOpts | undefined): ContinuationReplayIndex {
  if (continuation === undefined) {
    return {
      decide: (input) => ({
        kind: "execute",
        parentIds: input.parentIds,
        answerReplay: "unavailable",
      }),
      markPromptAnswerReplayed: () => {},
    };
  }
  const resumeStage = continuation.source.stages.find((stage) => stage.id === continuation.resumeFromStageId);
  if (resumeStage === undefined) {
    throw new Error(`atomic-workflows: insufficient_state: resume stage ${continuation.resumeFromStageId} was not found in source run ${continuation.source.id}`);
  }

  const stagesByReplayIdentity = new Map<string, StageSnapshot[]>();
  const promptDuplicateCounts = new Map<string, number>();
  for (const stage of continuation.source.stages) {
    const identity = stage.replayKey ?? stage.name;
    const stages = stagesByReplayIdentity.get(identity);
    if (stages === undefined) {
      stagesByReplayIdentity.set(identity, [stage]);
    } else {
      stages.push(stage);
    }
    const duplicateKey = `${identity}\u0001${sortedIdentity(stage.parentIds)}`;
    promptDuplicateCounts.set(duplicateKey, (promptDuplicateCounts.get(duplicateKey) ?? 0) + 1);
  }

  const consumedSourceStageIds = new Set<string>();
  const continuationStageIdBySourceStageId = new Map<string, string>();
  const replayablePromptContinuationStageIds = new Set<string>();

  const failTopology = (displayName: string, replayKey: string, reason: "mismatch" | "ambiguous"): never => {
    throw new Error(`atomic-workflows: insufficient_state: replay topology ${reason} for stage "${displayName}" (replayKey "${replayKey}") in source run ${continuation.source.id}`);
  };

  const translateSourceParents = (source: StageSnapshot): string[] | undefined => {
    const parentIds: string[] = [];
    for (const sourceParentId of source.parentIds) {
      const continuationParentId = continuationStageIdBySourceStageId.get(sourceParentId);
      if (continuationParentId === undefined) return undefined;
      parentIds.push(continuationParentId);
    }
    return parentIds;
  };

  const allSameParentSet = (candidates: readonly { readonly parentIds: readonly string[] }[]): boolean => {
    const first = candidates[0]?.parentIds;
    if (first === undefined) return false;
    return candidates.every((candidate) => sameStringSet(candidate.parentIds, first));
  };

  const hasOnlyReplayablePromptParentDrift = (
    sourceParentIds: readonly string[],
    provisionalParentIds: readonly string[],
  ): boolean => {
    const sourceParentSet = new Set(sourceParentIds);
    const provisionalParentSet = new Set(provisionalParentIds);
    const driftParentIds = [
      ...sourceParentIds.filter((parentId) => !provisionalParentSet.has(parentId)),
      ...provisionalParentIds.filter((parentId) => !sourceParentSet.has(parentId)),
    ];
    return driftParentIds.length > 0 && driftParentIds.every((parentId) => replayablePromptContinuationStageIds.has(parentId));
  };

  return {
    markPromptAnswerReplayed(stageId: string): void {
      replayablePromptContinuationStageIds.add(stageId);
    },

    decide(input: ContinuationReplayInput): ContinuationReplayDecision {
      const { displayName, replayKey, parentIds, stageId, kind } = input;
      let identity = replayKey;
      let candidates = stagesByReplayIdentity.get(replayKey)?.filter((stage) => !consumedSourceStageIds.has(stage.id)) ?? [];
      if (candidates.length === 0) {
        // Legacy snapshots created before replayKey existed can only be matched
        // by display name. Current stage and prompt nodes always carry replayKey.
        identity = displayName;
        candidates = stagesByReplayIdentity.get(displayName)?.filter((stage) => !consumedSourceStageIds.has(stage.id) && stage.replayKey === undefined) ?? [];
      }
      if (candidates.length === 0) {
        return { kind: "execute", parentIds, answerReplay: "unavailable" };
      }

      const mappedCandidates = candidates
        .map((source) => ({ source, parentIds: translateSourceParents(source) }))
        .filter((candidate): candidate is { readonly source: StageSnapshot; readonly parentIds: string[] } => candidate.parentIds !== undefined);

      if (mappedCandidates.length === 0) {
        failTopology(displayName, replayKey, "mismatch");
      }

      const provisionalMatches = mappedCandidates.filter((candidate) => sameStringSet(candidate.parentIds, parentIds));
      const hasPromptDriftMatch = kind === "prompt" &&
        allSameParentSet(mappedCandidates) &&
        hasOnlyReplayablePromptParentDrift(mappedCandidates[0]!.parentIds, parentIds);
      let matches: typeof mappedCandidates | undefined;
      if (provisionalMatches.length > 0) {
        matches = provisionalMatches;
      } else if (hasPromptDriftMatch) {
        matches = mappedCandidates;
      }
      if (matches === undefined) {
        return failTopology(displayName, replayKey, "mismatch");
      }
      if (matches.length > 1 && (kind !== "prompt" || !allSameParentSet(matches))) {
        failTopology(displayName, replayKey, "ambiguous");
      }

      const selected = matches[0]!;
      const duplicateKey = `${identity}\u0001${sortedIdentity(selected.source.parentIds)}`;
      const ambiguousPromptAnswer = kind === "prompt" && (promptDuplicateCounts.get(duplicateKey) ?? 0) > 1;
      const answerReplay: PromptAnswerReplaySafety = ambiguousPromptAnswer
        ? "ambiguous"
        : selected.source.status === "completed"
          ? "allowed"
          : "unavailable";
      consumedSourceStageIds.add(selected.source.id);
      continuationStageIdBySourceStageId.set(selected.source.id, stageId);
      if (selected.source.status === "completed" && answerReplay === "allowed") {
        return { kind: "replay", source: selected.source, parentIds: selected.parentIds, answerReplay };
      }
      return { kind: "execute", source: selected.source, parentIds: selected.parentIds, answerReplay };
    },
  };
}

interface ParallelFailFastStage {
  readonly skip: () => void;
}

interface ParallelFailFastScope {
  failed: boolean;
  firstFailure?: unknown;
  readonly activeStages: Map<string, ParallelFailFastStage>;
}

// ---------------------------------------------------------------------------
// Shared killed finalizer — used for catch-abort and post-body abort check
// ---------------------------------------------------------------------------

function finalizeKilled(
  runId: string,
  runSnapshot: RunSnapshot,
  activeStore: Store,
  persistence: WorkflowPersistencePort | undefined,
  onRunEnd: RunOpts["onRunEnd"],
): RunResult {
  const errorMessage = "workflow killed";
  const metadata = {
    failureKind: "cancelled" as const,
    failureCode: "cancelled" as const,
    failureRecoverability: "non_recoverable" as const,
    failureDisposition: "terminal_killed" as const,
    failureMessage: errorMessage,
    resumable: false,
  };
  const recorded = activeStore.recordRunEnd(runId, "killed", undefined, errorMessage, metadata);
  appendRunEndWhenRecorded(persistence, recorded, {
    runId,
    status: "killed",
    error: errorMessage,
    ...metadata,
    ts: Date.now(),
  });
  return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
    status: "killed",
    error: errorMessage,
  }, onRunEnd);
}

function finalizeKilledByFailure(
  runId: string,
  runSnapshot: RunSnapshot,
  activeStore: Store,
  persistence: WorkflowPersistencePort | undefined,
  onRunEnd: RunOpts["onRunEnd"],
  metadata: RunFailureMetadata,
): RunResult {
  const recorded = activeStore.recordRunEnd(runId, "killed", undefined, metadata.errorMessage, metadata);
  appendRunEndWhenRecorded(persistence, recorded, {
    runId,
    status: "killed",
    error: metadata.errorMessage,
    failureKind: metadata.failureKind,
    ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
    ...(metadata.failureRecoverability !== undefined ? { failureRecoverability: metadata.failureRecoverability } : {}),
    ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
    failureMessage: metadata.failureMessage,
    ...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
    resumable: false,
    ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
    ts: Date.now(),
  });
  return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
    status: "killed",
    error: metadata.errorMessage,
  }, onRunEnd);
}

function recordActiveBlockedFailure(
  runId: string,
  runSnapshot: RunSnapshot,
  activeStore: Store,
  persistence: WorkflowPersistencePort | undefined,
  metadata: RunFailureMetadata & { readonly failureRecoverability: "recoverable"; readonly failedStageId: string },
): RunResult {
  const blockedAt = Date.now();
  const recorded = activeStore.recordRunBlocked(runId, metadata.errorMessage, {
    failureKind: metadata.failureKind,
    ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
    failureRecoverability: "recoverable",
    ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
    failureMessage: metadata.failureMessage,
    failedStageId: metadata.failedStageId,
    resumable: true,
    ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
    blockedAt,
  });
  if (recorded && persistence !== undefined) {
    appendRunBlocked(persistence, {
      runId,
      failedStageId: metadata.failedStageId,
      error: metadata.errorMessage,
      failureKind: metadata.failureKind,
      ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
      failureMessage: metadata.failureMessage,
      failureRecoverability: "recoverable",
      ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
      ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
      resumable: true,
      ts: blockedAt,
    });
  }
  return {
    runId,
    status: "running",
    error: metadata.errorMessage,
    stages: [...runSnapshot.stages],
  };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((error) => `  - ${error.key}: ${error.reason}`).join("\n");
}

export function resolveAndValidateInputs(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  provided: Readonly<Record<string, unknown>>,
  scope: string,
): ResolvedInputs {
  const resolved = resolveInputs(schema, provided);
  const errors = validateInputs(schema, resolved);
  if (errors.length > 0) {
    throw new TypeError(
      `atomic-workflows: invalid inputs for ${scope}:\n${formatValidationErrors(errors)}`,
    );
  }
  return resolved;
}

function hasOwnWorkflowOutput(record: WorkflowOutputValues | Readonly<Record<string, WorkflowOutputSchema>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// Workflow outputs are fully explicit: a workflow exposes exactly the outputs it
// declares with `.output(...)`. There is no implicit `result` fallback, and a
// `.run()` return that contains a key the workflow did not declare is an error,
// so authors cannot silently leak undeclared values across a workflow boundary.
function assertWorkflowOutputsExplicit(
  scope: string,
  sourceOutput: WorkflowOutputValues,
  declarations: Readonly<Record<string, WorkflowOutputSchema>>,
  missingOutputSuffix = "",
): void {
  for (const key of Object.keys(sourceOutput)) {
    if (!hasOwnWorkflowOutput(declarations, key)) {
      throw new Error(
        `atomic-workflows: ${scope} returned undeclared output "${key}"; declare it with .output("${key}", Type....) or remove it from the .run() return`,
      );
    }
  }
  for (const [key, schema] of Object.entries(declarations)) {
    if (!(key in sourceOutput)) {
      if (schemaIsRequired(schema)) {
        throw new Error(
          `atomic-workflows: ${scope} missing output "${key}"${missingOutputSuffix}`,
        );
      }
      continue;
    }
    const value = sourceOutput[key];
    const kind = schemaFieldKind(schema);
    if (!Value.Check(schema, value)) {
      const choices = schemaChoices(schema);
      if (kind === "select" && choices !== undefined && typeof value === "string") {
        throw new Error(
          `atomic-workflows: ${scope} output "${key}" must be one of [${choices.join(", ")}], got ${JSON.stringify(value)}`,
        );
      }
      throw new Error(
        `atomic-workflows: ${scope} output "${key}" expected ${kind}, got ${workflowSerializableTypeName(value)}`,
      );
    }
    const serializableError = workflowSerializableValidationError(
      value,
      `${scope} output "${key}"`,
    );
    if (serializableError !== undefined) {
      throw new Error(`atomic-workflows: ${serializableError}`);
    }
  }
}

function normalizeWorkflowOutputObject(
  workflowName: string,
  rawOutput: unknown,
  label: string,
): WorkflowOutputValues | undefined {
  if (rawOutput === undefined) return undefined;
  // Drop top-level keys explicitly set to `undefined` so conditional outputs
  // (e.g. `{ note: cond ? value : undefined }`) satisfy the JSON-serializable
  // contract instead of failing validation; selectWorkflowOutputs strips the
  // same way at the child boundary, keeping both paths consistent.
  const normalized =
    rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput)
      ? Object.fromEntries(
          Object.entries(rawOutput as Record<string, unknown>).filter(([, v]) => v !== undefined),
        )
      : rawOutput;
  assertWorkflowSerializableObject(normalized, `workflow "${workflowName}" ${label}`);
  return normalized;
}

function normalizeWorkflowRunOutput(
  workflowName: string,
  rawOutput: unknown,
): WorkflowOutputValues | undefined {
  return normalizeWorkflowOutputObject(workflowName, rawOutput, ".run() return");
}

function normalizeWorkflowExitOutput(
  workflowName: string,
  snapshot: WorkflowExitOutputSnapshot | undefined,
): WorkflowOutputValues | undefined {
  if (snapshot === undefined) return undefined;
  if (!snapshot.ok) throw snapshot.error;
  if (isWorkflowExitSnapshotInvalidValue(snapshot.value)) {
    const invalidMessage = workflowExitSnapshotInvalidValueMessage(
      `workflow "${workflowName}" ctx.exit() outputs`,
      snapshot.value,
    );
    throw new Error(`atomic-workflows: ${invalidMessage ?? `workflow "${workflowName}" ctx.exit() outputs must be ${WORKFLOW_SERIALIZABLE_DESCRIPTION}, got object`}`);
  }
  return normalizeWorkflowOutputObject(workflowName, snapshot.value, "ctx.exit() outputs");
}

function assertWorkflowRunOutputs(
  workflowName: string,
  result: WorkflowOutputValues | undefined,
  declaredOutputs: Readonly<Record<string, WorkflowOutputSchema>> | undefined,
): void {
  assertWorkflowOutputsExplicit(
    `workflow "${workflowName}"`,
    result ?? {},
    declaredOutputs ?? {},
  );
}

function assertWorkflowExitOutputs(
  workflowName: string,
  result: WorkflowOutputValues | undefined,
  declaredOutputs: Readonly<Record<string, WorkflowOutputSchema>> | undefined,
): void {
  const declarations = declaredOutputs ?? {};
  const sourceOutput = result ?? {};
  const scope = `workflow "${workflowName}" ctx.exit()`;
  for (const key of Object.keys(sourceOutput)) {
    if (!hasOwnWorkflowOutput(declarations, key)) {
      throw new Error(
        `atomic-workflows: ${scope} provided undeclared output "${key}"; declare it with .output("${key}", Type....) or remove it from ctx.exit({ outputs })`,
      );
    }
  }
  for (const [key, schema] of Object.entries(declarations)) {
    if (!(key in sourceOutput)) continue;
    const value = sourceOutput[key];
    const invalidSnapshotValue = workflowExitSnapshotInvalidValueMessage(`${scope} output "${key}"`, value);
    if (invalidSnapshotValue !== undefined) {
      throw new Error(`atomic-workflows: ${invalidSnapshotValue}`);
    }
    const kind = schemaFieldKind(schema);
    if (!Value.Check(schema, value)) {
      const choices = schemaChoices(schema);
      if (kind === "select" && choices !== undefined && typeof value === "string") {
        throw new Error(
          `atomic-workflows: ${scope} output "${key}" must be one of [${choices.join(", ")}], got ${JSON.stringify(value)}`,
        );
      }
      throw new Error(
        `atomic-workflows: ${scope} output "${key}" expected ${kind}, got ${workflowSerializableTypeName(value)}`,
      );
    }
    const serializableError = workflowSerializableValidationError(
      value,
      `${scope} output "${key}"`,
    );
    if (serializableError !== undefined) {
      throw new Error(`atomic-workflows: ${serializableError}`);
    }
  }
}

function selectWorkflowOutputs(
  child: WorkflowDefinition,
  rawOutput: WorkflowOutputValues | undefined,
): WorkflowOutputValues {
  const declarations = child.outputs ?? {};
  const sourceOutput = rawOutput ?? {};
  // The child run already validated its return against these declared outputs
  // (assertWorkflowRunOutputs) before it could complete, so undeclared keys are
  // impossible here and a second assertWorkflowOutputsExplicit pass could never
  // fire. Just project the declared outputs the child returned. (An undeclared
  // key fails the child run itself; the parent surfaces that as a wrapped
  // "child workflow ... failed" error.)
  const selected: Record<string, WorkflowSerializableValue> = {};
  for (const key of Object.keys(declarations)) {
    const value = sourceOutput[key];
    if (value !== undefined) selected[key] = value;
  }

  return selected;
}

function cloneWorkflowChildValue<T>(value: T): T {
  return structuredClone(value);
}

function workflowChildSerializationMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!isBrandedWorkflowDefinition(value)) return false;
  const record = value as Partial<WorkflowDefinition>;
  return record.__piWorkflow === true &&
    typeof record.name === "string" && record.name.trim().length > 0 &&
    typeof record.normalizedName === "string" && record.normalizedName.trim().length > 0 &&
    typeof record.run === "function" &&
    typeof record.inputs === "object" && record.inputs !== null;
}

function workflowDefinitionRequirementMessage(callSite: string, value: unknown): string {
  // isWorkflowDefinition already failed; this extra sentinel check narrows the
  // diagnostic for forged legacy literals versus unrelated values.
  if (value !== null && typeof value === "object" && (value as { __piWorkflow?: unknown }).__piWorkflow === true) {
    return `atomic-workflows: ${callSite} requires a compiled workflow definition produced by defineWorkflow(...).compile(); hand-rolled __piWorkflow objects are not supported`;
  }
  return `atomic-workflows: ${callSite} requires a compiled workflow definition`;
}

function cloneWorkflowChildReplaySnapshot(snapshot: WorkflowChildReplaySnapshot): WorkflowChildReplaySnapshot {
  return {
    alias: snapshot.alias,
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    status: snapshot.status,
    ...(snapshot.exited !== undefined ? { exited: snapshot.exited } : {}),
    outputs: cloneWorkflowChildValue(snapshot.outputs),
    ...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
  };
}

function workflowChildReplaySnapshot(
  alias: string,
  childResult: WorkflowChildResult,
): WorkflowChildReplaySnapshot {
  const outputs: Record<string, WorkflowSerializableValue> = {};
  for (const [key, value] of Object.entries(childResult.outputs)) {
    if (value === undefined) continue;
    try {
      outputs[key] = cloneWorkflowChildValue(value);
    } catch (err) {
      throw new Error(
        `atomic-workflows: child workflow "${alias}" (${childResult.workflow}) exposed output "${key}" is not serializable for continuation replay: ${workflowChildSerializationMessage(err)}`,
        { cause: err },
      );
    }
  }

  const exitReason = childResult.exited === true ? childResult.exitReason : undefined;
  return {
    alias,
    workflow: childResult.workflow,
    runId: childResult.runId,
    status: childResult.status,
    exited: childResult.exited,
    outputs,
    ...(exitReason !== undefined ? { exitReason } : {}),
  };
}

export async function run<TInputs extends WorkflowInputValues>(
  def: WorkflowDefinition<TInputs>,
  inputs: Readonly<Record<string, unknown>>,
  opts: RunOpts = {},
): Promise<RunResult> {
  if (!isWorkflowDefinition(def)) {
    throw new Error(workflowDefinitionRequirementMessage("run(definition, inputs)", def));
  }

  const activeStore = opts.store ?? defaultStore;
  const adapters = opts.adapters ?? {};
  if (opts.usePromptNodesForUi === true && opts.ui !== undefined) {
    console.warn("atomic-workflows: usePromptNodesForUi ignores the provided RunOpts.ui adapter");
  }

  // 0. maxDepth guard — reject before any store/persistence side effects.
  const depth = opts.depth ?? 0;
  const maxDepth = opts.config?.maxDepth ?? 4;
  if (depth >= maxDepth) {
    const max = maxDepth;
    return {
      runId: opts.runId ?? crypto.randomUUID(),
      status: "failed",
      error: `atomic-workflows: maxDepth exceeded (max ${max})`,
      stages: [],
    };
  }

  // 1. Resolve + validate inputs
  const resolvedInputs = resolveAndValidateInputs(
    def.inputs,
    inputs,
    `workflow "${def.name}"`,
  );

  // 2. Generate runId (or use pre-allocated seam from caller)
  const runId = opts.runId ?? crypto.randomUUID();
  const exitScope = Symbol(`workflow-exit:${runId}`);
  let selectedExit: WorkflowExitSignal | undefined;
  const replayIndex = createContinuationReplayIndex(opts.continuation);

  // 2a. Create own AbortController; forward caller signal if provided
  const ownController = new AbortController();
  const callerSignal = opts.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      ownController.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => { ownController.abort(callerSignal.reason); }, { once: true });
    }
  }

  // 3. Create RunSnapshot + register
  const runSnapshot: RunSnapshot = {
    id: runId,
    name: def.name,
    inputs: Object.freeze(resolvedInputs),
    status: "running",
    stages: [],
    startedAt: Date.now(),
    ...(opts.parentRun !== undefined ? {
      parentRunId: opts.parentRun.runId,
      parentStageId: opts.parentRun.stageId,
      rootRunId: opts.parentRun.rootRunId,
    } : {}),
    ...(opts.continuation !== undefined ? {
      resumedFromRunId: opts.continuation.source.id,
      resumeFromStageId: opts.continuation.resumeFromStageId,
    } : {}),
  };

  const classifiedFailures = new Map<unknown, WorkflowFailure>();
  const classifyExecutorFailure = (error: unknown): WorkflowFailure => {
    const cached = classifiedFailures.get(error);
    if (cached !== undefined) return cached;
    let classified: WorkflowFailure;
    try {
      classified = classifyWorkflowFailure(error);
    } catch {
      // Failure classification can inspect provider-shaped metadata such as
      // `cause`/`errors`. If an arbitrary workflow-thrown object uses throwing
      // accessors for those names, keep the executor catch path on the ordinary
      // failed-run rail instead of letting the accessor escape and strand the run.
      classified = classifyWorkflowFailure(new Error(unknownErrorMessage(error)));
    }
    classifiedFailures.set(error, classified);
    return classified;
  };

  activeStore.recordRunStart(runSnapshot);
  // When the caller already has a controller registered (the detached runner
  // pre-registers before calling run() so abort() can hit the run during
  // executor setup), avoid overwriting it. Two registrations for the same
  // runId means `cancellation.abort(runId)` only hits one controller, and
  // listeners on the other never fire — which is exactly the leak that
  // wedges HIL waiters in background runs.
  if (!opts.signal) {
    opts.cancellation?.register(runId, ownController);
  }
  opts.onRunStart?.(runSnapshot);

  // Persistence: append run.start entry
  if (opts.persistence) {
    appendRunStart(opts.persistence, {
      runId,
      name: def.name,
      inputs: resolvedInputs,
      ...(runSnapshot.parentRunId !== undefined ? { parentRunId: runSnapshot.parentRunId } : {}),
      ...(runSnapshot.parentStageId !== undefined ? { parentStageId: runSnapshot.parentStageId } : {}),
      ...(runSnapshot.rootRunId !== undefined ? { rootRunId: runSnapshot.rootRunId } : {}),
      ...(runSnapshot.resumedFromRunId !== undefined ? { resumedFromRunId: runSnapshot.resumedFromRunId } : {}),
      ...(runSnapshot.resumeFromStageId !== undefined ? { resumeFromStageId: runSnapshot.resumeFromStageId } : {}),
      ts: runSnapshot.startedAt,
    });
  }

  // 4. Create GraphFrontierTracker and per-run ConcurrencyLimiter
  const tracker = new GraphFrontierTracker();
  const inputConcurrency = resolveInputConcurrency(def.inputs, resolvedInputs);
  const inputRuntimeDefaults = resolveInputRuntimeDefaults(def, resolvedInputs);
  const workflowInvocationCwd = opts.cwd ?? process.cwd();
  let workflowCwd: string | undefined;
  const resolveWorkflowCwd = (): string => {
    workflowCwd ??= workflowCwdWithInputWorktree(inputRuntimeDefaults, workflowInvocationCwd);
    return workflowCwd;
  };
  const limiter = createRunLimiter(inputConcurrency ?? opts.config?.defaultConcurrency);
  interface ReleaseBarrier {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason?: unknown) => void;
  }
  const releaseBarriers = new Map<string, ReleaseBarrier>();
  const cascadePauseOwners = new Map<string, Set<string>>();

  const makeReleaseBarrier = (): ReleaseBarrier => {
    const resolver = Promise.withResolvers<void>();
    // Abort rejects release barriers during kill/shutdown. Some barriers are
    // only state markers for a paused root/current stage and have no active
    // waiter, so mark expected cancellation as observed while preserving the
    // same promise for callers that do await it.
    void resolver.promise.catch(() => {});
    return { promise: resolver.promise, resolve: resolver.resolve, reject: resolver.reject };
  };

  const isTerminalStage = (stage: StageSnapshot): boolean =>
    stage.status === "completed" || stage.status === "failed" || stage.status === "skipped";

  interface WorkflowExitCleanup {
    skipForWorkflowExit(reason?: string): void | Promise<void>;
  }

  const exitCleanups = new Map<string, WorkflowExitCleanup>();
  const workflowExitCleanupPromises = new Set<Promise<void>>();
  const workflowExitSkippedReason = (reason?: string): string =>
    reason === undefined || reason.length === 0 ? "workflow-exit" : `workflow-exit: ${reason}`;
  const isWorkflowExitSkippedReason = (reason: string | undefined): boolean =>
    reason === "workflow-exit" || reason?.startsWith("workflow-exit: ") === true;
  const currentWorkflowExitAbortReason = (): { readonly reason?: string } | undefined => {
    const scopedExit = selectedExit ?? findWorkflowExitSignal(ownController.signal.reason, exitScope);
    if (scopedExit !== undefined) {
      return scopedExit.reason === undefined ? {} : { reason: scopedExit.reason };
    }
    const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
    if (parentExit !== undefined) {
      return parentExit.workflowExitReason === undefined ? {} : { reason: parentExit.workflowExitReason };
    }
    return undefined;
  };
  const preserveWorkflowExitSkippedReason = (stage: StageSnapshot, fallback: string): void => {
    if (isWorkflowExitSkippedReason(stage.skippedReason)) return;
    const workflowExitAbort = currentWorkflowExitAbortReason();
    if (workflowExitAbort !== undefined) {
      stage.skippedReason = workflowExitSkippedReason(workflowExitAbort.reason);
      return;
    }
    stage.skippedReason = fallback;
  };
  const trackWorkflowExitCleanup = (operation: void | Promise<void>): void => {
    if (operation === undefined) return;
    let tracked: Promise<void>;
    tracked = Promise.resolve(operation)
      .catch(() => {
        // Cleanup is best-effort and must never surface as an unhandled rejection
        // or convert an intentional workflow exit into a failed run.
      })
      .finally(() => {
        workflowExitCleanupPromises.delete(tracked);
      });
    workflowExitCleanupPromises.add(tracked);
  };
  const invokeWorkflowExitCleanup = (cleanup: WorkflowExitCleanup, reason?: string): void => {
    try {
      trackWorkflowExitCleanup(cleanup.skipForWorkflowExit(reason));
    } catch (err) {
      trackWorkflowExitCleanup(Promise.reject(err));
    }
  };
  const registerWorkflowExitCleanup = (stageId: string, cleanup: WorkflowExitCleanup): (() => void) => {
    if (selectedExit !== undefined) {
      invokeWorkflowExitCleanup(cleanup, selectedExit.reason);
      return () => undefined;
    }
    exitCleanups.set(stageId, cleanup);
    return () => {
      if (exitCleanups.get(stageId) === cleanup) exitCleanups.delete(stageId);
    };
  };
  const runWorkflowExitCleanups = (reason?: string): void => {
    for (const cleanup of [...exitCleanups.values()]) {
      invokeWorkflowExitCleanup(cleanup, reason);
    }
  };
  const drainWorkflowExitCleanups = async (reason?: string): Promise<void> => {
    runWorkflowExitCleanups(reason);
    while (workflowExitCleanupPromises.size > 0) {
      await Promise.all([...workflowExitCleanupPromises]);
    }
  };
  const throwIfWorkflowExitSelected = (): void => {
    if (selectedExit !== undefined) {
      if (!ownController.signal.aborted) ownController.abort(selectedExit);
      runWorkflowExitCleanups(selectedExit.reason);
      throw selectedExit;
    }
    if (ownController.signal.aborted) {
      throw ownController.signal.reason ?? new DOMException("workflow killed", "AbortError");
    }
  };

  const stageById = (stageId: string): StageSnapshot | undefined =>
    runSnapshot.stages.find((stage) => stage.id === stageId);

  const setStageParentIds = (stage: StageSnapshot, parentIds: readonly string[]): void => {
    // Keep tracker and snapshot parent arrays in sync when topology is refreshed;
    // consumers should not cache the old parentIds reference across updates.
    stage.parentIds = Object.freeze([...parentIds]);
  };

  const hasAncestor = (stage: StageSnapshot, ancestorId: string): boolean => {
    const queue = [...stage.parentIds];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      if (next === ancestorId) return true;
      seen.add(next);
      queue.push(...tracker.getParents(next));
    }
    return false;
  };

  const descendantsOf = (stageId: string): StageSnapshot[] =>
    runSnapshot.stages.filter((stage) => stage.id !== stageId && hasAncestor(stage, stageId));

  const blockingAncestorFor = (stage: StageSnapshot): string | undefined => {
    const queue = [...stage.parentIds];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const ancestor = stageById(next);
      if (ancestor?.status === "paused" || ancestor?.status === "blocked") return next;
      queue.push(...tracker.getParents(next));
    }
    return undefined;
  };

  const ensureReleaseBarrier = (stageId: string): ReleaseBarrier => {
    let barrier = releaseBarriers.get(stageId);
    if (!barrier) {
      barrier = makeReleaseBarrier();
      releaseBarriers.set(stageId, barrier);
    }
    return barrier;
  };

  const blockStageUntilCascadeRelease = (stage: StageSnapshot, blockedBy: string): void => {
    ensureReleaseBarrier(stage.id);
    activeStore.recordStageBlocked(runId, stage.id, blockedBy);
  };

  const blockKnownNonTerminalDescendants = (failedStageId: string): void => {
    for (const descendant of descendantsOf(failedStageId)) {
      if (isTerminalStage(descendant) || descendant.status === "paused" || descendant.status === "blocked") continue;
      blockStageUntilCascadeRelease(descendant, failedStageId);
    }
  };

  const markCascadePaused = (stageId: string, ownerStageId: string): void => {
    let owners = cascadePauseOwners.get(stageId);
    if (!owners) {
      owners = new Set<string>();
      cascadePauseOwners.set(stageId, owners);
    }
    owners.add(ownerStageId);
  };

  const releaseCascadePauseOwner = (stageId: string, ownerStageId: string): boolean => {
    const owners = cascadePauseOwners.get(stageId);
    if (!owners) return false;
    const changed = owners.delete(ownerStageId);
    if (owners.size === 0) cascadePauseOwners.delete(stageId);
    return changed;
  };

  const releaseStageBarrier = (stageId: string): void => {
    const barrier = releaseBarriers.get(stageId);
    if (!barrier) return;
    releaseBarriers.delete(stageId);
    barrier.resolve();
  };

  const cascadePauseFrom = async (pausedStageId: string): Promise<void> => {
    const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
    for (const descendant of descendantsOf(pausedStageId)) {
      if (isTerminalStage(descendant) || descendant.status === "paused" || descendant.status === "blocked") continue;
      const descendantHandle = stageRegistry.get(runId, descendant.id);
      if (descendantHandle?.isStreaming || descendant.status === "running") {
        if (descendantHandle && (descendantHandle.status === "running" || descendantHandle.status === "pending")) {
          await descendantHandle.pause();
          markCascadePaused(descendant.id, pausedStageId);
        }
        continue;
      }
      blockStageUntilCascadeRelease(descendant, pausedStageId);
    }
  };

  const cascadeResumeFrom = async (resumedStageId: string): Promise<void> => {
    const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
    for (const descendant of descendantsOf(resumedStageId)) {
      if (isTerminalStage(descendant)) continue;
      if (descendant.status === "blocked") {
        if (blockingAncestorFor(descendant) !== undefined) continue;
        if (activeStore.recordStageUnblocked(runId, descendant.id)) {
          releaseStageBarrier(descendant.id);
        }
        continue;
      }
      if (descendant.status === "paused") {
        const ownedByResumedStage = releaseCascadePauseOwner(descendant.id, resumedStageId);
        if (!ownedByResumedStage) continue;
        if (cascadePauseOwners.has(descendant.id)) continue;
        if (blockingAncestorFor(descendant) !== undefined) continue;
        const descendantHandle = stageRegistry.get(runId, descendant.id);
        if (descendantHandle?.status === "paused") {
          await descendantHandle.resume();
        }
      }
    }
  };

  const rejectReleaseBarriers = (reason: unknown): void => {
    cascadePauseOwners.clear();
    for (const [stageId, barrier] of releaseBarriers) {
      releaseBarriers.delete(stageId);
      activeStore.recordStageUnblocked(runId, stageId);
      barrier.reject(reason);
    }
  };

  ownController.signal.addEventListener(
    "abort",
    () => rejectReleaseBarriers(ownController.signal.reason ?? new Error("atomic-workflows: run aborted")),
    { once: true },
  );

  const finalizeWorkflowExitValidationFailure = (err: unknown, exitReason?: string): RunResult => {
    const failure = classifyExecutorFailure(err);
    const classifiedMetadata = runFailureMetadata(failure, runSnapshot.stages);
    const metadata = {
      ...classifiedMetadata,
      // A selected ctx.exit has already unwound the workflow and run exit cleanup;
      // invalid exit options/outputs must never be offered as resumable snapshots.
      resumable: false,
      ...(exitReason !== undefined ? { exitReason } : {}),
    } as const;
    const recorded = activeStore.recordRunEnd(runId, "failed", undefined, metadata.errorMessage, metadata);
    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "failed",
      error: metadata.errorMessage,
      failureKind: metadata.failureKind,
      ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
      ...(metadata.failureRecoverability !== undefined ? { failureRecoverability: metadata.failureRecoverability } : {}),
      ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
      failureMessage: metadata.failureMessage,
      ...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
      resumable: false,
      ...(metadata.exitReason !== undefined ? { exitReason: metadata.exitReason } : {}),
      ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
      status: "failed",
      error: metadata.errorMessage,
      ...(metadata.exitReason !== undefined ? { exitReason: metadata.exitReason } : {}),
    }, opts.onRunEnd);
  };

  const finalizeWorkflowExit = async (signal: WorkflowExitSignal): Promise<RunResult> => {
    await drainWorkflowExitCleanups(signal.reason);
    if (signal.validationError !== undefined) {
      return finalizeWorkflowExitValidationFailure(signal.validationError, signal.reason);
    }

    let outputs: WorkflowOutputValues | undefined;
    try {
      outputs = normalizeWorkflowExitOutput(def.name, signal.outputSnapshot);
      assertWorkflowExitOutputs(def.name, outputs, def.outputs);
    } catch (err) {
      return finalizeWorkflowExitValidationFailure(err, signal.reason);
    }

    const metadata = {
      resumable: false,
      exited: true,
      ...(signal.reason !== undefined ? { exitReason: signal.reason } : {}),
    } as const;
    const recorded = activeStore.recordRunEnd(runId, signal.status, outputs, undefined, metadata);
    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: signal.status,
      result: outputs,
      exited: true,
      ...(signal.reason !== undefined ? { exitReason: signal.reason } : {}),
      resumable: false,
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
      status: signal.status,
      result: outputs,
      exited: true,
      ...(signal.reason !== undefined ? { exitReason: signal.reason } : {}),
    }, opts.onRunEnd);
  };

  const finalizeParentWorkflowExitCancellation = async (abortReason: ParentWorkflowExitAbortProbe): Promise<RunResult> => {
    const parentReason = abortReason.workflowExitReason;
    await drainWorkflowExitCleanups(parentReason);
    const exitReason = parentWorkflowExitRunReason(parentReason);
    const metadata = {
      resumable: false,
      exited: true,
      exitReason,
    } as const;
    const recorded = activeStore.recordRunEnd(runId, "cancelled", undefined, undefined, metadata);
    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "cancelled",
      exited: true,
      exitReason,
      resumable: false,
      ts: Date.now(),
    });
    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
      status: "cancelled",
      exited: true,
      exitReason,
    }, opts.onRunEnd);
  };

  interface LinkedChildWorkflowExitState {
    readonly ref: WorkflowChildRunRef;
    readonly controller: AbortController;
    runPromise?: Promise<RunResult>;
  }

  const requestLinkedChildWorkflowExit = (
    linkedChild: LinkedChildWorkflowExitState,
    reason?: string,
  ): void => {
    if (!linkedChild.controller.signal.aborted) {
      linkedChild.controller.abort(makeParentWorkflowExitAbortReason(reason));
    }
  };

  const waitForLinkedChildWorkflowExit = async (
    linkedChild: LinkedChildWorkflowExitState,
  ): Promise<void> => {
    const childRun = linkedChild.runPromise;
    if (childRun === undefined) return;
    try {
      await childRun;
    } catch {
      // The child workflow call itself observes and reports failures. Parent
      // exit cleanup only needs to await child-owned teardown and must not leak
      // an unhandled rejection while the parent is already intentionally exiting.
    }
  };

  interface WorkflowBoundaryStage {
    readonly id: string;
    readonly replayedChild?: WorkflowChildResult;
    finalizeReplay(): void;
    linkChildRun(ref: WorkflowChildRunRef, childController: AbortController): void;
    observeChildRun(promise: Promise<RunResult>): void;
    complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): void;
    skipForWorkflowExit(reason?: string): Promise<void>;
    fail(error: unknown): void;
  }

  const workflowChildResultFromReplay = (snapshot: WorkflowChildReplaySnapshot): WorkflowChildResult => {
    const outputs = cloneWorkflowChildValue(snapshot.outputs);
    if (snapshot.exited === true || snapshot.status !== "completed") {
      return {
        workflow: snapshot.workflow,
        runId: snapshot.runId,
        status: snapshot.status,
        exited: true,
        outputs,
        ...(snapshot.exitReason !== undefined ? { exitReason: snapshot.exitReason } : {}),
      };
    }
    return {
      workflow: snapshot.workflow,
      runId: snapshot.runId,
      status: "completed",
      exited: false,
      outputs,
    };
  };

  const workflowBoundaryReplayCounts = new Map<string, number>();
  const nextWorkflowBoundaryReplayKey = (name: string): string => {
    const next = (workflowBoundaryReplayCounts.get(name) ?? 0) + 1;
    workflowBoundaryReplayCounts.set(name, next);
    return `workflow:${name}:${next}`;
  };

  const startWorkflowBoundaryStage = (name: string, replayKey: string): WorkflowBoundaryStage => {
    const stageId = crypto.randomUUID();
    const provisionalParentIds = tracker.onSpawn(stageId, name);
    const replayDecision = replayIndex.decide({
      displayName: name,
      replayKey,
      parentIds: provisionalParentIds,
      stageId,
      kind: "workflow",
    });
    const parentIds = replayDecision.parentIds;
    if (!sameStringSet(parentIds, provisionalParentIds)) {
      tracker.replaceParents(stageId, parentIds);
    }
    const replaySource = replayDecision.source;
    const replayChildSnapshot = replayDecision.kind === "replay" ? replayDecision.source.workflowChild : undefined;
    const replayedChild = replayChildSnapshot !== undefined
      ? workflowChildResultFromReplay(replayChildSnapshot)
      : undefined;
    const startedAt = Date.now();
    const stageSnapshot: StageSnapshot = {
      id: stageId,
      name,
      replayKey,
      status: replayedChild !== undefined ? "completed" : "running",
      parentIds: Object.freeze([...parentIds]),
      startedAt,
      toolEvents: [],
      attachable: false,
      ...(replaySource !== undefined ? {
        replayedFromStageId: replaySource.id,
        replayed: replayedChild !== undefined,
      } : {}),
      ...(replayedChild !== undefined && replayChildSnapshot !== undefined ? {
        endedAt: startedAt,
        durationMs: 0,
        ...(replayDecision.kind === "replay" && replayDecision.source.result !== undefined ? { result: replayDecision.source.result } : {}),
        workflowChild: cloneWorkflowChildReplaySnapshot(replayChildSnapshot),
      } : {}),
    };
    let finalized = false;
    let unregisterWorkflowExitCleanup = (): void => {};
    let linkedChild: LinkedChildWorkflowExitState | undefined;

    const appendStageStartOnce = (): void => {
      if (!opts.persistence) return;
      appendStageStart(opts.persistence, {
        runId,
        stageId,
        name,
        parentIds: stageSnapshot.parentIds,
        ...stageReplayFields(stageSnapshot),
        ts: startedAt,
      });
    };

    const appendStageEndForSnapshot = (): void => {
      if (!opts.persistence) return;
      appendStageEnd(opts.persistence, {
        runId,
        stageId,
        status: stageSnapshot.status,
        durationMs: stageSnapshot.durationMs,
        ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
        ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
        ...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
        ...(stageSnapshot.failureRecoverability !== undefined ? { failureRecoverability: stageSnapshot.failureRecoverability } : {}),
        ...(stageSnapshot.failureDisposition !== undefined ? { failureDisposition: stageSnapshot.failureDisposition } : {}),
        ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
        ...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
        ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
        ...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed" ? { summary: stageSnapshot.result } : {}),
        ...stageReplayFields(stageSnapshot),
        ...(stageSnapshot.status === "completed" && stageSnapshot.workflowChild !== undefined
          ? { workflowChild: stageSnapshot.workflowChild }
          : {}),
      });
    };

    const clearBoundaryChildMetadata = (): void => {
      delete stageSnapshot.workflowChildRun;
      delete stageSnapshot.workflowChild;
    };

    const finalize = (
      status: "completed" | "failed" | "skipped",
      summaryOrError: string,
      workflowChild?: WorkflowChildReplaySnapshot,
      failureError?: unknown,
    ): void => {
      if (finalized) return;
      finalized = true;
      unregisterWorkflowExitCleanup();
      stageSnapshot.status = status;
      if (status === "completed") {
        stageSnapshot.result = summaryOrError;
        if (workflowChild !== undefined) stageSnapshot.workflowChild = workflowChild;
      } else if (status === "skipped") {
        clearBoundaryChildMetadata();
        stageSnapshot.skippedReason = summaryOrError;
      } else {
        clearBoundaryChildMetadata();
        applyFailureToStage(stageSnapshot, classifyExecutorFailure(failureError));
      }
      stageSnapshot.endedAt = Date.now();
      stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
      activeStore.recordStageEnd(runId, stageSnapshot);
      opts.onStageEnd?.(runId, stageSnapshot);
      appendStageEndForSnapshot();
      tracker.onSettle(stageId);
    };

    activeStore.recordStageStart(runId, stageSnapshot);
    opts.onStageStart?.(runId, stageSnapshot);
    appendStageStartOnce();

    unregisterWorkflowExitCleanup = registerWorkflowExitCleanup(stageId, {
      async skipForWorkflowExit(reason?: string): Promise<void> {
        const child = linkedChild;
        if (child !== undefined) {
          requestLinkedChildWorkflowExit(child, reason);
        }
        finalize("skipped", workflowExitSkippedReason(reason));
        if (child !== undefined) {
          await waitForLinkedChildWorkflowExit(child);
        }
      },
    });

    const finalizeReplay = (): void => {
      if (replayedChild === undefined || finalized) return;
      finalized = true;
      unregisterWorkflowExitCleanup();
      activeStore.recordStageEnd(runId, stageSnapshot);
      opts.onStageEnd?.(runId, stageSnapshot);
      appendStageEndForSnapshot();
      tracker.onSettle(stageId);
    };

    const linkChildRun = (ref: WorkflowChildRunRef, childController: AbortController): void => {
      if (finalized) return;
      linkedChild = { ref: { ...ref }, controller: childController };
      stageSnapshot.workflowChildRun = { ...ref };
      activeStore.recordStageWorkflowChildRun(runId, stageId, ref);
    };

    const observeChildRun = (promise: Promise<RunResult>): void => {
      if (linkedChild === undefined || finalized) return;
      linkedChild.runPromise = promise;
    };

    return {
      id: stageId,
      ...(replayedChild !== undefined ? { replayedChild } : {}),
      finalizeReplay,
      linkChildRun,
      observeChildRun,
      complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): void {
        finalize("completed", summary, workflowChild);
      },
      async skipForWorkflowExit(reason?: string): Promise<void> {
        const child = linkedChild;
        if (child !== undefined) {
          requestLinkedChildWorkflowExit(child, reason);
        }
        finalize("skipped", workflowExitSkippedReason(reason));
        if (child !== undefined) {
          await waitForLinkedChildWorkflowExit(child);
        }
      },
      fail(error: unknown): void {
        finalize("failed", error instanceof Error ? error.message : String(error), undefined, error);
      },
    };
  };

  const buildPromptNodeUiAdapter = (): WorkflowUIContext => {
    const ask = async <T>(descriptor: PromptDescriptor<T>): Promise<unknown> => {
      throwIfWorkflowExitSelected();
      const isCustom = isCustomPromptDescriptor(descriptor);
      if (ownController.signal.aborted) {
        if (isCustom) throw hilAbortError(ownController.signal);
        return fallbackForPromptDescriptor(descriptor);
      }
      if (isCustom && descriptor.options?.signal?.aborted) {
        throw hilAbortError(descriptor.options.signal);
      }

      const prompt = makePrompt(descriptor);
      const stageId = crypto.randomUUID();
      const provisionalParentIds = tracker.onSpawn(stageId, descriptor.kind);
      const replayKey = promptReplayKey(descriptor);
      const replayDecision = replayIndex.decide({
        displayName: descriptor.kind,
        replayKey,
        parentIds: provisionalParentIds,
        stageId,
        kind: "prompt",
      });
      const parentIds = replayDecision.parentIds;
      if (!sameStringSet(parentIds, provisionalParentIds)) {
        tracker.replaceParents(stageId, parentIds);
      }
      const replaySource = replayDecision.source;
      const replayAnswer = replayDecision.kind === "replay"
        // Replay decisions are only produced when continuation is present.
        ? activeStore.getStagePromptAnswer(opts.continuation!.source.id, replayDecision.source.id)
        : undefined;
      const shouldReplay = replayAnswer !== undefined;
      if (shouldReplay) {
        replayIndex.markPromptAnswerReplayed(stageId);
      }
      const replaySourceId = replaySource?.id;
      const promptAnswerStatus = getPromptAnswerState(shouldReplay, replaySourceId, replayDecision.answerReplay);
      const stageSnapshot: StageSnapshot = {
        id: stageId,
        name: descriptor.kind,
        replayKey,
        status: shouldReplay ? "completed" : "running",
        parentIds: Object.freeze(parentIds),
        startedAt: prompt.createdAt,
        promptFootprint: { ...prompt },
        toolEvents: [],
        attachable: !shouldReplay,
        ...(shouldReplay ? {
          endedAt: prompt.createdAt,
          durationMs: 0,
          promptAnswerState: promptAnswerStatus,
          replayedFromStageId: replaySourceId,
          replayed: true,
        } : replaySourceId !== undefined ? {
          promptAnswerState: promptAnswerStatus,
          replayedFromStageId: replaySourceId,
          replayed: false,
        } : {}),
      };
      let finalized = false;
      let unregisterWorkflowExitCleanup = (): void => {};
      const finalizePromptStage = (status: "completed" | "failed" | "skipped"): void => {
        if (finalized) return;
        finalized = true;
        unregisterWorkflowExitCleanup();
        stageSnapshot.status = status;
        stageSnapshot.endedAt = Date.now();
        stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
        activeStore.recordStageAttachable(runId, stageId, false);
        activeStore.recordStageEnd(runId, stageSnapshot);
        opts.onStageEnd?.(runId, stageSnapshot);
        if (opts.persistence) {
          appendStageEnd(opts.persistence, {
            runId,
            stageId,
            status: stageSnapshot.status,
            durationMs: stageSnapshot.durationMs,
            ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
            ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
            ...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
            ...(stageSnapshot.failureRecoverability !== undefined ? { failureRecoverability: stageSnapshot.failureRecoverability } : {}),
            ...(stageSnapshot.failureDisposition !== undefined ? { failureDisposition: stageSnapshot.failureDisposition } : {}),
            ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
            ...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
            ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
            ...stageReplayFields(stageSnapshot),
          });
        }
        tracker.onSettle(stageId);
      };

      activeStore.recordStageStart(runId, stageSnapshot);
      opts.onStageStart?.(runId, stageSnapshot);
      unregisterWorkflowExitCleanup = registerWorkflowExitCleanup(stageId, {
        skipForWorkflowExit(reason?: string): void {
          if (finalized) return;
          stageSnapshot.skippedReason = workflowExitSkippedReason(reason);
          if (!shouldReplay) {
            stageUiBroker.cancelStagePrompt(
              runId,
              stageId,
              new Error(`atomic-workflows: prompt ${stageId} skipped by workflow exit`),
            );
          }
          finalizePromptStage("skipped");
        },
      });
      if (opts.persistence) {
        appendStageStart(opts.persistence, {
          runId,
          stageId,
          name: stageSnapshot.name,
          parentIds: stageSnapshot.parentIds,
          ...stageReplayFields(stageSnapshot),
          ts: prompt.createdAt,
        });
      }
      if (shouldReplay) {
        await Promise.resolve();
        throwIfWorkflowExitSelected();
        finalizePromptStage("completed");
        return replayAnswer.value;
      }

      if (isCustom) {
        if (descriptor.options?.overlay === true) {
          const error = new Error("atomic-workflows: ctx.ui.custom overlay mode is unavailable in the workflow graph viewer");
          applyFailureToStage(stageSnapshot, classifyExecutorFailure(error));
          finalizePromptStage("failed");
          throw error;
        }

        const mergedSignal = mergeHilSignals(ownController.signal, descriptor.options?.signal);
        try {
          if (mergedSignal.signal.aborted) throw hilAbortError(mergedSignal.signal);
          const accepted = activeStore.recordStageAwaitingInput(runId, stageId, true, prompt.createdAt);
          if (!accepted) {
            const error = new Error("atomic-workflows: ctx.ui.custom prompt node is unavailable");
            stageSnapshot.skippedReason = "prompt-unavailable";
            finalizePromptStage("skipped");
            throw error;
          }
          const response = await stageUiBroker.requestCustomUi(
            runId,
            stageId,
            descriptor.factory as unknown as Parameters<typeof stageUiBroker.requestCustomUi>[2],
            descriptor.options as Parameters<typeof stageUiBroker.requestCustomUi>[3],
            mergedSignal.signal,
          );
          activeStore.recordStagePromptAnswer(runId, stageId, prompt, response, {
            answerSource: "workflow_ui",
          });
          finalizePromptStage("completed");
          return response;
        } catch (err) {
          activeStore.recordStageAwaitingInput(runId, stageId, false);
          stageUiBroker.cancelStagePrompt(runId, stageId, err);
          if (mergedSignal.signal.aborted) {
            preserveWorkflowExitSkippedReason(
              stageSnapshot,
              ownController.signal.aborted ? "run-aborted" : "prompt-aborted",
            );
            finalizePromptStage("skipped");
            throw hilAbortError(mergedSignal.signal);
          }
          if (!finalized) {
            applyFailureToStage(stageSnapshot, classifyExecutorFailure(err));
            finalizePromptStage("failed");
          }
          throw err;
        } finally {
          mergedSignal.dispose();
        }
      }

      const accepted = activeStore.recordStagePendingPrompt(runId, stageId, prompt);
      if (!accepted) {
        stageSnapshot.skippedReason = "prompt-unavailable";
        finalizePromptStage("skipped");
        return fallbackForPromptDescriptor(descriptor);
      }

      const waiter = activeStore.awaitStagePendingPrompt(runId, stageId, prompt.id);
      try {
        const response = await new Promise<unknown>((resolve, reject) => {
          const onAbort = (): void => {
            activeStore.resolveStagePendingPrompt(
              runId,
              stageId,
              prompt.id,
              fallbackForPromptDescriptor(descriptor),
              { recordAnswer: false },
            );
            reject(hilAbortError(ownController.signal));
          };
          if (ownController.signal.aborted) {
            onAbort();
            return;
          }
          ownController.signal.addEventListener("abort", onAbort, { once: true });
          waiter.then(
            (value) => {
              ownController.signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err: unknown) => {
              ownController.signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
        finalizePromptStage("completed");
        return response;
      } catch (err) {
        if (ownController.signal.aborted) {
          preserveWorkflowExitSkippedReason(stageSnapshot, "run-aborted");
          finalizePromptStage("skipped");
        } else {
          applyFailureToStage(stageSnapshot, classifyExecutorFailure(err));
          finalizePromptStage("failed");
        }
        throw err;
      }
    };

    return {
      async input(promptText: string): Promise<string> {
        const response = await ask({ kind: "input", message: promptText });
        return typeof response === "string" ? response : String(response ?? "");
      },
      async confirm(message: string): Promise<boolean> {
        const response = await ask({ kind: "confirm", message });
        return response === true;
      },
      async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
        if (options.length === 0) {
          throw new Error("atomic-workflows: ctx.ui.select requires at least one option");
        }
        const response = await ask({ kind: "select", message, choices: options });
        if (typeof response === "string" && (options as readonly string[]).includes(response)) {
          return response as T;
        }
        return options[0]!;
      },
      async editor(initial?: string): Promise<string> {
        const response = await ask({
          kind: "editor",
          message: "Edit and save to continue.",
          initial,
        });
        return typeof response === "string" ? response : initial ?? "";
      },
      async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
        const response = await ask(customPromptDescriptor(factory, options));
        return response as T;
      },
    };
  };

  const buildExitGatedUiContext = (): WorkflowUIContext => {
    // Headless (non-interactive) runs without an adapter get a context whose
    // interactive primitives fail with a clear "unavailable in headless mode"
    // error instead of a raw TypeError (#1339).
    const base = opts.usePromptNodesForUi === true
      ? buildPromptNodeUiAdapter()
      : opts.executionMode === "non_interactive" && opts.ui === undefined
        ? makeHeadlessUnavailableUIContext()
        : normalizeUIContext(opts.ui);
    return {
      async input(promptText: string): Promise<string> {
        throwIfWorkflowExitSelected();
        return await base.input(promptText);
      },
      async confirm(message: string): Promise<boolean> {
        throwIfWorkflowExitSelected();
        return await base.confirm(message);
      },
      async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
        throwIfWorkflowExitSelected();
        return await base.select(message, options);
      },
      async editor(initial?: string): Promise<string> {
        throwIfWorkflowExitSelected();
        return await base.editor(initial);
      },
      async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
        throwIfWorkflowExitSelected();
        return await base.custom(factory, options);
      },
    };
  };

  // 5. Build WorkflowRunContext
  const ctx: WorkflowRunContext<TInputs> = {
    inputs: resolvedInputs as TInputs,
    get cwd() { return resolveWorkflowCwd(); },
    exit(options?: WorkflowExitOptions): never {
      if (selectedExit !== undefined) {
        if (!ownController.signal.aborted) ownController.abort(selectedExit);
        runWorkflowExitCleanups(selectedExit.reason);
        throw selectedExit;
      }
      if (ownController.signal.aborted) {
        throw ownController.signal.reason ?? new DOMException("workflow killed", "AbortError");
      }

      const throwNestedSelectedExit = (): void => {
        if (selectedExit === undefined) return;
        if (!ownController.signal.aborted) ownController.abort(selectedExit);
        runWorkflowExitCleanups(selectedExit.reason);
        throw selectedExit;
      };
      const rawOptions = options as { readonly status?: unknown; readonly reason?: unknown; readonly outputs?: unknown } | null | undefined;
      let validationError: Error | undefined;
      const captureValidationError = (error: Error): void => {
        validationError ??= error;
      };

      const statusRead = readWorkflowExitOption(rawOptions, "status");
      throwNestedSelectedExit();
      const rawStatus = statusRead.ok ? statusRead.value ?? "completed" : "completed";
      if (!statusRead.ok) {
        captureValidationError(statusRead.error);
      } else if (!isWorkflowExitStatus(rawStatus)) {
        captureValidationError(new TypeError(
          `atomic-workflows: ctx.exit() status must be one of completed, skipped, cancelled, blocked; got ${describeWorkflowExitOptionValue(rawStatus)}`,
        ));
      }
      const status = isWorkflowExitStatus(rawStatus) ? rawStatus : "completed";

      const reasonRead = readWorkflowExitOption(rawOptions, "reason");
      throwNestedSelectedExit();
      const rawReason = reasonRead.ok ? reasonRead.value : undefined;
      if (!reasonRead.ok) {
        captureValidationError(reasonRead.error);
      } else if (rawReason !== undefined && typeof rawReason !== "string") {
        captureValidationError(new TypeError(
          `atomic-workflows: ctx.exit() reason must be a string when provided; got ${workflowSerializableTypeName(rawReason)}`,
        ));
      }
      const reason = typeof rawReason === "string" ? rawReason : undefined;

      const outputsRead = readWorkflowExitOption(rawOptions, "outputs");
      throwNestedSelectedExit();
      const outputSnapshot = !outputsRead.ok
        ? freezeWorkflowExitOutputSnapshot({ ok: false, error: outputsRead.error })
        : outputsRead.value !== undefined
          ? captureWorkflowExitOutputSnapshot(outputsRead.value)
          : undefined;
      throwNestedSelectedExit();

      // Freeze the signal so a broad author `catch (signal) { signal.* = ...; throw signal; }`
      // cannot rewrite the terminal status/reason/outputs. Finalization recovers this exact
      // object (via the abort reason or the rethrow) and the outputSnapshot value is already
      // deep-frozen, so the first selected exit is the authoritative terminal result.
      const signal: WorkflowExitSignal = {
        [WORKFLOW_EXIT_SIGNAL]: true,
        scope: exitScope,
        status,
        ...(reason !== undefined ? { reason } : {}),
        ...(outputSnapshot !== undefined ? { outputSnapshot } : {}),
        ...(validationError !== undefined ? { validationError } : {}),
      };
      selectedExit = Object.freeze(signal);
      ownController.abort(selectedExit);
      runWorkflowExitCleanups(reason);
      throw selectedExit;
    },
    // Prompt nodes and caller-provided UI adapters are mutually exclusive;
    // executor-owned prompt nodes intentionally take precedence when enabled.
    ui: buildExitGatedUiContext(),

    stage(name: string, options?: StageOptions, stageFailFastScope?: ParallelFailFastScope) {
      throwIfWorkflowExitSelected();
      options = stageOptionsWithGitWorktree(stageOptionsWithInputDefaults(options, inputRuntimeDefaults), workflowInvocationCwd);
      // a. Generate stageId
      const stageId = crypto.randomUUID();

      // b. tracker.onSpawn → provisional parentIds
      const provisionalParentIds = tracker.onSpawn(stageId, name);

      // c. Create StageSnapshot as "pending"
      const replayKey = `stage:${name}`;
      const replayDecision = replayIndex.decide({
        displayName: name,
        replayKey,
        parentIds: provisionalParentIds,
        stageId,
        kind: "stage",
      });
      const parentIds = replayDecision.parentIds;
      if (!sameStringSet(parentIds, provisionalParentIds)) {
        tracker.replaceParents(stageId, parentIds);
      }
      const replaySource = replayDecision.kind === "replay" ? replayDecision.source : undefined;
      const shouldReplay = replaySource !== undefined;

      const stageSnapshot: StageSnapshot = {
        id: stageId,
        name,
        replayKey,
        status: shouldReplay ? "completed" : "pending",
        parentIds: Object.freeze(parentIds),
        toolEvents: [],
        ...(shouldReplay ? {
          startedAt: Date.now(),
          endedAt: Date.now(),
          durationMs: 0,
          ...(replaySource.result !== undefined ? { result: replaySource.result } : {}),
          replayedFromStageId: replaySource.id,
          replayed: true,
        } : {}),
        // Store mcp scope options on snapshot when provided
        ...(options?.mcp !== undefined
          ? { mcpScope: { allow: options.mcp.allow ?? null, deny: options.mcp.deny ?? null } }
          : {}),
        // Mark attachable up-front: the live stage handle is registered
        // below before the first onStageStart fires, so consumers that
        // hook onStageStart see `attachable: true` for the pending stage.
        attachable: !shouldReplay,
      };

      let stageStartEntryAppended = false;
      const appendStageStartOnce = (): void => {
        if (!opts.persistence || stageStartEntryAppended) return;
        stageStartEntryAppended = true;
        appendStageStart(opts.persistence, {
          runId,
          stageId,
          name,
          parentIds: stageSnapshot.parentIds,
          ...stageReplayFields(stageSnapshot),
          ts: stageSnapshot.startedAt ?? Date.now(),
        });
      };

      if (shouldReplay) {
        activeStore.recordStageStart(runId, stageSnapshot);
        opts.onStageStart?.(runId, stageSnapshot);
        appendStageStartOnce();
        let replayFinalized = false;
        let unregisterWorkflowExitCleanup = (): void => {};
        const appendReplayStageEnd = (): void => {
          if (!opts.persistence) return;
          appendStageEnd(opts.persistence, {
            runId,
            stageId,
            status: stageSnapshot.status,
            durationMs: stageSnapshot.durationMs ?? 0,
            ...(stageSnapshot.status === "completed" && stageSnapshot.result !== undefined ? { summary: stageSnapshot.result } : {}),
            ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
            ...stageReplayFields(stageSnapshot),
          });
        };
        const finalizeReplayStage = (status: "completed" | "skipped", reason?: string): void => {
          if (replayFinalized) return;
          replayFinalized = true;
          unregisterWorkflowExitCleanup();
          stageSnapshot.status = status;
          if (status === "skipped") {
            delete stageSnapshot.result;
            stageSnapshot.skippedReason = workflowExitSkippedReason(reason);
          }
          stageSnapshot.endedAt = Date.now();
          stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
          activeStore.recordStageEnd(runId, stageSnapshot);
          opts.onStageEnd?.(runId, stageSnapshot);
          appendReplayStageEnd();
          tracker.onSettle(stageId);
        };
        unregisterWorkflowExitCleanup = registerWorkflowExitCleanup(stageId, {
          skipForWorkflowExit(reason?: string): void {
            finalizeReplayStage("skipped", reason);
          },
        });
        const replayResult = replaySource.result ?? "";
        const replayText = async (): Promise<string> => {
          await Promise.resolve();
          throwIfWorkflowExitSelected();
          finalizeReplayStage("completed");
          return replayResult;
        };
        const rejectReplayMutation = (action: string): never => {
          throw new Error(`atomic-workflows: replayed stage "${name}" cannot ${action}`);
        };
        const replayContext: InternalStageContext = {
          name,
          prompt: replayText,
          complete: replayText,
          steer: async () => rejectReplayMutation("steer"),
          followUp: async () => rejectReplayMutation("follow up"),
          subscribe: () => () => {},
          get sessionFile() { return replaySource.sessionFile; },
          get sessionId() { return replaySource.sessionId ?? ""; },
          setModel: async () => rejectReplayMutation("set model"),
          setThinkingLevel: () => rejectReplayMutation("set thinking level"),
          cycleModel: async () => rejectReplayMutation("cycle model"),
          cycleThinkingLevel: () => rejectReplayMutation("cycle thinking level"),
          get agent() { return undefined as never; },
          get model() { return replaySource.model as never; },
          get thinkingLevel() { return undefined as never; },
          get messages() { return [] as never; },
          get isStreaming() { return false; },
          navigateTree: async () => rejectReplayMutation("navigate conversation tree"),
          compact: async () => rejectReplayMutation("compact"),
          abortCompaction: () => rejectReplayMutation("abort compaction"),
          abort: async () => rejectReplayMutation("abort"),
          __dispose: async () => {},
          __getLastAssistantText: () => replayResult,
          getLastAssistantText: () => replayResult,
          __ensureSession: async () => {},
          __sessionMeta: () => ({
            sessionId: replaySource.sessionId,
            sessionFile: replaySource.sessionFile,
          }),
          __agentSession: () => undefined,
          __pendingMessageCount: () => 0,
          __modelFallbackMeta: () => ({
            ...(replaySource.model !== undefined ? { model: replaySource.model } : {}),
            ...(replaySource.fastMode === true ? { fastMode: replaySource.fastMode } : {}),
            ...(replaySource.attemptedModels !== undefined ? { attemptedModels: replaySource.attemptedModels } : {}),
            ...(replaySource.modelAttempts !== undefined ? { modelAttempts: replaySource.modelAttempts } : {}),
          }),
          __requestPause: async () => rejectReplayMutation("pause"),
          __resume: async () => rejectReplayMutation("resume"),
          __isPaused: () => false,
        };
        return replayContext;
      }

      // d. Create inner AgentSession-like StageContext (raw, without lifecycle wrapping).
      //    Must come before the registry registration because the handle
      //    delegates to it for every operation.
      const applyModelFallbackMeta = (meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>): void => {
        if (meta.model !== undefined) stageSnapshot.model = meta.model;
        if (meta.fastMode !== undefined) {
          if (meta.fastMode) stageSnapshot.fastMode = true;
          else delete stageSnapshot.fastMode;
        }
        if (meta.attemptedModels !== undefined) stageSnapshot.attemptedModels = meta.attemptedModels;
        if (meta.modelAttempts !== undefined) stageSnapshot.modelAttempts = meta.modelAttempts;
      };

      const innerCtx: InternalStageContext = createStageContext({
        stageId,
        stageName: name,
        adapters,
        runId,
        signal: ownController.signal,
        stageOptions: options,
        models: opts.models,
        executionMode: opts.executionMode,
        onModelFallbackMetaChange(meta) {
          applyModelFallbackMeta(meta);
          if (stageSnapshot.status === "running") {
            activeStore.recordStageStart(runId, stageSnapshot);
          }
        },
      });
      const activeAskUserQuestionCalls = new Set<string>();
      let activeAskUserQuestionAnonymousCalls = 0;
      // Set whenever an ask_user_question tool call is observed during the
      // current model turn. Drives the deterministic readiness gate (#1099):
      // after a turn that asked the user a question ends, the workflow must
      // confirm readiness before completing/advancing the stage.
      let askUserQuestionObservedThisTurn = false;
      // Set when the completed ask_user_question call carried a chat answer.
      // When true the readiness gate is bypassed — the stage stays in the
      // composer without showing an extra confirmation UI (#1264).
      let chatAnswerObservedThisTurn = false;
      const hasActiveAskUserQuestion = (): boolean =>
        activeAskUserQuestionCalls.size > 0 || activeAskUserQuestionAnonymousCalls > 0;
      const unsubscribeAskUserQuestionWatcher = innerCtx.subscribe((event) => {
        const toolEvent = askUserQuestionToolEvent(event);
        if (!toolEvent) return;
        if (toolEvent.phase === "start") {
          askUserQuestionObservedThisTurn = true;
          if (toolEvent.callId !== undefined) activeAskUserQuestionCalls.add(toolEvent.callId);
          else activeAskUserQuestionAnonymousCalls += 1;
          // Expose a headless-answer adapter before marking the stage awaiting
          // input so the main-chat steering notice can include the actual
          // structured question instead of a promptless placeholder.
          const adapter = buildStagePromptAdapter(
            toolEvent.callId ?? `ask-user-question-${stageId}`,
            "ask_user_question",
            toolEvent.args,
            Date.now(),
          );
          if (adapter) stageUiBroker.provideStagePrompt(runId, stageId, adapter);
          activeStore.recordStageAwaitingInput(runId, stageId, true);
          return;
        }

        if (toolEvent.callId !== undefined && activeAskUserQuestionCalls.has(toolEvent.callId)) {
          activeAskUserQuestionCalls.delete(toolEvent.callId);
        } else if (toolEvent.callId === undefined && toolEvent.nameMatched) {
          activeAskUserQuestionAnonymousCalls = Math.max(0, activeAskUserQuestionAnonymousCalls - 1);
        } else {
          return;
        }

        // If the completed call carried a chat answer, remember it so the
        // readiness gate can bypass confirmReadiness for this turn (#1264).
        if (toolResultHasChatAnswer((event as Record<string, unknown>)["result"])) {
          chatAnswerObservedThisTurn = true;
        }

        if (!hasActiveAskUserQuestion()) {
          activeStore.recordStageAwaitingInput(runId, stageId, false);
          stageUiBroker.clearStagePrompt(runId, stageId);
        }
      });
      const disposeInnerContext = async (): Promise<void> => {
        unsubscribeAskUserQuestionWatcher();
        activeAskUserQuestionCalls.clear();
        activeAskUserQuestionAnonymousCalls = 0;
        activeStore.recordStageAwaitingInput(runId, stageId, false);
        stageUiBroker.clearStagePrompt(runId, stageId);
        await innerCtx.__dispose();
      };
      let unregisterStageHandle = (): void => {};
      let dropStageControlHandle = (): void => {};
      let liveHandleReleased = false;
      const releaseLiveHandle = async (): Promise<void> => {
        if (liveHandleReleased) return;
        liveHandleReleased = true;
        dropStageControlHandle();
        unregisterStageHandle();
        await disposeInnerContext();
      };
      const dropStageControlForCompletion = async (): Promise<void> => {
        // Completion removes the stage from workflow-level pause/resume and
        // dependency cascades, but must not turn the attached/reopenable chat
        // into a read-only archive. Keep the direct live handle registered for
        // post-completion follow-ups until the registry/store is explicitly
        // cleared by the host.
        dropStageControlHandle();
      };
      let stageClosedByWorkflowExit = false;
      const throwIfStageMutationBlocked = (): void => {
        if (stageClosedByWorkflowExit) {
          throwIfWorkflowExitSelected();
          throw new Error(`atomic-workflows: stage "${name}" skipped by workflow exit`);
        }
        throwIfWorkflowExitSelected();
      };

      // e. Register a live stage-control handle so attached panes can
      //    prompt/steer/pause/resume the underlying Pi session lazily.
      //    Pending stages are attachable from the moment they are spawned;
      //    the chat surface only realises the SDK session when the user
      //    types or the workflow body invokes a tracked call.
      const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
      const handle: StageControlHandle = {
        runId,
        stageId,
        stageName: name,
        get status() {
          return stageSnapshot.status;
        },
        get sessionId() {
          return innerCtx.__sessionMeta().sessionId;
        },
        get sessionFile() {
          return innerCtx.__sessionMeta().sessionFile;
        },
        get isStreaming() {
          return innerCtx.isStreaming;
        },
        get isDisposed() {
          return liveHandleReleased;
        },
        get messages() {
          return innerCtx.messages;
        },
        get agentSession() {
          return innerCtx.__agentSession();
        },
        async ensureAttached() {
          throwIfStageMutationBlocked();
          await innerCtx.__ensureSession();
          throwIfStageMutationBlocked();
          const meta = innerCtx.__sessionMeta();
          if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
            activeStore.recordStageSession(runId, stageId, meta);
          }
        },
        async prompt(text: string) {
          throwIfStageMutationBlocked();
          await innerCtx.prompt(text);
          throwIfStageMutationBlocked();
          const meta = innerCtx.__sessionMeta();
          if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
            activeStore.recordStageSession(runId, stageId, meta);
          }
        },
        async steer(text: string) {
          throwIfStageMutationBlocked();
          await innerCtx.steer(text);
        },
        async followUp(text: string) {
          throwIfStageMutationBlocked();
          await innerCtx.followUp(text);
        },
        async pause() {
          throwIfStageMutationBlocked();
          const statusBeforePause = stageSnapshot.status;
          const changed = activeStore.recordStagePaused(runId, stageId);
          if (changed) {
            ensureReleaseBarrier(stageId);
            await cascadePauseFrom(stageId);
          }
          if (statusBeforePause === "pending" || statusBeforePause === "running" || innerCtx.isStreaming) {
            await innerCtx.__requestPause();
          }
        },
        async resume(message?: string) {
          throwIfStageMutationBlocked();
          const changed = activeStore.recordStageResumed(runId, stageId);
          if (changed) {
            releaseStageBarrier(stageId);
            await cascadeResumeFrom(stageId);
          }
          await innerCtx.__resume(message);
        },
        subscribe(listener: AgentSessionEventListener) {
          return innerCtx.subscribe(listener);
        },
        async dispose() {
          await releaseLiveHandle();
        },
      };
      let stageFinalized = false;
      let unregisterWorkflowExitCleanup = (): void => {};
      const finalizeStageSnapshot = (): boolean => {
        if (stageFinalized) return false;
        if (stageSnapshot.endedAt !== undefined && isTerminalStage(stageSnapshot)) {
          stageFinalized = true;
          unregisterWorkflowExitCleanup();
          stageFailFastScope?.activeStages.delete(stageId);
          tracker.onSettle(stageId);
          return false;
        }
        stageFinalized = true;
        unregisterWorkflowExitCleanup();
        stageSnapshot.endedAt = Date.now();
        stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);

        applyModelFallbackMeta(innerCtx.__modelFallbackMeta());

        activeStore.recordStageEnd(runId, stageSnapshot);
        stageUiBroker.cancelStagePrompt(
          runId,
          stageId,
          new Error(`atomic-workflows: stage ${stageId} completed with pending custom UI`),
        );
        opts.onStageEnd?.(runId, stageSnapshot);

        if (opts.persistence) {
          appendStageStartOnce();
          appendStageEnd(opts.persistence, {
            runId,
            stageId,
            status: stageSnapshot.status,
            durationMs: stageSnapshot.durationMs,
            ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
            ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
            ...(stageSnapshot.failureCode !== undefined ? { failureCode: stageSnapshot.failureCode } : {}),
            ...(stageSnapshot.failureRecoverability !== undefined ? { failureRecoverability: stageSnapshot.failureRecoverability } : {}),
            ...(stageSnapshot.failureDisposition !== undefined ? { failureDisposition: stageSnapshot.failureDisposition } : {}),
            ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
            ...(stageSnapshot.retryAfterMs !== undefined ? { retryAfterMs: stageSnapshot.retryAfterMs } : {}),
            ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
            ...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed" ? { summary: stageSnapshot.result } : {}),
            ...stageReplayFields(stageSnapshot),
          });
        }

        stageFailFastScope?.activeStages.delete(stageId);
        tracker.onSettle(stageId);
        return true;
      };
      let skippedForParallelFailFast = false;
      const markSkippedForParallelFailFast = (): void => {
        skippedForParallelFailFast = true;
        stageSnapshot.status = "skipped";
        stageSnapshot.skippedReason = "fail-fast";
      };
      const parallelFailFastError = (): unknown =>
        stageFailFastScope?.firstFailure ?? new Error("atomic-workflows: skipped after parallel fail-fast");
      const skipForParallelFailFast = (): void => {
        if (isTerminalStage(stageSnapshot)) return;
        markSkippedForParallelFailFast();
        finalizeStageSnapshot();
        void innerCtx.abort().catch(() => {});
        void dropStageControlForCompletion().catch(() => {});
      };
      stageFailFastScope?.activeStages.set(stageId, { skip: skipForParallelFailFast });
      unregisterWorkflowExitCleanup = registerWorkflowExitCleanup(stageId, {
        async skipForWorkflowExit(reason?: string): Promise<void> {
          stageClosedByWorkflowExit = true;
          if (!isTerminalStage(stageSnapshot)) {
            stageSnapshot.status = "skipped";
            stageSnapshot.skippedReason = workflowExitSkippedReason(reason);
            finalizeStageSnapshot();
          }
          await innerCtx.abort().catch(() => {});
          await releaseLiveHandle().catch(() => {});
        },
      });

      let stageControlDropped = false;
      dropStageControlHandle = (): void => {
        if (stageControlDropped) return;
        stageControlDropped = true;
        activeStore.recordStageAttachable(runId, stageId, false);
        stageRegistry.detachControl(runId, stageId, handle);
      };
      unregisterStageHandle = stageRegistry.register(handle);

      // f. Record stage start in store (as pending), call onStageStart.
      activeStore.recordStageStart(runId, stageSnapshot);
      opts.onStageStart?.(runId, stageSnapshot);
      const blockedBy = blockingAncestorFor(stageSnapshot);
      if (blockedBy !== undefined) {
        blockStageUntilCascadeRelease(stageSnapshot, blockedBy);
      }


      const waitForStageRelease = async (): Promise<void> => {
        while (true) {
          const barrier = releaseBarriers.get(stageId);
          if (!barrier) return;
          try {
            await barrier.promise;
          } catch (err) {
            await releaseLiveHandle();
            throw err;
          }
        }
      };

      // Deterministic readiness gate (#1099). After a model turn that issued an
      // ask_user_question tool call ends, confirm with the user before the stage
      // completes/advances. "No" keeps execution in this stage (steer + re-gate
      // after the next turn); "Yes" resumes progression. The gate engages only
      // when a confirmation seam is available, so headless/test runs proceed.
      const readinessGateEnabled =
        opts.confirmStageReadiness !== undefined || opts.usePromptNodesForUi === true;
      const confirmReadiness = async (): Promise<"advance" | "stay"> => {
        try {
          if (opts.confirmStageReadiness !== undefined) {
            const ready = await opts.confirmStageReadiness({
              runId,
              stageId,
              stageName: name,
              signal: ownController.signal,
            });
            return ready ? "advance" : "stay";
          }
          return await askReadinessViaStageBroker(runId, stageId, ownController.signal);
        } catch {
          // A gate failure must not strand the workflow; proceed on error.
          return "advance";
        }
      };

      const runTrackedStageCall = async (call: () => Promise<string>, eagerSession = false): Promise<string> => {
        throwIfWorkflowExitSelected();
        await waitForStageRelease();
        if (stageFinalized) {
          throw parallelFailFastError();
        }

        // Block here until a concurrency slot is available for this run.
        await limiter.acquire();

        try {
          await waitForStageRelease();
          throwIfWorkflowExitSelected();
          if (stageFinalized) {
            throw parallelFailFastError();
          }
        } catch (err) {
          limiter.release();
          throw err;
        }

        if (opts.continuation === undefined && stageSnapshot.startedAt === undefined) {
          const actualParentIds = tracker.currentParents();
          if (!sameStringSet(actualParentIds, stageSnapshot.parentIds)) {
            tracker.replaceParents(stageId, actualParentIds);
            setStageParentIds(stageSnapshot, actualParentIds);
          }
        }
        stageSnapshot.status = "running";
        stageSnapshot.startedAt = Date.now();
        const hasExplicitFastModeCandidate = async (): Promise<boolean> => {
          const rawCandidate = isCodexFastModeCandidateModelId(workflowModelId(options?.model))
            || (Array.isArray(options?.fallbackModels) && options.fallbackModels.some((candidate) => isCodexFastModeCandidateModelId(workflowModelId(candidate))));
          if (rawCandidate) return true;
          try {
            const candidates = await buildModelCandidatesFromCatalog({
              primaryModel: options?.model,
              fallbackModels: options?.fallbackModels,
              catalog: opts.models,
            });
            return candidates.some((candidate) => isCodexFastModeCandidateModelId(candidate.id));
          } catch {
            return false;
          }
        };
        const hasNoExplicitModelConfig = options?.model === undefined && options?.fallbackModels === undefined;
        const promptAdapterHandlesInitialPrompt = adapters.prompt !== undefined;
        if (eagerSession && !promptAdapterHandlesInitialPrompt && (hasNoExplicitModelConfig || await hasExplicitFastModeCandidate())) {
          try {
            await innerCtx.__ensureSession();
          } catch (err) {
            if (!(err instanceof Error && err.message.includes("prompt adapter not configured"))) {
              throw err;
            }
          }
        }
        applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
        activeStore.recordStageStart(runId, stageSnapshot);

        // Persistence: append stage.start entry
        appendStageStartOnce();

        const mcpAllow = options?.mcp?.allow ?? null;
        const mcpDeny = options?.mcp?.deny ?? null;
        const hasMcpScope = mcpAllow !== null || mcpDeny !== null;

        if (opts.mcp && hasMcpScope) {
          opts.mcp.setScope(stageId, mcpAllow, mcpDeny);
        }

        try {
          const abortSession = (): void => {
            void innerCtx.abort().catch(() => {});
          };
          if (ownController.signal.aborted) abortSession();
          else ownController.signal.addEventListener("abort", abortSession, { once: true });
          let result = "";
          try {
            // Run the stage's initial agent turn.
            askUserQuestionObservedThisTurn = false;
            chatAnswerObservedThisTurn = false;
            result = await raceAbort(call(), ownController.signal);

            // Per-turn readiness gate (#1099). When an agent turn ENDS (control
            // returns to the user): if the turn issued no ask_user_question
            // call, complete/advance automatically; if it DID, show the gate.
            // "advance" completes the stage; anything else hands control back to
            // the user, who keeps working in the normal stage composer — we wait
            // for their next turn to end (the session's agent_end event) and
            // re-apply the same check. No canned auto-steer, so the user is
            // never trapped re-gating and the stage never auto-drives a hidden
            // turn that could strand the stream.
            if (!ownController.signal.aborted && readinessGateEnabled) {
              let resolveNextTurnEnd: (() => void) | null = null;
              const unsubscribeTurnWatcher = innerCtx.subscribe((event) => {
                if ((event as { type?: unknown }).type === "agent_end" && resolveNextTurnEnd) {
                  const resolve = resolveNextTurnEnd;
                  resolveNextTurnEnd = null;
                  resolve();
                }
              });
              try {
                while (askUserQuestionObservedThisTurn) {
                  // Chat answer: bypass the confirmation UI and stay in the composer
                  // without asking again (#1264).
                  const decision = chatAnswerObservedThisTurn
                    ? "stay"
                    : await confirmReadiness();
                  if (decision === "advance") break;
                  if (ownController.signal.aborted) break;
                  // Stay: return control to the user and await their next
                  // composer-driven turn end before re-checking.
                  askUserQuestionObservedThisTurn = false;
                  chatAnswerObservedThisTurn = false;
                  await raceAbort(
                    new Promise<void>((resolve) => {
                      resolveNextTurnEnd = resolve;
                    }),
                    ownController.signal,
                  );
                  if (ownController.signal.aborted) break;
                  result = innerCtx.__getLastAssistantText() ?? result;
                }
              } finally {
                resolveNextTurnEnd = null;
                unsubscribeTurnWatcher();
              }
            }
          } finally {
            ownController.signal.removeEventListener("abort", abortSession);
          }
          // Capture SDK session metadata into the snapshot so the
          // attached chat surface can reopen the persisted session
          // via SessionManager.open(sessionFile) post-mortem.
          {
            const meta = innerCtx.__sessionMeta();
            if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
              activeStore.recordStageSession(runId, stageId, meta);
            }
            applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
          }
          if (stageFailFastScope?.failed === true && stageFailFastScope.activeStages.has(stageId)) {
            markSkippedForParallelFailFast();
            throw parallelFailFastError();
          }
          if (stageFinalized) {
            throw parallelFailFastError();
          }
          stageSnapshot.status = "completed";
          const assistantText = innerCtx.__getLastAssistantText();
          if (assistantText !== undefined) {
            stageSnapshot.result = assistantText;
          }
          return result;
        } catch (err) {
          const meta = innerCtx.__sessionMeta();
          if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
            activeStore.recordStageSession(runId, stageId, meta);
          }
          applyModelFallbackMeta(innerCtx.__modelFallbackMeta());

          const workflowExitAbort = ownController.signal.aborted
            ? currentWorkflowExitAbortReason()
            : undefined;
          if (workflowExitAbort !== undefined && !skippedForParallelFailFast) {
            stageClosedByWorkflowExit = true;
            if (!isTerminalStage(stageSnapshot)) {
              stageSnapshot.status = "skipped";
              stageSnapshot.skippedReason = workflowExitSkippedReason(workflowExitAbort.reason);
            }
          } else if (!ownController.signal.aborted && !skippedForParallelFailFast) {
            applyFailureToStage(stageSnapshot, classifyExecutorFailure(err));
          }
          throw err;
        } finally {
          if (opts.mcp && hasMcpScope) {
            opts.mcp.clearScope(stageId);
          }

          finalizeStageSnapshot();
          if (stageClosedByWorkflowExit || currentWorkflowExitAbortReason() !== undefined) {
            await releaseLiveHandle().catch(() => {});
          } else {
            // The stage has finished participating in workflow scheduling. Drop it
            // from run-level pause/resume and cascade-pause lookups immediately,
            // while retaining the direct chat handle so completed nodes can be
            // reopened and continued instead of becoming read-only archives.
            await dropStageControlForCompletion().catch(() => {});
          }
          limiter.release();
        }
      };

      const noticeValue = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (value === undefined || value === null) return "";
        if (typeof value === "object") {
          const candidate = value as { id?: unknown; name?: unknown; label?: unknown };
          if (typeof candidate.id === "string") return candidate.id;
          if (typeof candidate.name === "string") return candidate.name;
          if (typeof candidate.label === "string") return candidate.label;
        }
        return String(value);
      };

      const recordStageNotice = (notice: Omit<StageNotice, "id" | "ts">): void => {
        activeStore.recordStageNotice(runId, stageId, {
          id: crypto.randomUUID(),
          ts: Date.now(),
          ...notice,
        });
      };

      const compactionMeta = (result: unknown): string | undefined => {
        if (result === undefined || result === null || typeof result !== "object") return undefined;
        const compaction = result as {
          stats?: { tokensBefore?: unknown; tokensAfter?: unknown };
          tokensBefore?: unknown;
          tokensAfter?: unknown;
          tokensKept?: unknown;
        };
        const beforeRaw = compaction.stats?.tokensBefore ?? compaction.tokensBefore;
        const keptRaw = compaction.stats?.tokensAfter ?? compaction.tokensKept ?? compaction.tokensAfter;
        const before = typeof beforeRaw === "number" ? beforeRaw : undefined;
        const kept = typeof keptRaw === "number" ? keptRaw : undefined;
        if (before === undefined || kept === undefined) return undefined;
        return `${(before / 1000).toFixed(1)}k → ${(kept / 1000).toFixed(1)}k`;
      };

      const stageContext: StageContext & Pick<InternalStageContext, "__modelFallbackMeta"> = {
        name: innerCtx.name,
        prompt: (text, promptOptions) => {
          throwIfStageMutationBlocked();
          return runTrackedStageCall(() => innerCtx.prompt(text, promptOptions), true);
        },
        complete: (text, completeOptions) => {
          throwIfStageMutationBlocked();
          return runTrackedStageCall(() => innerCtx.complete(text, completeOptions));
        },
        steer: (text) => {
          throwIfStageMutationBlocked();
          return innerCtx.steer(text);
        },
        followUp: (text) => {
          throwIfStageMutationBlocked();
          return innerCtx.followUp(text);
        },
        subscribe: (listener) => innerCtx.subscribe(listener),
        get sessionFile() { return innerCtx.sessionFile; },
        get sessionId() { return innerCtx.sessionId; },
        setModel: async (model) => {
          throwIfStageMutationBlocked();
          await innerCtx.__ensureSession();
          throwIfStageMutationBlocked();
          recordStageNotice({ kind: "model", from: noticeValue(innerCtx.model), to: noticeValue(model) });
          await innerCtx.setModel(model);
        },
        setThinkingLevel: (level) => {
          throwIfStageMutationBlocked();
          recordStageNotice({ kind: "thinking", from: noticeValue(innerCtx.thinkingLevel), to: noticeValue(level) });
          innerCtx.setThinkingLevel(level);
        },
        cycleModel: async () => {
          throwIfStageMutationBlocked();
          const from = noticeValue(innerCtx.model);
          const result = await innerCtx.cycleModel();
          recordStageNotice({ kind: "model", from, to: noticeValue(innerCtx.model) });
          return result;
        },
        cycleThinkingLevel: () => {
          throwIfStageMutationBlocked();
          const from = noticeValue(innerCtx.thinkingLevel);
          const result = innerCtx.cycleThinkingLevel();
          recordStageNotice({ kind: "thinking", from, to: noticeValue(innerCtx.thinkingLevel) });
          return result;
        },
        get agent() { return innerCtx.agent; },
        get model() { return innerCtx.model; },
        get thinkingLevel() { return innerCtx.thinkingLevel; },
        get messages() { return innerCtx.messages; },
        get isStreaming() { return innerCtx.isStreaming; },
        navigateTree: async (targetId, treeOptions) => {
          throwIfStageMutationBlocked();
          recordStageNotice({ kind: "tree", to: targetId });
          return innerCtx.navigateTree(targetId, treeOptions);
        },
        compact: async () => {
          throwIfStageMutationBlocked();
          const result = await innerCtx.compact();
          recordStageNotice({ kind: "compaction", to: "compacted", meta: compactionMeta(result) });
          return result;
        },
        abortCompaction: () => {
          throwIfStageMutationBlocked();
          innerCtx.abortCompaction();
        },
        abort: async () => {
          throwIfStageMutationBlocked();
          recordStageNotice({ kind: "abort", to: "interrupted" });
          await innerCtx.abort();
        },
        __modelFallbackMeta: () => innerCtx.__modelFallbackMeta(),
      };
      return stageContext;
    },

    async task(name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope): Promise<WorkflowTaskResult> {
      throwIfWorkflowExitSelected();
      const runTaskOnce = async (taskOptions: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
        throwIfWorkflowExitSelected();
        const resolvedTaskOptions = stageOptionsWithGitWorktree(stageOptionsWithInputDefaults(taskOptions, inputRuntimeDefaults), workflowInvocationCwd) ?? taskOptions;
        const stage = (ctx.stage as typeof ctx.stage & ((stageName: string, stageOptions?: StageOptions, scope?: ParallelFailFastScope) => StageContext))(
          name,
          taskStageOptions(resolvedTaskOptions),
          stageFailFastScope,
        );
        const rawOutput = await stage.prompt(
          applyTaskContext(`${taskReadInstruction(resolvedTaskOptions)}${taskPrompt(resolvedTaskOptions)}`, taskPrevious(resolvedTaskOptions)),
          taskPromptOptions(resolvedTaskOptions),
        );
        const structured = typeof rawOutput === "string" ? undefined : rawOutput;
        const text = truncateTaskOutput(structuredTaskOutputText(rawOutput), resolvedTaskOptions.maxOutput);
        const sessionId = (() => {
          try {
            return stage.sessionId;
          } catch {
            return undefined;
          }
        })();
        const stageMeta = (stage as InternalStageContext).__modelFallbackMeta?.() ?? {};
        return {
          name,
          stageName: name,
          text,
          ...(structured !== undefined ? { structured: structured as WorkflowSerializableValue } : {}),
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
          ...(stageMeta.model !== undefined ? { model: stageMeta.model } : {}),
          ...(stageMeta.fastMode === true ? { fastMode: stageMeta.fastMode } : {}),
          ...(stageMeta.attemptedModels !== undefined ? { attemptedModels: stageMeta.attemptedModels } : {}),
          ...(stageMeta.modelAttempts !== undefined ? { modelAttempts: stageMeta.modelAttempts } : {}),
          ...(stageMeta.warnings !== undefined ? { warnings: stageMeta.warnings } : {}),
        };
      };

      if (options.worktree !== true) return runTaskOnce(options);

      const prepared = prepareDirectWorktrees(
        [{ ...options, name }],
        { ...options, worktree: true },
        `${runId}-${name}-${crypto.randomUUID()}`,
        name,
      );
      const preparedTask = prepared.tasks[0]!;
      try {
        const result = await runTaskOnce(preparedTask);
        const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
        return worktreeDiffs.artifacts.length === 0
          ? result
          : { ...result, artifacts: [...(result.artifacts ?? []), ...worktreeDiffs.artifacts] };
      } finally {
        if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
      }
    },

    async chain(steps: readonly WorkflowTaskStep[], options: WorkflowChainOptions = {}): Promise<WorkflowTaskResult[]> {
      throwIfWorkflowExitSelected();
      const results: WorkflowTaskResult[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        throwIfWorkflowExitSelected();
        const step = steps[index]!;
        const explicitPrevious = taskPrevious(step);
        const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
        const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
        results.push(await ctx.task(
          step.name,
          taskWithSharedDefaults(taskOptionsFromStep(step, prompt, previous), options),
        ));
      }
      return results;
    },

    async parallel(steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> {
      throwIfWorkflowExitSelected();
      const fallback = parallelFallbackTask(steps, options);
      const failFastScope: ParallelFailFastScope | undefined = options.failFast === false
        ? undefined
        : { failed: false, activeStages: new Map<string, ParallelFailFastStage>() };
      return mapParallelSteps(steps, options.concurrency, options.failFast, async (step) => {
        throwIfWorkflowExitSelected();
        const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback);
        return await (ctx.task as typeof ctx.task & ((taskName: string, taskOptions: WorkflowTaskOptions, scope?: ParallelFailFastScope) => Promise<WorkflowTaskResult>))(
          step.name,
          taskWithSharedDefaults(taskOptionsFromStep(step, prompt, taskPrevious(step)), options),
          failFastScope,
        );
      }, (error) => {
        if (failFastScope === undefined) return;
        failFastScope.failed = true;
        failFastScope.firstFailure = error;
        for (const stage of failFastScope.activeStages.values()) {
          stage.skip();
        }
      }, {
        beforeDequeue: throwIfWorkflowExitSelected,
        beforeMap: throwIfWorkflowExitSelected,
        isControlSignal: (error) => findWorkflowExitSignal(error, exitScope) !== undefined,
      });
    },

    async workflow<TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
      child: WorkflowDefinition<TChildInputs, TChildOutputs>,
      options: WorkflowRunChildOptions<TChildInputs> = {},
    ): Promise<WorkflowChildResult<TChildOutputs>> {
      throwIfWorkflowExitSelected();
      // The executor operates on type-erased definitions at runtime; the child's
      // declared output contract is validated dynamically by the child run and
      // selectWorkflowOutputs, so the typed result is reconstructed via casts.
      if (!isWorkflowDefinition(child)) {
        throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
      }
      const childName = child.normalizedName;
      const boundaryName = options.stageName ?? `workflow:${childName}`;
      const boundaryReplayKey = nextWorkflowBoundaryReplayKey(boundaryName);
      const boundary = startWorkflowBoundaryStage(boundaryName, boundaryReplayKey);

      // Tracked so the finally can detach the parent-abort listener and release
      // the pre-registered child controller on every exit path — including the
      // maxDepth early return inside run(), which returns before run()'s own
      // cleanup. Without this, sequential ctx.workflow(...) calls accumulate one
      // parent-signal listener (and a leaked registry entry) per child.
      let childRunId: string | undefined;
      let detachParentAbort: (() => void) | undefined;
      try {
        if (boundary.replayedChild !== undefined) {
          // Continuation replay returns the persisted child boundary exactly as
          // written; input validation and output remapping are intentionally not
          // re-run against edited workflow code for a completed child boundary.
          // Defer settling by one microtask so concurrent replayed boundaries
          // spawned in the same turn see the same frontier as the source run.
          await Promise.resolve();
          throwIfWorkflowExitSelected();
          boundary.finalizeReplay();
          return boundary.replayedChild as WorkflowChildResult<TChildOutputs>;
        }

        const childInputs = resolveAndValidateInputs(
          child.inputs,
          options.inputs ?? {},
          `child workflow "${childName}" (${child.name})`,
        );
        throwIfWorkflowExitSelected();

        childRunId = crypto.randomUUID();
        const childController = new AbortController();
        const childRef: WorkflowChildRunRef = {
          alias: childName,
          workflow: child.normalizedName,
          runId: childRunId,
        };
        boundary.linkChildRun(childRef, childController);

        const abortChildFromParent = (): void => {
          const parentExit = findWorkflowExitSignal(ownController.signal.reason, exitScope);
          childController.abort(parentExit !== undefined
            ? makeParentWorkflowExitAbortReason(parentExit.reason)
            : ownController.signal.reason);
        };
        if (ownController.signal.aborted) {
          abortChildFromParent();
        } else {
          ownController.signal.addEventListener("abort", abortChildFromParent, { once: true });
          detachParentAbort = () =>
            ownController.signal.removeEventListener("abort", abortChildFromParent);
        }
        throwIfWorkflowExitSelected();
        // Pre-register the child controller under its own runId *before* run()
        // so a kill targeting the child runId works even before the nested run
        // would register itself. The nested run() sees opts.signal set and skips
        // its own cancellation.register (avoiding a double-register on the same
        // key) while still running its finally{} unregister(runId) cleanup, so
        // both branches must agree on this key.
        opts.cancellation?.register(childRunId, childController);
        throwIfWorkflowExitSelected();

        const {
          runId: _parentRunId,
          continuation: _parentContinuation,
          deferWorkflowStart: _parentDeferWorkflowStart,
          parentRun: _parentRun,
          onRunStart: _parentOnRunStart,
          onRunEnd: _parentOnRunEnd,
          ...childBaseOpts
        } = opts;
        const childRunPromise = run(child, childInputs, {
          ...childBaseOpts,
          runId: childRunId,
          cwd: resolveWorkflowCwd(),
          depth: depth + 1,
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
          parentRun: {
            runId,
            stageId: boundary.id,
            rootRunId: opts.parentRun?.rootRunId ?? runId,
          },
          signal: childController.signal,
          deferWorkflowStart: false,
        });
        boundary.observeChildRun(childRunPromise);
        const childRun = await childRunPromise;
        throwIfWorkflowExitSelected();

        if (!isWorkflowExitStatus(childRun.status)) {
          const failedChildStage = childRun.stages.find((stage) => stage.failureKind !== undefined);
          throw new Error(
            `atomic-workflows: child workflow "${childName}" (${child.name}) failed with status ${childRun.status}${childRun.error !== undefined ? `: ${childRun.error}` : ""}`,
            {
              cause: {
                ...(failedChildStage?.failureKind !== undefined ? { code: failedChildStage.failureKind } : {}),
                ...(failedChildStage?.failureMessage !== undefined ? { message: failedChildStage.failureMessage } : {}),
              },
            },
          );
        }

        const outputs = selectWorkflowOutputs(child, childRun.result);
        const childExited = childRun.exited === true || childRun.status !== "completed";
        const childResult: WorkflowChildResult<TChildOutputs> = childExited
          ? {
              workflow: child.normalizedName,
              runId: childRun.runId,
              status: childRun.status,
              exited: true,
              outputs: outputs as Partial<TChildOutputs>,
              ...(childRun.exitReason !== undefined ? { exitReason: childRun.exitReason } : {}),
            }
          : {
              workflow: child.normalizedName,
              runId: childRun.runId,
              status: "completed",
              exited: false,
              outputs: outputs as TChildOutputs,
            };
        const workflowChild = workflowChildReplaySnapshot(childName, childResult);
        const outputKeys = Object.keys(outputs);
        boundary.complete(
          `Workflow "${child.name}" ${childRun.status} (runId: ${childRun.runId}; outputs: ${outputKeys.length > 0 ? outputKeys.join(", ") : "(none)"})`,
          workflowChild,
        );
        return childResult;
      } catch (err) {
        const exit = findWorkflowExitSignal(err, exitScope) ?? findWorkflowExitSignal(ownController.signal.reason, exitScope);
        if (exit !== undefined) {
          await boundary.skipForWorkflowExit(exit.reason);
          throw exit;
        }
        boundary.fail(err);
        throw err;
      } finally {
        detachParentAbort?.();
        // Idempotent with run()'s own finally on the normal path; required on
        // the maxDepth early-return path where run() never reaches its cleanup.
        if (childRunId !== undefined) opts.cancellation?.unregister(childRunId);
      }
    },
  };

  // 6. Call def.run(ctx)
  try {
    if (opts.deferWorkflowStart === true) {
      await nextEventLoopTurn();
      if (ownController.signal.aborted) {
        const exit = findWorkflowExitSignal(ownController.signal.reason, exitScope);
        if (exit !== undefined) return await finalizeWorkflowExit(exit);
        const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
        if (parentExit !== undefined) return await finalizeParentWorkflowExitCancellation(parentExit);
        return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
      }
    }

    const rawResult = await def.run(ctx);

    // Post-body abort check: if signal was aborted at any point before we record
    // completion, classify a scoped author exit before falling back to killed.
    if (ownController.signal.aborted) {
      const exit = findWorkflowExitSignal(ownController.signal.reason, exitScope);
      if (exit !== undefined) return await finalizeWorkflowExit(exit);
      const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
      if (parentExit !== undefined) return await finalizeParentWorkflowExitCancellation(parentExit);
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const result = normalizeWorkflowRunOutput(def.name, rawResult);
    assertWorkflowRunOutputs(def.name, result, def.outputs);

    assertWorkflowCreatedStage(runSnapshot);

    const recorded = activeStore.recordRunEnd(runId, "completed", result);

    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "completed",
      result,
      ts: Date.now(),
    });

    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
      status: "completed",
      result,
    }, opts.onRunEnd);
  } catch (err) {
    const exit = findWorkflowExitSignal(err, exitScope) ?? findWorkflowExitSignal(ownController.signal.reason, exitScope);
    if (exit !== undefined) return await finalizeWorkflowExit(exit);

    if (ownController.signal.aborted) {
      const parentExit = parentWorkflowExitAbortReason(ownController.signal.reason);
      if (parentExit !== undefined) return await finalizeParentWorkflowExitCancellation(parentExit);
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const failure = classifyExecutorFailure(err);
    const metadata = selectRunFailureDisposition({
      outerFailure: failure,
      thrownError: err,
      stages: runSnapshot.stages,
      classifyFailure: classifyExecutorFailure,
    });

    if (metadata.failureDisposition === "terminal_killed") {
      for (const failedStageId of metadata.failedStageIds) {
        blockKnownNonTerminalDescendants(failedStageId);
      }
      return finalizeKilledByFailure(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd, {
        ...metadata,
        resumable: false,
      });
    }

    if (
      metadata.failureDisposition === "active_blocked" &&
      metadata.failedStageId !== undefined &&
      metadata.failureRecoverability === "recoverable"
    ) {
      for (const failedStageId of metadata.failedStageIds) {
        blockKnownNonTerminalDescendants(failedStageId);
      }
      return recordActiveBlockedFailure(runId, runSnapshot, activeStore, opts.persistence, {
        ...metadata,
        failureRecoverability: "recoverable",
        failedStageId: metadata.failedStageId,
        resumable: true,
      });
    }

    const recorded = activeStore.recordRunEnd(runId, "failed", undefined, metadata.errorMessage, metadata);

    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "failed",
      error: metadata.errorMessage,
      failureKind: metadata.failureKind,
      ...(metadata.failureCode !== undefined ? { failureCode: metadata.failureCode } : {}),
      ...(metadata.failureRecoverability !== undefined ? { failureRecoverability: metadata.failureRecoverability } : {}),
      ...(metadata.failureDisposition !== undefined ? { failureDisposition: metadata.failureDisposition } : {}),
      failureMessage: metadata.failureMessage,
      ...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
      resumable: metadata.resumable,
      ...(metadata.retryAfterMs !== undefined ? { retryAfterMs: metadata.retryAfterMs } : {}),
      ts: Date.now(),
    });

    return reconcileTerminalRunResult(runId, runSnapshot, activeStore, {
      status: "failed",
      error: metadata.errorMessage,
    }, opts.onRunEnd);
  } finally {
    opts.cancellation?.unregister(runId);
  }
}
