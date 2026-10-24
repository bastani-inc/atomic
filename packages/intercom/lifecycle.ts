import { reportOwnedIntercomDiagnostic } from "./diagnostics.js";
import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { IntercomClient } from "./broker/client.js";
import type { IntercomConfig } from "./config.js";
import { buildPresenceIdentity } from "./intercom-utils.js";
import type { InboundIdleQueue } from "./inbound-idle-queue.js";
import type { ReplyTracker } from "./reply-tracker.js";

interface LifecycleDeps {
  config: IntercomConfig;
  client(): IntercomClient | null;
  setClient(client: IntercomClient | null): void;
  setShuttingDown(value: boolean): void;
  setDisposed(value: boolean): void;
  setRuntimeStarted(value: boolean): void;
  incrementRuntimeGeneration(): number;
  resetReconnectAttempt(): void;
  clearReconnectTimer(): void;
  setRuntimeContext(ctx: ExtensionContext | null): void;
  setCurrentSessionId(id: string | null): void;
  setCurrentModel(model: string): void;
  setSessionStartedAt(value: number | null): void;
  setAgentRunning(value: boolean): void;
  activeTools: Map<string, string>;
  getLiveContext(ctx?: ExtensionContext | null, generation?: number): ExtensionContext | null;
  rejectReplyWaiter(error: Error): void;
  replyTracker: ReplyTracker | (() => ReplyTracker);
  bindReplyTracker?(ctx: ExtensionContext): void;
  preserveReplyTrackerOnCleanup?(): boolean;
  pendingIdleMessages: InboundIdleQueue;
  clearInboundFlushTimer(): void;
  scheduleInboundFlush(delayMs?: number): void;
  syncPresenceStatus(): void;
  syncPresenceIdentity(sessionId: string): void;
  currentStatus(): string;
  restoreIntercomSessionIdEnv?(): void;
  disconnectAuxiliaryClients?(): Promise<void>;
}

