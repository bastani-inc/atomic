// MUST stay first: ESM evaluates static dependencies before the importer's body, so this is the
// only position from which the stderr cap covers the other modules' own initialization.
import "./bounded-stderr-install.js";
import net from "net";
import { writeFileSync, unlinkSync, mkdirSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { createMessageReader } from "./framing.js";
import { writeMessageIfOpen, writeMessageWithOutcome } from "./socket-writes.js";
import {
	getBrokerDeliveredMessagesPath,
	getBrokerPidPath,
	getBrokerSocketPath,
	getIntercomDirPath,
} from "./paths.js";
import type {
	SessionInfo,
	Message,
	BrokerMessage,
	SupervisorRegistration,
	WorkflowStageRosterAnnouncement,
	WorkflowStageRosterEntry,
	WorkflowPossibleStageAnnouncement,
	WorkflowFutureStageRosterEntry,
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
	senderGroupIdentity,
} from "./send-handler.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { hasGroup, normalizeGroup, normalizeGroups } from "../group.js";
import { handleBrokerPresence } from "./presence-handler.js";
import {
	knownGroupSummaries,
	sessionGroups,
	sessionsInGroup,
	sessionsVisibleTo,
	setSessionGroups,
} from "./group-membership.js";
import { PendingQuestionIndex } from "./pending-question-index.js";
import { matchStagePathSegments } from "../workflow-stage-path-matching.js";
import { DELIVERED_MESSAGE_TTL_MS } from "../retry-policy.js";

const INTERCOM_DIR = getIntercomDirPath();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = getBrokerPidPath();

const PENDING_STAGE_MESSAGE_TIMEOUT_MS = 10_000;

interface PendingStageRouteRegistration {
  readonly sessionId: string;
  readonly group: string;
  readonly capability: string;
}

interface WorkflowRosterRegistration {
	readonly ownerSessionId: string;
	readonly group: string;
	readonly stages: WorkflowStageRosterAnnouncement[];
	readonly possibleStages?: readonly WorkflowPossibleStageAnnouncement[];
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

function invocationOwnsGroup(invocationGroup: string, candidateGroup: string): boolean {
	const owner = normalizeGroup(invocationGroup);
	const candidate = normalizeGroup(candidateGroup);
	return candidate === owner || candidate.startsWith(`${owner}/`);
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
				announcement.queuedCount >= 0
			);
		})
	);
}


