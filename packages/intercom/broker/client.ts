import { EventEmitter } from "events";
import net from "net";
import { createHash, randomUUID } from "crypto";
import { releaseObservation, type ReleaseObservation, type ReleaseStamp, type VerifyRelease } from "./released-child-receipts.js";

import { writeMessage, createMessageReader, type JsonWireValue } from "./framing.js";
import { isBrokerStatusReport } from "./broker-status.js";
import { directBrokerSocketPath, getAgentDir, getBrokerSocketPathAsync } from "./paths.js";
import type {
	SessionInfo,
	Message,
	Attachment,
	BrokerStatusReport,
	BrokerMultiNodeStatus,
	GroupSummary,
	SupervisorRegistration,
	SessionDirectory,
	IntercomDeliveryMode,
	DeliveryFailureReasonCode,
	ReleasedChildRefusal,
	HostedSessionAssignment,
	HostedSessionFrameItem,
} from "../types.js";
import { IntercomReachUnsupportedError } from "../reach-errors.js";
import { type IntercomReachPolicy, narrowMemberships } from "../reach-policy.js";
import { buildSendSignature, PendingSendRegistry, PendingSendTimeoutError } from "./pending-send-registry.js";
import { readSubagentMessageSource } from "../source-ownership.js";
import { isMessage, isSessionInfo } from "./client-message-validation.js";
import { isDeliveryFailureReasonCode } from "./delivery-failure-reason.js";
import { isReleasedChildErrorCode, ReleasedChildReservationError, releasedChildErrorFor } from "./released-child-errors.js";
import {
	type IntercomReleasedReplyError,
	readSerializedIntercomReleasedReplyError,
	rehydrateIntercomReleasedReplyError,
} from "./released-reply-errors.js";
import { RELEASED_CHILD_FRAME_MAX, validateReleasedChildFrame } from "./released-children.js";
import {
	type IntercomRecipientGoneError,
	readSerializedIntercomRecipientGoneError,
	rehydrateIntercomRecipientGoneError,
	type SubagentEndedOutcome,
} from "./recipient-gone-errors.js";
import {
	HostedSessionRequestError,
	hostedSessionErrorFor,
	type IntercomHostedSessionError,
	readHostedSessionRefusal,
	readSerializedIntercomHostedSessionError,
	rehydrateIntercomHostedSessionError,
} from "./hosted-session-errors.js";
import { HOSTED_SESSION_FRAME_MAX, readHostedSessionAssignments, validateHostSessionsFrame } from "./hosted-sessions.js";
import { normalizeGroups } from "../group.js";
import {
	BROKER_RETIRING_CODE,
	BROKER_ROUTING_CHANGED_CODE,
	IntercomBrokerRetiringError,
	IntercomBrokerTimeoutError,
	IntercomClientDisconnectedError,
} from "../recoverable-disconnect.js";
import { type IntercomHostedSessionTimeoutFields, IntercomHostedSessionTimeoutError } from "../hosted-session-timeout-error.js";
import { isSocketAnswering } from "./socket-liveness.js";
import { IntercomBrokerProtocolError, IntercomRoutingChangedError, IntercomRoutingUnavailableError } from "@bastani/atomic";
import {
	BROKER_PROTOCOL,
	type BrokerProtocolRange,
	HOSTED_SESSIONS_PROTOCOL,
	isBrokerProtocolRange,
	LEGACY_BROKER_PROTOCOL,
	protocolRangeOf,
	VERIFIED_REGISTRATION_PROTOCOL,
} from "./protocol-version.js";
import { IntercomSupervisorAuthorizationRefusedError, SUPERVISOR_AUTHORIZATION_REFUSED_CODE } from "../supervisor-refusal.js";
import { SEND_RESPONSE_TIMEOUT_MS } from "../retry-policy.js";
import {
	ENDED_CHILD_OWNER_AWAY_MAX_MS,
	ENDED_CHILD_WAKE_ANSWER_MS,
	ENDED_CHILD_WAKE_START_MAX_MS,
	PAUSED_RECIPIENT_TARGET,
	RESUMING_RECIPIENT_TARGET,
} from "./ended-child-wakes.js";

/**
 * #5999: how long a message queued to resume a subagent is kept here as queued, at most: its broker's bound. One kept for
 * a paused subagent waits as long as the subagent is paused, so it is kept here until it reaches it or fails.
 */
const ENDED_QUEUED_KEPT_MS = ENDED_CHILD_WAKE_ANSWER_MS + ENDED_CHILD_WAKE_START_MAX_MS;
/**
 * Durable wake queue: a broker that keeps the queue across restarts also waits up to 7 days for the session that would
 * resume the subagent: such a message is kept here as long.
 */
const ENDED_QUEUED_KEPT_DURABLE_MS = ENDED_CHILD_OWNER_AWAY_MAX_MS + ENDED_QUEUED_KEPT_MS;
/** #5999: whether the broker has given up a message queued to resume a subagent by now, so it is not kept here. */
function expiredHere(
  kept: { readonly queue: "resuming" | "paused"; readonly at: number; readonly durable?: true },
  now: number,
): boolean {
  return kept.queue === "resuming" && now - kept.at > (kept.durable === true ? ENDED_QUEUED_KEPT_DURABLE_MS : ENDED_QUEUED_KEPT_MS);
}

/** #5999: the most messages kept here as queued for subagents that ended; the oldest is forgotten first. */
const ENDED_QUEUED_MAX = 1_024;

/** How long `connect()` waits for the broker to answer `register`. */
export const BROKER_CONNECT_TIMEOUT_MS = 10_000;
const GROUP_REQUEST_TIMEOUT_MS = 5000;
const PRESENCE_ACK_TIMEOUT_MS = 5000;
const RESTORING_RECIPIENT_REQUEST_TIMEOUT_MS = 5000;
/** #3904: retries of a connection the kernel refused before it reached the broker (a full listen backlog). */
const BROKER_BACKLOG_RETRIES = 6;
const BROKER_BACKLOG_RETRY_BASE_MS = 25;

/** The connect attempt was cancelled by `disconnect()` before it registered. */
function connectAborted(): IntercomClientDisconnectedError {
	return new IntercomClientDisconnectedError({ cause: new Error("Disconnected before the broker connection registered") });
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolveDelay, rejectDelay) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolveDelay();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			rejectDelay(connectAborted());
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
}

function isBacklogRefusal(error: Error): boolean {
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ECONNREFUSED" || code === "EAGAIN";
}

/** The broker closed the connection before it answered the registration. */
class ConnectionClosedBeforeRegistrationError extends Error {
	constructor() {
		super("Connection closed before registration");
		this.name = "ConnectionClosedBeforeRegistrationError";
	}
}

/**
 * Whether a failure before the broker answered `register` is what a broker that retired leaves behind: the socket path
 * is gone (`ENOENT`), or the connection was reset or ended without an answer. A refusal the kernel gives a full listen
 * backlog (`ECONNREFUSED`, `EAGAIN`) is not: those are retried above and still reject as before.
 */
function isLostBrokerSignature(error: Error): boolean {
	if (error instanceof ConnectionClosedBeforeRegistrationError) return true;
	const code = (error as NodeJS.ErrnoException).code;
	return code === "ENOENT" || code === "ECONNRESET" || code === "EPIPE";
}

/**
 * A failure before registration, classified: when it has the signature of a lost broker and nothing answers on the
 * broker socket any more, the broker retired first and the failure is recoverable by spawning its replacement. A broker
 * that still answers closed the connection for its own reasons (a refused or malformed registration), so the failure
 * stays what it was.
 */
async function classifyRegistrationFailure(error: Error, socketPath: string): Promise<Error> {
	if (!isLostBrokerSignature(error) || (await isSocketAnswering(socketPath))) return error;
	return new IntercomBrokerRetiringError(`Intercom broker went away before it registered this session: ${error.message}`, {
    cause: error,
  });
}
/** Extra wait past a broker hold, so the broker's own outcome for a held send always arrives first (#3760). */
const HELD_SEND_GRACE_MS = 5000;
/** #5145: how many outcomes a client remembers hearing, so a second copy of one is not heard again. */
const HEARD_OUTCOMES_MAX = 1_000;

export function sameReachPolicy(left: IntercomReachPolicy | undefined, right: IntercomReachPolicy | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return (
		left.home === right.home &&
		left.reachable.length === right.reachable.length &&
		left.reachable.every((group, index) => right.reachable[index] === group)
	);
}

export { IntercomReachUnsupportedError } from "../reach-errors.js";

export interface ExpectedRouting {
  readonly acrossMachines: boolean;
  /**
   * #4538: the broker verifies the routing as it registers the session (`register_verified`, protocol 2). Without it
   * the session registers as an older client does, and a broker that reports other routing in `registered` is refused.
   */
  readonly verify: boolean;
}

export interface SendOptions {
  text: string;
  attachments?: Attachment[];
  displayRanges?: readonly import("../types.js").MessageDisplayRange[];
  replyTo?: string;
  expectsReply?: boolean;
  /** How a busy recipient receives the message; absent means `steer`. */
  delivery?: IntercomDeliveryMode;
  replyError?: string;
  messageId?: string;
  beforeWrite?: (reach: IntercomReachPolicy | undefined) => void;
  /** The id every copy of one pattern send shares (`Message.broadcastId`). */
  broadcastId?: string;
  /** Internal caller-issued target identity; transport still uses the `to` argument. */
  logicalTarget?: string;
  /** Public reply must use the broker's exact pending reverse question route. */
  requirePendingReply?: true;
  /** An explicit reply selector must resolve to this frozen recipient, never a namesake. */
  expectedRecipientId?: string;
  /** Broker-authorized recipient identity for an ask, delivered before its recipient can reply. */
  onReplyTarget?: (sessionId: string) => void;
  /** #4642: send as this session, which this connection hosts (`hostSessions`). */
  hostedSender?: string;
  /**
   * #5999: a subagent that ended but can be resumed is resumed for this message, which is then answered `queued` with
   * target `resuming subagent`. For one exact target; never for one copy of a pattern send. An older broker ignores it.
   */
  wakeEndedRecipient?: true;
}

export interface IntercomClientOptions {
	/** Intercom session id held before a restart or reconnect; the broker grants it only when it is free (#3760). */
	readonly preferredSessionId?: string;
	/** #3761: this client confirms each received message with `acknowledgeReceived` once it has saved it. */
	readonly acknowledgesReceipt?: true;
	/** Registration answer bound for `connect()`; defaults to `BROKER_CONNECT_TIMEOUT_MS`. */
	readonly connectTimeoutMs?: number;
	/**
	 * Broker socket this client connects to; defaults to the one for the agent directory current when it is created
	 * (#4561), looked up at each connection, since a broker that replaces another may record a different one (#5040).
	 */
	readonly brokerSocketPath?: string;
	readonly reach?: () => IntercomReachPolicy | undefined;
	/** #5999: shared by the session's clients across reconnects; see {@link EndedQueueMemory}. */
	readonly endedQueue?: EndedQueueMemory;
	/**
	 * #5607: with multi-node routing, this client takes its id back when the broker hands it over: a registration that
	 * gets a fresh id only while another registration of the session holds the one it asked for is told which id it
	 * awaits, and later reconnects with the hand-over the broker gives it (`idHandoff`, `IntercomIdHandoff`).
	 */
	readonly takesIdHandoff?: true;
	/** #5607: the hand-over its previous connection was given, presented once with this registration. */
	readonly idHandoff?: IntercomIdHandoff;
}

/** #5607: an id the broker holds for this session, and the one-use value that takes it on the next registration. */
export interface IntercomIdHandoff {
	readonly sessionId: string;
	readonly handoff: string;
}

export interface ReleasedChildReply {
	readonly childName: string;
	readonly handoffId: string;
	readonly replyTo: string;
	readonly from: SessionInfo;
	readonly message: Message;
}

