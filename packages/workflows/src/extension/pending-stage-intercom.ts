import { getDurableBackend } from "../durable/factory.js";
import { durableBackendForRun, durableRootRunIdForRun } from "../durable/run-owner-backend.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import { workflowPendingStageRouteCapability } from "../shared/pending-stage-route-capability.js";
import {
	stageMatchesPathPattern,
	workflowBoundaryHops,
	workflowBoundarySegments,
} from "../shared/pending-stage-status.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
	PendingStickyStageMessageInput,
} from "../shared/store-types.js";
import {
	matchStagePathSegments,
	splitStagePathSegments,
	targetSegmentsInPossibleStages,
} from "../shared/workflow-stage-path-matching.js";
import {
	formatWorkflowStageTarget,
	parseWorkflowStageTarget,
	type WorkflowStageTarget,
} from "../shared/workflow-stage-target.js";

const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";
/** Broker → owner: the live stages a sticky broadcast was actually written to (D3 ledger input). */
const STICKY_LIVE_DELIVERED_EVENT = "atomic:workflow-sticky-live-delivered";
const PENDING_STAGE_ASK_REFUSAL =
	"Cannot ask a workflow stage whose session has not initialized. Use send; Atomic will queue the message until the stage session initializes.";

interface WorkflowEventSurface {
	readonly events?: {
		emit?(event: string, payload: Record<string, unknown>): void;
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?(event: "session_shutdown", listener: () => void): void;
}

interface PendingStageMessageEvent {
	handled: boolean;
	completion?: Promise<
		| {
				readonly outcome: "queued";
				readonly position: number;
				readonly notInKnownSet?: true;
				readonly forwardTargets?: readonly string[];
		  }
		| { readonly outcome: "delivered" }
		| { readonly outcome: "forward"; readonly target: string }
		| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" }
	>;
	readonly requestId?: string;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly from?: PendingStageSender;
	readonly runId?: string;
	readonly target?: string;
	readonly message?: PendingStageMessageInput["message"];
}

interface PendingStageUndeliverableEvent extends Record<string, unknown> {
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

export function registerPendingStageIntercomBridge(pi: WorkflowEventSurface, activeStore: Store): () => void {
	let disposed = false;
	let sweepPromise: Promise<void> = Promise.resolve();
	const notifyUndeliverable = async (
		entry: PendingStageMessage,
		reason: string,
		notificationId: string,
	): Promise<boolean> => {
		const payload: PendingStageUndeliverableEvent = {
			handled: false,
			runId: entry.runId,
			senderId: entry.from.id,
			...(entry.senderRegistrationName === undefined
				? {}
				: { senderRegistrationName: entry.senderRegistrationName }),
			...(entry.senderReturnAddress === undefined ? {} : { senderReturnAddress: entry.senderReturnAddress }),
			messageId: entry.message.id,
			notificationId,
			reason,
		};
		pi.events?.emit?.(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		return payload.handled && (await payload.completion) === true;
	};
	const announceRoutes = (): void => {
		if (disposed) return;
		const runs = activeStore.runs();
		for (const run of runs) {
			const rootRunId = durableRootRunIdForRun(runs, run.id);
			if (rootRunId === undefined) continue;
			pi.events?.emit?.(PENDING_STAGE_ROUTE_EVENT, {
				runId: run.id,
				group: workflowInvocationIntercomGroup(rootRunId),
				capability: workflowPendingStageRouteCapability(activeStore, run.id),
				stages: run.stages
					.filter(
						(stage) =>
							stage.pendingStageDeliveryAvailable === true &&
							(stage.status === "pending" ||
								stage.status === "running" ||
								stage.status === "awaiting_input" ||
								stage.status === "paused" ||
								stage.status === "blocked"),
					)
					.map((stage) => ({
						stageId: stage.id,
						stageName: stage.name,
						target: stageRouteTarget(runs, rootRunId, run.id, stage.id),
						lifecycle: stage.sessionId === undefined && stage.sessionFile === undefined ? "pending" : "running",
						routeEligible: true,
						group: stage.intercomGroup ?? workflowInvocationIntercomGroup(rootRunId),
					})),
				// D7 (slice 4): only the root run's roster registration carries the invocation's
				// possible-future rows. Presence replaces, so a terminal root publishes `[]` and
				// the broker drops the rows.
				...(run.id === rootRunId ? { possibleStages: possibleStageRows(runs, rootRunId, run) } : {}),
			});
		}
		sweepPromise = sweepPromise
			.then(() => settleUndeliverablePendingStageMessages(activeStore, notifyUndeliverable))
			.then(() => undefined)
			.catch((error: Error) => console.warn("atomic-workflows: pending stage delivery sweep failed", error));
	};
	const unsubscribeStore = activeStore.subscribeInvalidation(announceRoutes);
	announceRoutes();
	const subscription = pi.events?.on?.(PENDING_STAGE_MESSAGE_EVENT, (payload) => {
		if (disposed || !isPendingStageMessageEvent(payload) || payload.handled) return;
		const runs = activeStore.runs();
		const parsedTarget = parseWorkflowStageTarget(payload.target);
		if (parsedTarget === undefined) return;
		const destination = resolveMaterializedStage(runs, payload.target);
		if (destination === undefined) {
			// Slice 3 (D3/D4): an unresolved target (future stage, glob, or `**`) is accepted
			// speculatively as a sticky entry in the root run's durable bucket.
			if (payload.live === true) return;
			const rootRun = runs.find((candidate) => candidate.id === parsedTarget.rootRunId);
			if (rootRun === undefined) return;
			payload.handled = true;
			payload.completion = deliverStickyTarget(activeStore, runs, rootRun, payload, parsedTarget).then(
				(value) => {
					return value;
				},
				(error: Error) => {
					throw error;
				},
			);
			return;
		}
		const rootRunId = durableRootRunIdForRun(runs, destination.run.id);
		if (rootRunId === undefined) return;
		const resolvedEvent = {
			...payload,
			runId: destination.run.id,
			stageKey: destination.stage.id,
			target: payload.target,
		};
		const stage = destination.stage;
		const live = stage.sessionId !== undefined || stage.sessionFile !== undefined;
		// A terminal stage (completed/skipped/failed — e.g. reviewer-a after iteration 1)
		// cannot take a live forward: its alias is stale, so today's forward would fail
		// with "Session not found" (round-1 review). D3 keeps exactly-once queueing only
		// for materialized pending stages; a target that resolves to a terminal stage
		// falls through to the sticky branch so the next matching occurrence receives it.
		const stageTerminal = stage.status === "completed" || stage.status === "skipped" || stage.status === "failed";
		if (payload.live === true || (live && !stageTerminal)) {
			payload.handled = true;
			payload.completion = validateLiveDelivery(activeStore, resolvedEvent).then((result) =>
				result.outcome === "forward"
					? {
							outcome: "forward" as const,
							target: stageRouteTarget(runs, rootRunId, destination.run.id, stage.id),
						}
					: result,
			);
			return;
		}
		const uninitializedStage = knownUninitializedStage(destination.run, stage.id);
		if (uninitializedStage === undefined) {
			// Not live (the branch above took every live send) and not an exact
			// uninitialized stage: queue sticky for the next matching occurrence. Asks to
			// a resolved-but-terminal stage keep today's unknown-target refusal — only
			// future/pattern targets classify as pending_stage_ask_unsupported.
			if (payload.message.expectsReply === true) return;
			const stickyRoot = runs.find((candidate) => candidate.id === parsedTarget.rootRunId);
			if (stickyRoot === undefined || isTerminalRunStatus(stickyRoot.status)) return;
			payload.handled = true;
			payload.completion = deliverStickyTarget(activeStore, runs, stickyRoot, payload, parsedTarget);
			return;
		}
		payload.handled = true;
		payload.completion = queueAndPersist(
			activeStore,
			resolvedEvent,
			workflowInvocationIntercomGroup(rootRunId),
			stage.pendingStageDeliveryAvailable === true,
		);
	});
	const stickySubscription = pi.events?.on?.(STICKY_LIVE_DELIVERED_EVENT, (payload) => {
		if (disposed || !isStickyLiveDeliveredEvent(payload) || payload.handled) return;
		payload.handled = true;
		payload.completion = recordConfirmedStickyDeliveries(activeStore, payload);
	});
	const dispose = (): void => {
		disposed = true;
		unsubscribeStore();
		if (typeof subscription === "function") subscription();
		if (typeof stickySubscription === "function") stickySubscription();
	};
	pi.on?.("session_shutdown", dispose);
	return dispose;
}

/**
 * Canonical id-form target for one stage of `runId`, depth-faithful per the D8
 * clarification: one boundary segment per ancestor hop (boundary-stage name when it
 * is a valid single segment, else the materialized child-run id). Identical to the
 * roster announcement target, which is what the broker registers live aliases from.
 */
function stageRouteTarget(runs: ReturnType<Store["runs"]>, rootRunId: string, runId: string, stageId: string): string {
	const boundarySegments = runId === rootRunId ? [] : workflowBoundarySegments(runs, runId);
	return formatWorkflowStageTarget(rootRunId, ...(boundarySegments ?? [runId]), stageId);
}

/**
 * D7 (slice 4): possible-future rows for `intercom list`, derived from the persisted
 * scan (D10) plus the root run's sticky queue. Glob-free scan entries that already
 * name a route-eligible materialized stage are suppressed (they are announced as
 * materialized roster rows); pattern entries stay listed because future occurrences
 * still match them (D2/D3). The run-wide `workflow:<root>/**` broadcast row (D6) is
 * present whenever the root run is non-terminal, even with an empty scan; a terminal
 * root yields `[]` so the broker drops every future row.
 */
function possibleStageRows(
	runs: ReturnType<Store["runs"]>,
	rootRunId: string,
	rootRun: ReturnType<Store["runs"]>[number],
): { readonly target: string; readonly queuedCount: number }[] {
	if (isTerminalRunStatus(rootRun.status)) return [];
	const stickyQueued = (rootRun.pendingStageMessages ?? []).filter(
		(entry) => entry.sticky === true && entry.status === "queued",
	);
	const stickySegments = (entry: PendingStageMessage): readonly string[] | undefined => {
		const parsed = parseWorkflowStageTarget(entry.targetPath ?? entry.stageKey);
		return parsed?.rootRunId === rootRunId ? parsed.segments : undefined;
	};
	// The run-wide broadcast bucket (`workflow:<root>/**`) is its own target (D6): its
	// entries are counted on the broadcast row only, never on the scan rows below — a
	// bidirectional glob match would otherwise inflate every row with the same count.
	const scanEntries = stickyQueued.filter((entry) => {
		const segments = stickySegments(entry);
		return !(segments !== undefined && segments.length === 1 && segments[0] === "**");
	});
	const rows: { readonly target: string; readonly queuedCount: number }[] = [];
	for (const scanEntry of rootRun.possibleStages ?? []) {
		const rowSegments = splitStagePathSegments(scanEntry);
		if (rowSegments.length === 0 || rowSegments.some((segment) => segment.length === 0)) continue;
		if (
			!rowSegments.some((segment) => segment.includes("*")) &&
			materializedStageMatches(runs, rootRunId, rowSegments)
		) {
			continue;
		}
		rows.push({
			target: formatWorkflowStageTarget(rootRunId, ...rowSegments),
			queuedCount: scanEntries.filter((entry) => {
				const segments = stickySegments(entry);
				if (segments === undefined) return false;
				return matchStagePathSegments(rowSegments, segments) || matchStagePathSegments(segments, rowSegments);
			}).length,
		});
	}
	rows.push({
		target: formatWorkflowStageTarget(rootRunId, "**"),
		queuedCount: stickyQueued.filter((entry) => {
			const segments = stickySegments(entry);
			return segments !== undefined && segments.length === 1 && segments[0] === "**";
		}).length,
	});
	return rows;
}

/** True when a glob-free scan entry names a route-eligible materialized stage of the invocation. */
function materializedStageMatches(
	runs: ReturnType<Store["runs"]>,
	rootRunId: string,
	entrySegments: readonly string[],
): boolean {
	for (const run of runs) {
		if (durableRootRunIdForRun(runs, run.id) !== rootRunId) continue;
		const hops = workflowBoundaryHops(runs, run.id);
		if (hops === undefined) continue;
		for (const stage of run.stages) {
			if (stage.pendingStageDeliveryAvailable !== true) continue;
			if (
				stage.status !== "pending" &&
				stage.status !== "running" &&
				stage.status !== "awaiting_input" &&
				stage.status !== "paused" &&
				stage.status !== "blocked"
			) {
				continue;
			}
			if (stageMatchesPathPattern(entrySegments, hops, [stage.id, stage.name])) return true;
		}
	}
	return false;
}

function isPendingStageMessageEvent(value: unknown): value is PendingStageMessageEvent &
	Required<Pick<PendingStageMessageEvent, "from" | "runId" | "target" | "message">> & {
		readonly live?: boolean;
	} {
	if (typeof value !== "object" || value === null) return false;
	const event = value as PendingStageMessageEvent & { readonly live?: unknown };
	return (
		typeof event.handled === "boolean" &&
		(event.live === undefined || typeof event.live === "boolean") &&
		typeof event.runId === "string" &&
		typeof event.target === "string" &&
		parseWorkflowStageTarget(event.target) !== undefined &&
		typeof event.from?.id === "string" &&
		(event.from.name === undefined || typeof event.from.name === "string") &&
		(event.senderRegistrationName === undefined || typeof event.senderRegistrationName === "string") &&
		(event.senderReturnAddress === undefined || typeof event.senderReturnAddress === "string") &&
		typeof event.message?.id === "string" &&
		typeof event.message.timestamp === "number" &&
		typeof event.message.content?.text === "string"
	);
}

function resolveMaterializedStage(
	runs: ReturnType<Store["runs"]>,
	target: string,
):
	| {
			readonly run: ReturnType<Store["runs"]>[number];
			readonly stage: ReturnType<Store["runs"]>[number]["stages"][number];
	  }
	| undefined {
	const parsed = parseWorkflowStageTarget(target);
	if (parsed === undefined || parsed.kind !== "path") return undefined;
	const rootRun = runs.find((candidate) => candidate.id === parsed.rootRunId);
	if (rootRun === undefined) return undefined;
	let run: ReturnType<Store["runs"]>[number] = rootRun;
	for (const segment of parsed.segments.slice(0, -1)) {
		const currentRun = run;
		// A run-id segment may sit at any depth: the flat advertised form for a depth-2 run is
		// `workflow:<root>/<grandchildRunId>/<stageId>`, so match on the parsed invocation root
		// rather than requiring a direct child of the previous hop. Run ids win over boundary
		// stage names of the same spelling.
		const runById = runs.filter(
			(candidate) => candidate.id === segment && durableRootRunIdForRun(runs, candidate.id) === parsed.rootRunId,
		);
		if (runById.length === 1) {
			run = runById[0]!;
			continue;
		}
		const boundariesById = currentRun.stages.filter((stage) => stage.id === segment);
		const boundaries =
			boundariesById.length > 0 ? boundariesById : currentRun.stages.filter((stage) => stage.name === segment);
		const children = boundaries.flatMap((boundary) =>
			runs.filter((candidate) => candidate.parentRunId === currentRun.id && candidate.parentStageId === boundary.id),
		);
		if (children.length !== 1) return undefined;
		run = children[0]!;
	}
	const stageKey = parsed.segments.at(-1)!;
	const stagesById = run.stages.filter((stage) => stage.id === stageKey);
	const stages = stagesById.length > 0 ? stagesById : run.stages.filter((stage) => stage.name === stageKey);
	return stages.length === 1 ? { run, stage: stages[0]! } : undefined;
}

type ResolvedPendingStageMessageEvent = PendingStageMessageEvent &
	Required<Pick<PendingStageMessageEvent, "from" | "runId" | "target" | "message">> & {
		readonly stageKey: string;
	};

async function validateLiveDelivery(
	activeStore: Store,
	event: ResolvedPendingStageMessageEvent,
): Promise<
	| { readonly outcome: "queued"; readonly position: number }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "forward" }
	| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" }
> {
	const result = await activeStore.validateLiveStageMessage({
		runId: event.runId,
		stageKey: event.stageKey,
		from: event.from,
		message: event.message,
		queuedAt: new Date().toISOString(),
	});
	if (result === undefined) return { outcome: "refused", reason: "Session not found" };
	if (result.outcome === "forward" || result.outcome === "delivered" || result.outcome === "queued") return result;
	if (result.outcome === "undeliverable") {
		return { outcome: "refused", reason: result.reason ?? "Pending-stage delivery was refused" };
	}
	return {
		outcome: "refused",
		reason: `Intercom message ID '${result.messageId}' conflicts with the durable identity for ${event.target}`,
		reasonCode: "message_id_conflict",
	};
}

async function queueAndPersist(
	activeStore: Store,
	event: ResolvedPendingStageMessageEvent,
	runGroup: string,
	pendingStageDeliveryAvailable: boolean,
): Promise<
	| { readonly outcome: "queued"; readonly position: number }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "refused"; readonly reason: string }
> {
	if (event.message.expectsReply === true) {
		return { outcome: "refused", reason: PENDING_STAGE_ASK_REFUSAL };
	}
	if (!pendingStageDeliveryAvailable) {
		return {
			outcome: "refused",
			reason: `Workflow stage ${event.target} cannot receive Intercom messages before startup`,
		};
	}
	const request: PendingStageMessageInput = {
		runId: event.runId,
		stageKey: event.stageKey,
		from: event.from,
		...(event.senderRegistrationName === undefined ? {} : { senderRegistrationName: event.senderRegistrationName }),
		...(event.senderReturnAddress === undefined ? {} : { senderReturnAddress: event.senderReturnAddress }),
		message: event.message,
		queuedAt: new Date().toISOString(),
	};
	const rootBackend = getDurableBackend();
	const backend = durableBackendForRun(rootBackend, activeStore.runs(), event.runId);
	if (backend === undefined) return { outcome: "refused", reason: "Session not found" };
	// The broker has already authorized the immutable registration identity.
	// Preserve the sender identity in the durable entry, but use its current
	// invocation membership for the durable group check so an ordinary session
	// that explicitly joined workflow:<runId> can queue before stage startup.
	const senderGroup = event.from.groups?.includes(runGroup) === true ? runGroup : event.from.group;
	const result: PendingStageQueueResult | undefined = await activeStore.queueStageMessage(
		request,
		senderGroup,
		runGroup,
		backend,
	);
	if (result === undefined) return { outcome: "refused", reason: "Session not found" };
	if (!result.ok) {
		if (result.reason === "capacity") {
			return {
				outcome: "refused",
				reason: `Pending stage message queue is full (limit ${result.limit}) for ${event.target}`,
			};
		}
		if (result.reason === "message_id_conflict") {
			return {
				outcome: "refused",
				reason: `Intercom message ID '${result.messageId}' was already queued for ${event.target} with a different target, sender, or payload`,
			};
		}
		return { outcome: "refused", reason: "Target workflow run is in a different intercom group" };
	}
	if (result.entry.status === "delivered") return { outcome: "delivered" };
	if (result.entry.status === "undeliverable") {
		return {
			outcome: "refused",
			reason: result.entry.undeliverableReason ?? "Pending-stage delivery was refused",
		};
	}
	if (result.position === undefined) return { outcome: "refused", reason: "Pending-stage delivery was refused" };
	return { outcome: "queued", position: result.position };
}

/**
 * Slice 3 sticky delivery (D3/D4/D5/D6): persist one entry in the ROOT run's durable
 * bucket and answer `queued` (with `notInKnownSet` for speculative accepts). Matching
 * live stages are recorded as delivered immediately; the broker forwards the message to
 * them through the ordinary inbound admission path with the sender identity (D9).
 */
async function deliverStickyTarget(
	activeStore: Store,
	runs: ReturnType<Store["runs"]>,
	rootRun: ReturnType<Store["runs"]>[number],
	event: PendingStageMessageEvent & {
		readonly from: PendingStageSender;
		readonly target: string;
		readonly message: PendingStageMessageInput["message"];
	},
	parsedTarget: WorkflowStageTarget,
): Promise<
	| {
			readonly outcome: "queued";
			readonly position: number;
			readonly notInKnownSet?: true;
			readonly forwardTargets?: readonly string[];
	  }
	| { readonly outcome: "refused"; readonly reason: string }
> {
	const rootRunId = rootRun.id;
	const runGroup = workflowInvocationIntercomGroup(rootRunId);
	if (event.message.expectsReply === true) {
		return { outcome: "refused", reason: PENDING_STAGE_ASK_REFUSAL };
	}
	if (isTerminalRunStatus(rootRun.status)) {
		return {
			outcome: "refused",
			reason: `Workflow run ${rootRunId} terminated with status ${rootRun.status} before any stage matching ${event.target} started`,
		};
	}
	const notInKnownSet = targetSegmentsInPossibleStages(parsedTarget.segments, rootRun.possibleStages ?? [])
		? undefined
		: true;
	const liveMatches = matchingLiveStages(runs, rootRunId, parsedTarget.segments);
	const backend = durableBackendForRun(getDurableBackend(), runs, rootRunId);
	if (backend === undefined) return { outcome: "refused", reason: "Session not found" };
	const senderGroup = event.from.groups?.includes(runGroup) === true ? runGroup : event.from.group;
	const request: PendingStickyStageMessageInput = {
		runId: rootRunId,
		stageKey: event.target,
		from: event.from,
		...(event.senderRegistrationName === undefined ? {} : { senderRegistrationName: event.senderRegistrationName }),
		...(event.senderReturnAddress === undefined ? {} : { senderReturnAddress: event.senderReturnAddress }),
		message: event.message,
		queuedAt: new Date().toISOString(),
		targetPath: event.target,
		...(notInKnownSet === undefined ? {} : { notInKnownSet }),
	};
	const result = await activeStore.queueStickyStageMessage(request, senderGroup, runGroup, backend);
	if (result === undefined) return { outcome: "refused", reason: "Session not found" };
	if (!result.ok) {
		if (result.reason === "capacity") {
			return {
				outcome: "refused",
				reason: `Pending stage message queue is full (limit ${result.limit}) for ${event.target}`,
			};
		}
		if (result.reason === "message_id_conflict") {
			return {
				outcome: "refused",
				reason: `Intercom message ID '${result.messageId}' was already queued for ${event.target} with a different target, sender, or payload`,
			};
		}
		return { outcome: "refused", reason: "Target workflow run is in a different intercom group" };
	}
	// Live matches are forwarded by the broker, which then reports the targets it actually
	// wrote to (STICKY_LIVE_DELIVERED_EVENT); only those enter the durable ledger. Recording
	// before the write would mark a stage that blipped as delivered forever, and a retried
	// send would never re-forward to it. A dedup retry therefore re-forwards exactly the
	// live matches the ledger has not confirmed yet.
	const recordedDeliveries = result.entry.deliveries ?? [];
	const forwardTargets = liveMatches
		.filter(
			(match) =>
				!recordedDeliveries.some(
					(delivery) => delivery.runId === match.run.id && delivery.stageId === match.stage.id,
				),
		)
		.map((match) => match.target);
	return {
		outcome: "queued",
		position: result.position ?? 1,
		...(notInKnownSet === undefined ? {} : { notInKnownSet }),
		...(forwardTargets.length === 0 ? {} : { forwardTargets }),
	};
}

interface StickyLiveDeliveredEvent {
	handled: boolean;
	completion?: Promise<boolean>;
	readonly runId: string;
	readonly messageId: string;
	readonly target: string;
	readonly deliveredTargets: readonly string[];
}

function isStickyLiveDeliveredEvent(value: unknown): value is StickyLiveDeliveredEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Partial<StickyLiveDeliveredEvent>;
	return (
		typeof event.handled === "boolean" &&
		typeof event.runId === "string" &&
		typeof event.messageId === "string" &&
		typeof event.target === "string" &&
		Array.isArray(event.deliveredTargets) &&
		event.deliveredTargets.every((target) => typeof target === "string")
	);
}

