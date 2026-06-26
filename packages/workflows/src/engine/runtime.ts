import type { RunSnapshot } from "../shared/store-types.js";
import type { Store } from "../shared/store.js";
import type { StageOptions } from "../shared/types.js";
import type { ConcurrencyLimiter } from "../runs/shared/concurrency.js";
import type { ParallelFailFastScope } from "../runs/foreground/executor-types.js";
import type { WorkflowExitManager } from "../runs/foreground/executor-exit-manager.js";
import type { ContinuationReplayIndex } from "../runs/foreground/executor-continuation.js";
import type { StageScheduler } from "../runs/foreground/executor-scheduler.js";
import type { StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageAdapters } from "../runs/foreground/stage-runner.js";
import type { LiveStageRuntime, StageMcpScope, StageContextWithMeta } from "../runs/foreground/executor-stage-types.js";
import { createWorkflowStageFactory } from "../runs/foreground/executor-stage-factory.js";
import { createWorkflowBoundaryFactory, type WorkflowBoundaryStage } from "../runs/foreground/executor-child-boundary.js";
import type { GraphFrontierTracker } from "./graph-inference.js";
import type { EngineChildRunOptions, EngineStageRuntimeOptions, EngineWorkflowBoundaryOptions } from "./options.js";

export interface EngineRuntimeInput {
  readonly runId: string;
  readonly depth: number;
  readonly runSnapshot: RunSnapshot;
  readonly activeStore: Store;
  readonly stageOptions: EngineStageRuntimeOptions;
  readonly workflowBoundaryOptions: EngineWorkflowBoundaryOptions;
  readonly childRunOptions: EngineChildRunOptions;
  readonly parentRootRunId?: string;
  readonly adapters: StageAdapters;
  readonly signal: AbortSignal;
  readonly tracker: GraphFrontierTracker;
  readonly scheduler: StageScheduler;
  readonly replayIndex: ContinuationReplayIndex;
  readonly limiter: ConcurrencyLimiter;
  readonly inputRuntimeDefaults: Partial<StageOptions>;
  readonly workflowInvocationCwd: string;
  readonly stageRegistry: StageControlRegistry;
  readonly exit: WorkflowExitManager;
  readonly classifyExecutorFailure: LiveStageRuntime["classifyExecutorFailure"];
}

export interface EngineSpawnAgentStageOptions {
  readonly kind?: "agent";
  readonly options?: StageOptions;
  readonly failFastScope?: ParallelFailFastScope;
}

export interface EngineSpawnWorkflowBoundaryOptions {
  readonly kind: "workflow-boundary";
  readonly replayKey: string;
}

export type EngineSpawnStageOptions = EngineSpawnAgentStageOptions | EngineSpawnWorkflowBoundaryOptions;

export interface EngineAgentStageHandle {
  readonly kind: "agent";
  readonly context: StageContextWithMeta;
}

export interface EngineWorkflowBoundaryHandle {
  readonly kind: "workflow-boundary";
  readonly boundary: WorkflowBoundaryStage;
}

export type StageHandle = EngineAgentStageHandle | EngineWorkflowBoundaryHandle;

export class EngineRuntime {
  readonly runId: string;
  readonly depth: number;
  readonly activeStore: Store;
  readonly childRunOptions: EngineChildRunOptions;
  readonly parentRootRunId?: string;
  readonly adapters: StageAdapters;
  readonly signal: AbortSignal;
  readonly tracker: GraphFrontierTracker;
  readonly exit: WorkflowExitManager;
  readonly inputRuntimeDefaults: Partial<StageOptions>;
  readonly workflowInvocationCwd: string;

  private readonly spawnAgentStage: (
    name: string,
    options?: StageOptions,
    stageFailFastScope?: ParallelFailFastScope,
  ) => StageContextWithMeta;
  private readonly spawnWorkflowBoundary: (name: string, replayKey: string) => WorkflowBoundaryStage;

  constructor(input: EngineRuntimeInput) {
    this.runId = input.runId;
    this.depth = input.depth;
    this.activeStore = input.activeStore;
    this.childRunOptions = input.childRunOptions;
    this.parentRootRunId = input.parentRootRunId;
    this.adapters = input.adapters;
    this.signal = input.signal;
    this.tracker = input.tracker;
    this.exit = input.exit;
    this.inputRuntimeDefaults = input.inputRuntimeDefaults;
    this.workflowInvocationCwd = input.workflowInvocationCwd;

    // The runtime only wires host-injected ports; stage sessions are still
    // created lazily by the stage runner through input.adapters.agentSession.
    this.spawnAgentStage = createWorkflowStageFactory({
      runId: input.runId,
      activeStore: input.activeStore,
      opts: input.stageOptions,
      adapters: input.adapters,
      signal: input.signal,
      tracker: input.tracker,
      scheduler: input.scheduler,
      replayIndex: input.replayIndex,
      limiter: input.limiter,
      inputRuntimeDefaults: input.inputRuntimeDefaults,
      workflowInvocationCwd: input.workflowInvocationCwd,
      stageRegistry: input.stageRegistry,
      exit: input.exit,
      classifyExecutorFailure: input.classifyExecutorFailure,
      createMcpScope: (stageId, options) => this.createMcpScope(stageId, options),
    });
    this.spawnWorkflowBoundary = createWorkflowBoundaryFactory({
      runId: input.runId,
      runSnapshot: input.runSnapshot,
      activeStore: input.activeStore,
      opts: input.workflowBoundaryOptions,
      tracker: input.tracker,
      replayIndex: input.replayIndex,
      registerWorkflowExitCleanup: input.exit.registerWorkflowExitCleanup,
      workflowExitSkippedReason: input.exit.workflowExitSkippedReason,
      classifyExecutorFailure: input.classifyExecutorFailure,
    });
  }

  spawnStage(name: string, opts: EngineSpawnWorkflowBoundaryOptions): EngineWorkflowBoundaryHandle;
  spawnStage(name: string, opts?: EngineSpawnAgentStageOptions): EngineAgentStageHandle;
  spawnStage(name: string, opts: EngineSpawnStageOptions = {}): StageHandle {
    if (opts.kind === "workflow-boundary") {
      return { kind: "workflow-boundary", boundary: this.spawnWorkflowBoundary(name, opts.replayKey) };
    }
    return { kind: "agent", context: this.spawnAgentStage(name, opts.options, opts.failFastScope) };
  }

  readonly stage = (name: string, options?: StageOptions, failFastScope?: ParallelFailFastScope): StageContextWithMeta => {
    const handle = this.spawnStage(name, {
      kind: "agent",
      ...(options !== undefined ? { options } : {}),
      ...(failFastScope !== undefined ? { failFastScope } : {}),
    });
    return handle.context;
  };

  private createMcpScope(stageId: string, options: StageOptions | undefined): StageMcpScope {
    const allow = options?.mcp?.allow ?? null;
    const deny = options?.mcp?.deny ?? null;
    const hasScope = allow !== null || deny !== null;
    let depth = 0;
    return {
      apply: () => {
        if (!this.childRunOptions.mcp || !hasScope) return;
        if (depth === 0) this.childRunOptions.mcp.setScope(stageId, allow, deny);
        depth += 1;
      },
      clear: () => {
        if (!this.childRunOptions.mcp || !hasScope) return;
        if (depth === 0) return;
        depth -= 1;
        if (depth === 0) this.childRunOptions.mcp.clearScope(stageId);
      },
    };
  }
}
