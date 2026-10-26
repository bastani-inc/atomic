// MUST stay first: ESM evaluates static dependencies before the importer's body, so this is the
// only position from which the stderr cap covers the other modules' own initialization.
import "./bounded-stderr-install.js";
import net from "net";
import { chmodSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, statSync } from "fs";
import { dirname } from "path";
import { randomUUID } from "crypto";
import { createMessageReader, type JsonWireValue } from "./framing.js";
import {
  discardHeldWrites,
  flushHeldWrites,
  type HeldWrite,
  holdWrites,
  releaseHeldWrites,
  writeMessageIfOpen,
  writeMessageWithOutcome,
} from "./socket-writes.js";
import { boundWorkflowPossibleStageRow } from "../workflow-delivery-states.js";
import { isSocketAnswering } from "./socket-liveness.js";
import { acquireSocketReplacementLock } from "./socket-replacement-lock.js";
import { startBrokerWatchdog } from "./watchdog.js";
import {
	getBrokerDeliveredMessagesPath,
	getBrokerPidPath,
	getBrokerWatchdogLogPath,
	getBrokerSocketPath,
	getBrokerSocketReplacementLockPath,
	getIntercomDirPath,
} from "./paths.js";
import { describeSharedStorage, sharedStorageDigest, sharedStorageSettingSource } from "./shared-storage-setting.js";
import type {
	SessionInfo,
	Message,
	BrokerMessage,
	BrokerStatusReport,
	SupervisorRegistration,
	WorkflowStageRosterAnnouncement,
	WorkflowStageRosterEntry,
	WorkflowPossibleStageAnnouncement,
	WorkflowFutureStageRosterEntry,
	WorkflowRunParentAnnouncement,
	PendingStageRouteRefusalCode,
} from "../types.js";
import {
	formatWorkflowStageTarget,
	parseWorkflowStageTarget,
	withWorkflowStageTargetFinalSegment,
} from "../workflow-stage-target.js";
import { DELIVERED_MESSAGE_MAX_ENTRIES, DeliveredMessageCache } from "./delivered-message-cache.js";
import { isMessage } from "./client-message-validation.js";
import { buildMessageSendSignature } from "./send-signature.js";
import {
	deliveryTargetIdentity,
	handleBrokerSend,
	type BrokerConnectedSession,
	type PendingStageRoute,
	type RemoteSendRequest,
	type RemoteSendRouter,
	type RestoringRecipientHold,
	type SendClientMessage,
	senderGroupIdentity,
} from "./send-handler.js";
import {
  type BrokerStateOpener,
  LOCAL_RETRY_LOOKUP_BOUND_MS,
  MultiNodeRouter,
  readSharedStorageSetting,
  resolveMultiNodeStartup,
  SHARED_STORAGE_UNAVAILABLE_REASON,
} from "./multinode-router.js";
import { OUTBOX_BACKUP_POLL_INTERVAL_MS } from "./multinode-state-store.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { SessionIdReclaim } from "./session-id-reclaim.js";
import { type HeldSend, RestoringRecipients } from "./restoring-recipients.js";
import { hasGroup, normalizeGroup, normalizeGroups, workflowInvocationGroupRefusal } from "../group.js";
import { handleBrokerPresence } from "./presence-handler.js";
import {
	knownGroupSummaries,
	sessionGroups,
	setSessionGroups,
} from "./group-membership.js";
import { replyToList } from "./list-reply.js";
import { PendingQuestionIndex } from "./pending-question-index.js";
import { type ReceiptSender, RecipientReceipts, UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { matchStagePathSegments } from "../workflow-stage-path-matching.js";
import { DELIVERED_MESSAGE_TTL_MS } from "../retry-policy.js";
import { isAgentRecipient } from "../recipient-purpose.js";
import {
	LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_REASONS,
	type LiveWorkflowStageRouteRefusalCode,
} from "../live-route-refusal.js";

const INTERCOM_DIR = getIntercomDirPath();
const SOCKET_PATH = getBrokerSocketPath();
const BROKER_IDLE_TIMEOUT_MS = 5_000;
const UNCLASSIFIED_CONNECTION_RECHECK_MS = 100;
const PID_PATH = getBrokerPidPath();
const SOCKET_REPLACEMENT_LOCK_PATH = getBrokerSocketReplacementLockPath();

const PENDING_STAGE_MESSAGE_TIMEOUT_MS = 10_000;
const LISTEN_ATTEMPTS = 5;
const LISTEN_RETRY_DELAY_MS = 100;
const SOCKET_OWNERSHIP_CHECK_MS = 1_000;
const MULTI_NODE_CLOSE_BOUND_MS = 2_000;
const NO_SHARED_STORAGE_REASON = "no shared storage selection (top-level `storage` in global settings, or ATOMIC_STORAGE)";
/** The off reasons `resolveBrokerStateSource` reports without an error, as the log and `broker_status` state them. */
const MULTI_NODE_OFF_REASONS: Readonly<Record<string, string>> = {
  "no-storage": "the shared storage selection names no database",
  memory: "the shared storage selection is in memory",
  "domain-only-adapter": "the storage adapter has no openDatabase hook",
};

function exitBecauseLiveBrokerOwnsSocket(): never {
  console.error(`Intercom broker not started: a live broker already answers on ${SOCKET_PATH}`);
  process.exit(0);
}

interface PendingStageRouteRegistration {
  readonly sessionId: string;
  readonly group: string;
  readonly capability: string;
  /** Registered by a restarted owner for an interrupted run; yields to the process that resumes it (#3760). */
  readonly dormant?: true;
}

interface WorkflowRosterRegistration {
	readonly ownerSessionId: string;
	readonly group: string;
	readonly stages: WorkflowStageRosterAnnouncement[];
	readonly possibleStages?: readonly WorkflowPossibleStageAnnouncement[];
	readonly parent?: WorkflowRunParentAnnouncement;
}


interface PendingStageAcknowledgment {
  readonly ownerSessionId: string;
  readonly senderSocket: net.Socket;
  readonly messageId: string;
  readonly attemptId?: string;
	readonly runId: string;
	readonly target: string;
	readonly senderSessionId: string;
	readonly sender: SessionInfo;
	readonly message: Message;
	readonly liveTargetId?: string;
	readonly signature?: string;
	readonly resolveReplyTarget?: true;
  readonly timeout: NodeJS.Timeout;
}

interface PendingStageNotificationAcknowledgment {
	readonly ownerSessionId: string;
	readonly recipientSessionId: string;
	readonly senderSocket: net.Socket;
	readonly messageId: string;
	readonly attemptId?: string;
	readonly signature: string;
	readonly timeout: NodeJS.Timeout;
}

interface LiveWorkflowStageRouteRegistration {
  readonly sessionId: string;
  readonly capability: string;
  /** Run whose route registration authorized this alias; capabilities are per run. */
  readonly runId: string;
}

interface LiveWorkflowStageRouteActivation {
  readonly sessionId: string;
  readonly pendingRequestIds: Set<string>;
}

type ConnectedSession = BrokerConnectedSession;

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.group !== undefined && typeof session.group !== "string") {
    return false;
  }

  if (session.replyCapability !== undefined && session.replyCapability !== "live" && session.replyCapability !== "terminal") return false;
  if (session.recipientPurpose !== undefined &&
    session.recipientPurpose !== "agent" && session.recipientPurpose !== "control") {
    return false;
  }
  if (session.groups !== undefined &&
    (!Array.isArray(session.groups) || !session.groups.every((group) => typeof group === "string"))) {
    return false;
  }
  return session.status === undefined || typeof session.status === "string";
}
function isSupervisorRegistration(value: unknown): value is SupervisorRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const registration = value as Record<string, unknown>;
  return typeof registration.capability === "string"
    && typeof registration.supervisorSessionId === "string";
}

const RESTORING_RECIPIENT_ALIASES_MAX = 4;
const RESTORING_RECIPIENT_GONE_REASON_MAX = 1_000;
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRestoringRecipientAliasList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= RESTORING_RECIPIENT_ALIASES_MAX && value.every((alias) => typeof alias === "string");
}

/**
 * A restoring subagent's extra targets are ids only: its Atomic session id and its pre-restart Intercom id (#3760).
 * Its name comes from the supervisor capability, so no reservation can claim another child's name.
 */
function isRestoringRecipientAlias(alias: string): boolean {
  return SESSION_ID_PATTERN.test(alias.trim());
}

function invocationOwnsGroup(invocationGroup: string, candidateGroup: string): boolean {
	const owner = normalizeGroup(invocationGroup);
	const candidate = normalizeGroup(candidateGroup);
	return candidate === owner || candidate.startsWith(`${owner}/`);
}

function readWorkflowRunParentAnnouncement(value: JsonWireValue | undefined): WorkflowRunParentAnnouncement | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	if (
		typeof value.runId !== "string" ||
		!Array.isArray(value.stageKeys) ||
		!value.stageKeys.every((key) => typeof key === "string")
	) return undefined;
	return { runId: value.runId, stageKeys: value.stageKeys };
}

function isWorkflowStageRosterAnnouncements(
	value: unknown,
	runId: string,
	invocationGroup: string,
): value is WorkflowStageRosterAnnouncement[] {
	const groupRootRunId = invocationGroup.startsWith("workflow:")
		? invocationGroup.slice("workflow:".length)
		: undefined;
	return (
		Array.isArray(value) &&
		value.every((stage) => {
			if (typeof stage !== "object" || stage === null) return false;
			const announcement = stage as WorkflowStageRosterAnnouncement;
			const parsed = parseWorkflowStageTarget(announcement.target);
			return (
				typeof announcement.stageId === "string" &&
				typeof announcement.stageName === "string" &&
				parsed?.kind === "path" &&
				parsed.segments.at(-1) === announcement.stageId &&
				// Depth-faithful targets are anchored at the invocation root even when the
				// announcing run is a nested descendant whose run id appears in no segment
				// position (boundary-name segments). The runId conditions keep the flat
				// shortcut form valid for hosts that have not adopted the clarified form.
				((groupRootRunId !== undefined && groupRootRunId === parsed.rootRunId) ||
					runId === parsed.rootRunId ||
					parsed.segments.slice(0, -1).includes(runId)) &&
				(announcement.lifecycle === "pending" || announcement.lifecycle === "running") &&
				typeof announcement.routeEligible === "boolean" &&
				(announcement.recipientPurpose === undefined ||
					announcement.recipientPurpose === "agent" ||
					announcement.recipientPurpose === "control") &&
				typeof announcement.group === "string"
			);
		})
	);
}
function isWorkflowPossibleStageAnnouncements(
	value: unknown,
	runId: string,
	invocationGroup: string,
): value is WorkflowPossibleStageAnnouncement[] {
	const groupRootRunId = invocationGroup.startsWith("workflow:")
		? invocationGroup.slice("workflow:".length)
		: undefined;
	return (
		Array.isArray(value) &&
		value.every((row) => {
			if (typeof row !== "object" || row === null) return false;
			const announcement = row as WorkflowPossibleStageAnnouncement;
			const parsed = parseWorkflowStageTarget(announcement.target);
			return (
				parsed !== undefined &&
				((groupRootRunId !== undefined && groupRootRunId === parsed.rootRunId) || runId === parsed.rootRunId) &&
				typeof announcement.queuedCount === "number" &&
				Number.isInteger(announcement.queuedCount) &&
				announcement.queuedCount >= 0 &&
				(announcement.deliveryOnly === undefined || announcement.deliveryOnly === true) &&
				(announcement.omittedDeliveryStates === undefined ||
					(Number.isInteger(announcement.omittedDeliveryStates) && announcement.omittedDeliveryStates >= 0)) &&
				(announcement.deliveryStateCounts === undefined ||
					(typeof announcement.deliveryStateCounts === "object" &&
						announcement.deliveryStateCounts !== null &&
						Object.values(announcement.deliveryStateCounts).every(
							(count) => Number.isInteger(count) && count >= 0,
						))) &&
				(announcement.deliveryStates === undefined || (Array.isArray(announcement.deliveryStates) && announcement.deliveryStates.every((delivery) =>
					delivery !== null && typeof delivery === "object" &&
					typeof delivery.messageId === "string" && typeof delivery.runId === "string" &&
					typeof delivery.stageId === "string" && typeof delivery.state === "string" &&
					typeof delivery.reason === "string" && (delivery.sessionId === undefined || typeof delivery.sessionId === "string"))))
			);
		})
	);
}


