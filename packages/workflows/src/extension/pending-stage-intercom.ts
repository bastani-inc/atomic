import { outsideWorkflowExecutions } from "../durable/execution-context-boundary.js";
import { durableBackendForRun, durableRootRunIdForRun } from "../durable/run-owner-backend.js";
import { availableStoreDurableBackend, requireStoreDurableBackend } from "../durable/store-backend.js";
import { isSessionClosedError } from "../engine/session-closed-error.js";
import { externalRunRouteOwner, registerPendingStageMessageRouter } from "../shared/external-run-routes.js";
import {
	pendingStageSenderGroup,
	workflowInvocationGroupRefusal,
	workflowInvocationIntercomGroup,
	workflowInvocationOwnsGroup,
} from "../shared/intercom-group.js";
import { workflowPendingStageRouteCapability } from "../shared/pending-stage-route-capability.js";
import { registerWorkflowPendingStageRouteReadiness } from "../shared/pending-stage-route-readiness.js";
import {
	createWorkflowBoundaryHopsResolver,
	createWorkflowBoundarySegmentsResolver,
	isAddressableStageStatus,
	stageMatchesPathPattern,
	type WorkflowBoundarySegmentsResolver,
	workflowBoundarySegments,
} from "../shared/pending-stage-status.js";
import { knownScanEntries } from "../shared/possible-stage-prediction.js";
import type { StagePredictor } from "../shared/possible-stage-predictor.js";
import { type PossibleStageRow, PossibleStageRowsIndex, WorkflowTopologyIndex } from "../shared/possible-stage-rows.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import type { StoreRunChange } from "../shared/store-public-types.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
	PendingStickyStageMessageInput,
	RunSnapshot,
	StageSnapshot,
} from "../shared/store-types.js";
import {
	childRunsInSource,
	findRunInSource,
	invocationRunsInSource,
	type RunSource,
} from "../shared/workflow-run-ownership.js";
import { targetSegmentsInPossibleStages } from "../shared/workflow-stage-path-matching.js";
import {
	formatWorkflowStageTarget,
	parseWorkflowStageTarget,
	type WorkflowStageTarget,
} from "../shared/workflow-stage-target.js";
import type { ExtensionAPI } from "./public-types.js";
import { createWorkflowBackgroundWarningReporter } from "./workflow-background-warning.js";

const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
const PENDING_STAGE_UNDELIVERABLE_EVENT = "atomic:workflow-pending-stage-undeliverable";
/** Broker → owner: the live stages a sticky broadcast was actually written to (D3 ledger input). */
const STICKY_LIVE_DELIVERED_EVENT = "atomic:workflow-sticky-live-delivered";
const PENDING_STAGE_ASK_REFUSAL =
	"Cannot ask a workflow stage whose session has not initialized. Use send; Atomic will queue the message until the stage session initializes.";
const ROUTE_ANNOUNCEMENT_BATCH_MS = 25;
const ROUTE_ANNOUNCEMENT_EVENT_LOOP_SHARE = 0.2;
/**
 * The longest a route change waits for its batch, however slow announcing has been, so that throttling cannot hide a
 * route change for long. A batch waits four times the cost of an announcement to keep announcing to a fifth of the
 * event loop; a change to one run of a 1,000-run invocation costs about 30 ms to announce and the same change at 480
 * runs about 8 ms, which waits 120 ms and 32 ms, so the share holds at those sizes. Only an announcement over
 * 62.5 ms is held back for less than its share asks.
 */
const ROUTE_ANNOUNCEMENT_MAX_WAIT_MS = 250;
/**
 * How many recent announcements the wait is sized from. The median of three ignores one slow announcement, such as a
 * garbage collection pause or a preempted thread, which says nothing about what announcing costs, and follows
 * two slow announcements in three.
 */
const ROUTE_ANNOUNCEMENT_COST_SAMPLES = 3;

