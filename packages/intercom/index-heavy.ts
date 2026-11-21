import { releaseObservation } from "./broker/released-child-receipts.js";
import { registerSubagentReplyCapability } from "./subagent-reply-capability.js";
import {
  INTERCOM_SESSION_IDENTITY_ENTRY,
  type IntercomSessionIdentity,
  readIntercomSessionIdentity,
} from "./session-identity.js";
import {
  INTERCOM_SESSION_MEMBERSHIPS_ENTRY,
  type IntercomSessionMemberships,
  readIntercomSessionMemberships,
} from "./session-memberships.js";
import {
  INTERCOM_RECOVERY_PEERS_EVENT,
  type IntercomRecoveryPeersRequest,
  isAwaitIntercomPeerRequest,
  INTERCOM_CONNECTED_EVENT,
  type IntercomConnectedNotice,
  isAcknowledgeReleasedChildWakeRequest,
  isDropReleasedChildrenRequest,
  isMarkEndedChildrenRequest,
  isReleaseRestoringChildRequest,
  isReserveReleasedChildrenRequest,
  isReserveRestoringChildRequest,
  planIntercomRecoveryReplay,
  SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT,
  SUBAGENT_AWAIT_INTERCOM_PEER_EVENT,
  SUBAGENT_DROP_RELEASED_CHILDREN_EVENT,
  SUBAGENT_MARK_ENDED_CHILDREN_EVENT,
  SUBAGENT_RELEASE_RESTORING_CHILD_EVENT,
  SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT,
  SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
  SUBAGENT_RELEASED_CHILD_WAKE_EVENT,
  type ReleasedChildWakeNotice,
  SUBAGENT_ENDED_CHILD_WAKE_EVENT,
  type EndedChildWakeRequest,
  SUBAGENT_PEER_RESUME_EVENT,
  isPeerResumeRequest,
  type PeerResumeOutcome,
  waitForIntercomPeer,
} from "./session-recovery.js";
import { PAUSED_RECIPIENT_TARGET, RESUMING_RECIPIENT_TARGET } from "./broker/ended-child-wakes.js";
import { isIntercomRecipientGoneError } from "./broker/recipient-gone-errors.js";

/** #5999: how often a message kept for a paused subagent checks that the subagent's start went past its first turn. */
const FIRST_TURN_POLL_MS = 50;
/** #5999: the notice, in the session that launched a subagent, that it is resuming it for another session's message. */
const ENDED_CHILD_WAKE_MESSAGE_TYPE = "intercom_subagent_wake";
import { APP_NAME, createGitEnvironment, type ExtensionAPI, IntercomRoutingMismatchError, IntercomRoutingUnavailableError, isIntercomBrokerStopTimeoutError, isIntercomBrokerUpgradeError, isIntercomRoutingChangedError, isIntercomRoutingMismatchError, isIntercomRoutingUnavailableError, isProjectGroupError, type ExtensionContext, processStorageEnvironmentAsync, type SessionEntry, sessionScopedExtensionState, type IntercomPolicyView } from "@bastani/atomic";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
	type EndedChildWakeNotice,
	EndedQueueMemory,
	type LostEndedQueuedMessage,
	IntercomClient,
	IntercomReachUnsupportedError,
	type ExpectedRouting,
	type ReleasedChildReply,
} from "./broker/client.js";
import { spawnBrokerIfNeeded, upgradeBroker } from "./broker/spawn.js";
import {
  agreedProtocol,
  BROKER_PROTOCOL,
  decideBrokerProtocol,
  REACH_POLICY_PROTOCOL,
  VERIFIED_REGISTRATION_PROTOCOL,
} from "./broker/protocol-version.js";
import { createReachPolicy, type IntercomReachPolicy, narrowMemberships } from "./reach-policy.js";
import { localOnlyBrokerWarning, warnLocalOnlyBrokerWithoutUi } from "./local-only-broker.js";
import { RECIPIENT_SAVING_REPORT_INTERVAL_MS } from "./retry-policy.js";
import { IntercomRuntimeInactiveError } from "./runtime-inactive-error.js";
import { renderIntercomCustomMessage } from "./ui/inline-message.js";
import { defaultConfig, loadConfigAsync, type IntercomConfig } from "./config.js";
import type { SessionInfo, Message } from "./types.js";
import { ReplyTracker, restorePendingInboundAsks } from "./reply-tracker.js";
import { DEFAULT_REPLY_TIMEOUT_MS, ReplyWaiterRegistry } from "./reply-waiter.ts";
import { frameOutboundAskReply, OutboundAsks, type OutboundAskRecord, recipientClosedAskEntry } from "./outbound-asks.js";
import { RELEASED_CHILD_REPLY_EVENT, type ReleasedChildReplyRequest, replyWaitGates } from "./released-reply-wait.js";
import { registerContactSupervisorTool } from "./contact-supervisor-tool.js";
import { registerIntercomTool } from "./intercom-tool.js";
import { registerIntercomOverlay } from "./overlay.js";
import { registerIntercomLifecycle } from "./lifecycle.js";
import { registerSubagentRelay } from "./subagent-relay.js";
import { ForegroundDetachHandoff, handleForegroundInboundDelivery } from "./foreground-detach-handoff.js";
import { routeIncomingReply } from "./reply-routing.js";
import { routePeerDisconnect, type PeerDisconnectNotice } from "./peer-disconnect-routing.js";
import { INBOUND_FLUSH_DELAY_MS, INBOUND_IDLE_RETRY_MS, type InboundMessageEntry, buildPresenceIdentity, formatAttachments, readChildOrchestratorMetadata, toError } from "./intercom-utils.js";
import { boundReceivedMessage, receivedMessageExceedsBound } from "./received-message-bound.js";
import { readSubagentMessageSource } from "./source-ownership.js";
import {
  buildIncomingCustomMessage,
  createIncomingMessageSender,
  frameDeliveryFeedback,
  isDeliveryFeedback,
  frameHistoricalSupervisorUpdate,
  framePreStartPendingStageMessage,
} from "./incoming-message-delivery.js";
import { InboundIdleQueue, planIdleBatch } from "./inbound-idle-queue.js";
import {
  consumedIntercomMessageIds,
  DurableInbox,
  INTERCOM_INBOX_ENTRY,
  INTERCOM_INBOX_HANDLED_ENTRY,
  INTERCOM_INBOX_REPLAY_EVENT,
  type IntercomInboxReplayRequest,
  unconsumedIntercomInbox,
} from "./durable-inbox.js";
import { registerTerminalOrderingBarrier } from "./terminal-ordering-barrier.js";
import { resolveSessionTargetId, resolveSessionTargetIdIn } from "./session-target.js";
import { InboundMessageAdmission } from "./inbound-message-admission.js";
import { type AdmissionPlace, InboundAdmissionOrder } from "./inbound-admission-order.js";
import { retryStableDelivery } from "./stable-delivery-retry.js";
import type { IntercomConnectReason, IntercomExtensionTestOverrides } from "./intercom-test-seams.js";
import { INTERCOM_STARTUP_JOIN_EVENT, type IntercomStartupJoinRequest, startupJoinFromEnv } from "./startup-join.js";
import { admitActiveSessionInbound } from "./active-session-admission.js";
import { createInboundDeliveryFailureHandler } from "./inbound-delivery-failure.js";
import { DEFAULT_GROUP, explicitHomeGroup, normalizeGroups, resolveHomeGroup } from "./group.js";
import { getIntercomDirPath } from "./broker/paths.js";
import { type BrokerRouting, queryBrokerRouting } from "./broker/broker-routing.js";
import {
  cachedProjectGroup,
  DEFAULT_GROUP_WARNING,
  multiNodeSelectedAsync,
  projectGroupAsync,
  warnDefaultGroupWithoutUi,
} from "./project-group.js";
import { clearRuntimeIntercomGroup, setRuntimeIntercomGroup } from "./runtime-group.js";
import {
  BROKER_RETIRING_RETRY_WINDOW_MS,
  brokerRetiringRetryDelayMs,
  reconnectDelayMs,
} from "./reconnect-backoff.js";
import { isIntercomBrokerRetiring, isRecoverableIntercomDisconnect } from "./recoverable-disconnect.js";
import { SupervisorAuthorizationRegistry } from "./supervisor-authorization-registry.js";
import {
  isSupervisorAuthorizationRefusal,
  pauseUnlessAborted,
  SUPERVISOR_REFUSAL_RETRY_MS,
  supervisorRefusalRetryDelayMs,
} from "./supervisor-refusal.js";
if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL === "1") {
  process.env.ATOMIC_INTERCOM_HEAVY_IMPORTED = "1";
}
if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE) {
  void appendFile(process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE, "intercom\n");
}

const INTERCOM_SESSION_ID_ENV = `${APP_NAME.toUpperCase()}_INTERCOM_SESSION_ID`;
/**
 * The longest a starting subagent's first turn waits, after it registered, for the messages held for it to be saved
 * and written as that turn's context. They are written to its connection right after its registration.
 */
const STARTUP_ARRIVALS_WAIT_MS = 5_000;

