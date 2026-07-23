/**
 * Session-model inheritance for builtin implementation stages.
 *
 * Curated worker/orchestrator chains pin specific `provider/model:thinking`
 * ids, which silently shadow the model and thinking level the user configured
 * for their session. `resolveWorkerModels` puts the invoking session's current
 * model first — bare, without a reasoning suffix, so the stage runs at the
 * session's model and default thinking level — and demotes the curated primary
 * to the head of the fallback chain so outage survival is unchanged.
 *
 * When the session model is unknown (no catalog, detached execution), the
 * curated config is returned untouched.
 */
import type { WorkflowModelValue } from "../src/shared/types.js";

export type CuratedModelChainConfig = {
  readonly model: string;
  readonly fallbackModels: readonly string[];
};

export function resolveWorkerModels<T extends CuratedModelChainConfig>(
  curated: T,
  currentModel: WorkflowModelValue | undefined,
): T | (Omit<T, "model" | "fallbackModels"> & {
  readonly model: WorkflowModelValue;
  readonly fallbackModels: readonly string[];
}) {
  if (currentModel === undefined) return curated;
  return {
    ...curated,
    model: currentModel,
    fallbackModels: [curated.model, ...curated.fallbackModels],
  };
}
