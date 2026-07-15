/** Durable `ctx.ui` wrapper with collision-resistant prompt identities. */

import type {
  WorkflowCustomUiFactory,
  WorkflowCustomUiOptions,
  WorkflowUIContext,
} from "../shared/authoring-contract-ui.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import { withPromptCallerStack } from "../shared/prompt-callsite-context.js";
import { selectPromptCallsiteFrame } from "../runs/shared/prompt-callsite.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import type { DurableUiCheckpoint, UiPromptKind } from "./types.js";
import { recordCheckpointDurably } from "./tool-primitive.js";
import { claimDurablePromptToken, durablePromptScope, releaseDurablePrompt, reserveDurablePrompt, type PromptReservationToken } from "./prompt-reservations.js";

export interface DurableUiDeps {
  readonly workflowId: string;
  readonly backend: DurableWorkflowBackend;
  readonly nextCheckpointId: () => string;
}

export function wrapUiWithDurable(base: WorkflowUIContext, deps: DurableUiDeps): WorkflowUIContext {
  const ordinals = new Map<string, number>();

  const scope = durablePromptScope(deps.backend, deps.workflowId);
  const nextIdentity = (
    kind: UiPromptKind,
    message: string,
    callerStack: string | undefined,
    details?: WorkflowSerializableValue,
  ): { key: string; hash: string } => {
    const authorCallsite = selectPromptCallsiteFrame(callerStack ?? "") ?? "unknown";
    const descriptor = { kind, message, details: details ?? null };
    const baseIdentity = {
      rootWorkflowId: scope.rootWorkflowId,
      scope: scope.scope,
      authorCallsite: durableHash({ authorCallsite }),
      descriptor,
    };
    const baseKey = durableHash(baseIdentity);
    const ordinal = (ordinals.get(baseKey) ?? 0) + 1;
    ordinals.set(baseKey, ordinal);
    const identity = ordinal === 1 ? baseIdentity : { ...baseIdentity, ordinal };
    return { key: JSON.stringify(identity), hash: durableHash(identity) };
  };

  const record = async (kind: UiPromptKind, identity: { key: string; hash: string }, response: WorkflowSerializableValue): Promise<void> => {
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
    await recordCheckpointDurably(deps.backend, checkpoint);
  };

  const cached = (identity: { readonly hash: string }): WorkflowSerializableValue | undefined => deps.backend.getUiResponse(deps.workflowId, identity.hash);

  const cachedCustom = (identity: { readonly hash: string }): { readonly found: boolean; readonly response?: WorkflowSerializableValue } => {
    const hit = deps.backend.listCheckpoints(deps.workflowId)
      .find((checkpoint) => checkpoint.kind === "ui"
        && (checkpoint.promptHash === identity.hash || checkpoint.promptHash.endsWith(`:${identity.hash}`)));
    return hit?.kind === "ui" ? { found: true, response: hit.response } : { found: false };
  };

  const releasePending = async (identity: { readonly hash: string }, token: PromptReservationToken): Promise<void> => {
    releaseDurablePrompt(deps.backend, deps.workflowId, identity.hash, token);
    await deps.backend.flush?.();
  };
  const beginPending = (identity: { readonly hash: string }): {
    readonly token: PromptReservationToken;
    readonly write?: Promise<void>;
  } => {
    const token = reserveDurablePrompt(deps.backend, deps.workflowId, identity.hash);
    const write = deps.backend.flush?.();
    return { token, ...(write !== undefined ? { write } : {}) };
  };
  const waitForPendingWrite = async (
    identity: { readonly hash: string },
    pending: { readonly token: PromptReservationToken; readonly write?: Promise<void> },
  ): Promise<void> => {
    if (pending.write === undefined) return;
    try {
      await pending.write;
    } catch (error) {
      releaseDurablePrompt(deps.backend, deps.workflowId, identity.hash, pending.token);
      try { await deps.backend.flush?.(); } catch { /* Preserve the opening-write failure. */ }
      throw error;
    }
  };
  const releaseCached = async (identity: { readonly hash: string }): Promise<void> => {
    const token = claimDurablePromptToken(deps.backend, deps.workflowId, identity.hash);
    if (token !== undefined) await releasePending(identity, token);
  };

  return {
    async input(promptText: string): Promise<string> {
      const callerStack = new Error().stack;
      const identity = nextIdentity("input", promptText, callerStack);
      const hit = cached(identity);
      if (typeof hit === "string") {
        await releaseCached(identity);
        return hit;
      }
      const pending = beginPending(identity);
      await waitForPendingWrite(identity, pending);
      try {
        const response = await withPromptCallerStack(callerStack, () => base.input(promptText));
        await record("input", identity, response);
        return response;
      } finally { await releasePending(identity, pending.token); }
    },
    async confirm(message: string): Promise<boolean> {
      const callerStack = new Error().stack;
      const identity = nextIdentity("confirm", message, callerStack);
      const hit = cached(identity);
      if (typeof hit === "boolean") {
        await releaseCached(identity);
        return hit;
      }
      const pending = beginPending(identity);
      await waitForPendingWrite(identity, pending);
      try {
        const response = await withPromptCallerStack(callerStack, () => base.confirm(message));
        await record("confirm", identity, response);
        return response;
      } finally { await releasePending(identity, pending.token); }
    },
    async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
      const callerStack = new Error().stack;
      const identity = nextIdentity("select", message, callerStack, [...options]);
      const hit = cached(identity);
      if (typeof hit === "string") {
        await releaseCached(identity);
        return hit as T;
      }
      const pending = beginPending(identity);
      await waitForPendingWrite(identity, pending);
      try {
        const response = await withPromptCallerStack(callerStack, () => base.select<T>(message, options));
        await record("select", identity, response);
        return response;
      } finally { await releasePending(identity, pending.token); }
    },
    async editor(initial?: string): Promise<string> {
      const callerStack = new Error().stack;
      const identity = nextIdentity("editor", initial ?? "", callerStack, initial ?? null);
      const hit = cached(identity);
      if (typeof hit === "string") {
        await releaseCached(identity);
        return hit;
      }
      const pending = beginPending(identity);
      await waitForPendingWrite(identity, pending);
      try {
        const response = await withPromptCallerStack(callerStack, () => base.editor(initial));
        await record("editor", identity, response);
        return response;
      } finally { await releasePending(identity, pending.token); }
    },
    async custom<T>(factory: WorkflowCustomUiFactory<T>, options?: WorkflowCustomUiOptions): Promise<T> {
      const callerStack = new Error().stack;
      const replayIdentity = options?.replayIdentity ?? factory?.name ?? "custom";
      const identity = nextIdentity("custom", replayIdentity, callerStack, { replayIdentity });
      const hit = cachedCustom(identity);
      if (hit.found) {
        await releaseCached(identity);
        return hit.response as T;
      }
      const pending = beginPending(identity);
      await waitForPendingWrite(identity, pending);
      try {
        const response = await withPromptCallerStack(callerStack, () => base.custom<T>(factory, options));
        await record("custom", identity, response as WorkflowSerializableValue);
        return response;
      } finally { await releasePending(identity, pending.token); }
    },
  };
}
