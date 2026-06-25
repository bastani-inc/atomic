/**
 * Durable `ctx.ui` wrapper.
 *
 * Wraps a base {@link WorkflowUIContext} so completed user responses are cached
 * durably via the {@link DurableWorkflowBackend}. On cross-session resume, a
 * `ctx.ui.*` call whose prompt already has a cached response returns the cached
 * answer without re-asking the user — mirroring the DBOS "completed side effects
 * are not repeated" semantics for human-in-the-loop prompts.
 *
 * Only the prompt identity (message + options) participates in the replay hash;
 * the raw answer text is stored as a checkpoint output, exactly like `ctx.tool`.
 *
 * cross-ref: issue #1498 — "ctx.ui response/pending prompt state."
 */

import type {
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowUIContext,
} from "../shared/authoring-contract-ui.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import type { DurableUiCheckpoint, UiPromptKind } from "./types.js";

/**
 * Dependencies required to durably cache `ctx.ui` responses.
 */
export interface DurableUiDeps {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  /** Monotonic checkpoint id counter source. */
  readonly nextCheckpointId: () => string;
}

/**
 * Wrap a base UI context so completed responses are cached durably.
 *
 * The wrapper is transparent when the backend has no cached response: it
 * delegates to `base` and records the result on completion. When a cached
 * response exists for the prompt identity, it is returned directly without
 * invoking `base`, so resumed workflows do not re-ask answered prompts.
 */
export function wrapUiWithDurable(base: WorkflowUIContext, deps: DurableUiDeps): WorkflowUIContext {
  const record = (kind: UiPromptKind, message: string, response: WorkflowSerializableValue): void => {
    const promptHash = durableHash({ kind, message });
    const checkpoint: DurableUiCheckpoint = {
      kind: "ui",
      workflowId: deps.workflowId,
      checkpointId: deps.nextCheckpointId(),
      promptKind: kind,
      message,
      promptHash,
      response,
      completedAt: Date.now(),
    };
    deps.backend.recordCheckpoint(checkpoint);
  };

  const cached = (kind: UiPromptKind, message: string): WorkflowSerializableValue | undefined => {
    const promptHash = durableHash({ kind, message });
    return deps.backend.getUiResponse(deps.workflowId, promptHash);
  };

  return {
    async input(promptText: string): Promise<string> {
      const hit = cached("input", promptText);
      if (typeof hit === "string") return hit;
      const response = await base.input(promptText);
      record("input", promptText, response);
      return response;
    },
    async confirm(message: string): Promise<boolean> {
      const hit = cached("confirm", message);
      if (typeof hit === "boolean") return hit;
      const response = await base.confirm(message);
      record("confirm", message, response);
      return response;
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      const hit = cached("select", message);
      if (typeof hit === "string") return hit as T;
      const response = await base.select<T>(message, options);
      record("select", message, response);
      return response;
    },
    async editor(initial?: string): Promise<string> {
      const key = initial ?? "";
      const hit = cached("editor", key);
      if (typeof hit === "string") return hit;
      const response = await base.editor(initial);
      record("editor", key, response);
      return response;
    },
    async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      // Custom prompts carry an optional replayIdentity; fall back to the
      // factory name so the same custom prompt replays deterministically.
      const identity = options?.replayIdentity ?? factory?.name ?? "custom";
      const hit = cached("custom", identity);
      if (hit !== undefined) return hit as T;
      const response = await base.custom<T>(factory, options);
      record("custom", identity, response as unknown as WorkflowSerializableValue);
      return response;
    },
  };
}