/** Record the live deliveries the broker confirmed for one sticky entry (exactly-once per stage). */
async function recordConfirmedStickyDeliveries(activeStore: Store, event: StickyLiveDeliveredEvent): Promise<boolean> {
	const parsedTarget = parseWorkflowStageTarget(event.target);
	if (parsedTarget === undefined) return false;
	const runs = activeStore.runs();
	const rootRunId = parsedTarget.rootRunId;
	const rootRun = runs.find((candidate) => candidate.id === rootRunId);
	const entry = rootRun?.pendingStageMessages?.find(
		(candidate) => candidate.sticky === true && candidate.message.id === event.messageId,
	);
	if (rootRun === undefined || entry === undefined) return false;
	const delivered = new Set(event.deliveredTargets);
	const records = matchingLiveStages(runs, rootRunId, parsedTarget.segments)
		.filter((match) => delivered.has(match.target))
		.map((match) => ({
			runId: match.run.id,
			stageId: match.stage.id,
			...(match.stage.name === match.stage.id ? {} : { stageName: match.stage.name }),
		}));
	if (records.length === 0) return false;
	const backend = durableBackendForRun(getDurableBackend(), runs, rootRunId);
	if (backend === undefined) return false;
	return activeStore.recordPendingStageMessageDeliveries(
		rootRunId,
		entry.id,
		records,
		new Date().toISOString(),
		backend,
	);
}

