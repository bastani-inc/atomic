/** Durable `ctx.ui` wrapper with collision-resistant prompt identities. */

import type {
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowUIContext,
} from "../shared/authoring-contract-ui.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import type { DurableUiCheckpoint, UiPromptKind } from "./types.js";

export interface DurableUiDeps {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextCheckpointId: () => string;
}

export function wrapUiWithDurable(base: WorkflowUIContext, deps: DurableUiDeps): WorkflowUIContext {
  const ordinals = new Map<string, number>();

  const nextIdentity = (kind: UiPromptKind, message: string, details?: WorkflowSerializableValue): { key: string; hash: string } => {
    const baseKey = durableHash({ kind, message, details: details ?? null });
    const ordinal = (ordinals.get(baseKey) ?? 0) + 1;
    ordinals.set(baseKey, ordinal);
    const identity = { kind, message, details: details ?? null, ordinal };
    return { key: JSON.stringify(identity), hash: durableHash(identity) };
  };

  const record = (kind: UiPromptKind, identity: { key: string; hash: string }, response: WorkflowSerializableValue): void => {
    const checkpoint: DurableUiCheckpoint = {
      kind: "ui",
      workflowId: deps.workflowId,
      checkpointId: `ui:${identity.hash}`,
      promptKind: kind,
      message: identity.key,
      promptHash: identity.hash,
      response,
      completedAt: Date.now(),
    };
    deps.backend.recordCheckpoint(checkpoint);
  };

  const cached = (identity: { readonly hash: string }): WorkflowSerializableValue | undefined => deps.backend.getUiResponse(deps.workflowId, identity.hash);

  return {
    async input(promptText: string): Promise<string> {
      const identity = nextIdentity("input", promptText);
      const hit = cached(identity);
      if (typeof hit === "string") return hit;
      const response = await base.input(promptText);
      record("input", identity, response);
      return response;
    },
    async confirm(message: string): Promise<boolean> {
      const identity = nextIdentity("confirm", message);
      const hit = cached(identity);
      if (typeof hit === "boolean") return hit;
      const response = await base.confirm(message);
      record("confirm", identity, response);
      return response;
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      const identity = nextIdentity("select", message, [...options]);
      const hit = cached(identity);
      if (typeof hit === "string") return hit as T;
      const response = await base.select<T>(message, options);
      record("select", identity, response);
      return response;
    },
    async editor(initial?: string): Promise<string> {
      const identity = nextIdentity("editor", initial ?? "", initial ?? null);
      const hit = cached(identity);
      if (typeof hit === "string") return hit;
      const response = await base.editor(initial);
      record("editor", identity, response);
      return response;
    },
    async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      const replayIdentity = options?.replayIdentity ?? factory?.name ?? "custom";
      const identity = nextIdentity("custom", replayIdentity, { replayIdentity });
      const hit = cached(identity);
      if (hit !== undefined) return hit as T;
      const response = await base.custom<T>(factory, options);
      record("custom", identity, response as WorkflowSerializableValue);
      return response;
    },
  };
}