/** A subagent this session launched whose last run ended, and how (#4639). */
export interface EndedChildReport {
	readonly childName: string;
	readonly group?: string;
	/** Its Atomic session id and last Intercom id, when known. */
	readonly aliases?: readonly string[];
	readonly outcome: SubagentEndedOutcome;
	/** The `<runId>:<index>` id `subagent({ action: "resume" })` takes. */
	readonly childId?: string;
	/**
	 * #5999: resume it for a send that asks to wake it (`wake`), or keep such a message until this session continues it
	 * (`hold`). Reported only to a broker that wakes ended children; never with the `cancelled` outcome.
	 */
	readonly messages?: "wake" | "hold";
}

/** #5999: the broker asks this session to resume a subagent it reported ended with `wake`, for a message queued for it. */
export interface EndedChildWakeNotice {
	readonly childName: string;
	readonly childId?: string;
	/** Names this wake in the answer (`answerEndedChildWake`). */
	readonly wakeId: string;
	/** The sender of the message that woke it. */
	readonly from: { readonly id: string; readonly name?: string };
	/** How far down a chain of wakes this one is (1: its sender was not itself woken). */
	readonly depth: number;
}

/**
 * #5999: a message this client sent that its broker queued for a subagent that ended, and that the broker lost: it
 * registered again with another broker before the message reached the subagent or failed.
 */
export interface LostEndedQueuedMessage {
	readonly messageId: string;
	/** The target it was sent to, and the target as its sender wrote it. */
	readonly to: string;
	readonly logicalTarget: string;
	readonly expectsReply: boolean;
	/** Why it was queued: the subagent was being resumed for it, or was paused. */
	readonly queue: "resuming" | "paused";
}

/**
 * #5999: what a session keeps about messages its brokers queued for subagents that ended, across its connections: the
 * broker process it last registered with, and the messages that neither reached their subagent nor failed yet. Pass one
 * to every client a session connects with (`IntercomClientOptions.endedQueue`), so a client that registers with another
 * broker knows what the lost one kept.
 */
export class EndedQueueMemory {
	brokerInstanceId: string | undefined;
	readonly kept = new Map<string, LostEndedQueuedMessage & { readonly at: number; readonly durable?: true }>();
	/**
	 * Durable wake queue: messages this session was told were lost, by the id of what kept them. A broker that keeps them
	 * there after all (an older broker served in between) is told to drop them, so none is delivered after it was told
	 * lost. Bounded like `kept`.
	 */
	readonly toldLost = new Map<string, string>();
}

/** A released subagent to keep addressable through its owner, by name (#4326). */
export interface ReleasedChildReservation {
	readonly childName: string;
	readonly group?: string;
	readonly aliases?: readonly string[];
	/** true: the first send held for it asks this owner to wake it; false: parked (paused or quit): sends are held but the owner is never asked. */
	readonly wake: boolean;
}

export {
	IntercomReleasedChildError,
	isIntercomReleasedChildError,
	isReleasedChildReservationError,
	isUnknownReleasedChildError,
	ReleasedChildReservationError,
	rehydrateIntercomReleasedChildError,
	serializeIntercomReleasedChildError,
	UnknownReleasedChildError,
} from "./released-child-errors.js";
export type { IntercomReleasedChildErrorCode, SerializedIntercomReleasedChildError } from "./released-child-errors.js";
export {
	INTERCOM_RECIPIENT_GONE_ERROR_CODES,
	IntercomRecipientGoneError,
	isIntercomRecipientGoneError,
	isIntercomRecipientGoneErrorCode,
	isRetryableIntercomRecipientGoneError,
	isSubagentRecipientDisconnectedError,
	isSubagentRecipientEndedError,
	isSubagentRecipientOwnerSuspendedError,
	readSerializedIntercomRecipientGoneError,
	rehydrateIntercomRecipientGoneError,
	SUBAGENT_ENDED_OUTCOMES,
	SubagentRecipientDisconnectedError,
	SubagentRecipientEndedError,
	SubagentRecipientOwnerSuspendedError,
	serializeIntercomRecipientGoneError,
} from "./recipient-gone-errors.js";
export type {
	IntercomRecipientGoneErrorCode,
	IntercomRecipientGoneErrorFields,
	SerializedIntercomRecipientGoneError,
	SubagentEndedOutcome,
	SubagentRecipientDisconnectedCode,
	SubagentRecipientEndedCode,
	SubagentRecipientOwnerSuspendedCode,
} from "./recipient-gone-errors.js";
export {
	IntercomReleasedReplyError,
	isIntercomReleasedReplyError,
	isReleasedReplyAnsweredError,
	isReleasedReplyInFlightError,
	isRetryableIntercomReleasedReplyError,
	ReleasedReplyAnsweredError,
	ReleasedReplyInFlightError,
	rehydrateIntercomReleasedReplyError,
	serializeIntercomReleasedReplyError,
} from "./released-reply-errors.js";
export type {
	IntercomReleasedReplyErrorCode,
	IntercomReleasedReplyErrorFields,
	SerializedIntercomReleasedReplyError,
} from "./released-reply-errors.js";
export {
	HostedSessionRequestError,
	IntercomHostedSessionError,
	isHostedSessionRequestError,
	isIntercomHostedSessionError,
	isNotHostedSessionError,
	NotHostedSessionError,
} from "./hosted-session-errors.js";
export type { IntercomHostedSessionErrorCode } from "./hosted-session-errors.js";

function readReleasedChildRefusal(value: unknown): ReleasedChildRefusal | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const { code, childName } = value as { code?: unknown; childName?: unknown };
	if (typeof code !== "string" || !isReleasedChildErrorCode(code)) return undefined;
	if (childName !== undefined && typeof childName !== "string") return undefined;
	return childName === undefined ? { code } : { code, childName };
}

export interface SendResult {
  id: string;
  delivered: boolean;
  queued?: boolean;
  reason?: string;
	reasonCode?: DeliveryFailureReasonCode;
	/**
	 * #4386: the typed refusal of a reply to a released subagent. #4642: of a hosted sender. #4639: why a subagent with
	 * no live session is gone. Its `code` is `reasonCode`.
	 */
	error?: IntercomReleasedReplyError | IntercomHostedSessionError | IntercomRecipientGoneError;
	target?: string;
  position?: number;
}

export interface PresenceUpdates {
  name?: string;
  status?: string;
  model?: string;
  groups?: string[];
  group?: string;
  replyCapability?: SessionInfo["replyCapability"];
}


export interface SupervisorAuthorization extends SupervisorRegistration {
  childName: string;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}



/**
 * The broker did not answer one supervisor authorization in time although the connection then passed its health
 * check; a broker that failed it rejects with its own failure instead (#4697).
 */
export class SupervisorAuthorizationTimeoutError extends Error {
	constructor() {
		super("Supervisor authorization timeout");
		this.name = "SupervisorAuthorizationTimeoutError";
	}
}

/**
 * Frames only a 0.9.x broker writes, and only in answer to workflow requests (Atomic 0.10.0 removed workflows) that
 * this client never makes, or to a workflow route owner, which it never is: ignored rather than ending the connection.
 */
const LEGACY_WORKFLOW_BROKER_FRAME_TYPES: ReadonlySet<string> = new Set([
	"pending_stage_message",
	"sticky_live_delivered",
	"pending_stage_route_revoked",
	"pending_stage_route_refused",
	"pending_stage_route_registered",
	"workflow_invocation_claimed",
	"live_workflow_stage_route_registered",
]);

type ObserveReleaseReply = (stamp: ReleaseStamp, error?: Error) => void;

export class IntercomClient extends EventEmitter {
	private readonly returnAddress: string;
	private readonly preferredSessionId: string | undefined;
	private readonly takesIdHandoff: boolean;
	private readonly idHandoff: IntercomIdHandoff | undefined;
	private readonly acknowledgesReceipt: boolean;
	private readonly connectTimeoutMs: number;
	private readonly explicitBrokerSocketPath: string | undefined;
	private readonly brokerAgentDir: string;
	private readonly reachSource: (() => IntercomReachPolicy | undefined) | undefined;
	private sentReach: IntercomReachPolicy | undefined;
	private readonly pendingReach = new Map<string, { resolve(): void; reject(error: Error): void }>();
	/** #3761: the broker of the current registration echoed `acknowledgesReceipt`, so it understands `received`. */
	private brokerAcknowledgesReceipt = false;
	/**
	 * #5145: the outcomes (replies and failed asks) this client already heard, by message id, and whether each was
	 * confirmed saved. Every outcome of an ask carries the same id however often it is sent, so a second copy is not heard
	 * again; one already saved is confirmed again. Bounded, oldest forgotten first.
	 */
	private readonly heardOutcomes = new Map<string, "heard" | "saved">();
	/** #5999: sends in flight that asked to wake an ended recipient, by message id. */
	private readonly wakeSends = new Map<string, Omit<LostEndedQueuedMessage, "messageId" | "queue">>();
	/**
	 * #5999: the broker process of the last registration (another one on the next means queued messages were lost), and
	 * the messages a broker queued for subagents that ended that neither reached them nor failed yet.
	 */
	private readonly endedQueue: EndedQueueMemory;
	private brokerAnswersStatus = false;
	private _multiNodeRouting: BrokerMultiNodeStatus["status"] | undefined;
	/** #4538: the protocol versions the broker of the current registration accepts. */
	private _brokerProtocol: BrokerProtocolRange = LEGACY_BROKER_PROTOCOL;
	/** #3904: the connect attempt in progress, which `disconnect()` cancels. */
	private connectAttempt: AbortController | undefined;
	/** #3983: the broker of the current registration accepts `saving`. */
	private brokerExtendsSaves = false;
	private brokerMarksEndedChildren = false;
	/** #5999: the broker of the current registration wakes ended children and accepts `answer_ended_child_wake`. */
	private brokerWakesEndedChildren = false;
	/** Durable wake queue: the broker of the current registration keeps queued messages across restarts. */
	private brokerDropsEndedQueued = false;
	private brokerStampsReleasedChildren = false;
  private socket: net.Socket | null = null;
  private _sessionId: string | null = null;
  private _supervisorSessionId: string | null = null;
  private _awaitedSessionId: string | null = null;
  /** Source identity is captured once at connect, never read from env per message. */
  private _messageSource: Message["source"] | undefined;
  private pendingSends = new PendingSendRegistry();
  private readonly sendResults = new WeakMap<Promise<SendResult>, Promise<SendResult>>();
  private pendingReplyTargets = new Map<string, { messageId: string; bind(sessionId: string): void }>();
  private pendingGroupLists = new Map<string, { resolve: (groups: GroupSummary[]) => void; reject: (error: Error) => void }>();
  private pendingLists = new Map<string, { resolve: (directory: SessionDirectory) => void; reject: (e: Error) => void }>();
  private pendingPresence = new Map<string, {
    resolve: (group: string) => void;
    reject: (error: Error) => void;
    groups?: string[];
  }>();
  private pendingMemberships = new Map<string, { resolve: (groups: string[]) => void; reject: (error: Error) => void }>();
  private registrationExpectedRouting: ExpectedRouting | undefined;
  private pendingBrokerStatus = new Map<string, { resolve: (report: BrokerStatusReport) => void; reject: (error: Error) => void }>();
  private _groups = normalizeGroups();

  private pendingSupervisorAuthorizations = new Map<string, {
    resolve: (authorization: SupervisorAuthorization) => void;
    reject: (error: Error) => void;
  }>();
  private pendingRestoringRecipientRequests = new Map<
    string,
    { resolve(published?: boolean): void; reject(error: Error): void; observe?: ObserveReleaseReply; verify?: boolean }
  >();
  private releaseRegistration?: string;
  private verifyRelease?: VerifyRelease;
  private pendingHostedSessionRequests = new Map<
    string,
    { resolve(sessions: readonly HostedSessionAssignment[]): void; reject(error: Error): void }
  >();
  private disconnecting = false;
  private disconnectError: Error | null = null;
  private healthCheck: { socket: net.Socket; result: Promise<Error | undefined> } | undefined;

