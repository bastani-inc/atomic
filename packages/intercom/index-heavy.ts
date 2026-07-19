import { APP_NAME, type ExtensionAPI, type ExtensionContext } from "@bastani/atomic";
import { appendFileSync } from "node:fs";
import { IntercomClient } from "./broker/client.js";
import { spawnBrokerIfNeeded } from "./broker/spawn.js";
import { InlineMessageComponent } from "./ui/inline-message.js";
import { loadConfig, type IntercomConfig } from "./config.js";
import type { SessionInfo, Message } from "./types.js";
import { ReplyTracker } from "./reply-tracker.js";
import { ReplyWaiterSlot } from "./reply-waiter.js";
import { registerContactSupervisorTool } from "./contact-supervisor-tool.js";
import { registerIntercomTool } from "./intercom-tool.js";
import { registerIntercomOverlay } from "./overlay.js";
import { registerIntercomLifecycle } from "./lifecycle.js";
import { registerSubagentRelay } from "./subagent-relay.js";
import { ForegroundDetachHandoff, handleForegroundInboundDelivery } from "./foreground-detach-handoff.js";
import { routeIncomingReply } from "./reply-routing.js";
import { INBOUND_FLUSH_DELAY_MS, INBOUND_IDLE_RETRY_MS, type InboundMessageEntry, buildPresenceIdentity, formatAttachments, readChildOrchestratorMetadata, toError } from "./intercom-utils.js";
import { InboundIdleQueue } from "./inbound-idle-queue.js";
import { registerTerminalOrderingBarrier } from "./terminal-ordering-barrier.js";
import { resolveSessionTargetId } from "./session-target.js";
import { InboundMessageAdmission } from "./inbound-message-admission.js";
import { registerLateStageMessageRouter } from "./late-stage-message-router.js";
import { retryStableDelivery } from "./stable-delivery-retry.js";
import type { IntercomExtensionTestOverrides } from "./intercom-test-seams.js";
import { admitWorkflowStageInbound } from "./workflow-stage-admission.js";
import { bindWorkflowReplyTracker, preserveWorkflowReplyTracker } from "./workflow-reply-tracker.js";
import { routeClosedWorkflowStageMessage } from "./closed-workflow-stage-message.js";
import { resolveHomeGroup } from "./group.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
import { SupervisorAuthorizationRegistry } from "./supervisor-authorization-registry.js";
if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL === "1") {
  process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED = "1";
}
if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE) {
  appendFileSync(process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE, "intercom\n");
}

