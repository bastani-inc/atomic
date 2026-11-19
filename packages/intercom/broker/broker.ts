// MUST stay first: ESM evaluates static dependencies before the importer's body, so this is the
// only position from which the stderr cap covers the other modules' own initialization.
import "./bounded-stderr-install.js";
// MUST stay second: it announces the broker's pid before the rest of the module graph loads (see start-announcement.ts).
import "./announce-on-import.js";
import net from "net";
import { chmodSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, statSync } from "fs";
import { hostname } from "os";
import { dirname } from "path";
import { createHash, randomUUID } from "crypto";
import { createMessageReader, type JsonWireValue } from "./framing.js";
import {
  clientHostsSessions,
  discardHeldWrites,
  flushHeldWrites,
  type HeldWrite,
  holdWrites,
  isHoldingWrites,
  recordClientProtocol,
  releaseHeldWrites,
  writeMessageIfOpen,
  writeMessageWithOutcome,
} from "./socket-writes.js";
import { BROKER_PROTOCOL, isBrokerProtocolRange, protocolRangeOf } from "./protocol-version.js";
import { boundWorkflowPossibleStageRow } from "../workflow-delivery-states.js";
import {
	isWorkflowFutureStagePredictionFields,
	isWorkflowSendPredictionFields,
	type WorkflowSendPredictionFields,
	workflowFutureStagePredictionFields,
	workflowSendPredictionFields,
} from "../workflow-prediction-fields.js";
import { isSocketAnswering } from "./socket-liveness.js";
import { acquireSocketReplacementLock, type SocketReplacementLock } from "./socket-replacement-lock.js";
import { type BrokerWatchdog, startBrokerWatchdog } from "./watchdog.js";
import { retractBrokerStartAnnouncement } from "./start-announcement.js";
import {
	getBrokerAwayAsksPath,
	getBrokerDeliveredMessagesPath,
	getBrokerPidPath,
	getBrokerWatchdogLogPath,
	chooseBrokerSocketPath,
	getBrokerSocketPath,
	getBrokerSocketReplacementLockPath,
	getIntercomDirPath,
	recordBrokerSocketPath,
} from "./paths.js";
import { describeSharedStorage, sharedStorageDigest, sharedStorageSettingSource } from "./shared-storage-setting.js";
import type {
	SessionInfo,
	Message,
	BrokerMessage,
	BrokerStatusReport,
	DeliveryFailureReasonCode,
	SupervisorRegistration,
	WorkflowStageRosterAnnouncement,
	WorkflowStageRosterEntry,
	WorkflowPossibleStageAnnouncement,
	WorkflowFutureStageRosterEntry,
	WorkflowRunParentAnnouncement,
	PendingStageRouteRefusalCode,
	ReleasedChildRefusal,
	HostedSessionAssignment,
	HostedSessionRefusal,
} from "../types.js";
import {
	formatWorkflowStageTarget,
	parseWorkflowStageTarget,
	withWorkflowStageTargetFinalSegment,
} from "../workflow-stage-target.js";
import { DELIVERED_MESSAGE_MAX_ENTRIES, DeliveredMessageCache } from "./delivered-message-cache.js";
import { isMessage, isSessionRegistration } from "./client-message-validation.js";
import { buildMessageSendSignature } from "./send-signature.js";
import {
	deliveryTargetIdentity,
	handleBrokerSend,
	messageFrameFor,
	type BrokerConnectedSession,
	type PendingStageRoute,
	type ReleasedAskerReplyRouter,
	type RemoteSendRequest,
	type RemoteSendRouter,
	type RestoringRecipientHold,
	createReturnPathAuthority,
	type ReturnPathAuthority,
	returnPathParty,
	type SendClientMessage,
	senderGroupIdentity,
} from "./send-handler.js";
import { type ReturnPathParty, type ReturnPathSender, ReturnPaths } from "./return-paths.js";
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
import {
	isReleasedReservationKey,
	isRestoringRecipientAlias,
	isValidChildName,
	type ParsedReleasedChild,
	RELEASED_CHILD_FRAME_MAX,
	releasedReservationKey,
	validateReleasedChildFrame,
} from "./released-children.js";
import { boundedReleaseReasons, type HeldSend, RestoringRecipients, type RestoringRecipientWake } from "./restoring-recipients.js";
import { DepartedChildren, type HeldSendRefusal, validateEndedChildrenFrame } from "./departed-children.js";
import { WorkflowStageAliases } from "./workflow-stage-aliases.js";
import { type IntercomRecipientGoneError, serializeIntercomRecipientGoneError } from "./recipient-gone-errors.js";
import { NotHostedSessionError, serializeIntercomHostedSessionError } from "./hosted-session-errors.js";
import { type ParsedHostedSession, validateHostSessionsFrame, validateUnhostSessionsFrame } from "./hosted-sessions.js";
import {
  failRefusedReleasedAsk,
  ReleasedAskerReplies,
  type RefusedReleasedAskerRoute,
  type ReleasedAskerReplyRoute,
} from "./released-asker-replies.js";
import {
  crashPoint,
  DEPARTURE_ASKS_TAKEN,
  DEPARTURE_ASKS_TO_IT_FAILED,
  DEPARTURE_ASKS_TO_IT_TAKEN,
} from "./crash-points.js";
import { releasedAskerReplyRefusal } from "./released-asker-remote-replies.js";
import { hasGroup, normalizeGroup, normalizeGroups, workflowInvocationRefusalFor } from "../group.js";
import { handleBrokerPresence, replaceSessionReach } from "./presence-handler.js";
import { PresenceFanout } from "./presence-fanout.js";
import {
	type HoldSender,
	knownGroupSummaries,
	reachesGroups,
	reachesSession,
	sessionGroups,
	setSessionGroups,
} from "./group-membership.js";
import { replyToList } from "./list-reply.js";
import {
	admitsMemberships,
	canPeek,
	childReachPolicy,
	createReachPolicy,
	type IntercomReachPolicy,
	isReachable,
	reachPolicyError,
} from "../reach-policy.js";
import { type PendingQuestion, PendingQuestionIndex } from "./pending-question-index.js";
import { AwayAsks, awayQueueFullReason } from "./away-asks.js";
import { TERMINAL_CHILD_ASK_REFUSAL } from "../recipient-purpose.js";
import { type ReceiptSender, RecipientReceipts, UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { deliverAskFailure, deliverHeldToAsker, failLostReply } from "./ask-failures.js";
import { matchStagePathSegments } from "../workflow-stage-path-matching.js";
import { DELIVERED_MESSAGE_TTL_MS, RECIPIENT_RECEIPT_TIMEOUT_MS } from "../retry-policy.js";
import { isAgentRecipient } from "../recipient-purpose.js";
import {
  BROKER_RETIRING_CODE,
  BROKER_RETIRING_REASON,
  BROKER_ROUTING_CHANGED_CODE,
  BROKER_ROUTING_CHANGED_REASON,
} from "../recoverable-disconnect.js";
import {
	LIVE_WORKFLOW_STAGE_ROUTE_REFUSAL_REASONS,
	type LiveWorkflowStageRouteRefusalCode,
} from "../live-route-refusal.js";
import { SUPERVISOR_AUTHORIZATION_REFUSED_CODE, SUPERVISOR_AUTHORIZATION_REFUSED_REASON } from "../supervisor-refusal.js";

const INTERCOM_DIR = getIntercomDirPath();
/** The socket clients reach the running broker on, until this broker chooses its own under the startup lock (#5040). */
let SOCKET_PATH = getBrokerSocketPath();
const BROKER_IDLE_TIMEOUT_MS = 5_000;
const UNCLASSIFIED_CONNECTION_RECHECK_MS = 100;
const PID_PATH = getBrokerPidPath();
const SOCKET_REPLACEMENT_LOCK_PATH = getBrokerSocketReplacementLockPath();

const PENDING_STAGE_MESSAGE_TIMEOUT_MS = 10_000;
/**
 * #5096: delay before retrying a delivered-message delete that failed, e.g. while another broker held the write lock.
 * A delete waits only `FORGET_BUSY_TIMEOUT_MS` for the lock, so a retry costs the broker milliseconds.
 */
const PENDING_FORGET_RETRY_MS = 1_000;
const LISTEN_ATTEMPTS = 5;
const LISTEN_RETRY_DELAY_MS = 100;
const SOCKET_OWNERSHIP_CHECK_MS = 1_000;
const SHUTDOWN_CLOSE_BOUND_MS = 2_000;
/** What a registration is answered with once this broker is closing: the client spawns the replacement and registers again. */
const RETIRING_REFUSAL = {
  type: "registration_failed",
  reason: BROKER_RETIRING_REASON,
  code: BROKER_RETIRING_CODE,
} as const;
const ROUTING_CHANGED_REFUSAL = {
  type: "registration_failed",
  reason: BROKER_ROUTING_CHANGED_REASON,
  code: BROKER_ROUTING_CHANGED_CODE,
} as const;
const NO_SHARED_STORAGE_REASON = "no shared storage selection (top-level `storage` in global settings, or ATOMIC_STORAGE)";
/** The off reasons `resolveBrokerStateSource` reports without an error, as the log and `broker_status` state them. */
const MULTI_NODE_OFF_REASONS: Readonly<Record<string, string>> = {
  "no-storage": "the shared storage selection names no database",
  memory: "the shared storage selection is in memory",
  "domain-only-adapter": "the storage adapter has no openDatabase hook",
};

function socketPathInode(): number | undefined {
  try {
    return statSync(SOCKET_PATH).ino;
  } catch {
    return undefined;
  }
}

/** The socket lock, or undefined when a starting broker still holds it after `budgetMs`. */
async function acquireSocketLockWithin(budgetMs: number): Promise<SocketReplacementLock | undefined> {
  // A lock taken after the budget is never released by hand: the broker exits at once, and a lock whose holder is dead
  // is taken over.
  return Promise.race([
    acquireSocketReplacementLock(SOCKET_REPLACEMENT_LOCK_PATH).catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(resolve, budgetMs).unref()),
  ]);
}

function exitBecauseLiveBrokerOwnsSocket(): never {
  console.error(`Intercom broker not started: a live broker already answers on ${SOCKET_PATH}`);
  process.exit(0);
}

interface PendingStageRouteRegistration {
  readonly sessionId: string;
  readonly generation?: string;
  readonly group: string;
  readonly capability: string;
  /** Registered by a restarted owner for an interrupted run; yields to the process that resumes it (#3760). */
  readonly dormant?: true;
  /**
   * #4006: held only by the process that launched the run, never by its stages. Presenting it in
   * `claim_workflow_invocation` grants that session the invocation's control without membership.
   */
  readonly launcherCapability?: string;
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

interface PendingReleasedReplyAck {
  readonly handoffId: string;
  /** Who the reply is from: the replier, or the recipient that ended, for a failed ask the broker made (#4751). */
  readonly from: SessionInfo;
  /** A failed ask the broker made: no replier waits for its outcome, so the broker keeps it until it is delivered. */
  readonly synthetic?: true;
  /** The reply itself, delivered to the child as an ordinary send when no call of the child waits for it (#4751). */
  readonly message: Message;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly socket: net.Socket;
  readonly attemptId?: string;
  readonly ownerSessionId: string;
  readonly questionId: string;
  readonly childName: string;
  readonly route: ReleasedAskerReplyRoute;
}

/** What registering a session reads from its validated `register` message. */
interface SessionRegistrationRequest {
  readonly session: Omit<SessionInfo, "id">;
  readonly registrationGroup?: unknown;
  readonly returnAddress?: unknown;
  readonly supervisorOwnerToken?: unknown;
  readonly acknowledgesReceipt?: unknown;
  readonly supervisor?: unknown;
  readonly reachPolicy?: IntercomReachPolicy;
}

function isSupervisorRegistration(value: unknown): value is SupervisorRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const registration = value as Record<string, unknown>;
  return typeof registration.capability === "string"
    && typeof registration.supervisorSessionId === "string";
}

const RESTORING_RECIPIENT_ALIASES_MAX = 4;

function isRestoringRecipientAliasList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= RESTORING_RECIPIENT_ALIASES_MAX && value.every((alias) => typeof alias === "string");
}

const HOSTED_REPLY_ONLY_REFUSAL =
	"A session hosted by a session with an Intercom reach policy can only reply to an ask it received";

function isPendingReply(clientMessage: SendClientMessage): boolean {
	const message = clientMessage.message;
	return (
		clientMessage.type === "send" &&
		clientMessage.requirePendingReply === true &&
		isMessage(message) &&
		message.replyTo !== undefined &&
		message.expectsReply !== true
	);
}

function hostedWithinReach(reach: IntercomReachPolicy, item: ParsedHostedSession): boolean {
	for (const group of normalizeGroups(item.session.groups, item.session.group)) {
		if (!isReachable(reach, group) && !group.startsWith("workflow:")) return false;
	}
	return true;
}

function readRegistrationReach(
	frame: JsonWireValue | undefined,
	session: Omit<SessionInfo, "id">,
	registrationGroup: string | undefined,
): { readonly reach?: IntercomReachPolicy; readonly refusal?: string } {
	if (frame === undefined) return {};
	if (typeof frame !== "object" || frame === null || Array.isArray(frame)) throw new Error("Invalid reach policy");
	const error = reachPolicyError(frame.home, frame.reachable);
	if (error !== undefined || typeof frame.home !== "string" || !Array.isArray(frame.reachable)
    || !frame.reachable.every((group): group is string => typeof group === "string"))
    throw new Error(`Invalid reach policy: ${error ?? "reachable"}`);
	const reach = createReachPolicy(frame.home, frame.reachable);
	const groups = [...normalizeGroups(session.groups, session.group)];
	if (registrationGroup !== undefined && normalizeGroup(registrationGroup) !== reach.home)
		return { refusal: `Intercom registration group ${normalizeGroup(registrationGroup)} is not the reach policy's home group ${reach.home}` };
	if (!admitsMemberships(reach, groups))
		return {
			refusal: `Intercom memberships ${groups.join(", ")} are outside the reach policy (home group ${reach.home}; reachable groups: ${reach.reachable.join(", ") || "none"})`,
		};
	return { reach };
}