  private async requestTimeout(socket: net.Socket, error: Error): Promise<Error> {
    if (this.socket !== socket || socket.destroyed) return this.disconnectError ?? new IntercomClientDisconnectedError();
    if (this.healthCheck?.socket !== socket) {
      const requestId = randomUUID();
      const result = new Promise<Error | undefined>((resolve) => {
        const finish = (failure?: Error) => {
          clearTimeout(timer);
          this.pendingGroupLists.delete(requestId);
          resolve(failure);
        };
        const timer = setTimeout(() => finish(new IntercomBrokerTimeoutError("Broker health check timed out")), GROUP_REQUEST_TIMEOUT_MS);
        this.pendingGroupLists.set(requestId, { resolve: () => finish(), reject: finish });
        try {
          writeMessage(socket, { type: "list_groups", requestId });
        } catch (cause) {
          finish(new IntercomClientDisconnectedError({ cause }));
        }
      });
      this.healthCheck = { socket, result };
    }
    const check = this.healthCheck;
    const failure = await check.result;
    if (this.healthCheck === check) this.healthCheck = undefined;
    if (failure === undefined) return error;
    const reported = failure instanceof IntercomBrokerTimeoutError
      ? new IntercomBrokerTimeoutError(error.message, { cause: failure })
      : failure;
    if (this.socket === socket && !this.disconnecting) {
      // The other requests on this connection fail with the connection's own failure, not with this request's.
      this.disconnectError ??= failure;
      this.failPending(this.disconnectError);
      socket.destroy();
    }
    return reported;
  }

	constructor(returnAddress: string = randomUUID(), options: IntercomClientOptions = {}) {
		super();
		if (returnAddress.length === 0) throw new Error("Intercom return address must not be empty");
		this.returnAddress = returnAddress;
		this.preferredSessionId = options.idHandoff?.sessionId ?? options.preferredSessionId;
		this.takesIdHandoff = options.takesIdHandoff === true || options.idHandoff !== undefined;
		this.idHandoff = options.idHandoff;
		this.acknowledgesReceipt = options.acknowledgesReceipt === true;
		this.connectTimeoutMs = options.connectTimeoutMs ?? BROKER_CONNECT_TIMEOUT_MS;
		this.explicitBrokerSocketPath = options.brokerSocketPath;
		this.endedQueue = options.endedQueue ?? new EndedQueueMemory();
		this.brokerAgentDir = getAgentDir();
		this.reachSource = options.reach;
	}

  private resolveBrokerSocketPath(): string | Promise<string> {
    if (this.explicitBrokerSocketPath !== undefined) return this.explicitBrokerSocketPath;
    return (
      directBrokerSocketPath(process.platform, this.brokerAgentDir) ??
      getBrokerSocketPathAsync(process.platform, this.brokerAgentDir)
    );
  }

  private failPending(error: Error): void {
    this.pendingSends.rejectAll(error);
    for (const pending of this.pendingGroupLists.values()) pending.reject(error);
    for (const pending of this.pendingLists.values()) pending.reject(error);
    for (const pending of this.pendingSupervisorAuthorizations.values()) pending.reject(error);
    for (const pending of this.pendingRestoringRecipientRequests.values()) pending.reject(error);
    for (const pending of this.pendingHostedSessionRequests.values()) pending.reject(error);
    for (const pending of this.pendingPresence.values()) pending.reject(error);
    for (const pending of this.pendingMemberships.values()) pending.reject(error);
    for (const pending of this.pendingBrokerStatus.values()) pending.reject(error);
    for (const pending of this.pendingReach.values()) pending.reject(error);
    this.pendingReach.clear();
    this.pendingLists.clear();
    this.pendingGroupLists.clear();
    this.pendingSupervisorAuthorizations.clear();
    this.pendingRestoringRecipientRequests.clear();
    this.pendingHostedSessionRequests.clear();
    this.pendingPresence.clear();
    this.pendingMemberships.clear();
    this.pendingBrokerStatus.clear();
  }


  get sessionId(): string | null {
    return this._sessionId;
  }
  /**
   * #5607: with multi-node routing, the id this registration asked for when it got another only because a registration
   * of the same session still held it; null otherwise. The session keeps asking for that id rather than this one.
   */
  get awaitedSessionId(): string | null {
    return this._awaitedSessionId;
  }

  get supervisorSessionId(): string | null {
    return this._supervisorSessionId;
  }
  /** #4538: the protocol versions the broker of the current registration accepts; protocol 1 before registration. */
  get brokerProtocol(): BrokerProtocolRange {
    return this._brokerProtocol;
  }

  /** Routing mode of this registration; absent when the broker predates this capability. */
  get multiNodeRouting(): BrokerMultiNodeStatus["status"] | undefined {
    return this._multiNodeRouting;
  }
  get groups(): string[] {
    return [...this._groups];
  }



  isConnected(): boolean {
    const socket = this.socket;
    return Boolean(socket && this._sessionId && !this.disconnecting && !socket.destroyed && !socket.writableEnded && socket.writable);
  }

  private requireActiveSocket(): net.Socket {
    if (this.disconnecting) {
      throw new Error("Client disconnecting");
    }

    const socket = this.socket;
    if (!socket || !this._sessionId) {
      throw new Error("Not connected");
    }

    if (socket.destroyed || socket.writableEnded || !socket.writable) {
      throw new IntercomClientDisconnectedError();
    }

    return socket;
  }

  /**
   * Connect and register. A connection the operating system refuses before it reaches the broker (`ECONNREFUSED`,
   * `EAGAIN`) is retried a few times with a short jittered backoff: when many sessions start at once (a large pooled
   * fan-out) the broker socket's listen backlog fills and the kernel refuses connections the broker would accept a
   * moment later (#3904). Every other failure, and a refusal that persists past the retries, rejects as before.
   */
  async connect(
    session: Omit<SessionInfo, "id">,
    supervisor?: SupervisorRegistration,
    supervisorOwnerToken?: string,
    messageSource?: Message["source"],
    registrationGroup?: string,
    expectedRouting?: ExpectedRouting,
  ): Promise<void> {
    // #3904: `disconnect()` aborts this attempt, its retry delay and any later retry, so a session that finished
    // its cleanup never ends up connected and registered by a retry still in flight.
    const attempt = new AbortController();
    this.connectAttempt = attempt;
    try {
      for (let retry = 0; ; retry++) {
        if (attempt.signal.aborted) throw connectAborted();
        const resolvedSocketPath = this.resolveBrokerSocketPath();
        const socketPath = typeof resolvedSocketPath === "string" ? resolvedSocketPath : await resolvedSocketPath;
        if (attempt.signal.aborted) throw connectAborted();
        try {
          await this.connectOnce(
            socketPath,
            attempt.signal,
            session,
            supervisor,
            supervisorOwnerToken,
            messageSource,
            registrationGroup,
            expectedRouting,
          );
          return;
        } catch (error) {
          if (attempt.signal.aborted) throw connectAborted();
          if (!(error instanceof Error)) throw error;
          if (!isBacklogRefusal(error) || retry >= BROKER_BACKLOG_RETRIES) {
            const classified = await classifyRegistrationFailure(error, socketPath);
            if (attempt.signal.aborted) throw connectAborted();
            if (expectedRouting?.verify === true && classified instanceof ConnectionClosedBeforeRegistrationError) {
              throw new IntercomRoutingUnavailableError("unsupported", "register");
            }
            throw classified;
          }
          const backoff = BROKER_BACKLOG_RETRY_BASE_MS * 2 ** retry;
          await abortableDelay(backoff * (0.5 + Math.random() / 2), attempt.signal);
        }
      }
    } finally {
      if (this.connectAttempt === attempt) this.connectAttempt = undefined;
    }
  }

  private connectOnce(
    socketPath: string,
    signal: AbortSignal,
    session: Omit<SessionInfo, "id">,
    supervisor?: SupervisorRegistration,
    supervisorOwnerToken?: string,
    messageSource?: Message["source"],
    registrationGroup?: string,
    expectedRouting?: ExpectedRouting,
  ): Promise<void> {
    if (this.socket) {
      return Promise.reject(new Error("Already connected"));
    }
    this._messageSource = messageSource ?? readSubagentMessageSource();
    this._groups = normalizeGroups(session.groups, session.group);
    this.registrationExpectedRouting = expectedRouting;
    // A reconnect by this owner shares its fingerprint, never the registration secret itself.
    this.releaseRegistration = typeof supervisorOwnerToken === "string"
      ? createHash("sha256").update(supervisorOwnerToken).digest("hex") : undefined;
    this.verifyRelease = undefined;

    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      this.socket = socket;
      this.disconnectError = null;
      let settled = false;
      const timeout = setTimeout(() => {
        if (!this._sessionId) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(new IntercomBrokerTimeoutError("Connection timeout"));
        }
      }, this.connectTimeoutMs);
      
      let connectionEstablished = false;
      
      const onRegistered = () => {
        settled = true;
        connectionEstablished = true;
        cleanupConnectionAttempt();
        resolve();
      };
      const onRegistrationFailed = (error: Error) => onError(error);
      
      const onError = (err: Error) => {
        settled = true;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        if (this.socket === socket) {
          this.socket = null;
        }
        socket.destroy();
        reject(err);
      };
      
      const onClose = () => {
        const wasConnecting = !settled && !this._sessionId;
        const wasDisconnecting = this.disconnecting;
        const disconnectError = this.disconnectError ?? new IntercomClientDisconnectedError();
        this.disconnecting = false;
        cleanupConnectionAttempt();
        cleanupSocketListeners();
        this.failPending(disconnectError);
        if (this.socket === socket) {
          this.socket = null;
        }
        this._sessionId = null;
        this._supervisorSessionId = null;
        this._awaitedSessionId = null;
        this.releaseRegistration = undefined;
        this.verifyRelease = undefined;
        this.brokerAcknowledgesReceipt = false;
        this.brokerAnswersStatus = false;
        this._multiNodeRouting = undefined;
        this._brokerProtocol = LEGACY_BROKER_PROTOCOL;
        this.brokerExtendsSaves = false;
        this.brokerMarksEndedChildren = false;
        this.brokerWakesEndedChildren = false;
        this.brokerDropsEndedQueued = false;
        this.brokerStampsReleasedChildren = false;
        this._messageSource = undefined;
        this.disconnectError = null;
        if (connectionEstablished && !wasDisconnecting) {
          this.emit("disconnected", disconnectError);
        }
        if (wasConnecting) {
          reject(new ConnectionClosedBeforeRegistrationError());
        }
      };

      const onSocketError = (err: Error) => {
        if (connectionEstablished) {
          // A transport error on an already-registered socket (ECONNRESET, EPIPE,
          // ETIMEDOUT, or a write-after-end from our own write) is a *recoverable*
          // disconnect: the broker connection is gone, and the lightweight wrapper
          // re-imports and reconnects on the next call. Record it as the typed
          // recoverable error so `onClose` rejects pending work and emits
          // `disconnected` with something the classifier recognizes, and keep the
          // raw transport error as `cause` so the code is still diagnosable.
          //
          // `??=`, not `=`: `onReaderError` records a protocol error and then
          // destroys the socket, and a socket 'error' can still follow. Overwriting
          // would silently downgrade a non-recoverable protocol failure into a
          // recoverable one. First error recorded wins.
          this.disconnectError ??= new IntercomClientDisconnectedError({ cause: err });
          // The raw error keeps flowing to `error` listeners: that channel exists for
          // diagnosis, and the transport code is what a debugger wants to see.
          this.emit("error", err);
        }
      };

