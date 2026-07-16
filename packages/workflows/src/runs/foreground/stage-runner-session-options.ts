import {
  getModelDefaultContextWindow,
  getSupportedContextWindows,
  SessionManager,
  type CreateAgentSessionOptions,
} from "@bastani/atomic";
import type { StageOptions } from "../../shared/types.js";
import type { WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";

interface StageSessionOptionsInput {
  readonly effectiveStageOptions: StageOptions | undefined;
  readonly candidate: WorkflowResolvedModelCandidate | undefined;
  readonly restoreSavedModel?: boolean;
  readonly reattachSessionFile: string | undefined;
  readonly sharedModelRegistry: CreateAgentSessionOptions["modelRegistry"];
}

export function buildStageSessionOptions(input: StageSessionOptionsInput): StageOptions | undefined {
  const options: StageOptions = input.candidate === undefined
    ? { ...(input.effectiveStageOptions ?? {}) }
    : {
        ...(input.effectiveStageOptions ?? {}),
        model: input.candidate.value,
        ...(input.candidate.reasoningLevel !== undefined ? { thinkingLevel: input.candidate.reasoningLevel } : {}),
        ...(input.candidate.contextWindow !== undefined ? { contextWindow: input.candidate.contextWindow } : {}),
        fallbackModels: undefined,
        fallbackThinkingLevels: undefined,
      };
  if (input.restoreSavedModel === true) delete options.model;

  if (
    input.restoreSavedModel !== true &&
    input.reattachSessionFile === undefined &&
    options.contextWindow === undefined &&
    input.candidate !== undefined &&
    typeof input.candidate.value !== "string" &&
    getSupportedContextWindows(input.candidate.value).length > 1
  ) {
    options.contextWindow = getModelDefaultContextWindow(input.candidate.value);
  }
  if (input.reattachSessionFile !== undefined && options.sessionManager === undefined) {
    const cwd = options.cwd ?? process.cwd();
    options.sessionManager = SessionManager.open(input.reattachSessionFile, options.sessionDir, cwd);
    options.context = undefined;
    options.forkFromSessionFile = undefined;
  }
  if (input.sharedModelRegistry !== undefined && options.modelRegistry === undefined) {
    options.modelRegistry = input.sharedModelRegistry;
  }
  return Object.keys(options).length === 0 ? undefined : options;
}