export function registerIntercomLifecycle(pi: ExtensionAPI, deps: LifecycleDeps): void {
  const activeReplyTracker = (): ReplyTracker =>
    typeof deps.replyTracker === "function" ? deps.replyTracker() : deps.replyTracker;
  let hasActiveSession = false;
  let unbindStageClose: (() => void) | undefined;

  async function cleanupRuntime(reason: string): Promise<void> {
    unbindStageClose?.();
    unbindStageClose = undefined;
    deps.setRuntimeStarted(false);
    deps.setShuttingDown(true);
    deps.setDisposed(true);
    deps.incrementRuntimeGeneration();
    deps.clearReconnectTimer();
    deps.rejectReplyWaiter(new Error(reason));
    if (deps.preserveReplyTrackerOnCleanup?.() !== true) activeReplyTracker().reset();
    deps.pendingIdleMessages.clear();
    deps.clearInboundFlushTimer();
    deps.setAgentRunning(false);
    deps.activeTools.clear();
    const activeClient = deps.client();
    deps.setClient(null);
    if (activeClient) {
      try {
        await activeClient.disconnect();
      } catch (error) {
        if (!reportOwnedIntercomDiagnostic()) console.error(`Intercom failed to disconnect during ${reason.toLowerCase()}; continuing cleanup:`, error);
      }
    }
    if (deps.disconnectAuxiliaryClients) {
      try {
        await deps.disconnectAuxiliaryClients();
      } catch (error) {
        if (!reportOwnedIntercomDiagnostic()) console.error(`Intercom failed to disconnect auxiliary clients during ${reason.toLowerCase()}; continuing cleanup:`, error);
      }
    }
    deps.restoreIntercomSessionIdEnv?.();
    deps.setRuntimeContext(null);
    deps.setCurrentSessionId(null);
    deps.setSessionStartedAt(null);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (hasActiveSession) await cleanupRuntime("Session replaced");
    hasActiveSession = true;
    deps.setShuttingDown(false);
    deps.setDisposed(false);
    deps.setRuntimeStarted(true);
    deps.incrementRuntimeGeneration();
    deps.resetReconnectAttempt();
    deps.clearReconnectTimer();
    deps.setRuntimeContext(ctx);
    deps.bindReplyTracker?.(ctx);
    deps.setCurrentSessionId(ctx.sessionManager.getSessionId());
    deps.setCurrentModel(ctx.model?.id ?? "unknown");
    deps.setSessionStartedAt(Date.now());
    deps.setAgentRunning(false);
    deps.activeTools.clear();
    const stage = ctx.orchestrationContext;
    const closeSignal = stage?.kind === "workflow-stage" ? stage.messageAdmission?.boundary?.closeSignal : undefined;
    closeSignal?.addEventListener("abort", deps.syncPresenceStatus, { once: true });
    unbindStageClose = () => closeSignal?.removeEventListener("abort", deps.syncPresenceStatus);
    if (closeSignal?.aborted) deps.syncPresenceStatus();
  });

  pi.on("session_shutdown", async () => {
    if (!hasActiveSession) return;
    hasActiveSession = false;
    await cleanupRuntime("Session shutting down");
  });

  pi.on("turn_end", (event) => {
    if (!deps.getLiveContext()) return;
    const message = (event as { message?: { role?: string; stopReason?: string; content?: unknown[] } }).message;
    const cancelledBeforeReply = message?.role === "assistant" && message.stopReason === "aborted" && message.content?.length === 0;
    if (cancelledBeforeReply) activeReplyTracker().restoreTurnContext();
    else activeReplyTracker().endTurn();
    // Preserve the normal grace period so a same-tick terminal barrier can
    // claim accepted child messages before idle delivery releases ownership.
    deps.scheduleInboundFlush();
  });
  pi.on("agent_start", () => {
    if (!deps.getLiveContext()) return;
    deps.setAgentRunning(true);
    deps.activeTools.clear();
    deps.syncPresenceStatus();
  });
  pi.on("tool_execution_start", (event) => {
    if (!deps.getLiveContext()) return;
    deps.activeTools.set(event.toolCallId, event.toolName);
    deps.syncPresenceStatus();
  });
  pi.on("tool_execution_end", (event) => {
    if (!deps.getLiveContext()) return;
    deps.activeTools.delete(event.toolCallId);
    deps.syncPresenceStatus();
  });
  pi.on("agent_end", () => {
    if (!deps.getLiveContext()) return;
    deps.setAgentRunning(false);
    deps.activeTools.clear();
    deps.syncPresenceStatus();
    deps.scheduleInboundFlush();
  });
  pi.on("turn_start", (_event, ctx) => {
    if (!deps.getLiveContext(ctx)) return;
    deps.bindReplyTracker?.(ctx);
    deps.setCurrentSessionId(ctx.sessionManager.getSessionId());
    deps.syncPresenceIdentity(ctx.sessionManager.getSessionId());
    activeReplyTracker().beginTurn();
  });
  // Bind the reply target when an inbound message enters the model's context, not when it
  // arrived: steer, followUp, and interrupt deliveries reach turns out of arrival order (#3921).
  // While the agent streams, the host shows the intercom card at admission and feeds the model
  // a hidden reconciliation that points back at that card's entry.
  pi.on("message_start", (event, ctx) => {
    if (!deps.getLiveContext(ctx)) return;
    const id = admittedIntercomMessageId(event.message, ctx);
    if (id !== undefined) activeReplyTracker().admitTurnMessage(id);
  });
  pi.on("model_select", (event, ctx) => {
    if (!deps.getLiveContext(ctx)) return;
    deps.setCurrentModel(event.model.id);
    const activeClient = deps.client();
    if (activeClient) {
      activeClient.updatePresence({
        ...buildPresenceIdentity(pi, ctx.sessionManager.getSessionId()),
        model: event.model.id,
        status: deps.currentStatus(),
      });
    }
  });
}

const PROTECTED_RECONCILIATION_CUSTOM_TYPE = "atomic:protected-streaming-reconciliation";

function intercomMessageId(customType: unknown, details: unknown): string | undefined {
  if (customType !== "intercom_message" || details === null || typeof details !== "object") return undefined;
  const id = (details as { message?: { id?: unknown } }).message?.id;
  return typeof id === "string" ? id : undefined;
}

/** The intercom message a model-context message admits: the message itself, or the card a protected reconciliation points at. */
export function admittedIntercomMessageId(message: unknown, ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  const custom = message as { role?: unknown; customType?: unknown; details?: { protectedReconciliationOf?: unknown } };
  if (custom?.role !== "custom") return undefined;
  if (custom.customType !== PROTECTED_RECONCILIATION_CUSTOM_TYPE) return intercomMessageId(custom.customType, custom.details);
  const intentEntryId = custom.details?.protectedReconciliationOf;
  if (typeof intentEntryId !== "string") return undefined;
  const intent = ctx.sessionManager.getEntries().find((entry) => entry.id === intentEntryId);
  return intent?.type === "custom_message" ? intercomMessageId(intent.customType, intent.details) : undefined;
}