class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private deliveredMessages = new DeliveredMessageCache(
	DELIVERED_MESSAGE_TTL_MS,
	DELIVERED_MESSAGE_MAX_ENTRIES,
	getBrokerDeliveredMessagesPath(),
  );
  private supervisorChannel = new SupervisorChannelCache();
  private pendingQuestions = new PendingQuestionIndex();
  private pendingStageRoutes = new Map<string, PendingStageRouteRegistration>();
  private pendingStageAcknowledgments = new Map<string, PendingStageAcknowledgment>();
	private pendingStageNotificationAcknowledgments = new Map<string, PendingStageNotificationAcknowledgment>();
  private liveWorkflowStageRoutes = new Map<string, LiveWorkflowStageRouteRegistration>();
  private workflowRosters = new Map<string, WorkflowRosterRegistration>();
  private liveWorkflowStageRouteActivations = new Map<string, LiveWorkflowStageRouteActivation>();

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
      this.scheduleShutdownCheck();
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      if (socket.destroyed || socket.writableEnded) return;
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

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
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
		if (session !== undefined) return session;
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
	 * Invocation control may come from the invocation owner or from an ordinary
	 * host session that explicitly joined the invocation group. A workflow stage
	 * registered under any workflow group cannot turn mutable membership into a
	 * parent-control capability for a sibling (or for another workflow run).
	 */
	private canControlWorkflowInvocation(sender: ConnectedSession, invocationGroup: string): boolean {
		if (!hasGroup(sessionGroups(sender.info), invocationGroup)) return false;
		const registrationGroup = normalizeGroup(sender.registrationGroup);
		return registrationGroup === invocationGroup || !registrationGroup.startsWith("workflow:");
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
			if (!stage.routeEligible) continue;
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
			if (![...requesterGroups].some((group) => invocationOwnsGroup(roster.group, group))) continue;
			if (selected !== undefined && selected !== roster.group) continue;
			for (const row of roster.possibleStages) {
				entries.push({
					kind: "workflow-future-stage",
					runId,
					target: row.target,
					queuedCount: row.queuedCount,
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

  private registerLiveWorkflowStageRoute(
    currentId: string,
    requestId: string,
    runId: string,
    stageKeys: readonly string[],
    capability: string,
  ): boolean {
		const uniqueStageKeys = [...new Set(stageKeys)];
		const owner = this.pendingStageRoutes.get(runId);
		if (owner === undefined || !owner.group.startsWith("workflow:")) return false;
		const rootRunId = owner.group.slice("workflow:".length);
		// D8 clarification: advertised targets are depth-faithful, so the live aliases must be
		// depth-faithful too. The roster publishes the id-form target per stage; the name form
		// swaps its final segment. Without a roster entry, fall back to the flat run-id prefix
		// (still an accepted resolver input).
		const roster = this.workflowRosters.get(runId);
		const targets = uniqueStageKeys.map((stageKey) => {
			const entry = roster?.stages.find((stage) => stage.stageId === stageKey || stage.stageName === stageKey);
			const entryTarget = entry === undefined ? undefined : parseWorkflowStageTarget(entry.target);
			if (entry !== undefined && entryTarget?.kind === "path") {
				if (stageKey !== entry.stageName) return entry.target;
				return (
					withWorkflowStageTargetFinalSegment(entry.target, entry.stageName) ?? entry.target
				);
			}
			const prefix = runId === rootRunId ? [] : [runId];
			return formatWorkflowStageTarget(rootRunId, ...prefix, stageKey);
		});
		for (const target of targets) {
			const existing = this.liveWorkflowStageRoutes.get(target);
      if (
        existing !== undefined &&
        existing.sessionId !== currentId &&
        this.sessions.has(existing.sessionId)
      ) {
        return false;
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
    return true;
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
        reason: "Target workflow run is in a different intercom group",
      });
      return true;
    }
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
		if (deliveredMatch !== "miss") {
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
					this.pendingQuestions.record(from.info.id, target.info.id, pending.messageId);
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
				this.pendingQuestions.record(from.info.id, target.info.id, pending.messageId);
			}
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivered",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
			});
			return;
		}
		if (reservation !== "recorded") {
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
		if (!writeMessageIfOpen(target.socket, { type: "message", from: pending.sender, message: pending.message })) {
			this.deliveredMessages.forget(pending.messageId, pending.signature);
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason: "Session not found",
			});
			return;
		}
		let accepted: ReturnType<DeliveredMessageCache["accept"]>;
		try {
			accepted = this.deliveredMessages.accept(pending.messageId, pending.signature, targetIdentity);
		} catch {
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
			});
			return;
		}
		if (accepted !== "accepted") {
			writeMessageIfOpen(pending.senderSocket, {
				type: "delivery_failed",
				messageId: pending.messageId,
				...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
				reason: "Intercom could not durably confirm the forwarded operation; refusing a possibly unsafe retry",
				...(accepted === "conflict" ? { reasonCode: "message_id_conflict" as const } : {}),
			});
			return;
		}
		if (pending.message.expectsReply === true) {
			this.pendingQuestions.record(from.info.id, target.info.id, pending.messageId);
		}
		if (pending.message.replyTo !== undefined) {
			this.pendingQuestions.clearReply(from.info.id, target.info.id, pending.message.replyTo);
		}
		writeMessageIfOpen(pending.senderSocket, {
			type: "delivered",
			messageId: pending.messageId,
			...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
		});
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
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }
		if (clientMessage.returnAddress !== undefined &&
			(typeof clientMessage.returnAddress !== "string" || clientMessage.returnAddress.length === 0)) {
			throw new Error("Invalid return address");
		}
		if (clientMessage.supervisorOwnerToken !== undefined
			&& (typeof clientMessage.supervisorOwnerToken !== "string" || !clientMessage.supervisorOwnerToken)) {
			throw new Error("Invalid supervisor owner token");
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

        const id = randomUUID();
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
          registrationGroup: legacyGroup,
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
        });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessageIfOpen(socket, supervisorId
          ? { type: "registered", sessionId: id, supervisorSessionId: supervisorId }
          : { type: "registered", sessionId: id });
        this.broadcastToMemberships({ type: "session_joined", session: info }, sessionGroups(info), id);
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
		const sessions =
			typeof clientMessage.group === "string"
				? this.canInspectSelectedGroup(requester, clientMessage.group)
					? sessionsInGroup(this.sessions, clientMessage.group)
					: []
				: sessionsVisibleTo(this.sessions, requester.info);
        writeMessageIfOpen(socket, {
			type: "sessions",
			requestId: clientMessage.requestId,
			sessions,
			workflowStages: this.workflowStagesVisibleTo(requester, clientMessage.group),
			workflowFutureStages: this.workflowFutureStagesVisibleTo(requester, clientMessage.group),
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

      case "register_pending_stage_route": {
        if (
          typeof clientMessage.runId !== "string" ||
          !clientMessage.runId ||
          typeof clientMessage.group !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability
        ) {
          throw new Error("Invalid pending-stage route registration");
        }
        const owner = this.sessions.get(currentId);
        const existing = this.pendingStageRoutes.get(clientMessage.runId);
        const ownerGroup = normalizeGroup(owner?.registrationGroup);
        const activeExisting = existing !== undefined && this.sessions.has(existing.sessionId) ? existing : undefined;
        if (
          owner === undefined ||
          normalizeGroup(clientMessage.group) !== ownerGroup ||
          (activeExisting !== undefined &&
            (activeExisting.capability !== clientMessage.capability || activeExisting.group !== ownerGroup))
        ) {
          writeMessageIfOpen(socket, { type: "registration_failed", reason: "Pending-stage route is not authorized" });
          this.endRefusedConnection(socket, currentId, setId);
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
          writeMessageIfOpen(socket, { type: "registration_failed", reason: "Invalid workflow-stage roster" });
          this.endRefusedConnection(socket, currentId, setId);
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
          writeMessageIfOpen(socket, { type: "registration_failed", reason: "Invalid workflow possible-stage roster" });
          this.endRefusedConnection(socket, currentId, setId);
          return;
        }
        // D7 (slice 4): presence replaces, absence keeps — a terminal root publishes `[]`
        // so the broker drops every future row, while nested runs' re-announcements (which
        // never carry the field) preserve the root's rows.
        const possibleStages =
          clientMessage.possibleStages !== undefined
            ? clientMessage.possibleStages
            : this.workflowRosters.get(clientMessage.runId)?.possibleStages;
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
            });
          }
          break;
        }
        this.pendingStageRoutes.set(clientMessage.runId, {
          sessionId: currentId,
          group: ownerGroup,
          capability: clientMessage.capability,
        });
        if (clientMessage.stages !== undefined || possibleStages !== undefined) {
          this.workflowRosters.set(clientMessage.runId, {
            ownerSessionId: currentId,
            group: ownerGroup,
            stages: clientMessage.stages ?? [],
            ...(possibleStages === undefined ? {} : { possibleStages }),
          });
        }
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
        if (!clientMessage.stageKeys.every((stageKey) => !stageKey.includes("/") && !stageKey.includes("*"))) {
          // A stage name containing "/" or "*" cannot be a canonical path segment, but throwing
          // here reaches the framing reader's onError and destroys the stage session's whole
          // broker connection. Refuse orderly like every neighbouring rejection; host clients
          // filter such name keys and register the stage-id key instead.
          writeMessageIfOpen(socket, {
            type: "registration_failed",
            reason: "Live workflow-stage route keys must be single path segments",
          });
          this.endRefusedConnection(socket, currentId, setId);
          return;
        }
        const ownerRegistration = this.pendingStageRoutes.get(clientMessage.runId);
        const registeringSession = this.sessions.get(currentId);
        if (
          ownerRegistration === undefined ||
          registeringSession === undefined ||
          ownerRegistration.capability !== clientMessage.capability ||
		  !invocationOwnsGroup(
			ownerRegistration.group,
			registeringSession.registrationGroup ?? registeringSession.info.group ?? "default",
		  ) ||
          !this.registerLiveWorkflowStageRoute(
            currentId,
            clientMessage.requestId,
            clientMessage.runId,
            clientMessage.stageKeys,
            clientMessage.capability,
          )
        ) {
          writeMessageIfOpen(socket, {
            type: "registration_failed",
            reason: "Live workflow-stage route is owned by another active session",
          });
          this.endRefusedConnection(socket, currentId, setId);
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
			handleBrokerSend(
				socket,
				clientMessage,
				currentId,
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
			);
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
        );
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private disconnectSession(sessionId: string): void {
    const departed = this.sessions.get(sessionId);
    if (!departed) return;

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
	this.sessions.delete(sessionId);
	this.broadcastToMemberships({ type: "session_left", sessionId }, sessionGroups(departed.info), sessionId);
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
    console.log("Broker shutting down");

    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    this.pendingStageRoutes.clear();
    this.pendingStageAcknowledgments.clear();
    this.liveWorkflowStageRoutes.clear();
    this.liveWorkflowStageRouteActivations.clear();
	for (const pending of this.pendingStageNotificationAcknowledgments.values()) clearTimeout(pending.timeout);
	this.pendingStageNotificationAcknowledgments.clear();
	this.deliveredMessages.close();
    const ownsRuntime = this.readPidFile() === process.pid;
    this.unlinkRuntimeFilesIfOwned();
    // Node unlinks a Unix socket path on server.close() even after a successor
    // rebound that path. Skip close when we no longer own the pid; process.exit
    // still closes our fd. Windows named pipes are not path-unlinked this way.
    if (process.platform === "win32" || ownsRuntime) {
      this.server.close();
    }
    process.exit(0);
  }
}

// The stderr cap is already in place: `./bounded-stderr-install.js` is this file's first import.
new IntercomBroker().start();
