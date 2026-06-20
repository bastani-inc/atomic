/**
 * Stage runner — creates an AgentSession-like StageContext for a workflow stage.
 *
 * The public stage surface mirrors the supported subset of pi's SDK
 * AgentSession. The executor wraps prompt() for lifecycle tracking and owns
 * disposal; workflow authors get direct SDK session methods without a custom
 * prompt abstraction.
 */

export { createStageContext } from "./stage-runner-context.js";
export type {
  AgentSessionAdapter,
  CompleteAdapter,
  InternalStageContext,
  PromptAdapter,
  StageAdapters,
  StageModelFallbackMeta,
  StageRunnerOpts,
  StageSessionCreateOptions,
  StageSessionCreateResult,
  StageSessionRuntime,
} from "./stage-runner-types.js";