/** Live stages of the invocation whose depth-faithful path (per D5 hop spellings) matches the target segments. */
function matchingLiveStages(
	runs: ReturnType<Store["runs"]>,
	rootRunId: string,
	patternSegments: readonly string[],
): {
	readonly run: ReturnType<Store["runs"]>[number];
	readonly stage: ReturnType<Store["runs"]>[number]["stages"][number];
	readonly target: string;
}[] {
	const matches: {
		readonly run: ReturnType<Store["runs"]>[number];
		readonly stage: ReturnType<Store["runs"]>[number]["stages"][number];
		readonly target: string;
	}[] = [];
	for (const run of runs) {
		if (durableRootRunIdForRun(runs, run.id) !== rootRunId) continue;
		const hops = workflowBoundaryHops(runs, run.id);
		if (hops === undefined) continue;
		for (const stage of run.stages) {
			const live = stage.sessionId !== undefined || stage.sessionFile !== undefined;
			if (!live || stage.pendingStageDeliveryAvailable !== true) continue;
			if (
				stage.status !== "pending" &&
				stage.status !== "running" &&
				stage.status !== "awaiting_input" &&
				stage.status !== "paused" &&
				stage.status !== "blocked"
			) {
				continue;
			}
			const idTarget = formatWorkflowStageTarget(rootRunId, ...hops.map((hop) => hop.name), stage.id);
			if (stageMatchesPathPattern(patternSegments, hops, [stage.id, stage.name])) {
				// The forward target stays in the announced boundary-name form: the broker's
				// live aliases are built from the roster's advertised targets.
				matches.push({ run, stage, target: idTarget });
			}
		}
	}
	return matches;
}