/** Wait for `work`, at most `timeoutMs`. */
function settledWithin(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    timer.unref?.();
    void work.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
function readIntercomPolicy(ctx: ExtensionContext): IntercomPolicyView | undefined {
  try {
    return ctx.intercomPolicy;
  } catch {
    return undefined;
  }
}

export default function piIntercomExtension(pi: ExtensionAPI, testOverrides: IntercomExtensionTestOverrides = {}) {
  const inheritedIntercomSessionId = process.env[INTERCOM_SESSION_ID_ENV];
  const restoreIntercomSessionIdEnv = (): void => {
    if (inheritedIntercomSessionId === undefined) delete process.env[INTERCOM_SESSION_ID_ENV];
    else process.env[INTERCOM_SESSION_ID_ENV] = inheritedIntercomSessionId;
  };
  let client: IntercomClient | null = null;
  const replyCapability = registerSubagentReplyCapability(pi, () => client);
  const config: IntercomConfig = defaultConfig();
  const legacyChildOrchestratorMetadata = readChildOrchestratorMetadata();
  let runtimeContext: ExtensionContext | null = null;
  /**
   * Why the broker refused the supervisor capability this child registered with, after it kept refusing it for
   * {@link SUPERVISOR_REFUSAL_RETRY_MS}: the child then registers without it, so its start never fails on it, and
   * reaches its supervisor by its orchestrator target with ordinary sends. A refusal is often a race: after a broker
   * restart a child can register before its supervisor has reconnected and restored the capability. So the next
   * connection tries the capability again.
   */
  let supervisorRefusal: string | undefined;
  /** When the broker first refused the capability in the current run of refusals. */
  let supervisorRefusedSince: number | undefined;
  let supervisorRefusalAttempts = 0;
  function currentChildOrchestratorMetadata() {
    const metadata = runtimeContext?.subagentPolicy !== undefined
      ? readChildOrchestratorMetadata(runtimeContext.subagentPolicy)
      : legacyChildOrchestratorMetadata;
    if (metadata === null || supervisorRefusal === undefined || metadata.supervisor === undefined) return metadata;
    const { supervisor: _refused, ...unverified } = metadata;
    return { ...unverified, supervisorRefusal };
  }
  let currentSessionId: string | null = null;
  let currentModel = "unknown";
  let sessionStartedAt: number | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectPromise: Promise<IntercomClient> | null = null;
  let reconnectPromiseGeneration: number | null = null;
  let reconnectAttempt = 0;
  /**
   * Whether anything other than the startup join has asked for a connection. Only then does a failed attempt keep
   * reconnecting in the background: a session that only joined at startup and never used Intercom stays lazy.
   */
  let connectionWanted = false;
  /**
   * #4727: aborted when the runtime is cleaned up, so a broker start this session began stops before it writes into the
   * agent directory; renewed when the next session starts. Each connect reads the current one.
   */
  let connectAbort = new AbortController();
  /** #4727: the broker starts in flight, settled either way; the cleanup waits for them. */
  const brokerStarts = new Set<Promise<void>>();
  function trackBrokerStart<T>(begin: () => Promise<T>): Promise<T> {
    const start = (async () => begin())();
    const settled = start.then(
      () => {},
      () => {},
    );
    brokerStarts.add(settled);
    void settled.then(() => brokerStarts.delete(settled));
    return start;
  }
  function startBrokerIfNeeded(signal: AbortSignal): Promise<void> {
    return trackBrokerStart(async () => {
      await configReady;
      await spawnBrokerIfNeeded(config.brokerCommand, config.brokerArgs, config.brokerStartupTimeoutMs, undefined, signal);
    });
  }
  let shuttingDown = false;
  let disposed = true;
  let runtimeStarted = false;
  let runtimeGeneration = 0;
  let agentRunning = false;
  /**
   * #5999: whether this is a subagent whose turn its user paused (Esc in its chat): it keeps what arrives until it is
   * continued, and tells each sender so.
   */
  function childTurnPaused(): boolean {
    const policy = getLiveContext()?.subagentPolicy as { readonly turnPaused?: () => boolean } | undefined;
    try {
      return policy?.turnPaused?.() === true;
    } catch {
      return false;
    }
  }
  /** #5999: messages this session's brokers queued for subagents that ended, across its connections. */
  const endedQueueMemory = new EndedQueueMemory();
  /** #5999: by sender, the last of its messages admitted after this subagent's first turn starts; later ones follow it. */
  const deferredFromSender = new Map<string, Promise<void>>();
  /** #5999: messages kept for a paused subagent wait here for its first turn to start. */
  const agentStartWaiters: Array<() => void> = [];
  /**
   * #5999: settles once this subagent's first turn has started (or it has none pending), or its start is given up.
   * Messages kept for it while it was paused wait for this, so what it is continued with goes first.
   */
  function untilFirstTurnStarted(liveContext: ExtensionContext): Promise<void> {
    const startup = liveContext.subagentPolicy?.startup;
    if (startup?.firstTurnPending() !== true || agentRunning) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearInterval(poll);
        startup.signal.removeEventListener("abort", finish);
        const index = agentStartWaiters.indexOf(finish);
        if (index >= 0) agentStartWaiters.splice(index, 1);
        resolve();
      };
      // The start's own steps end its wait too: a start that skips its prompt, or is given up, never starts a turn.
      const poll = setInterval(() => {
        if (startup.firstTurnPending() !== true) finish();
      }, FIRST_TURN_POLL_MS);
      poll.unref?.();
      agentStartWaiters.push(finish);
      startup.signal.addEventListener("abort", finish, { once: true });
    });
  }
  let sessionHomeGroup: string | null = null;
  let brokerRouting: boolean | null = null;
  let selectedSharedStorage = false;
  let homeRoutedAcrossMachines: boolean | null = null;
  let defaultGroupWarned = false;
  /** #4538: this session already warned that it uses a broker it cannot verify on this machine only. */
  let localOnlyWarned = false;
  let terminalHomeGroupError: Error | null = null;
  let joinedGroups: Set<string> | null = null;
  let intercomPolicy: IntercomPolicyView | undefined;
  let stopApplyingReach: (() => void) | undefined;
  const sessionMemberships = sessionScopedExtensionState<Map<string, readonly string[]>>(
    pi.lifecycleScope ?? pi.events ?? pi,
    "intercom:session-memberships:v1",
    () => new Map(),
  );
  const activeTools = new Map<string, string>();
  let replyTracker = new ReplyTracker();
  const replyWaiters = new ReplyWaiterRegistry(DEFAULT_REPLY_TIMEOUT_MS, config.maxPendingAsks);
  const configReady = loadConfigAsync().then((loaded) => {
    Object.assign(config, loaded);
    replyWaiters.setMaxPending(loaded.maxPendingAsks);
  });
  const foregroundDetachHandoff = new ForegroundDetachHandoff(pi);
  function sessionBranch(): SessionEntry[] {
    try {
      return runtimeContext?.sessionManager.getBranch() ?? [];
    } catch {
      return [];
    }
  }
  /** #6168: the messages this session took in entries its resumed window left out. */
  function takenOutsideWindow(): readonly string[] {
    try {
      return runtimeContext?.sessionManager.getSessionRecoveryState?.().intercomTakenIds ?? [];
    } catch {
      return [];
    }
  }
  // #3761: a message counts as shown once its `intercom_message` card is on the session branch.
  const pendingIdleMessages = new InboundIdleQueue(() => consumedIntercomMessageIds(sessionBranch()));
  /** Every path that writes an arriving message to the session takes its place here, in arrival order. */
  const inboundOrder = new InboundAdmissionOrder();
  /** Whether this session is saved, so it can be resumed: anything but an in-memory (`--no-session`) store. */
  function sessionIsSaved(): boolean {
    try {
      return runtimeContext?.sessionManager.getSessionStore?.().descriptor.adapter !== "memory";
    } catch {
      return true;
    }
  }
  const durableInbox = new DurableInbox({
    durable: sessionIsSaved,
    entries: sessionBranch,
    append: (record) => pi.appendEntry(INTERCOM_INBOX_ENTRY, record),
    appendHandled: (messageId) => pi.appendEntry(INTERCOM_INBOX_HANDLED_ENTRY, { messageId }),
  });
  const inboundDeliveries = new InboundMessageAdmission();
  /** Messages a starting subagent is writing as context for its first turn; its start waits for them. */
  const startupDeliveries = new Set<Promise<void>>();
  /** Messages that arrived and are not yet saved and handed over. */
  const arrivalsInFlight = new Set<Promise<void>>();
  // #4751: the asks this session sent; their replies arrive as messages on this session's own thread.
  const outboundAsks = new OutboundAsks({
    entries: sessionBranch,
    append: (customType, data) => pi.appendEntry(customType, data),
    sessionId: () => currentSessionId,
  });
  function outboundAskFor(from: SessionInfo, message: Message): OutboundAskRecord | undefined {
    return outboundAsks.answeredBy(from, message);
  }
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
  function warnExplicitDefaultGroup(ctx: ExtensionContext): void {
    if (defaultGroupWarned) return;
    const liveContext = getLiveContext(ctx);
    if (liveContext === null) return;
    defaultGroupWarned = true;
    if (liveContext.hasUI) notifyIfLive(liveContext, DEFAULT_GROUP_WARNING, "warning");
    else warnDefaultGroupWithoutUi();
  }
  function currentStatus(): string {
    const activeToolName = activeTools.values().next().value;
    const lifecycleStatus = activeToolName ? `tool:${activeToolName}` : agentRunning ? "thinking" : "idle";
    return config.status ? `${lifecycleStatus} · ${config.status}` : lifecycleStatus;
  }
  /** Whether this session's broker routes across machines: what the broker reported, else the storage selection it would start with. */
  function multiNodeRouting(): boolean {
    return brokerRouting ?? selectedSharedStorage;
  }
  /** The project group a session in this context joins by default while multi-node routing is on. */
  function projectGroupOf(ctx: ExtensionContext | null): () => string | undefined {
    return () => (multiNodeRouting() ? cachedProjectGroup(ctx?.cwd ?? process.cwd()) : undefined);
  }
  async function warmProjectGroup(ctx: ExtensionContext | null): Promise<void> {
    await configReady;
    if (explicitHomeGroup(config, ctx) !== undefined || !multiNodeRouting()) return;
    await projectGroupAsync(ctx?.cwd ?? process.cwd(), createGitEnvironment());
  }
  /** Called only for a context `settleBrokerRouting` just found live. */
  function warnLocalOnly(ctx: ExtensionContext, reason: IntercomRoutingUnavailableError): void {
    if (localOnlyWarned) return;
    localOnlyWarned = true;
    if (ctx.hasUI) notifyIfLive(ctx, localOnlyBrokerWarning(reason), "warning");
    else warnLocalOnlyBrokerWithoutUi(reason);
  }
  /**
   * #4538: a broker older than this version is replaced by this version's (`upgradeBroker`); the routing is then read
   * from whichever broker answers. A failed replacement leaves the older broker, which the caller verifies as such.
   */
  async function upgradeOlderBroker(
    agentDir: string,
    signal: AbortSignal,
  ): Promise<{ routing: BrokerRouting; upgradeFailure: Error | undefined }> {
    let upgradeFailure: Error | undefined;
    try {
      await trackBrokerStart(async () => {
        await configReady;
        return upgradeBroker(
          config.brokerCommand,
          config.brokerArgs,
          config.brokerStartupTimeoutMs,
          undefined,
          undefined,
          undefined,
          signal,
        );
      });
    } catch (error) {
      if (!isIntercomBrokerUpgradeError(error)) throw error;
      // An older broker that shut down but is still exiting serves no session, so this attempt fails and the reconnect
      // backoff retries. The lock names that process for about another minute; after it exits or the lock ages out, the
      // first session to reconnect starts a broker, which can be an older one that this version replaces again.
      if (isIntercomBrokerStopTimeoutError(error.cause)) throw error;
      upgradeFailure = error;
    }
    await startBrokerIfNeeded(signal);
    return { routing: await queryBrokerRouting(agentDir), upgradeFailure };
  }
  /**
   * The routing this session registers with. #4538: a broker that cannot verify it (no `broker_status`, or a protocol
   * without `register_verified`) is used on this machine only, with one warning, unless multi-node routing is
   * configured here or reported by the broker; then the session is refused with `broker-routing-unavailable`.
   */
  async function settleBrokerRouting(
    ctx: ExtensionContext,
    generation: number,
    signal: AbortSignal,
  ): Promise<ExpectedRouting> {
    await configReady;
    const agentDir = dirname(getIntercomDirPath());
    const selectedShared = await multiNodeSelectedAsync(agentDir, await processStorageEnvironmentAsync());
    selectedSharedStorage = selectedShared;
    let routing: BrokerRouting | undefined;
    let unverified: IntercomRoutingUnavailableError | undefined;
    try {
      routing = await queryBrokerRouting(agentDir);
      let upgradeFailure: Error | undefined;
      if (decideBrokerProtocol(BROKER_PROTOCOL, routing.protocol) === "upgrade") {
        ({ routing, upgradeFailure } = await upgradeOlderBroker(agentDir, signal));
      }
      const agreed = agreedProtocol(BROKER_PROTOCOL, routing.protocol);
      if (agreed === undefined || agreed < VERIFIED_REGISTRATION_PROTOCOL) {
        unverified = new IntercomRoutingUnavailableError("unsupported", "register", { cause: upgradeFailure });
      }
      if (intercomPolicy !== undefined && (agreed === undefined || agreed < REACH_POLICY_PROTOCOL)) {
        throw new IntercomReachUnsupportedError();
      }
    } catch (error) {
      if (!isIntercomRoutingUnavailableError(error)) throw error;
      unverified = error;
    }
    if (!getLiveContext(ctx, generation)) throw new IntercomRuntimeInactiveError();
    const actual = routing?.acrossMachines ?? false;
    const explicit = explicitHomeGroup(config, ctx);
    const strictSharedProfile = selectedShared && (process.env.ATOMIC_PROFILE ?? "").trim() === "ci";
    if (routing !== undefined) {
      brokerRouting = actual;
      const brokerLacksSelectedStorage = !routing.hasSharedStorage && selectedShared;
      if (brokerLacksSelectedStorage || (strictSharedProfile && !actual)) {
        if (sessionHomeGroup === null) await warmProjectGroup(ctx);
        throw new IntercomRoutingMismatchError("shared-storage-not-on-broker", resolveSessionHomeGroup());
      }
    }
    if (unverified !== undefined) {
      if (selectedShared || actual) throw unverified;
      warnLocalOnly(ctx, unverified);
      brokerRouting = false;
    }
    if (homeRoutedAcrossMachines === null) {
      homeRoutedAcrossMachines = actual;
      const previousHome = sessionHomeGroup;
      await warmProjectGroup(ctx);
      sessionHomeGroup = resolveHomeGroup(config, ctx, projectGroupOf(ctx));
      if (sessionHomeGroup !== previousHome) clearJoinedGroups();
      if (joinedGroups === null) {
        const restored = persistedJoinedGroups(ctx);
        if (restored) setJoinedGroups(restored);
      }
    } else if (actual && !homeRoutedAcrossMachines && explicit === undefined) {
      if (sessionHomeGroup === null) await warmProjectGroup(ctx);
      throw new IntercomRoutingMismatchError("implicit-default-on-remote-broker", resolveSessionHomeGroup());
    }
    if (actual && explicit === DEFAULT_GROUP) warnExplicitDefaultGroup(ctx);
    return { acrossMachines: actual, verify: unverified === undefined };
  }
  function resolveSessionHomeGroup(): string {
    if (sessionHomeGroup !== null) return sessionHomeGroup;
    const liveContext = getLiveContext();
    return resolveHomeGroup(config, liveContext, projectGroupOf(liveContext));
  }
  function currentReachPolicy(): IntercomReachPolicy | undefined {
    const policy = intercomPolicy;
    return policy === undefined ? undefined : createReachPolicy(resolveSessionHomeGroup(), policy.reachable);
  }
  function applyReach(): Promise<void> {
    const reach = currentReachPolicy();
    if (reach === undefined) return Promise.resolve();
    let persisted: Promise<void> = Promise.resolve();
    if (joinedGroups !== null) {
      const narrowed = narrowMemberships(reach, [...joinedGroups]);
      if (narrowed.length !== joinedGroups.size) {
        setJoinedGroups(narrowed);
        persisted = persistJoinedGroups(narrowed.length === 1 ? null : narrowed);
      }
    }
    const active = client;
    const synced =
      active === null || !active.isConnected()
        ? Promise.resolve()
        : active.syncReach().then(
            () => {
              if (client === active && joinedGroups !== null) setJoinedGroups(active.groups);
            },
            (error: Error) => {
              if (!isRecoverableIntercomDisconnect(error)) throw error;
            },
          );
    return Promise.all([persisted, synced]).then(() => {});
  }
  function currentIntercomGroups(): Set<string> {
    return joinedGroups === null
      ? normalizeGroups(undefined, resolveSessionHomeGroup())
      : new Set(joinedGroups);
  }
  function currentIntercomGroup(): string {
    return [...currentIntercomGroups()].at(-1) ?? resolveSessionHomeGroup();
  }
  function setJoinedGroups(groups: readonly string[]): void {
    joinedGroups = normalizeGroups(groups);
    const sessionId = currentSessionId;
    if (!sessionId) return;
    setRuntimeIntercomGroup(sessionId, intercomPolicy === undefined ? currentIntercomGroup() : resolveSessionHomeGroup());
    sessionMemberships.set(sessionId, [...joinedGroups]);
  }
  function clearJoinedGroups(): void {
    if (currentSessionId) sessionMemberships.delete(currentSessionId);
    releaseJoinedGroups();
  }
  /** #4079: record a `join` or `leave` with the session so a restored session rejoins the same groups. */
  async function persistJoinedGroups(groups: readonly string[] | null): Promise<void> {
    const sessionId = currentSessionId;
    if (!sessionId) return;
    try {
      await pi.appendEntry(INTERCOM_SESSION_MEMBERSHIPS_ENTRY, {
        sessionId,
        homeGroup: resolveSessionHomeGroup(),
        groups: groups === null ? null : [...normalizeGroups(groups)],
      } satisfies IntercomSessionMemberships);
    } catch {
      // Best effort: without the record a later restart restores only the home group, as before.
    }
  }
  function persistedJoinedGroups(ctx: ExtensionContext): readonly string[] | undefined {
    try {
      const groups = readIntercomSessionMemberships(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getSessionId(),
        resolveSessionHomeGroup(),
      );
      const reach = currentReachPolicy();
      return groups === undefined || reach === undefined ? groups : narrowMemberships(reach, groups);
    } catch {
      return undefined;
    }
  }
  function releaseJoinedGroups(): void {
    joinedGroups = null;
    const sessionId = currentSessionId;
    if (sessionId && !sessionMemberships.has(sessionId)) clearRuntimeIntercomGroup(sessionId);
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
      replyCapability: replyCapability(),
      groups: [...currentIntercomGroups()],
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
    // A finished child's completion notice follows every message already in line, from it or from anyone else.
    admissionPlace: () => inboundOrder.reserveBehindBusyLine(),
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
    // The flush takes its own place in line, so it never writes a sender's queued message while an earlier admission
    // of that sender's is still writing, nor after a later one that has not taken it yet.
    void inboundOrder.run(() => flushIdleMessagesInOrder(generation)).catch(() => {});
  }
  async function flushIdleMessagesInOrder(generation: number): Promise<void> {
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
    const batch = planIdleBatch(entries);
    if (batch.replyContext) replyTracker.queueTurnContext({ from: batch.replyContext.from, message: batch.replyContext.message, receivedAt: Date.now() });
    const messages = entries.map(buildIncomingCustomMessage);
    await retryStableDelivery({
      deliver: () => typeof pi.sendMessages === "function" ? Promise.resolve(pi.sendMessages(messages, { triggerTurn: batch.triggerTurn })) : Promise.all(messages.map((message, index) => pi.sendMessage(message, batch.sendOptions[index]))).then(() => {}),
      isCurrent: () => Boolean(getLiveContext(ctx, generation)),
    }).catch(() => {});
  }
  /**
   * One sender's messages reach the session in the order they arrived: before a message from `from` is admitted at
   * once, its earlier messages still waiting for this session to go idle are written first, without a turn of their own.
   */
  async function admitEarlierFromSender(from: SessionInfo, generation: number): Promise<void> {
    const earlier = pendingIdleMessages.takeFromSender(from.id);
    if (pendingIdleMessages.size === 0) clearInboundFlushTimer();
    for (const entry of earlier) {
      await retryStableDelivery({
        deliver: () => sendIncomingMessage(entry, "prelude", generation, false),
        isCurrent: () => Boolean(getLiveContext(runtimeContext, generation)),
      });
    }
  }
  testOverrides.captureInboundHandler?.(handleIncomingMessage);
  function buildInboundEntry(from: SessionInfo, message: Message, channel?: "supervisor"): InboundMessageEntry {
    const attachmentText = message.content.attachments?.length
      ? formatAttachments(message.content.attachments)
      : "";
    const bodyText = `${message.content.text}${attachmentText}`;
    const replyCommand = config.replyHint && message.expectsReply
      ? `intercom({ action: "reply", message: "..." })`
      : undefined;
    const rawEntry = { from, message, replyCommand, bodyText, ...(channel ? { channel } : {}) };
    const ask = outboundAskFor(from, message);
    if (ask !== undefined) return frameOutboundAskReply(rawEntry, ask);
    return isDeliveryFeedback(message) ? frameDeliveryFeedback(rawEntry) : frameHistoricalSupervisorUpdate(rawEntry);
  }
  /** #4907: a received message too large for the context, saved to a file in this session's directory. */
  function boundReceived(message: Message): Promise<Message> {
    return boundReceivedMessage(message, () => {
      const sessionManager = getLiveContext()?.sessionManager;
      const sessionDir = sessionManager?.getSessionDir();
      return {
        sessionId: sessionManager?.getSessionId() ?? currentSessionId ?? `intercom-${process.pid}`,
        ...(sessionDir ? { sessionDir } : {}),
      };
    });
  }
  let receivedBoundsInFlight = 0;
  let receivedBoundsTail: Promise<void> = Promise.resolve();
  /**
   * #4907: hands each arriving message to `next` in arrival order once it is bounded. A message within the limit,
   * with nothing ahead of it still being saved to a file, is handed over at once.
   */
  function inArrivalOrder(message: Message, next: (bounded: Message) => void, failed?: () => void): void {
    if (receivedBoundsInFlight === 0 && !receivedMessageExceedsBound(message)) {
      next(message);
      return;
    }
    receivedBoundsInFlight += 1;
    const bounded = receivedBoundsTail.then(() => boundReceived(message)).then(next, () => failed?.());
    receivedBoundsTail = bounded.catch(() => {}).finally(() => { receivedBoundsInFlight -= 1; });
  }
  /** #3761: save an arriving message, confirm it to the broker, then handle it; a copy already saved is only confirmed. */
  function receiveIncomingMessage(receiver: IntercomClient, from: SessionInfo, message: Message, channel?: "supervisor"): void {
    const generation = runtimeGeneration;
    // #3983: a save that waits (a journal commit behind other writers) keeps its sender waiting.
    const saving = setInterval(() => receiver.reportSaving(message.id), RECIPIENT_SAVING_REPORT_INTERVAL_MS);
    saving.unref?.();
    // Its place in line is taken now, on arrival: a slow save never lets a later message overtake it.
    const place = inboundOrder.reserve();
    // Until it is saved and handed over, the arrival is in flight: a starting subagent's first turn waits for it.
    const arrived = Promise.withResolvers<void>();
    arrivalsInFlight.add(arrived.promise);
    void arrived.promise.finally(() => arrivalsInFlight.delete(arrived.promise));
    // #4907: a message too large for the context is saved and shown bounded; unconfirmed, the broker sends it again.
    inArrivalOrder(message, (bounded) => {
      const saved = durableInbox.receive(from, bounded, channel, () => {
        clearInterval(saving);
        receiver.acknowledgeReceived(message.id, childTurnPaused());
      });
      void saved.finally(() => clearInterval(saving)).catch(() => {});
      void saved
        .then(async (arrival) => {
          if (arrival !== "fresh") {
            place.cancel();
            return;
          }
          const liveContext = getLiveContext(runtimeContext, generation);
          if (liveContext) await handleIncomingMessage(liveContext, from, bounded, channel, place);
          else place.cancel();
        })
        .catch(() => place.cancel())
        .finally(() => arrived.resolve());
    }, () => {
      clearInterval(saving);
      place.cancel();
      arrived.resolve();
    });
  }
  /**
   * #3761: decide about the saved messages a resumed session never showed with #3760's interrupted-card decision.
   * `replay` (a connected sender, or a local relay) queues it in arrival order for the next idle turn; `drop` (a sender
   * that is gone) writes its full card as history that starts no turn, and that card alone marks it handled, so a crash
   * before or after the write never loses it or shows it twice; `defer` (Intercom unreachable, or a relaunched sender
   * that has not reconnected) leaves it unshown for the next resume. One pass in arrival order keeps visible history in
   * that order: a gone sender's card that arrived after a queued message joins the same queue behind it, so it is
   * written in the batch that message starts rather than ahead of it. The card is marked `historyOnly`, so it never
   * starts that batch's turn or supplies its reply context, even when the message ahead of it leaves the queue first.
   */
  function replayDurableInbox(request: IntercomInboxReplayRequest): Promise<readonly string[]> {
    // Replay takes one place in line: what it writes or queues keeps its order against live arrivals.
    return inboundOrder.run(() => replayDurableInboxInOrder(request));
  }
  async function replayDurableInboxInOrder(request: IntercomInboxReplayRequest): Promise<readonly string[]> {
    const liveContext = getLiveContext();
    if (!liveContext) return [];
    // #4907: a message an earlier version saved whole is shown bounded.
    const records = await Promise.all(unconsumedIntercomInbox(sessionBranch(), takenOutsideWindow()).map(async (record) => ({
      record,
      entry: buildInboundEntry(record.from, await boundReceived(record.message), record.channel),
    })));
    const plan = planIntercomRecoveryReplay(
      records.map(({ record, entry }) => ({
        entryId: record.message.id,
        customType: "intercom_message",
        content: entry.bodyText,
        details: entry,
        timestamp: new Date(record.receivedAt).toISOString(),
        delivery: "followUp",
      })),
      request.peers,
      request.restored,
    );
    const actions = new Map((plan.decisions ?? []).map((decision) => [decision.entryId, decision.action]));
    let queued = 0;
    for (const { record, entry } of records) {
      const action = actions.get(record.message.id) ?? "replay";
      if (action === "defer") continue;
      if (action === "drop") {
        const historyEntry: InboundMessageEntry = { ...entry, replyCommand: undefined, historyOnly: true };
        if (queued > 0) {
          pendingIdleMessages.enqueue(historyEntry);
          continue;
        }
        try {
          await pi.sendMessage(buildIncomingCustomMessage(historyEntry), { triggerTurn: false });
        } catch {
          // Unwritten, the message stays unshown and the next resume decides about it again.
        }
        continue;
      }
      const admission = inboundDeliveries.admit(record.from, record.message);
      if (admission.kind !== "reserved") continue;
      const askReply = outboundAskFor(record.from, record.message);
      if (askReply !== undefined) void outboundAsks.settle(askReply.ask.askId, record.message.replyError === undefined ? "answered" : "failed");
      replyTracker.recordIncomingMessage(record.from, record.message);
      if (pendingIdleMessages.enqueue(entry)) queued += 1;
      inboundDeliveries.commit(admission.reservation);
    }
    if (queued > 0) scheduleInboundFlush();
    return plan.notices ?? [];
  }
  /** What admitting one message leaves running after its place in line: the delivery its caller may wait for. */
  interface Admitted {
    readonly done?: Promise<void>;
  }
  function handleIncomingMessage(
    ctx: ExtensionContext,
    from: SessionInfo,
    message: Message,
    channel?: "supervisor",
    // The place this message took in the admission line when it arrived; one is taken now when absent.
    arrival?: AdmissionPlace,
  ): void | Promise<void> {
    const messageGeneration = runtimeGeneration;
    const liveContext = getLiveContext(ctx, messageGeneration);
    if (!liveContext) {
      arrival?.cancel();
      return;
    }
    const place = arrival ?? inboundOrder.reserve();
    return place
      .run(() => admitIncomingMessage(liveContext, from, message, channel, messageGeneration))
      .then((admitted) => admitted.done);
  }
  /**
   * Admits one message in its place in line. Everything it writes to the session is written before the next place
   * starts; delivery it only starts (an active subagent's own FIFO, a foreground owner's handshake) is
   * returned, not awaited, so a slow recipient never holds the line.
   */
  async function admitIncomingMessage(
    liveContext: ExtensionContext,
    from: SessionInfo,
    message: Message,
    channel: "supervisor" | undefined,
    messageGeneration: number,
    /** #5999: admitted again after this subagent's first turn started, as the deferral below schedules it. */
    deferred = false,
  ): Promise<Admitted> {
    const entry = buildInboundEntry(from, message, channel);
    // #5999: a message kept for this subagent while it was paused reaches it after what it is continued with: once its
    // first turn has started, as any message to a running subagent does, never as context before that turn. It leaves
    // its place in line at once, so its start, which waits for what arrives before it, never waits for it. A later
    // message from the same sender follows it, so one sender's messages keep their order.
    const deferredBefore = deferred ? undefined : deferredFromSender.get(from.id);
    if (
      !deferred &&
      (deferredBefore !== undefined ||
        (message.heldWhilePaused === true && liveContext.subagentPolicy?.startup?.firstTurnPending() === true))
    ) {
      const admitted = (deferredBefore ?? untilFirstTurnStarted(liveContext)).then(() =>
        inboundOrder.run(() =>
          admitIncomingMessage(
            liveContext,
            from,
            { ...message, heldWhilePaused: undefined },
            channel,
            messageGeneration,
            true,
          ),
        ),
      );
      const settled = admitted.then(
        () => {},
        () => {},
      );
      deferredFromSender.set(from.id, settled);
      void settled.then(() => {
        if (deferredFromSender.get(from.id) === settled) deferredFromSender.delete(from.id);
      });
      return {};
    }
    // A subagent that has not started its first turn, as one whose held sends the broker hands over as it registers,
    // takes a message as context for that turn: written before it, without a turn of its own.
    if (
      message.replyTo === undefined &&
      liveContext.subagentPolicy?.startup?.firstTurnPending() === true
    ) {
      const admission = inboundDeliveries.admit(from, message);
      if (admission.kind !== "reserved") return {};
      const reservation = admission.reservation;
      replyTracker.recordIncomingMessage(from, message);
      const delivered = admitEarlierFromSender(from, messageGeneration)
        .then(() =>
          sendIncomingMessage(
            framePreStartPendingStageMessage({ ...entry, receivedBeforeStart: true }),
            "prelude",
            messageGeneration,
            false,
          ),
        )
        .then(
          () => inboundDeliveries.commit(reservation),
          (error: unknown) => inboundDeliveries.release(reservation, toError(error)),
        );
      startupDeliveries.add(delivered);
      void delivered.finally(() => startupDeliveries.delete(delivered));
      await delivered;
      return {};
    }
    const admission = inboundDeliveries.admit(from, message);
    if (admission.kind !== "reserved") return {};
    const reservation = admission.reservation;
    if (routeIncomingReply(replyWaiters.pending(), from, message)) {
      inboundDeliveries.commit(reservation);
      return {};
    }
    // #4751: a reply to one of this session's asks arrives as a message on its own thread; a refusal is a failed ask.
    const askReply = outboundAskFor(from, message);
    // #5095: an ask has one outcome. A failure for one already answered is not shown; one after a failure still is.
    if (askReply?.state === "answered" && message.replyError !== undefined) {
      void durableInbox.handledWithoutCard(message.id);
      inboundDeliveries.commit(reservation);
      return {};
    }
    if (askReply !== undefined) void outboundAsks.settle(askReply.ask.askId, message.replyError === undefined ? "answered" : "failed");
    if (isDeliveryFeedback(message) && askReply === undefined) {
      // Correlated asks were resolved above. A refusal of a fire-and-forget
      // send is feedback, not a new conversation to queue until parent idle.
      await admitEarlierFromSender(from, messageGeneration).then(
        () =>
          retryStableDelivery({
            deliver: () => sendIncomingMessage(entry, "prelude", messageGeneration, false),
            isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
          }),
      ).then(
        () => inboundDeliveries.commit(reservation),
        (error) => inboundDeliveries.release(reservation, toError(error)),
      );
      return {};
    }
    const replyContext = replyTracker.recordIncomingMessage(from, message);
    const commit = (): void => { inboundDeliveries.commit(reservation); };
    const release = createInboundDeliveryFailureHandler({
      entry,
      admission: inboundDeliveries,
      reservation,
      tracker: replyTracker,
      replyContext,
      currentClient: () => client,
      // Only a failure reply to the sender commits here; the message itself is never shown.
      commit: () => {
        void durableInbox.handledWithoutCard(message.id);
        commit();
      },
      failurePrefix: liveContext.subagentPolicy?.executionEnded === undefined ? undefined : "Subagent could not admit intercom ask",
    });
    if (liveContext.subagentPolicy?.executionEnded !== undefined) {
      // An active subagent admits through its own FIFO; anything this sender left waiting goes first.
      try {
        await admitEarlierFromSender(from, messageGeneration);
      } catch (error) {
        release(error);
        return {};
      }
    }
    const activeDelivery = admitActiveSessionInbound(liveContext, () => {
      replyTracker.queueTurnContext(replyContext);
      // The sender chooses delivery. The default steer lands after the in-flight
      // tool calls and never cancels the receiver's work; followUp waits until the
      // agent stops; only an explicit interrupt cancels the supported active
      // operation and continues the same task with the message.
      const delivery = message.delivery === "interrupt"
        ? "interrupt"
        : message.delivery === "followUp" ? "triggerFollowUp" : "trigger";
      return retryStableDelivery({
        deliver: () => sendIncomingMessage(entry, delivery, messageGeneration, false),
        isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) &&
          liveContext.subagentPolicy?.executionEnded?.aborted !== true &&
          liveContext.subagentPolicy?.messageAdmission?.isOpen() !== false,
      });
    });
    if (activeDelivery !== false) {
      void activeDelivery.then(commit, release);
      return {};
    }
    try {
      const activeContext = getLiveContext(liveContext, messageGeneration);
      if (!activeContext) {
        release(new Error("Intercom session retired before inbound delivery"));
        return {};
      }
      // #4751: the reply to an ask starts a turn when idle and otherwise arrives after the current tool call.
      if (askReply !== undefined) {
        await admitEarlierFromSender(from, messageGeneration);
        await retryStableDelivery({ deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false), isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) });
        commit();
        return {};
      }
      // Parent-addressed peers need not match an exact child handshake. Reach
      // SDK admission while this owner is observing a task: persistence and
      // model-queue insertion then yield its waits, never the child execution.
      if (!activeContext.isIdle() && !activeContext.getAgentTaskHost?.().hasActiveTaskWaits) {
        if (!activeContext.hasUI) {
          const activeClient = client;
          if (!message.replyTo && activeClient?.isConnected()) {
            try {
              const refusal = "Message not accepted: recipient was busy in non-interactive mode. Its task was not interrupted.";
              const result = await activeClient.send(from.id, {
                text: refusal,
                replyTo: message.id,
                replyError: refusal,
              });
              if (result.delivered && getLiveContext(liveContext, messageGeneration)) {
                replyTracker.markReplied(message.id);
              }
            } catch {
              // Best-effort reply; keep the busy non-interactive session running either way.
            }
          }
          await durableInbox.handledWithoutCard(message.id);
          commit();
          return {};
        }
        // Establish queue ownership before probing asynchronously. If a terminal
        // barrier wins the race, the later foreground callback cannot redeliver.
        pendingIdleMessages.enqueue(entry);
        commit();
        // The foreground owner's handshake runs outside the line: only what it surfaces takes a new place.
        const handoff = handleForegroundInboundDelivery({
          handoff: foregroundDetachHandoff,
          from,
          message,
          generation: messageGeneration,
          surface: () => {
            void inboundOrder
              .run(async () => {
                // The surfaced message goes with the messages its sender queued before it, never ahead of them.
                const surfaced = pendingIdleMessages.takeFromSenderThrough(entry);
                if (surfaced.length === 0) return;
                if (pendingIdleMessages.size === 0) clearInboundFlushTimer();
                for (const earlier of surfaced.slice(0, -1)) {
                  await retryStableDelivery({
                    deliver: () => sendIncomingMessage(earlier, "prelude", messageGeneration, false),
                    isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
                  });
                }
                replyTracker.queueTurnContext(replyContext);
                await retryStableDelivery({ deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false), isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) });
              })
              .catch(() => {});
          },
          isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)),
          onUnclaimed: () => {
            // No exact foreground owner acknowledged the target. Preserve the
            // established background/cross-session behavior by waiting for idle.
            if (pendingIdleMessages.has(entry)) scheduleInboundFlush(INBOUND_IDLE_RETRY_MS);
          },
          onDelivered: () => { pendingIdleMessages.remove(entry); },
        }).catch((error: unknown) => release(error));
        return { done: handoff };
      }
      // Observing parents still owe the exact child first refusal: its commit
      // releases parallel/queued sibling observations as well as its own wait.
      // Unrelated peers remain unclaimed and reach protected SDK admission.
      if (!activeContext.isIdle()) {
        const disposition = await foregroundDetachHandoff.claim(from, message, messageGeneration, () => Boolean(getLiveContext(liveContext, messageGeneration)));
        if (disposition === "abandoned") {
          release(new Error("Intercom session retired during foreground-owner admission"));
          return {};
        }
      }
      await admitEarlierFromSender(from, messageGeneration);
      replyTracker.queueTurnContext(replyContext);
      await retryStableDelivery({ deliver: () => sendIncomingMessage(entry, "trigger", messageGeneration, false), isCurrent: () => Boolean(getLiveContext(liveContext, messageGeneration)) });
      commit();
    } catch (error) {
      release(error);
    }
    return {};
  }
  function attachClientHandlers(nextClient: IntercomClient): void {
    nextClient.on("message", (from: SessionInfo, message: Message, channel?: "supervisor") => {
      if (client !== nextClient || !getLiveContext()) {
        return;
      }
      receiveIncomingMessage(nextClient, from, message, channel);
    });
    nextClient.on("released_child_reply", (notice: ReleasedChildReply) => {
      const request: ReleasedChildReplyRequest = { childName: notice.childName, replyTo: notice.replyTo, message: notice.message };
      if (client === nextClient && getLiveContext()) pi.events.emit(RELEASED_CHILD_REPLY_EVENT, request);
      void (request.completion ?? Promise.resolve(false)).then(
        (accepted) => nextClient.acknowledgeReleasedChildReply(notice, accepted === true, accepted === "deliver"),
        () => nextClient.acknowledgeReleasedChildReply(notice, false),
      );
    });
    // #4326: a send waits at the broker for a released child of this session; Subagents wakes it.
    nextClient.on("restoring_recipient_wake", (notice: { childName: string }) => {
      const wake: ReleasedChildWakeNotice = { childName: notice.childName };
      pi.events.emit(SUBAGENT_RELEASED_CHILD_WAKE_EVENT, wake);
    });
    // #5999: a message waits at the broker for a child of this session that ended; Subagents resumes it, and answers.
    nextClient.on("ended_child_wake", (notice: EndedChildWakeNotice) => {
      let told = false;
      const answer = (accepted: boolean, reason?: string): void => {
        nextClient.answerEndedChildWake(notice.childName, notice.wakeId, accepted, reason);
        if (!accepted || told || client !== nextClient || !getLiveContext()) return;
        told = true;
        // The user sees, where the child's result will arrive, who woke it and why.
        const waker = notice.from.name ?? notice.from.id;
        void Promise.resolve(
          pi.sendMessage(
            {
              customType: ENDED_CHILD_WAKE_MESSAGE_TYPE,
              content: `Resuming subagent \`${notice.childName}\`${notice.childId === undefined ? "" : ` (${notice.childId})`} for an Intercom message from ${waker}. It stays this session's subagent: its result arrives here.`,
              display: true,
              details: { childName: notice.childName, childId: notice.childId, from: notice.from, depth: notice.depth },
            },
            { triggerTurn: false },
          ),
        ).catch(() => {});
      };
      const request: EndedChildWakeRequest = {
        childName: notice.childName,
        ...(notice.childId === undefined ? {} : { childId: notice.childId }),
        from: notice.from,
        depth: notice.depth,
        answer,
      };
      if (client === nextClient && getLiveContext()) {
        try {
          pi.events.emit(SUBAGENT_ENDED_CHILD_WAKE_EVENT, request);
        } catch {
          // Answered below as not taken.
        }
      }
      if (request.handled !== true) answer(false, "the session that launched it cannot resume subagents right now");
    });
    // #5999: the broker that kept messages queued for subagents that ended is gone: each fails here, once, as the broker
    // would have failed it, so an ask settles failed and a send shows that it was not delivered.
    nextClient.on("ended_queue_lost", (lost: readonly LostEndedQueuedMessage[]) => {
      if (client !== nextClient || !getLiveContext()) return;
      for (const kept of lost) {
        // Durable wake queue: only a broker that kept the queue in memory, or an older one, loses it; the message may have
        // reached its subagent just before, which this session cannot know.
        const reason = `Intercom restarted before ${kept.logicalTarget} ${kept.queue === "resuming" ? "was resumed for this message" : "was continued"}, and the message queued for it was lost, unless it had just reached it. Send it again if it is still needed.`;
        const now = Date.now();
        receiveIncomingMessage(
          nextClient,
          { id: kept.to, name: kept.logicalTarget, cwd: "", model: "", pid: 0, startedAt: now, lastActivity: now },
          { id: `wake-lost:${kept.messageId}`, timestamp: now, replyTo: kept.messageId, replyError: reason, content: { text: reason } },
        );
      }
    });
    nextClient.on("peer_disconnected", (notice: PeerDisconnectNotice) => {
      if (client !== nextClient) {
        return;
      }
      if (routePeerDisconnect(replyWaiters.pending(), notice)) return;
      // #4751: an ask whose recipient session ended comes back as a failed-ask message.
      const record = outboundAsks.find(notice.replyTo);
      if (record === undefined || record.state !== "pending") return;
      const liveContext = getLiveContext();
      if (!liveContext) return;
      const generation = runtimeGeneration;
      const entry = recipientClosedAskEntry(record.ask, { sessionId: notice.peerSessionId, ...(notice.peerName === undefined ? {} : { name: notice.peerName }) });
      // Saved like any arriving message first, so a restart before the card is written still shows it once.
      void durableInbox.receive(entry.from, entry.message, undefined, () => {}).then(async (arrival) => {
        if (arrival !== "fresh") return;
        await retryStableDelivery({
          deliver: () => sendIncomingMessage(entry, "trigger", generation, false),
          isCurrent: () => Boolean(getLiveContext(liveContext, generation)),
        });
        await outboundAsks.settle(record.ask.askId, "failed");
      }).catch(() => {});
    });
    nextClient.on("peer_rebound", (notice: { replyTo: string; previousSessionId: string; sessionId: string }) => {
      if (client !== nextClient) return;
      replyWaiters.rebind(notice.replyTo, notice.previousSessionId, notice.sessionId);
    });
    nextClient.on("disconnected", (error: Error) => {
      if (client !== nextClient) {
        return;
      }
      rejectReplyWaiter(new Error(`Disconnected while waiting for reply: ${error.message}`, { cause: error }));
      client = null;
      // A child that registered without its refused capability offers it again on its next connection: its
      // supervisor may be back by then, as after a broker restart.
      supervisorRefusal = undefined;
      supervisorRefusedSince = undefined;
      supervisorRefusalAttempts = 0;
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
    if (disposed || shuttingDown || reconnectTimer || reconnectPromise || client?.isConnected() || !getLiveContext()) {
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
        // ensureConnected queues the next retry from its `finally`, once it has released
        // ownership of `reconnectPromise`.
      });
    }, reconnectDelayMs(reconnectAttempt));
  }
  function persistedIntercomSessionId(ctx: ExtensionContext, sessionId: string): string | undefined {
    try {
      return readIntercomSessionIdentity(ctx.sessionManager.getEntries(), sessionId);
    } catch {
      return undefined;
    }
  }
  /** Remember the Intercom id this session registered under, so a resume or restore can ask for it back (#3760). */
  async function recordIntercomSessionIdentity(sessionId: string, intercomSessionId: string): Promise<void> {
    try {
      await pi.appendEntry(INTERCOM_SESSION_IDENTITY_ENTRY, {
        sessionId,
        intercomSessionId,
      } satisfies IntercomSessionIdentity);
    } catch {
      // Best effort: without the record a later restart registers under a fresh id, as before.
    }
  }
  async function ensureConnected(reason: IntercomConnectReason): Promise<IntercomClient> {
    if (reason !== "join") connectionWanted = true;
    if (disposed || shuttingDown) {
      throw new Error("Intercom shutting down");
    }
    if (client && client.isConnected()) {
      return client;
    }
    if (terminalHomeGroupError !== null) throw terminalHomeGroupError;
    const contextAtStart = getLiveContext();
    const generationAtStart = runtimeGeneration;
    if (!contextAtStart || !currentSessionId || sessionStartedAt === null) {
      throw new Error("Intercom runtime not initialized");
    }
    clearReconnectTimer();
    if (reconnectPromise && reconnectPromiseGeneration === generationAtStart) {
      return reconnectPromise;
    }
    // Ownership has to be recorded before the connect body can settle. A body that rejects
    // before its first suspension point runs its `finally` while `reconnectPromise` is still
    // unassigned, and the assignment below then parks an already-settled promise there for
    // good: every later `scheduleReconnect()` reads that dead promise as an owner and returns,
    // and every later `ensureConnected` hands the same stale rejection back instead of
    // attempting a connection.
    const ownershipRecorded = Promise.withResolvers<void>();
    const sessionIdAtStart = currentSessionId;
    // #3760: a resumed session or restored subagent registers under the Intercom id its peers already know.
    const preferredSessionId = persistedIntercomSessionId(contextAtStart, sessionIdAtStart);
    const { signal } = connectAbort;
    const nextReconnectPromise = (async () => {
      let connectFailed = false;
      await ownershipRecorded.promise;
      let retiringRetries = 0;
      let retiringDeadline: number | undefined;
      try {
        for (;;) {
		const nextClient = new IntercomClient(sessionIdAtStart, {
			preferredSessionId,
			acknowledgesReceipt: true,
			connectTimeoutMs: testOverrides.connectTimeoutMs?.(sessionIdAtStart),
			reach: currentReachPolicy,
			// #5999: what a lost broker kept for subagents that ended is known to the next connection.
			endedQueue: endedQueueMemory,
		});
          client = nextClient;
          attachClientHandlers(nextClient);
          let childMetadata: ReturnType<typeof currentChildOrchestratorMetadata> = null;
          try {
            await testOverrides.beforeConnectAttempt?.(reason);
            await startBrokerIfNeeded(signal);
            const expectedRouting = await settleBrokerRouting(contextAtStart, generationAtStart, signal);
            childMetadata = currentChildOrchestratorMetadata();
            // Snapshot after startup awaits: execution may have ended while disconnected.
            // connect writes registration synchronously, so no abort can interleave before that write.
            await nextClient.connect(
              buildRegistration(),
              childMetadata?.supervisor,
              supervisorAuthorizations.ownerToken,
              readSubagentMessageSource(runtimeContext?.subagentPolicy),
              // The registration group is the session's origin, not its memberships or a child's inheritance.
              resolveSessionHomeGroup(),
              expectedRouting,
            );
            // Termination may have won while registration was in flight.
            if (replyCapability() === "terminal") nextClient.updatePresence({ replyCapability: "terminal" });
            await supervisorAuthorizations.restore(nextClient);
            if (!getLiveContext(contextAtStart, generationAtStart)) {
              await nextClient.disconnect();
              throw new IntercomRuntimeInactiveError();
            }
            client = nextClient;
            if (nextClient.sessionId) {
              process.env[INTERCOM_SESSION_ID_ENV] = nextClient.sessionId;
            }
            reconnectAttempt = 0;
            // Registered with the capability: a later refusal starts a new run of retries.
            if (childMetadata?.supervisor !== undefined) {
              supervisorRefusedSince = undefined;
              supervisorRefusalAttempts = 0;
            }
            if (nextClient.sessionId && nextClient.sessionId !== preferredSessionId) {
              await recordIntercomSessionIdentity(sessionIdAtStart, nextClient.sessionId);
            }
            // The broker forgot every reservation this connection made when the last one ended.
            if (nextClient.sessionId) {
              const connected: IntercomConnectedNotice = { sessionId: nextClient.sessionId };
              pi.events.emit(INTERCOM_CONNECTED_EVENT, connected);
            }
            return nextClient;
          } catch (error) {
            if (client === nextClient) client = null;
            // A step after `connect()` succeeded — supervisor-authorization restore — leaves `nextClient`
            // registered at the broker. Dropping the reference without closing the socket leaves a phantom
            // roster row that the retry then duplicates: the broker still answers `delivered: true` for it
            // while `attachClientHandlers` swallows the message on `client === nextClient`. `connectFailed`
            // is set before the `finally` runs, so it reschedules however this disconnect behaves.
            try { await nextClient.disconnect(); } catch {}
            // A supervisor capability the broker refuses never ends the child's start. The refusal may be a race (its
            // supervisor has not reconnected and restored it yet, as after a broker restart), so the child keeps
            // offering it for a while; a capability still refused after that, such as one whose supervisor has
            // released or gone, or a forged one, is dropped and the child registers without it.
            if (
              isSupervisorAuthorizationRefusal(error) &&
              supervisorRefusal === undefined &&
              childMetadata?.supervisor !== undefined &&
              getLiveContext(contextAtStart, generationAtStart)
            ) {
              supervisorRefusedSince ??= Date.now();
              if (Date.now() - supervisorRefusedSince < SUPERVISOR_REFUSAL_RETRY_MS) {
                await pauseUnlessAborted(supervisorRefusalRetryDelayMs(supervisorRefusalAttempts++), signal);
                if (!signal.aborted && getLiveContext(contextAtStart, generationAtStart)) continue;
              } else {
                supervisorRefusal = error instanceof Error ? error.message : String(error);
                continue;
              }
            }
            // The broker retired while this session was registering with it (idle retirement, a restart, a
            // replacement): spawn its successor and register again, rather than failing the start-up or leaving
            // the retry to the one-second background timer.
            if (isIntercomBrokerRetiring(error) || isIntercomRoutingChangedError(error)) {
              retiringDeadline ??= Date.now() + BROKER_RETIRING_RETRY_WINDOW_MS;
              if (
                Date.now() < retiringDeadline &&
                !disposed &&
                !shuttingDown &&
                getLiveContext(contextAtStart, generationAtStart)
              ) {
                await delay(brokerRetiringRetryDelayMs(retiringRetries++), undefined, { signal });
                // The session can be replaced during the wait: the next attempt would then assign its client over the
                // replacement's and register a session that is gone, so the retry goes on only while it is still this one.
                if (getLiveContext(contextAtStart, generationAtStart)) continue;
              }
            }
            if (isIntercomRoutingMismatchError(error) || isProjectGroupError(error)) {
              terminalHomeGroupError = error;
              throw error;
            }
            connectFailed = true;
            throw toError(error);
          }
        }
      } finally {
        if (reconnectPromiseGeneration === generationAtStart) {
          reconnectPromise = null;
          reconnectPromiseGeneration = null;
        }
        // Schedule only after ownership of `reconnectPromise` is released above. Scheduling from
        // `catch` short-circuited on this very promise (`scheduleReconnect()` returns early while
        // `reconnectPromise` is non-null), which left a live runtime with no client, no timer and
        // no promise owning the next attempt. Every failing reason reschedules once a connection is
        // wanted, not just "background": `clearReconnectTimer()` above drops any pending timer before
        // the attempt, so a failed "tool" or "overlay" attempt would otherwise destroy the recovery a
        // background timer already owned. A failed "join" alone arms nothing: the lazy wrapper retries
        // it a bounded number of times. The timer armed for a failed "startup" attempt does not
        // survive: that reason is reachable only from the lazy wrapper's first heavy load, whose
        // rejection path disposes the whole candidate (`index.ts` `cleanupCandidate`), and
        // `cleanupRuntime` clears the timer with it. Do not advertise a startup retry.
        if (connectFailed && connectionWanted && getLiveContext(contextAtStart, generationAtStart)) {
          scheduleReconnect();
        }
      }
    })();
    reconnectPromise = nextReconnectPromise;
    reconnectPromiseGeneration = generationAtStart;
    ownershipRecorded.resolve();
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
    forgetSupervisedChildren: (childNames) => supervisorAuthorizations.forget(childNames),
    resolveSessionTarget: resolveSessionTargetId,
    homeGroup: currentIntercomGroup,
  });

  pi.events.on(SUBAGENT_AWAIT_INTERCOM_PEER_EVENT, (payload) => {
    if (!payload || typeof payload !== "object" || !isAwaitIntercomPeerRequest(payload) || payload.completion) return;
    const request = payload;
    request.completion = ensureConnected("background").then((activeClient) => waitForIntercomPeer(activeClient, request));
  });
  pi.events.on(INTERCOM_INBOX_REPLAY_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as IntercomInboxReplayRequest;
    if (request.completion || !Array.isArray(request.restored)) return;
    request.completion = replayDurableInbox(request);
  });
  pi.events.on(INTERCOM_STARTUP_JOIN_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as IntercomStartupJoinRequest;
    if (request.completion) return;
    request.completion = configReady.then(async () => {
      if (!(startupJoinFromEnv() ?? config.joinAtStartup)) return;
      await ensureConnected("join");
    });
  });
  pi.events.on(INTERCOM_RECOVERY_PEERS_EVENT, (payload) => {
    if (!payload || typeof payload !== "object") return;
    const request = payload as IntercomRecoveryPeersRequest;
    if (request.completion) return;
    request.completion = ensureConnected("background").then((activeClient) => activeClient.listSessions());
  });
  // #3760: the capability was issued to this session's own broker connection, so that connection reserves.
  pi.events.on(SUBAGENT_RESERVE_RESTORING_CHILD_EVENT, (payload) => {
    if (!isReserveRestoringChildRequest(payload) || payload.completion) return;
    const request = payload;
    request.completion = ensureConnected("background").then((activeClient) =>
      activeClient.reserveRestoringRecipient(request.capability, {
        ...(request.group === undefined ? {} : { group: request.group }),
        aliases: request.aliases,
        ...(request.dormant === true ? { dormant: true } : {}),
        ...(request.holdMs === undefined ? {} : { holdMs: request.holdMs }),
      }),
    // #5352: a hold whose publication to other brokers is still pending is in force here; the broker finishes it.
    ).then(() => undefined);
  });
  // #4326: released children are reserved by name for this connection, any number in one call.
  pi.events.on(SUBAGENT_RESERVE_RELEASED_CHILDREN_EVENT, (payload) => {
    if (!isReserveReleasedChildrenRequest(payload) || payload.completion) return;
    const request = payload;
    supervisorAuthorizations.forget(request.children.map((child) => child.childName));
    request.completion = ensureConnected("background").then((activeClient) =>
      activeClient.reserveReleasedChildren(request.children),
    );
  });
  pi.events.on(SUBAGENT_DROP_RELEASED_CHILDREN_EVENT, (payload) => {
    if (!isDropReleasedChildrenRequest(payload) || payload.completion) return;
    const request = payload;
    supervisorAuthorizations.forget(request.childNames);
    const activeClient = client;
    request.completion = activeClient?.isConnected()
      ? activeClient.dropReleasedChildren(request.childNames, {
          ...(request.gone === undefined ? {} : { gone: request.gone }),
          ...(request.refusal === undefined ? {} : { refusal: request.refusal }),
        })
      : Promise.resolve();
  });
  // #4639: how children this session launched ended; a report lives on this connection, like a reservation.
  // #5999: `subagent({ action: "resume" })` of a child another session launched is a message to it that asks to wake it:
  // its launching session resumes it, under the same group and reach rules as any message.
  pi.events.on(SUBAGENT_PEER_RESUME_EVENT, (payload) => {
    if (!isPeerResumeRequest(payload) || payload.completion) return;
    const request = payload;
    // Only through a connection already up: `resume` of an id nobody here answers to keeps its prompt answer.
    const activeClient = client;
    if (activeClient === null || !activeClient.isConnected()) {
      request.completion = Promise.resolve({ kind: "unknown" });
      return;
    }
    request.completion = (async (): Promise<PeerResumeOutcome> => {
      const listed = await activeClient.listSessions();
      const live = resolveSessionTargetIdIn(listed, activeClient.supervisorSessionId, request.to);
      // A live session is running: `resume` refuses it, as it refuses a running child of its own; nothing is sent.
      if (live !== null) {
        const session = listed.find((candidate) => candidate.id === live);
        return { kind: "running", name: session?.name ?? live };
      }
      const result = await activeClient.send(request.to.trim(), {
        text: request.message,
        logicalTarget: request.to,
        wakeEndedRecipient: true,
      });
      if (result.queued === true)
        return result.target === RESUMING_RECIPIENT_TARGET
          ? { kind: "resuming" }
          : result.target === PAUSED_RECIPIENT_TARGET
            ? { kind: "paused" }
            : { kind: "queued" };
      if (result.delivered) return { kind: "delivered" };
      // A subagent that is gone says why; anything else is a target no session or subagent here answers to.
      if (result.error === undefined || !isIntercomRecipientGoneError(result.error)) return { kind: "unknown" };
      return { kind: "refused", reason: result.reason ?? result.error.message };
    })().catch((): PeerResumeOutcome => ({ kind: "unknown" }));
  });
  pi.events.on(SUBAGENT_MARK_ENDED_CHILDREN_EVENT, (payload) => {
    if (!isMarkEndedChildrenRequest(payload) || payload.completion) return;
    const request = payload;
    const activeClient = client;
    request.completion = activeClient?.isConnected()
      ? activeClient.markEndedChildren(request.children)
      : Promise.resolve();
  });
  pi.events.on(SUBAGENT_ACKNOWLEDGE_RELEASED_CHILD_WAKE_EVENT, (payload) => {
    if (!isAcknowledgeReleasedChildWakeRequest(payload) || payload.completion) return;
    const request = payload;
    const activeClient = client;
    request.completion = activeClient?.isConnected()
      ? releaseObservation(request)
        ? activeClient.acknowledgeReleasedChildWake(request.childName, request)
        : activeClient.acknowledgeReleasedChildWake(request.childName)
      : Promise.resolve();
  });
  pi.events.on(SUBAGENT_RELEASE_RESTORING_CHILD_EVENT, (payload) => {
    if (!isReleaseRestoringChildRequest(payload) || payload.completion) return;
    const request = payload;
    if (request.gone !== undefined) supervisorAuthorizations.forgetCapability(request.capability);
    // A reservation ends with the connection that made it, so a disconnected client has nothing to release.
    const activeClient = client;
    request.completion = activeClient?.isConnected()
      ? activeClient.releaseRestoringRecipient(request.capability, {
          ...(request.gone === undefined ? {} : { gone: request.gone }),
          ...(request.refusal === undefined ? {} : { refusal: request.refusal }),
        })
      : Promise.resolve();
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason !== "reload" && currentSessionId) sessionMemberships.delete(currentSessionId);
  });
  registerIntercomLifecycle(pi, {
    config,
    sessionResumable: () => runtimeContext !== null && sessionIsSaved(),
    client: () => client,
    setClient: (value) => {
      client = value;
    },
    setShuttingDown: (value) => { shuttingDown = value; },
    setDisposed: (value) => { disposed = value; },
    setRuntimeStarted: (value) => { runtimeStarted = value; },
    incrementRuntimeGeneration: () => { runtimeGeneration += 1; foregroundDetachHandoff.reset(); return runtimeGeneration; },
    resetReconnectAttempt: () => { reconnectAttempt = 0; },
    clearReconnectTimer,
    abortBrokerStarts: async () => {
      connectAbort.abort(new IntercomRuntimeInactiveError());
      await Promise.all(brokerStarts);
    },
    setRuntimeContext: async (value) => {
      if (value !== null && connectAbort.signal.aborted) connectAbort = new AbortController();
      stopApplyingReach?.();
      stopApplyingReach = undefined;
      intercomPolicy = value === null ? undefined : readIntercomPolicy(value);
      stopApplyingReach = intercomPolicy?.onReachableChange(() => applyReach());
      brokerRouting = null;
      homeRoutedAcrossMachines = null;
      defaultGroupWarned = false;
      terminalHomeGroupError = null;
      runtimeContext = value;
      if (value === null) {
        selectedSharedStorage = false;
        releaseJoinedGroups();
        sessionHomeGroup = null;
        return;
      }
      inboundDeliveries.restore(value.sessionManager.getBranch(), [], value.sessionManager.getAdmissionKeys?.());
      await configReady;
      selectedSharedStorage = await multiNodeSelectedAsync(dirname(getIntercomDirPath()), await processStorageEnvironmentAsync());
      try {
        await warmProjectGroup(value);
        sessionHomeGroup = resolveHomeGroup(config, value, projectGroupOf(value));
      } catch (error) {
        // Git could not name the project group. The session still starts; its first connection resolves the home
        // group again after it verifies the broker's routing and reports this typed error before any registration.
        if (!isProjectGroupError(error)) throw error;
        sessionHomeGroup = null;
      }
    },
    setCurrentSessionId: (value) => { currentSessionId = value; },
    setCurrentModel: (value) => { currentModel = value; },
    setSessionStartedAt: (value) => { sessionStartedAt = value; },
    setAgentRunning: (value) => {
      agentRunning = value;
      if (value) for (const started of agentStartWaiters.splice(0)) started();
    },
    activeTools,
    getLiveContext,
    rejectReplyWaiter,
    releaseRunningReplyWaits: (error) => {
      replyWaiters.releaseRunningWaits(error);
    },
    replyTracker: () => replyTracker,
    bindReplyTracker: (ctx) => {
      // #4751: a restarted recipient can still answer the asks it was sent before the restart.
      try {
        restorePendingInboundAsks(
          replyTracker,
          ctx.sessionManager.getBranch(),
          ctx.sessionManager.getSessionId(),
          ctx.sessionManager.getSessionRecoveryState?.().answeredInboundIds,
        );
      } catch {
        // A session without a readable branch has no earlier asks to restore.
      }
    },
    pendingIdleMessages,
    clearInboundFlushTimer,
    scheduleInboundFlush,
    syncPresenceStatus,
    syncPresenceIdentity,
    restoreIntercomSessionIdEnv,
    currentStatus,
  });
  pi.on("session_start", async (event, ctx) => {
    // A reload keeps the memberships this process held. A restart or resume reopens the session from its
    // store, so it rejoins the groups its own last `join`/`leave` recorded there (#4079), before the session
    // first connects: its registration then carries them, as a reconnect's does.
    const retainedMemberships = event.reason === "reload"
      ? sessionMemberships.get(ctx.sessionManager.getSessionId())
      : persistedJoinedGroups(ctx);
    const reach = currentReachPolicy();
    if (retainedMemberships) setJoinedGroups(reach === undefined ? retainedMemberships : narrowMemberships(reach, retainedMemberships));
    // An admitted child registers at startup so its supervisor and peers can
    // list and steer it before it uses Intercom itself.
    if (ctx.subagentPolicy?.intercom !== undefined) {
      // A start given up already never registers: its session is disposed unused.
      const startup = ctx.subagentPolicy.startup;
      if (startup?.signal.aborted === true) return;
      const registered = await ensureConnected("startup");
      // A start given up before its first turn leaves Intercom at once, before its session is disposed: later sends
      // wait for the retry instead of reaching a session that will never run a turn.
      startup?.signal.addEventListener(
        "abort",
        () => {
          // The signal aborts only when the start runs out of its budget, before the child's first turn.
          shuttingDown = true;
          clearReconnectTimer();
          const leaving = client;
          client = null;
          void leaving?.disconnect().catch(() => undefined);
        },
        { once: true },
      );
      // The sends the broker held for it follow its registration on the same connection: one round trip later
      // they have all arrived, and its first turn waits until they are written as its context.
      if (startup?.firstTurnPending() === true) {
        await registered.listSessions().catch(() => undefined);
        await settledWithin(
          Promise.allSettled([...arrivalsInFlight, ...startupDeliveries]),
          STARTUP_ARRIVALS_WAIT_MS,
        );
      }
    }
  });


  pi.registerMessageRenderer("intercom_message", renderIntercomCustomMessage);

  const replyWaits = replyWaitGates(() => client);
  /**
   * A child registered without the supervisor capability the broker kept refusing registers again with it, once: its
   * supervisor may be back. Refused again, it registers without it at once, as before.
   */
  async function retrySupervisorAuthorization(): Promise<void> {
    if (supervisorRefusal === undefined || disposed || shuttingDown) return;
    const current = client;
    supervisorRefusal = undefined;
    // One attempt: a refusal now drops the capability again without the wait a start gives it.
    supervisorRefusedSince = Date.now() - SUPERVISOR_REFUSAL_RETRY_MS;
    client = null;
    await current?.disconnect().catch(() => undefined);
    await ensureConnected("tool");
  }
  registerContactSupervisorTool(pi, {
    childOrchestratorMetadata: currentChildOrchestratorMetadata,
    retrySupervisorAuthorization,
    ensureConnected,
    syncPresenceIdentity,
    resolveSessionTarget: resolveSessionTargetId,
    beginReplyWait: (from, replyTo, signal) => replyWaiters.begin(from, replyTo, signal),
    ...replyWaits,
  });
  registerIntercomTool(pi, {
    childOrchestratorMetadata: currentChildOrchestratorMetadata,
    ensureConnected,
    syncPresenceIdentity,
    beginReplyWait: (from, replyTo, signal, timeoutMs) => replyWaiters.begin(from, replyTo, signal, timeoutMs),
    ...replyWaits,
    get confirmSend() {
      return config.confirmSend;
    },
    homeGroup: resolveSessionHomeGroup,
    reachPolicy: currentReachPolicy,
    multiNodeRouting,
    setJoinedGroups: async (groups) => {
      setJoinedGroups(groups);
      await persistJoinedGroups(groups);
    },
    clearJoinedGroups: async () => {
      clearJoinedGroups();
      await persistJoinedGroups(null);
    },
    replyTracker: () => replyTracker,
    outboundAsks,
    cancelReplyWait: (askId) => replyWaiters.cancel(askId, new Error("Ask cancelled")),
  });
  registerIntercomOverlay(pi, {
    runtimeGeneration: () => runtimeGeneration,
    getLiveContext,
    notifyIfLive,
    ensureConnected,
    syncPresenceIdentity,
  });
  return configReady;
}
