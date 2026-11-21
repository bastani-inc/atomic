// MUST stay first: ESM evaluates static dependencies before the importer's body, so this is the
// only position from which the stderr cap covers the other modules' own initialization.
import "./bounded-stderr-install.js";
// MUST stay second: it announces the broker's pid before the rest of the module graph loads (see start-announcement.ts).
import "./announce-on-import.js";
import net from "net";
import { chmodSync, existsSync, writeFileSync, unlinkSync, mkdirSync, readFileSync, rmSync, statSync } from "fs";
import { access } from "fs/promises";
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
import { isSocketAnswering } from "./socket-liveness.js";
import {
  acquireSocketReplacementLock,
  latestSocketReplacementGeneration,
  type SocketReplacementLock,
} from "./socket-replacement-lock.js";
import { type BrokerWatchdog, startBrokerWatchdog } from "./watchdog.js";
import { retractBrokerStartAnnouncement } from "./start-announcement.js";
import {
	getBrokerAwayAsksPath,
	getBrokerDeliveredMessagesPath,
	getBrokerEndedChildQueuePath,
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
	ReleasedChildRefusal,
	HostedSessionAssignment,
	HostedSessionRefusal,
} from "../types.js";
import { DELIVERED_MESSAGE_MAX_ENTRIES, DeliveredMessageCache } from "./delivered-message-cache.js";
import { isMessage, isSessionRegistration } from "./client-message-validation.js";
import {
	deliveryTargetIdentity,
	handleBrokerSend,
  type BrokerConnectedSession,
type ReleasedAskerReplyRouter,
	type RemoteSendRequest,
	type RemoteSendRouter,
	type RestoringRecipientHold,
	createReturnPathAuthority,
	type ReturnPathAuthority,
	returnPathParty,
	type SendClientMessage,
	detachSend,
	messageFrameFor,
	resolveSessionAliasesWith,
	senderAtReceipt,
} from "./send-handler.js";
import { buildMessageSendSignature } from "./send-signature.js";
import { DurableEndedQueue, type KeptFailure, isRestoredSend, type RestoredEndedQueues } from "./durable-ended-queue.js";
import type * as EndedChildQueueStoreModule from "./sql-ended-child-queue-store.js";
import type { EndedChildQueueStore } from "./sql-ended-child-queue-store.js";
import { ReturnPaths } from "./return-paths.js";
import {
  type BrokerStateOpener,
  LOCAL_RETRY_LOOKUP_BOUND_MS,
  MultiNodeRouter,
  readSharedStorageSetting,
  resolveMultiNodeStartup,
  SHARED_STORAGE_UNAVAILABLE_REASON,
  type SessionIdGrant,
  type UnansweredSessionIdClaim,
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
import {
	DepartedChildren,
	departureKey,
	type HeldSendRefusal,
	mayHaveReachedReason,
	notResumedReason,
	validateEndedChildrenFrame,
	type WakeSender,
} from "./departed-children.js";
import {
	EndedChildQueueFullError,
	EndedChildWakeBudget,
	type EndedChildWakeFailure,
	type EndedChildWakeRequest,
	isHeldWhilePaused,
	isMaybeDelivered,
	isQueuedForWake,
	PAUSED_LIVE_RECIPIENT_TARGET,
	sendWakesEndedRecipient,
} from "./ended-child-wakes.js";
import { type IntercomRecipientGoneError, serializeIntercomRecipientGoneError } from "./recipient-gone-errors.js";
import { NotHostedSessionError, serializeIntercomHostedSessionError } from "./hosted-session-errors.js";
import {
  LEGACY_LIVE_ROUTE_REFUSAL,
  type ParsedHostedSession,
  validateHostSessionsFrame,
  validateUnhostSessionsFrame,
} from "./hosted-sessions.js";
import { answerLegacyWorkflowFrame, legacyNotificationSend } from "./legacy-workflow-frames.js";
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
  ENDED_QUEUE_HANDED_OVER,
  ENDED_QUEUE_KEPT,
  ENDED_QUEUE_RECEIVED,
} from "./crash-points.js";
import { releasedAskerReplyRefusal } from "./released-asker-remote-replies.js";
import { normalizeGroup, normalizeGroups } from "../group.js";
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
import { RecipientReceipts, UNCERTAIN_RECEIPT_REASON } from "./recipient-receipts.js";
import { deliverAskFailure, deliverHeldToAsker, failLostReply } from "./ask-failures.js";
import { DELIVERED_MESSAGE_TTL_MS, RECIPIENT_RECEIPT_TIMEOUT_MS } from "../retry-policy.js";
import { isAgentRecipient } from "../recipient-purpose.js";
import {
  BROKER_RETIRING_CODE,
  BROKER_RETIRING_REASON,
  BROKER_ROUTING_CHANGED_CODE,
  BROKER_ROUTING_CHANGED_REASON,
} from "../recoverable-disconnect.js";
import { SUPERVISOR_AUTHORIZATION_REFUSED_CODE, SUPERVISOR_AUTHORIZATION_REFUSED_REASON } from "../supervisor-refusal.js";

const INTERCOM_DIR = getIntercomDirPath();
/** The socket clients reach the running broker on, until this broker chooses its own under the startup lock (#5040). */
let SOCKET_PATH = getBrokerSocketPath();
const BROKER_IDLE_TIMEOUT_MS = 5_000;
const UNCLASSIFIED_CONNECTION_RECHECK_MS = 100;
const PID_PATH = getBrokerPidPath();
const SOCKET_REPLACEMENT_LOCK_PATH = getBrokerSocketReplacementLockPath();

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
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), budgetMs).unref()),
  ]);
}