class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private unclassifiedConnections = new Map<net.Socket, number>();
  private server: net.Server;
  private readonly instanceId = randomUUID();
  private shutdownTimer: NodeJS.Timeout | null = null;
  private boundSocketInode: number | undefined;
  private lastConnectionAt = performance.now();
  private deliveredMessages = new DeliveredMessageCache(
	DELIVERED_MESSAGE_TTL_MS,
	DELIVERED_MESSAGE_MAX_ENTRIES,
	getBrokerDeliveredMessagesPath(),
  );
  private supervisorChannel = new SupervisorChannelCache();
  private sessionIdReclaim = new SessionIdReclaim();
  private pendingQuestions = new PendingQuestionIndex();
  private receipts = new RecipientReceipts<ConnectedSession>();
  private restoringRecipients = new RestoringRecipients((held, reason) => this.failHeldSend(held, reason));
  private pendingStageRoutes = new Map<string, PendingStageRouteRegistration>();
  private pendingStageAcknowledgments = new Map<string, PendingStageAcknowledgment>();
	private pendingStageNotificationAcknowledgments = new Map<string, PendingStageNotificationAcknowledgment>();
  private liveWorkflowStageRoutes = new Map<string, LiveWorkflowStageRouteRegistration>();
  private workflowRosters = new Map<string, WorkflowRosterRegistration>();
  private liveWorkflowStageRouteActivations = new Map<string, LiveWorkflowStageRouteActivation>();
  /**
   * #4006: runs each connected session launched, proven with the run's route capability. Keyed by session,
   * then run, holding the capability claimed; a claim lapses when the run's route moves to another capability.
   */
  private workflowInvocationClaims = new Map<string, Map<string, string>>();
  /** Multi-node S5: set only when the agent directory's settings select a top-level shared `storage`. */
  private readonly sharedStorageSetting = readSharedStorageSetting(dirname(INTERCOM_DIR));
  private readonly routeRemote: RemoteSendRouter | undefined =
    this.sharedStorageSetting === undefined ? undefined : (request) => this.routeRemoteSend(request);
  private multiNode: MultiNodeRouter | undefined;
  private multiNodeStatus: "starting" | "on" | "off" | "unavailable" = "off";
  /** Why multi-node routing is off or unavailable, for `broker_status` and the log. */
  private multiNodeReason: string | undefined = NO_SHARED_STORAGE_REASON;
  private multiNodeFirstAttempt: Promise<void> = Promise.resolve();
  private shuttingDown = false;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(INTERCOM_DIR, 0o700);
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.listen(1);
    if (this.sharedStorageSetting !== undefined) this.startMultiNode(this.sharedStorageSetting);
    else console.error(`Intercom multi-node routing is off: ${NO_SHARED_STORAGE_REASON}`);
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private listen(attempt: number, releaseReplacementLock: () => void = () => {}): void {
    const onError = (error: NodeJS.ErrnoException) => {
      releaseReplacementLock();
      void this.recoverFromListenError(error, attempt);
    };
    this.server.once("error", onError);
    this.server.listen(SOCKET_PATH, () => {
      this.server.off("error", onError);
      if (process.platform !== "win32") this.boundSocketInode = statSync(SOCKET_PATH).ino;
      releaseReplacementLock();
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
      startBrokerWatchdog(SOCKET_PATH, this.instanceId, getBrokerWatchdogLogPath());
      this.lastConnectionAt = performance.now();
      this.scheduleShutdownCheck();
      if (this.boundSocketInode !== undefined) this.watchSocketOwnership();
    });
  }

  private ownsSocketPath(): boolean {
    if (this.boundSocketInode === undefined) return process.platform === "win32";
    try {
      return statSync(SOCKET_PATH).ino === this.boundSocketInode;
    } catch {
      return false;
    }
  }

  /**
   * A broker whose socket path now leads to another broker can no longer be reached by new clients, so its sessions
   * would be stranded. It shuts down instead, and its clients reconnect through broker.sock to the broker that owns it.
   */
  private watchSocketOwnership(): void {
    const timer = setInterval(() => {
      if (this.ownsSocketPath()) return;
      clearInterval(timer);
      console.error(`Intercom broker lost ${SOCKET_PATH} to another broker; shutting down so its sessions reconnect`);
      this.shutdown();
    }, SOCKET_OWNERSHIP_CHECK_MS);
    timer.unref();
  }

  /** Take over only a stale socket: a path a live broker answers on is never unlinked. */
  private async recoverFromListenError(error: NodeJS.ErrnoException, attempt: number): Promise<void> {
    if (error.code === "EADDRINUSE" && (await isSocketAnswering(SOCKET_PATH))) exitBecauseLiveBrokerOwnsSocket();
    if (error.code !== "EADDRINUSE" || attempt >= LISTEN_ATTEMPTS) {
      console.error(`Intercom broker could not listen on ${SOCKET_PATH}: ${error.message}`);
      process.exit(1);
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => setTimeout(resolve, LISTEN_RETRY_DELAY_MS));
      this.listen(attempt + 1);
      return;
    }
    const releaseReplacementLock = await acquireSocketReplacementLock(SOCKET_REPLACEMENT_LOCK_PATH, {
      onWait: () => console.error(`Intercom broker waiting for another broker replacing ${SOCKET_PATH}`),
    });
    // Another broker may have replaced the stale socket while this one waited for the lock.
    if (await isSocketAnswering(SOCKET_PATH)) {
      releaseReplacementLock();
      exitBecauseLiveBrokerOwnsSocket();
    }
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // A clean path has no stale socket to remove.
    }
    this.listen(attempt + 1, releaseReplacementLock);
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;
    this.unclassifiedConnections.set(socket, performance.now());
    const recordActivity = () => {
      this.lastConnectionAt = performance.now();
      this.restartShutdownCheck();
    };

    const reader = createMessageReader((msg) => {
      if (socket.destroyed || socket.writableEnded) return;
      if (this.unclassifiedConnections.delete(socket)) {
        const health = typeof msg === "object" && msg !== null && !Array.isArray(msg) && msg.type === "health";
        if (!health) recordActivity();
      }
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    // Retire the session as soon as its socket stops being able to accept a
    // frame, not only on 'close'. A peer that half-closes -- or one whose
    // writable side the broker itself ended after refusing a registration --
    // can keep its read side open indefinitely, so 'close' may never arrive
    // while the session is still in the fan-out map and every broadcast, ack
    // and delivery targets a socket whose writable side is already gone.
    //
    // 'end' is a safe retirement point: Node runs its automatic end() after the
    // user listeners, so the socket is still writable here and no final frame
    // is lost. disconnectSession is idempotent, so 'end', 'error' and 'close'
    // may each fire without duplicating the departure broadcast.
    const retire = () => {
      if (this.unclassifiedConnections.delete(socket)) recordActivity();
      const departing = sessionId;
      if (departing === null) return;
      sessionId = null;
      this.disconnectSession(departing);
    };

    socket.on("end", () => {
      retire();
      this.scheduleShutdownCheck();
    });

    socket.on("close", () => {
      retire();
      this.scheduleShutdownCheck();
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
      retire();
      this.scheduleShutdownCheck();
    });
  }

  private scheduleShutdownCheck(delayMs = BROKER_IDLE_TIMEOUT_MS): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        const now = performance.now();
        const awaitingFirstFrame = [...this.unclassifiedConnections.values()]
          .some((acceptedAt) => now - acceptedAt < BROKER_IDLE_TIMEOUT_MS);
        if (awaitingFirstFrame) {
          this.scheduleShutdownCheck(UNCLASSIFIED_CONNECTION_RECHECK_MS);
          return;
        }
        const idleMs = Math.round(performance.now() - this.lastConnectionAt);
        console.log(`No sessions connected for ${idleMs}ms since the last connection, shutting down`);
        this.shutdown();
      }
    }, delayMs);
  }

  private restartShutdownCheck(): void {
    if (!this.shutdownTimer) return;
    clearTimeout(this.shutdownTimer);
    this.shutdownTimer = null;
    this.scheduleShutdownCheck();
  }

  /**
   * End a connection the broker itself is refusing, and retire its session first.
   *
   * `socket.end()` only sends FIN. A peer opened with `allowHalfOpen` — or one
   * that simply has not read yet — never has to close in response, so without
   * this the refused session would stay in the fan-out map indefinitely: still
   * advertised by `list`, still acked as `delivered`, and still written to by
   * every broadcast even though its writable side is gone.
   */
  private endRefusedConnection(
    socket: net.Socket,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (currentId !== null) {
      this.disconnectSession(currentId);
      setId(null);
    }
    socket.end();
    this.scheduleShutdownCheck();
  }
	private pendingStageOwnerForTarget(
		target: string,
	): { readonly runId: string; readonly registration: PendingStageRouteRegistration } | undefined {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed === undefined) return undefined;
		const invocationGroup = normalizeGroup(`workflow:${parsed.rootRunId}`);
		// Slice 3 (D3/D6): pattern and `**` targets are anchored at the invocation root
		// registration — glob segments name no nested run, and the sticky entry lives in
		// the root run's durable bucket.
		if (parsed.kind !== "path") {
			const rootRegistration = this.pendingStageRoutes.get(parsed.rootRunId);
			return rootRegistration !== undefined && normalizeGroup(rootRegistration.group) === invocationGroup
				? { runId: parsed.rootRunId, registration: rootRegistration }
				: undefined;
		}
		let ownerRunId = parsed.rootRunId;
		let registration = this.pendingStageRoutes.get(ownerRunId);
		for (const segment of parsed.segments.slice(0, -1)) {
			const candidate = this.pendingStageRoutes.get(segment);
			if (candidate !== undefined && normalizeGroup(candidate.group) === invocationGroup) {
				ownerRunId = segment;
				registration = candidate;
			}
		}
		return registration === undefined ? undefined : { runId: ownerRunId, registration };
	}

	private resolveLegacyWorkflowStageTarget = (runId: string, stageKey: string): string | undefined => {
		const route = this.pendingStageRoutes.get(runId);
		const roster = this.workflowRosters.get(runId);
		if (route === undefined || roster === undefined || !route.group.startsWith("workflow:")) return undefined;
		const matches = roster.stages.filter((stage) => stage.stageId === stageKey || stage.stageName === stageKey);
		return matches.length === 1 ? matches[0]!.target : undefined;
	};
	private isNonAgentWorkflowTarget = (target: string): boolean => {
		const parsed = parseWorkflowStageTarget(target);
		if (parsed?.kind !== "path") return false;
		// A connected agent's registered alias outlives its pending roster row.
		// A same-name control announcement must not revoke that live identity.
		if (this.resolveLiveWorkflowStage(target) !== undefined) return false;
		const rosters = [...this.workflowRosters].filter(([, roster]) => roster.group === `workflow:${parsed.rootRunId}`);
		let runId: string | undefined = parsed.rootRunId;
		for (const segment of parsed.segments.slice(0, -1)) {
			// Match the host's materialized-stage traversal: run IDs can jump at any
			// depth; otherwise follow a uniquely resolved boundary ID/name edge.
			if (rosters.some(([id]) => id === segment)) {
				runId = segment;
				continue;
			}
			const children = rosters.filter(([, roster]) => roster.parent?.runId === runId && roster.parent.stageKeys.includes(segment));
			runId = children.length === 1 ? children[0]![0] : undefined;
			if (runId === undefined) break;
		}
		const stageKey = parsed.segments.at(-1);
		const stages = rosters.find(([id]) => id === runId)?.[1].stages;
		const byId = stages?.filter((stage) => stage.stageId === stageKey) ?? [];
		// Hosts without parent-edge metadata still support their advertised literal targets.
		const matches = stages === undefined ? rosters.flatMap(([, roster]) => roster.stages.filter((stage) =>
			stage.target === target || withWorkflowStageTargetFinalSegment(stage.target, stage.stageName) === target,
		)) : byId.length > 0 ? byId : stages.filter((stage) => stage.stageName === stageKey);
		return matches.some((stage) => !isAgentRecipient(stage)) && !matches.some(isAgentRecipient);
	};


	private resolveLiveWorkflowStage = (target: string): ConnectedSession | undefined => {
		const registration = this.liveWorkflowStageRoutes.get(target);
		if (registration === undefined) return undefined;
		// The alias is owned by the run that registered it: route capabilities are per run,
		// and for boundary-form targets the depth-first owner resolution selects the root
		// registration, whose capability legitimately differs from the nested stage's own.
		// Validate staleness against the alias's own run registration and require the alias
		// to stay anchored inside the target's invocation.
		const ownRegistration = this.pendingStageRoutes.get(registration.runId);
		const parsed = parseWorkflowStageTarget(target);
		if (
			ownRegistration === undefined ||
			ownRegistration.capability !== registration.capability ||
			parsed === undefined ||
			normalizeGroup(ownRegistration.group) !== normalizeGroup(`workflow:${parsed.rootRunId}`)
		) {
			this.liveWorkflowStageRoutes.delete(target);
			return undefined;
		}
		const session = this.sessions.get(registration.sessionId);
		if (session !== undefined && isAgentRecipient(session.info)) return session;
		this.liveWorkflowStageRoutes.delete(target);
		return undefined;
	};

	private canInspectSelectedGroup(requester: ConnectedSession, selectedGroup: string): boolean {
		const selected = normalizeGroup(selectedGroup);
		const groups = sessionGroups(requester.info);
		for (const roster of this.workflowRosters.values()) {
			if (!roster.stages.some((stage) => stage.group === selected && invocationOwnsGroup(roster.group, selected))) continue;
			return groups.has(selected) || this.canControlWorkflowInvocation(requester, roster.group);
		}
		return true;
	}

	/**
	 * Invocation control may come from the invocation owner, from the session that
	 * launched the run (#4006), or from an ordinary host session that explicitly
	 * joined the invocation group. A workflow stage registered under any workflow
	 * group cannot turn mutable membership into a parent-control capability for a
	 * sibling (or for another workflow run).
	 */
	private canControlWorkflowInvocation(sender: ConnectedSession, invocationGroup: string): boolean {
		return this.controlsWorkflowInvocationByMembership(sender, invocationGroup) || this.launchedWorkflowInvocation(sender, invocationGroup);
	}

	private controlsWorkflowInvocationByMembership(sender: ConnectedSession, invocationGroup: string): boolean {
		if (!hasGroup(sessionGroups(sender.info), invocationGroup)) return false;
		const registrationGroup = normalizeGroup(sender.registrationGroup);
		return registrationGroup === invocationGroup || !registrationGroup.startsWith("workflow:");
	}

	/** #4006: the sender holds a current claim on a run whose route is registered under `invocationGroup`. */
	private launchedWorkflowInvocation(sender: ConnectedSession, invocationGroup: string): boolean {
		const claims = this.workflowInvocationClaims.get(sender.info.id);
		if (claims === undefined) return false;
		const group = normalizeGroup(invocationGroup);
		for (const [runId, capability] of claims) {
			const route = this.pendingStageRoutes.get(runId);
			if (route?.capability === capability && normalizeGroup(route.group) === group) return true;
		}
		return false;
	}

	/** Only the holder of a run's current route capability can claim to have launched it. */
	private claimWorkflowInvocation(sessionId: string, runId: string, capability: string): boolean {
		const route = this.pendingStageRoutes.get(runId);
		if (route === undefined || route.capability !== capability || !normalizeGroup(route.group).startsWith("workflow:")) {
			return false;
		}
		const claims = this.workflowInvocationClaims.get(sessionId) ?? new Map<string, string>();
		// Claims on runs whose routes are gone or moved on can never authorize again.
		for (const [claimedRunId, claimedCapability] of claims) {
			if (this.pendingStageRoutes.get(claimedRunId)?.capability !== claimedCapability) claims.delete(claimedRunId);
		}
		claims.set(runId, capability);
		this.workflowInvocationClaims.set(sessionId, claims);
		return true;
	}

	private canControlLiveWorkflowStage = (
		sender: ConnectedSession,
		target: ConnectedSession,
		logicalTarget: string,
	): boolean => {
		const owner = this.pendingStageOwnerForTarget(logicalTarget)?.registration;
		const live = this.liveWorkflowStageRoutes.get(logicalTarget);
		if (owner === undefined || live?.sessionId !== target.info.id) return false;
		const targetGroup = target.registrationGroup ?? target.info.group ?? "default";
		return this.canControlWorkflowInvocation(sender, owner.group) && invocationOwnsGroup(owner.group, targetGroup);
	};

	// `send`/`ask` always resolve this namespace as a stage target. `list({ group })`
	// remains the only operation that interprets the same path as an owned subgroup.

	private workflowStagesVisibleTo(requester: ConnectedSession, selectedGroup?: string): WorkflowStageRosterEntry[] {
	const requesterGroups = sessionGroups(requester.info);
	const selected = selectedGroup === undefined ? undefined : normalizeGroup(selectedGroup);
	const entries: WorkflowStageRosterEntry[] = [];
	for (const [runId, roster] of this.workflowRosters) {
		for (const stage of roster.stages) {
			if (!stage.routeEligible || !isAgentRecipient(stage)) continue;
			const parentControl =
				this.canControlWorkflowInvocation(requester, roster.group) && invocationOwnsGroup(roster.group, stage.group);
			const directMembership = requesterGroups.has(stage.group);
			if (!parentControl && !directMembership) continue;
			if (selected !== undefined && selected !== stage.group) continue;
			const live = this.liveWorkflowStageRoutes.get(stage.target);
			const liveSession = live === undefined ? undefined : this.sessions.get(live.sessionId);
			if (stage.lifecycle === "running" && liveSession === undefined) continue;
			// #2784: never list the requester's own stage as an "other" participant.
			// Ordinary session rows already exclude self; the roster must match.
			if (liveSession !== undefined && liveSession.info.id === requester.info.id) continue;
			entries.push({
				kind: "workflow-stage",
				runId,
				stageId: stage.stageId,
				stageName: stage.stageName,
				target: stage.target,
				lifecycle: liveSession === undefined ? "pending" : "running",
				group: stage.group,
				...(liveSession === undefined ? {} : { sessionId: liveSession.info.id }),
			});
		}
	}
	return entries;
  }

	/**
	 * D7 (slice 4): possible-future rows published with the run's persisted scan. Visible
	 * only from inside the invocation — a membership in `workflow:<rootRunId>` or in an
	 * owned subgroup (`workflow:<rootRunId>/…`). The read-only peek filter keeps the
	 * invocation-group rows out of every other group's view.
	 */
	private workflowFutureStagesVisibleTo(
		requester: ConnectedSession,
		selectedGroup?: string,
	): WorkflowFutureStageRosterEntry[] {
		const requesterGroups = sessionGroups(requester.info);
		const selected = selectedGroup === undefined ? undefined : normalizeGroup(selectedGroup);
		const entries: WorkflowFutureStageRosterEntry[] = [];
		for (const [runId, roster] of this.workflowRosters) {
			if (roster.possibleStages === undefined || roster.possibleStages.length === 0) continue;
			if (
				![...requesterGroups].some((group) => invocationOwnsGroup(roster.group, group)) &&
				!this.launchedWorkflowInvocation(requester, roster.group)
			) {
				continue;
			}
			if (selected !== undefined && selected !== roster.group) continue;
			for (const row of roster.possibleStages) {
				if (this.isNonAgentWorkflowTarget(row.target)) continue;
				entries.push({
					kind: "workflow-future-stage",
					runId,
					target: row.target,
					queuedCount: row.queuedCount,
					...(row.deliveryStates === undefined ? {} : { deliveryStates: row.deliveryStates }),
					...(row.deliveryStateCounts === undefined ? {} : { deliveryStateCounts: row.deliveryStateCounts }),
					...(row.omittedDeliveryStates === undefined ? {} : { omittedDeliveryStates: row.omittedDeliveryStates }),
					...(row.deliveryOnly === undefined ? {} : { deliveryOnly: row.deliveryOnly }),
					group: roster.group,
				});
			}
		}
		return entries;
	}

  private acknowledgeLiveWorkflowStageRoute(requestId: string): void {
    const activation = this.liveWorkflowStageRouteActivations.get(requestId);
    if (activation === undefined || activation.pendingRequestIds.size > 0) return;
    this.liveWorkflowStageRouteActivations.delete(requestId);
    const stage = this.sessions.get(activation.sessionId);
    if (stage !== undefined) writeMessageIfOpen(stage.socket, { type: "live_workflow_stage_route_registered", requestId });
  }

  private releasePendingStageAcknowledgment(requestId: string): void {
    for (const [activationId, activation] of this.liveWorkflowStageRouteActivations) {
      if (!activation.pendingRequestIds.delete(requestId)) continue;
      this.acknowledgeLiveWorkflowStageRoute(activationId);
    }
  }

  /** Stage names shared by more than one agent stage of a roster; hosts resolve them to no stage. */
  private ambiguousStageNames(roster: WorkflowRosterRegistration | undefined): ReadonlySet<string> {
    const counts = new Map<string, number>();
    for (const stage of roster?.stages ?? []) {
      if (!isAgentRecipient(stage)) continue;
      counts.set(stage.stageName, (counts.get(stage.stageName) ?? 0) + 1);
    }
    return new Set([...counts].filter(([, count]) => count > 1).map(([name]) => name));
  }

  /**
   * #3163: once a run's roster makes a stage name ambiguous, no occurrence may keep the
   * name-form alias — otherwise a send to `workflow:<root>/reviewer-a` would still reach
   * the retained earlier round while the later round is the one running. The id-form
   * aliases stay; the name resolves through the owner, which treats it as ambiguous.
   */
  private retireAmbiguousNameAliases(runId: string): void {
    const roster = this.workflowRosters.get(runId);
    const ambiguousNames = this.ambiguousStageNames(roster);
    if (ambiguousNames.size === 0) return;
    const stages = roster?.stages ?? [];
    for (const stage of stages) {
      if (!ambiguousNames.has(stage.stageName)) continue;
      // A name that is also some stage's id addresses that stage; leave its id alias alone.
      if (stages.some((candidate) => candidate.stageId === stage.stageName)) continue;
      const nameTarget = withWorkflowStageTargetFinalSegment(stage.target, stage.stageName);
      if (nameTarget === undefined || nameTarget === stage.target) continue;
      if (this.liveWorkflowStageRoutes.get(nameTarget)?.runId === runId) this.liveWorkflowStageRoutes.delete(nameTarget);
    }
  }

  /** Register the stage's live aliases; returns the refusal code when a precondition fails. */
  private registerLiveWorkflowStageRoute(
    currentId: string,
    requestId: string,
    runId: string,
    stageKeys: readonly string[],
    capability: string,
  ): LiveWorkflowStageRouteRefusalCode | undefined {
		const uniqueStageKeys = [...new Set(stageKeys)];
		const owner = this.pendingStageRoutes.get(runId);
		if (owner === undefined) return "owner_missing";
		if (!owner.group.startsWith("workflow:")) return "owner_not_workflow";
		const rootRunId = owner.group.slice("workflow:".length);
		// D8 clarification: advertised targets are depth-faithful, so the live aliases must be
		// depth-faithful too. The roster publishes the id-form target per stage; the name form
		// swaps its final segment. Without a roster entry, fall back to the flat run-id prefix
		// (still an accepted resolver input).
		const roster = this.workflowRosters.get(runId);
		const rosterMatches = (key: string): WorkflowStageRosterAnnouncement[] =>
			roster?.stages.filter((stage) => stage.stageId === key || stage.stageName === key) ?? [];
		if (uniqueStageKeys.some((key) => {
			const matches = rosterMatches(key);
			return matches.length > 0 && matches.every((stage) => !isAgentRecipient(stage));
		})) return "non_agent_stage_key";
		// #3163: a stage name reused by a later occurrence (`reviewer-a` in review round two)
		// is ambiguous — hosts resolve such a name to no stage — so it gets no name alias
		// rather than colliding with the retained earlier occurrence's live session. The
		// stage stays addressable by its id-form target, which the roster advertises.
		const ambiguousNames = this.ambiguousStageNames(roster);
		this.retireAmbiguousNameAliases(runId);
		const stages = roster?.stages ?? [];
		// The registrant is the roster stage its own `[id, name]` keys describe. A key is an
		// id alias only when it is *that* stage's id: a name that happens to equal another
		// stage's id must not take over that stage's route.
		const registrant =
			stages.find((stage) => uniqueStageKeys.includes(stage.stageId) &&
				(uniqueStageKeys.length === 1 || uniqueStageKeys.includes(stage.stageName))) ??
			(uniqueStageKeys.length === 1 ? rosterMatches(uniqueStageKeys[0]!).find(isAgentRecipient) : undefined);
		const idOfAnotherStage = (key: string): boolean =>
			stages.some((stage) => stage.stageId === key && stage !== registrant);
		const targets = uniqueStageKeys.flatMap((stageKey) => {
			if (idOfAnotherStage(stageKey)) return [];
			const registrantTarget = registrant === undefined ? undefined : parseWorkflowStageTarget(registrant.target);
			if (registrant !== undefined && registrantTarget?.kind === "path") {
				if (stageKey === registrant.stageId) return [registrant.target];
				if (ambiguousNames.has(stageKey)) return [];
				return [withWorkflowStageTargetFinalSegment(registrant.target, stageKey) ?? registrant.target];
			}
			if (ambiguousNames.has(stageKey)) return [];
			const prefix = runId === rootRunId ? [] : [runId];
			return [formatWorkflowStageTarget(rootRunId, ...prefix, stageKey)];
		});
		for (const target of targets) {
			const existing = this.liveWorkflowStageRoutes.get(target);
      if (
        existing !== undefined &&
        existing.sessionId !== currentId &&
        this.sessions.has(existing.sessionId)
      ) {
        return "duplicate_live_owner";
      }
    }
    for (const target of targets) {
      this.liveWorkflowStageRoutes.set(target, { sessionId: currentId, capability, runId });
    }
    const pendingRequestIds = new Set(
      [...this.pendingStageAcknowledgments]
				.filter(([, pending]) => {
					// Match in-flight pendings of the whole invocation, not just this run's own:
					// boundary-form pendings settle on the root registration while the going-live
					// stage may register under its nested child run.
					const parsedPending = parseWorkflowStageTarget(pending.target);
					if (parsedPending === undefined || parsedPending.rootRunId !== rootRunId) return false;
					if (parsedPending.kind !== "path") {
						// Slice 3: sticky pattern pendings hold the going-live barrier when the
						// stage's advertised depth-faithful target matches the pattern.
						return uniqueStageKeys.some((stageKey) => {
							const entry = roster?.stages.find(
								(candidate) => candidate.stageId === stageKey || candidate.stageName === stageKey,
							);
							const parsedEntry = entry === undefined ? undefined : parseWorkflowStageTarget(entry.target);
							if (parsedEntry === undefined) {
								return matchStagePathSegments(parsedPending.segments, parsedPending.segments);
							}
							return matchStagePathSegments(parsedPending.segments, parsedEntry.segments);
						});
					}
					return uniqueStageKeys.includes(parsedPending.segments.at(-1) ?? "");
				})
        .map(([pendingRequestId]) => pendingRequestId),
    );
    this.liveWorkflowStageRouteActivations.set(requestId, { sessionId: currentId, pendingRequestIds });
    this.acknowledgeLiveWorkflowStageRoute(requestId);
    return undefined;
  }

	private routePendingStage = (route: PendingStageRoute): boolean => {
		const ownerMatch = this.pendingStageOwnerForTarget(route.target);
		if (ownerMatch === undefined) return false;
		const { runId, registration: ownerRegistration } = ownerMatch;
		const owner = this.sessions.get(ownerRegistration.sessionId);
		if (owner === undefined) {
			this.pendingStageRoutes.delete(runId);
			return false;
		}
    if (route.liveTargetId === undefined && !this.canControlWorkflowInvocation(route.from, ownerRegistration.group)) {
      writeMessageIfOpen(route.socket, {
        type: "delivery_failed",
        messageId: route.message.id,
        ...(route.attemptId ? { attemptId: route.attemptId } : {}),
        reason: workflowInvocationGroupRefusal(ownerRegistration.group),
      });
      return true;
    }
    // #4006: the run's host checks membership again before queueing; say when the broker authorized the launcher instead.
    const invocationControl =
      !this.controlsWorkflowInvocationByMembership(route.from, ownerRegistration.group) &&
      this.launchedWorkflowInvocation(route.from, ownerRegistration.group);
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      const pending = this.pendingStageAcknowledgments.get(requestId);
      if (pending === undefined) return;
      this.pendingStageAcknowledgments.delete(requestId);
      this.releasePendingStageAcknowledgment(requestId);
      writeMessageIfOpen(pending.senderSocket, {
        type: "delivery_failed",
        messageId: pending.messageId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        reason: "Pending-stage route did not acknowledge the message",
      });
    }, PENDING_STAGE_MESSAGE_TIMEOUT_MS);
    this.pendingStageAcknowledgments.set(requestId, {
      ownerSessionId: ownerRegistration.sessionId,
      senderSocket: route.socket,
      messageId: route.message.id,
      ...(route.attemptId ? { attemptId: route.attemptId } : {}),
			runId,
			target: route.target,
		senderSessionId: route.from.info.id,
		sender: { ...route.from.info },
		message: route.message,
		...(route.liveTargetId === undefined ? {} : { liveTargetId: route.liveTargetId }),
		...(route.signature === undefined ? {} : { signature: route.signature }),
		...(route.resolveReplyTarget === true ? { resolveReplyTarget: true } : {}),
      timeout,
    });
    if (
      !writeMessageIfOpen(owner.socket, {
        type: "pending_stage_message",
        requestId,
        from: route.from.info,
		...(route.from.registrationName === undefined ? {} : { senderRegistrationName: route.from.registrationName }),
		...(route.from.registrationReturnAddress === undefined
			? {}
			: { senderReturnAddress: route.from.registrationReturnAddress }),
			runId,
			target: route.target,
        message: route.message,
		...(route.liveTargetId === undefined ? {} : { live: true }),
		...(invocationControl ? { invocationControl: true as const } : {}),
      })
    ) {
      // The owner's socket stopped accepting frames between resolving the route
      // and this write. Unwind the acknowledgment just armed and report the
      // route as not handled, so the caller answers with an honest
      // delivery_failed now instead of stalling the sender for the full
      // acknowledgment timeout on a message nobody ever received.
      clearTimeout(timeout);
      this.pendingStageAcknowledgments.delete(requestId);
      this.releasePendingStageAcknowledgment(requestId);
      return false;
    }
    return true;
  };

	private settlePendingStageMessageRequest(
		currentId: string,
		requestId: string,
		outcome: "queued" | "delivered" | "forward" | "refused",
		position: number | undefined,
		forwardTarget: string | undefined,
		reason: string | undefined,
		reasonCode: "message_id_conflict" | undefined,
		notInKnownSet?: true,
		forwardTargets?: readonly string[],
	): void {
		const pending = this.pendingStageAcknowledgments.get(requestId);
		if (pending === undefined || pending.ownerSessionId !== currentId) return;
		clearTimeout(pending.timeout);
		this.pendingStageAcknowledgments.delete(requestId);
		this.releasePendingStageAcknowledgment(requestId);
		if (outcome === "forward") {
			this.forwardValidatedLiveStageMessage(pending, forwardTarget);
			return;
		}
		if (outcome === "delivered") {
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivered",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
			});
			return;
		}
		if (outcome === "queued" && typeof position === "number" && position > 0) {
			// Slice 3 (D6/D9): a sticky pattern entry answers `queued` once while any
			// matching live stages receive the message now, as ordinary inbound
			// messages with the original sender identity. The owner records a live
			// delivery only for the targets this write actually reached, so a stage
			// that dropped between the owner's answer and this write is not marked
			// delivered and a retried send re-forwards to it.
			const deliveredTargets = this.deliverStickyBroadcast(pending, forwardTargets);
			const ownerSocket = this.sessions.get(currentId)?.socket;
			if (deliveredTargets.length > 0 && ownerSocket !== undefined) {
				writeMessageIfOpen(ownerSocket, {
					type: "sticky_live_delivered",
					runId: pending.runId,
					messageId: pending.messageId,
					target: pending.target,
					deliveredTargets,
				});
			}
			writeMessageIfOpen(pending.senderSocket, {
				type: "queued",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				target: pending.target,
				position,
				...(notInKnownSet === true ? { notInKnownSet: true } : {}),
			});
			return;
		}
		writeMessageIfOpen(pending.senderSocket, {
			type: "delivery_failed",
			messageId: pending.messageId,
			...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
			reason: reason ?? "Pending-stage delivery was refused",
			...(reasonCode === undefined ? {} : { reasonCode }),
		});
	}

	private forwardValidatedLiveStageMessage(pending: PendingStageAcknowledgment, forwardTarget?: string): void {
		const from = this.sessions.get(pending.senderSessionId);
		// The route owner chooses the live alias for boundary-form targets, so bind its
		// forward answer to the sender's own invocation: a target under any other rootRunId
		// could deliver a sender's message into a different invocation, bypassing the
		// sender's group authorization on the ordinary send path.
		const destination = forwardTarget ?? pending.target;
		const parsedDestination = parseWorkflowStageTarget(destination);
		const parsedPending = parseWorkflowStageTarget(pending.target);
		const crossInvocation =
			parsedDestination === undefined ||
			parsedPending === undefined ||
			parsedDestination.rootRunId !== parsedPending.rootRunId;
		const target = crossInvocation ? undefined : this.resolveLiveWorkflowStage(destination);
		if (
			from === undefined ||
			target === undefined ||
			(pending.liveTargetId !== undefined && target.info.id !== pending.liveTargetId) ||
			pending.signature === undefined
		) {
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason: "Session not found",
			});
			return;
		}
		const targetIdentity = deliveryTargetIdentity(target);
		const deliveredMatch = this.deliveredMessages.lookupForTarget(
			pending.messageId,
			pending.signature,
			targetIdentity,
		);
		// #3761: a recipient that confirms saves ignores a copy it already saved, so a reserved message is sent again.
		const confirmsSaves = target.acknowledgesReceipt === true;
		if (deliveredMatch !== "miss" && !(deliveredMatch === "uncertain" && confirmsSaves)) {
			if (deliveredMatch === "match") {
				if (pending.message.expectsReply === true) {
					const acceptedQuestionTarget = this.deliveredMessages.lookupQuestionTarget(
						pending.messageId,
						pending.signature,
						senderGroupIdentity(from),
					);
					if (acceptedQuestionTarget === undefined) {
						writeMessageIfOpen(pending.senderSocket, {
							type: "delivery_failed",
							messageId: pending.messageId,
							...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
							reason: "Accepted Intercom question route could not be securely rebound",
						});
						return;
					}
					if (!this.deliveredMessages.isQuestionAnswered(pending.messageId))
						this.pendingQuestions.record(from.info.id, target.info.id, pending.messageId);
					if (pending.resolveReplyTarget === true && pending.attemptId !== undefined)
						writeMessageIfOpen(pending.senderSocket, { type: "question_target", messageId: pending.messageId, attemptId: pending.attemptId, sessionId: target.info.id });
				}
				writeMessageIfOpen(pending.senderSocket, {
					type: "delivered",
					messageId: pending.messageId,
					...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				});
				return;
			}
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason:
					deliveredMatch === "conflict"
						? `Intercom message ID '${pending.messageId}' was already delivered with a different target or payload`
						: deliveredMatch === "uncertain"
							? "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery"
							: "Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery",
				...(deliveredMatch === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
			});
			return;
		}
		const reservation =
			pending.message.expectsReply === true
				? this.deliveredMessages.reserveQuestion(
						pending.messageId,
						pending.signature,
						{
							targetSessionId: target.info.id,
							senderGroupIdentity: senderGroupIdentity(from),
						},
						Date.now(),
						targetIdentity,
					)
				: this.deliveredMessages.reserve(pending.messageId, pending.signature, Date.now(), targetIdentity);
		if (reservation === "match") {
			if (pending.message.expectsReply === true) {
				const acceptedQuestionTarget = this.deliveredMessages.lookupQuestionTarget(
					pending.messageId,
					pending.signature,
					senderGroupIdentity(from),
				);
				if (acceptedQuestionTarget === undefined) {
					writeMessageIfOpen(pending.senderSocket, {
						type: "delivery_failed",
						messageId: pending.messageId,
						...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
						reason: "Accepted Intercom question route could not be securely rebound",
					});
					return;
				}
				if (!this.deliveredMessages.isQuestionAnswered(pending.messageId))
					this.pendingQuestions.record(from.info.id, target.info.id, pending.messageId);
				if (pending.resolveReplyTarget === true && pending.attemptId !== undefined)
					writeMessageIfOpen(pending.senderSocket, { type: "question_target", messageId: pending.messageId, attemptId: pending.attemptId, sessionId: target.info.id });
			}
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivered",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
			});
			return;
		}
		if (reservation !== "recorded" && !(reservation === "uncertain" && confirmsSaves)) {
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason:
					reservation === "capacity"
						? "Intercom accepted-delivery capacity is full; refusing delivery without evicting live retry authority"
						: reservation === "uncertain"
							? "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery"
							: "Intercom accepted-delivery authority changed before forwarding; refusing possible duplicate delivery",
				...(reservation === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
			});
			return;
		}
		if (pending.message.expectsReply === true && pending.resolveReplyTarget === true && pending.attemptId !== undefined)
			writeMessageIfOpen(pending.senderSocket, { type: "question_target", messageId: pending.messageId, attemptId: pending.attemptId, sessionId: target.info.id });
		const frame: BrokerMessage = { type: "message", from: pending.sender, message: pending.message };
		const signature = pending.signature;
		const finish = (recipient: ConnectedSession, sender: ReceiptSender | undefined): void => {
			const notify = (message: BrokerMessage): void => {
				if (sender !== undefined) writeMessageIfOpen(sender.socket, message);
			};
			const senderAttempt = sender?.attemptId === undefined ? {} : { attemptId: sender.attemptId };
			let accepted: ReturnType<DeliveredMessageCache["accept"]>;
			try {
				accepted = this.deliveredMessages.accept(pending.messageId, signature, targetIdentity);
			} catch {
				notify({
					type: "delivery_failed",
					messageId: pending.messageId,
					...senderAttempt,
					reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
				});
				return;
			}
			if (accepted !== "accepted") {
				notify({
					type: "delivery_failed",
					messageId: pending.messageId,
					...senderAttempt,
					reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
					...(accepted === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
				});
				return;
			}
			if (pending.message.expectsReply === true && sender !== undefined) {
				this.pendingQuestions.record(from.info.id, recipient.info.id, pending.messageId);
				// #3761: a recipient that reconnected before confirming answers under its new session id.
				if (recipient.info.id !== target.info.id && pending.resolveReplyTarget === true && sender.attemptId !== undefined)
					notify({ type: "question_target", messageId: pending.messageId, attemptId: sender.attemptId, sessionId: recipient.info.id });
			}
			if (pending.message.replyTo !== undefined && this.pendingQuestions.clearReply(from.info.id, recipient.info.id, pending.message.replyTo)) {
				this.deliveredMessages.settleQuestion(pending.message.replyTo);
			}
			notify({ type: "delivered", messageId: pending.messageId, ...senderAttempt });
		};
		const sender: ReceiptSender = {
			socket: pending.senderSocket,
			...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
		};
		if (confirmsSaves) {
			this.receipts.await(
				{
					messageId: pending.messageId,
					targetIdentity,
					frame,
					complete: finish,
					expire: (waiting) => {
						writeMessageIfOpen(waiting.socket, {
							type: "delivery_failed",
							messageId: pending.messageId,
							...(waiting.attemptId === undefined ? {} : { attemptId: waiting.attemptId }),
							reason: UNCERTAIN_RECEIPT_REASON,
						});
					},
				},
				sender,
			);
		}
		if (!writeMessageIfOpen(target.socket, frame)) {
			if (confirmsSaves) this.receipts.drop(pending.messageId);
			if (reservation === "recorded") this.deliveredMessages.forget(pending.messageId, pending.signature);
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason: "Session not found",
			});
			return;
		}
		if (!confirmsSaves) finish(target, sender);
	}


	/**
	 * Slice 3 (D6/D9): deliver a sticky broadcast to the live stages the host validated,
	 * each as an ordinary inbound message frame carrying the original sender identity.
	 */
	private deliverStickyBroadcast(
		pending: PendingStageAcknowledgment,
		forwardTargets: readonly string[] | undefined,
	): string[] {
		if (forwardTargets === undefined || forwardTargets.length === 0) return [];
		const parsedPending = parseWorkflowStageTarget(pending.target);
		if (parsedPending === undefined) return [];
		const invocationGroup = normalizeGroup(`workflow:${parsedPending.rootRunId}`);
		const delivered: string[] = [];
		for (const target of forwardTargets) {
			const targetSession = this.resolveLiveWorkflowStage(target);
			if (targetSession === undefined) continue;
			const targetGroup = targetSession.registrationGroup ?? targetSession.info.group ?? "default";
			if (!invocationOwnsGroup(invocationGroup, normalizeGroup(targetGroup))) continue;
			// The write itself is the writability check, so a stage that dropped between
			// the owner's answer and this loop is not reported as delivered and a retried
			// send re-forwards to it.
			if (!writeMessageIfOpen(targetSession.socket, { type: "message", from: pending.sender, message: pending.message }))
				continue;
			delivered.push(target);
		}
		// Deliberately NOT recorded in the delivered-message cache (round-1 review): the
		// sticky ledger in the workflow host is the durable dedupe authority, so a retry
		// re-routes to the host, dedupes there, and the sender's ack stays `queued`
		// instead of flipping to `delivered` between attempts.
		return delivered;
	}

	private failPendingStageNotification(
		socket: net.Socket,
		messageId: string,
		attemptId: string | undefined,
		reason: string,
		reasonCode?: "message_id_conflict",
	): void {
		writeMessageIfOpen(socket, {
			type: "delivery_failed",
			messageId,
			...(attemptId === undefined ? {} : { attemptId }),
			reason,
			...(reasonCode === undefined ? {} : { reasonCode }),
		});
	}

	private handlePendingStageNotificationSend(
		socket: net.Socket,
		clientMessage: Record<string, unknown>,
		currentId: string,
	): void {
		const message = clientMessage.message;
		const messageId = typeof message === "object" && message !== null && typeof (message as { id?: unknown }).id === "string"
			? (message as { id: string }).id
			: "unknown";
		const attemptId = typeof clientMessage.attemptId === "string" ? clientMessage.attemptId : undefined;
		if (
			typeof clientMessage.runId !== "string" ||
			typeof clientMessage.capability !== "string" ||
			typeof clientMessage.to !== "string" ||
			(clientMessage.senderRegistrationName !== undefined && typeof clientMessage.senderRegistrationName !== "string") ||
			(clientMessage.senderReturnAddress !== undefined &&
				(typeof clientMessage.senderReturnAddress !== "string" || clientMessage.senderReturnAddress.length === 0)) ||
			(clientMessage.attemptId !== undefined && typeof clientMessage.attemptId !== "string") ||
			!isMessage(message)
		) {
			this.failPendingStageNotification(socket, messageId, attemptId, "Invalid pending-stage notification format");
			return;
		}
		const ownerRegistration = this.pendingStageRoutes.get(clientMessage.runId);
		const owner = this.sessions.get(currentId);
		const routeGroup = normalizeGroup(ownerRegistration?.group);
		if (
			ownerRegistration === undefined ||
			owner === undefined ||
			ownerRegistration.sessionId !== currentId ||
			ownerRegistration.capability !== clientMessage.capability ||
			normalizeGroup(owner.registrationGroup) !== routeGroup
		) {
			this.failPendingStageNotification(socket, message.id, attemptId, "Pending-stage notification is not authorized");
			return;
		}
		const logicalTarget = [
			clientMessage.runId,
			clientMessage.to,
			clientMessage.senderReturnAddress ?? "",
			clientMessage.senderRegistrationName ?? "",
			routeGroup,
		].join(":");
		const signature = buildMessageSendSignature(logicalTarget, message, clientMessage.capability);
		const deliveredMatch = this.deliveredMessages.lookup(message.id, signature);
		if (deliveredMatch === "match") {
			writeMessageIfOpen(socket, { type: "delivered", messageId: message.id, ...(attemptId === undefined ? {} : { attemptId }) });
			return;
		}
		if (deliveredMatch !== "miss") {
			this.failPendingStageNotification(
				socket,
				message.id,
				attemptId,
				deliveredMatch === "conflict"
					? `Intercom message ID '${message.id}' was already delivered with a different target or payload`
					: deliveredMatch === "uncertain"
						? "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery"
						: "Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery",
				deliveredMatch === "conflict" ? "message_id_conflict" : undefined,
			);
			return;
		}

		let target = this.sessions.get(clientMessage.to);
		if (target === undefined && clientMessage.senderReturnAddress !== undefined) {
			const matches = [...this.sessions.values()].filter(
				(session) =>
					session.registrationReturnAddress === clientMessage.senderReturnAddress &&
					normalizeGroup(session.registrationGroup) === routeGroup,
			);
			if (matches.length === 1) target = matches[0];
		} else if (target === undefined && clientMessage.senderRegistrationName !== undefined) {
			const alias = clientMessage.senderRegistrationName.trim().toLowerCase();
			if (alias.length > 0) {
				// Legacy durable records can only use the immutable registration name/group fallback.
				const matches = [...this.sessions.values()].filter(
					(session) =>
						session.registrationName?.toLowerCase() === alias &&
						normalizeGroup(session.registrationGroup) === routeGroup,
				);
				if (matches.length === 1) target = matches[0];
			}
		}
		if (
			target === undefined ||
			!isAgentRecipient(target.info) ||
			target.info.id === currentId ||
			normalizeGroup(target.registrationGroup) !== routeGroup ||
			!hasGroup(sessionGroups(target.info), routeGroup)
		) {
			this.failPendingStageNotification(socket, message.id, attemptId, "Session not found");
			return;
		}

		const requestId = randomUUID();
		let reservation: ReturnType<DeliveredMessageCache["reserve"]>;
		try {
			reservation = this.deliveredMessages.reserve(message.id, signature);
		} catch {
			this.failPendingStageNotification(
				socket,
				message.id,
				attemptId,
				"Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery",
			);
			return;
		}
		if (reservation === "match") {
			writeMessageIfOpen(socket, {
				type: "delivered",
				messageId: message.id,
				...(attemptId === undefined ? {} : { attemptId }),
			});
			return;
		}
		if (reservation !== "recorded") {
			this.failPendingStageNotification(
				socket,
				message.id,
				attemptId,
				reservation === "capacity"
					? "Intercom accepted-delivery capacity is full; refusing delivery without evicting live retry authority"
					: reservation === "conflict"
						? `Intercom message ID '${message.id}' was already delivered with a different target or payload`
						: reservation === "uncertain"
							? "Intercom cannot prove whether this reserved operation reached its recipient; refusing redelivery"
							: "Intercom accepted-delivery authority is invalid; refusing possible duplicate delivery",
				reservation === "conflict" ? "message_id_conflict" : undefined,
			);
			return;
		}

		const timeout = setTimeout(() => {
			const pending = this.pendingStageNotificationAcknowledgments.get(requestId);
			if (pending === undefined) return;
			this.pendingStageNotificationAcknowledgments.delete(requestId);
			this.deliveredMessages.forget(pending.messageId, pending.signature);
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Recipient did not acknowledge the pending-stage notification",
			);
		}, PENDING_STAGE_MESSAGE_TIMEOUT_MS);
		this.pendingStageNotificationAcknowledgments.set(requestId, {
			ownerSessionId: currentId,
			recipientSessionId: target.info.id,
			senderSocket: socket,
			messageId: message.id,
			...(attemptId === undefined ? {} : { attemptId }),
			signature,
			timeout,
		});
		if (
			!writeMessageIfOpen(target.socket, {
				type: "pending_stage_notification",
				requestId,
				from: owner.info,
				message,
			})
		) {
			// The recipient's socket stopped accepting frames between resolving it and
			// this write. Release the acknowledgment and fail now, so the owner retries a
			// message that was never handed over rather than waiting out the ack timeout.
			clearTimeout(timeout);
			this.pendingStageNotificationAcknowledgments.delete(requestId);
			this.failPendingStageNotification(socket, message.id, attemptId, "Session not found");
			this.deliveredMessages.forget(message.id, signature);
		}
	}

	private settlePendingStageNotification(
		currentId: string,
		requestId: string,
		delivered: boolean,
	): void {
		const pending = this.pendingStageNotificationAcknowledgments.get(requestId);
		if (pending === undefined || pending.recipientSessionId !== currentId) return;
		clearTimeout(pending.timeout);
		this.pendingStageNotificationAcknowledgments.delete(requestId);
		if (!delivered) {
			this.deliveredMessages.forget(pending.messageId, pending.signature);
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Recipient did not admit the pending-stage notification",
			);
			return;
		}
		let accepted: ReturnType<DeliveredMessageCache["accept"]>;
		try {
			accepted = this.deliveredMessages.accept(pending.messageId, pending.signature);
		} catch {
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
			);
			return;
		}
		if (accepted !== "accepted") {
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
				accepted === "conflict" ? "message_id_conflict" : undefined,
			);
			return;
		}
		writeMessageIfOpen(pending.senderSocket, {
			type: "delivered",
			messageId: pending.messageId,
			...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
		});
	}

  private handleMessage(
    socket: net.Socket,
    msg: JsonWireValue,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || Array.isArray(msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg;

    if (clientMessage.type === "health") {
      if (typeof clientMessage.requestId !== "string" || clientMessage.requestId.length > 128) {
        throw new Error("Invalid health request");
      }
      writeMessageIfOpen(socket, { type: "health", requestId: clientMessage.requestId, instanceId: this.instanceId });
      return;
    }

    // Control requests need no registration: `atomic intercom restart` and `atomic storage status` send them.
    if (clientMessage.type === "broker_status" || clientMessage.type === "shutdown") {
      if (typeof clientMessage.requestId !== "string") throw new Error(`Invalid ${clientMessage.type} message`);
      const requestId = clientMessage.requestId;
      if (clientMessage.type === "broker_status") {
        void this.statusReport().then((report) => writeMessageIfOpen(socket, { type: "broker_status", requestId, report }));
        return;
      }
      console.error("Intercom broker shutting down on request, so its sessions reconnect to a new broker");
      writeMessageWithOutcome(socket, { type: "shutdown_ack", requestId }, () => this.shutdown());
      return;
    }

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }
		if (clientMessage.registrationGroup !== undefined &&
			(typeof clientMessage.registrationGroup !== "string" || clientMessage.registrationGroup.trim().length === 0)) {
			throw new Error("Invalid registration group");
		}
		if (clientMessage.returnAddress !== undefined &&
			(typeof clientMessage.returnAddress !== "string" || clientMessage.returnAddress.length === 0)) {
			throw new Error("Invalid return address");
		}
		if (clientMessage.supervisorOwnerToken !== undefined
			&& (typeof clientMessage.supervisorOwnerToken !== "string" || !clientMessage.supervisorOwnerToken)) {
			throw new Error("Invalid supervisor owner token");
		}
		if (clientMessage.preferredSessionId !== undefined && typeof clientMessage.preferredSessionId !== "string") {
			throw new Error("Invalid preferred session id");
		}
		if (clientMessage.acknowledgesReceipt !== undefined && clientMessage.acknowledgesReceipt !== true) {
			throw new Error("Invalid receipt acknowledgement capability");
		}

        if (currentId) {
          throw new Error("Received duplicate register message");
        }

        let supervisorId: string | undefined;
        if (clientMessage.supervisor !== undefined) {
          const childName = clientMessage.session.name?.trim();
          const claimedSupervisorId = isSupervisorRegistration(clientMessage.supervisor) && childName
            ? this.supervisorChannel.claim(clientMessage.supervisor.capability, childName)
            : undefined;
          if (!claimedSupervisorId || !this.sessions.has(claimedSupervisorId)) {
            writeMessageIfOpen(socket, { type: "registration_failed", reason: "Invalid supervisor authorization" });
            this.endRefusedConnection(socket, currentId, setId);
            return;
          }
          supervisorId = claimedSupervisorId;
        }

        // #3760: a restored or reconnected session keeps the id peers know when it is free; never a live one.
        const id = this.sessionIdReclaim.grant(
          clientMessage.preferredSessionId,
          clientMessage.returnAddress,
          (sessionId) => this.sessions.has(sessionId),
        ) ?? randomUUID();
        setId(id);
        const initialGroups = normalizeGroups(clientMessage.session.groups, clientMessage.session.group);
        const legacyGroup = normalizeGroup(clientMessage.session.group ?? initialGroups.values().next().value);
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
        };
		setSessionGroups(info, initialGroups, legacyGroup);
        this.sessions.set(id, {
          socket,
          info,
          registrationGroup: typeof clientMessage.registrationGroup === "string"
            ? normalizeGroup(clientMessage.registrationGroup) : legacyGroup,
			...(typeof info.name === "string" && info.name.trim().length > 0
				? { registrationName: info.name.trim() }
				: {}),
			...(typeof clientMessage.returnAddress === "string"
				? { registrationReturnAddress: clientMessage.returnAddress }
				: {}),
          ...(supervisorId ? { supervisorId } : {}),
          ...(typeof clientMessage.supervisorOwnerToken === "string"
            ? { supervisorOwnerToken: clientMessage.supervisorOwnerToken }
            : {}),
          ...(clientMessage.acknowledgesReceipt === true ? { acknowledgesReceipt: true as const } : {}),
        });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        const rejoined = this.sessions.get(id);
        const consumedCapability =
          supervisorId && isSupervisorRegistration(clientMessage.supervisor) ? clientMessage.supervisor.capability : undefined;
        const completeRegistration = (held: readonly HeldWrite[] = []): void => {
          // #3761: echoing the capability tells the client this broker understands `received`; an old broker never does.
          writeMessageIfOpen(socket, {
            type: "registered",
            sessionId: id,
            ...(supervisorId ? { supervisorSessionId: supervisorId } : {}),
            ...(clientMessage.acknowledgesReceipt === true ? { acknowledgesReceipt: true as const } : {}),
            acknowledgesPendingStageRoutes: true as const,
            refusesPendingStageRoutesInPlace: true as const,
            brokerStatus: true as const,
            claimsWorkflowInvocations: true as const,
          });
          if (isAgentRecipient(info)) this.broadcastToMemberships({ type: "session_joined", session: info }, sessionGroups(info), id);
          // #3761: messages written to this recipient's previous connection that it never confirmed saving go out again.
          if (rejoined?.acknowledgesReceipt === true) {
            const heldFrames = new Set(held.map((write) => write.message));
            for (const frame of this.receipts.framesFor(deliveryTargetIdentity(rejoined))) {
              if (!heldFrames.has(frame)) writeMessageIfOpen(socket, frame);
            }
          }
          // Multi-node S5: frames written while registration waited for the presence lease follow `registered`.
          flushHeldWrites(socket, held);
          // #3760: a restored subagent is back under the capability its owner reserved it with; the sends held
          // for it while it was being restored go out now, once each and in the order they arrived.
          if (consumedCapability !== undefined) {
            const registered = info.name?.trim();
            for (const send of this.restoringRecipients.consume(
              consumedCapability,
              registered ? { childName: registered, groups: sessionGroups(info) } : undefined,
            ))
              this.dispatchSend(send.socket, send.clientMessage, send.senderId);
          }
        };
        // Multi-node S5: brokers on other hosts find this session through its presence lease, so registration
        // completes once the lease is written (or bounded attempts found it still held elsewhere). The session is
        // routable meanwhile, so its frames are held until `registered` is written.
        const presence =
          rejoined === undefined
            ? undefined
            : this.multiNode?.sessionRegistered(
                rejoined,
                consumedCapability === undefined
                  ? undefined
                  : {
                      capability: consumedCapability,
                      ...(info.name?.trim() ? { childName: info.name.trim() } : {}),
                      groups: sessionGroups(info),
                    },
              );
        if (presence === undefined) completeRegistration();
        else {
          holdWrites(socket);
          void presence.then(() => {
            const held = releaseHeldWrites(socket);
            if (this.sessions.get(id) === rejoined) completeRegistration(held);
            else discardHeldWrites(held);
          });
        }
        break;
      }

      case "unregister": {
        this.disconnectSession(currentId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }
        if (clientMessage.group !== undefined && typeof clientMessage.group !== "string") {
          throw new Error("Invalid list group");
        }

        const requester = currentId ? this.sessions.get(currentId) : undefined;
		if (requester === undefined) throw new Error("Session not found");
		const requestId = clientMessage.requestId;
		const selectedGroup = clientMessage.group;
		const multiNode = this.multiNode;
		replyToList({
			requestId,
			requesterInfo: requester.info,
			selectedGroup,
			localSessions: () => this.sessions,
			remoteSessions: multiNode === undefined ? undefined : () => multiNode.remoteSessions(),
			canInspectSelectedGroup: (group) => this.canInspectSelectedGroup(requester, group),
			workflowStages: () => this.workflowStagesVisibleTo(requester, selectedGroup),
			workflowFutureStages: () => this.workflowFutureStagesVisibleTo(requester, selectedGroup),
			write: (reply) => writeMessageIfOpen(socket, reply),
		});
        break;
      }

	  case "list_groups": {
		if (typeof clientMessage.requestId !== "string") throw new Error("Invalid list_groups message");
		const requester = currentId ? this.sessions.get(currentId) : undefined;
		if (requester === undefined) throw new Error("Session not found");
		writeMessageIfOpen(socket, {
			type: "groups",
			requestId: clientMessage.requestId,
			groups: knownGroupSummaries(this.sessions, requester.info),
		});
        break;
      }

      case "authorize_supervisor": {
        const supervisor = this.sessions.get(currentId);
        if (!supervisor?.supervisorOwnerToken || typeof clientMessage.requestId !== "string"
          || typeof clientMessage.childName !== "string" || !clientMessage.childName.trim()
          || (clientMessage.capability !== undefined && typeof clientMessage.capability !== "string")) {
          throw new Error("Invalid authorize_supervisor message");
        }
        const childName = clientMessage.childName.trim();
        const capability = this.supervisorChannel.authorize(
          supervisor.info.id,
          supervisor.supervisorOwnerToken,
          childName,
          typeof clientMessage.capability === "string" ? clientMessage.capability : undefined,
        );
        writeMessageIfOpen(socket, {
          type: "supervisor_authorized",
          requestId: clientMessage.requestId,
          capability,
          supervisorSessionId: supervisor.info.id,
          childName,
        });
        break;
      }

      case "reserve_restoring_recipient": {
        const owner = this.sessions.get(currentId);
        if (
          owner === undefined || typeof clientMessage.requestId !== "string" ||
          typeof clientMessage.capability !== "string" || !clientMessage.capability ||
          (clientMessage.group !== undefined && typeof clientMessage.group !== "string") ||
          (clientMessage.dormant !== undefined && typeof clientMessage.dormant !== "boolean") ||
          (clientMessage.aliases !== undefined && !isRestoringRecipientAliasList(clientMessage.aliases))
        ) {
          throw new Error("Invalid reserve_restoring_recipient message");
        }
        // Only the supervisor the capability was issued to may hold sends for that child (#3760).
        const childName = this.supervisorChannel.supervisedChildName(clientMessage.capability, currentId);
        const aliases = (clientMessage.aliases ?? []) as string[];
        if (childName === undefined || !aliases.every(isRestoringRecipientAlias)) {
          writeMessageIfOpen(socket, {
            type: "restoring_recipient_ack",
            requestId: clientMessage.requestId,
            error: childName === undefined
              ? "Only the supervisor authorized for this subagent can reserve its Intercom targets"
              : "A restoring subagent can be reserved only under its name and session ids",
          });
          break;
        }
        this.restoringRecipients.reserve(
          clientMessage.capability,
          currentId,
          childName,
          normalizeGroup(typeof clientMessage.group === "string" ? clientMessage.group : owner.registrationGroup),
          aliases,
          { dormant: clientMessage.dormant === true },
        );
        this.multiNode?.restoringReserved(
          clientMessage.capability,
          currentId,
          childName,
          normalizeGroup(typeof clientMessage.group === "string" ? clientMessage.group : owner.registrationGroup),
          aliases,
          clientMessage.dormant === true,
        );
        writeMessageIfOpen(socket, { type: "restoring_recipient_ack", requestId: clientMessage.requestId });
        break;
      }

      case "release_restoring_recipient": {
        if (
          typeof clientMessage.requestId !== "string" || typeof clientMessage.capability !== "string" ||
          (clientMessage.gone !== undefined && typeof clientMessage.gone !== "string") ||
          (clientMessage.refusal !== undefined && typeof clientMessage.refusal !== "string")
        ) {
          throw new Error("Invalid release_restoring_recipient message");
        }
        const released = this.restoringRecipients.release(
          clientMessage.capability,
          currentId,
          typeof clientMessage.gone === "string" ? clientMessage.gone.slice(0, RESTORING_RECIPIENT_GONE_REASON_MAX) : undefined,
          typeof clientMessage.refusal === "string" && clientMessage.refusal.trim()
            ? clientMessage.refusal.slice(0, RESTORING_RECIPIENT_GONE_REASON_MAX)
            : undefined,
        );
        if (released !== undefined) {
          this.multiNode?.restoringReleased(clientMessage.capability, currentId, released.gone, released.refusal);
        }
        writeMessageIfOpen(socket, { type: "restoring_recipient_ack", requestId: clientMessage.requestId });
        for (const send of released?.held ?? []) {
          if (released?.gone !== undefined) this.failHeldSend(send, released.gone);
          else if (released?.refusal !== undefined) this.failHeldSend(send, released.refusal);
          else this.dispatchSend(send.socket, send.clientMessage, send.senderId);
        }
        break;
      }

      case "register_pending_stage_route": {
        if (
          typeof clientMessage.runId !== "string" ||
          !clientMessage.runId ||
          typeof clientMessage.group !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability ||
          (clientMessage.requestId !== undefined && typeof clientMessage.requestId !== "string")
        ) {
          throw new Error("Invalid pending-stage route registration");
        }
        const routeRequestId = clientMessage.requestId;
        // The route is applied synchronously, so this answer proves the update is visible to every later request.
        const acknowledgeRoute = (): void => {
          if (routeRequestId !== undefined) {
            writeMessageIfOpen(socket, { type: "pending_stage_route_registered", requestId: routeRequestId });
          }
        };
        // #3906: a client whose connection carries the routes of many runs asks for a refusal of one of them to be
        // answered on its own. Authorization is the same either way; only whether the refusal ends the connection differs.
        const refusesInPlace = routeRequestId !== undefined && clientMessage.refusalKeepsConnection === true;
        // #3904: the refusal names the registration it answers, so a connection carrying many runs' routes knows which one.
        const refuseRoute = (code: PendingStageRouteRefusalCode, reason: string): void => {
          if (refusesInPlace) {
            writeMessageIfOpen(socket, {
              type: "pending_stage_route_refused",
              requestId: routeRequestId,
              runId: clientMessage.runId,
              code,
              reason,
            });
            return;
          }
          writeMessageIfOpen(socket, {
            type: "registration_failed",
            reason,
            ...(routeRequestId === undefined ? {} : { requestId: routeRequestId }),
          });
          this.endRefusedConnection(socket, currentId, setId);
        };
        const owner = this.sessions.get(currentId);
        const existing = this.pendingStageRoutes.get(clientMessage.runId);
        const ownerGroup = normalizeGroup(owner?.registrationGroup);
        const dormant = clientMessage.dormant === true;
        const liveExisting = existing !== undefined && this.sessions.has(existing.sessionId) ? existing : undefined;
        // #3760: a restarted owner queues for its interrupted run under a dormant route. The process that
        // resumes the run holds the run's lease and a capability of its own, so it takes the route over and
        // the dormant owner is told to stop answering for it; a dormant route never takes over another.
        const yieldedDormant =
          liveExisting?.dormant === true &&
          !dormant &&
          liveExisting.sessionId !== currentId &&
          liveExisting.capability !== clientMessage.capability &&
          normalizeGroup(clientMessage.group) === ownerGroup &&
          liveExisting.group === ownerGroup
            ? liveExisting
            : undefined;
        const activeExisting = yieldedDormant === undefined ? liveExisting : undefined;
        // #3904: the owning session may move its own route to a new capability. One connection carries
        // the routes of many runs, so refusing a rotation would end the connection and drop all of them.
        if (
          owner === undefined ||
          normalizeGroup(clientMessage.group) !== ownerGroup ||
          (activeExisting !== undefined &&
            (activeExisting.group !== ownerGroup ||
              (activeExisting.capability !== clientMessage.capability && activeExisting.sessionId !== currentId)))
        ) {
          refuseRoute("not_authorized", "Pending-stage route is not authorized");
          return;
        }
        if (
          clientMessage.stages !== undefined &&
          (!isWorkflowStageRosterAnnouncements(
            clientMessage.stages,
            clientMessage.runId,
            normalizeGroup(clientMessage.group),
          ) ||
            !clientMessage.stages.every((stage) => invocationOwnsGroup(ownerGroup, stage.group)))
        ) {
          refuseRoute("invalid_stage_roster", "Invalid workflow-stage roster");
          return;
        }
        if (
          clientMessage.possibleStages !== undefined &&
          !isWorkflowPossibleStageAnnouncements(
            clientMessage.possibleStages,
            clientMessage.runId,
            normalizeGroup(clientMessage.group),
          )
        ) {
          refuseRoute("invalid_possible_stage_roster", "Invalid workflow possible-stage roster");
          return;
        }
        // D7 (slice 4): presence replaces, absence keeps — a terminal root publishes `[]`
        // so the broker drops every future row, while nested runs' re-announcements (which
        // never carry the field) preserve the root's rows.
        // Rows from hosts that announce every delivery state are bounded like current hosts' rows.
        const possibleStages =
          clientMessage.possibleStages !== undefined
            ? clientMessage.possibleStages.map((row) => boundWorkflowPossibleStageRow(row))
            : this.workflowRosters.get(clientMessage.runId)?.possibleStages;
		// Optional path metadata is advisory for old hosts; omission retains a
		// previously announced edge during two-session route replay.
		const parent = readWorkflowRunParentAnnouncement(clientMessage.parent)
			?? this.workflowRosters.get(clientMessage.runId)?.parent;
        if (activeExisting !== undefined && activeExisting.sessionId !== currentId) {
          // A stage replays the process-shared owner announcement before registering its live aliases.
          // It may publish the materialized roster, but the original workflow owner must continue to
          // handle pending delivery and own roster cleanup.
          if (clientMessage.stages !== undefined || possibleStages !== undefined) {
            this.workflowRosters.set(clientMessage.runId, {
              ownerSessionId: activeExisting.sessionId,
              group: ownerGroup,
              stages: clientMessage.stages ?? [],
              ...(possibleStages === undefined ? {} : { possibleStages }),
              ...(parent === undefined ? {} : { parent }),
            });
            this.retireAmbiguousNameAliases(clientMessage.runId);
          }
          acknowledgeRoute();
          break;
        }
        this.pendingStageRoutes.set(clientMessage.runId, {
          sessionId: currentId,
          group: ownerGroup,
          capability: clientMessage.capability,
          ...(dormant ? { dormant: true as const } : {}),
        });
        if (yieldedDormant !== undefined) {
          const revoked = this.sessions.get(yieldedDormant.sessionId);
          if (revoked !== undefined)
            writeMessageIfOpen(revoked.socket, { type: "pending_stage_route_revoked", runId: clientMessage.runId });
        }
        if (clientMessage.stages !== undefined || possibleStages !== undefined) {
          this.workflowRosters.set(clientMessage.runId, {
            ownerSessionId: currentId,
            group: ownerGroup,
            stages: clientMessage.stages ?? [],
            ...(possibleStages === undefined ? {} : { possibleStages }),
            ...(parent === undefined ? {} : { parent }),
          });
          this.retireAmbiguousNameAliases(clientMessage.runId);
        }
        acknowledgeRoute();
        break;
      }

      case "claim_workflow_invocation": {
        if (
          typeof clientMessage.requestId !== "string" ||
          typeof clientMessage.runId !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability ||
          currentId === null
        ) {
          throw new Error("Invalid workflow invocation claim");
        }
        writeMessageIfOpen(socket, {
          type: "workflow_invocation_claimed",
          requestId: clientMessage.requestId,
          claimed: this.claimWorkflowInvocation(currentId, clientMessage.runId, clientMessage.capability),
        });
        break;
      }

      case "register_live_workflow_stage_route": {
        if (
          typeof clientMessage.requestId !== "string" ||
          typeof clientMessage.runId !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability ||
          !Array.isArray(clientMessage.stageKeys) ||
          clientMessage.stageKeys.length < 1 ||
          clientMessage.stageKeys.length > 2 ||
          !clientMessage.stageKeys.every((stageKey) => typeof stageKey === "string" && stageKey.length > 0)
        ) {
          throw new Error("Invalid live workflow-stage route registration");
        }
        const refuse = (code: LiveWorkflowStageRouteRefusalCode): void => {
          // #3163: every precondition names its own condition, so a stage that started
          // while its owner was reconnecting is not reported as a duplicate live owner.
          writeMessageIfOpen(socket, {
            type: "registration_failed",
            reason: LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_REASONS[code],
            code,
          });
          this.endRefusedConnection(socket, currentId, setId);
        };
        if (!clientMessage.stageKeys.every((stageKey) => !stageKey.includes("/") && !stageKey.includes("*"))) {
          // A stage name containing "/" or "*" cannot be a canonical path segment, but throwing
          // here reaches the framing reader's onError and destroys the stage session's whole
          // broker connection. Refuse orderly like every neighbouring rejection; host clients
          // filter such name keys and register the stage-id key instead.
          refuse("invalid_stage_key");
          return;
        }
        const ownerRegistration = this.pendingStageRoutes.get(clientMessage.runId);
        const registeringSession = this.sessions.get(currentId);
        if (ownerRegistration === undefined) {
          refuse("owner_missing");
          return;
        }
        if (registeringSession === undefined || !isAgentRecipient(registeringSession.info)) {
          refuse("registrant_not_agent");
          return;
        }
        if (ownerRegistration.capability !== clientMessage.capability) {
          refuse("capability_mismatch");
          return;
        }
        if (
          !invocationOwnsGroup(
            ownerRegistration.group,
            registeringSession.registrationGroup ?? registeringSession.info.group ?? "default",
          )
        ) {
          refuse("group_mismatch");
          return;
        }
        const refusal = this.registerLiveWorkflowStageRoute(
          currentId,
          clientMessage.requestId,
          clientMessage.runId,
          clientMessage.stageKeys,
          clientMessage.capability,
        );
        if (refusal !== undefined) {
          refuse(refusal);
          return;
        }
        break;
      }

      case "pending_stage_message_result": {
        if (
          typeof clientMessage.requestId !== "string" ||
			(clientMessage.outcome !== "queued" &&
				clientMessage.outcome !== "delivered" &&
				clientMessage.outcome !== "forward" &&
				clientMessage.outcome !== "refused") ||
			(clientMessage.position !== undefined && typeof clientMessage.position !== "number") ||
			(clientMessage.target !== undefined && typeof clientMessage.target !== "string") ||
			(clientMessage.outcome === "forward" && typeof clientMessage.target !== "string") ||
			(clientMessage.reason !== undefined && typeof clientMessage.reason !== "string") ||
			(clientMessage.reasonCode !== undefined && clientMessage.reasonCode !== "message_id_conflict") ||
			(clientMessage.notInKnownSet !== undefined && clientMessage.notInKnownSet !== true) ||
			(clientMessage.forwardTargets !== undefined &&
				(!Array.isArray(clientMessage.forwardTargets) ||
					!clientMessage.forwardTargets.every((entry) => typeof entry === "string")))
        ) {
          throw new Error("Invalid pending-stage message result");
        }
        this.settlePendingStageMessageRequest(
          currentId,
          clientMessage.requestId,
          clientMessage.outcome,
          clientMessage.position,
			clientMessage.target,
			clientMessage.reason,
			clientMessage.reasonCode,
			clientMessage.notInKnownSet === true ? true : undefined,
			Array.isArray(clientMessage.forwardTargets) ? [...clientMessage.forwardTargets] : undefined,
        );
        break;
      }

		case "send":
		case "supervisor_send": {
			this.dispatchSend(socket, clientMessage, currentId);
			break;
		}

		case "received": {
			if (typeof clientMessage.messageId !== "string") throw new Error("Invalid received message");
			const recipient = this.sessions.get(currentId);
			if (recipient?.acknowledgesReceipt === true) {
				this.multiNode?.received(recipient, clientMessage.messageId);
				this.receipts.settle(clientMessage.messageId, deliveryTargetIdentity(recipient), recipient);
			}
			break;
		}

		case "send_pending_stage_notification": {
			this.handlePendingStageNotificationSend(socket, clientMessage, currentId);
			break;
		}

		case "pending_stage_notification_result": {
			if (typeof clientMessage.requestId !== "string" || typeof clientMessage.delivered !== "boolean") {
				throw new Error("Invalid pending-stage notification result");
			}
			this.settlePendingStageNotification(currentId, clientMessage.requestId, clientMessage.delivered);
			break;
		}

      case "presence":
	  case "join_group":
	  case "leave_group": {
        handleBrokerPresence(
          socket,
          clientMessage,
          currentId,
          this.sessions,
          (target, message) => writeMessageIfOpen(target, message),
          this.pendingQuestions,
        );
        const updated = this.sessions.get(currentId);
        if (updated !== undefined) this.multiNode?.sessionUpdated(updated);
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  /** Route one send or ask frame, as received or again after a restoring subagent's hold ends (#3760). */
  private dispatchSend(socket: net.Socket, clientMessage: SendClientMessage, senderId: string | null): void {
    handleBrokerSend(
      socket,
      clientMessage,
      senderId,
      this.sessions,
      this.deliveredMessages,
      writeMessageIfOpen,
      this.supervisorChannel,
      this.pendingQuestions,
      this.routePendingStage,
      this.resolveLiveWorkflowStage,
      this.canControlLiveWorkflowStage,
      this.resolveLegacyWorkflowStageTarget,
      writeMessageWithOutcome,
      this.isNonAgentWorkflowTarget,
      this.holdForRestoringRecipient,
      this.receipts,
      this.routeRemote,
    );
  }

  /** Multi-node S5: a send no local session resolved goes to the shared state once it is open. */
  private routeRemoteSend(request: RemoteSendRequest): void {
    if (this.multiNode !== undefined) {
      this.multiNode.routeSend(request);
      return;
    }
    // Off, or a send to a session on this broker: local delivery never depends on the shared database (spec §8).
    if (this.multiNodeStatus === "off" || (this.multiNodeStatus === "unavailable" && request.localTarget !== undefined)) {
      request.notFound();
      return;
    }
    if (this.multiNodeStatus === "starting") {
      if (request.localTarget === undefined) {
        void this.multiNodeFirstAttempt.then(() => this.routeRemoteSend(request));
        return;
      }
      // A send to a session on this broker waits for the first opening at most as long as the router's own retry
      // lookup would, then is delivered locally; whichever comes second does nothing, so it is answered once.
      let answered = false;
      const bound = setTimeout(() => {
        answered = true;
        request.notFound();
      }, LOCAL_RETRY_LOOKUP_BOUND_MS);
      void this.multiNodeFirstAttempt.then(() => {
        if (answered) return;
        answered = true;
        clearTimeout(bound);
        this.routeRemoteSend(request);
      });
      return;
    }
    writeMessageIfOpen(request.socket, {
      type: "delivery_failed",
      messageId: request.message.id,
      ...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
      reason: SHARED_STORAGE_UNAVAILABLE_REASON,
      ...(request.requirePendingReply ? { reasonCode: "session_not_found" as const } : {}),
    });
  }

  /** This broker's `broker_status` report: its storage selection's digest, multi-node state and live peers. */
  private async statusReport(): Promise<BrokerStatusReport> {
    const setting = this.sharedStorageSetting;
    const peers = this.multiNodeStatus === "on" ? await this.multiNode?.peerBrokers() : undefined;
    return {
      pid: process.pid,
      sessions: this.sessions.size,
      ...(setting === undefined
        ? {}
        : { storage: { digest: sharedStorageDigest(setting), source: sharedStorageSettingSource() } }),
      multiNode: {
        status: this.multiNodeStatus,
        ...(this.multiNodeReason === undefined ? {} : { reason: this.multiNodeReason }),
        ...(setting === undefined ? {} : describeSharedStorage(setting)),
        ...(peers === undefined ? {} : { peers }),
      },
    };
  }

  /**
   * The shared state is loaded lazily, so a single-node broker never loads the host storage layer. A database that
   * cannot be opened is retried with exponential backoff; meanwhile local delivery continues.
   */
  private startMultiNode(setting: Record<string, JsonWireValue>): void {
    this.multiNodeStatus = "starting";
    this.multiNodeReason = undefined;
    let settleFirstAttempt: () => void = () => {};
    this.multiNodeFirstAttempt = new Promise<void>((resolve) => {
      settleFirstAttempt = resolve;
    });
    const settle = (status: "on" | "off" | "unavailable"): void => {
      this.multiNodeStatus = status;
      settleFirstAttempt();
    };
    const report = (error: unknown): void => {
      this.multiNodeReason = error instanceof Error ? error.message : String(error);
      console.error(`Intercom multi-node routing is unavailable: ${this.multiNodeReason}`);
    };
    void (async () => {
      const startup = await resolveMultiNodeStartup(setting, dirname(INTERCOM_DIR), async () => {
        const loaded = await import("./open-broker-state.js");
        type Source = Parameters<typeof loaded.openIntercomBrokerState>[0];
        const opener: BrokerStateOpener<Source> = {
          resolveBrokerStateSource: (value, agentDir) =>
            loaded.resolveBrokerStateSource(value as Parameters<typeof loaded.resolveBrokerStateSource>[0], agentDir),
          openIntercomBrokerState: (source) => loaded.openIntercomBrokerState(source),
        };
        return opener;
      });
      if (startup.status === "off") {
        // A selection that does not resolve to a database, or an adapter that cannot load, leaves this broker
        // single-node, exactly as without a shared `storage`.
        this.multiNodeReason = startup.error === undefined ? (MULTI_NODE_OFF_REASONS[startup.reason] ?? startup.reason) : startup.reason;
        console.error(`Intercom multi-node routing is off: ${this.multiNodeReason}`);
        settle("off");
        return;
      }
      const { opener, source } = startup;
      for (let attempt = 0; !this.shuttingDown; attempt++) {
        try {
          const opened = await opener.openIntercomBrokerState(source);
          try {
            this.multiNode = await MultiNodeRouter.start({
              ...opened,
              host: {
                sessions: this.sessions,
                write: writeMessageIfOpen,
                writeConfirmed: writeMessageWithOutcome,
                supervisorCache: this.supervisorChannel,
                pendingQuestions: this.pendingQuestions,
                deliveredMessages: this.deliveredMessages,
                dispatch: (socket, clientMessage, senderId) => this.dispatchSend(socket, clientMessage, senderId),
              },
            });
          } catch (error) {
            await opened.bus.close().catch(() => {});
            await opened.state.close().catch(() => {});
            throw error;
          }
          // Reservations acknowledged before routing started (or while an earlier opening failed) were kept only
          // here; mirror the ones still in force so other brokers hold sends for them too. Releases and owner
          // departures from now on reach the router behind these reserves.
          for (const reservation of this.restoringRecipients.active()) {
            this.multiNode.restoringReserved(
              reservation.capability,
              reservation.ownerSessionId,
              reservation.childName,
              reservation.group,
              reservation.aliases,
              reservation.dormant,
            );
            if (reservation.gone !== undefined) {
              this.multiNode.restoringReleased(reservation.capability, reservation.ownerSessionId, reservation.gone);
            }
          }
          if (this.shuttingDown) await this.multiNode.close().catch(() => {});
          this.multiNodeReason = undefined;
          const { adapter, prefix } = describeSharedStorage(setting);
          console.error(`Intercom multi-node routing is on (adapter ${adapter}, prefix ${prefix ?? "none"})`);
          settle("on");
          return;
        } catch (error) {
          report(error);
          settle("unavailable");
          await new Promise<void>((resolve) => {
            setTimeout(resolve, Math.min(1_000 * 2 ** attempt, OUTBOX_BACKUP_POLL_INTERVAL_MS)).unref();
          });
        }
      }
    })();
  }

  /**
   * #3760: a send to a subagent its owner is restoring is held, by whichever sender, instead of failing with
   * `Session not found`; a send to one its owner reported gone gets the gone refusal.
   */
  private readonly holdForRestoringRecipient: RestoringRecipientHold = ({ socket, from, clientMessage, target, messageId, attemptId }) => {
    const held: HeldSend = { socket, senderId: from.info.id, messageId, clientMessage, ...(attemptId === undefined ? {} : { attemptId }) };
    const admission = this.restoringRecipients.admit(
      target,
      { id: from.info.id, info: from.info },
      held,
      clientMessage.awaitRestoringRecipient === true,
    );
    if (admission.kind === "none") return false;
    if (admission.kind === "refused") this.failHeldSend(held, admission.reason);
    else writeMessageIfOpen(socket, { type: "send_held", messageId, ...(attemptId === undefined ? {} : { attemptId }), timeoutMs: admission.timeoutMs });
    return true;
  };

  private failHeldSend(held: HeldSend, reason: string): void {
    writeMessageIfOpen(held.socket, {
      type: "delivery_failed",
      messageId: held.messageId,
      ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
      reason,
    });
  }

  private disconnectSession(sessionId: string): void {
    const departed = this.sessions.get(sessionId);
    if (!departed) return;

    this.restoringRecipients.dropSender(sessionId);
    // #3760: a departed owner restores nothing more; what it held goes through ordinary routing once it is gone.
    const unreserved = this.restoringRecipients.dropOwner(sessionId);

    this.pendingQuestions.pruneSender(sessionId);
    for (const question of this.pendingQuestions.takeForTarget(sessionId)) {
      const asker = this.sessions.get(question.senderSessionId);
      if (!asker) continue;
      writeMessageIfOpen(asker.socket, {
        type: "peer_disconnected",
        replyTo: question.messageId,
        peerSessionId: departed.info.id,
        ...(departed.info.name !== undefined ? { peerName: departed.info.name } : {}),
      });
    }

    for (const [runId, owner] of this.pendingStageRoutes) {
      if (owner.sessionId !== sessionId) continue;
      this.pendingStageRoutes.delete(runId);
      this.workflowRosters.delete(runId);
    }
    for (const [requestId, pending] of this.pendingStageAcknowledgments) {
      if (pending.ownerSessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pendingStageAcknowledgments.delete(requestId);
      this.releasePendingStageAcknowledgment(requestId);
      writeMessageIfOpen(pending.senderSocket, {
        type: "delivery_failed",
        messageId: pending.messageId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        reason: "Pending-stage route disconnected before acknowledging the message",
      });
    }
	for (const [requestId, pending] of this.pendingStageNotificationAcknowledgments) {
		if (pending.ownerSessionId !== sessionId && pending.recipientSessionId !== sessionId) continue;
		clearTimeout(pending.timeout);
		this.pendingStageNotificationAcknowledgments.delete(requestId);
		this.deliveredMessages.forget(pending.messageId, pending.signature);
		if (pending.ownerSessionId === sessionId) continue;
		this.failPendingStageNotification(
			pending.senderSocket,
			pending.messageId,
			pending.attemptId,
			"Recipient disconnected before acknowledging the pending-stage notification",
		);
	}
	for (const [target, registration] of this.liveWorkflowStageRoutes) {
		if (registration.sessionId === sessionId) this.liveWorkflowStageRoutes.delete(target);
	}
	for (const [requestId, activation] of this.liveWorkflowStageRouteActivations) {
		if (activation.sessionId === sessionId) this.liveWorkflowStageRouteActivations.delete(requestId);
	}
	this.workflowInvocationClaims.delete(sessionId);
	this.sessions.delete(sessionId);
	this.multiNode?.sessionLeft(departed);
	this.sessionIdReclaim.retire(sessionId, departed.registrationReturnAddress);
	if (isAgentRecipient(departed.info)) this.broadcastToMemberships({ type: "session_left", sessionId }, sessionGroups(departed.info), sessionId);
	for (const send of unreserved) this.dispatchSend(send.socket, send.clientMessage, send.senderId);
	}
  /** Deliver a broadcast once to each session represented in any given group. */
  private broadcastToMemberships(msg: BrokerMessage, groups: ReadonlySet<string>, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      if (id !== exclude && [...groups].some((group) => hasGroup(sessionGroups(session.info), group))) {
        writeMessageIfOpen(session.socket, msg);
      }
    }
  }

  private readPidFile(): number | undefined {
    try {
      const pid = Number.parseInt(readFileSync(PID_PATH, "utf-8").trim(), 10);
      return Number.isFinite(pid) ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  /** Unlink the pid file only while this process still owns PID_PATH. */
  private unlinkRuntimeFilesIfOwned(): void {
    if (this.readPidFile() !== process.pid) return;
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
  }

  private shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    console.log("Broker shutting down");

    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    this.pendingStageRoutes.clear();
    this.pendingStageAcknowledgments.clear();
    this.liveWorkflowStageRoutes.clear();
    this.liveWorkflowStageRouteActivations.clear();
    this.restoringRecipients.clear();
    this.receipts.clear();
	for (const pending of this.pendingStageNotificationAcknowledgments.values()) clearTimeout(pending.timeout);
	this.pendingStageNotificationAcknowledgments.clear();
	this.deliveredMessages.close();
    const multiNode = this.multiNode;
    if (multiNode === undefined) {
      this.exitAfterShutdown();
      return;
    }
    // Give this broker's leases up so other brokers see its sessions offline at once, within a bound.
    const bound = new Promise<void>((resolve) => setTimeout(resolve, MULTI_NODE_CLOSE_BOUND_MS).unref());
    void Promise.race([multiNode.close().catch(() => {}), bound]).finally(() => this.exitAfterShutdown());
  }

  private exitAfterShutdown(): never {
    const ownsRuntime = this.readPidFile() === process.pid;
    this.unlinkRuntimeFilesIfOwned();
    // Node unlinks a Unix socket path on server.close() even after a successor
    // rebound that path. Skip close when we no longer own the pid or the socket
    // path; process.exit still closes our fd. Windows named pipes are not
    // path-unlinked this way.
    if (process.platform === "win32" || (ownsRuntime && this.ownsSocketPath())) {
      this.server.close();
    }
    process.exit(0);
  }
}

// The stderr cap is already in place: `./bounded-stderr-install.js` is this file's first import.
async function startUnlessLiveBrokerAnswers(): Promise<void> {
  if (await isSocketAnswering(SOCKET_PATH)) exitBecauseLiveBrokerOwnsSocket();
  new IntercomBroker().start();
}

void startUnlessLiveBrokerAnswers();
