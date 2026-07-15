import type { WorkflowModelValue } from "../shared/types.js";
import type { WorkflowModelCatalogPort } from "../shared/types.js";
import type { WorkflowToolArgs } from "./index.js";
import { validateWorkflowModels } from "../runs/shared/model-fallback.js";

export interface WorkflowModelRequest {
  readonly model?: WorkflowModelValue;
  readonly fallbackModels?: readonly string[];
  readonly fallbackThinkingLevels?: readonly string[];
}

export function namedWorkflowModelRequests(args: WorkflowToolArgs): readonly WorkflowModelRequest[] {
  if (args.model === undefined && (args.fallbackModels?.length ?? 0) === 0) return [];
  return [{
    model: args.model,
    fallbackModels: args.fallbackModels,
    fallbackThinkingLevels: args.fallbackThinkingLevels,
  }];
}

export function preflightWorkflowModelRequests(
  requests: readonly WorkflowModelRequest[],
  catalog: WorkflowModelCatalogPort | undefined,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  return validateWorkflowModels({ requests, catalog, signal });
}