const INTERCOM_SESSION_ID_ENV = `${APP_NAME.toUpperCase()}_INTERCOM_SESSION_ID`;
export default function piIntercomExtension(pi: ExtensionAPI, testOverrides: IntercomExtensionTestOverrides = {}) {
  const inheritedIntercomSessionId = process.env[INTERCOM_SESSION_ID_ENV];
  const restoreIntercomSessionIdEnv = (): void => {
    if (inheritedIntercomSessionId === undefined) delete process.env[INTERCOM_SESSION_ID_ENV];
    else process.env[INTERCOM_SESSION_ID_ENV] = inheritedIntercomSessionId;
  };
  let client: IntercomClient | null = null;
  const config: IntercomConfig = loadConfig();
  const childOrchestratorMetadata = readChildOrchestratorMetadata();
  let runtimeContext: ExtensionContext | null = null;
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let reconnectAttempt = 0;
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  const activeTools = new Map<string, string>();
  let replyTracker = new ReplyTracker();
  const replyWaiters = new ReplyWaiterSlot();
  const foregroundDetachHandoff = new ForegroundDetachHandoff(pi);
  const pendingIdleMessages = new InboundIdleQueue();
  const inboundDeliveries = new InboundMessageAdmission();
  const supervisorAuthorizations = new SupervisorAuthorizationRegistry();
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  function rejectReplyWaiter(error: Error): void { replyWaiters.rejectCurrent(error); }
  function clearReconnectTimer(): void { if (reconnectTimer) clearTimeout(reconnectTimer); reconnectTimer = null; }
  function clearInboundFlushTimer(): void { if (inboundFlushTimer) clearTimeout(inboundFlushTimer); inboundFlushTimer = null; }
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
      group: resolveHomeGroup(config, getLiveContext()),
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
  function buildIncomingCustomMessage(entry: InboundMessageEntry) {
    const senderDisplay = entry.from.name || entry.from.id.slice(0, 8);
    const replyInstruction = entry.replyCommand ? `\n\nTo reply, use the intercom tool: ${entry.replyCommand}` : "";
    return {
      customType: "intercom_message" as const,
      content: `**📨 From ${senderDisplay}** (${entry.from.cwd})${replyInstruction}\n\n${entry.bodyText}`,
      display: true as const,
      details: entry,
    };
  }
  registerLateStageMessageRouter(pi, inboundDeliveries, () => replyTracker, () => resolveHomeGroup(config, getLiveContext()));
  function sendIncomingMessage(entry: InboundMessageEntry, delivery: "trigger" | "followUp" | "prelude", generation = runtimeGeneration, trackReplyContext = true, turnContext?: ReturnType<ReplyTracker["recordIncomingMessage"]>): Promise<void> {
    if (runtimeStarted && !getLiveContext(runtimeContext, generation)) {
      return Promise.resolve();
    }
    if (delivery === "trigger" && trackReplyContext) {
      replyTracker.queueTurnContext(turnContext ?? { from: entry.from, message: entry.message, receivedAt: Date.now() });
    }
    const baseOptions = { stageAdmissionKey: `intercom:${entry.message.id}` } as const;
    const options = delivery === "trigger"
      ? { ...baseOptions, triggerTurn: true } as const
      : delivery === "followUp" ? { ...baseOptions, deliverAs: "followUp" } as const : baseOptions;
    return Promise.resolve(pi.sendMessage(buildIncomingCustomMessage(entry), options));
  }
  const unregisterTerminalOrderingBarrier = registerTerminalOrderingBarrier(pi, {
    queue: pendingIdleMessages,
    toMessage: buildIncomingCustomMessage,
    // A prelude is admitted synchronously when idle, or FIFO-queued when busy.
    // The following terminal trigger therefore sees it in context first without
    // waiting for a separate ordinary-message model turn to complete.
    deliver: (entry) => sendIncomingMessage(entry, "prelude"),
    onDrain: () => {
      if (pendingIdleMessages.size === 0) clearInboundFlushTimer();
    },
    isCurrent: () => Boolean(getLiveContext()),
  });
  pi.on("session_shutdown", () => { unregisterTerminalOrderingBarrier(); });
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
    if (pendingIdleMessages.size === 0) {
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

    const entries = pendingIdleMessages.drain();
    const first = entries[0];
    if (first) replyTracker.queueTurnContext({ from: first.from, message: first.message, receivedAt: Date.now() });
    const messages = entries.map(buildIncomingCustomMessage);
    void retryStableDelivery({
      deliver: () => typeof pi.sendMessages === "function" ? Promise.resolve(pi.sendMessages(messages, { triggerTurn: true })) : Promise.all(messages.map((message, index) => pi.sendMessage(message, index === 0 ? { triggerTurn: true } : { deliverAs: "followUp" }))).then(() => {}),
      isCurrent: () => Boolean(getLiveContext(ctx, generation)),
    }).catch(() => {});
  }
  testOverrides.captureInboundHandler?.(handleIncomingMessage);
  function handleIncomingMessage(ctx: ExtensionContext, from: SessionInfo, message: Message, channel?: "supervisor"): void {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      return;
    }
    replyTracker = bindWorkflowReplyTracker(liveContext, replyTracker);
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    const entry = { from, message, replyCommand, bodyText, ...(channel ? { channel } : {}) };
    const stageClosed = liveContext.orchestrationContext?.kind === "workflow-stage"
      && liveContext.orchestrationContext.messageAdmission?.isOpen() === false;
    if (stageClosed) {
      routeClosedWorkflowStageMessage(
        entry, inboundDeliveries, replyTracker, replyWaiters.current(),
        () => sendIncomingMessage(entry, "trigger", messageGeneration, false),
        () => client,
        () => Boolean(getLiveContext(liveContext, messageGeneration)),
      );
      return;
    }
    const admission = inboundDeliveries.admit(from, message);
    if (admission.kind !== "reserved") return;
    const reservation = admission.reservation;
    if (routeIncomingReply(replyWaiters.current(), from, message)) {
      inboundDeliveries.commit(reservation);
      return;
    }
    const replyContext = replyTracker.recordIncomingMessage(from, message);
    const commit = (): void => { inboundDeliveries.commit(reservation); };
    const release = (error: unknown): void => {
      const failure = error instanceof Error ? error : new Error(String(error));
      inboundDeliveries.release(reservation, failure);
      replyTracker.forgetIncomingMessage(replyContext);
    };
    const stageDelivery = admitWorkflowStageInbound(
      liveContext,
      () => { replyTracker.queueTurnContext(replyContext); return retryStableDelivery({ deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false), isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) }); },
      () => foregroundDetachHandoff.claim(from, message, messageGeneration, () => Boolean(getLiveContext(liveContext, messageGeneration))),
    );
    if (stageDelivery !== false) {
      void stageDelivery.then(commit, release);
      return;
    }
    void (async () => {
      try {
        const activeContext = getLiveContext(liveContext, messageGeneration);
        if (!activeContext) {
          release(new Error("Intercom session retired before inbound delivery"));
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
            commit();
            return;
          }
          // Establish queue ownership before probing asynchronously. If a terminal
          // barrier wins the race, the later foreground callback cannot redeliver.
          pendingIdleMessages.enqueue(entry);
          commit();
          await handleForegroundInboundDelivery({
            handoff: foregroundDetachHandoff,
            from,
            message,
            generation: messageGeneration,
            surface: () => {
              if (pendingIdleMessages.remove(entry)) {
                replyTracker.queueTurnContext(replyContext);
                void retryStableDelivery({ deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false), isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) }).catch(() => {});
              }
            },
            isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
            onUnclaimed: () => {
              // No exact foreground owner acknowledged the target. Preserve the
              // established background/cross-session behavior by waiting for idle.
              if (pendingIdleMessages.has(entry)) scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
            },
            onDelivered: () => { pendingIdleMessages.remove(entry); },
          });
          return;
        }
        replyTracker.queueTurnContext(replyContext);
        await retryStableDelivery({ deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false), isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) });
        commit();
      } catch (error) {
        release(error);
      }
    })();
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from: SessionInfo, message: Message, channel?: "supervisor") => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message, channel);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      if (process.env[INTERCOM_SESSION_ID_ENV] === nextClient.sessionId) restoreIntercomSessionIdEnv();
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
    }, reconnectDelayMs(reconnectAttempt));
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
        await nextClient.connect(
          buildRegistration(), childOrchestratorMetadata?.supervisor, supervisorAuthorizations.ownerToken,
        );
        await supervisorAuthorizations.restore(nextClient);
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        if (nextClient.sessionId) process.env[INTERCOM_SESSION_ID_ENV] = nextClient.sessionId;
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
        if (reconnectPromiseGeneration === generationAtStart) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    return nextReconnectPromise;
  }
  registerSubagentRelay(pi, {
    runtimeGeneration: () => runtimeGeneration,
    runtimeStarted: () => runtimeStarted,
    runtimeContext: () => runtimeContext,
    getLiveContext,
    currentSessionTargetMatches,
    sendIncomingMessage,
    ensureConnected,
    authorizeSupervisorChild: (childName) => supervisorAuthorizations.authorize(childName, () => ensureConnected("background")),
    resolveSessionTarget: resolveSessionTargetId,
    homeGroup: () => resolveHomeGroup(config, getLiveContext()),
  });

  registerIntercomLifecycle(pi, {
    config,
    client: () => client,
    setClient: (value) => { client = value; },
    setShuttingDown: (value) => { shuttingDown = value; },
    setDisposed: (value) => { disposed = value; },
    setRuntimeStarted: (value) => { runtimeStarted = value; },
    incrementRuntimeGeneration: () => { runtimeGeneration += 1; foregroundDetachHandoff.reset(); return runtimeGeneration; },
    resetReconnectAttempt: () => { reconnectAttempt = 0; },
    clearReconnectTimer,
    setRuntimeContext: (value) => { runtimeContext = value; },
    setCurrentSessionId: (value) => { currentSessionId = value; },
    setCurrentModel: (value) => { currentModel = value; },
    setSessionStartedAt: (value) => { sessionStartedAt = value; },
    setAgentRunning: (value) => { agentRunning = value; },
    activeTools,
    getLiveContext,
    rejectReplyWaiter,
    replyTracker: () => replyTracker,
    bindReplyTracker: (ctx) => { replyTracker = bindWorkflowReplyTracker(ctx, replyTracker); },
    preserveReplyTrackerOnCleanup: () => preserveWorkflowReplyTracker(runtimeContext),
    pendingIdleMessages,
    clearInboundFlushTimer,
    scheduleInboundFlush,
    syncPresenceStatus,
    syncPresenceIdentity,
    restoreIntercomSessionIdEnv,
    currentStatus,
  });

  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  registerContactSupervisorTool(pi, {
    childOrchestratorMetadata,
    ensureConnected,
    syncPresenceIdentity,
    resolveSessionTarget: resolveSessionTargetId,
    beginReplyWait: (from, replyTo, signal) => replyWaiters.begin(from, replyTo, signal),
    hasReplyWaiter: () => replyWaiters.has(),
  });
  registerIntercomTool(pi, {
    ensureConnected,
    syncPresenceIdentity,
    beginReplyWait: (from, replyTo, signal) => replyWaiters.begin(from, replyTo, signal),
    confirmSend: config.confirmSend,
    replyTracker: () => replyTracker,
    hasReplyWaiter: () => replyWaiters.has(),
  });
  registerIntercomOverlay(pi, {
    runtimeGeneration: () => runtimeGeneration,
    getLiveContext,
    notifyIfLive,
    ensureConnected,
    syncPresenceIdentity,
  });
}
