import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import type { IntercomClient } from "./broker/client.ts";
import type { IntercomConfig } from "./config.ts";
import { buildPresenceIdentity } from "./intercom-utils.js";
import type { InboundIdleQueue } from "./inbound-idle-queue.js";
import type { ReplyTracker } from "./reply-tracker.ts";

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
  replyTracker: ReplyTracker;
  pendingIdleMessages: InboundIdleQueue;
  clearInboundFlushTimer(): void;
  scheduleInboundFlush(delayMs?: number): void;
  syncPresenceStatus(): void;
  syncPresenceIdentity(sessionId: string): void;
  currentStatus(): string;
  restoreIntercomSessionIdEnv?(): void;
}

export function registerIntercomLifecycle(pi: ExtensionAPI, deps: LifecycleDeps): void {
  let hasActiveSession = false;

  async function cleanupRuntime(reason: string): Promise<void> {
    deps.setRuntimeStarted(false);
    deps.setShuttingDown(true);
    deps.setDisposed(true);
    deps.incrementRuntimeGeneration();
    deps.clearReconnectTimer();
    deps.rejectReplyWaiter(new Error(reason));
    deps.replyTracker.reset();
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
        console.error(`Intercom failed to disconnect during ${reason.toLowerCase()}; continuing cleanup:`, error);
      }
    }
    deps.restoreIntercomSessionIdEnv?.();
    deps.setRuntimeContext(null);
    deps.setCurrentSessionId(null);
    deps.setSessionStartedAt(null);
  }

  pi.on("session_start", async (_event, ctx) => {
    if (!deps.config.enabled) return;
    if (hasActiveSession) await cleanupRuntime("Session replaced");
    hasActiveSession = true;
    deps.setShuttingDown(false);
    deps.setDisposed(false);
    deps.setRuntimeStarted(true);
    deps.incrementRuntimeGeneration();
    deps.resetReconnectAttempt();
    deps.clearReconnectTimer();
    deps.setRuntimeContext(ctx);
    deps.setCurrentSessionId(ctx.sessionManager.getSessionId());
    deps.setCurrentModel(ctx.model?.id ?? "unknown");
    deps.setSessionStartedAt(Date.now());
    deps.setAgentRunning(false);
    deps.activeTools.clear();
  });

  pi.on("session_shutdown", async () => {
    if (!hasActiveSession) return;
    hasActiveSession = false;
    await cleanupRuntime("Session shutting down");
  });

  pi.on("turn_end", () => {
    if (!deps.getLiveContext()) return;
    deps.replyTracker.endTurn();
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
    deps.setCurrentSessionId(ctx.sessionManager.getSessionId());
    deps.syncPresenceIdentity(ctx.sessionManager.getSessionId());
    deps.replyTracker.beginTurn();
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