function knownUninitializedStage(
	run: ReturnType<Store["runs"]>[number],
	stageKey: string,
): ReturnType<Store["runs"]>[number]["stages"][number] | undefined {
	const exactIds = run.stages.filter((stage) => stage.id === stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === stageKey);
	if (candidates.length !== 1) return undefined;
	const stage = candidates[0]!;
	return (stage.status === "pending" || stage.status === "running") &&
		stage.sessionId === undefined &&
		stage.sessionFile === undefined
		? stage
		: undefined;
}

function pendingStageDestination(
	run: ReturnType<Store["runs"]>[number],
	entry: PendingStageMessage,
): ReturnType<Store["runs"]>[number]["stages"][number] | undefined {
	if (entry.stageId !== undefined) {
		const candidates = run.stages.filter((stage) => stage.id === entry.stageId);
		return candidates.length === 1 ? candidates[0] : undefined;
	}
	if (entry.stageReplayKey !== undefined) {
		const candidates = run.stages.filter((stage) => stage.replayKey === entry.stageReplayKey);
		return candidates.length === 1 ? candidates[0] : undefined;
	}
	const exactIds = run.stages.filter((stage) => stage.id === entry.stageKey);
	const candidates = exactIds.length > 0 ? exactIds : run.stages.filter((stage) => stage.name === entry.stageKey);
	return candidates.length === 1 ? candidates[0] : undefined;
}