interface WorkflowEventSurface {
	readonly events?: {
		emit?(event: string, payload: Record<string, unknown>): void;
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?: ExtensionAPI["on"];
}

interface PendingStageMessageEvent {
	handled: boolean;
	completion?: Promise<
		| ({
				readonly outcome: "queued";
				readonly position: number;
				readonly forwardTargets?: readonly string[];
		  } & Partial<StickySendPrediction>)
		| { readonly outcome: "delivered" }
		| { readonly outcome: "forward"; readonly target: string }
		| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" }
	>;
	readonly requestId?: string;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly from?: PendingStageSender;
	/** #4006: the broker authorized the sender as the session that launched the run. */
	readonly invocationControl?: boolean;
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

/**
 * Route announcement payload. The consumer (the lightweight relay or the heavy
 * handler) attaches `completion` to the object in place, so the producer must
 * project its signature before emitting and read the acknowledgement after.
 */
interface PendingStageRouteEvent extends Record<string, unknown> {
	completion?: Promise<void>;
}

export function registerPendingStageIntercomBridge(
	pi: WorkflowEventSurface,
	activeStore: Store,
	ownsRun: (runId: string) => boolean = () => true,
	predictor?: StagePredictor,
): (() => void) & { flush(): Promise<void>; refresh(): void } {
	let disposed = false;
	let sweepPromise: Promise<void> = Promise.resolve();
	const reportWarning = createWorkflowBackgroundWarningReporter(pi);
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
		// A pooled run's route lives in its pool coordinator; only that route can notify the sender.
		const external = externalRunRouteOwner(activeStore, entry.runId);
		if (external !== undefined) return external.notifyUndeliverable(payload);
		pi.events?.emit?.(PENDING_STAGE_UNDELIVERABLE_EVENT, payload);
		return payload.handled && (await payload.completion) === true;
	};
	/**
	 * Latest route payload this bridge claims to have published, per run id.
	 *
	 * Every store invalidation republished every run, so tool events, attachment
	 * changes, and notices — none of which alter the route projection — each cost a
	 * broker round trip whose `listSessions()` barrier can expire on its own timer.
	 * The cache is bridge-local: a new bridge, or a run whose durable owner is gone,
	 * starts with no claim. An entry records a *claim*, not proof of acknowledgement,
	 * so a rejected or unacknowledged emission invalidates it again below.
	 */
	const announcedRoutes = new Map<string, { readonly signature: string }>();
	// Keep rejected completions separate from the publication cache: failure is not
	// an absent optional consumer, even if it settled before a stage began waiting.
	const routeCompletions = new Map<string, Promise<void>>();
	/**
	 * Per claimed publication, settles once its consumer answered it, acknowledged or refused, and the event loop has
	 * turned since it went out. The entry is removed when it settles.
	 */
	const unansweredPublications = new WeakMap<Promise<void>, Promise<void>>();
	/**
	 * A starting stage waits for a publication of its run's changes. While the run's last publication is unanswered,
	 * a stage with changes to announce waits for that answer, then announces every change made meanwhile once, so a
	 * burst of starting stages costs two roster publications rather than one each (#4376).
	 */
	const routeReady = (runId: string): Promise<void> | undefined => {
		const latest = routeCompletions.get(runId);
		const unanswered = latest && unansweredPublications.get(latest);
		if (unanswered === undefined || !announcementPending) {
			announceIfPending();
			return routeCompletions.get(runId);
		}
		return unanswered.then(() => {
			announceIfPending();
			return routeCompletions.get(runId);
		});
	};
	const disposeReadiness = registerWorkflowPendingStageRouteReadiness(activeStore, routeReady);
	// Root ownership, boundary hops and possible-stage rows carry over between announcements and
	// recompute only what changed; a root run's rows and their delivery states keep their identity
	// while unchanged, so its announcement is compared by row identity rather than re-serialized.
	const topology = new WorkflowTopologyIndex();
	const possibleStageRowIndexes = new Map<string, PossibleStageRowsIndex>();
	const rowIdentities = new WeakMap<PossibleStageRow, number>();
	let nextRowIdentity = 0;
	const rowIdentity = (row: PossibleStageRow): number => {
		let identity = rowIdentities.get(row);
		if (identity === undefined) {
			identity = nextRowIdentity++;
			rowIdentities.set(row, identity);
		}
		return identity;
	};
	const possibleStageRowsIndex = (rootRunId: string): PossibleStageRowsIndex => {
		let index = possibleStageRowIndexes.get(rootRunId);
		if (index === undefined) {
			index = new PossibleStageRowsIndex(rootRunId, topology);
			possibleStageRowIndexes.set(rootRunId, index);
		}
		return index;
	};
	/**
	 * Per root, the ids of the runs that name it as their topology root or their declared root, in store order, as
	 * the last full announcement saw them. A change that leaves every lineage alone leaves these alone too.
	 */
	let rootRunMembers = new Map<string, string[]>();
	const membersOf = (rootRunId: string): readonly RunSnapshot[] =>
		(rootRunMembers.get(rootRunId) ?? []).flatMap((runId) => {
			const run = activeStore.run(runId);
			return run === undefined ? [] : [run];
		});
	const dropRoute = (runId: string): void => {
		announcedRoutes.delete(runId);
		routeCompletions.delete(runId);
		possibleStageRowIndexes.delete(runId);
	};
	/**
	 * Runs whose last route no consumer claimed or whose publication failed. Every announcement used to publish them
	 * again, whichever run changed; an announcement scoped to changed runs publishes them again too.
	 */
	const unpublishedRunIds = new Set<string>();
	const announceRun = (run: RunSnapshot, rootRunId: string, lookups: RouteLookups): void => {
		const parentRun = lookups.parentOf(run);
		const boundary = parentRun?.stages.find((stage) => stage.id === run.parentStageId);
		const parent =
			parentRun === undefined || boundary === undefined
				? undefined
				: {
						runId: parentRun.id,
						stageKeys: [boundary.id, boundary.name].filter(
							(key) => lookups.childAt(parentRun, key)?.id === run.id,
						),
					};
		let possibleStages: readonly PossibleStageRow[] | undefined;
		if (run.id === rootRunId && isTerminalRunStatus(run.status)) {
			// A terminal root publishes no rows; its cached rows and statuses are released, and a resumed
			// root rebuilds them on its next announcement.
			possibleStageRowIndexes.delete(rootRunId);
			possibleStages = [];
		} else if (run.id === rootRunId) {
			possibleStages = possibleStageRowsIndex(rootRunId).rows(
				lookups.rowRuns(rootRunId),
				run,
				availableStoreDurableBackend(activeStore, rootRunId),
				lookups.runs,
			);
		}
		const announcement: PendingStageRouteEvent = {
			runId: run.id,
			group: workflowInvocationIntercomGroup(rootRunId),
			capability: workflowPendingStageRouteCapability(activeStore, run.id),
			...(parent === undefined ? {} : { parent }),
			stages: [
				...run.stages
					.filter(
						(stage) =>
							!isNonAgentStage(stage) &&
							workflowInvocationOwnsGroup(
								workflowInvocationIntercomGroup(rootRunId),
								stage.intercomGroup ?? workflowInvocationIntercomGroup(rootRunId),
							),
					)
					.map((stage) => ({
						stageId: stage.id,
						stageName: stage.name,
						target: stageRouteTarget(lookups.runs, rootRunId, run.id, stage.id, lookups.segments),
						lifecycle:
							stage.status === "waiting" || (stage.sessionId === undefined && stage.sessionFile === undefined)
								? "pending"
								: "running",
						// Keep agent identity for alias reactivation even after discovery eligibility ends.
						routeEligible: stage.pendingStageDeliveryAvailable === true && isAddressableStageStatus(stage.status),
						group: stage.intercomGroup ?? workflowInvocationIntercomGroup(rootRunId),
					})),
				// Known ctx.ui/ctx.tool identities must not become speculative agents.
				...nonAgentNodes(run).map((node) => ({
					stageId: node.id,
					stageName: node.name,
					target: stageRouteTarget(lookups.runs, rootRunId, run.id, node.id, lookups.segments),
					lifecycle: "pending",
					routeEligible: false,
					recipientPurpose: "control",
					group: workflowInvocationIntercomGroup(rootRunId),
				})),
			],
			// D7 (slice 4): only the root run's roster registration carries the invocation's
			// possible-future rows. Presence replaces, so a terminal root publishes `[]` and
			// the broker drops the rows.
			...(possibleStages === undefined ? {} : { possibleStages }),
		};
		// Compute the signature *before* emitting: the consumer mutates the payload
		// by attaching `completion`, so a post-emit projection would never match.
		// Possible-stage rows keep their identity exactly while their content is unchanged.
		const signature =
			possibleStages === undefined
				? JSON.stringify(announcement)
				: `${JSON.stringify({ ...announcement, possibleStages: undefined })}\u0000${possibleStages.map(rowIdentity).join(",")}`;
		if (announcedRoutes.get(run.id)?.signature === signature) return;
		// Different snapshots are never debounced or serialized: A → B → A publishes
		// all three immediately, even while an earlier completion is outstanding.
		// Delaying a real change would hide new stages, nested aliases, and terminal
		// rosters behind a slow acknowledgement.
		const entry = { signature };
		announcedRoutes.set(run.id, entry);
		try {
			// Intercom may open this session's own broker connection for the route; opened inside the
			// run's execution, every later inbound message would start host turns inside it once it retires.
			outsideWorkflowExecutions(() => pi.events?.emit?.(PENDING_STAGE_ROUTE_EVENT, announcement));
		} catch (error) {
			// Never cache a failed emission; the store observer owns the error.
			if (announcedRoutes.get(run.id) === entry) announcedRoutes.delete(run.id);
			unpublishedRunIds.add(run.id);
			const failure = Promise.reject<void>(error);
			void failure.catch(() => {});
			routeCompletions.set(run.id, failure);
			throw error;
		}
		// Both the lightweight relay and the direct heavy handler assign this
		// synchronously. It is observed, never awaited here and never overwritten.
		const completion = announcement.completion;
		if (completion === undefined) {
			// No consumer claimed it: an absent event surface or a not-yet-installed
			// relay must not make the route look published. Retry next invalidation.
			announcedRoutes.delete(run.id);
			routeCompletions.delete(run.id);
			unpublishedRunIds.add(run.id);
		} else {
			routeCompletions.set(run.id, completion);
			unansweredPublications.set(
				completion,
				Promise.allSettled([completion, nextEventLoopTurn()]).then(() => {
					unansweredPublications.delete(completion);
				}),
			);
			completion.catch(() => {
				// Identity, not signature: an older rejected A must not evict the
				// newer A published after A → B → A. Reporting is the relay's job.
				if (announcedRoutes.get(run.id) !== entry) return;
				announcedRoutes.delete(run.id);
				unpublishedRunIds.add(run.id);
			});
		}
	};
	/** Every run's route, announced after a change not scoped to runs or one that changed a run's lineage. */
	const announceAllRoutes = (): void => {
		unpublishedRunIds.clear();
		const ownedRunIds = new Set<string>();
		const runs = activeStore.runs();
		topology.refresh(runs);
		const runById = new Map(runs.map((run) => [run.id, run]));
		const childrenByBoundary = new Map<string, RunSnapshot[]>();
		for (const run of runs) {
			if (run.parentRunId === undefined || run.parentStageId === undefined) continue;
			const key = JSON.stringify([run.parentRunId, run.parentStageId]);
			const children = childrenByBoundary.get(key) ?? [];
			children.push(run);
			childrenByBoundary.set(key, children);
		}
		const lookups: RouteLookups = {
			runs,
			parentOf: (run) => (run.parentRunId === undefined ? undefined : runById.get(run.parentRunId)),
			childAt: (parent, segment) => resolveIndexedChildRun(childrenByBoundary, parent, segment),
			segments: createWorkflowBoundarySegmentsResolver(runs),
			rowRuns: () => runs,
		};
		const members = new Map<string, string[]>();
		for (const run of runs) {
			const rootRunId = topology.rootOf(run.id);
			for (const root of new Set([rootRunId, run.rootRunId])) {
				if (root === undefined) continue;
				const ids = members.get(root);
				if (ids === undefined) members.set(root, [run.id]);
				else ids.push(run.id);
			}
			// Externally routed (pooled) runs are announced by their coordinator, never from here.
			if (externalRunRouteOwner(activeStore, run.id) !== undefined || !ownsRun(run.id)) continue;
			if (rootRunId === undefined) continue;
			ownedRunIds.add(run.id);
			announceRun(run, rootRunId, lookups);
		}
		rootRunMembers = members;
		// Drop claims for runs with no currently resolvable durable owner, so a removed
		// and re-added run re-announces instead of inheriting a stale claim.
		for (const runId of announcedRoutes.keys()) {
			if (!ownedRunIds.has(runId)) announcedRoutes.delete(runId);
		}
		for (const runId of routeCompletions.keys()) {
			if (!ownedRunIds.has(runId)) routeCompletions.delete(runId);
		}
		for (const rootRunId of possibleStageRowIndexes.keys()) {
			if (!ownedRunIds.has(rootRunId)) possibleStageRowIndexes.delete(rootRunId);
		}
	};
	/**
	 * The routes a change to these runs can alter, found by id: every run of each invocation a changed run belongs to
	 * or names as its declared root. Valid only while no run's lineage changed, so every other route still holds.
	 */
	const announceChangedRoutes = (changed: ReadonlySet<string>): void => {
		const retried = [...unpublishedRunIds];
		unpublishedRunIds.clear();
		const roots = new Set<string>();
		for (const runId of [...changed, ...retried])
			for (const root of [topology.rootOf(runId), activeStore.run(runId)?.rootRunId])
				if (root !== undefined && rootRunMembers.has(root)) roots.add(root);
		const segments = new Map<string, readonly string[] | undefined>();
		const lookups: RouteLookups = {
			runs: activeStore,
			parentOf: (run) => (run.parentRunId === undefined ? undefined : activeStore.run(run.parentRunId)),
			childAt: (parent, segment) => resolveChildRun(activeStore, parent, segment),
			segments: (runId) => {
				if (!segments.has(runId)) segments.set(runId, workflowBoundarySegments(activeStore, runId));
				return segments.get(runId);
			},
			rowRuns: membersOf,
		};
		const position = (runId: string) => activeStore.runPosition(runId) ?? Number.MAX_SAFE_INTEGER;
		for (const rootRunId of [...roots].sort((left, right) => position(left) - position(right))) {
			for (const run of membersOf(rootRunId)) {
				if (topology.rootOf(run.id) !== rootRunId) continue;
				if (externalRunRouteOwner(activeStore, run.id) !== undefined || !ownsRun(run.id)) dropRoute(run.id);
				else announceRun(run, rootRunId, lookups);
			}
		}
	};
	/** Runs a sweep last found with settlement work; a scoped sweep looks at them again. */
	const unsettledRunIds = new Set<string>();
	const sweep = async (changed: ReadonlySet<string> | undefined): Promise<void> => {
		const runIds = changed === undefined ? undefined : new Set([...changed, ...unsettledRunIds]);
		const found = new Set<string>();
		try {
			await settleUndeliverablePendingStageMessages(activeStore, notifyUndeliverable, ownsRun, runIds, (runId) =>
				found.add(runId),
			);
		} finally {
			if (runIds === undefined) unsettledRunIds.clear();
			else for (const runId of runIds) unsettledRunIds.delete(runId);
			for (const runId of found) if (hasSettlementWork(activeStore.run(runId))) unsettledRunIds.add(runId);
		}
	};
	/**
	 * Announces the routes the changed runs can alter and sweeps those runs, or, when `changed` is undefined or a
	 * changed run's lineage moved, announces every route and sweeps every run.
	 */
	const announceRoutes = (changed: ReadonlySet<string> | undefined): void => {
		if (disposed) return;
		const scope = changed !== undefined && topology.holds(activeStore, changed) ? changed : undefined;
		if (scope === undefined) announceAllRoutes();
		else announceChangedRoutes(scope);
		sweepPromise = sweepPromise
			.then(() => outsideWorkflowExecutions(() => sweep(scope)))
			.then(() => undefined)
			.catch((error: Error) =>
				reportWarning(`atomic-workflows: pending stage delivery sweep failed: ${error.message}`),
			);
	};
	let announcementPending = false;
	let announcementTimer: ReturnType<typeof setTimeout> | undefined;
	let announcedAt = Number.NEGATIVE_INFINITY;
	/** The wall times of the last few announcements, oldest first. */
	const announcementCosts: number[] = [];
	/** Their median; an announcement not yet recorded counts as free, so one sample never sets it. */
	const typicalAnnouncementCost = (): number => {
		const costs = [...announcementCosts];
		while (costs.length < ROUTE_ANNOUNCEMENT_COST_SAMPLES) costs.push(0);
		return costs.sort((left, right) => left - right)[Math.floor(costs.length / 2)] ?? 0;
	};
	/** Runs changed since the last announcement; undefined once a change was not scoped to runs. */
	let changedRunIds: Set<string> | undefined = new Set();
	const announceNow = (everything = false): void => {
		if (announcementTimer !== undefined) clearTimeout(announcementTimer);
		announcementTimer = undefined;
		announcementPending = false;
		const changed = everything ? undefined : changedRunIds;
		changedRunIds = new Set();
		const started = performance.now();
		try {
			announceRoutes(changed);
		} catch (error) {
			// The changes this announcement did not finish are unknown; the next one announces every route.
			changedRunIds = undefined;
			throw error;
		}
		announcedAt = performance.now();
		announcementCosts.push(announcedAt - started);
		if (announcementCosts.length > ROUTE_ANNOUNCEMENT_COST_SAMPLES) announcementCosts.shift();
	};
	function announceIfPending(): void {
		if (announcementPending) announceNow();
	}
	const announceBatch = (): void => {
		try {
			announceNow();
		} catch (error) {
			if (error instanceof Error && isSessionClosedError(error)) {
				dispose();
				return;
			}
			try {
				reportWarning(`atomic-workflows: pending stage route announcement failed: ${String(error)}`);
			} catch {
				dispose();
			}
		}
	};
	// Store invalidations are batched: a burst becomes one announcement after a short window, stretched when needed
	// so announcing stays under a fixed share of the event loop, by the typical cost of recent announcements and for
	// at most the cap. The batch carries the runs its invalidations named, so a change to one run announces only its
	// invocation's routes. Readiness, flush and refresh announce a pending batch first.
	const scheduleAnnouncement = (changes?: readonly StoreRunChange[]): void => {
		if (disposed) return;
		if (changes === undefined) changedRunIds = undefined;
		else if (changedRunIds !== undefined) for (const change of changes) changedRunIds.add(change.runId);
		if (announcementTimer !== undefined) return;
		const cost = typicalAnnouncementCost();
		const idle = cost / ROUTE_ANNOUNCEMENT_EVENT_LOOP_SHARE - cost;
		const wait = Math.min(
			ROUTE_ANNOUNCEMENT_MAX_WAIT_MS,
			Math.max(ROUTE_ANNOUNCEMENT_BATCH_MS, announcedAt + idle - performance.now()),
		);
		announcementPending = true;
		announcementTimer = setTimeout(announceBatch, wait);
		announcementTimer.unref?.();
	};
	const unsubscribeStore = activeStore.subscribeInvalidation(scheduleAnnouncement);
	announceNow(true);
	pi.on?.("session_start", () => {
		announcedRoutes.clear();
		announceNow(true);
	});
	const routePendingStageMessage = (payload: unknown): void => {
		if (disposed || !isPendingStageMessageEvent(payload) || payload.handled) return;
		const parsedTarget = parseWorkflowStageTarget(payload.target);
		if (parsedTarget === undefined) return;
		if (!ownsRun(parsedTarget.rootRunId)) return;
		if (parsedTarget.kind === "path" && isMaterializedNonAgentTarget(activeStore, parsedTarget)) {
			payload.handled = true;
			payload.completion = Promise.resolve({
				outcome: "refused",
				reason: "Target is a non-agent workflow node and cannot receive Intercom messages",
			});
			return;
		}
		const destination = resolveMaterializedStage(activeStore, payload.target);
		if (destination === undefined) {
			// Slice 3 (D3/D4): an unresolved target (future stage, glob, or `**`) is accepted
			// speculatively as a sticky entry in the root run's durable bucket.
			if (payload.live === true) return;
			const rootRun = activeStore.run(parsedTarget.rootRunId);
			if (rootRun === undefined) return;
			payload.handled = true;
			payload.completion = deliverStickyTarget(activeStore, rootRun, payload, parsedTarget, predictor).then(
				(value) => {
					return value;
				},
				(error: Error) => {
					throw error;
				},
			);
			return;
		}
		const rootRunId = durableRootRunIdForRun(activeStore, destination.run.id);
		if (rootRunId === undefined) return;
		const resolvedEvent = {
			...payload,
			runId: destination.run.id,
			stageKey: destination.stage.id,
			target: payload.target,
		};
		const stage = destination.stage;
		// A waiting stage released its session: a send to it queues until the stage reopens that session.
		const live = stage.status !== "waiting" && (stage.sessionId !== undefined || stage.sessionFile !== undefined);
		// A terminal stage (completed/skipped/failed — e.g. reviewer-a after iteration 1)
		// cannot take a live forward: its alias is stale, so today's forward would fail
		// with "Session not found" (round-1 review). D3 keeps exactly-once queueing only
		// for materialized pending stages; a target that resolves to a terminal stage
		// falls through to the sticky branch so the next matching occurrence receives it.
		const stageTerminal = stage.status === "completed" || stage.status === "skipped" || stage.status === "failed";
		if ((payload.live === true && stage.status !== "waiting") || (live && !stageTerminal)) {
			payload.handled = true;
			payload.completion = validateLiveDelivery(activeStore, resolvedEvent).then((result) =>
				result.outcome === "forward"
					? {
							outcome: "forward" as const,
							target: stageRouteTarget(activeStore, rootRunId, destination.run.id, stage.id),
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
			const stickyRoot = activeStore.run(parsedTarget.rootRunId);
			if (stickyRoot === undefined || isTerminalRunStatus(stickyRoot.status)) return;
			payload.handled = true;
			payload.completion = deliverStickyTarget(activeStore, stickyRoot, payload, parsedTarget, predictor);
			return;
		}
		payload.handled = true;
		payload.completion = queueAndPersist(
			activeStore,
			resolvedEvent,
			workflowInvocationIntercomGroup(rootRunId),
			stage.pendingStageDeliveryAvailable === true,
		);
	};
	const routeStickyLiveDelivered = (payload: unknown): void => {
		if (disposed || !isStickyLiveDeliveredEvent(payload) || payload.handled) return;
		payload.handled = true;
		payload.completion = outsideWorkflowExecutions(() => recordConfirmedStickyDeliveries(activeStore, payload));
	};
	const subscription = pi.events?.on?.(PENDING_STAGE_MESSAGE_EVENT, (payload) =>
		outsideWorkflowExecutions(() => routePendingStageMessage(payload)),
	);
	const stickySubscription = pi.events?.on?.(STICKY_LIVE_DELIVERED_EVENT, routeStickyLiveDelivered);
	// Messages that reach an externally owned (pooled) run's route are routed through this store's bridge.
	const disposeRouter = registerPendingStageMessageRouter(activeStore, {
		route: (payload) => outsideWorkflowExecutions(() => routePendingStageMessage(payload)),
		sticky: routeStickyLiveDelivered,
	});
	const dispose = (): void => {
		disposed = true;
		if (announcementTimer !== undefined) clearTimeout(announcementTimer);
		announcementTimer = undefined;
		announcementPending = false;
		disposeReadiness();
		disposeRouter();
		routeCompletions.clear();
		unsubscribeStore();
		if (typeof subscription === "function") subscription();
		if (typeof stickySubscription === "function") stickySubscription();
		// A replacement bridge over the same store starts with no claims, and a
		// completion still pending across disposal cannot evict the replacement's.
		announcedRoutes.clear();
	};
	pi.on?.("session_shutdown", dispose);
	return Object.assign(dispose, {
		async flush() {
			announceIfPending();
			await Promise.allSettled(routeCompletions.values());
			await sweepPromise;
		},
		/** Announces every route, as after a change of which runs the bridge owns. */
		refresh: () => announceNow(true),
	});
}

/** What a run's route announcement reads besides the run, from a pass over every run or by id. */
interface RouteLookups {
	readonly runs: RunSource;
	readonly parentOf: (run: RunSnapshot) => RunSnapshot | undefined;
	/** The one child run a parent's boundary stage, named by id or name, leads to. */
	readonly childAt: (parent: RunSnapshot, segment: string) => RunSnapshot | undefined;
	readonly segments: WorkflowBoundarySegmentsResolver;
	/** The runs that name the root as their topology root or declared root, in store order. */
	readonly rowRuns: (rootRunId: string) => readonly RunSnapshot[];
}

/**
 * Canonical id-form target for one stage of `runId`, depth-faithful per the D8
 * clarification: one boundary segment per ancestor hop (boundary-stage name when it
 * resolves to that child, else the materialized child-run id). Identical to the
 * roster announcement target, which is what the broker registers live aliases from.
 */
function stageRouteTarget(
	runs: RunSource,
	rootRunId: string,
	runId: string,
	stageId: string,
	resolveBoundarySegments: WorkflowBoundarySegmentsResolver = (id) => workflowBoundarySegments(runs, id),
): string {
	const boundarySegments = runId === rootRunId ? [] : resolveBoundarySegments(runId);
	return formatWorkflowStageTarget(rootRunId, ...(boundarySegments ?? [runId]), stageId);
}

/** Settles after the work already queued on the event loop, as the answer of a consumer across a socket would. */
function nextEventLoopTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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

function isNonAgentStage(stage: StageSnapshot): boolean {
	// The executor gives synthetic ctx.ui nodes a persisted prompt replay identity.
	// pendingPrompt/footprints alone also occur on genuine model stages.
	return stage.nodeKind === "tool" || stage.replayKey?.startsWith("prompt:") === true;
}

function nonAgentNodes(run: ReturnType<Store["runs"]>[number]): { readonly id: string; readonly name: string }[] {
	return [
		...run.toolNodes,
		...run.stages.filter(isNonAgentStage).flatMap((stage) => {
			const prompt = stage.pendingPrompt ?? stage.promptFootprint;
			return [stage, ...(prompt === undefined ? [] : [{ id: prompt.id, name: prompt.kind }])];
		}),
		...(run.pendingPrompt === undefined ? [] : [{ id: run.pendingPrompt.id, name: run.pendingPrompt.kind }]),
	];
}

function isMaterializedNonAgentTarget(runs: RunSource, target: WorkflowStageTarget): boolean {
	const run = resolveMaterializedRun(runs, target);
	if (run === undefined) return false;
	const stageKey = target.segments.at(-1);
	const byId = run.stages.filter((stage) => stage.id === stageKey);
	const matches = byId.length > 0 ? byId : run.stages.filter((stage) => stage.name === stageKey);
	// Multiple genuine matches are ambiguous, not evidence of a non-agent target.
	if (matches.some((stage) => !isNonAgentStage(stage))) return false;
	return nonAgentNodes(run).some((node) => node.id === stageKey || node.name === stageKey);
}

/** `resolveChildRun` over a precomputed `[parentRunId, parentStageId]` index of child runs. */
function resolveIndexedChildRun(
	childrenByBoundary: ReadonlyMap<string, readonly ReturnType<Store["runs"]>[number][]>,
	parent: ReturnType<Store["runs"]>[number],
	segment: string,
): ReturnType<Store["runs"]>[number] | undefined {
	const boundariesById = parent.stages.filter((stage) => stage.id === segment);
	const boundaries =
		boundariesById.length > 0 ? boundariesById : parent.stages.filter((stage) => stage.name === segment);
	const children = boundaries.flatMap(
		(boundary) => childrenByBoundary.get(JSON.stringify([parent.id, boundary.id])) ?? [],
	);
	return children.length === 1 ? children[0] : undefined;
}

function resolveChildRun(
	runs: RunSource,
	parent: ReturnType<Store["runs"]>[number],
	segment: string,
): ReturnType<Store["runs"]>[number] | undefined {
	const boundariesById = parent.stages.filter((stage) => stage.id === segment);
	const boundaries =
		boundariesById.length > 0 ? boundariesById : parent.stages.filter((stage) => stage.name === segment);
	const children = boundaries.flatMap((boundary) => childRunsInSource(runs, parent.id, boundary.id));
	return children.length === 1 ? children[0] : undefined;
}

function resolveMaterializedRun(
	runs: RunSource,
	parsed: WorkflowStageTarget,
): ReturnType<Store["runs"]>[number] | undefined {
	if (parsed.kind !== "path") return undefined;
	const rootRun = findRunInSource(runs, parsed.rootRunId);
	if (rootRun === undefined) return undefined;
	let run: ReturnType<Store["runs"]>[number] = rootRun;
	for (const segment of parsed.segments.slice(0, -1)) {
		// A run-id segment may sit at any depth: the flat advertised form for a depth-2 run is
		// `workflow:<root>/<grandchildRunId>/<stageId>`, so match on the parsed invocation root
		// rather than requiring a direct child of the previous hop. Run ids win over boundary
		// stage names of the same spelling.
		const runById = findRunInSource(runs, segment);
		if (runById !== undefined && durableRootRunIdForRun(runs, runById.id) === parsed.rootRunId) {
			run = runById;
			continue;
		}
		const child = resolveChildRun(runs, run, segment);
		if (child === undefined) return undefined;
		run = child;
	}
	return run;
}

function resolveMaterializedStage(
	runs: RunSource,
	target: string,
):
	| {
			readonly run: ReturnType<Store["runs"]>[number];
			readonly stage: ReturnType<Store["runs"]>[number]["stages"][number];
	  }
	| undefined {
	const parsed = parseWorkflowStageTarget(target);
	if (parsed === undefined) return undefined;
	const run = resolveMaterializedRun(runs, parsed);
	if (run === undefined) return undefined;
	const stageKey = parsed.segments.at(-1)!;
	const stagesById = run.stages.filter((stage) => stage.id === stageKey);
	const stages = (stagesById.length > 0 ? stagesById : run.stages.filter((stage) => stage.name === stageKey)).filter(
		(stage) => !isNonAgentStage(stage),
	);
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
	const rootBackend = requireStoreDurableBackend(activeStore, event.runId);
	const backend = durableBackendForRun(rootBackend, activeStore, event.runId);
	if (backend === undefined) return { outcome: "refused", reason: "Session not found" };
	// The broker has already authorized the immutable registration identity.
	// Preserve the sender identity in the durable entry, but use its current
	// invocation membership for the durable group check so an ordinary session
	// that explicitly joined workflow:<runId> (or launched the run) can queue before stage startup.
	const senderGroup = pendingStageSenderGroup(event, runGroup);
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
		return { outcome: "refused", reason: workflowInvocationGroupRefusal(runGroup) };
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

/** How a sticky send's target relates to the run's stages: the structured classification every queued result carries. */
export interface StickySendPrediction {
	/** `known`: the scan or a materialized stage covers it; `predicted`: the decision model expects it. */
	readonly prediction: "known" | "predicted" | "unknown";
	/** The decision model judged the target unlikely: probably a typo. */
	readonly unexpected?: true;
	/** The closest known stage path for an unexpected target, when one is close enough. */
	readonly suggestion?: string;
}

/**
 * Slice 3 sticky delivery (D3/D4/D5/D6): persist one entry in the ROOT run's durable
 * bucket and answer `queued` with the target's {@link StickySendPrediction}. Matching
 * live stages are recorded as delivered immediately; the broker forwards the message to
 * them through the ordinary inbound admission path with the sender identity (D9).
 */
async function deliverStickyTarget(
	activeStore: Store,
	rootRun: ReturnType<Store["runs"]>[number],
	event: PendingStageMessageEvent & {
		readonly from: PendingStageSender;
		readonly target: string;
		readonly message: PendingStageMessageInput["message"];
	},
	parsedTarget: WorkflowStageTarget,
	predictor: StagePredictor | undefined,
): Promise<
	| ({
			readonly outcome: "queued";
			readonly position: number;
			readonly forwardTargets?: readonly string[];
	  } & StickySendPrediction)
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
	const liveMatches = matchingLiveStages(activeStore, rootRunId, parsedTarget.segments);
	// The static scan cannot see inside dynamically loaded (pooled) children, so a target that
	// matches a materialized live or pending stage is known even when the scan misses it.
	// Anything else asks the decision model in the background and never waits for it.
	const classification: StickySendPrediction =
		targetSegmentsInPossibleStages(parsedTarget.segments, knownScanEntries(rootRun)) ||
		liveMatches.length > 0 ||
		matchingLiveStages(activeStore, rootRunId, parsedTarget.segments, { includePending: true }).length > 0
			? { prediction: "known" }
			: (predictor?.classifySend(rootRun, parsedTarget.segments) ?? { prediction: "unknown" });
	const backend = durableBackendForRun(requireStoreDurableBackend(activeStore, rootRunId), activeStore, rootRunId);
	if (backend === undefined) return { outcome: "refused", reason: "Session not found" };
	const senderGroup = pendingStageSenderGroup(event, runGroup);
	const request: PendingStickyStageMessageInput = {
		runId: rootRunId,
		stageKey: event.target,
		from: event.from,
		...(event.senderRegistrationName === undefined ? {} : { senderRegistrationName: event.senderRegistrationName }),
		...(event.senderReturnAddress === undefined ? {} : { senderReturnAddress: event.senderReturnAddress }),
		message: event.message,
		queuedAt: new Date().toISOString(),
		targetPath: event.target,
		...(classification.prediction === "known" ? {} : { prediction: classification.prediction }),
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
		return { outcome: "refused", reason: workflowInvocationGroupRefusal(runGroup) };
	}
	// Live matches are forwarded by the broker, which then reports the targets it actually
	// wrote to (STICKY_LIVE_DELIVERED_EVENT); only those enter the durable ledger. Recording
	// before the write would mark a stage that blipped as delivered forever, and a retried
	// send would never re-forward to it. A dedup retry therefore re-forwards exactly the
	// live matches the ledger has not confirmed yet.
	const recordedDeliveries = result.entry.deliveries ?? [];
	const forwardTargets: string[] = [];
	for (const match of liveMatches) {
		if (
			recordedDeliveries.some(
				(delivery) =>
					delivery.runId === match.run.id &&
					delivery.stageId === match.stage.id &&
					delivery.sessionId === match.stage.sessionId &&
					(delivery.admission === "transport" || delivery.admission === "context"),
			) ||
			(await backend.hasPendingStageDeliveryReceipt?.(rootRunId, result.entry.id, {
				runId: match.run.id,
				stageId: match.stage.id,
				...(match.stage.sessionId === undefined ? {} : { sessionId: match.stage.sessionId }),
				admission: "transport",
			})) ||
			(await backend.hasPendingStageDeliveryReceipt?.(rootRunId, result.entry.id, {
				runId: match.run.id,
				stageId: match.stage.id,
				...(match.stage.sessionId === undefined ? {} : { sessionId: match.stage.sessionId }),
				admission: "context",
			}))
		) {
			continue;
		}
		forwardTargets.push(match.target);
	}
	return {
		outcome: "queued",
		position: result.position ?? 1,
		...classification,
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
	const rootRunId = parsedTarget.rootRunId;
	const rootRun = activeStore.run(rootRunId);
	const entry = rootRun?.pendingStageMessages?.find(
		(candidate) => candidate.sticky === true && candidate.message.id === event.messageId,
	);
	if (rootRun === undefined || entry === undefined) return false;
	const delivered = new Set(event.deliveredTargets);
	const records = matchingLiveStages(activeStore, rootRunId, parsedTarget.segments)
		.filter((match) => delivered.has(match.target))
		.map((match) => ({
			runId: match.run.id,
			stageId: match.stage.id,
			...(match.stage.name === match.stage.id ? {} : { stageName: match.stage.name }),
			...(match.stage.sessionId === undefined ? {} : { sessionId: match.stage.sessionId }),
			admission: "transport" as const,
		}));
	if (records.length === 0) return false;
	const backend = durableBackendForRun(requireStoreDurableBackend(activeStore, rootRunId), activeStore, rootRunId);
	if (backend === undefined) return false;
	const unconfirmedRecords = [];
	for (const record of records) {
		if (
			!entry.deliveries?.some(
				(delivery) =>
					delivery.runId === record.runId &&
					delivery.stageId === record.stageId &&
					delivery.sessionId === record.sessionId &&
					(delivery.admission === "context" || delivery.admission === "transport"),
			) &&
			!(await backend.hasPendingStageDeliveryReceipt?.(rootRunId, entry.id, record)) &&
			!(await backend.hasPendingStageDeliveryReceipt?.(rootRunId, entry.id, { ...record, admission: "context" }))
		) {
			unconfirmedRecords.push(record);
		}
	}
	return activeStore.recordPendingStageMessageDeliveries(
		rootRunId,
		entry.id,
		unconfirmedRecords,
		new Date().toISOString(),
		backend,
	);
}

/**
 * Live stages of the invocation whose depth-faithful path (per D5 hop spellings) matches the target segments.
 * `includePending` also returns addressable stages that have no session yet.
 */
function matchingLiveStages(
	runs: RunSource,
	rootRunId: string,
	patternSegments: readonly string[],
	options: { readonly includePending?: boolean } = {},
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
	const hopsFor = createWorkflowBoundaryHopsResolver(runs);
	for (const run of invocationRunsInSource(runs, rootRunId)) {
		const hops = hopsFor(run.id);
		if (hops === undefined) continue;
		for (const stage of run.stages) {
			const live = stage.sessionId !== undefined || stage.sessionFile !== undefined;
			if ((!live && options.includePending !== true) || stage.pendingStageDeliveryAvailable !== true) continue;
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
	if (stage.status === "waiting") return stage;
	return isAddressableStageStatus(stage.status) && stage.sessionId === undefined && stage.sessionFile === undefined
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

/** Whether a queued message of the run can no longer start, or an undeliverable one still owes its sender a notice. */
function hasSettlementWork(run: RunSnapshot | undefined): boolean {
	return run?.pendingStageMessages?.some((entry) => needsUndeliverableSettlement(run, entry)) === true;
}

/**
 * Settle queued messages whose destination can no longer enter the pre-start lifecycle window. `runIds` limits the
 * sweep to those runs, found by id; without it every run is read. `onSettlementWork` hears of each run found with
 * settlement work, owned or not, before any is settled.
 */
export async function settleUndeliverablePendingStageMessages(
	activeStore: Store,
	notify: (entry: PendingStageMessage, reason: string, notificationId: string) => Promise<boolean>,
	ownsRun: (runId: string) => boolean = () => true,
	runIds?: Iterable<string>,
	onSettlementWork?: (runId: string) => void,
): Promise<number> {
	if (runIds !== undefined) {
		const position = (run: RunSnapshot) => activeStore.runPosition(run.id) ?? Number.MAX_SAFE_INTEGER;
		const candidates = [...new Set(runIds)]
			.flatMap((runId) => {
				const run = activeStore.run(runId);
				return run !== undefined && hasSettlementWork(run) ? [run] : [];
			})
			.sort((left, right) => position(left) - position(right));
		for (const run of candidates) onSettlementWork?.(run.id);
		const owned = candidates.filter((run) => ownsRun(run.id));
		if (owned.length === 0) return 0;
		// Ownership limits the runs a durable owner resolves through, as the full sweep's list of owned runs does.
		const ownedRuns: RunSource = {
			run: (runId) => {
				const run = activeStore.run(runId);
				return run !== undefined && ownsRun(run.id) ? run : undefined;
			},
			runs: () => activeStore.runs().filter((run) => ownsRun(run.id)),
		};
		return settleRuns(activeStore, owned, ownedRuns, notify);
	}
	// Ownership resolves a run's root through every run, so it is asked only once a run has settlement work:
	// asking it of every run on each sweep made a wide fan-out's sweeps quadratic in its width.
	const all = activeStore.runs();
	const candidates = all.filter(hasSettlementWork);
	for (const run of candidates) onSettlementWork?.(run.id);
	if (!candidates.some((run) => ownsRun(run.id))) return 0;
	const runs = all.filter((run) => ownsRun(run.id));
	return settleRuns(activeStore, runs, runs, notify);
}

/** Settles each run's messages; `owners` holds the runs a durable owner may be resolved through. */
async function settleRuns(
	activeStore: Store,
	runs: readonly RunSnapshot[],
	owners: RunSource,
	notify: (entry: PendingStageMessage, reason: string, notificationId: string) => Promise<boolean>,
): Promise<number> {
	let settled = 0;
	for (const run of runs) {
		// Retained/partial runs with no settlement work need no durable owner.
		if (!hasSettlementWork(run)) continue;
		const backend = durableBackendForRun(requireStoreDurableBackend(activeStore, run.id), owners, run.id);
		if (backend === undefined) {
			throw new Error(`atomic-workflows: workflow run ${run.id} has no durable owner for pending-stage settlement`);
		}
		for (const snapshotEntry of run.pendingStageMessages ?? []) {
			let entry = snapshotEntry;
			if (entry.status === "queued" && entry.sticky === true && isTerminalRunStatus(run.status)) {
				if (
					await activeStore.settleStickyPendingStageMessageDelivered(
						run.id,
						entry.id,
						new Date().toISOString(),
						backend,
					)
				) {
					settled += 1;
					continue;
				}
			}
			if (entry.status === "queued") {
				const reason = pendingStageUndeliverableReason(run, entry);
				if (reason === undefined) continue;
				if (
					await activeStore.markPendingStageMessageUndeliverable(run.id, entry.stageKey, entry.id, reason, backend)
				) {
					settled += 1;
				}
				const currentRun = activeStore.run(run.id);
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
