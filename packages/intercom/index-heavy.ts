import { APP_NAME, type ExtensionAPI, type ExtensionContext } from "@bastani/atomic";
import { appendFileSync } from "node:fs";
import {
	IntercomClient,
	type PendingStageMessageRequest,
	type PendingStageMessageResult,
	type PendingStageNotificationRequest,
} from "./broker/client.js";
import { spawnBrokerIfNeeded } from "./broker/spawn.js";
import { InlineMessageComponent } from "./ui/inline-message.js";
import { loadConfig, type IntercomConfig } from "./config.ts";
import type { SessionInfo, Message } from "./types.js";
import { ReplyTracker } from "./reply-tracker.js";
import { DEFAULT_REPLY_TIMEOUT_MS, ReplyWaiterRegistry } from "./reply-waiter.ts";
import { registerContactSupervisorTool } from "./contact-supervisor-tool.js";
import { registerIntercomTool } from "./intercom-tool.js";
import { registerIntercomOverlay } from "./overlay.js";
import { registerIntercomLifecycle } from "./lifecycle.js";
import { registerSubagentRelay } from "./subagent-relay.js";
import { ForegroundDetachHandoff, handleForegroundInboundDelivery } from "./foreground-detach-handoff.js";
import { routeIncomingReply } from "./reply-routing.js";
import { routePeerDisconnect, type PeerDisconnectNotice } from "./peer-disconnect-routing.js";
import { INBOUND_FLUSH_DELAY_MS, INBOUND_IDLE_RETRY_MS, buildPresenceIdentity, formatAttachments, readChildOrchestratorMetadata, toError } from "./intercom-utils.js";
import { readSubagentMessageSource } from "./source-ownership.js";
import {
  buildIncomingCustomMessage,
  createIncomingMessageSender,
  framePreStartPendingStageMessage,
} from "./incoming-message-delivery.js";
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
import { createWorkflowStageDeliveryFailureHandler } from "./workflow-stage-delivery-failure.js";
import { normalizeGroup, resolveHomeGroup } from "./group.js";
import { clearRuntimeIntercomGroup, setRuntimeIntercomGroup } from "./runtime-group.js";
import { reconnectDelayMs } from "./reconnect-backoff.js";
import { SupervisorAuthorizationRegistry } from "./supervisor-authorization-registry.js";
if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL === "1") {
  process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED = "1";
}
if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE) {
  appendFileSync(process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE, "intercom\n");
}

const INTERCOM_SESSION_ID_ENV = `${APP_NAME.toUpperCase()}_INTERCOM_SESSION_ID`;
const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";

interface PendingStageRouteRegistrationEvent {
  readonly runId: string;
  readonly group: string;
  readonly capability: string;
  completion?: Promise<void>;
}

type PendingStageRouteRegistration = Pick<PendingStageRouteRegistrationEvent, "group" | "capability">;

interface PendingStageRouteClientState {
  readonly route: PendingStageRouteRegistration;
  client: IntercomClient | null;
  promise: Promise<void> | null;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
}

interface PendingStageMessageEvent extends PendingStageMessageRequest {
  handled: boolean;
  completion?: Promise<PendingStageMessageResult>;
}

interface PendingStageUndeliverableEvent {
  handled: boolean;
  completion?: Promise<boolean>;
  readonly runId: string;
  readonly senderId: string;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
  readonly messageId: string;
  readonly notificationId: string;
  readonly reason: string;
}

function isPendingStageUndeliverableEvent(value: unknown): value is PendingStageUndeliverableEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PendingStageUndeliverableEvent>;
  return (
    typeof event.runId === "string" &&
    typeof event.handled === "boolean" &&
    typeof event.senderId === "string" &&
		(event.senderRegistrationName === undefined || typeof event.senderRegistrationName === "string") &&
		(event.senderReturnAddress === undefined || typeof event.senderReturnAddress === "string") &&
    typeof event.messageId === "string" &&
    typeof event.notificationId === "string" &&
    typeof event.reason === "string"
  );
}

