import type { RunOpts } from "../runs/foreground/executor-types.js";

export type EngineStageRuntimeOptions = Pick<
	RunOpts,
	| "continuation"
	| "models"
	| "executionMode"
	| "defaultSessionDir"
	| "persistence"
	| "onStageStart"
	| "onStageEnd"
	| "onStageSession"
	| "onStageSessionEvent"
	| "onStageLifecycleEvent"
	| "releaseWhenWaiting"
	| "confirmStageReadiness"
	| "usePromptNodesForUi"
>;

export type EngineWorkflowBoundaryOptions = Pick<RunOpts, "persistence" | "onStageStart" | "onStageEnd">;

export type EngineChildRunOptions = Pick<
	RunOpts,
	| "adapters"
	| "ui"
	| "executionMode"
	| "defaultSessionDir"
	| "usePromptNodesForUi"
	| "confirmStageReadiness"
	| "store"
	| "persistence"
	| "mcp"
	| "cancellation"
	| "overlay"
	| "config"
	| "snapshots"
	| "worktreeRootMappings"
	| "worktreeRestoreOutcomes"
	| "models"
	| "registry"
	| "stageControlRegistry"
	| "toolControlRegistry"
	| "stageUiBroker"
	| "toolAdmissionBoundary"
	| "onStageStart"
	| "onStageEnd"
	| "onStageSession"
	| "onStageSessionEvent"
	| "onStageLifecycleEvent"
	| "releaseWhenWaiting"
	| "durableBackend"
	| "durableRootBackend"
	| "rootBudget"
>;