      const onReaderError = (error: Error) => {
        const protocolError = new Error(`Intercom protocol error: ${error.message}`, { cause: error });
        if (!connectionEstablished) {
          onError(protocolError);
          return;
        }
        this.disconnectError = protocolError;
        this.emit("error", protocolError);
        socket.destroy();
      };

      const reader = createMessageReader((msg) => {
        this.handleBrokerMessage(msg);
      }, onReaderError);
      
      const onConnect = (): void => {
        if (signal.aborted) {
          onAbort();
          return;
        }
        try {
          const reach = this.reachSource?.();
          const registration = reach === undefined ? session : {
            ...session,
            group: reach.home,
            groups: narrowMemberships(reach, [...normalizeGroups(session.groups, session.group)]),
          };
          this._groups = normalizeGroups(registration.groups, registration.group);
          this.sentReach = reach;
          writeMessage(socket, {
            ...(expectedRouting?.verify === true
              ? { type: "register_verified", expectedRouting: { acrossMachines: expectedRouting.acrossMachines } }
              : { type: "register" }),
            session: registration,
            ...(reach === undefined ? {} : { reach: { home: reach.home, reachable: [...reach.reachable] } }),
            protocol: { ...BROKER_PROTOCOL },
            ...(registrationGroup !== undefined ? { registrationGroup } : {}),
			returnAddress: this.returnAddress,
			...(this.preferredSessionId === undefined ? {} : { preferredSessionId: this.preferredSessionId }),
			...(this.acknowledgesReceipt ? { acknowledgesReceipt: true as const } : {}),
			...(this.takesIdHandoff ? { takesIdHandoff: true as const } : {}),
			...(this.idHandoff === undefined ? {} : { idHandoff: this.idHandoff.handoff }),
            ...(supervisor ? { supervisor } : {}),
            ...(supervisorOwnerToken ? { supervisorOwnerToken } : {}),
          });
        } catch (error) {
          cleanupConnectionAttempt();
          cleanupSocketListeners();
          if (this.socket === socket) {
            this.socket = null;
          }
          socket.destroy();
          reject(toError(error));
        }
      };

      const onAbort = () => onError(connectAborted());

      const cleanupConnectionAttempt = () => {
        signal.removeEventListener("abort", onAbort);
        socket.off("connect", onConnect);
        this.off("_registered", onRegistered);
        this.off("_registration_failed", onRegistrationFailed);
        socket.off("error", onError);
        clearTimeout(timeout);
      };

      const cleanupSocketListeners = () => {
        socket.off("data", reader);
        socket.off("error", onSocketError);
        socket.off("close", onClose);
      };
      
      socket.on("data", reader);
      socket.on("error", onError);
      socket.on("close", onClose);
      
      socket.on("error", onSocketError);
      this.once("_registered", onRegistered);
      this.once("_registration_failed", onRegistrationFailed);
      
