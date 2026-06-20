import type { ExtensionAPI, ExtensionContext } from "@bastani/atomic";
import { appendFileSync } from "node:fs";
import { IntercomClient } from "./broker/client.ts";
import { spawnBrokerIfNeeded } from "./broker/spawn.ts";
import { InlineMessageComponent } from "./ui/inline-message.ts";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type { SessionInfo, Message } from "./types.ts";
import { ReplyTracker } from "./reply-tracker.ts";
import { registerContactSupervisorTool } from "./contact-supervisor-tool.js";
import { registerIntercomTool } from "./intercom-tool.js";
import { registerIntercomOverlay } from "./overlay.js";
import { registerIntercomLifecycle } from "./lifecycle.js";
import { registerSubagentRelay } from "./subagent-relay.js";
import {
  INBOUND_FLUSH_DELAY_MS,
  INBOUND_IDLE_RETRY_MS,
  type InboundMessageEntry,
  buildPresenceIdentity,
  formatAttachments,
  readChildOrchestratorMetadata,
  toError,
} from "./intercom-utils.js";

if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL === "1") {
  process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED = "1";
}

if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE) {
  appendFileSync(process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE, "intercom\n");
}

export default function piIntercomExtension(pi: ExtensionAPI) {
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let startupConnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const activeTools = new Map<string, string>();
  const replyTracker = new ReplyTracker();
  const pendingIdleMessages: InboundMessageEntry[] = [];
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  let replyWaiter: {
    from: string;
    replyTo: string;
    resolve: (message: Message) => void;
    reject: (error: Error) => void;
  } | null = null;
  function waitForReply(from: string, replyTo: string, signal?: AbortSignal): Promise<Message> {
    if (replyWaiter) {
      return Promise.reject(new Error("Already waiting for a reply"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("Cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectReplyWaiter(new Error(`No reply from "${from}" within 10 minutes`));
      }, 10 * 60 * 1000);
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        if (replyWaiter?.replyTo === replyTo) {
          replyWaiter = null;
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      replyWaiter = {
        from,
        replyTo,
        resolve: (message) => {
          cleanup();
          resolve(message);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      };
    });
  }
  function rejectReplyWaiter(error: Error): void {
    replyWaiter?.reject(error);
  }
  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  function clearStartupConnectTimer(): void {
    if (!startupConnectTimer) {
      return;
    }
    clearTimeout(startupConnectTimer);
    startupConnectTimer = null;
  }
  function clearInboundFlushTimer(): void {
    if (!inboundFlushTimer) {
      return;
    }
    clearTimeout(inboundFlushTimer);
    inboundFlushTimer = null;
  }
  function getLiveContext(ctx: ExtensionContext | null = runtimeContext, generation = runtimeGeneration): ExtensionContext | null {
    if (disposed || shuttingDown || generation !== runtimeGeneration || !ctx) {
      return null;
    }
    try {
      if (currentSessionId && ctx.sessionManager.getSessionId() !== currentSessionId) {
        return null;
      }
      void ctx.hasUI;
      return ctx;
    } catch {
      // A context that throws while reading session/UI state is no longer usable.
      return null;
    }
  }
  function notifyIfLive(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error", generation = runtimeGeneration): void {
    const liveContext = getLiveContext(ctx, generation);
    if (!liveContext?.hasUI) {
      return;
    }
    try {
      liveContext.ui.notify(message, level);
    } catch {
      // The UI can disappear during session shutdown/reload while async overlay work is settling.
    }
  }
  function getReconnectDelayMs(): number {
    const backoffMs = [1000, 2000, 5000, 10000, 30000];
    return backoffMs[Math.min(reconnectAttempt, backoffMs.length - 1)]!;
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  function buildRegistration(): Omit<SessionInfo, "id"> {
    const liveContext = getLiveContext();
    if (!liveContext || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }

    const identity = buildPresenceIdentity(pi, currentSessionId);
    return {
      name: identity.name,
      cwd: liveContext.cwd ?? process.cwd(),
      model: currentModel,
      pid: process.pid,
      startedAt: sessionStartedAt,
      lastActivity: Date.now(),
      status: currentStatus(),
    };
  }
  function syncPresenceIdentity(sessionId: string): void {
    if (!client || !getLiveContext()) {
      return;
    }
    client.updatePresence({ ...buildPresenceIdentity(pi, sessionId), status: currentStatus() });
  }
  function syncPresenceStatus(): void {
    if (!client || !currentSessionId || !getLiveContext()) {
      return;
    }
    client.updatePresence({ status: currentStatus() });
  }
  function currentSessionTargetMatches(to: string, resolvedTo?: string | null, activeClient?: IntercomClient): boolean {
    const targets = new Set<string>();
    const addTarget = (target: string | undefined | null) => {
      const trimmed = target?.trim();
      if (trimmed) targets.add(trimmed.toLowerCase());
    };
    addTarget(currentSessionId);
    addTarget(activeClient?.sessionId);
    addTarget(pi.getSessionName());
    if (currentSessionId) addTarget(buildPresenceIdentity(pi, currentSessionId).name);
    return Boolean(resolvedTo && activeClient?.sessionId && resolvedTo === activeClient.sessionId)
      || targets.has(to.trim().toLowerCase());
  }
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "followUp", generation = runtimeGeneration): void {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return;
    }
    if (delivery !== "followUp") {
      replyTracker.queueTurnContext({ from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    pi.sendMessage(
      {
        customType: "intercom_message",
        content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
        display: true,
        details: entry,
      },
      delivery === "trigger"
        ? { triggerTurn: true }
        : { deliverAs: "followUp" }
    );
  }
  function scheduleInboundFlush(delayMs = INBOUND_FLUSH_DELAY_MS): void {
    if (!getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    clearInboundFlushTimer();
    inboundFlushTimer = setTimeout(() => {
      inboundFlushTimer = null;
      flushIdleMessages(scheduledGeneration);
    }, delayMs);
  }
  function flushIdleMessages(generation = runtimeGeneration): void {
    if (pendingIdleMessages.length === 0) {
      return;
    }
    const ctx = getLiveContext(runtimeContext, generation);
    if (!ctx) {
      return;
    }

    let isIdle: boolean;
    try {
      isIdle = ctx.isIdle();
    } catch {
      // Stale contexts are cleaned up by shutdown/reload; do not deliver queued messages through them.
      return;
    }
    if (!isIdle) {
      scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
      return;
    }

    const entries = pendingIdleMessages.splice(0, pendingIdleMessages.length);
    entries.forEach((entry, index) => {
      sendIncomingMessage(entry, index === 0 ? "trigger" : "followUp");
    });
  }
  function queueIdleMessage(entry: InboundMessageEntry): void {
    pendingIdleMessages.push(entry);
    scheduleInboundFlush();
  }
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }
    if (replyWaiter) {
      const senderTarget = from.name || from.id;
      const fromMatches = senderTarget.toLowerCase() === replyWaiter.from.toLowerCase()
        || from.id === replyWaiter.from;
      const replyMatches = message.replyTo === replyWaiter.replyTo;
      if (fromMatches && replyMatches) {
        replyWaiter.resolve(message);
        return;
      }
    }
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    replyTracker.recordIncomingMessage(from, message);
    const entry = { from, message, replyCommand, bodyText };
    void (async () => {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        return;
      }
      if (!activeContext.isIdle()) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const result = await activeClient.send(from.id, {
                text: "This agent is running in non-interactive mode and cannot respond to intercom messages while it is working. It will continue its current task and exit when done.",
                replyTo: message.id,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          return;
        }
        queueIdleMessage(entry);
        return;
      }
      if (getLiveContext(liveContext, messageGeneration)) {
        sendIncomingMessage(entry, "trigger", messageGeneration);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from, message) => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (!shuttingDown && !disposed) {
        clearReconnectTimer();
        scheduleReconnect();
      }
    });
    nextClient.on("error", () => {
      // Keep broker/socket noise out of the TUI. Reconnect logic runs from the disconnect path.
    });
  }
  function scheduleReconnect(): void {
    if (disposed || shuttingDown || reconnectTimer || reconnectPromise || !getLiveContext()) {
      return;
    }
    const scheduledGeneration = runtimeGeneration;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (scheduledGeneration !== runtimeGeneration || !getLiveContext()) {
        return;
      }
      reconnectAttempt += 1;
      void ensureConnected("background").catch(() => {
        // ensureConnected("background") already queued the next retry.
      });
    }, getReconnectDelayMs());
  }
  async function ensureConnected(reason: "startup" | "background" | "tool" | "overlay"): Promise<IntercomClient> {
    if (!config.enabled) {
      throw new Error("Intercom disabled");
    }
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    const nextReconnectPromise = (async () => {
      const nextClient = new IntercomClient();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        await nextClient.connect(buildRegistration());
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        reconnectAttempt = 0;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
        }
        if (reason === "background" && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
        throw toError(error);
      } finally {
        if (reconnectPromise === nextReconnectPromise) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  async function resolveSessionTarget(activeClient: IntercomClient, nameOrId: string): Promise<string | null> {
    const sessions = await activeClient.listSessions();
    const byId = sessions.find(s => s.id === nameOrId);
    if (byId) {
      return byId.id;
    }
    const lowerName = nameOrId.toLowerCase();
    const byName = sessions.filter(s => s.name?.toLowerCase() === lowerName);
    if (byName.length > 1) {
      throw new Error(`Multiple sessions named "${nameOrId}" are connected. Use the session ID instead.`);
    }
    return byName[0]?.id ?? null;
  }
  registerSubagentRelay(pi, {
    runtimeGeneration: () => runtimeGeneration,
    runtimeStarted: () => runtimeStarted,
    runtimeContext: () => runtimeContext,
    getLiveContext,
    currentSessionTargetMatches,
    sendIncomingMessage,
    ensureConnected,
    resolveSessionTarget,
  });


  registerIntercomLifecycle(pi, {
    config,
    client: () => client,
    setClient: (value) => { client = value; },
    setShuttingDown: (value) => { shuttingDown = value; },
    setDisposed: (value) => { disposed = value; },
    setRuntimeStarted: (value) => { runtimeStarted = value; },
    incrementRuntimeGeneration: () => { runtimeGeneration += 1; return runtimeGeneration; },
    resetReconnectAttempt: () => { reconnectAttempt = 0; },
    clearReconnectTimer,
    clearStartupConnectTimer,
    setRuntimeContext: (value) => { runtimeContext = value; },
    setCurrentSessionId: (value) => { currentSessionId = value; },
    setCurrentModel: (value) => { currentModel = value; },
    setSessionStartedAt: (value) => { sessionStartedAt = value; },
    setAgentRunning: (value) => { agentRunning = value; },
    activeTools,
    setStartupConnectTimer: (value) => { startupConnectTimer = value; },
    getLiveContext,
    ensureConnected,
    scheduleReconnect,
    rejectReplyWaiter,
    replyTracker,
    pendingIdleMessages,
    clearInboundFlushTimer,
    scheduleInboundFlush,
    syncPresenceStatus,
    syncPresenceIdentity,
    currentStatus,
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  const childOrchestratorMetadata = readChildOrchestratorMetadata();
  registerContactSupervisorTool(pi, {
    childOrchestratorMetadata,
    ensureConnected,
    syncPresenceIdentity,
    resolveSessionTarget,
    waitForReply,
    hasReplyWaiter: () => Boolean(replyWaiter),
    rejectReplyWaiter,
  });
  registerIntercomTool(pi, {
    ensureConnected,
    syncPresenceIdentity,
    resolveSessionTarget,
    waitForReply,
    confirmSend: config.confirmSend,
    replyTracker,
    hasReplyWaiter: () => Boolean(replyWaiter),
    rejectReplyWaiter,
  });
  registerIntercomOverlay(pi, {
    runtimeGeneration: () => runtimeGeneration,
    getLiveContext,
    notifyIfLive,
    ensureConnected,
    syncPresenceIdentity,
  });
}