function pendingStageUndeliverableReason(
	run: ReturnType<Store["runs"]>[number],
	entry: PendingStageMessage,
): string | undefined {
	// Sticky entries (D3) stay deliverable until the ROOT run terminates; there is no
	// per-stage skipped branch because any future matching stage must still receive them.
	if (entry.sticky === true) {
		const target = entry.targetPath ?? entry.stageKey;
		if (isTerminalRunStatus(run.status)) {
			return `Workflow run ${run.id} terminated with status ${run.status} before any stage matching ${target} started`;
		}
		return undefined;
	}
	const stage = pendingStageDestination(run, entry);
	if (run.status === "cancelled") {
		return `Workflow run ${run.id} terminated with status cancelled before stage ${entry.stageKey} started`;
	}
	if (stage?.status === "skipped") {
		return `Workflow stage ${entry.stageKey} was skipped${stage.skippedReason ? ` (${stage.skippedReason})` : ""}`;
	}
	if (isTerminalRunStatus(run.status)) {
		return `Workflow run ${run.id} terminated with status ${run.status} before stage ${entry.stageKey} started`;
	}
	return undefined;
}

function needsUndeliverableSettlement(run: ReturnType<Store["runs"]>[number], entry: PendingStageMessage): boolean {
	if (entry.status === "queued") return pendingStageUndeliverableReason(run, entry) !== undefined;
	return (
		entry.status === "undeliverable" &&
		entry.undeliverableNotificationId !== undefined &&
		entry.undeliverableNotifiedAt === undefined &&
		entry.undeliverableReason !== undefined
	);
}