      // Register only once connected, and only if the attempt was not cancelled meanwhile (#3904).
      signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", onConnect);
    });
  }

  private handleBrokerMessage(msg: unknown): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid broker message");
    }

    const brokerMessage = msg as { type: string } & Record<string, unknown>;

    if (this._sessionId === null
      && brokerMessage.type !== "registered"
      && brokerMessage.type !== "registration_failed") {
      throw new Error(`Received ${brokerMessage.type} before registered`);
    }

    switch (brokerMessage.type) {
      case "registered": {
        if (typeof brokerMessage.sessionId !== "string"
          || (brokerMessage.supervisorSessionId !== undefined && typeof brokerMessage.supervisorSessionId !== "string")
          || (brokerMessage.acknowledgesReceipt !== undefined && brokerMessage.acknowledgesReceipt !== true)
          || (brokerMessage.brokerStatus !== undefined && brokerMessage.brokerStatus !== true)
          || (brokerMessage.multiNodeRouting !== undefined && brokerMessage.multiNodeRouting !== "off"
            && brokerMessage.multiNodeRouting !== "starting" && brokerMessage.multiNodeRouting !== "on"
            && brokerMessage.multiNodeRouting !== "unavailable")
          || (brokerMessage.extendsSaves !== undefined && brokerMessage.extendsSaves !== true)
          || (brokerMessage.marksEndedChildren !== undefined && brokerMessage.marksEndedChildren !== true)
          || (brokerMessage.wakesEndedChildren !== undefined && brokerMessage.wakesEndedChildren !== true)
          || (brokerMessage.instanceId !== undefined && typeof brokerMessage.instanceId !== "string")
          || (brokerMessage.awaitsSessionId !== undefined && typeof brokerMessage.awaitsSessionId !== "string")
          || (brokerMessage.dropsEndedQueued !== undefined && brokerMessage.dropsEndedQueued !== true)
          || (brokerMessage.enforcesReach !== undefined && brokerMessage.enforcesReach !== true)
          || (brokerMessage.protocol !== undefined && !isBrokerProtocolRange(brokerMessage.protocol as JsonWireValue))) {
          throw new Error("Invalid registered message");
        }
        if (this._sessionId !== null) {
          throw new Error("Received duplicate registered message");
        }
        // #4538: a session that registered unverified on a broker it took for single-machine is refused if the broker
        // that answered routes otherwise, as `register_verified` would have been, before it takes the registration.
        const expected = this.registrationExpectedRouting;
        if (
          expected !== undefined && !expected.verify
          && brokerMessage.multiNodeRouting !== undefined
          && (brokerMessage.multiNodeRouting !== "off") !== expected.acrossMachines
        ) {
          this.emit("_registration_failed", new IntercomRoutingChangedError(expected.acrossMachines));
          break;
        }
        if (this.sentReach !== undefined && brokerMessage.enforcesReach !== true) {
          this.emit("_registration_failed", new IntercomReachUnsupportedError());
          break;
        }
        this._sessionId = brokerMessage.sessionId;
        // #5607: the id it asked for is another registration's for now; the broker gives it back when it can.
        this._awaitedSessionId = typeof brokerMessage.awaitsSessionId === "string" ? brokerMessage.awaitsSessionId : null;
        this._supervisorSessionId = typeof brokerMessage.supervisorSessionId === "string"
          ? brokerMessage.supervisorSessionId
          : null;
        // #3761: a broker from before receipts never echoes the capability and drops a client that sends `received`.
        this.brokerAcknowledgesReceipt = this.acknowledgesReceipt && brokerMessage.acknowledgesReceipt === true;
        // #5145: an outcome heard but not confirmed saved is sent again on this registration, to be saved this time.
        for (const [messageId, heard] of this.heardOutcomes) {
          if (heard === "heard" && this.acknowledgesReceipt) this.heardOutcomes.delete(messageId);
        }
        // The workflow route capabilities a broker advertises (`acknowledgesPendingStageRoutes`, ...) are not read: this
        // client never sends a workflow frame (Atomic 0.10.0 removed workflows).
        this.brokerAnswersStatus = brokerMessage.brokerStatus === true;
        this._multiNodeRouting = brokerMessage.multiNodeRouting as BrokerMultiNodeStatus["status"] | undefined;
        this.brokerExtendsSaves = this.brokerAcknowledgesReceipt && brokerMessage.extendsSaves === true;
        this.brokerMarksEndedChildren = brokerMessage.marksEndedChildren === true;
        this.brokerWakesEndedChildren = this.brokerMarksEndedChildren && brokerMessage.wakesEndedChildren === true;
        this.noteBrokerInstance(typeof brokerMessage.instanceId === "string" ? brokerMessage.instanceId : undefined);
        this.brokerDropsEndedQueued = brokerMessage.dropsEndedQueued === true;
        if (this.brokerDropsEndedQueued) this.dropToldLost();
        this.brokerStampsReleasedChildren = brokerMessage.stampsReleasedChildren === true;
        this._brokerProtocol = protocolRangeOf(brokerMessage.protocol as BrokerProtocolRange | undefined);
        void this.syncReach().catch(() => {});
        this.emit("_registered", { type: "registered", sessionId: brokerMessage.sessionId });
        break;
      }
      case "registration_failed": {
        if (typeof brokerMessage.reason !== "string") throw new Error("Invalid registration_failed message");
        // A coded refusal is classified by construction downstream. A code this client does not know (broker/client
        // version skew) keeps the reason as an ordinary, non-recoverable error.
        const refusal = brokerMessage.code === BROKER_RETIRING_CODE
          ? new IntercomBrokerRetiringError(brokerMessage.reason)
          : brokerMessage.code === BROKER_ROUTING_CHANGED_CODE
          ? new IntercomRoutingChangedError(this.registrationExpectedRouting?.acrossMachines ?? false)
          : brokerMessage.code === SUPERVISOR_AUTHORIZATION_REFUSED_CODE
          ? new IntercomSupervisorAuthorizationRefusedError(brokerMessage.reason)
          : new Error(brokerMessage.reason);
        if (this._sessionId === null) {
          // Still registering: `connect()` owns the failure and its own cleanup.
          this.emit("_registration_failed", refusal);
          break;
        }
        // The broker reuses this frame to refuse an *established* client's request
        // and then ends the socket, deliberately dropping anything already
        // pipelined behind it. By
        // this point `connect()` has removed its `_registration_failed` listener,
        // so emitting there would discard the refusal and leave every pipelined
        // request — notably the `listSessions()` barrier — to expire on its own
        // five-second timer with an unusable diagnostic. Record the refusal as the
        // disconnect cause, settle outstanding work with it, and destroy the socket
        // so no new work is accepted while we wait for the peer FIN. `onClose`
        // still owns session/socket teardown and the `disconnected` emission.
        this.disconnectError ??= refusal;
        this.failPending(this.disconnectError);
        this.socket?.destroy();
        break;
      }
      case "question_target": {
        const { messageId, attemptId, sessionId } = brokerMessage;
        if (typeof messageId !== "string" || typeof attemptId !== "string" || typeof sessionId !== "string") {
          throw new Error("Invalid question_target message");
        }
        const pending = this.pendingReplyTargets.get(attemptId);
        if (pending?.messageId === messageId) pending.bind(sessionId);
        break;
      }
      case "sessions": {
		// A 0.9.x broker also lists workflow stages (`workflowStages`, `workflowFutureStages`); they are not read.
		const { requestId, sessions, restricted } = brokerMessage;
		if (
			typeof requestId !== "string" ||
			!Array.isArray(sessions) ||
			!sessions.every(isSessionInfo) ||
			(restricted !== undefined && restricted !== true)
		) {
			throw new Error("Invalid sessions message");
		}
		const pending = this.pendingLists.get(requestId);
		if (!pending) return;
		this.pendingLists.delete(requestId);
		pending.resolve({ sessions, ...(restricted === true ? { restricted: true as const } : {}) });
		break;
	  }
      case "groups": {
        const { requestId, groups } = brokerMessage;
        if (
          typeof requestId !== "string" ||
          !Array.isArray(groups) ||
          !groups.every((summary) =>
            typeof summary === "object" &&
            summary !== null &&
            typeof summary.group === "string" &&
            typeof summary.sessionCount === "number" &&
            typeof summary.member === "boolean"
          )
        ) {
          throw new Error("Invalid groups message");
        }
        const pending = this.pendingGroupLists.get(requestId);
        if (!pending) return;
        this.pendingGroupLists.delete(requestId);
        pending.resolve(groups as GroupSummary[]);
        break;
      }
      case "broker_status": {
        const { requestId } = brokerMessage;
        const report = brokerMessage.report as JsonWireValue | undefined;
        if (typeof requestId !== "string" || !isBrokerStatusReport(report)) throw new Error("Invalid broker_status message");
        const pending = this.pendingBrokerStatus.get(requestId);
        if (!pending) return;
        this.pendingBrokerStatus.delete(requestId);
        pending.resolve(report);
        break;
      }
      case "supervisor_authorized": {
        const { requestId, capability, supervisorSessionId, childName } = brokerMessage;
        if (typeof requestId !== "string" || typeof capability !== "string"
          || typeof supervisorSessionId !== "string" || typeof childName !== "string") {
          throw new Error("Invalid supervisor_authorized message");
        }
        const pending = this.pendingSupervisorAuthorizations.get(requestId);
        if (!pending) return;
        this.pendingSupervisorAuthorizations.delete(requestId);
        pending.resolve({ capability, supervisorSessionId, childName });
        break;
      }
      case "message": {
        const { from, message, channel, hostedRecipient } = brokerMessage;
        if (
          !isSessionInfo(from) ||
          !isMessage(message) ||
          (channel !== undefined && channel !== "supervisor") ||
          (hostedRecipient !== undefined && typeof hostedRecipient !== "string")
        ) {
          throw new Error("Invalid message event");
        }
        // #4642: a message for a session this connection hosts goes to its own listeners, never to this session's.
        // #5999: the failure, or the reply, of a message queued for a subagent that ended settles it.
        if (message.replyTo !== undefined) this.endedQueue.kept.delete(message.replyTo);
        if (hostedRecipient !== undefined) this.emit("hosted_message", hostedRecipient, from, message, channel);
        else if (this.heardOutcomeAgain(message)) break;
        else this.emit("message", from, message, channel);
        break;
      }
		case "pending_stage_notification": {
			// A 0.9.x broker hands a workflow run's notice to the session it concerns and waits for its answer. This client
			// keeps no workflow state, so it declines the notice at once rather than leaving the broker to time out.
			const { requestId } = brokerMessage;
			if (typeof requestId !== "string") throw new Error("Invalid pending-stage notification event");
			if (this.socket !== null && !this.socket.destroyed) {
				writeMessage(this.socket, { type: "pending_stage_notification_result", requestId, delivered: false });
			}
			break;
		}
      case "queued": {
		const { messageId, attemptId, target, position } = brokerMessage;
        if (
          typeof messageId !== "string" ||
          (attemptId !== undefined && typeof attemptId !== "string") ||
			typeof target !== "string" ||
          typeof position !== "number" ||
          position < 1
        ) {
          throw new Error("Invalid queued message");
        }
		const result = { id: messageId, delivered: false, queued: true, target, position } as const;
        this.noteEndedQueued(messageId, target);
        if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
        else this.pendingSends.resolve(messageId, attemptId, result);
        break;
      }
      case "send_held": {
        const { messageId, attemptId, timeoutMs } = brokerMessage;
        if (
          typeof messageId !== "string" ||
          (attemptId !== undefined && typeof attemptId !== "string") ||
          typeof timeoutMs !== "number" ||
          !Number.isFinite(timeoutMs) ||
          timeoutMs <= 0
        ) {
          throw new Error("Invalid send_held message");
        }
        // #3760: the recipient is a subagent being restored; the broker answers within `timeoutMs`.
        this.pendingSends.extend(messageId, attemptId, timeoutMs + HELD_SEND_GRACE_MS);
        break;
      }
      case "restoring_recipient_wake": {
        const { capability, childName } = brokerMessage;
        if (typeof childName !== "string" || (capability !== undefined && typeof capability !== "string")) {
          throw new Error("Invalid restoring_recipient_wake message");
        }
        // #4326: a send waits at the broker for a released child this session reserved; its owner wakes it.
        this.emit("restoring_recipient_wake", capability === undefined ? { childName } : { childName, capability });
        break;
      }
      case "ended_child_wake": {
        const { childName, childId, wakeId, from, depth } = brokerMessage;
        const waker = from as { id?: unknown; name?: unknown } | undefined;
        if (
          typeof childName !== "string" ||
          (childId !== undefined && typeof childId !== "string") ||
          typeof wakeId !== "string" ||
          typeof waker !== "object" ||
          waker === null ||
          typeof waker.id !== "string" ||
          (waker.name !== undefined && typeof waker.name !== "string") ||
          typeof depth !== "number"
        ) {
          throw new Error("Invalid ended_child_wake message");
        }
        // #5999: a message is queued for a subagent this session reported ended with `wake`; its owner resumes it.
        const notice: EndedChildWakeNotice = {
          childName,
          ...(childId === undefined ? {} : { childId }),
          wakeId,
          from: { id: waker.id, ...(typeof waker.name === "string" ? { name: waker.name } : {}) },
          depth,
        };
        this.emit("ended_child_wake", notice);
        break;
      }
      case "released_child_reply": {
        const { childName, handoffId, replyTo, from, message } = brokerMessage;
        if (
          typeof childName !== "string" ||
          typeof handoffId !== "string" ||
          typeof replyTo !== "string" ||
          !isSessionInfo(from) ||
          !isMessage(message) ||
          message.replyTo !== replyTo
        ) {
          throw new Error("Invalid released_child_reply message");
        }
        const notice: ReleasedChildReply = { childName, handoffId, replyTo, from, message };
        this.emit("released_child_reply", notice);
        break;
      }
      case "hosted_sessions_ack": {
        const { requestId, refusal, sessions } = brokerMessage;
        const parsedRefusal = readHostedSessionRefusal(refusal as JsonWireValue | undefined);
        const assignments = sessions === undefined ? [] : readHostedSessionAssignments(sessions as JsonWireValue);
        if (typeof requestId !== "string" || (refusal !== undefined && parsedRefusal === undefined) || assignments === undefined) {
          throw new Error("Invalid hosted_sessions_ack message");
        }
        const pending = this.pendingHostedSessionRequests.get(requestId);
        if (!pending) return;
        this.pendingHostedSessionRequests.delete(requestId);
        if (parsedRefusal === undefined) pending.resolve(assignments);
        else pending.reject(hostedSessionErrorFor(parsedRefusal));
        break;
      }
      case "released_children_ack": {
        const { requestId, refusal, published } = brokerMessage;
        const parsed = refusal === undefined ? undefined : readReleasedChildRefusal(refusal);
        if (
          typeof requestId !== "string" ||
          (refusal !== undefined && parsed === undefined) ||
          (published !== undefined && typeof published !== "boolean")
        ) {
          throw new Error("Invalid released_children_ack message");
        }
        const pending = this.pendingRestoringRecipientRequests.get(requestId);
        if (!pending) return;
        this.pendingRestoringRecipientRequests.delete(requestId);
        const error = parsed === undefined ? undefined : releasedChildErrorFor(parsed);
        if (pending.observe && this._sessionId !== null) {
          const stamp = brokerMessage.releaseStamp as { broker?: unknown; order?: unknown } | undefined;
          if (stamp && typeof stamp.broker === "string" && typeof stamp.order === "number" &&
              Number.isSafeInteger(stamp.order) && stamp.order > 0) {
            this.releaseRegistration ??= randomUUID();
            pending.observe({ broker: stamp.broker, order: stamp.order, owner: this._sessionId, registration: this.releaseRegistration }, error);
          }
        }
        if (error === undefined) pending.resolve(pending.verify ? brokerMessage.current === true : published !== false);
        else pending.reject(error);
        break;
      }
      case "restoring_recipient_ack": {
        const { requestId, error, published } = brokerMessage;
        if (
          typeof requestId !== "string" ||
          (error !== undefined && typeof error !== "string") ||
          (published !== undefined && typeof published !== "boolean")
        ) {
          throw new Error("Invalid restoring_recipient_ack message");
        }
        const pending = this.pendingRestoringRecipientRequests.get(requestId);
        if (!pending) return;
        this.pendingRestoringRecipientRequests.delete(requestId);
        if (error === undefined) pending.resolve(!pending.verify && published !== false);
        else pending.reject(new Error(error));
        break;
      }
      case "delivered": {
        const { messageId, attemptId } = brokerMessage;
        if (typeof messageId !== "string" || (attemptId !== undefined && typeof attemptId !== "string")) {
          throw new Error("Invalid delivered message");
        }
        const result = { id: messageId, delivered: true } as const;
        // #5999: a message queued for a subagent that ended reached it.
        this.endedQueue.kept.delete(messageId);
        if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
        else this.pendingSends.resolve(messageId, attemptId, result);
        break;
      }
      case "delivery_failed": {
		const { messageId, attemptId, reason, reasonCode } = brokerMessage;
		const wireError = brokerMessage.error as JsonWireValue | undefined;
		const releasedReplyError = readSerializedIntercomReleasedReplyError(wireError);
		const hostedSessionError = readSerializedIntercomHostedSessionError(wireError);
		const error = releasedReplyError ?? hostedSessionError;
		const wireRecipientError = brokerMessage.recipientError as JsonWireValue | undefined;
		// A 0.9.x broker's `recipient_stage_released`, for a released workflow stage (Atomic 0.10.0 removed workflows), is
		// not read: its `reason` already says what it does.
		const legacyStageReleased =
			typeof wireRecipientError === "object" &&
			wireRecipientError !== null &&
			!Array.isArray(wireRecipientError) &&
			wireRecipientError.code === "recipient_stage_released";
		const recipientError = legacyStageReleased ? undefined : readSerializedIntercomRecipientGoneError(wireRecipientError);
		if (
			typeof messageId !== "string" ||
			(attemptId !== undefined && typeof attemptId !== "string") ||
			typeof reason !== "string" ||
			(reasonCode !== undefined && (typeof reasonCode !== "string" || !isDeliveryFailureReasonCode(reasonCode))) ||
			(wireError !== undefined && (error === undefined || error.code !== reasonCode)) ||
			// A valid released-reply `error` always comes with its `reasonCode`, so this also refuses carrying both errors.
			(wireRecipientError !== undefined && !legacyStageReleased && (recipientError === undefined || reasonCode !== undefined))
		) {
			throw new Error("Invalid delivery_failed message");
		}
		// #4997, #5101: carried apart from the wire `reasonCode`, so older clients, which validate it, are not refused it.
		const routeUnavailable = brokerMessage.routeUnavailable === true && reasonCode === undefined;
		const result: SendResult = {
			id: messageId,
			delivered: false,
			reason,
			...(reasonCode === undefined ? {} : { reasonCode }),
			...(routeUnavailable ? { reasonCode: "route_unavailable" as const } : {}),
			...(releasedReplyError === undefined ? {} : { error: rehydrateIntercomReleasedReplyError(releasedReplyError) }),
			...(hostedSessionError === undefined ? {} : { error: rehydrateIntercomHostedSessionError(hostedSessionError) }),
			...(recipientError === undefined
				? {}
				: { reasonCode: recipientError.code, error: rehydrateIntercomRecipientGoneError(recipientError) }),
		};
		if (attemptId === undefined) this.pendingSends.resolveLegacy(messageId, result);
		else this.pendingSends.resolve(messageId, attemptId, result);
		break;
      }
      case "session_joined": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid session_joined message");
        }
        this.emit("session_joined", brokerMessage.session);
        break;
      }
      case "session_left": {
        if (typeof brokerMessage.sessionId !== "string") {
          throw new Error("Invalid session_left message");
        }
        this.emit("session_left", brokerMessage.sessionId);
        break;
      }
      case "presence_update": {
        if (!isSessionInfo(brokerMessage.session)) {
          throw new Error("Invalid presence_update message");
        }
        this.emit("presence_update", brokerMessage.session);
        break;
      }
      case "presence_ack": {
        if (typeof brokerMessage.requestId !== "string" || typeof brokerMessage.group !== "string") {
          throw new Error("Invalid presence_ack message");
        }
        const pending = this.pendingPresence.get(brokerMessage.requestId);
        if (!pending) return;
        this.pendingPresence.delete(brokerMessage.requestId);
        this._groups = pending.groups === undefined
          ? normalizeGroups(undefined, brokerMessage.group)
          : normalizeGroups(pending.groups);
        pending.resolve(brokerMessage.group);
        break;
      }
      case "reach_ack": {
        const { requestId, groups, reachable } = brokerMessage;
        if (
          typeof requestId !== "string" ||
          !Array.isArray(groups) ||
          !groups.every((group) => typeof group === "string") ||
          !Array.isArray(reachable) ||
          !reachable.every((group) => typeof group === "string")
        ) {
          throw new Error("Invalid reach_ack message");
        }
        const pending = this.pendingReach.get(requestId);
        if (!pending) return;
        this.pendingReach.delete(requestId);
        this._groups = normalizeGroups(groups);
        pending.resolve();
        break;
      }
      case "reach_failed": {
        if (typeof brokerMessage.requestId !== "string" || typeof brokerMessage.reason !== "string") {
          throw new Error("Invalid reach_failed message");
        }
        const pending = this.pendingReach.get(brokerMessage.requestId);
        if (!pending) return;
        this.pendingReach.delete(brokerMessage.requestId);
        pending.reject(new Error(brokerMessage.reason));
        break;
      }
      case "membership_ack": {
        const { requestId, groups } = brokerMessage;
        if (typeof requestId !== "string" || !Array.isArray(groups) || !groups.every((group) => typeof group === "string")) {
          throw new Error("Invalid membership_ack message");
        }
        const pending = this.pendingMemberships.get(requestId);
        if (!pending) return;
        this.pendingMemberships.delete(requestId);
        const normalizedGroups = [...normalizeGroups(groups)];
        this._groups = new Set(normalizedGroups);
        pending.resolve(normalizedGroups);
        break;
      }
      case "presence_failed": {
        if (typeof brokerMessage.requestId !== "string" || typeof brokerMessage.reason !== "string") {
          throw new Error("Invalid presence_failed message");
        }
        const presence = this.pendingPresence.get(brokerMessage.requestId);
        if (presence) {
          this.pendingPresence.delete(brokerMessage.requestId);
          presence.reject(new Error(brokerMessage.reason));
          break;
        }
        const membership = this.pendingMemberships.get(brokerMessage.requestId);
        if (!membership) return;
        this.pendingMemberships.delete(brokerMessage.requestId);
        membership.reject(new Error(brokerMessage.reason));
        break;
      }
      case "peer_disconnected": {
        const { replyTo, peerSessionId, peerName } = brokerMessage;
        if (typeof replyTo !== "string" || typeof peerSessionId !== "string"
          || (peerName !== undefined && typeof peerName !== "string")) {
          throw new Error("Invalid peer_disconnected message");
        }
        this.emit("peer_disconnected", {
          replyTo,
          peerSessionId,
          ...(peerName !== undefined ? { peerName } : {}),
        });
        break;
      }
      case "id_handoff": {
        // #5607: the id this session awaited is held for it; it takes it by registering again with this hand-over.
        const { sessionId, handoff } = brokerMessage;
        if (typeof sessionId !== "string" || typeof handoff !== "string") throw new Error("Invalid id_handoff message");
        const idHandoff: IntercomIdHandoff = { sessionId, handoff };
        this.emit("id_handoff", idHandoff);
        break;
      }
      case "peer_rebound": {
        const { replyTo, previousSessionId, sessionId } = brokerMessage;
        if (typeof replyTo !== "string" || typeof previousSessionId !== "string" || typeof sessionId !== "string") {
          throw new Error("Invalid peer_rebound message");
        }
        this.emit("peer_rebound", { replyTo, previousSessionId, sessionId });
        break;
      }
      case "error": {
        if (typeof brokerMessage.error !== "string") {
          throw new Error("Invalid error message");
        }
        this.emit("error", new Error(brokerMessage.error));
        break;
      }
      default:
        if (LEGACY_WORKFLOW_BROKER_FRAME_TYPES.has(brokerMessage.type)) break;
        throw new Error(`Unknown broker message type: ${brokerMessage.type}`);
    }
  }
  /** `resumable`: this session can be resumed later, so the asks it sent or was sent stay pending (#4751). */
  async disconnect(options: { readonly resumable?: boolean } = {}): Promise<void> {
    // A connect still in progress (or waiting to retry) is cancelled: it closes any socket it opened and never
    // registers (#3904).
    if (this.connectAttempt !== undefined && this._sessionId === null) {
      this.connectAttempt.abort();
      return;
    }
    const socket = this.socket;
    if (!socket) {
      return;
    }
    this.disconnecting = true;
    this.disconnectError = null;
    this.failPending(new IntercomClientDisconnectedError());
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        socket.off("close", onClose);
        socket.off("error", onError);
        resolve();
      };
      const onClose = () => finish();
      const onError = () => {
        socket.destroy();
      };
      const timeout = setTimeout(() => {
        socket.destroy();
      }, 2000);
      socket.once("close", onClose);
      socket.once("error", onError);
      try {
        writeMessage(socket, { type: "unregister", ...(options.resumable === true ? { resumable: true as const } : {}) });
        socket.end();
      } catch {
        // Disconnect should still finish even if the unregister write fails.
        socket.destroy();
      }
    });
  }
  async listSessions(group?: string): Promise<SessionInfo[]> {
	return (await this.listDirectory(group)).sessions;
  }

  listDirectory(group?: string): Promise<SessionDirectory> {
	let socket: net.Socket;
	try {
		socket = this.requireActiveSocket();
	} catch (error) {
		return Promise.reject(toError(error));
	}
	return new Promise((resolve, reject) => {
		const requestId = randomUUID();
		const timeout = setTimeout(() => {
			if (!this.pendingLists.delete(requestId)) return;
			void this.requestTimeout(socket, new Error("List sessions timeout")).then(reject);
		}, 5000);
		this.pendingLists.set(requestId, {
			resolve: (directory) => {
				clearTimeout(timeout);
				resolve(directory);
			},
			reject: (error) => {
				clearTimeout(timeout);
				reject(error);
			},
		});
		try {
			writeMessage(socket, group === undefined ? { type: "list", requestId } : { type: "list", requestId, group });
		} catch (error) {
			clearTimeout(timeout);
			this.pendingLists.delete(requestId);
			reject(toError(error));
		}
	});
  }
  listGroups(): Promise<GroupSummary[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingGroupLists.delete(requestId)) return;
        void this.requestTimeout(socket, new Error("List groups timeout")).then(reject);
      }, GROUP_REQUEST_TIMEOUT_MS);
      this.pendingGroupLists.set(requestId, {
        resolve: (groups) => { clearTimeout(timeout); resolve(groups); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, { type: "list_groups", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingGroupLists.delete(requestId);
        reject(toError(error));
      }
    });
  }

  /** The broker's own status, including multi-node routing; `undefined` from a broker older than `broker_status`. */
  brokerStatus(): Promise<BrokerStatusReport | undefined> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    if (!this.brokerAnswersStatus) return Promise.resolve(undefined);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingBrokerStatus.delete(requestId)) return;
        reject(new Error("Broker status timeout"));
      }, GROUP_REQUEST_TIMEOUT_MS);
      this.pendingBrokerStatus.set(requestId, {
        resolve: (report) => { clearTimeout(timeout); resolve(report); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, { type: "broker_status", requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingBrokerStatus.delete(requestId);
        reject(toError(error));
      }
    });
  }

  syncReach(): Promise<void> {
    const reach = this.reachSource?.();
    const sent = this.sentReach;
    if (reach === undefined || sent === undefined || !this._sessionId || sameReachPolicy(sent, reach)) return Promise.resolve();
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch {
      return Promise.resolve();
    }
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingReach.delete(requestId)) return;
        void this.requestTimeout(socket, new Error("Reach update timeout")).then(reject);
      }, GROUP_REQUEST_TIMEOUT_MS);
      this.pendingReach.set(requestId, {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, { type: "set_reach", requestId, reachable: [...reach.reachable] });
        this.sentReach = reach;
        this._groups = new Set(narrowMemberships(reach, [...this._groups]));
      } catch (error) {
        clearTimeout(timeout);
        this.pendingReach.delete(requestId);
        reject(toError(error));
      }
    });
  }

  joinGroup(group: string): Promise<string[]> {
    return this.updateMembership("join_group", group);
  }

  leaveGroup(group?: string): Promise<string[]> {
    return this.updateMembership("leave_group", group);
  }

  private updateMembership(type: "join_group" | "leave_group", group?: string): Promise<string[]> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingMemberships.delete(requestId)) return;
        void this.requestTimeout(socket, new Error("Membership update timeout")).then(reject);
      }, GROUP_REQUEST_TIMEOUT_MS);
      this.pendingMemberships.set(requestId, {
        resolve: (groups) => { clearTimeout(timeout); resolve(groups); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, group === undefined ? { type, requestId } : { type, requestId, group });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingMemberships.delete(requestId);
        reject(toError(error));
      }
    });
  }


  authorizeSupervisorChild(childName: string, capability?: string): Promise<SupervisorAuthorization> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const normalizedChildName = childName.trim();
    if (!normalizedChildName) return Promise.reject(new Error("Child session name is required"));
    return new Promise((resolve, reject) => {
      const requestId = randomUUID();
      const timeout = setTimeout(() => {
        if (!this.pendingSupervisorAuthorizations.delete(requestId)) return;
        void this.requestTimeout(socket, new SupervisorAuthorizationTimeoutError()).then(reject);
      }, 5000);
      this.pendingSupervisorAuthorizations.set(requestId, {
        resolve: (authorization) => { clearTimeout(timeout); resolve(authorization); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, capability
          ? { type: "authorize_supervisor", requestId, childName: normalizedChildName, capability }
          : { type: "authorize_supervisor", requestId, childName: normalizedChildName });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingSupervisorAuthorizations.delete(requestId);
        reject(toError(error));
      }
    });
  }

  /**
   * #3760: hold sends to the child that `capability` (issued to this session by `authorizeSupervisorChild`)
   * names, and to its `aliases`, until the child registers with that capability. Calling again adds aliases.
   * A `dormant` hold keeps the child addressable until the supervisor that restores it takes the hold over.
   * #5352: with multi-node routing, `published` is false when the hold is in force on this broker but brokers on other
   * hosts could not find it yet: the broker keeps publishing it until it can, or until the hold ends.
   */
  async reserveRestoringRecipient(
    capability: string,
    options: { group?: string; aliases?: readonly string[]; dormant?: boolean; holdMs?: number } = {},
  ): Promise<{ readonly published: boolean }> {
    const published = await this.restoringRecipientRequest({
      type: "reserve_restoring_recipient",
      capability,
      ...(options.group === undefined ? {} : { group: options.group }),
      ...(options.aliases === undefined ? {} : { aliases: [...options.aliases] }),
      ...(options.dormant === true ? { dormant: true } : {}),
      ...(options.holdMs === undefined ? {} : { holdMs: options.holdMs }),
    });
    return { published };
  }

  /**
   * #3760: end that hold. With `gone` (the reason), held and later senders are told the child is gone. With
   * `refusal`, the senders held now are told that reason and later sends are routed normally. With neither,
   * held sends are routed normally.
   */
  releaseRestoringRecipient(capability: string, outcome?: string | { gone?: string; refusal?: string }): Promise<void> {
    const { gone, refusal } = typeof outcome === "string" ? { gone: outcome, refusal: undefined } : (outcome ?? {});
    return this.restoringRecipientRequest({
      type: "release_restoring_recipient",
      capability,
      ...(gone === undefined ? {} : { gone }),
      ...(refusal === undefined ? {} : { refusal }),
    }).then(() => undefined);
  }

  /**
   * #4326: reserve released subagents by child name for this connection, which becomes their owner: sends to
   * them are held, and the first one held asks this session to wake the child when `wake` is true. Children go in
   * frames of at most 500. Every item is validated before any frame is sent; an invalid item fails the call with a
   * `ReleasedChildReservationError` naming its child, and reserves nothing from its frame or any later one. The
   * broker refuses a whole frame the same way, with `not_owner` when another session owns one of its children.
   * Reserving a child again replaces its aliases, group and wake flag and keeps the sends held for it.
   */
  async reserveReleasedChildren(children: readonly ReleasedChildReservation[]): Promise<void> {
    this.requireBrokerProtocol("reserve_released_children");
    let observations: Map<object, ReleaseObservation> | undefined;
    const wireChildren = children.map((child) => {
      const wire = {
        childName: child.childName,
        ...(child.group === undefined ? {} : { group: child.group }),
        ...(child.aliases === undefined ? {} : { aliases: [...child.aliases] }),
        wake: child.wake,
      };
      const receipt = wire.wake ? releaseObservation(child) : undefined;
      if (receipt && receipt.childName === wire.childName) {
        observations ??= new Map();
        observations.set(wire, receipt);
      }
      return wire;
    });
    const frames: (typeof wireChildren)[] = [];
    for (let start = 0; start < wireChildren.length; start += RELEASED_CHILD_FRAME_MAX) {
      const frame = wireChildren.slice(start, start + RELEASED_CHILD_FRAME_MAX);
      const validation = validateReleasedChildFrame(frame);
      if (!validation.ok) throw new ReleasedChildReservationError(validation.refusal);
      frames.push(frame);
    }
    for (const frame of frames) {
      const receipts = observations && frame.flatMap((child) => {
        const receipt = observations?.get(child);
        return receipt ? [receipt] : [];
      });
      await this.restoringRecipientRequest({ type: "reserve_released_children", children: frame }, !receipts?.length ? undefined : (stamp, error) => {
        if (error) return;
        const verify = this.liveReleaseVerifier();
        for (const receipt of receipts) receipt.repair = { stamp, verify };
      });
    }
  }

  /** A saved receipt must not keep this client alive or run a new frame on a replacement connection. */
  private liveReleaseVerifier(): WeakRef<VerifyRelease> {
    if (!this.verifyRelease) {
      const socket = this.socket;
      this.verifyRelease = (childName, { broker, order }, signal) => {
        if (signal.aborted || socket === null || this.socket !== socket || socket.destroyed || this.disconnecting) return Promise.resolve(false);
        const requestId = randomUUID();
        return new Promise<boolean>((resolve) => {
          const finish = (current = false) => {
            this.pendingRestoringRecipientRequests.delete(requestId);
            clearTimeout(timeout);
            signal.removeEventListener("abort", cancel);
            resolve(current);
          };
          const cancel = () => finish(false);
          // A diagnostic must not keep an owner waiting, ping the broker, or tear down a working connection.
          const timeout = setTimeout(cancel, RESTORING_RECIPIENT_REQUEST_TIMEOUT_MS);
          signal.addEventListener("abort", cancel, { once: true });
          this.pendingRestoringRecipientRequests.set(requestId, { verify: true, resolve: finish, reject: cancel });
          try { writeMessage(socket, { type: "verify_released_child", childName, broker, order, requestId }); }
          catch { cancel(); }
        });
      };
    }
    return new WeakRef(this.verifyRelease);
  }

  /**
   * #4326: end this connection's reservations for these child names, in frames of at most 500. `gone` and
   * `refusal` behave as they do for `releaseRestoringRecipient`. A child nobody reserved is skipped; a frame naming
   * a child another session owns fails with a `not_owner` `ReleasedChildReservationError` and drops nothing.
   */
  async dropReleasedChildren(childNames: readonly string[], outcome: { gone?: string; refusal?: string } = {}): Promise<void> {
    this.requireBrokerProtocol("drop_released_children");
    for (let start = 0; start < childNames.length; start += RELEASED_CHILD_FRAME_MAX) {
      await this.restoringRecipientRequest({
        type: "drop_released_children",
        childNames: childNames.slice(start, start + RELEASED_CHILD_FRAME_MAX),
        ...(outcome.gone === undefined ? {} : { gone: outcome.gone }),
        ...(outcome.refusal === undefined ? {} : { refusal: outcome.refusal }),
      });
    }
  }

  /**
   * #4639: report how subagents this session launched ended, in frames of at most 500, so a send to one that has no
   * live session is refused with why and the next step instead of `Session not found`. The broker keeps each report on
   * this connection until the subagent registers again or this session disconnects; report again after a reconnect.
   * Resolves without sending anything to a broker that does not advertise `marksEndedChildren`. Fails with a
   * `ReleasedChildReservationError` naming the first invalid child, or `not_owner` when another session owns one.
   */
  async markEndedChildren(children: readonly EndedChildReport[]): Promise<void> {
    if (!this.brokerMarksEndedChildren) return;
    // Fields left undefined are not written: the frame carries what each report names, nothing else.
    const wireChildren = children.map((child) => ({
      childName: child.childName,
      group: child.group,
      aliases: child.aliases,
      outcome: child.outcome,
      childId: child.childId,
      // #5999: offered only to a broker that wakes ended children; an older one is told nothing new.
      ...(this.brokerWakesEndedChildren && child.messages !== undefined && child.outcome !== "cancelled"
        ? { messages: child.messages }
        : {}),
    }));
    for (let start = 0; start < wireChildren.length; start += RELEASED_CHILD_FRAME_MAX) {
      await this.restoringRecipientRequest({
        type: "mark_ended_children",
        children: wireChildren.slice(start, start + RELEASED_CHILD_FRAME_MAX),
      });
    }
  }

  /**
   * #4326: confirm this session is waking `childName`: the broker lengthens the hold of every send waiting for it,
   * once per wake, up to 120 seconds from each send's admission. Fails with `UnknownReleasedChildError` when no
   * session holds a reservation for the child, and with a `not_owner` `ReleasedChildReservationError` when another
   * session owns it.
   */
  acknowledgeReleasedChildWake(childName: string, occurrence?: object): Promise<void> {
    try {
      this.requireBrokerProtocol("acknowledge_released_child_wake");
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const receipt = occurrence && releaseObservation(occurrence);
    return this.restoringRecipientRequest({ type: "acknowledge_released_child_wake", childName }, receipt?.childName === childName ? (stamp, error) => {
      if (error) receipt.refusal = { error: new WeakRef(error), stamp };
    } : undefined).then(() => undefined);
  }

  /** #5999: keep a message the broker queued for a subagent that ended, until it reaches it or fails. */
  private noteEndedQueued(messageId: string, target: string): void {
    const queue = target === RESUMING_RECIPIENT_TARGET ? "resuming" : target === PAUSED_RECIPIENT_TARGET ? "paused" : undefined;
    const sent = this.wakeSends.get(messageId);
    if (queue === undefined || sent === undefined) return;
    const now = Date.now();
    for (const [id, kept] of this.endedQueue.kept) if (expiredHere(kept, now)) this.endedQueue.kept.delete(id);
    this.endedQueue.kept.delete(messageId);
    this.endedQueue.kept.set(messageId, {
      ...sent,
      messageId,
      queue,
      at: now,
      ...(this.brokerDropsEndedQueued ? { durable: true as const } : {}),
    });
    while (this.endedQueue.kept.size > ENDED_QUEUED_MAX) this.endedQueue.kept.delete(this.endedQueue.kept.keys().next().value as string);
  }

  /**
   * #5999: this registration's broker is `instanceId`. Messages the previous broker queued for subagents that ended were
   * lost with it when another broker answers now (or one that does not say which it is): they are given up as lost
   * (`ended_queue_lost`), so each still has one outcome.
   */
  private noteBrokerInstance(instanceId: string | undefined): void {
    const previous = this.endedQueue.brokerInstanceId;
    this.endedQueue.brokerInstanceId = instanceId;
    if (previous === undefined || previous === instanceId || this.endedQueue.kept.size === 0) return;
    const now = Date.now();
    const lost = [...this.endedQueue.kept.values()]
      .filter((kept) => !expiredHere(kept, now))
      .map(({ at: _at, durable: _durable, ...message }) => message);
    this.endedQueue.kept.clear();
    for (const message of lost) {
      this.endedQueue.toldLost.delete(message.messageId);
      this.endedQueue.toldLost.set(message.messageId, previous);
    }
    while (this.endedQueue.toldLost.size > ENDED_QUEUED_MAX)
      this.endedQueue.toldLost.delete(this.endedQueue.toldLost.keys().next().value as string);
    if (lost.length > 0) this.emit("ended_queue_lost", lost);
  }

  /**
   * Durable wake queue: this registration's broker keeps what an earlier one kept (an older broker served in between,
   * which kept nothing, and this session was told those messages were lost): it drops the ones this session was told were
   * lost, so none of them is delivered after all.
   */
  private dropToldLost(): void {
    const keeper = this.endedQueue.brokerInstanceId;
    if (keeper === undefined || this.socket === null) return;
    const messageIds = [...this.endedQueue.toldLost].filter(([, keptBy]) => keptBy === keeper).map(([id]) => id);
    if (messageIds.length === 0) return;
    for (const id of messageIds) this.endedQueue.toldLost.delete(id);
    writeMessage(this.socket, { type: "drop_ended_queued", messageIds });
  }

  /** #5999: whether the broker of the current registration wakes ended children for a send that asks it. */
  get wakesEndedChildren(): boolean {
    return this.brokerWakesEndedChildren;
  }

  /**
   * #5999: answer an `ended_child_wake`: this session is resuming the child (`accepted`), or is not, for `reason`; the
   * messages queued for it then fail with that reason. False when nothing was written: no broker of this registration
   * asked (it does not wake ended children) or the connection is gone, and the wake then ends at the broker's bound.
   */
  answerEndedChildWake(childName: string, wakeId: string, accepted: boolean, reason?: string): boolean {
    if (!this.brokerWakesEndedChildren || !this.socket || this.socket.destroyed) return false;
    writeMessage(this.socket, {
      type: "answer_ended_child_wake",
      childName,
      wakeId,
      accepted,
      ...(reason === undefined ? {} : { reason }),
    });
    return true;
  }

  acknowledgeReleasedChildReply(reply: ReleasedChildReply, accepted: boolean, deliverToChild = false): boolean {
    if (!this.socket || this.socket.destroyed) return false;
    this.requireBrokerProtocol("released_child_reply_ack");
    writeMessage(this.socket, {
      type: "released_child_reply_ack",
      messageId: reply.message.id,
      handoffId: reply.handoffId,
      accepted,
      ...(deliverToChild ? { deliverToChild: true as const } : {}),
    });
    return true;
  }

  /**
   * #4538: refuse, before anything is sent, a request of protocol 2 to the broker of protocol 1 this client registered
   * with, which would end the connection with a protocol error over a frame type it does not know. Without a
   * registration the request fails as it always did, as not connected.
   */
  private requireBrokerProtocol(feature: string, requiredProtocol = VERIFIED_REGISTRATION_PROTOCOL): void {
    const broker = this._brokerProtocol;
    if (this._sessionId === null || broker.max >= requiredProtocol) return;
    throw new IntercomBrokerProtocolError({
      feature,
      brokerProtocolMin: broker.min,
      brokerProtocolMax: broker.max,
      requiredProtocol,
    });
  }

  /**
   * #4642: host sessions on this connection, in frames of at most 500. Each is listed and addressed like a connected
   * session; messages for it arrive as `hosted_message` (recipient id, sender, message, channel), and
   * `send(..., { hostedSender })` sends as it. They leave when `unhostSessions` removes them or this connection
   * closes. Every item is validated before any frame is sent: an invalid one fails the call with a
   * `HostedSessionRequestError` naming its key and hosts nothing from its frame or any later one. Resolves with each
   * key's broker id. Needs a broker of protocol 3.
   */
  async hostSessions(sessions: readonly HostedSessionFrameItem[]): Promise<HostedSessionAssignment[]> {
    this.requireBrokerProtocol("host_sessions", HOSTED_SESSIONS_PROTOCOL);
    const frames: HostedSessionFrameItem[][] = [];
    for (let start = 0; start < sessions.length; start += HOSTED_SESSION_FRAME_MAX) {
      const frame = sessions.slice(start, start + HOSTED_SESSION_FRAME_MAX);
      // Validated exactly as the broker reads it: what JSON keeps of the frame.
      const wire: JsonWireValue = JSON.parse(JSON.stringify(frame));
      const validation = validateHostSessionsFrame(wire);
      if (!validation.ok) throw hostedSessionErrorFor(validation.refusal);
      frames.push(frame);
    }
    const assigned: HostedSessionAssignment[] = [];
    for (const frame of frames) assigned.push(...(await this.hostedSessionRequest({ type: "host_sessions", sessions: frame })));
    return assigned;
  }

  /**
   * #4642: remove sessions this connection hosts, in frames of at most 500. A frame naming a session this connection
   * does not host fails with `NotHostedSessionError` and removes nothing from that frame.
   */
  async unhostSessions(sessionIds: readonly string[]): Promise<void> {
    this.requireBrokerProtocol("unhost_sessions", HOSTED_SESSIONS_PROTOCOL);
    if (sessionIds.length === 0) throw new HostedSessionRequestError("invalid_hosted_frame");
    for (let start = 0; start < sessionIds.length; start += HOSTED_SESSION_FRAME_MAX) {
      await this.hostedSessionRequest({
        type: "unhost_sessions",
        sessionIds: sessionIds.slice(start, start + HOSTED_SESSION_FRAME_MAX),
      });
    }
  }

  /** Its callers are async: a connection that is not active rejects their promise. */
  private hostedSessionRequest(frame: Record<string, unknown>): Promise<HostedSessionAssignment[]> {
    const socket = this.requireActiveSocket();
    const requestId = randomUUID();
    const startedAt = performance.now();
    return new Promise((resolve, reject) => {
      // Every other way the request settles clears this timer, so it only ever finds the request still pending.
      const timeout = setTimeout(() => {
        this.pendingHostedSessionRequests.delete(requestId);
        const timedOut: IntercomHostedSessionTimeoutFields = {
          requestType: frame.type === "unhost_sessions" ? "unhost_sessions" : "host_sessions",
          sessionCount: Array.isArray(frame.sessions) ? frame.sessions.length : Array.isArray(frame.sessionIds) ? frame.sessionIds.length : 0,
          timeoutMs: RESTORING_RECIPIENT_REQUEST_TIMEOUT_MS,
          elapsedMs: Math.round(performance.now() - startedAt),
        };
        void this.requestTimeout(socket, new IntercomHostedSessionTimeoutError(timedOut)).then((error) =>
          reject(
            error instanceof IntercomBrokerTimeoutError && !(error instanceof IntercomHostedSessionTimeoutError)
              ? new IntercomHostedSessionTimeoutError(timedOut, { cause: error })
              : error,
          ),
        );
      }, RESTORING_RECIPIENT_REQUEST_TIMEOUT_MS);
      this.pendingHostedSessionRequests.set(requestId, {
        resolve: (sessions) => {
          clearTimeout(timeout);
          resolve([...sessions]);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
      try {
        writeMessage(socket, { ...frame, requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingHostedSessionRequests.delete(requestId);
        reject(toError(error));
      }
    });
  }

  /** Resolves false when the broker reserved with `published: false` (#5352), true for every other success. */
  private restoringRecipientRequest(frame: Record<string, unknown>, observe?: ObserveReleaseReply): Promise<boolean> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    // The confirmation and reservation keep their original wire bytes unless this particular broker offered stamps.
    const receipt = this.brokerStampsReleasedChildren ? observe : undefined;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pendingRestoringRecipientRequests.delete(requestId)) return;
        void this.requestTimeout(socket, new Error("Restoring-recipient request timeout")).then(reject);
      }, RESTORING_RECIPIENT_REQUEST_TIMEOUT_MS);
      this.pendingRestoringRecipientRequests.set(requestId, {
        observe: receipt,
        resolve: (published = true) => { clearTimeout(timeout); resolve(published); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      });
      try {
        writeMessage(socket, { ...frame, requestId, ...(receipt ? { releaseStamp: true } : {}) });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingRestoringRecipientRequests.delete(requestId);
        reject(toError(error));
      }
    });
  }
  send(to: string, options: SendOptions): Promise<SendResult> {
    return this.sendFrame("send", to, options);
  }

	/**
	 * #3761: tell the broker this message is saved, so it reports `delivered` to its sender. A no-op unless the
	 * current registration's broker echoed the capability: that broker already reported `delivered` on the socket write.
	 */
	acknowledgeReceived(messageId: string, paused = false): void {
		if (!this.brokerAcknowledgesReceipt) return;
		if (this.heardOutcomes.has(messageId)) this.heardOutcomes.set(messageId, "saved");
		// #5999: a subagent whose turn its user paused keeps the message for when it is continued; its sender hears so.
		writeMessage(this.requireActiveSocket(), { type: "received", messageId, ...(paused ? { paused: true as const } : {}) });
	}

	/**
	 * #5145: whether `message` is an outcome this client already heard, so it is not heard twice. A copy of one already
	 * saved is confirmed again, so the broker that sent it stops holding it.
	 */
	private heardOutcomeAgain(message: Message): boolean {
		if (message.replyTo === undefined) return false;
		const heard = this.heardOutcomes.get(message.id);
		if (heard === undefined) {
			this.heardOutcomes.set(message.id, "heard");
			for (const oldest of this.heardOutcomes.keys()) {
				if (this.heardOutcomes.size <= HEARD_OUTCOMES_MAX) break;
				this.heardOutcomes.delete(oldest);
			}
			return false;
		}
		if (heard === "saved") this.acknowledgeReceived(message.id);
		return true;
	}

	/**
	 * #3983: tell the broker this message is still being saved, so its sender keeps waiting instead of hearing the
	 * outcome is uncertain. A no-op on a broker that did not advertise `extendsSaves`, or while disconnected.
	 */
	reportSaving(messageId: string): void {
		if (!this.brokerExtendsSaves || !this.socket || this.socket.destroyed) return;
		writeMessage(this.socket, { type: "saving", messageId });
	}

  sendToSupervisor(to: string, options: SendOptions): Promise<SendResult> {
    return this.sendFrame("supervisor_send", to, options);
  }

	private sendFrame(type: "send" | "supervisor_send", to: string, options: SendOptions): Promise<SendResult> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const messageId = options.messageId ?? randomUUID();
    let acquired;
    try {
		const pendingSignature = JSON.stringify({
			transportTarget: to,
			logicalSignature: buildSendSignature(options.logicalTarget ?? to, options),
			requirePendingReply: options.requirePendingReply ?? false,
			...(options.expectedRecipientId === undefined ? {} : { expectedRecipientId: options.expectedRecipientId }),
		});
		acquired = this.pendingSends.acquire(messageId, pendingSignature, SEND_RESPONSE_TIMEOUT_MS);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    let result = this.sendResults.get(acquired.attempt.promise);
    if (result === undefined) {
      result = acquired.attempt.promise.catch(async (error: Error) => {
        if (error instanceof PendingSendTimeoutError) {
          try {
            throw await this.requestTimeout(socket, error);
          } finally {
            this.pendingSends.release(acquired.attempt);
          }
        }
        throw error;
      });
      this.sendResults.set(acquired.attempt.promise, result);
    }
    if (!acquired.owner) return result;
    const message: Message = {
      id: messageId,
      timestamp: Date.now(),
      replyTo: options.replyTo,
      expectsReply: options.expectsReply,
      ...(options.delivery === undefined || options.delivery === "steer" ? {} : { delivery: options.delivery }),
      replyError: options.replyError,
      ...(options.broadcastId === undefined ? {} : { broadcastId: options.broadcastId }),
      source: this._messageSource,
      content: {
        text: options.text,
        attachments: options.attachments,
        ...(options.displayRanges === undefined ? {} : { displayRanges: options.displayRanges }),
      },
    };
    if (options.onReplyTarget !== undefined) {
      this.pendingReplyTargets.set(acquired.attempt.attemptId, { messageId, bind: options.onReplyTarget });
    }
    const asksToWake = type === "send" && options.wakeEndedRecipient === true && options.broadcastId === undefined;
    if (asksToWake) {
      this.wakeSends.set(messageId, { to, logicalTarget: options.logicalTarget ?? to, expectsReply: options.expectsReply === true });
      const settled = () => { this.wakeSends.delete(messageId); };
      void acquired.attempt.promise.then(settled, settled);
    }
    try {
      options.beforeWrite?.(this.sentReach);
		writeMessage(socket, {
			type,
			to,
			...(options.logicalTarget === undefined ? {} : { logicalTarget: options.logicalTarget }),
			...(options.requirePendingReply === undefined ? {} : { requirePendingReply: options.requirePendingReply }),
			...(options.expectedRecipientId === undefined ? {} : { expectedRecipientId: options.expectedRecipientId }),
      ...(options.onReplyTarget === undefined ? {} : { resolveReplyTarget: true as const }),
			// #3760: this client understands `send_held`, so the broker may hold the send for a subagent being restored.
			...(type === "send" ? { awaitRestoringRecipient: true as const } : {}),
			// #5999: a subagent that ended but can be resumed is resumed for this message; the send is answered `queued`.
			...(asksToWake ? { wakeEndedRecipient: true as const } : {}),
			// The frame is JSON: an undefined sender is left out of it.
			hostedSender: options.hostedSender,
			message,
			attemptId: acquired.attempt.attemptId,
		});
    } catch (error) {
      this.pendingSends.reject(acquired.attempt, toError(error));
    }
    const clearReplyTarget = () => { this.pendingReplyTargets.delete(acquired.attempt.attemptId); };
    void acquired.attempt.promise.then(clearReplyTarget, clearReplyTarget);
    return result;
  }
  updatePresence(updates: PresenceUpdates): boolean {
    if (this.disconnecting) {
      return false;
    }
    const socket = this.socket;
    if (!socket || !this._sessionId || socket.destroyed || socket.writableEnded || !socket.writable) {
      return false;
    }
    writeMessage(socket, { type: "presence", ...updates });
    if (updates.groups !== undefined) this._groups = normalizeGroups(updates.groups, updates.group);
    else if (updates.group !== undefined) this._groups = normalizeGroups(undefined, updates.group);
    return true;
  }

  updatePresenceAcked(updates: PresenceUpdates): Promise<string> {
    let socket: net.Socket;
    try {
      socket = this.requireActiveSocket();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const wrappedResolve = (group: string): void => {
        clearTimeout(timeout);
        resolve(group);
      };
      const wrappedReject = (error: Error): void => {
        clearTimeout(timeout);
        reject(error);
      };
      const timeout = setTimeout(() => {
        if (!this.pendingPresence.delete(requestId)) return;
        void this.requestTimeout(socket, new Error("Presence update timeout")).then(reject);
      }, PRESENCE_ACK_TIMEOUT_MS);
      this.pendingPresence.set(requestId, {
        resolve: wrappedResolve,
        reject: wrappedReject,
        ...(updates.groups === undefined ? {} : { groups: [...updates.groups] }),
      });
      try {
        writeMessage(socket, { type: "presence", ...updates, requestId });
      } catch (error) {
        clearTimeout(timeout);
        this.pendingPresence.delete(requestId);
        reject(toError(error));
      }
    });
  }
}