function isPendingStageRouteRegistrationEvent(value: unknown): value is PendingStageRouteRegistrationEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Partial<PendingStageRouteRegistrationEvent>;
  return (
    typeof event.runId === "string" &&
    event.runId.length > 0 &&
    typeof event.group === "string" &&
    typeof event.capability === "string" &&
    event.capability.length > 0
  );
}
export default function piIntercomExtension(pi: ExtensionAPI, testOverrides: IntercomExtensionTestOverrides = {}) {
  const inheritedIntercomSessionId = process.env[INTERCOM_SESSION_ID_ENV];
  const restoreIntercomSessionIdEnv = (): void => {
    if (inheritedIntercomSessionId === undefined) delete process.env[INTERCOM_SESSION_ID_ENV];
    else process.env[INTERCOM_SESSION_ID_ENV] = inheritedIntercomSessionId;
  };
  let client: IntercomClient | null = null;
  let clientRegistrationGroup: string | null = null;
  const config: IntercomConfig = loadConfig();
  const legacyChildOrchestratorMetadata = readChildOrchestratorMetadata();
  let runtimeContext: ExtensionContext | null = null;
  function currentChildOrchestratorMetadata() {
    return runtimeContext?.subagentPolicy !== undefined
      ? readChildOrchestratorMetadata(runtimeContext.subagentPolicy)
      : legacyChildOrchestratorMetadata;
  }
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
  let sessionHomeGroup: string | null = null;
  let joinedGroup: string | null = null;
  const activeTools = new Map<string, string>();
  let replyTracker = new ReplyTracker();
  const replyWaiters = new ReplyWaiterRegistry(DEFAULT_REPLY_TIMEOUT_MS, config.maxPendingAsks);
  const foregroundDetachHandoff = new ForegroundDetachHandoff(pi);
  const pendingIdleMessages = new InboundIdleQueue();
  const inboundDeliveries = new InboundMessageAdmission();
  const pendingStageRoutes = new Map<string, PendingStageRouteRegistration>();
  const pendingStageRouteClients = new Map<string, PendingStageRouteClientState>();
  const supervisorAuthorizations = new SupervisorAuthorizationRegistry();
  let inboundFlushTimer: NodeJS.Timeout | null = null;
  function rejectReplyWaiter(error: Error): void { replyWaiters.rejectAll(error); }
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
  function resolveSessionHomeGroup(): string {
    return sessionHomeGroup ?? resolveHomeGroup(config, getLiveContext());
  }
  function currentIntercomGroup(): string {
    return joinedGroup ?? resolveSessionHomeGroup();
  }
  function setJoinedGroup(group: string): void {
    const sessionId = currentSessionId;
    if (!sessionId) return;
    setRuntimeIntercomGroup(sessionId, group);
    joinedGroup = group;
  }
  function clearJoinedGroup(): void {
    const sessionId = currentSessionId;
    joinedGroup = null;
    if (sessionId) clearRuntimeIntercomGroup(sessionId);
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
      group: currentIntercomGroup(),
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
  registerLateStageMessageRouter(pi, inboundDeliveries, () => replyTracker, currentIntercomGroup);
  const sendIncomingMessage = createIncomingMessageSender({
    pi,
    currentGeneration: () => runtimeGeneration,
    canDeliver: (generation) => !runtimeStarted || Boolean(getLiveContext(runtimeContext, generation)),
    queueTurnContext: (context) => replyTracker.queueTurnContext(context),
  });
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
  function handleIncomingMessage(
    ctx: ExtensionContext,
    from: SessionInfo,
    message: Message,
    channel?: "supervisor",
    receivedBeforeStageStart = false,
  ): void | Promise<void> {
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
    const rawEntry = { from, message, replyCommand, bodyText, ...(channel ? { channel } : {}) };
    const entry = receivedBeforeStageStart ? framePreStartPendingStageMessage(rawEntry) : rawEntry;
    if (receivedBeforeStageStart) {
      return sendIncomingMessage(entry, "prelude", messageGeneration, false);
    }
    const stageClosed = liveContext.orchestrationContext?.kind === "workflow-stage"
      && liveContext.orchestrationContext.messageAdmission?.isOpen() === false;
    if (stageClosed) {
      routeClosedWorkflowStageMessage(
        entry, inboundDeliveries, replyTracker, replyWaiters.pending(),
        () => sendIncomingMessage(entry, "trigger", messageGeneration, false),
        () => client,
        () => Boolean(getLiveContext(liveContext, messageGeneration)),
      );
      return;
    }
    const admission = inboundDeliveries.admit(from, message);
    if (admission.kind !== "reserved") return;
    const reservation = admission.reservation;
    if (routeIncomingReply(replyWaiters.pending(), from, message)) {
      inboundDeliveries.commit(reservation);
      return;
    }
    const replyContext = replyTracker.recordIncomingMessage(from, message);
    const commit = (): void => { inboundDeliveries.commit(reservation); };
    const release = createWorkflowStageDeliveryFailureHandler({
      entry,
      admission: inboundDeliveries,
      reservation,
      tracker: replyTracker,
      replyContext,
      currentClient: () => client,
      commit,
    });
    const stageDelivery = admitWorkflowStageInbound(
      liveContext,
      (admissionBarrier) => {
        replyTracker.queueTurnContext(replyContext);
        return retryStableDelivery({
          deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false, undefined, admissionBarrier),
          isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
        });
      },
      () => foregroundDetachHandoff.claim(from, message, messageGeneration, () => Boolean(getLiveContext(liveContext, messageGeneration))),
      release,
    );
    if (stageDelivery !== false) {
      void stageDelivery.then(commit, release);
      return;
    }
    return (async () => {
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
  function handlePendingStageMessage(
    nextClient: IntercomClient,
    request: PendingStageMessageRequest,
    isCurrent: () => boolean,
  ): void {
    if (!isCurrent()) return;
    const event: PendingStageMessageEvent = { ...request, handled: false };
    try {
      pi.events.emit(PENDING_STAGE_MESSAGE_EVENT, event as unknown as Record<string, unknown>);
    } catch (error) {
      nextClient.respondPendingStageMessage(request.requestId, { outcome: "refused", reason: toError(error).message });
      return;
    }
    if (!event.handled || event.completion === undefined) {
      nextClient.respondPendingStageMessage(request.requestId, {
        outcome: "refused",
        reason: "Session not found",
      });
      return;
    }
    void event.completion.then(
      (result) => nextClient.respondPendingStageMessage(request.requestId, result),
      (error) =>
        nextClient.respondPendingStageMessage(request.requestId, {
          outcome: "refused",
          reason: toError(error).message,
        }),
    );
  }
	async function admitPendingStageNotification(
		nextClient: IntercomClient,
		request: PendingStageNotificationRequest,
	): Promise<boolean> {
		const messageGeneration = runtimeGeneration;
		const liveContext = client === nextClient ? getLiveContext() : null;
		if (liveContext === null) return false;
		const attachmentText = request.message.content.attachments?.length
			? formatAttachments(request.message.content.attachments)
			: "";
		const bodyText = `${request.message.content.text}${attachmentText}`;
		const replyCommand = config.replyHint && request.message.expectsReply
			? `intercom({ action: "reply", message: "..." })`
			: undefined;
		const entry = { from: request.from, message: request.message, replyCommand, bodyText };
		const admission = inboundDeliveries.admit(request.from, request.message);
		if (admission.kind === "duplicate") return true;
		if (admission.kind === "pending") {
			return admission.completion.then(() => true, () => false);
		}
		const reservation = admission.reservation;
		const commit = (): void => { inboundDeliveries.commit(reservation); };
		replyTracker = bindWorkflowReplyTracker(liveContext, replyTracker);
		if (routeIncomingReply(replyWaiters.pending(), request.from, request.message)) {
			commit();
			return true;
		}
		const replyContext = replyTracker.recordIncomingMessage(request.from, request.message);
		const release = createWorkflowStageDeliveryFailureHandler({
			entry,
			admission: inboundDeliveries,
			reservation,
			tracker: replyTracker,
			replyContext,
			currentClient: () => client,
			commit,
		});
		const reject = async (error: unknown): Promise<false> => {
			await release(error);
			return false;
		};
		const stageClosed = liveContext.orchestrationContext?.kind === "workflow-stage"
			&& liveContext.orchestrationContext.messageAdmission?.isOpen() === false;
		if (stageClosed) return reject(new Error("Workflow stage is closed before notification admission"));
		const stageDelivery = admitWorkflowStageInbound(
			liveContext,
			(admissionBarrier) => {
				replyTracker.queueTurnContext(replyContext);
				return retryStableDelivery({
					deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false, undefined, admissionBarrier),
					isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
				});
			},
			() => foregroundDetachHandoff.claim(
				request.from,
				request.message,
				messageGeneration,
				() => Boolean(getLiveContext(liveContext, messageGeneration)),
			),
			release,
		);
		if (stageDelivery !== false) {
			try {
				await stageDelivery;
				commit();
				return true;
			} catch (error) {
				return reject(error);
			}
		}
		try {
			const activeContext = getLiveContext(liveContext, messageGeneration);
			if (activeContext === null || !activeContext.isIdle()) {
				return reject(new Error("Intercom session is not ready for acknowledged notification delivery"));
			}
			replyTracker.queueTurnContext(replyContext);
			await retryStableDelivery({
				deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false),
				isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
			});
			commit();
			return true;
		} catch (error) {
			return reject(error);
		}
	}
	function handlePendingStageNotification(nextClient: IntercomClient, request: PendingStageNotificationRequest): void {
		void admitPendingStageNotification(nextClient, request)
			.catch(() => false)
			.then((delivered) => {
				if (client !== nextClient || !nextClient.isConnected()) return;
				try {
					nextClient.respondPendingStageNotification(request.requestId, delivered);
				} catch {
					// Broker disconnect keeps the durable sender outbox pending for retry.
				}
			});
	}
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from: SessionInfo, message: Message, channel?: "supervisor") => {
      const liveContext = getLiveContext();
      if (client !== nextClient || !liveContext) {
        return;
      }
      handleIncomingMessage(liveContext, from, message, channel);
    });
    nextClient.on("pending_stage_message", (request: PendingStageMessageRequest) => {
      handlePendingStageMessage(nextClient, request, () => client === nextClient);
    });
		nextClient.on("pending_stage_notification", (request: PendingStageNotificationRequest) => {
			handlePendingStageNotification(nextClient, request);
		});
    nextClient.on("peer_disconnected", (notice: PeerDisconnectNotice) => {
      if (client !== nextClient) {
        return;
      }
      routePeerDisconnect(replyWaiters.pending(), notice);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      clientRegistrationGroup = null;
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
  function samePendingStageRoute(
    left: PendingStageRouteRegistration | undefined,
    right: PendingStageRouteRegistration,
  ): boolean {
    return left !== undefined
      && normalizeGroup(left.group) === normalizeGroup(right.group)
      && left.capability === right.capability;
  }
  function pendingStageRouteClientIsCurrent(
    runId: string,
    state: PendingStageRouteClientState,
    context: ExtensionContext | null = runtimeContext,
    generation = runtimeGeneration,
  ): boolean {
    return pendingStageRouteClients.get(runId) === state
      && samePendingStageRoute(pendingStageRoutes.get(runId), state.route)
      && Boolean(getLiveContext(context, generation));
  }
  function schedulePendingStageRouteReconnect(runId: string, state: PendingStageRouteClientState): void {
    if (state.reconnectTimer || state.promise || !pendingStageRouteClientIsCurrent(runId, state)) return;
    const scheduledGeneration = runtimeGeneration;
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      if (!pendingStageRouteClientIsCurrent(runId, state, runtimeContext, scheduledGeneration)) return;
      state.reconnectAttempt += 1;
      void ensurePendingStageRouteClient(runId, state.route).catch(() => {});
    }, reconnectDelayMs(state.reconnectAttempt));
  }
  function attachPendingStageRouteClientHandlers(
    runId: string,
    state: PendingStageRouteClientState,
    nextClient: IntercomClient,
  ): void {
    nextClient.on("pending_stage_message", (request: PendingStageMessageRequest) => {
      handlePendingStageMessage(
        nextClient,
        request,
        () => state.client === nextClient && pendingStageRouteClientIsCurrent(runId, state),
      );
    });
    nextClient.on("disconnected", () => {
      if (state.client !== nextClient) return;
      state.client = null;
      schedulePendingStageRouteReconnect(runId, state);
    });
    nextClient.on("error", () => {
      // Route-owner reconnect logic runs from the disconnect path.
    });
  }
  async function ensurePendingStageRouteClient(
    runId: string,
    route: PendingStageRouteRegistration,
  ): Promise<void> {
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart) throw new Error("Intercom runtime not initialized");

    let existing = pendingStageRouteClients.get(runId);
    if (existing && !samePendingStageRoute(existing.route, route)) {
      pendingStageRouteClients.delete(runId);
      if (existing.reconnectTimer) clearTimeout(existing.reconnectTimer);
      try { await existing.promise; } catch {}
      if (existing.client) {
        try { await existing.client.disconnect(); } catch {}
      }
      existing = undefined;
    }
    const state: PendingStageRouteClientState = existing ?? {
      route,
      client: null,
      promise: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
    };
    if (!existing) pendingStageRouteClients.set(runId, state);
    if (state.client?.isConnected()) return;
    if (state.promise) return state.promise;

    const promise = (async () => {
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
		const nextClient = new IntercomClient(`${currentSessionId}:pending-stage-route:${runId}`);
      state.client = nextClient;
      attachPendingStageRouteClientHandlers(runId, state, nextClient);
      await nextClient.connect(
        { ...buildRegistration(), name: undefined, group: normalizeGroup(route.group) },
        undefined,
        undefined,
        readSubagentMessageSource(runtimeContext?.subagentPolicy),
      );
      if (!pendingStageRouteClientIsCurrent(runId, state, contextAtStart, generationAtStart)) {
        await nextClient.disconnect();
        throw new Error("Intercom runtime no longer active");
      }
      nextClient.registerPendingStageRoute(runId, normalizeGroup(route.group), route.capability);
      await nextClient.listSessions();
      if (!pendingStageRouteClientIsCurrent(runId, state, contextAtStart, generationAtStart)) {
        await nextClient.disconnect();
        throw new Error("Intercom runtime no longer active");
      }
      state.reconnectAttempt = 0;
    })();
    state.promise = promise;
    try {
      await promise;
    } catch (error) {
      const failedClient = state.client;
      state.client = null;
      if (failedClient) {
        try { await failedClient.disconnect(); } catch {}
      }
      if (state.promise === promise) state.promise = null;
      schedulePendingStageRouteReconnect(runId, state);
      throw toError(error);
    } finally {
      if (state.promise === promise) state.promise = null;
    }
  }
  async function disconnectPendingStageRouteClients(): Promise<void> {
    const states = [...pendingStageRouteClients.values()];
    pendingStageRouteClients.clear();
    for (const state of states) {
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try { await state.promise; } catch {}
      if (!state.client) continue;
      try { await state.client.disconnect(); } catch {}
      state.client = null;
    }
  }
  async function registerPendingStageRoute(
    activeClient: IntercomClient,
    runId: string,
    route: PendingStageRouteRegistration,
  ): Promise<void> {
    const routeGroup = normalizeGroup(route.group);
    if (clientRegistrationGroup === routeGroup) {
      activeClient.registerPendingStageRoute(runId, routeGroup, route.capability);
      return;
    }
    await ensurePendingStageRouteClient(runId, { ...route, group: routeGroup });
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
		const nextClient = new IntercomClient(currentSessionId);
      const registration = buildRegistration();
      client = nextClient;
      attachClientHandlers(nextClient);
      try {
        await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs);
        const childMetadata = currentChildOrchestratorMetadata();
        await nextClient.connect(
          registration,
          childMetadata?.supervisor,
          supervisorAuthorizations.ownerToken,
          readSubagentMessageSource(runtimeContext?.subagentPolicy),
        );
        clientRegistrationGroup = normalizeGroup(registration.group);
        await supervisorAuthorizations.restore(nextClient);
        for (const [runId, route] of pendingStageRoutes) {
          await registerPendingStageRoute(nextClient, runId, route);
        }
        const orchestration = contextAtStart.orchestrationContext;
        if (orchestration?.kind === "workflow-stage" && orchestration.pendingStageDelivery !== undefined) {
          await nextClient.registerLiveWorkflowStageRoute(
            orchestration.workflowRunId,
            [orchestration.workflowStageId, orchestration.workflowStageName],
            orchestration.pendingStageDelivery.routeCapability,
          );
        }
        if (!getLiveContext(contextAtStart, generationAtStart)) {
          await nextClient.disconnect();
          throw new Error("Intercom runtime no longer active");
        }
        client = nextClient;
        if (nextClient.sessionId) {
          process.env[INTERCOM_SESSION_ID_ENV] = nextClient.sessionId;
        }
        reconnectAttempt = 0;
        return nextClient;
      } catch (error) {
        if (client === nextClient) {
          client = null;
          clientRegistrationGroup = null;
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
  pi.events.on(PENDING_STAGE_ROUTE_EVENT, (payload) => {
    if (!isPendingStageRouteRegistrationEvent(payload)) return;
    pendingStageRoutes.set(payload.runId, { group: payload.group, capability: payload.capability });
    const completion = ensureConnected("background").then((activeClient) =>
      registerPendingStageRoute(activeClient, payload.runId, payload),
    );
    payload.completion = completion;
    void completion.catch(() => {});
  });
  async function pendingStageNotificationClient(runId: string): Promise<IntercomClient> {
    const route = pendingStageRoutes.get(runId);
    if (route === undefined) throw new Error("Pending workflow route is unavailable");
    if (client?.isConnected() && clientRegistrationGroup === normalizeGroup(route.group)) return client;
    await ensurePendingStageRouteClient(runId, route);
    const routeClient = pendingStageRouteClients.get(runId)?.client;
    if (!routeClient?.isConnected()) throw new Error("Pending workflow route is disconnected");
    return routeClient;
  }
  pi.events.on(PENDING_STAGE_UNDELIVERABLE_EVENT, (payload) => {
    if (!isPendingStageUndeliverableEvent(payload) || payload.handled) return;
    payload.handled = true;
    const actionable = `Pending workflow stage could not receive intercom message: ${payload.reason}`;
		payload.completion = pendingStageNotificationClient(payload.runId)
			.then((activeClient) => {
				const route = pendingStageRoutes.get(payload.runId);
				if (route === undefined) throw new Error("Pending workflow route is unavailable");
				return activeClient.sendPendingStageNotification(
					payload.runId,
					route.capability,
					payload.senderId,
					payload.senderRegistrationName,
					{
						text: actionable,
						replyTo: payload.messageId,
						replyError: actionable,
						messageId: payload.notificationId,
					},
					payload.senderReturnAddress,
				);
			})
			.then((result) => result.delivered)
			.catch(() => false);
  });

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
    homeGroup: currentIntercomGroup,
  });

  registerIntercomLifecycle(pi, {
    config,
    client: () => client,
    disconnectAuxiliaryClients: disconnectPendingStageRouteClients,
    setClient: (value) => {
      client = value;
      if (value === null) clientRegistrationGroup = null;
    },
    setShuttingDown: (value) => { shuttingDown = value; },
    setDisposed: (value) => { disposed = value; },
    setRuntimeStarted: (value) => { runtimeStarted = value; },
    incrementRuntimeGeneration: () => { runtimeGeneration += 1; foregroundDetachHandoff.reset(); return runtimeGeneration; },
    resetReconnectAttempt: () => { reconnectAttempt = 0; },
    clearReconnectTimer,
    setRuntimeContext: (value) => {
      if (value === null) {
        clearJoinedGroup();
        sessionHomeGroup = null;
      } else {
        sessionHomeGroup = resolveHomeGroup(config, value);
        inboundDeliveries.restore(value.sessionManager.getBranch());
      }
      runtimeContext = value;
    },
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
  pi.on("session_start", async (_event, ctx) => {
    const pendingStageDelivery = ctx.orchestrationContext?.kind === "workflow-stage" ? ctx.orchestrationContext.pendingStageDelivery : undefined;
    if (pendingStageDelivery === undefined) return;
    await ensureConnected("startup");
    await pendingStageDelivery.deliverPending((from, message) =>
      handleIncomingMessage(ctx, from as SessionInfo, message as Message, undefined, true),
    );
  });


  pi.registerMessageRenderer("intercom_message", (message, _options, theme) => {
    const details = message.details as { from: SessionInfo; message: Message; replyCommand?: string; bodyText?: string } | undefined;
    if (!details) return undefined;
    return new InlineMessageComponent(details.from, details.message, theme, details.replyCommand, details.bodyText);
  });

  registerContactSupervisorTool(pi, {
    childOrchestratorMetadata: currentChildOrchestratorMetadata,
    ensureConnected,
    syncPresenceIdentity,
    resolveSessionTarget: resolveSessionTargetId,
    beginReplyWait: (from, replyTo, signal) => replyWaiters.begin(from, replyTo, signal),
  });
  registerIntercomTool(pi, {
    childOrchestratorMetadata: currentChildOrchestratorMetadata,
    ensureConnected,
    syncPresenceIdentity,
    beginReplyWait: (from, replyTo, signal) => replyWaiters.begin(from, replyTo, signal),
    confirmSend: config.confirmSend,
    homeGroup: resolveSessionHomeGroup,
    setJoinedGroup,
    clearJoinedGroup,
    replyTracker: () => replyTracker,
  });
  registerIntercomOverlay(pi, {
    runtimeGeneration: () => runtimeGeneration,
    getLiveContext,
    notifyIfLive,
    ensureConnected,
    syncPresenceIdentity,
  });
}
