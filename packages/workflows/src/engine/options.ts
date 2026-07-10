import type { RunOpts } from "../runs/foreground/executor-types.js";

export type EngineStageRuntimeOptions = Pick<
  RunOpts,
  | "continuation"
  | "models"
  | "executionMode"
  | "defaultSessionDir"
  | "persistence"
  | "usageRollup"
  | "onStageStart"
  | "onStageEnd"
  | "onStageSession"
  | "confirmStageReadiness"
  | "usePromptNodesForUi"
>;

export type EngineWorkflowBoundaryOptions = Pick<
  RunOpts,
  "persistence" | "onStageStart" | "onStageEnd"
>;

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
  | "usageRollup"
  | "cancellation"
  | "overlay"
  | "config"
  | "models"
  | "registry"
  | "stageControlRegistry"
  | "onStageStart"
  | "onStageEnd"
  | "onStageSession"
  | "durableBackend"
>;
