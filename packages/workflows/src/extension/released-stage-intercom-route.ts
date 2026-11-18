import { durableRootRunIdForRun } from "../durable/run-owner-backend.js";
import { isSessionClosedError } from "../engine/session-closed-error.js";
import type { ReleasedStage, StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import { workflowPendingStageRouteCapability } from "../shared/pending-stage-route-capability.js";
import type { Store } from "../shared/store.js";
import { type CompletedStageHandleResolver, createCompletedStageAnswerer } from "./completed-stage-intercom-ask.js";

/** Workflows -> Intercom: a completed stage lost its session; keep its Intercom peer reachable. */
const RELEASED_STAGE_EVENT = "atomic:workflow-released-stage";

interface WorkflowEventSurface {
	readonly events?: {
		emit?: (event: string, payload: ReleasedStageAnnouncement) => void;
	};
}

/**
 * Ids plus one loader closure. A released stage's route must not pin its session,
 * store, or transcript: `answer` reopens the stage from its saved conversation
 * when an ask arrives and returns the stage's reply.
 */
type ReleasedStageAnnouncement = {
	readonly runId: string;
	readonly stageId: string;
	readonly stageName: string;
	readonly sessionId: string;
	readonly group: string;
	readonly model?: string;
	/** Present when the stage's live session was also addressable as `workflow:<root>/<stage>`. */
	readonly liveRoute?: {
		readonly stageKeys: readonly string[];
		readonly capability: string;
	};
	readonly isCurrent: () => boolean;
	readonly answer: (content: string) => Promise<string>;
};

function announcementFor(
	store: Store,
	released: ReleasedStage,
	answer: (content: string, assertCurrent: () => void) => Promise<string>,
): ReleasedStageAnnouncement | undefined {
	const run = store.run(released.runId);
	const stage = run?.stages.find((candidate) => candidate.id === released.stageId);
	// Only a stage that connected to Intercom at startup was a peer before release.
	if (run === undefined || stage?.pendingStageDeliveryAvailable !== true) return undefined;
	const record = released.stageRecord ?? new WeakRef(stage);
	if (record.deref() !== stage || stage.sessionId !== released.sessionId) return undefined;
	const isCurrent = () => {
		const held = record.deref();
		return (
			held !== undefined &&
			held.sessionId === released.sessionId &&
			store.run(released.runId)?.stages.includes(held) === true
		);
	};
	const rootRunId = durableRootRunIdForRun(store, run.id);
	if (rootRunId === undefined) return undefined;
	// A name containing "/" or "*" is not a canonical path segment; its id stays addressable.
	const stageKeys = [released.stageId, released.stageName].filter((key) => !key.includes("/") && !key.includes("*"));
	return {
		runId: released.runId,
		stageId: released.stageId,
		stageName: released.stageName,
		sessionId: released.sessionId,
		group: stage.intercomGroup ?? workflowInvocationIntercomGroup(rootRunId),
		...(stage.model === undefined ? {} : { model: stage.model }),
		...(stageKeys.length === 0
			? {}
			: { liveRoute: { stageKeys, capability: workflowPendingStageRouteCapability(store, run.id) } }),
		isCurrent,
		answer: (content) =>
			answer(content, () => {
				if (!isCurrent()) throw new Error("Intercom ask target is unavailable: the workflow stage was replaced.");
			}),
	};
}

/**
 * Tells Intercom about every stage whose session the registry released, so the
 * stage keeps an addressable peer after its run ends. Intercom answers an ask to
 * that peer by reopening the stage through the post-mortem loader.
 */
export function registerReleasedStageIntercomRoutes(
	pi: WorkflowEventSurface,
	registry: StageControlRegistry,
	store: Store,
	resolveHandle: CompletedStageHandleResolver,
): () => void {
	let disposed = false;
	const answerAsCompletedStage = createCompletedStageAnswerer(resolveHandle, () => {
		if (disposed) throw new Error("Intercom ask target is unavailable: its owning session has closed.");
	});
	const unsubscribe = registry.onStageReleased((released) => {
		if (disposed) return;
		const announcement = announcementFor(store, released, (content, assertCurrent) =>
			answerAsCompletedStage(released.runId, released.stageId, content, assertCurrent),
		);
		if (announcement === undefined) return;
		try {
			pi.events?.emit?.(RELEASED_STAGE_EVENT, announcement);
		} catch (error) {
			if (!(error instanceof Error && isSessionClosedError(error))) throw error;
			disposed = true;
		}
	});
	return () => {
		disposed = true;
		unsubscribe();
	};
}
