import type * as AuthoringContract from "../../shared/authoring-contract.js";
import type {
  WorkflowExecutionMode,
  WorkflowInputValues,
  WorkflowOutputValues,
  WorkflowRuntimeConfig,
  WorkflowUIAdapter,
  WorkflowPersistencePort,
  WorkflowMcpPort,
  WorkflowModelCatalogPort,
} from "../../shared/types.js";
import type { RunStatus, RunSnapshot, StageSnapshot, WorkflowOverlayAdapter } from "../../shared/store-types.js";
import type { Store } from "../../shared/store.js";
import type { WorkflowRegistry } from "../../workflows/registry.js";
import type { CancellationRegistry } from "../background/cancellation-registry.js";
import type { StageAdapters } from "./stage-runner.js";
import type { StageControlRegistry } from "./stage-control-registry.js";

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
  /** Host-resolved non-default session directory inherited by stages without explicit sessionDir. */
  defaultSessionDir?: string;
  /** Internal detached-run mode: surface ctx.ui.* as node-local workflow prompt stages. */
  usePromptNodesForUi?: boolean;
  /** Readiness-gate confirmation seam (#1099). */
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
  /** Yield to the next event-loop turn before invoking user workflow code. */
  deferWorkflowStart?: boolean;
  /** Resolved runtime configuration. */
  config?: WorkflowRuntimeConfig;
  /** Optional model catalog used for fallback validation/resolution. */
  models?: WorkflowModelCatalogPort;
  /** Registry metadata forwarded to workflow runs launched from discovery/tooling. */
  registry?: WorkflowRegistry;
  /** Current nesting depth of this workflow run. */
  depth?: number;
  /** Live stage-control registry. */
  stageControlRegistry?: StageControlRegistry;
  /** Pre-allocated runId. */
  runId?: string;
  /** Replay completed stages from a failed source run, then resume at this stage. */
  continuation?: RunContinuationOpts;
  /**
   * Durable workflow backend override (for testing). Defaults to the global
   * backend resolved by `getDurableBackend()`.
   *
   * cross-ref: issue #1498 — DBOS-backed cross-session resumability.
   */
  durableBackend?: import("../../durable/backend.js").DurableWorkflowBackend;
  /**
   * Durable scope for a child workflow run. When set, the child's internal
   * `ctx.tool`/`ctx.ui`/`ctx.stage` checkpoints are routed under the root
   * workflow id with a stable boundary prefix so an interrupted child does
   * not re-execute completed side effects on parent resume.
   *
   * cross-ref: issue #1498.
   */
  durableScope?: import("../../durable/scoped-backend.js").DurableScope;
  /** Internal parent linkage for nested ctx.workflow(...) runs. */
  parentRun?: {
    readonly runId: string;
    readonly stageId: string;
    readonly rootRunId: string;
  };
  onRunStart?: (snapshot: RunSnapshot) => void;
  onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  onStageEnd?: (runId: string, snapshot: StageSnapshot) => unknown;
  onRunEnd?: (runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string, exitReason?: string) => void;
}

export interface RunResult<TOutputs extends WorkflowOutputValues = WorkflowOutputValues> {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: Partial<TOutputs>;
  readonly error?: string;
  /** True when the run reached its terminal status through ctx.exit(). */
  readonly exited?: boolean;
  readonly exitReason?: string;
  readonly stages: StageSnapshot[];
}

export interface ParallelFailFastStage {
  readonly skip: () => Promise<void>;
}

export interface ParallelFailFastScope {
  failed: boolean;
  firstFailure?: unknown;
  readonly activeStages: Map<string, ParallelFailFastStage>;
  readonly parentIds?: readonly string[];
}

export interface WorkflowExitCleanup {
  skipForWorkflowExit(reason?: string): void | Promise<void>;
}