function holdSenderOf(from: ConnectedSession, answersAsk?: true): HoldSender {
	return {
		id: from.info.id,
		info: from.info,
		...(from.reach === undefined ? {} : { reach: from.reach }),
		...(answersAsk === undefined ? {} : { answersAsk }),
	};
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
				isWorkflowFutureStagePredictionFields(announcement) &&
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
  /** #5146: presence frames gathered per recipient, so they grow with the changes, not their square. */
  private readonly presenceFanout = new PresenceFanout(this.sessions, (socket, message) => {
    writeMessageIfOpen(socket, message);
  });
  /** #4642: the sessions each connection hosts, by the hosting session's id. */
  private hostedSessions = new Map<string, Set<string>>();
  private unclassifiedConnections = new Map<net.Socket, number>();
  private server: net.Server;
  private readonly instanceId = randomUUID();
  private releaseOrder = 0;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private watchdog: BrokerWatchdog | undefined;
  private boundSocketInode: number | undefined;
  private lastConnectionAt = performance.now();
  private deliveredMessageCache: DeliveredMessageCache | undefined;
  /**
   * #4727: the durable delivered-message authority is opened when the first session registers, before that session can
   * send, so a broker that idles out having served no session leaves no durable state in the agent directory. A broker
   * that does serve one reads what its predecessors recorded, so a retried send is still deduplicated across restarts.
   */
  private openDeliveredMessages(): DeliveredMessageCache {
    // #4751: what waits for away sessions is kept with the same lifetime as the delivered-message authority.
    if (this.deliveredMessageCache === undefined) {
      try {
        // #4829: live asks are written to it too, with their peers' return addresses, so they outlive this broker.
        this.pendingQuestions.useAwayStore(
          new AwayAsks(getBrokerAwayAsksPath()),
          (sessionId) =>
            this.sessions.get(sessionId)?.registrationReturnAddress ?? this.sessionIdReclaim.retiredReturnAddress(sessionId),
        );
      } catch (error) {
        console.error(`Intercom broker keeps away asks in memory only: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    this.deliveredMessageCache ??= new DeliveredMessageCache(
      DELIVERED_MESSAGE_TTL_MS,
      DELIVERED_MESSAGE_MAX_ENTRIES,
      getBrokerDeliveredMessagesPath(),
    );
    return this.deliveredMessageCache;
  }

  private get deliveredMessages(): DeliveredMessageCache {
    return this.openDeliveredMessages();
  }
  /** #5096: reservations whose delete failed, by message ID, retried until the delete lands. */
  private pendingForgets = new Map<string, string>();
  private pendingForgetTimer: NodeJS.Timeout | null = null;

  /**
   * Remove a reservation after a proven non-delivery without letting a failed delete escape (#5096).
   *
   * `forget` is a durable SQLite DELETE that throws while another connection holds the write lock or the disk fails.
   * Its callers include timer callbacks and socket close handlers, where a throw is an uncaughtException that ends
   * the broker, and outcome paths whose sender must still hear `delivery_failed`. A failed delete is logged and
   * retried later, so a stale reservation does not keep refusing the sender's retry as uncertain. The delete waits
   * only `FORGET_BUSY_TIMEOUT_MS` for the lock, so a held lock does not stall the broker. Callers write the sender's
   * outcome first; the sender's retry is handled only after this synchronous delete, and a failed one is retried
   * before the ID is looked up again.
   */
  private forgetDelivered(messageId: string, signature: string): void {
    this.pendingForgets.delete(messageId);
    try {
      this.deliveredMessages.forget(messageId, signature);
    } catch (error) {
      this.pendingForgets.set(messageId, signature);
      console.error(
        `Intercom broker could not forget delivered message ${messageId}; retrying: ${error instanceof Error ? error.message : String(error)}`,
      );
      this.schedulePendingForgets();
    }
  }

  /** Retry a failed delete for `messageId` before its ID is looked up or reserved again. */
  private retryPendingForget(messageId: string): void {
    const signature = this.pendingForgets.get(messageId);
    if (signature !== undefined) this.forgetDelivered(messageId, signature);
  }

  private schedulePendingForgets(): void {
    if (this.pendingForgetTimer !== null || this.shuttingDown) return;
    this.pendingForgetTimer = setTimeout(() => {
      this.pendingForgetTimer = null;
      for (const messageId of [...this.pendingForgets.keys()]) this.retryPendingForget(messageId);
    }, PENDING_FORGET_RETRY_MS);
    this.pendingForgetTimer.unref?.();
  }
  private supervisorChannel = new SupervisorChannelCache();
  private sessionIdReclaim = new SessionIdReclaim();
  /** Connections whose requested id is being checked against its multi-node binding before they register. */
  private claimingSessionIds = new WeakSet<net.Socket>();
  private pendingQuestions = new PendingQuestionIndex();
  private receipts = new RecipientReceipts<ConnectedSession>();
  // #4751: an ask has no expiry, so a released asker's route lasts until the child or its owner ends or it is back.
  private releasedAskerReplies = new ReleasedAskerReplies(undefined, Number.POSITIVE_INFINITY, undefined, () => {
    console.error("Intercom broker released-asker reply route capacity reached; dropped routes are counted in broker_status");
  });
  private releasedReplyAcks = new Map<string, PendingReleasedReplyAck>();
  private restoringRecipients = new RestoringRecipients((held, reason, reasonCode, error) =>
    error === undefined ? this.failHeldSend(held, reason, reasonCode) : this.failHeldSendWith(held, error),
  );
  /** #4639: subagents whose session is gone, held for until they return or their owner says why they ended. */
  private departedChildren = new DepartedChildren((refusals) => this.refuseHeldSends(refusals));
  private pendingStageRoutes = new Map<string, PendingStageRouteRegistration>();
  private pendingStageAcknowledgments = new Map<string, PendingStageAcknowledgment>();
	private pendingStageNotificationAcknowledgments = new Map<string, PendingStageNotificationAcknowledgment>();
  private liveWorkflowStageRoutes = new Map<string, LiveWorkflowStageRouteRegistration>();
  /** Return paths: who may answer a sender outside its groups that wrote to it. */
  private readonly returnPaths = new ReturnPaths();
  private readonly returnPathAuthority: ReturnPathAuthority = createReturnPathAuthority(this.returnPaths, this.sessions);
  /** #4639: the names and ids each stage's sessions registered under, so they keep reaching the stage. */
  private workflowStageAliases = new WorkflowStageAliases();
  private workflowRosters = new Map<string, WorkflowRosterRegistration>();
  private liveWorkflowStageRouteActivations = new Map<string, LiveWorkflowStageRouteActivation>();
  /**
   * #4006: runs each connected session launched, proven with the run's launcher capability. Keyed by session,
   * then run, holding the capability claimed; a claim lapses when the run's route carries another one.
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
  /** Held from before this broker writes its pid file until it listens or gives up starting. */
  private releaseStartupLock: () => void = () => {};
  private holdsStartupLock: () => boolean = () => false;

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") chmodSync(INTERCOM_DIR, 0o700);
    this.server = net.createServer(this.handleConnection.bind(this));
    this.pendingQuestions.failThroughOwnerWhen((question) => this.releasedAskerReplies.hasOwnedRoute(question));
    // #5095: a reply that never reached its asker after its recipient ended fails the ask then, once.
    this.pendingQuestions.onReplyLost((question, held, askerReturnAddress) =>
      failLostReply({
        question,
        held,
        askerReturnAddress,
        asker: this.sessions.get(question.senderSessionId),
        pending: this.pendingQuestions,
        write: this.writeAfterDeparture,
      }),
    );
    // #4997: an ask between two top-level sessions may follow either of them to another broker, even after a crash.
    this.pendingQuestions.movableWhen((question) =>
      [question.senderSessionId, question.targetSessionId].every((id) => this.isTopLevel(this.sessions.get(id))),
    );
    // #4992: a reply or failure held for a released subagent wakes it through its owner, also after a restart.
    this.pendingQuestions.onHeldForReleasedAsker((ownerSessionId, childName) => {
      if (this.restoringRecipients.releasedOwner(childName) === ownerSessionId)
        this.afterDeparture(() => this.wakeRestoringRecipientOwner({ ownerSessionId, childName }));
    });
    this.pendingQuestions.failToConnectedAskerWhen((question, returnAddress) =>
      this.isConnectedAs(question.senderSessionId, returnAddress),
    );
    // #4829: a released subagent's asks outlive this broker too; the next one keeps them for the subagent's return.
    this.releasedAskerReplies.persistWith({
      kept: (question) => this.pendingQuestions.writeLive(question),
      removed: (question) => this.pendingQuestions.forgetLive([question]),
    });
    this.releasedAskerReplies.refuseWith((route) => this.failRefusedReleasedRoute(route));
  }

  /**
   * The pid file is written before the socket can accept a connection, so a client that has connected always finds
   * it (#4409). Brokers start one at a time under the socket lock, so one that yields never claims the pid file.
   */
  async start(): Promise<void> {
    let startupLock: SocketReplacementLock;
    try {
      startupLock = await acquireSocketReplacementLock(SOCKET_REPLACEMENT_LOCK_PATH, {
        onWait: () => console.error(`Intercom broker waiting for another broker starting on ${SOCKET_PATH}`),
      });
    } catch (error) {
      console.error(`Intercom broker not started: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    this.releaseStartupLock = startupLock;
    this.holdsStartupLock = startupLock.held;
    // Read again under the lock: a broker that started meanwhile may have recorded a socket of its own.
    SOCKET_PATH = getBrokerSocketPath();
    if (await isSocketAnswering(SOCKET_PATH)) {
      this.releaseStartupLock();
      exitBecauseLiveBrokerOwnsSocket();
    }
    SOCKET_PATH = chooseBrokerSocketPath();
    writeFileSync(PID_PATH, String(process.pid));
    this.recordSocketPath();
    this.listen(1);
    if (this.sharedStorageSetting !== undefined) this.startMultiNode(this.sharedStorageSetting);
    else console.error(`Intercom multi-node routing is off: ${NO_SHARED_STORAGE_REASON}`);
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private listen(attempt: number): void {
    if (!this.holdsStartupLock()) {
      this.exitHavingLostStartupLock();
      return;
    }
    const onError = (error: NodeJS.ErrnoException) => {
      void this.recoverFromListenError(error, attempt);
    };
    this.server.once("error", onError);
    this.server.listen(SOCKET_PATH, () => {
      this.server.off("error", onError);
      if (process.platform !== "win32") {
        const inode = socketPathInode();
        if (inode === undefined) {
          this.rebindVanishedSocket(attempt);
          return;
        }
        this.boundSocketInode = inode;
      }
      this.releaseStartupLock();
      // The pid file takes over from the start-up announcement the moment the broker answers.
      retractBrokerStartAnnouncement();
      console.log(`Intercom broker started (pid: ${process.pid})`);
      this.watchdog = startBrokerWatchdog(SOCKET_PATH, this.instanceId, getBrokerWatchdogLogPath());
      this.lastConnectionAt = performance.now();
      this.scheduleShutdownCheck();
      if (this.boundSocketInode !== undefined) this.watchSocketOwnership();
    });
  }

  /**
   * #5040: the path this broker just bound is gone. The startup lock is still held, so no broker that takes it can have
   * bound the path since; the server is closed while nothing is there for its close to unlink, and bound again.
   */
  private rebindVanishedSocket(attempt: number): void {
    if (!this.holdsStartupLock()) {
      this.exitHavingLostStartupLock();
      return;
    }
    this.server.close();
    if (attempt >= LISTEN_ATTEMPTS) {
      console.error(`Intercom broker could not listen on ${SOCKET_PATH}: the socket vanished after it was bound`);
      this.abandonStart();
      process.exit(1);
    }
    console.error(`Intercom broker socket ${SOCKET_PATH} vanished after it was bound; binding it again`);
    this.listen(attempt + 1);
  }

  private ownsSocketPath(): boolean {
    if (this.boundSocketInode === undefined) return process.platform === "win32";
    return socketPathInode() === this.boundSocketInode;
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
    if (error.code === "EADDRINUSE" && (await isSocketAnswering(SOCKET_PATH))) {
      this.abandonStart();
      exitBecauseLiveBrokerOwnsSocket();
    }
    if (error.code !== "EADDRINUSE" || attempt >= LISTEN_ATTEMPTS) {
      console.error(`Intercom broker could not listen on ${SOCKET_PATH}: ${error.message}`);
      this.abandonStart();
      process.exit(1);
    }
    if (process.platform === "win32") {
      await new Promise<void>((resolve) => setTimeout(resolve, LISTEN_RETRY_DELAY_MS));
      this.listen(attempt + 1);
      return;
    }
    if (!this.holdsStartupLock()) {
      this.exitHavingLostStartupLock();
      return;
    }
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // A clean path has no stale socket to remove.
    }
    this.listen(attempt + 1);
  }

  /** Sessions whose runtime or temp directory differs from this broker's find its socket through the record (#5040). */
  private recordSocketPath(): void {
    try {
      recordBrokerSocketPath(SOCKET_PATH);
    } catch (error) {
      console.error(`Intercom broker could not record its socket path ${SOCKET_PATH}:`, error);
    }
  }

  private exitHavingLostStartupLock(): void {
    console.error(`Intercom broker not started: it lost the socket lock for ${SOCKET_PATH} while starting`);
    this.abandonStart();
    process.exit(1);
  }

  /** A broker that does not start leaves no pid file of its own and lets the next starting broker go ahead. */
  private abandonStart(): void {
    this.unlinkRuntimeFilesIfOwned();
    this.releaseStartupLock();
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
		return requester.reach === undefined || canPeek(requester.reach, selected);
	}

	/**
	 * The run's host queued a message for the stages `target` names: each of them may answer its sender once it starts
	 * and the message reaches it. An owner's answer for a message it had already queued or delivered changes nothing.
	 */
	private queueStageReturnPath(pending: PendingStageAcknowledgment): void {
		const sender = this.sessions.get(pending.senderSessionId);
		if (sender === undefined || sender.info.id !== pending.sender.id) return;
		// A stage may take its route while its host is still answering for this message (the going-live barrier holds
		// the stage's acknowledgment behind it); the host hands the message to that live stage, so it reaches it now.
		const parsed = parseWorkflowStageTarget(pending.target);
		const liveRoutes: { stage: ReturnPathParty; target: string }[] = [];
		const runPrefix = parsed === undefined ? undefined : `workflow:${parsed.rootRunId}/`;
		for (const [target, route] of this.liveWorkflowStageRoutes) {
			if (runPrefix === undefined || !target.startsWith(runPrefix)) continue;
			const stage = this.sessions.get(route.sessionId);
			if (stage !== undefined) liveRoutes.push({ stage: returnPathParty(stage), target });
		}
		this.returnPaths.queue(pending.target, returnPathParty(sender), pending.messageId, liveRoutes, (stage, from) =>
			this.canAlreadyReach(stage.sessionId, from),
		);
	}

	/** Whether a live session here other than `departed` is registered under `departed`'s return-path identity. */
	private identityLiveHere(departed: ConnectedSession, identity: string): boolean {
		for (const session of this.sessions.values()) {
			if (session === departed || session.registrationReturnAddress !== departed.registrationReturnAddress) continue;
			if (returnPathParty(session).identity === identity) return true;
		}
		return false;
	}

	/** A stage took `target`: the messages queued for it reached it, opening its paths back to their senders. */
	private stageTookRoute(stage: ConnectedSession, target: string): void {
		this.returnPaths.stageStarted(returnPathParty(stage), target, (sender: ReturnPathSender) =>
			this.canAlreadyReach(stage.info.id, sender),
		);
	}

	/** Whether the stage `stageId` already shares a group with `sender`'s live session, so needs no return path to it. */
	private canAlreadyReach(stageId: string, sender: ReturnPathSender): boolean {
		const stage = this.sessions.get(stageId);
		const live = this.sessions.get(sender.sessionId);
		return (
			stage !== undefined &&
			live !== undefined &&
			returnPathParty(live).identity === sender.identity &&
			reachesSession(stage, live.info)
		);
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
			if (route?.launcherCapability === capability && normalizeGroup(route.group) === group) return true;
		}
		return false;
	}

	/**
	 * Only the holder of a run's launcher capability can claim to have launched it. That capability is
	 * separate from the route capability every stage of the run holds, so a stage cannot claim.
	 */
	private claimWorkflowInvocation(sessionId: string, runId: string, capability: string): boolean {
		const route = this.pendingStageRoutes.get(runId);
		if (
			route?.launcherCapability === undefined ||
			route.launcherCapability !== capability ||
			!normalizeGroup(route.group).startsWith("workflow:")
		) {
			return false;
		}
		const claims = this.workflowInvocationClaims.get(sessionId) ?? new Map<string, string>();
		// Claims on runs whose routes are gone can never authorize again.
		for (const claimedRunId of claims.keys()) {
			if (!this.pendingStageRoutes.has(claimedRunId)) claims.delete(claimedRunId);
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
	const selected = selectedGroup === undefined ? undefined : normalizeGroup(selectedGroup);
	const entries: WorkflowStageRosterEntry[] = [];
	for (const [runId, roster] of this.workflowRosters) {
		for (const stage of roster.stages) {
			if (!stage.routeEligible || !isAgentRecipient(stage)) continue;
			const parentControl =
				this.canControlWorkflowInvocation(requester, roster.group) && invocationOwnsGroup(roster.group, stage.group);
			const directMembership = reachesGroups(requester, [stage.group]);
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
					...workflowFutureStagePredictionFields(row),
					group: roster.group,
				});
			}
		}
		return entries;
	}

  /** The preconditions of a live workflow-stage route a registrant may hold, checked before any alias is taken. */
  private liveWorkflowStageRouteRefusal(
    registrant: ConnectedSession | undefined,
    runId: string,
    stageKeys: readonly string[],
    capability: string,
  ): LiveWorkflowStageRouteRefusalCode | undefined {
    if (!stageKeys.every((stageKey) => !stageKey.includes("/") && !stageKey.includes("*"))) return "invalid_stage_key";
    const ownerRegistration = this.pendingStageRoutes.get(runId);
    if (ownerRegistration === undefined) return "owner_missing";
    if (registrant === undefined || !isAgentRecipient(registrant.info)) return "registrant_not_agent";
    if (ownerRegistration.capability !== capability) return "capability_mismatch";
    const registrantGroup = registrant.registrationGroup ?? registrant.info.group ?? "default";
    if (!invocationOwnsGroup(ownerRegistration.group, registrantGroup)) return "group_mismatch";
    return undefined;
  }

  /** #4642: a hosted session takes its live workflow-stage aliases as a connected stage would; a refusal keeps it hosted. */
  private registerHostedLiveRoute(
    hosted: ConnectedSession,
    route: NonNullable<ParsedHostedSession["liveRoute"]>,
  ): LiveWorkflowStageRouteRefusalCode | undefined {
    return (
      this.liveWorkflowStageRouteRefusal(hosted, route.runId, route.stageKeys, route.capability) ??
      this.registerLiveWorkflowStageRoute(hosted.info.id, randomUUID(), route.runId, route.stageKeys, route.capability)
    );
  }

  /** #4642: register one session hosted by `hostId`, listed and addressed like a connected one, on the host's socket. */
  private hostSession(hostId: string, socket: net.Socket, item: ParsedHostedSession, confined: boolean): ConnectedSession {
    const id = randomUUID();
    const initialGroups = normalizeGroups(item.session.groups, item.session.group);
    const legacyGroup = normalizeGroup(item.session.group ?? initialGroups.values().next().value);
    const info: SessionInfo = { ...item.session, id };
    setSessionGroups(info, confined ? new Set([legacyGroup]) : initialGroups, legacyGroup);
    const name = info.name?.trim();
    const hosted: ConnectedSession = {
      socket,
      info,
      registrationGroup: legacyGroup,
      ...(name ? { registrationName: name } : {}),
      ...(item.returnAddress === undefined ? {} : { registrationReturnAddress: item.returnAddress }),
      hostedBy: hostId,
      ...(confined ? { reach: childReachPolicy(legacyGroup) } : {}),
    };
    this.sessions.set(id, hosted);
    let hosts = this.hostedSessions.get(hostId);
    if (hosts === undefined) {
      hosts = new Set();
      this.hostedSessions.set(hostId, hosts);
    }
    hosts.add(id);
    this.broadcastToMemberships({ type: "session_joined", session: info }, sessionGroups(info), id);
    return hosted;
  }

  /** #4642: a send as a session this connection does not host is refused with `NotHostedSessionError`. */
  private refuseHostedSender(socket: net.Socket, clientMessage: SendClientMessage, hostedSender: string): void {
    const message = clientMessage.message;
    const error = new NotHostedSessionError({ sessionId: hostedSender });
    writeMessageIfOpen(socket, {
      type: "delivery_failed",
      messageId: isMessage(message) ? message.id : "unknown",
      ...(typeof clientMessage.attemptId === "string" ? { attemptId: clientMessage.attemptId } : {}),
      reason: error.message,
      reasonCode: error.code,
      error: serializeIntercomHostedSessionError(error),
    });
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
    const stage = this.sessions.get(currentId);
    if (stage !== undefined) for (const target of targets) this.stageTookRoute(stage, target);
    this.recordWorkflowStageAliases(currentId, runId, registrant?.target ?? targets[0]);
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

	/** #4639: the stage session's names and ids reach its stage at `target` for as long as the run's route lives. */
	private recordWorkflowStageAliases(sessionId: string, runId: string, target: string | undefined): void {
		const session = this.sessions.get(sessionId);
		if (session === undefined || target === undefined) return;
		const group = normalizeGroup(session.registrationGroup ?? session.info.group);
		const aliases = [session.info.name, session.registrationName, session.info.id, session.registrationReturnAddress];
		this.workflowStageAliases.record({ runId, target, group }, aliases.filter((alias): alias is string => alias !== undefined));
	}

	/**
	 * #4639: the `workflow:` target a stage session's name or id stands for, to a sender that may reach the stage: one
	 * in the stage's group, or one that controls its run. Anyone else finds nothing, as before.
	 */
	private resolveWorkflowStageAlias = (sender: ConnectedSession, alias: string): string | undefined => {
		const stage = this.workflowStageAliases.resolve(alias);
		if (stage === undefined) return undefined;
		const route = this.pendingStageRoutes.get(stage.runId);
		if (route === undefined) {
			this.workflowStageAliases.forgetRun(stage.runId);
			return undefined;
		}
		const reachable = reachesGroups(sender, [stage.group]) || this.canControlWorkflowInvocation(sender, route.group);
		if (!reachable) return undefined;
		// #4642: a released stage whose hosted peer is gone and that no live session answers for is refused with why
		// by the send itself, not forwarded to a run that has nothing to queue for it.
		const live = this.liveWorkflowStageRoutes.get(stage.target);
		const liveSession = live === undefined ? undefined : this.sessions.get(live.sessionId);
		if (liveSession === undefined && this.departedChildren.isReleasedStage(alias, holdSenderOf(sender))) {
			return undefined;
		}
		return stage.target;
	};

	private routePendingStage = (route: PendingStageRoute): boolean => {
		const ownerMatch = this.pendingStageOwnerForTarget(route.target);
		if (ownerMatch === undefined) return false;
		const { runId, registration: ownerRegistration } = ownerMatch;
		const owner = this.sessions.get(ownerRegistration.sessionId);
		if (owner === undefined) {
			this.pendingStageRoutes.delete(runId);
			this.workflowStageAliases.forgetRun(runId);
			this.returnPaths.forgetRun(runId);
			return false;
		}
    if (route.liveTargetId === undefined && !this.canControlWorkflowInvocation(route.from, ownerRegistration.group)) {
      writeMessageIfOpen(route.socket, {
        type: "delivery_failed",
        messageId: route.message.id,
        ...(route.attemptId ? { attemptId: route.attemptId } : {}),
        // A workflow stage registered outside the invocation can't gain control by joining; say so.
        reason: workflowInvocationRefusalFor(route.from.registrationGroup, ownerRegistration.group),
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
		prediction?: WorkflowSendPredictionFields,
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
			this.queueStageReturnPath(pending);
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
				...prediction,
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
		this.retryPendingForget(pending.messageId);
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
		const frame: BrokerMessage = messageFrameFor(target, pending.sender, pending.message);
		const signature = pending.signature;
		// Taken as the message is handed over: its receipt opens nothing once every registration of the sender ended since.
		const handedOver = this.returnPaths.mark();
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
			this.returnPathAuthority.delivered(recipient, returnPathParty(from), from.info, pending.messageId, handedOver);
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
					hold: (waiting, timeoutMs) => {
						writeMessageIfOpen(waiting.socket, {
							type: "send_held",
							messageId: pending.messageId,
							...(waiting.attemptId === undefined ? {} : { attemptId: waiting.attemptId }),
							timeoutMs,
						});
					},
				},
				sender,
			);
		}
		if (!writeMessageIfOpen(target.socket, frame)) {
			if (confirmsSaves) this.receipts.drop(pending.messageId);
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason: "Session not found",
			});
			if (reservation === "recorded") this.forgetDelivered(pending.messageId, pending.signature);
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
			if (!writeMessageIfOpen(targetSession.socket, messageFrameFor(targetSession, pending.sender, pending.message)))
				continue;
			const sender = this.sessions.get(pending.senderSessionId);
			if (sender !== undefined && sender.info.id === pending.sender.id)
				this.returnPathAuthority.delivered(targetSession, returnPathParty(sender), pending.sender, pending.messageId);
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
		this.writeAfterDeparture(socket, {
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
		this.retryPendingForget(message.id);
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
			!this.canReceivePendingStageNotification(target, clientMessage.to, routeGroup)
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
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Recipient did not acknowledge the pending-stage notification",
			);
			this.forgetDelivered(pending.messageId, pending.signature);
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
			this.forgetDelivered(message.id, signature);
		}
	}

	/**
	 * A pending-stage notice reaches a session registered in the run's group, or (#4006) the exact
	 * sender session that controls the run from outside it: the launcher holding a current claim, or
	 * an ordinary session that joined `workflow:<rootRunId>`. Isolated stages never qualify, and the
	 * legacy name/return-address fallbacks stay limited to the run's own group.
	 */
	private canReceivePendingStageNotification(target: ConnectedSession, to: string, routeGroup: string): boolean {
		if (normalizeGroup(target.registrationGroup) === routeGroup && hasGroup(sessionGroups(target.info), routeGroup)) {
			return true;
		}
		return target.info.id === to && this.canControlWorkflowInvocation(target, routeGroup);
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
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Recipient did not admit the pending-stage notification",
			);
			this.forgetDelivered(pending.messageId, pending.signature);
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

  /** Register the session under the id it was granted, and complete its registration (see `register`). */
  private completeSessionRegistration(
    socket: net.Socket,
    clientMessage: SessionRegistrationRequest,
    id: string,
    supervisorId: string | undefined,
    setId: (id: string | null) => void,
  ): void {
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
          registrationGroup: clientMessage.reachPolicy?.home ?? (typeof clientMessage.registrationGroup === "string"
            ? normalizeGroup(clientMessage.registrationGroup) : legacyGroup),
			...(typeof info.name === "string" && info.name.trim().length > 0
				? { registrationName: info.name.trim() }
				: {}),
			...(typeof clientMessage.returnAddress === "string"
				? { registrationReturnAddress: clientMessage.returnAddress }
				: {}),
          ...(supervisorId ? { supervisorId } : {}),
          ...(supervisorId && this.sessions.get(supervisorId)?.registrationReturnAddress !== undefined
            ? { supervisorReturnAddress: this.sessions.get(supervisorId)?.registrationReturnAddress }
            : {}),
          ...(typeof clientMessage.supervisorOwnerToken === "string"
            ? { supervisorOwnerToken: clientMessage.supervisorOwnerToken }
            : {}),
          ...(clientMessage.acknowledgesReceipt === true ? { acknowledgesReceipt: true as const } : {}),
          ...(clientMessage.reachPolicy === undefined ? {} : { reach: clientMessage.reachPolicy }),
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
            withdrawsPendingStageRoutes: true as const,
            refusesPendingStageRoutesInPlace: true as const,
            brokerStatus: true as const,
            claimsWorkflowInvocations: true as const,
            extendsSaves: true as const,
            marksEndedChildren: true as const,
            stampsReleasedChildren: true as const,
            multiNodeRouting: this.multiNodeStatus,
            protocol: { ...BROKER_PROTOCOL },
            ...(clientMessage.reachPolicy === undefined ? {} : { enforcesReach: true as const }),
          });
          if (isAgentRecipient(info)) this.broadcastToMemberships({ type: "session_joined", session: info }, sessionGroups(info), id);
          // #3761: messages written to this recipient's previous connection that it never confirmed saving go out again.
          // #5095: the asks whose reply goes out again here are answered unless it lapses unsaved.
          const replyingTo = new Set<string>();
          if (rejoined?.acknowledgesReceipt === true) {
            const heldFrames = new Set(held.map((write) => write.message));
            for (const frame of this.receipts.framesFor(deliveryTargetIdentity(rejoined))) {
              if (!heldFrames.has(frame)) writeMessageIfOpen(socket, frame);
              if (frame.type === "message" && frame.message.replyTo !== undefined && frame.message.replyError === undefined)
                replyingTo.add(JSON.stringify([frame.from.id, frame.message.replyTo]));
            }
          }
          // Multi-node S5: frames written while registration waited for the presence lease follow `registered`.
          flushHeldWrites(socket, held);
          // #4751: a session back under its id takes up the asks it sent or was sent before it went away.
          const restored = this.pendingQuestions.restoreDormant(id, rejoined?.registrationReturnAddress, (sessionId, returnAddress) =>
            this.isConnectedAs(sessionId, returnAddress),
          );
          // #4997: their shared routes, if they had moved there too, are settled: this broker answers them now.
          this.multiNode?.settleRestoredRoutes(restored);
          // #4997: and any kept ask that has not reached the shared state yet (its earlier move failed) tries again.
          void this.multiNode?.publishAwayRoutes(this.pendingQuestions.movableDormant());
          // What was held for it while it was away (replies, failed asks) is delivered once: a recipient that confirms
          // saves releases each when saved, and its inbox shows a redelivered copy only once.
          const returnAddress = rejoined?.registrationReturnAddress;
          for (const held of this.pendingQuestions.heldForAsker(returnAddress)) {
            // #5095: a failure of an ask whose reply went out again stays held: saving the reply releases it.
            if (held.message.replyError !== undefined && replyingTo.has(JSON.stringify([held.from.id, held.message.replyTo])))
              continue;
            const written = writeMessageIfOpen(socket, { type: "message", from: held.from, message: held.message });
            // #5149: a socket that closed during registration keeps them held for its next connection.
            if (written && clientMessage.acknowledgesReceipt !== true)
              this.pendingQuestions.releaseHeld(held.message.id, returnAddress);
          }
          // #3760: a restored subagent is back under the capability its owner reserved it with; the sends held
          // for it while it was being restored go out now, once each and in the order they arrived.
          const registered = info.name?.trim();
          if (registered !== undefined && supervisorId !== undefined) {
            this.pendingQuestions.forgetReleasedAsker(rejoined?.registrationReturnAddress);
            // #4751: a released subagent back under its owner takes up the routes of its pending asks, including one
            // whose reply is held for it, so their replies reach it as a live asker.
            for (const question of this.pendingQuestions.takeParkedAskers(registered, supervisorId))
              this.pendingQuestions.record(id, question.targetSessionId, question.messageId);
            for (const route of this.releasedAskerReplies.takeChild(registered, supervisorId))
              this.pendingQuestions.record(id, route.replierSessionId, route.questionId);
            // #5004: held again under its own return address until it saved it, so a subagent that dies first gets it again.
            const child = this.sessions.get(id);
            if (child !== undefined)
              for (const held of this.pendingQuestions.takeHeldForReleasedChild(registered, supervisorId))
                deliverHeldToAsker(
                  {
                    asker: child,
                    question: { senderSessionId: id, targetSessionId: held.from.id, messageId: held.message.replyTo ?? held.message.id },
                    from: held.from,
                    pending: this.pendingQuestions,
                    write: writeMessageIfOpen,
                    legacy: { type: "message", from: held.from, message: held.message },
                  },
                  held.message,
                );
            for (const question of this.pendingQuestions.takeParked(registered, supervisorId)) {
              this.pendingQuestions.record(question.senderSessionId, id, question.messageId);
              const asker = this.sessions.get(question.senderSessionId);
              if (asker !== undefined) writeMessageIfOpen(asker.socket, {
                type: "peer_rebound", replyTo: question.messageId, previousSessionId: question.targetSessionId, sessionId: id,
              });
            }
          }
          for (const send of this.restoringRecipients.consume(
            consumedCapability,
            registered
              ? { childName: registered, groups: sessionGroups(info), ...(supervisorId ? { authorizedBy: supervisorId } : {}) }
              : undefined,
          ))
            this.dispatchSend(send.socket, send.clientMessage, send.senderId);
          // #4639: a subagent whose session dropped is back under its owner's authorization; its held sends follow.
          if (registered !== undefined && supervisorId !== undefined)
            for (const send of this.departedChildren.registered(registered, sessionGroups(info), supervisorId))
              this.dispatchSend(send.socket, send.clientMessage, send.senderId);
        };
        // Multi-node S5: brokers on other hosts find this session through its presence lease, so registration
        // completes once the lease is written (or bounded attempts found it still held elsewhere). The session is
        // routable meanwhile, so its frames are held until `registered` is written.
        const presence =
          rejoined === undefined
            ? undefined
            : this.multiNode?.sessionRegistered(
                rejoined,
                consumedCapability === undefined && !info.name?.trim()
                  ? undefined
                  : {
                      ...(consumedCapability === undefined ? {} : { capability: consumedCapability }),
                      ...(info.name?.trim() ? { childName: info.name.trim() } : {}),
                      groups: sessionGroups(info),
                      ...(supervisorId ? { authorizedBy: supervisorId } : {}),
                    },
              );
        if (presence === undefined) completeRegistration();
        else {
          holdWrites(socket);
          // #5101: routable now, but its routes are restored only as its registration completes; a reply that only a
          // restored route would authorize waits for that rather than being refused.
          const restoring = this.pendingQuestions.beginRestoring(id);
          void presence.then(() => {
            const held = releaseHeldWrites(socket);
            try {
              if (this.sessions.get(id) === rejoined) completeRegistration(held);
              else discardHeldWrites(held);
            } finally {
              this.pendingQuestions.finishRestoring(id, restoring);
            }
          });
        }
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

    if (currentId === null && clientMessage.type !== "register" && clientMessage.type !== "register_verified") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register":
      case "register_verified": {
        if (this.shuttingDown) {
          // A client that connected while this broker was closing (a multi-node broker takes up to two seconds to give
          // its leases up) learns it lost the race and spawns the replacement, instead of finding its socket reset.
          writeMessageIfOpen(socket, RETIRING_REFUSAL);
          socket.end();
          return;
        }
        if (clientMessage.type === "register_verified") {
          const expected = clientMessage.expectedRouting;
          if (typeof expected !== "object" || expected === null || Array.isArray(expected) || typeof expected.acrossMachines !== "boolean") {
            throw new Error("Invalid expected routing");
          }
          if (expected.acrossMachines !== (this.multiNodeStatus !== "off")) {
            writeMessageIfOpen(socket, ROUTING_CHANGED_REFUSAL);
            socket.end();
            return;
          }
        }
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
		if (clientMessage.protocol !== undefined && !isBrokerProtocolRange(clientMessage.protocol)) {
			throw new Error("Invalid protocol range");
		}
		const registrationReach = readRegistrationReach(
			clientMessage.reach,
			clientMessage.session,
			typeof clientMessage.registrationGroup === "string" ? clientMessage.registrationGroup : undefined,
		);
		if (registrationReach.refusal !== undefined) {
			writeMessageIfOpen(socket, {
				type: "registration_failed",
				reason: registrationReach.refusal,
				code: "reach_policy_refused",
			});
			this.endRefusedConnection(socket, currentId, setId);
			return;
		}

        if (currentId || this.claimingSessionIds.has(socket)) {
          throw new Error("Received duplicate register message");
        }
        // #4538: a client that names no range is a 0.9.71-or-older client, which drops its connection over a frame
        // type it does not know; such frames are never written to it.
        recordClientProtocol(
          socket,
          protocolRangeOf(isBrokerProtocolRange(clientMessage.protocol) ? clientMessage.protocol : undefined),
        );

        let supervisorId: string | undefined;
        if (clientMessage.supervisor !== undefined) {
          const childName = clientMessage.session.name?.trim();
          const claimedSupervisorId = isSupervisorRegistration(clientMessage.supervisor) && childName
            ? this.supervisorChannel.claim(clientMessage.supervisor.capability, childName)
            : undefined;
          if (!claimedSupervisorId || !this.sessions.has(claimedSupervisorId)) {
            writeMessageIfOpen(socket, {
              type: "registration_failed",
              reason: SUPERVISOR_AUTHORIZATION_REFUSED_REASON,
              code: SUPERVISOR_AUTHORIZATION_REFUSED_CODE,
            });
            this.endRefusedConnection(socket, currentId, setId);
            return;
          }
          supervisorId = claimedSupervisorId;
        }

        this.openDeliveredMessages();
        // #3760: a restored or reconnected session keeps the id peers know when it is free; never a live one.
        const preferred = this.sessionIdReclaim.grant(
          clientMessage.preferredSessionId,
          clientMessage.returnAddress,
          (sessionId) => this.sessions.has(sessionId),
        );
        const multiNode = this.multiNode;
        const returnAddress = clientMessage.returnAddress;
        const registration: SessionRegistrationRequest = {
          ...clientMessage,
          session: clientMessage.session,
          ...(registrationReach.reach === undefined ? {} : { reachPolicy: registrationReach.reach }),
        };
        if (preferred !== undefined && multiNode !== undefined && typeof returnAddress === "string") {
          // In multi-node mode the id carries authority on every broker (shared ask routes and known sessions name
          // sessions by id), so it is granted only to the return address it is bound to in shared storage.
          this.claimingSessionIds.add(socket);
          void multiNode
            .claimSessionId(preferred, returnAddress)
            .then((claimed) => {
              this.claimingSessionIds.delete(socket);
              if (socket.destroyed || socket.writableEnded) return;
              if (this.shuttingDown) {
                writeMessageIfOpen(socket, RETIRING_REFUSAL);
                socket.end();
                return;
              }
              this.completeSessionRegistration(
                socket,
                registration,
                claimed && !this.sessions.has(preferred) ? preferred : randomUUID(),
                supervisorId,
                setId,
              );
            })
            .catch((error: unknown) => socket.destroy(error instanceof Error ? error : new Error(String(error))));
          break;
        }
        this.completeSessionRegistration(socket, registration, preferred ?? randomUUID(), supervisorId, setId);
        break;
      }

      case "unregister": {
        // #4751: a session that can be resumed is only away; one that cannot has ended.
        this.disconnectSession(currentId, clientMessage.resumable !== true);
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
			...(requester.reach === undefined ? {} : { requesterReach: requester.reach }),
			selectedGroup,
			localSessions: () => this.sessions,
			remoteSessions: multiNode === undefined ? undefined : () => multiNode.remoteSessions(),
			canInspectSelectedGroup: (group) => this.canInspectSelectedGroup(requester, group),
			workflowStages: () => this.workflowStagesVisibleTo(requester, selectedGroup),
			workflowFutureStages: () => this.workflowFutureStagesVisibleTo(requester, selectedGroup),
			write: (reply) => {
				// #5146: presence gathered for this session goes first, so a list never precedes a staler update.
				this.presenceFanout.flush(socket);
				writeMessageIfOpen(socket, reply);
			},
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
			groups: knownGroupSummaries(this.sessions, requester.info, requester.reach),
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
          (clientMessage.aliases !== undefined && !isRestoringRecipientAliasList(clientMessage.aliases)) ||
          (clientMessage.holdMs !== undefined &&
            (typeof clientMessage.holdMs !== "number" || !Number.isInteger(clientMessage.holdMs) || clientMessage.holdMs <= 0))
        ) {
          throw new Error("Invalid reserve_restoring_recipient message");
        }
        // Only the supervisor the capability was issued to may hold sends for that child (#3760).
        const childName = isReleasedReservationKey(clientMessage.capability)
          ? undefined
          : this.supervisorChannel.supervisedChildName(clientMessage.capability, currentId);
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
        const published = this.reserveRestoringRecipient(
          clientMessage.capability,
          currentId,
          childName,
          normalizeGroup(typeof clientMessage.group === "string" ? clientMessage.group : owner.registrationGroup),
          aliases,
          {
            dormant: clientMessage.dormant === true,
            ...(typeof clientMessage.holdMs === "number" ? { holdMs: clientMessage.holdMs } : {}),
          },
        );
        this.dispatchHeldSends(this.departedChildren.supersede(currentId, childName));
        // #5352: acknowledged once senders on other brokers can find the reservation (bounded by the router).
        const requestId = clientMessage.requestId;
        // `published: false`: reserved here, and written for other brokers once the shared database takes it.
        void published.then((visible) =>
          writeMessageIfOpen(socket, { type: "restoring_recipient_ack", requestId, ...(visible ? {} : { published: false }) }),
        );
        break;
      }

      case "host_sessions": {
        const host = this.sessions.get(currentId);
        if (
          host === undefined ||
          host.hostedBy !== undefined ||
          typeof clientMessage.requestId !== "string" ||
          !clientHostsSessions(socket)
        ) {
          throw new Error("Invalid host_sessions message");
        }
        const requestId = clientMessage.requestId;
        const validation = validateHostSessionsFrame(clientMessage.sessions);
        if (!validation.ok) {
          writeMessageIfOpen(socket, { type: "hosted_sessions_ack", requestId, refusal: validation.refusal });
          break;
        }
        const hostReach = host.reach;
        const outsideReach =
          hostReach === undefined ? undefined : validation.sessions.find((item) => !hostedWithinReach(hostReach, item));
        if (outsideReach !== undefined) {
          writeMessageIfOpen(socket, {
            type: "hosted_sessions_ack",
            requestId,
            refusal: { code: "invalid_hosted_session", key: outsideReach.key },
          });
          break;
        }
        const assignments: HostedSessionAssignment[] = [];
        const presences: Promise<void>[] = [];
        // #4639: a host back after its connection closed takes over the departures it kept; hosting a name again ends its.
        this.adoptOrphans(currentId, host);
        for (const item of validation.sessions) {
          const hosted = this.hostSession(currentId, socket, item, hostReach !== undefined);
          if (hosted.registrationName !== undefined)
            this.dispatchHeldSends(this.departedChildren.supersede(currentId, hosted.registrationName));
          const presence = this.multiNode?.sessionRegistered(hosted);
          if (presence !== undefined) presences.push(presence);
          const liveRouteRefusal = item.liveRoute === undefined ? undefined : this.registerHostedLiveRoute(hosted, item.liveRoute);
          assignments.push({
            key: item.key,
            sessionId: hosted.info.id,
            ...(liveRouteRefusal === undefined ? {} : { liveRouteRefusal }),
          });
        }
        // Multi-node: the answer waits until other brokers can resolve the hosted sessions, as `registered` does.
        const answer = (): void => {
          writeMessageIfOpen(socket, { type: "hosted_sessions_ack", requestId, sessions: assignments });
        };
        if (presences.length === 0) answer();
        else void Promise.all(presences).then(answer);
        break;
      }

      case "unhost_sessions": {
        if (typeof clientMessage.requestId !== "string" || !this.sessions.has(currentId)) {
          throw new Error("Invalid unhost_sessions message");
        }
        const validation = validateUnhostSessionsFrame(clientMessage.sessionIds);
        const hosted = this.hostedSessions.get(currentId);
        const refusal: HostedSessionRefusal | undefined = validation.ok
          ? validation.sessionIds
              .filter((sessionId) => hosted?.has(sessionId) !== true)
              .map((sessionId) => ({ code: "not_hosted_by_connection" as const, sessionId }))[0]
          : validation.refusal;
        if (!validation.ok || refusal !== undefined) {
          writeMessageIfOpen(socket, { type: "hosted_sessions_ack", requestId: clientMessage.requestId, refusal });
          break;
        }
        for (const sessionId of validation.sessionIds) this.disconnectSession(sessionId);
        writeMessageIfOpen(socket, { type: "hosted_sessions_ack", requestId: clientMessage.requestId });
        break;
      }

      case "reserve_released_children": {
        const owner = this.sessions.get(currentId);
        if (owner === undefined || typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid reserve_released_children message");
        }
        // #4639: a host session back after its connection closed takes over the released children it kept.
        this.adoptOrphans(currentId, owner);
        const validation = validateReleasedChildFrame(clientMessage.children);
        const refusal = validation.ok ? this.releasedChildrenRefusal(owner, validation.children) : validation.refusal;
        if (!validation.ok || refusal !== undefined) {
          writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId, refusal });
          break;
        }
        const published: Promise<boolean>[] = [];
        // Stamp installation, not the later completion of route publication.
        const order = clientMessage.releaseStamp === true ? ++this.releaseOrder : undefined;
        for (const child of validation.children) {
          published.push(this.reserveReleasedChild(currentId, owner.registrationGroup, child, order));
          this.releasedAskerReplies.attach(child.childName, currentId);
          // #4751: a failed ask kept for the child wakes it again, so it is delivered.
          if (
            child.wake &&
            (this.pendingQuestions.hasHeldForReleasedChild(child.childName, currentId) ||
              this.pendingQuestions.hasHeldForReleasedAsker(child.childName, currentId))
          )
            this.wakeRestoringRecipientOwner({ ownerSessionId: currentId, childName: child.childName });
          this.dispatchHeldSends(this.departedChildren.supersede(currentId, child.childName));
        }
        // #5352: acknowledged once senders on other brokers can find the reservations (bounded by the router).
        const requestId = clientMessage.requestId;
        void Promise.all(published).then((visible) =>
          writeMessageIfOpen(socket, {
            type: "released_children_ack",
            requestId,
            ...(visible.every(Boolean) ? {} : { published: false }),
            ...(order === undefined ? {} : { releaseStamp: { broker: this.instanceId, order } }),
          }),
        );
        break;
      }

      case "verify_released_child": {
        const { requestId, childName, order } = clientMessage;
        if (typeof requestId !== "string" || typeof childName !== "string" || typeof order !== "number") {
          throw new Error("Invalid verify_released_child message");
        }
        // Unlike a reservation or wake, a check cannot adopt an orphan or change anyone's hold deadline.
        const current = clientMessage.broker === this.instanceId && currentId !== null &&
          this.sessions.get(currentId)?.socket === socket && this.restoringRecipients.isCurrentRelease(childName, currentId, order);
        writeMessageIfOpen(socket, { type: "released_children_ack", requestId, current });
        break;
      }

      case "mark_ended_children": {
        const owner = this.sessions.get(currentId);
        if (owner === undefined || typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid mark_ended_children message");
        }
        this.adoptOrphans(currentId, owner);
        const validation = validateEndedChildrenFrame(clientMessage.children, owner.registrationGroup);
        const refusal = validation.ok
          ? this.releasedChildrenRefusal(owner, validation.children.map((child) => ({ ...child, wake: false })))
          : validation.refusal;
        if (!validation.ok || refusal !== undefined) {
          writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId, refusal });
          break;
        }
        const marked = this.departedChildren.mark(currentId, validation.children);
        this.refuseHeldSends(marked.refused);
        this.dispatchHeldSends(marked.evicted);
        writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId });
        break;
      }

      case "drop_released_children": {
        const owner = this.sessions.get(currentId);
        if (
          owner === undefined ||
          typeof clientMessage.requestId !== "string" ||
          !Array.isArray(clientMessage.childNames) ||
          clientMessage.childNames.length > RELEASED_CHILD_FRAME_MAX ||
          !clientMessage.childNames.every((name) => typeof name === "string") ||
          (clientMessage.gone !== undefined && typeof clientMessage.gone !== "string") ||
          (clientMessage.refusal !== undefined && typeof clientMessage.refusal !== "string")
        ) {
          throw new Error("Invalid drop_released_children message");
        }
        this.adoptOrphans(currentId, owner);
        const childNames = clientMessage.childNames as string[];
        const refusal = childNames
          .map((childName) => this.releasedChildOwnerRefusal(owner, childName))
          .find((candidate) => candidate !== undefined);
        if (refusal !== undefined) {
          writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId, refusal });
          break;
        }
        for (const childName of childNames) {
          this.releaseReservation(releasedReservationKey(childName), currentId, clientMessage.gone, clientMessage.refusal);
          this.failParkedQuestions(this.pendingQuestions.takeParked(childName, currentId), childName);
          this.failParkedKept(currentId, childName);
          this.releasedAskerReplies.dropChild(childName, currentId);
        }
        writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId });
        break;
      }

      case "acknowledge_released_child_wake": {
        const owner = this.sessions.get(currentId);
        if (owner === undefined || typeof clientMessage.requestId !== "string" || typeof clientMessage.childName !== "string") {
          throw new Error("Invalid acknowledge_released_child_wake message");
        }
        this.adoptOrphans(currentId, owner);
        const childName = clientMessage.childName;
        const valid = isValidChildName(childName);
        const refusal: ReleasedChildRefusal | undefined = valid ? this.releasedChildOwnerRefusal(owner, childName) : undefined;
        const extended = valid && refusal === undefined ? this.restoringRecipients.extendHolds(childName, currentId) : undefined;
        if (extended === undefined) {
          writeMessageIfOpen(socket, {
            type: "released_children_ack",
            requestId: clientMessage.requestId,
            refusal: refusal ?? { code: "unknown_released_child", childName },
            ...(clientMessage.releaseStamp === true ? { releaseStamp: { broker: this.instanceId, order: ++this.releaseOrder } } : {}),
          });
          break;
        }
        for (const { held, timeoutMs } of extended) {
          writeMessageIfOpen(held.socket, {
            type: "send_held",
            messageId: held.messageId,
            ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
            timeoutMs,
          });
        }
        writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId });
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
        this.releaseReservation(clientMessage.capability, currentId, clientMessage.gone, clientMessage.refusal);
        writeMessageIfOpen(socket, { type: "restoring_recipient_ack", requestId: clientMessage.requestId });
        break;
      }

      case "withdraw_pending_stage_route": {
        const { runId, generation, requestId } = clientMessage;
        if (typeof runId !== "string" || !runId || typeof generation !== "string" || !generation || typeof requestId !== "string")
          throw new Error("Invalid pending-stage route withdrawal");
        const owner = this.pendingStageRoutes.get(runId);
        if (owner?.sessionId === currentId && owner.generation === generation && this.sessions.get(currentId)?.socket === socket) {
          this.forgetPendingStageRoute(runId);
          this.dispatchHeldSends(this.releaseInvocationOrphans(owner.group));
        }
        // A stale request is also settled. Never disclose or remove the replacement owner.
        writeMessageIfOpen(socket, { type: "pending_stage_route_registered", requestId });
        break;
      }

      case "register_pending_stage_route": {
        if (
          typeof clientMessage.runId !== "string" ||
          !clientMessage.runId ||
          typeof clientMessage.group !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability ||
          (clientMessage.requestId !== undefined && typeof clientMessage.requestId !== "string") ||
          (clientMessage.generation !== undefined && (typeof clientMessage.generation !== "string" || !clientMessage.generation)) ||
          (clientMessage.launcherCapability !== undefined &&
            (typeof clientMessage.launcherCapability !== "string" || !clientMessage.launcherCapability))
        ) {
          throw new Error("Invalid pending-stage route registration");
        }
        const launcherCapability = clientMessage.launcherCapability;
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
          generation: clientMessage.generation,
          group: ownerGroup,
          capability: clientMessage.capability,
          ...(dormant ? { dormant: true as const } : {}),
          ...(launcherCapability === undefined ? {} : { launcherCapability }),
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
        // A stage name containing "/" or "*" cannot be a canonical path segment, but throwing
        // here reaches the framing reader's onError and destroys the stage session's whole
        // broker connection. Refuse orderly like every neighbouring rejection; host clients
        // filter such name keys and register the stage-id key instead.
        const precondition = this.liveWorkflowStageRouteRefusal(
          this.sessions.get(currentId),
          clientMessage.runId,
          clientMessage.stageKeys,
          clientMessage.capability,
        );
        if (precondition !== undefined) {
          refuse(precondition);
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
			!isWorkflowSendPredictionFields(clientMessage) ||
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
			workflowSendPredictionFields(clientMessage),
			Array.isArray(clientMessage.forwardTargets) ? [...clientMessage.forwardTargets] : undefined,
        );
        break;
      }

		case "send":
		case "supervisor_send": {
			const hostedSender = clientMessage.hostedSender;
			if (hostedSender === undefined) {
				this.dispatchSend(socket, clientMessage, currentId);
				break;
			}
			if (typeof hostedSender !== "string") throw new Error("Invalid hostedSender");
			if (this.hostedSessions.get(currentId)?.has(hostedSender) !== true) {
				this.refuseHostedSender(socket, clientMessage, hostedSender);
				break;
			}
			if (this.sessions.get(currentId)?.reach !== undefined && !isPendingReply(clientMessage)) {
				const message = clientMessage.message;
				writeMessageIfOpen(socket, {
					type: "delivery_failed",
					messageId: isMessage(message) ? message.id : "unknown",
					...(typeof clientMessage.attemptId === "string" ? { attemptId: clientMessage.attemptId } : {}),
					reason: HOSTED_REPLY_ONLY_REFUSAL,
				});
				break;
			}
			this.dispatchSend(socket, clientMessage, hostedSender);
			break;
		}

		case "released_child_reply_ack": {
			if (typeof clientMessage.messageId !== "string" || typeof clientMessage.accepted !== "boolean") {
				throw new Error("Invalid released_child_reply_ack message");
			}
			const owner = currentId === null ? undefined : this.sessions.get(currentId);
			const handoffId = typeof clientMessage.handoffId === "string" ? clientMessage.handoffId : undefined;
			if (owner !== undefined && this.multiNode?.releasedReplyAcknowledged(owner, clientMessage.messageId, handoffId, clientMessage.accepted)) {
				break;
			}
			const pending = this.releasedReplyAcks.get(clientMessage.messageId);
			if (pending?.ownerSessionId === currentId && pending.handoffId === clientMessage.handoffId) {
				this.settleReleasedReply(
					clientMessage.messageId,
					clientMessage.accepted ? "accepted" : clientMessage.deliverToChild === true ? "deliver" : "refused",
				);
			}
			break;
		}

		case "received": {
			if (typeof clientMessage.messageId !== "string") throw new Error("Invalid received message");
			const recipient = this.sessions.get(currentId);
			// #4751: only the asker a message is held for, proven by its return address, releases it.
			if (recipient !== undefined)
				this.pendingQuestions.releaseHeld(clientMessage.messageId, recipient.registrationReturnAddress);
			if (recipient?.acknowledgesReceipt === true) {
				this.multiNode?.received(recipient, clientMessage.messageId);
				this.receipts.settle(clientMessage.messageId, deliveryTargetIdentity(recipient), recipient);
			}
			break;
		}

		case "saving": {
			if (typeof clientMessage.messageId !== "string") throw new Error("Invalid saving message");
			const recipient = this.sessions.get(currentId);
			if (recipient?.acknowledgesReceipt === true && !this.multiNode?.saving(recipient, clientMessage.messageId))
				this.receipts.extend(clientMessage.messageId, deliveryTargetIdentity(recipient));
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

      case "set_reach": {
        const session = this.sessions.get(currentId);
        if (session === undefined || typeof clientMessage.requestId !== "string") throw new Error("Invalid set_reach message");
        const requestId = clientMessage.requestId;
        if (session.reach === undefined) {
          writeMessageIfOpen(socket, {
            type: "reach_failed",
            requestId,
            reason: "This session registered without an Intercom reach policy, so its reach cannot change",
          });
          break;
        }
        const error = reachPolicyError(session.reach.home, clientMessage.reachable);
        if (error !== undefined || !Array.isArray(clientMessage.reachable)
          || !clientMessage.reachable.every((group): group is string => typeof group === "string")) {
          writeMessageIfOpen(socket, { type: "reach_failed", requestId, reason: error ?? "Intercom reachable must be an array" });
          break;
        }
        this.replaceReach(session, createReachPolicy(session.reach.home, clientMessage.reachable));
        writeMessageIfOpen(socket, {
          type: "reach_ack",
          requestId,
          reachable: [...session.reach.reachable],
          groups: [...sessionGroups(session.info)],
        });
        break;
      }

      case "presence":
	  case "join_group":
	  case "leave_group": {
        const wasTerminal = this.sessions.get(currentId)?.info.replyCapability === "terminal";
        handleBrokerPresence(
          socket,
          clientMessage,
          currentId,
          this.sessions,
          (target, message) => writeMessageIfOpen(target, message),
          this.pendingQuestions,
          (peer, changed) => this.presenceFanout.queue(peer, changed.info.id),
        );
        const updated = this.sessions.get(currentId);
        // #4751: a recipient that can no longer answer fails the asks of released subagents waiting for it.
        if (updated !== undefined && !wasTerminal && updated.info.replyCapability === "terminal")
          this.failReleasedAsksTo(updated.info, updated.socket, TERMINAL_CHILD_ASK_REFUSAL, "terminal");
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
      (sender, group) => this.canInspectSelectedGroup(sender, group),
      this.routeReleasedAskerReply,
      this.resolveWorkflowStageAlias,
      this.returnPathAuthority,
    );
  }

  private readonly routeReleasedAskerReply: ReleasedAskerReplyRouter = ({
    socket,
    from,
    message,
    target,
    attemptId,
    expectedRecipientId,
  }) => {
    const route = this.releasedAskerReplies.take(message.replyTo, from.info.id, target, expectedRecipientId);
    if (route === undefined) return false;
    if (this.releasedReplyAcks.has(message.id)) {
      this.releasedAskerReplies.restore(route, route.ownerSessionId);
      writeMessageIfOpen(socket, {
        type: "delivery_failed",
        messageId: message.id,
        ...(attemptId === undefined ? {} : { attemptId }),
        reason: `Intercom message ID '${message.id}' is already waiting for a released subagent's owner to confirm another reply`,
        reasonCode: "message_id_conflict",
      });
      return true;
    }
    this.pendingQuestions.forgetDormant({
      messageId: route.questionId,
      senderSessionId: route.askerSessionId,
      targetSessionId: route.replierSessionId,
    });
    this.handOffReleasedReply(route, from.info, message, socket, attemptId);
    return true;
  };

  /** Hand a reply to a released subagent's ask to its owner, which saves it for a waiting call or lets it through. */
  private handOffReleasedReply(
    route: ReleasedAskerReplyRoute,
    from: SessionInfo,
    message: Message & { readonly replyTo: string },
    socket: net.Socket,
    attemptId?: string,
    synthetic = false,
  ): void {
    const owner = this.sessions.get(route.ownerSessionId);
    const timer = setTimeout(() => this.settleReleasedReply(message.id, "uncertain"), RECIPIENT_RECEIPT_TIMEOUT_MS);
    timer.unref?.();
    const handoffId = randomUUID();
    const pending: PendingReleasedReplyAck = {
      handoffId,
      from,
      ...(synthetic ? { synthetic: true as const } : {}),
      message,
      timer,
      socket,
      ...(attemptId === undefined ? {} : { attemptId }),
      ownerSessionId: route.ownerSessionId,
      questionId: route.questionId,
      childName: route.childName,
      route,
    };
    this.releasedReplyAcks.set(message.id, pending);
    const written =
      owner !== undefined &&
      writeMessageIfOpen(owner.socket, {
        type: "released_child_reply",
        childName: route.childName,
        handoffId,
        replyTo: route.questionId,
        from,
        message,
      });
    if (!written) this.settleReleasedReply(message.id, "refused");
  }

  /**
   * #4751: a recipient that ended, or can no longer answer, fails the asks of released subagents that wait for it: each
   * gets a failed-ask message through the same owner handoff as a reply.
   */
  private failReleasedAsksTo(target: SessionInfo, socket: net.Socket, reason: string, idPrefix: string): void {
    for (const route of this.releasedAskerReplies.takeForReplier(target.id)) {
      // #4996: handed to the owner once the departure in progress, if any, is saved; one id per ask (#5004).
      this.afterDeparture(() => this.handOffReleasedReply(
        route,
        target,
        {
          id: `${idPrefix}:${route.questionId}`,
          timestamp: Date.now(),
          replyTo: route.questionId,
          replyError: reason,
          content: { text: reason },
        },
        socket,
        undefined,
        true,
      ));
    }
  }

  private settleReleasedReply(messageId: string, outcome: "accepted" | "refused" | "uncertain" | "deliver"): void {
    const pending = this.releasedReplyAcks.get(messageId);
    if (pending === undefined) return;
    clearTimeout(pending.timer);
    this.releasedReplyAcks.delete(messageId);
    const attempt = pending.attemptId === undefined ? {} : { attemptId: pending.attemptId };
    if (outcome === "deliver" && this.deliverReplyToReleasedChild(pending)) return;
    if (pending.synthetic === true && outcome !== "accepted") {
      // #4751: the owner did not save the failed ask; it is kept for the child, which gets it when its owner reserves
      // or wakes it again and it registers.
      this.pendingQuestions.holdForReleasedChild(pending.childName, pending.ownerSessionId, {
        askerSessionId: pending.route.askerSessionId,
        from: pending.from,
        message: pending.message,
      });
      return;
    }
    if (outcome === "accepted") {
      this.deliveredMessages.settleQuestion(pending.questionId);
      writeMessageIfOpen(pending.socket, { type: "delivered", messageId, ...attempt });
      return;
    }
    const ownerStillHolds = this.restoringRecipients.releasedOwner(pending.childName) === pending.ownerSessionId;
    if (outcome === "uncertain") {
      // The owner may have saved the reply, late or before disconnecting; its record will deduplicate a later retry.
      this.releasedAskerReplies.restore(pending.route, ownerStillHolds ? pending.ownerSessionId : undefined);
    } else if (ownerStillHolds) {
      this.releasedAskerReplies.restore(pending.route, pending.ownerSessionId);
    }
    // #4996: a replier is told its reply failed only once the departure in progress, if any, is saved.
    this.writeAfterDeparture(pending.socket, {
      type: "delivery_failed",
      messageId,
      ...attempt,
      reason: outcome === "uncertain" ? UNCERTAIN_RECEIPT_REASON : releasedAskerReplyRefusal(pending.childName),
    });
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
      reservations: this.restoringRecipients.size,
      heldSends: this.restoringRecipients.heldSendCount + this.departedChildren.heldSendCount,
      droppedReleasedReplyRoutes: this.releasedAskerReplies.droppedRoutes,
      ...(setting === undefined
        ? {}
        : { storage: { digest: sharedStorageDigest(setting), source: sharedStorageSettingSource() } }),
      multiNode: {
        status: this.multiNodeStatus,
        ...(this.multiNodeReason === undefined ? {} : { reason: this.multiNodeReason }),
        ...(setting === undefined ? {} : describeSharedStorage(setting)),
        ...(peers === undefined ? {} : { peers }),
      },
      protocol: { ...BROKER_PROTOCOL },
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
              // #4997: the same across this broker's restarts on this host, as its away-ask store is.
              home: createHash("sha256").update(`${hostname()}\0${INTERCOM_DIR}`).digest("hex").slice(0, 32),
              // #5038: a restarted broker serves the same socket; its previous instance's leases are retired at start.
              instanceKey: SOCKET_PATH,
              host: {
                sessions: this.sessions,
                write: writeMessageIfOpen,
                writeConfirmed: writeMessageWithOutcome,
                supervisorCache: this.supervisorChannel,
                returnPaths: this.returnPathAuthority,
                pendingQuestions: this.pendingQuestions,
                // A remote send reaches only a session registered here, which has opened the authority (#4727).
                deliveredMessages: {
                  lookupForTarget: (...args) => this.deliveredMessages.lookupForTarget(...args),
                  lookupQuestionTarget: (...args) => this.deliveredMessages.lookupQuestionTarget(...args),
                },
                dispatch: (socket, clientMessage, senderId) => this.dispatchSend(socket, clientMessage, senderId),
                revokeReleasedReservation: (key, ownerSessionId) => this.revokeReleasedReservation(key, ownerSessionId),
                holdsReservation: (key, ownerSessionId) => this.restoringRecipients.holds(key, ownerSessionId),
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
              { wake: reservation.wake },
            );
            if (reservation.gone !== undefined) {
              this.multiNode.restoringReleased(reservation.capability, reservation.ownerSessionId, reservation.gone);
            }
          }
          // #4997: the asks a crashed or stopped broker left here between two top-level sessions move to the shared
          // state, as an away session's do, since either session may come back on another broker.
          // The away store opens with the delivered-message authority, at the first registration otherwise.
          this.openDeliveredMessages();
          void this.multiNode.publishAwayRoutes(this.pendingQuestions.movableDormant());
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
  private readonly holdForRestoringRecipient: RestoringRecipientHold = ({ socket, from, clientMessage, target, messageId, attemptId, answersAsk }) => {
    const held: HeldSend = { socket, senderId: from.info.id, messageId, clientMessage, ...(attemptId === undefined ? {} : { attemptId }) };
    const sender = holdSenderOf(from, answersAsk);
    const admission = this.restoringRecipients.admit(target, sender, held, clientMessage.awaitRestoringRecipient === true);
    if (admission.kind === "none")
      return this.holdForDepartedChild(held, target, sender, clientMessage.awaitRestoringRecipient === true);
    if (admission.kind === "refused" && admission.error !== undefined) this.failHeldSendWith(held, admission.error);
    else if (admission.kind === "refused") this.failHeldSend(held, admission.reason, admission.reasonCode);
    else writeMessageIfOpen(socket, { type: "send_held", messageId, ...(attemptId === undefined ? {} : { attemptId }), timeoutMs: admission.timeoutMs });
    if (admission.kind === "held" && admission.wake !== undefined) this.wakeRestoringRecipientOwner(admission.wake);
    return true;
  };

  /**
   * #4751: a reply to an ask of a released subagent whose call no longer waits for it is delivered like any other send
   * to the child: held for it, waking it, and its ask's route comes back with it. False when it cannot be held.
   */
  private deliverReplyToReleasedChild(pending: PendingReleasedReplyAck): boolean {
    const replier = this.sessions.get(pending.route.replierSessionId);
    if (replier === undefined || replier.socket !== pending.socket) {
      // A failed ask whose recipient ended: there is no sender to hold a send for, so the child gets the message when
      // its owner wakes it and it registers again.
      if (pending.message.replyError === undefined) return false;
      this.pendingQuestions.holdForReleasedChild(pending.childName, pending.ownerSessionId, {
        askerSessionId: pending.route.askerSessionId,
        from: pending.from,
        message: pending.message,
      });
      this.wakeRestoringRecipientOwner({ ownerSessionId: pending.ownerSessionId, childName: pending.childName });
      return true;
    }
    this.pendingQuestions.parkAsker(pending.childName, pending.ownerSessionId, {
      senderSessionId: pending.route.askerSessionId,
      targetSessionId: pending.route.replierSessionId,
      messageId: pending.questionId,
    });
    const held = this.holdForRestoringRecipient({
      socket: pending.socket,
      from: replier,
      clientMessage: {
        type: "send",
        to: pending.childName,
        message: pending.message,
        // The replier's client sent a `send`, which always waits for a held recipient.
        awaitRestoringRecipient: true,
        ...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
      },
      target: pending.childName,
      messageId: pending.message.id,
      ...(pending.attemptId === undefined ? {} : { attemptId: pending.attemptId }),
      answersAsk: true,
    });
    // The route stays with the owner, so a reply whose held delivery fails (the child does not wake in time) can be
    // sent again and wake the child again; the child's inbox shows a reply once however often it arrives.
    if (held) this.releasedAskerReplies.restore(pending.route, pending.ownerSessionId);
    return held;
  }

  /** #4639: a subagent whose session is gone: hold the send for its return or its owner's verdict, or refuse it with why. */
  private holdForDepartedChild(held: HeldSend, target: string, sender: HoldSender, canHold: boolean): boolean {
    const admission = this.departedChildren.admit(target, sender, held, canHold);
    if (admission.kind === "none") return false;
    if (admission.kind === "refused") this.refuseHeldSends([{ held, error: admission.error }]);
    else
      writeMessageIfOpen(held.socket, {
        type: "send_held",
        messageId: held.messageId,
        ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
        timeoutMs: admission.timeoutMs,
      });
    return true;
  }

  private dispatchHeldSends(sends: readonly HeldSend[]): void {
    for (const send of sends) this.dispatchSend(send.socket, send.clientMessage, send.senderId);
  }

  /** #4639: refuse held sends with the typed error naming why their subagent is gone; its message is the reason. */
  private refuseHeldSends(refusals: readonly HeldSendRefusal[]): void {
    for (const { held, error } of refusals) this.failHeldSendWith(held, error);
  }

  private failHeldSendWith(held: HeldSend, error: IntercomRecipientGoneError): void {
    // #4642: a client that registered below protocol 3 validates `recipientError` against the codes it knows and ends
    // the connection over one it does not; it gets the plain reason, which already says what the typed error does.
    const typed = error.code !== "recipient_stage_released" || clientHostsSessions(held.socket);
    writeMessageIfOpen(held.socket, {
      type: "delivery_failed",
      messageId: held.messageId,
      ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
      reason: error.message,
      ...(typed ? { recipientError: serializeIntercomRecipientGoneError(error) } : {}),
    });
  }

  /** #4326: the child is released; its owner rehydrates it, and it takes the held sends in order when it registers. */
  private wakeRestoringRecipientOwner(wake: RestoringRecipientWake): void {
    const owner = this.sessions.get(wake.ownerSessionId);
    if (owner === undefined) return;
    writeMessageIfOpen(owner.socket, {
      type: "restoring_recipient_wake",
      childName: wake.childName,
      ...(wake.capability === undefined ? {} : { capability: wake.capability }),
    });
  }

  private reserveRestoringRecipient(
    key: string,
    ownerSessionId: string,
    childName: string,
    group: string,
    aliases: readonly string[],
    options: { readonly dormant: boolean; readonly wake?: boolean; readonly replaceAliases?: true; readonly holdMs?: number; readonly releaseOrder?: number },
  ): Promise<boolean> {
    const wake = this.restoringRecipients.reserve(key, ownerSessionId, childName, group, aliases, options);
    const published = this.multiNode?.restoringReserved(key, ownerSessionId, childName, group, aliases, options.dormant, {
      wake: options.wake === true,
      ...(options.replaceAliases === true ? { replaceAliases: true } : {}),
    });
    if (wake !== undefined) this.wakeRestoringRecipientOwner(wake);
    return published ?? Promise.resolve(true);
  }

  /** Resolves true once senders on other brokers can find the reservation, false while its write is retried. */
  private reserveReleasedChild(ownerSessionId: string, ownerGroup: string, child: ParsedReleasedChild, releaseOrder?: number): Promise<boolean> {
    return this.reserveRestoringRecipient(
      releasedReservationKey(child.childName),
      ownerSessionId,
      child.childName,
      normalizeGroup(child.group ?? ownerGroup),
      child.aliases,
      { dormant: true, wake: child.wake, replaceAliases: true, releaseOrder },
    );
  }

  private releasedChildrenRefusal(
    owner: ConnectedSession,
    children: readonly ParsedReleasedChild[],
  ): ReleasedChildRefusal | undefined {
    for (const child of children) {
      const refusal = this.releasedChildGroupRefusal(owner, child) ?? this.releasedChildOwnerRefusal(owner, child.childName);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
  }

  private releasedChildGroupRefusal(owner: ConnectedSession, child: ParsedReleasedChild): ReleasedChildRefusal | undefined {
    if (child.group === undefined) return undefined;
    const group = normalizeGroup(child.group);
    if (!group.startsWith("workflow:")) return undefined;
    if (group === normalizeGroup(owner.registrationGroup) || hasGroup(sessionGroups(owner.info), group)) return undefined;
    return { code: "group_not_allowed", childName: child.childName };
  }

  private releasedChildOwnerRefusal(requester: ConnectedSession, childName: string): ReleasedChildRefusal | undefined {
    const reservedBy = this.restoringRecipients.releasedOwner(childName);
    if (reservedBy !== undefined) return reservedBy === requester.info.id ? undefined : { code: "not_owner", childName };
    const supervisor = this.supervisorChannel.supervisorOf(childName);
    if (
      supervisor === undefined ||
      supervisor.supervisorId === requester.info.id ||
      (requester.supervisorOwnerToken !== undefined && requester.supervisorOwnerToken === supervisor.ownerToken)
    ) {
      return undefined;
    }
    return { code: "not_owner", childName };
  }

  private revokeReleasedReservation(key: string, ownerSessionId: string): void {
    const revoked = this.restoringRecipients.release(key, ownerSessionId, undefined);
    for (const send of revoked?.held ?? []) this.dispatchSend(send.socket, send.clientMessage, send.senderId);
  }

  private releaseReservation(key: string, ownerSessionId: string, gone: string | undefined, refusal: string | undefined): void {
    const bounded = boundedReleaseReasons(gone, refusal);
    const released = this.restoringRecipients.release(key, ownerSessionId, bounded.gone, bounded.refusal);
    if (released === undefined) return;
    this.multiNode?.restoringReleased(key, ownerSessionId, released.gone, released.refusal);
    for (const send of released.held) {
      if (released.gone !== undefined) this.failHeldSend(send, released.gone);
      else if (released.refusal !== undefined) this.failHeldSend(send, released.refusal);
      else this.dispatchSend(send.socket, send.clientMessage, send.senderId);
    }
  }

  private failHeldSend(held: HeldSend, reason: string, reasonCode?: DeliveryFailureReasonCode): void {
    writeMessageIfOpen(held.socket, {
      type: "delivery_failed",
      messageId: held.messageId,
      ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
      reason,
      ...(reasonCode === undefined ? {} : { reasonCode }),
    });
  }

  /** #4996: a released subagent's ask refused a reply route at capacity fails to the subagent, never silently. */
  private failRefusedReleasedRoute(route: RefusedReleasedAskerRoute): void {
    failRefusedReleasedAsk(route, {
      pendingQuestions: this.pendingQuestions,
      replier: this.sessions.get(route.replierSessionId)?.info,
      askerReturnAddress:
        this.sessions.get(route.askerSessionId)?.registrationReturnAddress ??
        this.sessionIdReclaim.retiredReturnAddress(route.askerSessionId),
      wake: (wake) => this.afterDeparture(() => this.wakeRestoringRecipientOwner(wake)),
    });
  }

  /** #4996: asks the away recipient's full queue could not keep fail at once to their connected askers, never silently. */
  private failAwayQueueFull(questions: readonly PendingQuestion[], recipient: SessionInfo): void {
    const reason = awayQueueFullReason(recipient.name ?? recipient.id);
    for (const question of questions) {
      const asker = this.sessions.get(question.senderSessionId);
      if (asker === undefined) continue;
      // #5004: held until the asker saved it, like a reply, and sent once this departure is saved.
      deliverAskFailure({
        asker,
        question,
        from: recipient,
        id: `away-queue-full:${question.messageId}`,
        reason,
        pending: this.pendingQuestions,
        write: this.writeAfterDeparture,
      });
    }
  }

  /** Whether `sessionId` is connected and proves the kept return address (an empty one proves nothing to match). */
  private isConnectedAs(sessionId: string, returnAddress: string): boolean {
    const session = this.sessions.get(sessionId);
    return session !== undefined && (returnAddress === "" || session.registrationReturnAddress === returnAddress);
  }

  /** `peer`: the recipient that ended, when it is known; otherwise each question's recipient is named by its id. */
  private failParkedQuestions(questions: readonly PendingQuestion[], peer?: SessionInfo): void {
    for (const question of questions) {
      const asker = this.sessions.get(question.senderSessionId);
      if (asker === undefined) continue;
      const from: SessionInfo = peer ?? {
        id: question.targetSessionId, cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: Date.now(),
      };
      // #5004: held until the asker saved it, like a reply; a client that does not confirm saves gets the notice.
      deliverAskFailure({
        asker,
        question,
        from,
        id: `ended:${question.messageId}`,
        reason: `Session "${from.name ?? from.id}" ended before replying`,
        pending: this.pendingQuestions,
        write: this.writeAfterDeparture,
        legacy: {
          type: "peer_disconnected", replyTo: question.messageId, peerSessionId: question.targetSessionId,
          ...(peer?.name === undefined ? {} : { peerName: peer.name }),
        },
      });
    }
  }

  /**
   * #4992: the asks to the owner's released subagents that wait kept (an away asker's, or any after a broker restart)
   * end with the owner, or with `childName` when it is dropped: each asker gets one failed-ask message, held until it
   * saves it, and written now when it is connected.
   */
  private failParkedKept(ownerSessionId: string, childName?: string): void {
    for (const held of this.pendingQuestions.failParkedKept(ownerSessionId, childName)) {
      const asker = [...this.sessions.values()].find(
        (session) => session.registrationReturnAddress === held.askerReturnAddress,
      );
      if (asker === undefined) continue;
      // #4996: told once the departure in progress, if any, is saved.
      this.writeAfterDeparture(asker.socket, { type: "message", from: held.from, message: held.message });
      if (!asker.acknowledgesReceipt) this.pendingQuestions.releaseHeld(held.message.id, held.askerReturnAddress);
    }
  }

  /** #4639: a session back after its connection closed takes over what its host session kept: released children and answers. */
  private adoptOrphans(ownerSessionId: string, owner: ConnectedSession): void {
    this.restoringRecipients.adoptOrphans(ownerSessionId, owner.registrationReturnAddress);
    this.dispatchHeldSends(this.departedChildren.adoptOrphans(ownerSessionId, owner.registrationReturnAddress));
  }

  private isTopLevel(session: ConnectedSession | undefined): boolean {
    return session !== undefined && session.supervisorId === undefined && session.hostedBy === undefined;
  }

  /**
   * #4751: asks wait here for their away peer. #4997: with multi-node routing that peer may come back on another
   * broker, so the asks between two top-level sessions also move to the shared state, which either broker answers.
   */
  private keepAwayRoutes(
    departed: ConnectedSession,
    questions: readonly PendingQuestion[],
    senderReturnAddress?: string,
    /** `recipient`: the departed session is their recipient, whose away queue is capped (#4996). */
    away: "asker" | "recipient" = "asker",
  ): PendingQuestion[] {
    // An ask whose other peer is away too, or is a subagent, stays this broker's alone, as before.
    const movable = new Set(
      this.multiNode === undefined || !this.isTopLevel(departed)
        ? []
        : questions.filter((question) =>
            [question.senderSessionId, question.targetSessionId].every(
              (id) => id === departed.info.id || this.isTopLevel(this.sessions.get(id)),
            ),
          ),
    );
    // Kept, and marked movable, in the write that removes their live routes, so a crash before the shared write
    // leaves them to move once this broker is back.
    const isMovable = (question: PendingQuestion) => movable.has(question);
    const refused =
      away === "recipient"
        ? this.pendingQuestions.keepDormantForRecipient(questions, isMovable)
        : (this.pendingQuestions.keepDormant(questions, senderReturnAddress, isMovable), []);
    // #4996: one the recipient's full away queue refused is failed to its asker, not moved.
    void this.multiNode?.publishAwayRoutes([...movable].filter((question) => !refused.includes(question)));
    return refused;
  }

  /** `ended`: the session said goodbye, so it is not coming back; otherwise its connection only dropped. */
  private disconnectSession(sessionId: string, ended = false): void {
    // A hosted session's departure joins its host's: its outcomes go out when the host's departure is saved.
    if (this.departureOutcomes !== undefined) {
      this.departSession(sessionId, ended);
      return;
    }
    // #4996: what a departure keeps, holds and forgets durably (possibly thousands of asks) is one transaction. What it
    // tells askers goes out only once that is saved: a crash before then undoes the decision, which the next broker
    // makes again, so an asker is never told of an outcome that did not happen.
    const outcomes: Array<() => void> = [];
    this.departureOutcomes = outcomes;
    try {
      this.pendingQuestions.batch(() => this.departSession(sessionId, ended));
    } finally {
      this.departureOutcomes = undefined;
    }
    for (const tell of outcomes) tell();
  }

  /** #4996: what a departure tells askers, collected while it is saved; undefined outside a departure. */
  private departureOutcomes: Array<() => void> | undefined;

  /** #4996: tell an asker now, or, during a departure, once the departure is saved. */
  private afterDeparture(tell: () => void): void {
    if (this.departureOutcomes === undefined) tell();
    else this.departureOutcomes.push(tell);
  }

  /** #4996: a frame to an asker, written once the departure in progress, if any, is saved. */
  private readonly writeAfterDeparture = (socket: net.Socket, frame: BrokerMessage): void => {
    this.afterDeparture(() => writeMessageIfOpen(socket, frame));
  };

  private forgetPendingStageRoute(runId: string): void {
    this.pendingStageRoutes.delete(runId);
    this.workflowRosters.delete(runId);
    this.workflowStageAliases.forgetRun(runId);
    this.returnPaths.forgetRun(runId);
  }

  /** Only the last route of an invocation releases its orphaned children. */
  private releaseInvocationOrphans(invocation: string): HeldSend[] {
    for (const route of this.pendingStageRoutes.values()) if (route.group === invocation) return [];
    const inInvocation = (group: string) => invocationOwnsGroup(invocation, group);
    return [...this.restoringRecipients.dropOrphans(inInvocation), ...this.departedChildren.dropOrphans(inInvocation)];
  }

  private departSession(sessionId: string, ended: boolean): void {
    const departed = this.sessions.get(sessionId);
    if (!departed) return;
    // #4642: the sessions a connection hosts leave with it, and a hosted session leaves its host's index.
    for (const hostedId of [...(this.hostedSessions.get(sessionId) ?? [])]) this.disconnectSession(hostedId);
    this.hostedSessions.delete(sessionId);
    if (departed.hostedBy !== undefined) {
      this.hostedSessions.get(departed.hostedBy)?.delete(sessionId);
      // A released stage whose peer left answers with why, and where to send instead, rather than `Session not found`.
      if (departed.registrationName !== undefined) {
        const marked = this.departedChildren.markStageReleased(departed.hostedBy, {
          childName: departed.registrationName,
          group: normalizeGroup(departed.registrationGroup),
          aliases: [sessionId],
        });
        this.refuseHeldSends(marked.refused);
        this.dispatchHeldSends(marked.evicted);
      }
    }

    this.restoringRecipients.dropSender(sessionId);
    this.departedChildren.dropSender(sessionId);
    // A session that ended for good takes its return paths with it, both ways: a later session given its id or name
    // inherits nothing, nor does a receipt that arrives later for what it sent. One that is only away keeps them for
    // when it registers again under the same identity. Paths belong to the identity, so while another registration of
    // it (a duplicate) is live, here or, with multi-node routing, on another broker, they stay with that one.
    const departedIdentity = returnPathParty(departed).identity;
    if (ended && departedIdentity !== undefined && !this.identityLiveHere(departed, departedIdentity)) {
      const multiNode = this.multiNode;
      if (multiNode === undefined) this.returnPaths.revoke(departedIdentity);
      else
        void multiNode.identityPresentElsewhere(departedIdentity).then((present) => {
          if (!present) this.returnPaths.revoke(departedIdentity);
        });
    }
    // #3760: a departed owner restores nothing more; what it held goes through ordinary routing once it is gone.
    // #4639: a session whose connection closes while it keeps released children, as a suspended stage's does, keeps
    // them: sends to them are held until its host session connects again and reserves them.
    const unreserved = [
      ...this.restoringRecipients.dropOwner(sessionId, departed.registrationReturnAddress),
      ...this.departedChildren.dropOwner(sessionId, departed.registrationReturnAddress),
    ];
    this.failParkedQuestions(this.pendingQuestions.takeParkedForOwner(sessionId));
    this.failParkedKept(sessionId);

    // Each ask keeps its live record until what replaces it is written, so a crash in between loses none.
    const unanswered = this.pendingQuestions.takeForSender(sessionId, { keepLiveRecords: true });
    crashPoint(DEPARTURE_ASKS_TAKEN);
    if (departed.supervisorId !== undefined && departed.registrationName !== undefined) {
      // #4765: an ask kept while its recipient was away waits on the owner's route too, so the recipient's later end
      // fails it through the owner, which wakes the subagent. It stays kept under the subagent's own return address as
      // well, so a broker restart or a subagent back without its owner still gets the failure, held for it alone.
      this.releasedAskerReplies.keep(
        { sessionId, childName: departed.registrationName },
        [...unanswered, ...this.pendingQuestions.dormantForReleasedAsker(sessionId)],
        this.restoringRecipients.releasedOwner(departed.registrationName),
      );
      this.pendingQuestions.markAwayAsker(sessionId, departed.registrationReturnAddress);
      this.pendingQuestions.keepReleasedAsker(
        departed.registrationReturnAddress,
        this.restoringRecipients.releasedOwner(departed.registrationName) ?? departed.supervisorId,
        departed.registrationName,
      );
      // A kept route rewrote its ask's live record; one it did not keep has no record left to wait on.
      this.pendingQuestions.forgetLive(unanswered.filter((question) => !this.releasedAskerReplies.holds(question)));
    } else if (departed.supervisorId === undefined && !ended) {
      // #4751: an ask has no expiry and survives its asker's restart or release: the route waits for the asker.
      this.keepAwayRoutes(departed, unanswered, departed.registrationReturnAddress);
      this.pendingQuestions.markAwayAsker(sessionId, departed.registrationReturnAddress);
      this.pendingQuestions.forgetLive(unanswered);
    } else {
      this.pendingQuestions.forgetLive(unanswered);
    }
    this.releasedAskerReplies.dropOwner(sessionId);
    for (const [messageId, pending] of [...this.releasedReplyAcks]) {
      if (pending.ownerSessionId === sessionId || (departed.hostedBy === undefined && pending.socket === departed.socket)) {
        this.settleReleasedReply(messageId, "uncertain");
      }
    }
    const childName = departed.registrationName;
    const releasedOwner = childName === undefined ? undefined : this.restoringRecipients.releasedOwner(childName);
    const parked = childName !== undefined && releasedOwner !== undefined && releasedOwner === departed.supervisorId;
    if (parked) {
      this.pendingQuestions.parkTarget(sessionId, childName, releasedOwner);
    } else if (!ended && departed.supervisorId === undefined && departed.hostedBy === undefined) {
      // #4751: a recipient whose connection dropped without ending its session may restart; its asks stay pending.
      // Each ask keeps its live record until its away record is written, so a crash in between loses none. #4996: one
      // its recipient's full away queue refuses fails to its connected asker at once.
      const askedOfIt = this.pendingQuestions.takeForTarget(sessionId, { keepLiveRecords: true });
      crashPoint(DEPARTURE_ASKS_TO_IT_TAKEN);
      const refused = this.keepAwayRoutes(departed, askedOfIt, undefined, "recipient");
      this.pendingQuestions.forgetLive(askedOfIt);
      this.failAwayQueueFull(refused, departed.info);
    } else {
      if (ended) {
        // #4751: an away asker's ask to it fails with a message held until the asker is back; a session that ended
        // for good is waited for by nothing.
        const reason = `Session "${departed.info.name ?? sessionId}" ended before replying`;
        // #4997: with multi-node routing, an ask that moves to the shared state is failed there, once, on any broker.
        this.pendingQuestions.failDormantForTarget(
          departed.info,
          reason,
          "recipient-ended",
          departed.registrationReturnAddress,
          this.multiNode !== undefined,
        );
        this.failReleasedAsksTo(departed.info, departed.socket, reason, "recipient-ended");
        if (departed.supervisorId === undefined)
          this.pendingQuestions.dropAway(departed.registrationReturnAddress);
      }
      this.failParkedQuestions(this.pendingQuestions.takeForTarget(sessionId, { ended: departed.info }), departed.info);
      if (ended) crashPoint(DEPARTURE_ASKS_TO_IT_FAILED);
    }
    // #4639: a subagent that left without being released: hold sends to it until it is back or its owner says why. An
    // owner already away, as a suspended workflow stage's session is, says so through its host session when it is back.
    const ownerAway = departed.supervisorId !== undefined && !this.sessions.has(departed.supervisorId);
    if (
      !parked &&
      childName !== undefined &&
      departed.supervisorId !== undefined &&
      (!ownerAway || departed.supervisorReturnAddress !== undefined)
    ) {
      const aliases = [sessionId, departed.registrationReturnAddress].filter((alias): alias is string => alias !== undefined);
      unreserved.push(...this.departedChildren.depart({
        ownerSessionId: departed.supervisorId,
        childName,
        group: normalizeGroup(departed.registrationGroup),
        aliases,
        ...(ownerAway && departed.supervisorReturnAddress !== undefined
          ? { ownerHostSession: departed.supervisorReturnAddress }
          : {}),
      }));
    }

    const endedInvocations = new Set<string>();
    for (const [runId, owner] of this.pendingStageRoutes) {
      if (owner.sessionId !== sessionId) continue;
      this.forgetPendingStageRoute(runId);
      endedInvocations.add(owner.group);
    }
    // #4639: once no route of a run is left, the released children its stages kept while away go with it.
    for (const invocation of endedInvocations) unreserved.push(...this.releaseInvocationOrphans(invocation));
    for (const [requestId, pending] of this.pendingStageAcknowledgments) {
      if (pending.ownerSessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pendingStageAcknowledgments.delete(requestId);
      this.releasePendingStageAcknowledgment(requestId);
      this.writeAfterDeparture(pending.senderSocket, {
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
		if (pending.ownerSessionId !== sessionId) {
			this.failPendingStageNotification(
				pending.senderSocket,
				pending.messageId,
				pending.attemptId,
				"Recipient disconnected before acknowledging the pending-stage notification",
			);
		}
		this.forgetDelivered(pending.messageId, pending.signature);
	}
	for (const [target, registration] of this.liveWorkflowStageRoutes) {
		if (registration.sessionId === sessionId) this.liveWorkflowStageRoutes.delete(target);
	}
	for (const [requestId, activation] of this.liveWorkflowStageRouteActivations) {
		if (activation.sessionId === sessionId) this.liveWorkflowStageRouteActivations.delete(requestId);
	}
	this.workflowInvocationClaims.delete(sessionId);
	this.sessions.delete(sessionId);
	if (departed.hostedBy === undefined) this.presenceFanout.forget(departed.socket);
	this.multiNode?.sessionLeft(departed, parked ? { ownerSessionId: releasedOwner, childName } : undefined, ended);
	this.sessionIdReclaim.retire(sessionId, departed.registrationReturnAddress);
	if (isAgentRecipient(departed.info)) this.broadcastToMemberships({ type: "session_left", sessionId }, sessionGroups(departed.info), sessionId);
	for (const send of unreserved) this.dispatchSend(send.socket, send.clientMessage, send.senderId);
	}
  private replaceReach(session: ConnectedSession, reach: IntercomReachPolicy): void {
    const reachedBefore = this.reachedSessionIds(session);
    replaceSessionReach(
      this.sessions,
      (target, message) => writeMessageIfOpen(target, message),
      session,
      reach,
      (peer, changed) => this.presenceFanout.queue(peer, changed.info.id),
    );
    const reachedAfter = this.reachedSessionIds(session);
    for (const id of reachedAfter) {
      const reached = this.sessions.get(id);
      if (!reachedBefore.has(id) && reached !== undefined)
        writeMessageIfOpen(session.socket, { type: "session_joined", session: reached.info });
    }
    for (const id of reachedBefore) {
      if (!reachedAfter.has(id)) writeMessageIfOpen(session.socket, { type: "session_left", sessionId: id });
    }
    this.multiNode?.sessionUpdated(session);
  }

  private reachedSessionIds(session: ConnectedSession): Set<string> {
    const reached = new Set<string>();
    for (const [id, peer] of this.sessions) {
      if (id !== session.info.id && isAgentRecipient(peer.info) && reachesSession(session, peer.info)) reached.add(id);
    }
    return reached;
  }

  /** Deliver a broadcast once to each session represented in any given group. */
  private broadcastToMemberships(msg: BrokerMessage, groups: ReadonlySet<string>, exclude?: string): void {
    for (const [id, session] of this.sessions) {
      // #4642: a hosted session shares its host's socket and needs no copy of its own.
      if (session.hostedBy !== undefined) continue;
      if (id !== exclude && reachesGroups(session, groups)) {
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
      // A registration still waiting for its presence write has been taken but not answered, and its frames are held
      // behind the `registered` it is owed. It gets the same refusal a registration arriving now gets: the held
      // frames go (each confirmed write reports `false`, as for a session that is gone) and the refusal is written
      // before the socket ends, so its client registers with the replacement instead of finding the socket closed.
      if (isHoldingWrites(session.socket)) {
        discardHeldWrites(releaseHeldWrites(session.socket));
        writeMessageIfOpen(session.socket, RETIRING_REFUSAL);
      }
      session.socket.end();
    }
    this.sessions.clear();
    this.hostedSessions.clear();
    this.pendingStageRoutes.clear();
    this.pendingStageAcknowledgments.clear();
    this.liveWorkflowStageRoutes.clear();
    this.liveWorkflowStageRouteActivations.clear();
    this.restoringRecipients.clear();
    this.releasedAskerReplies.clear();
    this.presenceFanout.dispose();
    for (const pending of this.releasedReplyAcks.values()) clearTimeout(pending.timer);
    this.releasedReplyAcks.clear();
    this.receipts.clear();
	for (const pending of this.pendingStageNotificationAcknowledgments.values()) clearTimeout(pending.timeout);
	this.pendingStageNotificationAcknowledgments.clear();
	if (this.pendingForgetTimer !== null) clearTimeout(this.pendingForgetTimer);
	this.pendingForgetTimer = null;
	this.deliveredMessageCache?.close();
    // The watchdog thread ends while this broker's pipe still answers its probes. On Windows, process.exit waits for
    // that thread, and the thread for its probe's connection: one made after the pipe server closed, while a session's
    // connection still holds the pipe open, finds the pipe busy and waits up to 30 s for a free instance.
    const watchdogStopped = this.watchdog?.stop() ?? Promise.resolve();
    // Give this broker's leases up so other brokers see its sessions offline at once, within a bound.
    const leasesGivenUp = this.multiNode?.close().catch(() => {}) ?? Promise.resolve();
    const bound = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_CLOSE_BOUND_MS).unref());
    void Promise.race([Promise.all([watchdogStopped, leasesGivenUp]), bound]).finally(() => this.exitAfterShutdown());
  }

  private async exitAfterShutdown(): Promise<never> {
    // Windows named pipes are not path-unlinked on close, so a successor's pipe is never at risk.
    if (process.platform === "win32") {
      this.unlinkRuntimeFilesIfOwned();
      this.server.close();
      process.exit(0);
    }
    // Node unlinks a Unix socket path on server.close() even after a successor rebound that path. The close happens
    // only under the socket lock every starting broker holds until it listens, and only while the pid file and the
    // socket inode are still this broker's (#5040); otherwise process.exit closes the fd without unlinking the path.
    const release = await acquireSocketLockWithin(SHUTDOWN_CLOSE_BOUND_MS);
    const ownsRuntime = this.readPidFile() === process.pid;
    this.unlinkRuntimeFilesIfOwned();
    if (release?.held() === true && ownsRuntime && this.ownsSocketPath()) this.server.close();
    release?.();
    process.exit(0);
  }
}

// The stderr cap is already in place: `./bounded-stderr-install.js` is this file's first import.
async function startUnlessLiveBrokerAnswers(): Promise<void> {
  if (await isSocketAnswering(SOCKET_PATH)) exitBecauseLiveBrokerOwnsSocket();
  await new IntercomBroker().start();
}

void startUnlessLiveBrokerAnswers();