/** Settle queued messages whose destination can no longer enter the pre-start lifecycle window. */
export async function settleUndeliverablePendingStageMessages(
	activeStore: Store,
	notify: (entry: PendingStageMessage, reason: string, notificationId: string) => Promise<boolean>,
): Promise<number> {
	const runs = activeStore.runs();
	if (!runs.some((run) => run.pendingStageMessages?.some((entry) => needsUndeliverableSettlement(run, entry)))) {
		return 0;
	}
	let settled = 0;
	const rootBackend = getDurableBackend();
	for (const run of runs) {
		const backend = durableBackendForRun(rootBackend, runs, run.id);
		if (backend === undefined) {
			throw new Error(`atomic-workflows: workflow run ${run.id} has no durable owner for pending-stage settlement`);
		}
		for (const snapshotEntry of run.pendingStageMessages ?? []) {
			let entry = snapshotEntry;
			if (
				entry.status === "queued" &&
				entry.sticky === true &&
				(entry.deliveryCount ?? 0) > 0 &&
				isTerminalRunStatus(run.status)
			) {
				if (
					await activeStore.settleStickyPendingStageMessageDelivered(
						run.id,
						entry.id,
						new Date().toISOString(),
						backend,
					)
				) {
					settled += 1;
				}
				continue;
			}
			if (entry.status === "queued") {
				const reason = pendingStageUndeliverableReason(run, entry);
				if (reason === undefined) continue;
				if (
					await activeStore.markPendingStageMessageUndeliverable(run.id, entry.stageKey, entry.id, reason, backend)
				) {
					settled += 1;
				}
				const currentRun = activeStore.runs().find((candidate) => candidate.id === run.id);
				const currentEntry = currentRun?.pendingStageMessages?.find(
					(candidate) => candidate.stageKey === entry.stageKey && candidate.id === entry.id,
				);
				if (currentEntry === undefined) continue;
				entry = currentEntry;
			}
			if (
				entry.status !== "undeliverable" ||
				entry.undeliverableNotificationId === undefined ||
				entry.undeliverableNotifiedAt !== undefined ||
				entry.undeliverableReason === undefined
			)
				continue;
			if (!(await notify(entry, entry.undeliverableReason, entry.undeliverableNotificationId))) continue;
			await activeStore.markPendingStageMessageUndeliverableNotified(
				run.id,
				entry.stageKey,
				entry.id,
				entry.undeliverableNotificationId,
				new Date().toISOString(),
				backend,
			);
		}
	}
	return settled;
}