function exitBecauseLiveBrokerOwnsSocket(): never {
  console.error(`Intercom broker not started: a live broker already answers on ${SOCKET_PATH}`);
  process.exit(0);
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
		if (!isReachable(reach, group)) return false;
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

/** #5999: a sender that may wake an ended subagent: who the owner is told woke it, and its own key as a subagent. */
function wakeSenderOf(from: ConnectedSession): WakeSender {
	const name = from.info.name?.trim();
	return {
		...holdSenderOf(from),
		waker: { id: from.info.id, ...(name ? { name } : {}) },
		...(from.supervisorId !== undefined && from.registrationName !== undefined
			? { wakeKey: departureKey(from.supervisorId, from.registrationName) }
			: {}),
	};
}

function holdSenderOf(from: ConnectedSession, answersAsk?: true): HoldSender {
	return {
		id: from.info.id,
		info: from.info,
		...(from.reach === undefined ? {} : { reach: from.reach }),
		...(answersAsk === undefined ? {} : { answersAsk }),
	};
}

let endedChildQueueStoreModule: Promise<typeof EndedChildQueueStoreModule> | undefined;

/**
 * #5999 durable wake queue: the store's code, loaded when a session first registers or as a broker warms it, once; a
 * load that failed is tried again.
 */
function loadEndedChildQueueStore(): Promise<typeof EndedChildQueueStoreModule> {
  endedChildQueueStoreModule ??= import("./sql-ended-child-queue-store.js").catch((error: unknown) => {
    endedChildQueueStoreModule = undefined;
    throw error;
  });
  return endedChildQueueStoreModule;
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
  private supervisorChannel = new SupervisorChannelCache();
  private sessionIdReclaim = new SessionIdReclaim();
  /** Connections whose requested id is being checked against its multi-node binding before they register. */
  private claimingSessionIds = new WeakSet<net.Socket>();
  /**
   * #5607: connections whose claim of their id went unanswered and whose binding write has not yet decided which id
   * they hold. They are about to register, so the broker does not retire for want of sessions meanwhile.
   */
  private readonly settlingRegistrations = new Set<net.Socket>();
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
  /** #5999: the bounds on message wakes; with the durable wake queue, what they count outlives the broker too. */
  private readonly wakeBudget = new EndedChildWakeBudget();
  /** #5999 durable wake queue: where messages for subagents that ended are kept, so a broker restart loses none. */
  private readonly endedQueue = new DurableEndedQueue({
    openStore: () => this.openEndedQueueStore(),
    routingStarted: () => (this.sharedStorageSetting === undefined ? undefined : this.multiNodeFirstAttempt),
    retireStore: () => this.retireEndedQueueStore(),
    budget: this.wakeBudget,
    delivered: (held) => this.queuedMessageState(held),
    log: (text) => console.error(text),
  });
  /** #5999 durable wake queue: the broker before this one: the pid it recorded, and the socket lock generation it left. */
  private predecessor: { readonly pid?: string; readonly generationBefore?: number } = {};
  /** Multi-node: opens the durable wake queue in the shared database, once routing is on. */
  private openSharedEndedQueue:
    | ((owner: { readonly home: string; readonly holder: string; readonly retire?: boolean }) => Promise<EndedChildQueueStore>)
    | undefined;
  /** #4639: subagents whose session is gone, held for until they return or their owner says why they ended. */
  private departedChildren = new DepartedChildren(
    (refusals) => this.refuseHeldSends(refusals),
    undefined,
    undefined,
    undefined,
    {
      // #5999: a subagent that ended but can be resumed is woken for a message through its owner, within these bounds.
      failed: (failures) => this.failQueuedForWake(failures),
      budget: this.wakeBudget,
      ownerLive: (ownerSessionId) => this.sessions.has(ownerSessionId),
      ownerHost: (ownerSessionId) => this.sessions.get(ownerSessionId)?.registrationReturnAddress,
      journal: this.endedQueue.journal,
      evicted: (sends) => this.dispatchHeldSends(sends),
      // Durable wake queue: the caps count what a message takes in the store, and what the store keeps.
      storedBytes: (held) => this.endedQueue.storedBytes(held),
      storedCounts: (departure) => this.endedQueue.storedCounts(departure),
    },
  );
  /** Return paths: who may answer a sender outside its groups that wrote to it. */
  private readonly returnPaths = new ReturnPaths();
  private readonly returnPathAuthority: ReturnPathAuthority = createReturnPathAuthority(this.returnPaths, this.sessions);
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
    // #5607: with multi-node routing, a plain send to an id a session here holds as an alias reaches that session.
    resolveSessionAliasesWith(this.sessions, (sessionId) => this.multiNode?.aliasTarget(sessionId));
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
    // #5999 durable wake queue: which broker served before this one, as every version leaves it: the pid it recorded
    // (kept when it crashed), and the socket lock generation before the one this broker took.
    const taken = latestSocketReplacementGeneration(SOCKET_REPLACEMENT_LOCK_PATH);
    this.predecessor = {
      pid: this.readPidRecord(),
      ...(taken === undefined ? {} : { generationBefore: taken - 1 }),
    };
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
      this.warmEndedQueueStore();
    });
  }

  /**
   * #5999 durable wake queue: a broker taking over the local store an earlier broker left loads the store's code as it
   * starts. The first registration waits a bounded time for the store, and on a busy machine loading that code alone
   * could use it up, so the earlier broker's messages were kept in memory only and lost. Nothing is opened here.
   */
  private warmEndedQueueStore(): void {
    if (this.sharedStorageSetting !== undefined) return;
    // Looked for off the event loop: a slow home directory must not hold the broker's first answers.
    void access(getBrokerEndedChildQueuePath()).then(
      () => loadEndedChildQueueStore().catch(() => {}),
      () => {},
    );
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
      // #5607: a session fenced here left already, and its id may name another session by now.
      if (this.sessions.get(departing)?.socket !== socket) return;
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
        if (awaitingFirstFrame || this.settlingRegistrations.size > 0) {
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
	private canInspectSelectedGroup(requester: ConnectedSession, selectedGroup: string): boolean {
		return requester.reach === undefined || canPeek(requester.reach, normalizeGroup(selectedGroup));
	}

	/** Whether a live session here other than `departed` is registered under `departed`'s return-path identity. */
	private identityLiveHere(departed: ConnectedSession, identity: string): boolean {
		for (const session of this.sessions.values()) {
			if (session === departed || session.registrationReturnAddress !== departed.registrationReturnAddress) continue;
			if (returnPathParty(session).identity === identity) return true;
		}
		return false;
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

  /**
   * Register the session under the id it was granted, and complete its registration (see `register`). `unanswered`: its
   * claim of the id it asked for went unanswered (#5607). Its binding write, in the place of the fresh id's, may still
   * keep that id; the session is registered here once that write has decided which id it holds, and never shown under
   * the other.
   */
  private completeSessionRegistration(
    socket: net.Socket,
    clientMessage: SessionRegistrationRequest,
    grantedId: string,
    supervisorId: string | undefined,
    setId: (id: string | null) => void,
    unanswered?: UnansweredSessionIdClaim,
    grant?: SessionIdGrant,
    awaits?: string,
  ): void {
        let id = grantedId;
        const initialGroups = normalizeGroups(clientMessage.session.groups, clientMessage.session.group);
        const legacyGroup = normalizeGroup(clientMessage.session.group ?? initialGroups.values().next().value);
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
        };
		setSessionGroups(info, initialGroups, legacyGroup);
        const rejoined: ConnectedSession = {
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
        };
        const register = (): void => {
          setId(id);
          this.sessions.set(id, rejoined);
        };
        // #5607: until its binding write decides its id, the session is still claiming it, as it was before.
        let settled = unanswered === undefined || this.multiNode === undefined;
        if (settled) register();
        else {
          this.claimingSessionIds.add(socket);
          this.settlingRegistrations.add(socket);
        }

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        const consumedCapability =
          supervisorId && isSupervisorRegistration(clientMessage.supervisor) ? clientMessage.supervisor.capability : undefined;
        const completeRegistration = (held: readonly HeldWrite[] = []): void => {
          // #3761: echoing the capability tells the client this broker understands `received`; an old broker never does.
          writeMessageIfOpen(socket, {
            type: "registered",
            sessionId: id,
            ...(supervisorId ? { supervisorSessionId: supervisorId } : {}),
            ...(clientMessage.acknowledgesReceipt === true ? { acknowledgesReceipt: true as const } : {}),
            // Advertised so a 0.9.x session sends its workflow frames with a `requestId`, which this broker can answer
            // in place; it no longer advertises `claimsWorkflowInvocations`, so 0.9.x never sends a claim.
            acknowledgesPendingStageRoutes: true as const,
            withdrawsPendingStageRoutes: true as const,
            refusesPendingStageRoutesInPlace: true as const,
            brokerStatus: true as const,
            extendsSaves: true as const,
            marksEndedChildren: true as const,
            wakesEndedChildren: true as const,
            // #5999: a client that kept messages queued for subagents that ended learns when a new broker lost them: this
            // names what keeps them, the durable wake queue's store (the same across restarts) or this process's memory.
            instanceId: this.endedQueue.storeId ?? this.instanceId,
            ...(this.endedQueue.durable ? { dropsEndedQueued: true as const } : {}),
            stampsReleasedChildren: true as const,
            multiNodeRouting: this.multiNodeStatus,
            protocol: { ...BROKER_PROTOCOL },
            ...(clientMessage.reachPolicy === undefined ? {} : { enforcesReach: true as const }),
            // #5607: the id it asked for is another registration's for now; it gets it back as an alias once that one
            // gives it up or goes stale, so it keeps asking for that id rather than this one.
            ...(awaits === undefined || awaits === id ? {} : { awaitsSessionId: awaits }),
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
          // #5999 durable wake queue: a message it queued for a subagent that ended, which failed while it was away, is told
          // now, once.
          const registeredSession = this.sessions.get(id);
          if (registeredSession !== undefined)
            for (const failure of this.endedQueue.takeFailures(rejoined?.registrationReturnAddress, id))
              this.tellKeptFailure(registeredSession, failure);
          // #4639: a subagent whose session dropped is back under its owner's authorization; its held sends follow.
          // #5999: what was queued for its wake goes first: it was sent before anything its restart held since.
          const departedSends =
            registered !== undefined && supervisorId !== undefined
              ? this.departedChildren.registered(registered, sessionGroups(info), supervisorId)
              : [];
          const restoredSends = this.restoringRecipients.consume(
            consumedCapability,
            registered
              ? { childName: registered, groups: sessionGroups(info), ...(supervisorId ? { authorizedBy: supervisorId } : {}) }
              : undefined,
          );
          for (const send of departedSends.filter(isQueuedForWake)) this.dispatchQueuedForWake(send, registered);
          for (const send of restoredSends) this.dispatchSend(send.socket, send.clientMessage, send.senderId);
          this.dispatchHeldSends(departedSends.filter((send) => !isQueuedForWake(send)));
        };
        // #5101: set while its routes are being restored, as its registration completes.
        let restoring: object | undefined;
        // #5607: register the session as its binding write decided: under its unanswered claim's id when that write kept
        // it and no session here holds it, otherwise under the fresh id. Once only; true when it kept the claimed id.
        const settle = (keep: boolean): boolean => {
          if (settled) return false;
          settled = true;
          this.claimingSessionIds.delete(socket);
          this.settlingRegistrations.delete(socket);
          const kept = keep && unanswered !== undefined && !this.sessions.has(unanswered.sessionId);
          if (kept) {
            id = unanswered.sessionId;
            info.id = id;
          }
          register();
          // #5101: its routes are restored only as its registration completes (see below).
          restoring = this.pendingQuestions.beginRestoring(id);
          // Its connection closed while the write was deciding: it leaves as if it closed now.
          if (socket.destroyed || socket.writableEnded) {
            setId(null);
            this.disconnectSession(id);
            this.scheduleShutdownCheck();
          }
          return kept;
        };
        // Multi-node S5: brokers on other hosts find this session through its presence lease, so registration
        // completes once the lease is written (or bounded attempts found it still held elsewhere). The session is
        // routable meanwhile, so its frames are held until `registered` is written.
        const presence = this.multiNode?.sessionRegistered(
          rejoined,
          consumedCapability === undefined && !info.name?.trim()
            ? undefined
            : {
                ...(consumedCapability === undefined ? {} : { capability: consumedCapability }),
                ...(info.name?.trim() ? { childName: info.name.trim() } : {}),
                groups: sessionGroups(info),
                ...(supervisorId ? { authorizedBy: supervisorId } : {}),
              },
          settled || unanswered === undefined ? undefined : { ...unanswered, settle, unsettled: () => !settled },
          grant,
          awaits,
        );
        // #5999 durable wake queue: `registered` names what keeps queued messages, decided once, when the first session
        // registers (bounded by ENDED_QUEUE_OPEN_WAIT_MS, and by ENDED_QUEUE_ROUTING_WAIT_MS with a shared `storage`).
        const keeper = this.endedQueue.decided
          ? undefined
          : this.endedQueue.decide((snapshot) => this.restoreEndedQueue(snapshot));
        if (presence === undefined && keeper === undefined) completeRegistration();
        else {
          holdWrites(socket);
          // #5101: routable now, but its routes are restored only as its registration completes; a reply that only a
          // restored route would authorize waits for that rather than being refused.
          if (settled) restoring = this.pendingQuestions.beginRestoring(id);
          void Promise.all([presence, keeper]).then(() => {
            // #5607: a binding write that has not decided by now leaves the session under the fresh id.
            settle(false);
            const held = releaseHeldWrites(socket);
            try {
              if (this.sessions.get(id) === rejoined) completeRegistration(held);
              else discardHeldWrites(held);
            } finally {
              if (restoring !== undefined) this.pendingQuestions.finishRestoring(id, restoring);
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

    // A JSON object whose `type` is a string: checked just above.
    const clientMessage = msg as { [key: string]: JsonWireValue } & { type: string };

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

    // Every message but a registration comes from a registered session: the cases below read `currentId!`.
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
          // #5607: an id held here for this session is taken back by the registration of its own delivery identity only.
          const initialGroups = normalizeGroups(clientMessage.session.groups, clientMessage.session.group);
          const home =
            registration.reachPolicy?.home ??
            (typeof clientMessage.registrationGroup === "string"
              ? normalizeGroup(clientMessage.registrationGroup)
              : normalizeGroup(clientMessage.session.group ?? initialGroups.values().next().value));
          // #5607: a client that takes ids back is told which id it awaits; a hand-over it presents takes one.
          const takesIdHandoff = clientMessage.takesIdHandoff === true;
          const idHandoff = typeof clientMessage.idHandoff === "string" ? clientMessage.idHandoff : undefined;
          void multiNode
            .claimSessionId(
              preferred,
              returnAddress,
              JSON.stringify(["return", returnAddress, normalizeGroup(home)]),
              idHandoff,
            )
            .then((claimed) => {
              this.claimingSessionIds.delete(socket);
              // #5607: the id granted is the one asked for, or one held here for this session since it awaited it. An id
              // this registration took but does not use is given back at once.
              const grantedId = claimed.status === "granted" ? claimed.grant.sessionId : undefined;
              const granted =
                claimed.status === "granted" && grantedId !== undefined && !this.sessions.has(grantedId)
                  ? claimed.grant
                  : undefined;
              const giveBack = () => {
                if (claimed.status === "granted")
                  void multiNode.releaseOwner({ intercomSessionId: claimed.grant.sessionId, token: claimed.grant.token });
                else if (claimed.status === "unanswered")
                  void multiNode.releaseOwner({
                    intercomSessionId: claimed.unanswered.sessionId,
                    token: claimed.unanswered.token,
                  });
              };
              if (socket.destroyed || socket.writableEnded) {
                giveBack();
                return;
              }
              if (this.shuttingDown) {
                giveBack();
                writeMessageIfOpen(socket, RETIRING_REFUSAL);
                socket.end();
                return;
              }
              if (claimed.status === "granted" && granted === undefined) giveBack();
              this.completeSessionRegistration(
                socket,
                registration,
                granted !== undefined ? granted.sessionId : randomUUID(),
                supervisorId,
                setId,
                claimed.status === "unanswered" ? claimed.unanswered : undefined,
                granted,
                // #5607: held by another registration of this session (or for this one, by a hand-over that did not take
                // it this time): a client that takes ids back awaits it, and keeps asking for it rather than saving the
                // fresh one.
                claimed.status === "held" && takesIdHandoff ? preferred : undefined,
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
        this.disconnectSession(currentId!, clientMessage.resumable !== true);
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
        const supervisor = this.sessions.get(currentId!);
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
        const owner = this.sessions.get(currentId!);
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
          : this.supervisorChannel.supervisedChildName(clientMessage.capability, currentId!);
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
          currentId!,
          childName,
          normalizeGroup(typeof clientMessage.group === "string" ? clientMessage.group : owner.registrationGroup),
          aliases,
          {
            dormant: clientMessage.dormant === true,
            ...(typeof clientMessage.holdMs === "number" ? { holdMs: clientMessage.holdMs } : {}),
          },
        );
        // #5999: a subagent resumed for a message keeps what was queued for it until it registers.
        this.dispatchHeldSends(this.departedChildren.supersede(currentId!, childName, true));
        // #5352: acknowledged once senders on other brokers can find the reservation (bounded by the router).
        const requestId = clientMessage.requestId;
        // `published: false`: reserved here, and written for other brokers once the shared database takes it.
        void published.then((visible) =>
          writeMessageIfOpen(socket, { type: "restoring_recipient_ack", requestId, ...(visible ? {} : { published: false }) }),
        );
        break;
      }

      case "host_sessions": {
        const host = this.sessions.get(currentId!);
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
        const assignments: Array<HostedSessionAssignment & { liveRouteRefusal?: string }> = [];
        const presences: Promise<void>[] = [];
        // #4639: a host back after its connection closed takes over the departures it kept; hosting a name again ends its.
        this.adoptOrphans(currentId!, host);
        for (const item of validation.sessions) {
          const hosted = this.hostSession(currentId!, socket, item, hostReach !== undefined);
          if (hosted.registrationName !== undefined)
            this.dispatchHeldSends(this.departedChildren.supersede(currentId!, hosted.registrationName));
          const presence = this.multiNode?.sessionRegistered(hosted);
          if (presence !== undefined) presences.push(presence);
          // A 0.9.x host's released workflow stage asks for a live route too: it is hosted, and the route refused.
          assignments.push({
            key: item.key,
            sessionId: hosted.info.id,
            ...(item.liveRoute === true ? { liveRouteRefusal: LEGACY_LIVE_ROUTE_REFUSAL } : {}),
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
        if (typeof clientMessage.requestId !== "string" || !this.sessions.has(currentId!)) {
          throw new Error("Invalid unhost_sessions message");
        }
        const validation = validateUnhostSessionsFrame(clientMessage.sessionIds);
        const hosted = this.hostedSessions.get(currentId!);
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
        const owner = this.sessions.get(currentId!);
        if (owner === undefined || typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid reserve_released_children message");
        }
        // #4639: a host session back after its connection closed takes over the released children it kept.
        this.adoptOrphans(currentId!, owner);
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
          published.push(this.reserveReleasedChild(currentId!, owner.registrationGroup, child, order));
          this.releasedAskerReplies.attach(child.childName, currentId!);
          // #4751: a failed ask kept for the child wakes it again, so it is delivered.
          if (
            child.wake &&
            (this.pendingQuestions.hasHeldForReleasedChild(child.childName, currentId!) ||
              this.pendingQuestions.hasHeldForReleasedAsker(child.childName, currentId!))
          )
            this.wakeRestoringRecipientOwner({ ownerSessionId: currentId!, childName: child.childName });
          this.dispatchHeldSends(this.departedChildren.supersede(currentId!, child.childName));
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

      case "drop_ended_queued": {
        const { messageIds } = clientMessage;
        if (!Array.isArray(messageIds) || messageIds.length > 1_024 || !messageIds.every((id) => typeof id === "string")) {
          throw new Error("Invalid drop_ended_queued message");
        }
        // Durable wake queue: this session was told these were lost; only its own are dropped, and nobody is told again.
        const session = currentId === null ? undefined : this.sessions.get(currentId);
        if (session !== undefined)
          this.endedQueue.settled(
            this.departedChildren.dropQueued(messageIds as string[], (held) =>
              held.senderReturnAddress === undefined
                ? held.senderId === session.info.id
                : held.senderReturnAddress === session.registrationReturnAddress,
            ),
          );
        break;
      }

      case "answer_ended_child_wake": {
        const { childName, wakeId, accepted, reason } = clientMessage;
        if (
          typeof childName !== "string" ||
          typeof wakeId !== "string" ||
          typeof accepted !== "boolean" ||
          (reason !== undefined && typeof reason !== "string")
        ) {
          throw new Error("Invalid answer_ended_child_wake message");
        }
        // #5999: only the owner the wake was asked of answers it; any other answer names no wake of its own.
        this.departedChildren.answerWake(currentId!, childName, wakeId, accepted, reason?.slice(0, 1_000));
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
        const owner = this.sessions.get(currentId!);
        if (owner === undefined || typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid mark_ended_children message");
        }
        this.adoptOrphans(currentId!, owner);
        const validation = validateEndedChildrenFrame(clientMessage.children, owner.registrationGroup);
        const refusal = validation.ok
          ? this.releasedChildrenRefusal(owner, validation.children.map((child) => ({ ...child, wake: false })))
          : validation.refusal;
        if (!validation.ok || refusal !== undefined) {
          writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId, refusal });
          break;
        }
        const marked = this.departedChildren.mark(currentId!, validation.children);
        this.refuseHeldSends(marked.refused);
        // #5999: sends that waited for this verdict and asked to wake their subagent are queued for it now.
        for (const { held, target, kept } of marked.queued) this.answerQueuedForWake(held, target, kept);
        for (const held of marked.uncounted) this.decideOnceCounted(held);
        for (const wake of marked.wakes) this.wakeEndedChildOwner(wake);
        this.dispatchHeldSends(marked.evicted);
        writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId });
        break;
      }

      case "drop_released_children": {
        const owner = this.sessions.get(currentId!);
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
        this.adoptOrphans(currentId!, owner);
        const childNames = clientMessage.childNames as string[];
        const refusal = childNames
          .map((childName) => this.releasedChildOwnerRefusal(owner, childName))
          .find((candidate) => candidate !== undefined);
        if (refusal !== undefined) {
          writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId, refusal });
          break;
        }
        for (const childName of childNames) {
          this.releaseReservation(releasedReservationKey(childName), currentId!, clientMessage.gone, clientMessage.refusal);
          this.failParkedQuestions(this.pendingQuestions.takeParked(childName, currentId!), undefined, childName);
          this.failParkedKept(currentId!, childName);
          this.releasedAskerReplies.dropChild(childName, currentId!);
        }
        writeMessageIfOpen(socket, { type: "released_children_ack", requestId: clientMessage.requestId });
        break;
      }

      case "acknowledge_released_child_wake": {
        const owner = this.sessions.get(currentId!);
        if (owner === undefined || typeof clientMessage.requestId !== "string" || typeof clientMessage.childName !== "string") {
          throw new Error("Invalid acknowledge_released_child_wake message");
        }
        this.adoptOrphans(currentId!, owner);
        const childName = clientMessage.childName;
        const valid = isValidChildName(childName);
        const refusal: ReleasedChildRefusal | undefined = valid ? this.releasedChildOwnerRefusal(owner, childName) : undefined;
        const extended = valid && refusal === undefined ? this.restoringRecipients.extendHolds(childName, currentId!) : undefined;
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
        this.releaseReservation(clientMessage.capability, currentId!, clientMessage.gone, clientMessage.refusal);
        writeMessageIfOpen(socket, { type: "restoring_recipient_ack", requestId: clientMessage.requestId });
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
			if (this.hostedSessions.get(currentId!)?.has(hostedSender) !== true) {
				this.refuseHostedSender(socket, clientMessage, hostedSender);
				break;
			}
			if (this.sessions.get(currentId!)?.reach !== undefined && !isPendingReply(clientMessage)) {
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
			const recipient = this.sessions.get(currentId!);
			// #4751: only the asker a message is held for, proven by its return address, releases it.
			if (recipient !== undefined)
				this.pendingQuestions.releaseHeld(clientMessage.messageId, recipient.registrationReturnAddress);
			if (recipient?.acknowledgesReceipt === true) {
				this.multiNode?.received(recipient, clientMessage.messageId);
				this.receipts.settle(
					clientMessage.messageId,
					deliveryTargetIdentity(recipient),
					recipient,
					clientMessage.paused === true ? true : undefined,
				);
			}
			break;
		}

		case "saving": {
			if (typeof clientMessage.messageId !== "string") throw new Error("Invalid saving message");
			const recipient = this.sessions.get(currentId!);
			if (recipient?.acknowledgesReceipt === true && !this.multiNode?.saving(recipient, clientMessage.messageId))
				this.receipts.extend(clientMessage.messageId, deliveryTargetIdentity(recipient));
			break;
		}

      case "set_reach": {
        const session = this.sessions.get(currentId!);
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
        const wasTerminal = this.sessions.get(currentId!)?.info.replyCapability === "terminal";
        handleBrokerPresence(
          socket,
          clientMessage,
          currentId,
          this.sessions,
          (target, message) => writeMessageIfOpen(target, message),
          this.pendingQuestions,
          (peer, changed) => this.presenceFanout.queue(peer, changed.info.id),
        );
        const updated = this.sessions.get(currentId!);
        // #4751: a recipient that can no longer answer fails the asks of released subagents waiting for it.
        if (updated !== undefined && !wasTerminal && updated.info.replyCapability === "terminal")
          this.failReleasedAsksTo(updated.info, updated.socket, TERMINAL_CHILD_ASK_REFUSAL, "terminal");
        if (updated !== undefined) this.multiNode?.sessionUpdated(updated);
        break;
      }

      case "send_pending_stage_notification":
        // A 0.9.x run's notice that a message queued for one of its stages will not be delivered: sent on as an
        // ordinary send from this connection (Atomic 0.10.0 removed workflows; see `legacy-workflow-frames.ts`).
        this.dispatchSend(
          socket,
          legacyNotificationSend(
            clientMessage,
            this.sessions.values(),
            currentId === null ? undefined : this.sessions.get(currentId)?.registrationGroup,
          ),
          currentId,
        );
        break;

      case "register_pending_stage_route":
      case "withdraw_pending_stage_route":
      case "claim_workflow_invocation":
      case "register_live_workflow_stage_route":
      case "pending_stage_message_result":
      case "pending_stage_notification_result":
        // A 0.9.x session's workflow frame: answered in place, never by ending the connection (Atomic 0.10.0 removed
        // workflows; see `legacy-workflow-frames.ts`).
        answerLegacyWorkflowFrame(socket, clientMessage);
        break;

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  /** Route one send or ask frame, as received or again after a restoring subagent's hold ends (#3760). */
  private dispatchSend(socket: net.Socket, clientMessage: SendClientMessage, senderId: string | null): void {
    // Durable wake queue: a send to a subagent an earlier broker kept messages for waits until they are taken up again, so
    // a sender's later message never overtakes its earlier ones. Sends to other sessions never wait.
    if (typeof clientMessage.to === "string" && this.endedQueue.holds(clientMessage.to)) {
      this.endedQueue.whenRestored(() => this.dispatchSend(socket, clientMessage, senderId));
      return;
    }
    handleBrokerSend(
      socket,
      clientMessage,
      senderId,
      this.sessions,
      this.deliveredMessages,
      writeMessageIfOpen,
      this.supervisorChannel,
      this.pendingQuestions,
      writeMessageWithOutcome,
      this.holdForRestoringRecipient,
      this.receipts,
      this.routeRemote,
      (sender, group) => this.canInspectSelectedGroup(sender, group),
      this.routeReleasedAskerReply,
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
      queuedBytes: this.departedChildren.queuedBytes,
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
          this.openSharedEndedQueue = opened.state.openEndedChildQueue;
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
                fence: (session, reason, handoff) => this.fenceSession(session, reason, handoff),
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
    const held: HeldSend = {
      socket,
      senderId: from.info.id,
      messageId,
      clientMessage,
      ...(attemptId === undefined ? {} : { attemptId }),
      ...(from.registrationReturnAddress === undefined ? {} : { senderReturnAddress: from.registrationReturnAddress }),
    };
    const sender = holdSenderOf(from, answersAsk);
    // #5999: a send that asks to wake a subagent its owner resumes for a message is queued for it, before anything else
    // (the hold of a paused child, or of one starting) would hold its sender.
    const wakeSender = answersAsk === undefined && sendWakesEndedRecipient(clientMessage) ? wakeSenderOf(from) : undefined;
    if (wakeSender !== undefined && this.queueForEndedChildWake(held, target, wakeSender)) return true;
    const admission = this.restoringRecipients.admit(target, sender, held, clientMessage.awaitRestoringRecipient === true);
    if (admission.kind === "none")
      return this.holdForDepartedChild(held, target, sender, clientMessage.awaitRestoringRecipient === true, wakeSender);
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

  /**
   * #5999: a send that asks to wake an ended subagent its owner resumes for a message: queued for it, its sender told so
   * at once, and the owner asked to resume it when this is the first message queued. False when no such subagent is the
   * target: the send is decided as before.
   */
  /** Durable wake queue: sends that already waited for the store to count what it kept: decided as things stand. */
  private readonly countWaited = new WeakSet<HeldSend["clientMessage"]>();

  /**
   * Durable wake queue: a message that may not fit while the store still counts what it kept waits for the count, at
   * most the store's open wait, and is then decided again: queued if it fits, or refused with the cap's reason.
   */
  private decideOnceCounted(held: HeldSend): void {
    this.countWaited.add(held.clientMessage);
    void this.endedQueue.untilCounted().then(() => this.dispatchSend(held.socket, held.clientMessage, held.senderId));
  }

  private queueForEndedChildWake(held: HeldSend, target: string, sender: WakeSender): boolean {
    // Durable wake queue: what an earlier broker kept may be for this target, and this may be a retry of one of them
    // whose answer the restart cut off: the send waits until it is taken up again (bounded), then is decided anew.
    if (!this.endedQueue.loaded) {
      void this.endedQueue.untilLoaded().then(() => this.dispatchSend(held.socket, held.clientMessage, held.senderId));
      return true;
    }
    // A child its owner reported gone keeps that answer; one its owner already holds (restoring, resuming or pausing it)
    // takes the message without another wake.
    const reserved = this.restoringRecipients.peek(target, sender);
    if (reserved === "gone") return false;
    const admission = this.departedChildren.admitWake(
      target,
      sender,
      held,
      reserved === "active",
      this.countWaited.has(held.clientMessage),
    );
    if (admission.kind === "none") return false;
    if (admission.kind === "uncounted") {
      this.decideOnceCounted(held);
      return true;
    }
    if (admission.kind === "refused") {
      this.refuseHeldSends([{ held, error: admission.error, reason: admission.reason }]);
      return true;
    }
    if (admission.duplicate !== true) {
      // A retry of a message that already reached the subagent (its answer was lost with a broker) is answered so.
      const from = senderAtReceipt(held.clientMessage as SendClientMessage);
      if (from !== undefined && this.queuedMessageDelivered(held, from)) {
        this.departedChildren.unqueue(held);
        this.endedQueue.takeEarly(held.messageId);
        this.endedQueue.settled([held.messageId]);
        writeMessageIfOpen(held.socket, {
          type: "delivered",
          messageId: held.messageId,
          ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
        });
        return true;
      }
    }
    this.answerQueuedForWake(held, admission.target, admission.kept);
    if (admission.wake !== undefined) this.wakeEndedChildOwner(admission.wake);
    return true;
  }

  /**
   * Durable wake queue: whether the delivered-message authority shows `held` reached its recipient: the recipient
   * confirmed saving it, possibly through an earlier broker.
   */
  private queuedMessageDelivered(held: HeldSend, sender: ConnectedSession): boolean {
    return this.queuedMessageKnown(held, sender) === "delivered";
  }

  /** Durable wake queue: what the delivered-message authority knows of a queued message an earlier broker kept. */
  private queuedMessageState(held: HeldSend): "delivered" | "uncertain" | "unknown" {
    try {
      const state = this.deliveredMessages.deliveryStateOf(held.messageId);
      return state === "accepted" ? "delivered" : state === "reserved" ? "uncertain" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Durable wake queue: what the delivered-message authority knows of `held`, sent as `sender`. */
  private queuedMessageKnown(held: HeldSend, sender: ConnectedSession): "delivered" | "uncertain" | "unknown" {
    const message = held.clientMessage.message;
    if (!isMessage(message)) return "unknown";
    const logicalTarget = typeof held.clientMessage.logicalTarget === "string" ? held.clientMessage.logicalTarget : held.clientMessage.to;
    const signature = buildMessageSendSignature(logicalTarget, message, sender.registrationReturnAddress ?? sender.info.id);
    try {
      const known = this.deliveredMessages.lookup(message.id, signature);
      return known === "match" ? "delivered" : known === "uncertain" ? "uncertain" : "unknown";
    } catch {
      return "unknown";
    }
  }

  /**
   * Durable wake queue: which store keeps the messages for subagents that ended. By default the local file in the
   * Intercom directory; with a shared `storage`, the shared database once routing is on (memory when it is not).
   */
  private async openEndedQueueStore(): Promise<EndedChildQueueStore | undefined> {
    const marker = this.endedQueueRetiredMarker();
    const retire = existsSync(marker);
    const continuity = {
      servedSinceLastHolder: (storeId: string) => this.servedSinceLastHolder(storeId),
      pid: String(process.pid),
    };
    let store: EndedChildQueueStore | undefined;
    if (this.sharedStorageSetting === undefined) {
      const { openLocalEndedChildQueueStore } = await loadEndedChildQueueStore();
      store = await openLocalEndedChildQueueStore(getBrokerEndedChildQueuePath(), this.instanceId, retire, continuity);
    } else {
      await this.multiNodeFirstAttempt;
      const router = this.multiNode;
      const open = this.openSharedEndedQueue;
      if (router === undefined || open === undefined) return undefined;
      store = await open({ home: router.durableHome, holder: router.brokerId, retire, ...continuity });
    }
    if (retire) rmSync(marker, { force: true });
    // This broker holds the store now: recorded at once, without the store's write lock, so the next broker can tell it
    // replaced this one (a write to the store can wait on another process's lock, or fail).
    try {
      writeFileSync(this.endedQueueHolderRecord(), JSON.stringify({ storeId: store.id, pid: String(process.pid) }), {
        mode: 0o600,
      });
    } catch (error) {
      console.error(
        `Intercom broker could not record that it holds the store of messages for subagents that ended: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return store;
  }

  /** Durable wake queue: the store's identity and the pid of the broker holding it, next to the local store. */
  private endedQueueHolderRecord(): string {
    return `${getBrokerEndedChildQueuePath()}.holder`;
  }

  /**
   * Durable wake queue: whether a broker other than the store's last holder (its holder record names it) may have served
   * this agent directory since: an earlier version keeps no such queue, and told its sessions their messages were lost.
   * Proven not when the last holder crashed (the pid file still names it), or exited in order with nothing started since
   * (its exit record names it and the socket lock generation it left is the one before this broker's).
   */
  private servedSinceLastHolder(storeId: string): boolean {
    let lastHolderPid: string | undefined;
    try {
      const holder = JSON.parse(readFileSync(this.endedQueueHolderRecord(), "utf-8")) as { storeId?: unknown; pid?: unknown };
      if (holder.storeId === storeId && typeof holder.pid === "string") lastHolderPid = holder.pid;
    } catch {
      // No record: nothing proves which broker held the store last.
    }
    if (lastHolderPid === undefined) return true;
    const { pid, generationBefore } = this.predecessor;
    if (pid !== undefined) return pid !== lastHolderPid;
    try {
      const exit = JSON.parse(readFileSync(this.endedQueueCleanExitMarker(), "utf-8")) as {
        readonly pid?: unknown;
        readonly generation?: unknown;
      };
      return !(exit.pid === lastHolderPid && generationBefore !== undefined && exit.generation === generationBefore);
    } catch {
      return true;
    }
  }

  /** Durable wake queue: written as this broker exits in order: its pid and the socket lock generation it leaves. */
  private endedQueueCleanExitMarker(): string {
    return `${getBrokerEndedChildQueuePath()}.exited`;
  }

  private recordCleanExit(): void {
    if (!this.endedQueue.durable) return;
    try {
      writeFileSync(
        this.endedQueueCleanExitMarker(),
        JSON.stringify({ pid: String(process.pid), generation: latestSocketReplacementGeneration(SOCKET_REPLACEMENT_LOCK_PATH) }),
        { mode: 0o600 },
      );
    } catch {
      // Unrecorded, the next broker cannot prove nothing served in between, and retires what the store kept.
    }
  }

  /** Durable wake queue: where a broker that kept the queue in memory says what a store kept is to be dropped. */
  private endedQueueRetiredMarker(): string {
    const store = getBrokerEndedChildQueuePath();
    return this.sharedStorageSetting === undefined ? `${store}.retired` : `${store}.shared.retired`;
  }

  /**
   * Durable wake queue: this broker keeps the queue in memory and names itself as what keeps it, so its sessions are
   * told what an earlier broker's store kept was lost; the next broker that opens the store drops it.
   */
  private retireEndedQueueStore(): void {
    try {
      writeFileSync(this.endedQueueRetiredMarker(), "retired\n", { mode: 0o600 });
    } catch (error) {
      console.error(
        `Intercom broker could not mark its store of messages for subagents that ended as retired: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Durable wake queue: what an earlier broker kept is taken up again. Messages the delivered-message authority shows
   * reached their subagent are done; failures waiting for their sender wait on; the rest join their subagent's queue,
   * in order, under their owner (asked to wake it when it reports it again) or waiting for it to come back.
   */
  private restoreEndedQueue(restored: RestoredEndedQueues): void {
    this.wakeBudget.restore(restored.budget);
    const { queues, delivered, ownerless } = restored;
    for (const { held } of delivered) {
      const sender = this.queuedSenderOf(held);
      if (sender !== undefined) writeMessageIfOpen(sender.socket, { type: "delivered", messageId: held.messageId });
    }
    this.endedQueue.settled(delivered.map(({ held }) => held.messageId));
    this.failQueuedForWake(
      ownerless.map(({ held, childName }) => ({
        held,
        childName,
        reason: notResumedReason(childName, "the session that launched it disconnected before it was resumed"),
      })),
    );
    const liveOwner = (host: string): string | undefined => {
      for (const session of this.sessions.values())
        if (session.registrationReturnAddress === host && session.hostedBy === undefined) return session.info.id;
      return undefined;
    };
    for (const wake of this.departedChildren.restore(queues, liveOwner)) this.wakeEndedChildOwner(wake);
    for (const session of [...this.sessions.values()]) {
      // A sender connected already is told what failed while it was away.
      for (const failure of this.endedQueue.takeFailures(session.registrationReturnAddress, session.info.id))
        this.tellKeptFailure(session, failure);
      // A subagent registered already takes what was kept for it.
      if (session.supervisorId === undefined || session.registrationName === undefined) continue;
      const sends = this.departedChildren.registered(session.registrationName, sessionGroups(session.info), session.supervisorId);
      for (const send of sends.filter(isQueuedForWake)) this.dispatchQueuedForWake(send, session.registrationName);
      this.dispatchHeldSends(sends.filter((send) => !isQueuedForWake(send)));
    }
  }

  /** Durable wake queue: tell a sender that its queued message failed while it was away. */
  private tellKeptFailure(sender: ConnectedSession, failure: KeptFailure): void {
    const from: SessionInfo = {
      id: failure.target,
      name: failure.childName,
      cwd: sender.info.cwd,
      model: "",
      pid: 0,
      startedAt: Date.now(),
      lastActivity: Date.now(),
    };
    writeMessageIfOpen(
      sender.socket,
      messageFrameFor(sender, from, {
        id: `wake-failed:${failure.messageId}`,
        timestamp: Date.now(),
        replyTo: failure.messageId,
        replyError: failure.reason,
        content: { text: failure.reason },
      }),
    );
    this.endedQueue.settled([failure.messageId]);
  }

  /**
   * #5999: tell the sender its message is queued for a subagent being resumed, or paused, and why (`target`); nothing it
   * waits on is held.
   */
  private answerQueuedForWake(held: HeldSend, target: string, kept?: Promise<unknown>): void {
    detachSend(held.clientMessage);
    const attempt = held.attemptId === undefined ? {} : { attemptId: held.attemptId };
    const queued = () =>
      writeMessageIfOpen(held.socket, { type: "queued", messageId: held.messageId, ...attempt, target, position: 1 });
    if (kept === undefined) {
      queued();
      return;
    }
    // Durable wake queue: answered once the message is kept; an outcome that came first is its answer instead.
    const answerEarly = (early: NonNullable<ReturnType<DurableEndedQueue["takeEarly"]>>) =>
      writeMessageIfOpen(
        held.socket,
        early.kind === "delivered"
          ? { type: "delivered", messageId: held.messageId, ...attempt }
          : { type: "delivery_failed", messageId: held.messageId, ...attempt, reason: early.reason },
      );
    void kept.then(
      () => {
        crashPoint(ENDED_QUEUE_KEPT);
        const early = this.endedQueue.takeEarly(held.messageId);
        if (early === undefined) queued();
        else answerEarly(early);
      },
      (error: unknown) => {
        const early = this.endedQueue.takeEarly(held.messageId);
        if (this.departedChildren.unqueue(held)) {
          const why = error instanceof Error ? error.message : String(error);
          writeMessageIfOpen(held.socket, {
            type: "delivery_failed",
            messageId: held.messageId,
            ...attempt,
            // The store had no room left for it: refused as for a full queue.
            reason:
              error instanceof EndedChildQueueFullError && error.reason !== undefined
                ? error.reason
                : `Intercom could not keep this message for ${held.clientMessage.to.trim()} until it is continued (${why}); it was not queued. Send it again.`,
          });
        } else if (early !== undefined) answerEarly(early);
        // Already on its way to the subagent: its outcome answers it.
      },
    );
  }

  /** #5999: ask the owner to resume its ended child for the messages now queued for it. */
  private wakeEndedChildOwner(wake: EndedChildWakeRequest): void {
    const owner = this.sessions.get(wake.ownerSessionId);
    if (owner === undefined) return;
    writeMessageIfOpen(owner.socket, {
      type: "ended_child_wake",
      childName: wake.childName,
      ...(wake.childId === undefined ? {} : { childId: wake.childId }),
      wakeId: wake.wakeId,
      from: wake.waker,
      depth: wake.depth,
    });
  }

  /**
   * #5999: messages queued for a wake that will not reach their subagent. Their senders were already answered, so each
   * is told as a delivery failure of that message, from the subagent it was for: an ask fails, a send shows the failure.
   * A sender that is gone has nobody left to tell.
   */
  private failQueuedForWake(failures: readonly EndedChildWakeFailure[]): void {
    for (const failure of failures) {
      const { held, childName } = failure;
      // Durable wake queue: one an earlier broker had handed over may have reached the subagent: its failure says so.
      const reason = isMaybeDelivered(held) ? mayHaveReachedReason(childName, failure.reason) : failure.reason;
      // Durable wake queue: a sender not answered `queued` yet gets the failure as its answer.
      if (this.endedQueue.settleEarly(held.messageId, { kind: "failed", reason })) {
        this.endedQueue.settled([held.messageId]);
        continue;
      }
      const sender = this.queuedSenderOf(held);
      if (sender === undefined) {
        // One that is away is told when it is back, if the queue outlives this broker.
        const addressed = held.clientMessage.logicalTarget;
        this.endedQueue.keepFailure(held, {
          messageId: held.messageId,
          reason,
          target: (typeof addressed === "string" ? addressed : held.clientMessage.to).trim(),
          childName,
        });
        continue;
      }
      this.endedQueue.settled([held.messageId]);
      const addressed = held.clientMessage.logicalTarget;
      const from: SessionInfo = {
        id: (typeof addressed === "string" ? addressed : held.clientMessage.to).trim(),
        name: childName,
        cwd: sender.info.cwd,
        model: "",
        pid: 0,
        startedAt: Date.now(),
        lastActivity: Date.now(),
      };
      writeMessageIfOpen(
        sender.socket,
        messageFrameFor(sender, from, {
          id: `wake-failed:${held.messageId}`,
          timestamp: Date.now(),
          replyTo: held.messageId,
          replyError: reason,
          content: { text: reason },
        }),
      );
    }
  }

  /**
   * #5999: the session to tell about a message queued for a subagent's wake: its sender on the connection that sent it,
   * or, once that connection is gone, the sender's session back under the same return address.
   */
  private queuedSenderOf(held: HeldSend): ConnectedSession | undefined {
    const sender = this.sessions.get(held.senderId);
    if (sender !== undefined && sender.socket === held.socket) return sender;
    // Durable wake queue: a send an earlier broker took is its sender's under the same id and return address.
    if (
      isRestoredSend(held) &&
      sender !== undefined &&
      sender.hostedBy === undefined &&
      sender.registrationReturnAddress === held.senderReturnAddress
    )
      return sender;
    if (held.senderReturnAddress === undefined) return undefined;
    for (const session of this.sessions.values())
      if (session.registrationReturnAddress === held.senderReturnAddress && session.hostedBy === undefined) return session;
    return undefined;
  }

  /** #4639: a subagent whose session is gone: hold the send for its return or its owner's verdict, or refuse it with why. */
  private holdForDepartedChild(
    held: HeldSend,
    target: string,
    sender: HoldSender,
    canHold: boolean,
    wakeSender?: WakeSender,
  ): boolean {
    const admission = this.departedChildren.admit(target, sender, held, canHold, wakeSender);
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
    for (const send of sends) {
      if (isQueuedForWake(send)) this.dispatchQueuedForWake(send);
      else this.dispatchSend(send.socket, send.clientMessage, send.senderId);
    }
  }

  /**
   * #5999: deliver a message queued for a subagent's wake, now that the subagent `childName` registered again. Its sender
   * was answered `queued` and may be gone: it is delivered as its sender was when it was sent, and what the delivery
   * would tell the sender stays here, except a refusal, which the sender gets as that message's delivery failure. One
   * kept while the subagent was paused is marked so, so the subagent takes it after what it is continued with.
   */
  private dispatchQueuedForWake(send: HeldSend, childName: string = send.clientMessage.to.trim()): void {
    const clientMessage = send.clientMessage as HeldSend["clientMessage"] & { message: Message };
    if (isHeldWhilePaused(send)) clientMessage.message = { ...clientMessage.message, heldWhilePaused: true };
    const write = (socket: net.Socket, frame: BrokerMessage): boolean => {
      if (socket !== send.socket) return writeMessageIfOpen(socket, frame);
      const about = (frame as { readonly messageId?: unknown }).messageId;
      if (about !== send.messageId) return writeMessageIfOpen(socket, frame);
      if (frame.type === "delivery_failed")
        this.failQueuedForWake([{ held: send, childName, reason: frame.reason }]);
      // The sender stops keeping the message as queued: it reached the subagent.
      if (frame.type === "delivered") {
        crashPoint(ENDED_QUEUE_RECEIVED);
        const sender = this.queuedSenderOf(send);
        if (!this.endedQueue.settleEarly(send.messageId, { kind: "delivered" }) && sender !== undefined)
          writeMessageIfOpen(sender.socket, { type: "delivered", messageId: send.messageId });
        // An ask that reached its subagent while its asker is away: the reply is held for the asker, as for any ask
        // whose asker is away.
        if (sender === undefined && clientMessage.message.expectsReply === true && send.senderReturnAddress !== undefined)
          this.pendingQuestions.keepForAwayAsker(send.messageId, send.senderId, send.senderReturnAddress);
        this.endedQueue.settled([send.messageId]);
      }
      // A subagent whose turn its user paused saved it: it keeps it until it is continued.
      if (frame.type === "queued" && frame.target === PAUSED_LIVE_RECIPIENT_TARGET) this.endedQueue.settled([send.messageId]);
      return true;
    };
    handleBrokerSend(
      send.socket,
      send.clientMessage,
      send.senderId,
      this.sessions,
      this.deliveredMessages,
      write,
      this.supervisorChannel,
      this.pendingQuestions,
      writeMessageWithOutcome,
      this.holdForRestoringRecipient,
      this.receipts,
      this.routeRemote,
      (sender, group) => this.canInspectSelectedGroup(sender, group),
      this.routeReleasedAskerReply,
      this.returnPathAuthority,
    );
    // Durable wake queue: written to the subagent; a restart before it confirms does not wake it for this message.
    if (!this.departedChildren.isQueued(send.messageId)) this.endedQueue.handedOver([send.messageId]);
    crashPoint(ENDED_QUEUE_HANDED_OVER);
  }

  /** #4639: refuse held sends with the typed error naming why their subagent is gone; its message is the reason. */
  private refuseHeldSends(refusals: readonly HeldSendRefusal[]): void {
    for (const { held, error, reason } of refusals) this.failHeldSendWith(held, error, reason);
  }

  private failHeldSendWith(held: HeldSend, error: IntercomRecipientGoneError, reason = error.message): void {
    writeMessageIfOpen(held.socket, {
      type: "delivery_failed",
      messageId: held.messageId,
      ...(held.attemptId === undefined ? {} : { attemptId: held.attemptId }),
      reason,
      recipientError: serializeIntercomRecipientGoneError(error),
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
  private reserveReleasedChild(ownerSessionId: string, ownerGroup: string | undefined, child: ParsedReleasedChild, releaseOrder?: number): Promise<boolean> {
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
      const refusal = this.releasedChildOwnerRefusal(owner, child.childName);
      if (refusal !== undefined) return refusal;
    }
    return undefined;
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
    const childName = this.restoringRecipients.childOf(key, ownerSessionId);
    const released = this.restoringRecipients.release(key, ownerSessionId, bounded.gone, bounded.refusal);
    if (released === undefined) return;
    // #5999: what was queued for the child fails with why its owner gave it up.
    if (childName !== undefined) this.departedChildren.holdEnded(ownerSessionId, childName, released);
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

  /**
   * `peer`: the recipient that ended, when it is known; otherwise each question's recipient is named by `peerName` (a
   * released subagent's name), or by its id.
   */
  private failParkedQuestions(questions: readonly PendingQuestion[], peer?: SessionInfo, peerName?: string): void {
    for (const question of questions) {
      const asker = this.sessions.get(question.senderSessionId);
      if (asker === undefined) continue;
      const from: SessionInfo = peer ?? {
        id: question.targetSessionId, ...(peerName === undefined ? {} : { name: peerName }),
        cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: Date.now(),
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
          ...(from.name === undefined ? {} : { peerName: from.name }),
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
  /**
   * #5607: another live registration of the same session owns this session's id across nodes: it leaves here as if its
   * connection dropped, and its client reconnects and gets a fresh id. A hosted session goes alone; its host stays.
   */
  private fenceSession(
    session: BrokerConnectedSession,
    reason: "lost" | "reclaimed" = "lost",
    handoff?: { readonly sessionId: string; readonly handoff: string },
  ): void {
    const id = session.info.id;
    if (this.sessions.get(id) !== session) return;
    console.error(
      reason === "lost"
        ? `Intercom session ${id} is registered on another broker, which owns its id; this registration reconnects with a fresh id`
        : `Intercom session ${id} reconnects to take back the id it asked for, which its earlier registration no longer holds`,
    );
    this.disconnectSession(id);
    if (session.hostedBy === undefined) {
      // #5607: a session moved back to the id it awaited is given the hand-over that takes it, then disconnected.
      if (handoff !== undefined) {
        writeMessageIfOpen(session.socket, { type: "id_handoff", sessionId: handoff.sessionId, handoff: handoff.handoff });
        session.socket.end();
      } else session.socket.destroy();
    }
    this.scheduleShutdownCheck();
  }

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

  private departSession(sessionId: string, ended: boolean): void {
    const departed = this.sessions.get(sessionId);
    if (!departed) return;
    // #4642: the sessions a connection hosts leave with it, and a hosted session leaves its host's index.
    for (const hostedId of [...(this.hostedSessions.get(sessionId) ?? [])]) this.disconnectSession(hostedId);
    this.hostedSessions.delete(sessionId);
    if (departed.hostedBy !== undefined) this.hostedSessions.get(departed.hostedBy)?.delete(sessionId);

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
    // #4639: a session whose connection closes while it keeps released children keeps them: sends to them are held
    // until its host session connects again and reserves them.
    const unreserved = [
      ...this.restoringRecipients.dropOwner(sessionId, departed.registrationReturnAddress),
      ...this.departedChildren.dropOwner(sessionId, departed.registrationReturnAddress, ended),
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
    // owner already away says so through its host session when it is back.
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

  private readPidRecord(): string | undefined {
    try {
      return readFileSync(PID_PATH, "utf-8").trim();
    } catch {
      return undefined;
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
    this.restoringRecipients.clear();
    this.releasedAskerReplies.clear();
    this.presenceFanout.dispose();
    for (const pending of this.releasedReplyAcks.values()) clearTimeout(pending.timer);
    this.releasedReplyAcks.clear();
    this.receipts.clear();
	this.deliveredMessageCache?.close();
    // The watchdog thread ends while this broker's pipe still answers its probes. On Windows, process.exit waits for
    // that thread, and the thread for its probe's connection: one made after the pipe server closed, while a session's
    // connection still holds the pipe open, finds the pipe busy and waits up to 30 s for a free instance.
    const watchdogStopped = this.watchdog?.stop() ?? Promise.resolve();
    // Give this broker's leases up so other brokers see its sessions offline at once, within a bound.
    const leasesGivenUp = this.multiNode?.close().catch(() => {}) ?? Promise.resolve();
    // #5999 durable wake queue: what is being written is written; the rows stay for the next broker.
    const queueClosed = this.endedQueue.close();
    const bound = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_CLOSE_BOUND_MS).unref());
    void Promise.race([Promise.all([watchdogStopped, leasesGivenUp, queueClosed]), bound]).finally(() => this.exitAfterShutdown());
  }

  private async exitAfterShutdown(): Promise<never> {
    // Windows named pipes are not path-unlinked on close, so a successor's pipe is never at risk.
    if (process.platform === "win32") {
      this.unlinkRuntimeFilesIfOwned();
      this.server.close();
      this.recordCleanExit();
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
    this.recordCleanExit();
    process.exit(0);
  }
}

// The stderr cap is already in place: `./bounded-stderr-install.js` is this file's first import.
async function startUnlessLiveBrokerAnswers(): Promise<void> {
  if (await isSocketAnswering(SOCKET_PATH)) exitBecauseLiveBrokerOwnsSocket();
  await new IntercomBroker().start();
}

void startUnlessLiveBrokerAnswers();
