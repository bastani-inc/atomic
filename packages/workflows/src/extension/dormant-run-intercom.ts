import { type DurableWorkflowBackend, pendingStageMessagesForDurableRun } from "../durable/backend.js";
import { durableWorkflowRunSnapshots } from "../durable/completed-catalog.js";
import { JournalDurableBackend, JournalOwnershipError } from "../durable/journal/journal-backend.js";
import { FOREIGN_LIVE_WORKFLOW_WINDOW_MS, isDurableWorkflowResumable } from "../durable/resume-eligibility.js";
import { canonicalDirectory } from "../durable/sdk-recovery-scope.js";
import { workflowInvocationIntercomGroup } from "../shared/intercom-group.js";
import { queueStageMessage, queueStickyStageMessage } from "../shared/pending-stage-delivery.js";
import { workflowPendingStageRouteCapability } from "../shared/pending-stage-route-capability.js";
import { type SessionEntry, scanInFlightRuns } from "../shared/persistence-restore.js";
import type { Store } from "../shared/store.js";
import { isTerminalRunStatus } from "../shared/store-internal.js";
import type {
	PendingStageMessage,
	PendingStageMessageInput,
	PendingStageQueueResult,
	PendingStageSender,
	StageSnapshot,
} from "../shared/store-types.js";
import { formatWorkflowStageTarget, parseWorkflowStageTarget } from "../shared/workflow-stage-target.js";
import { withDormantRunWrite } from "./dormant-run-gate.js";
import type { ExtensionAPI, PiEventContext } from "./public-types.js";
import { createWorkflowBackgroundWarningReporter } from "./workflow-background-warning.js";

const PENDING_STAGE_ROUTE_EVENT = "atomic:workflow-pending-stage-route";
const PENDING_STAGE_MESSAGE_EVENT = "atomic:workflow-pending-stage-message";
/** Intercom → workflows: the process that resumed a dormant run took its routes over. */
const PENDING_STAGE_ROUTE_REVOKED_EVENT = "atomic:workflow-pending-stage-route-revoked";
/**
 * Workflows → subagents: keep the background subagents of an interrupted run's stages addressable until `/workflow
 * resume` restores them. The answer is the hold to end when the run is taken over by another process or ends.
 */
const DORMANT_RUN_SUBAGENT_HOLD_EVENT = "atomic:workflow-dormant-run-subagent-hold";
/** How often a run whose crashed owner's lease has not expired yet is checked again. */
const DORMANT_RUN_RECHECK_MS = 15_000;
const ADDRESSABLE_STAGE_STATUSES: ReadonlySet<string> = new Set([
	"pending",
	"running",
	"awaiting_input",
	"paused",
	"blocked",
]);
const DORMANT_ASK_REFUSAL =
	"Cannot ask a stage of an interrupted workflow run. Use send; Atomic will queue the message until the run is resumed.";

/** What the subagents extension hands back for an interrupted run: the holds on its stages' subagents. */
interface DormantRunSubagentHold {
	/** End every hold. With `refusal` the senders held now are told that reason, otherwise they are routed normally. */
	release(refusal?: string): Promise<void>;
}

interface DormantRun {
	readonly runId: string;
	readonly group: string;
	readonly capability: string;
	readonly backend: DurableWorkflowBackend;
	readonly stages: readonly StageSnapshot[];
}

type DormantMessageResult =
	| { readonly outcome: "queued"; readonly position: number }
	| { readonly outcome: "delivered" }
	| { readonly outcome: "refused"; readonly reason: string; readonly reasonCode?: "message_id_conflict" };

interface DormantMessageEvent {
	handled: boolean;
	completion?: Promise<unknown>;
	readonly live?: boolean;
	readonly runId: string;
	readonly target: string;
	readonly from: PendingStageSender;
	readonly senderRegistrationName?: string;
	readonly senderReturnAddress?: string;
	readonly message: PendingStageMessageInput["message"];
}

interface DormantRunSurface {
	readonly events?: {
		emit?(event: string, payload: Record<string, unknown>): void;
		on?(event: string, listener: (payload: unknown) => void): unknown;
	};
	on?: ExtensionAPI["on"];
}

export interface DormantRunIntercomDeps {
	/** The host's ready durable backend after refreshing these interrupted runs, if one is configured. */
	prepareBackend(
		ctx: PiEventContext | undefined,
		runIds: readonly string[],
	): Promise<DurableWorkflowBackend | undefined>;
	readonly recheckMs?: number;
}

export interface DormantRunIntercom {
	/** Settles once the current session's interrupted runs were examined. */
	settled(): Promise<void>;
	dispose(): void;
}

/**
 * Keep an interrupted run addressable while it waits for `/workflow resume` (#3760).
 *
 * After its owning session restarts, an interrupted durable run is not in the live
 * store, so nothing answers for `workflow:<rootRunId>/...` and sends fail with
 * "Session not found". For each run the session launched that is still resumable
 * here, this registers a dormant pending-stage route and queues every send in the
 * run's own journal. Resume seeds those entries into the run, and each stage drains
 * them exactly once when it goes live. The process that resumes the run takes the
 * route over; a dormant owner whose route was revoked stops answering for it.
 *
 * The background subagents that the run's stages launched are addressable too: sends to them are
 * held by the broker until the resumed stage restores them. This session asks its subagents
 * extension to hold them, from the `subagent-child` records in the stages' own sessions. When the
 * run resumes here, each stage's restoration takes its holds over. A hold ends when another
 * process takes the run over (its senders are told so), when the run ends, or with this session.
 */
export function registerDormantRunIntercomRoutes(
	pi: DormantRunSurface,
	activeStore: Store,
	deps: DormantRunIntercomDeps,
): DormantRunIntercom {
	const reportWarning = createWorkflowBackgroundWarningReporter(pi);
	const dormant = new Map<string, DormantRun>();
	/** The subagent holds of runs this session made addressable, for as long as the run can still restore them here. */
	const subagentHolds = new Map<string, Promise<DormantRunSubagentHold | undefined>>();
	let generation = 0;
	let disposed = false;
	let examined: Promise<void> = Promise.resolve();
	let recheck: ReturnType<typeof setTimeout> | undefined;
	const isLive = (runId: string): boolean => activeStore.runs().some((run) => run.id === runId);
	const holdSubagents = (run: DormantRun, ctx: PiEventContext | undefined): void => {
		const stageSessionIds = run.stages.flatMap((stage) => {
			const sessionId =
				stage.sessionId ??
				(stage.replayKey === undefined
					? undefined
					: run.backend.getStageSession(run.runId, stage.replayKey)?.sessionId);
			return sessionId === undefined ? [] : [sessionId];
		});
		if (stageSessionIds.length === 0) return;
		const request: Record<string, unknown> & { completion?: Promise<DormantRunSubagentHold> } = {
			runId: run.runId,
			group: run.group,
			stageSessionIds,
			// The session whose store holds the stages' sessions; the subagents extension may not have seen its start yet.
			...(ctx === undefined ? {} : { context: ctx }),
		};
		pi.events?.emit?.(DORMANT_RUN_SUBAGENT_HOLD_EVENT, request);
		if (request.completion === undefined) return;
		// A run is held once; a hold left from an earlier registration of it ends first.
		releaseSubagents(run.runId);
		subagentHolds.set(
			run.runId,
			request.completion.catch(() => undefined),
		);
	};
	const releaseSubagents = (runId: string, refusal?: string): void => {
		const pending = subagentHolds.get(runId);
		if (pending === undefined) return;
		subagentHolds.delete(runId);
		void pending.then((hold) => hold?.release(refusal)).catch(() => undefined);
	};
	const releaseAllSubagents = (): void => {
		for (const runId of [...subagentHolds.keys()]) releaseSubagents(runId);
	};
	const resumedElsewhereReason = (runId: string): string =>
		`Workflow run ${runId} was resumed in another Atomic session; send to it again there`;
	const clearRecheck = (): void => {
		if (recheck !== undefined) clearTimeout(recheck);
		recheck = undefined;
	};

	const announce = (run: DormantRun): void => {
		const broadcast = formatWorkflowStageTarget(run.runId, "**");
		const queuedBroadcasts = pendingStageMessagesForDurableRun(run.backend, run.runId).filter(
			(entry) => entry.sticky === true && entry.status === "queued" && entry.targetPath === broadcast,
		).length;
		const payload: Record<string, unknown> & { completion?: Promise<void> } = {
			runId: run.runId,
			group: run.group,
			capability: run.capability,
			dormant: true,
			stages: run.stages.map((stage) => ({
				stageId: stage.id,
				stageName: stage.name,
				target: formatWorkflowStageTarget(run.runId, stage.id),
				lifecycle: "pending",
				routeEligible: true,
				group: run.group,
			})),
			possibleStages: [{ target: broadcast, queuedCount: queuedBroadcasts }],
		};
		pi.events?.emit?.(PENDING_STAGE_ROUTE_EVENT, payload);
		payload.completion?.catch(() => {
			// The route client retries on its own; a run another process resumed is revoked.
		});
	};

	/**
	 * Make this session's interrupted runs addressable. A crashed owner's lease stays fresh
	 * for `FOREIGN_LIVE_WORKFLOW_WINDOW_MS`, so a run still held is checked again until that
	 * window has passed; after it, the holder is a live session that owns the run's routes.
	 */
	const examine = async (
		ctx: PiEventContext | undefined,
		runIds: readonly string[],
		current: number,
		prepared?: { readonly backend: DurableWorkflowBackend; readonly heldUntil: number },
	): Promise<void> => {
		const backend = prepared?.backend ?? (await deps.prepareBackend(ctx, runIds));
		if (backend === undefined || current !== generation || disposed) return;
		const cwd = ctx?.cwd ?? ctx?.sessionManager?.getCwd?.();
		if (cwd === undefined) return;
		const recheckMs = deps.recheckMs ?? DORMANT_RUN_RECHECK_MS;
		const heldUntil = prepared?.heldUntil ?? Date.now() + FOREIGN_LIVE_WORKFLOW_WINDOW_MS + recheckMs;
		const held: string[] = [];
		for (const runId of runIds) {
			if (isLive(runId) || dormant.has(runId)) continue;
			if (prepared !== undefined) await backend.hydrateWorkflow(runId);
			const handle = backend.getWorkflow(runId);
			if (
				handle === undefined ||
				handle.status !== "running" ||
				(handle.rootWorkflowId !== undefined && handle.rootWorkflowId !== runId) ||
				handle.invocationCwd === undefined ||
				canonicalDirectory(handle.invocationCwd) !== canonicalDirectory(cwd) ||
				!isDurableWorkflowResumable(handle)
			)
				continue;
			const ownership = await backend.workflowOwnership(runId);
			if (current !== generation || disposed) return;
			if (ownership === "foreign") held.push(runId);
			if (ownership !== "available" || isLive(runId)) continue;
			const root = durableWorkflowRunSnapshots(backend, handle).find((run) => run.id === runId);
			if (root === undefined) continue;
			const run: DormantRun = {
				runId,
				group: workflowInvocationIntercomGroup(runId),
				capability: workflowPendingStageRouteCapability(activeStore, runId),
				backend,
				stages: root.stages.filter(isAddressableStage),
			};
			dormant.set(runId, run);
			announce(run);
			holdSubagents(run, ctx);
		}
		if (held.length === 0 || Date.now() >= heldUntil || current !== generation || disposed) return;
		recheck = setTimeout(() => {
			recheck = undefined;
			if (current !== generation || disposed) return;
			examined = examine(ctx, held, current, { backend, heldUntil }).catch(reportExamineFailure);
		}, recheckMs);
		recheck.unref?.();
	};
	const reportExamineFailure = (error: Error): void =>
		reportWarning(`atomic-workflows: interrupted workflow runs could not be made addressable: ${error.message}`);

	pi.on?.("session_start", (_event, ctx) => {
		generation += 1;
		clearRecheck();
		dormant.clear();
		releaseAllSubagents();
		if (disposed || ctx?.isPresentationOnly === true) return;
		const entries = (ctx?.sessionManager?.getEntries?.() ?? []) as readonly SessionEntry[];
		const runIds = scanInFlightRuns(entries)
			.map((run) => run.runId)
			.filter((runId) => !isLive(runId));
		if (runIds.length === 0) return;
		examined = examine(ctx, runIds, generation).catch(reportExamineFailure);
	});
	const unsubscribeStore = activeStore.subscribeInvalidation(() => {
		// A resumed run's live owner re-announces the same route; it is no longer dormant here.
		for (const runId of dormant.keys()) if (isLive(runId)) dormant.delete(runId);
		// A run resumed here keeps its subagent holds until each resumed stage restores its subagents and takes its hold
		// over. A run that ended, or left the store, restores nothing more.
		for (const runId of [...subagentHolds.keys()]) {
			if (dormant.has(runId)) continue;
			const resumed = activeStore.runs().find((run) => run.id === runId);
			if (resumed === undefined || isTerminalRunStatus(resumed.status)) releaseSubagents(runId);
		}
	});
	const revoked = pi.events?.on?.(PENDING_STAGE_ROUTE_REVOKED_EVENT, (payload) => {
		const notice = payload as { readonly runId?: unknown; readonly capability?: unknown } | undefined;
		if (typeof notice?.runId !== "string") return;
		if (dormant.get(notice.runId)?.capability !== notice.capability) return;
		dormant.delete(notice.runId);
		releaseSubagents(notice.runId, resumedElsewhereReason(notice.runId));
	});

	const redispatch = async (event: DormantMessageEvent): Promise<DormantMessageResult | unknown> => {
		const forwarded: DormantMessageEvent & Record<string, unknown> = {
			handled: false,
			runId: event.runId,
			target: event.target,
			from: event.from,
			message: event.message,
			...(event.senderRegistrationName === undefined
				? {}
				: { senderRegistrationName: event.senderRegistrationName }),
			...(event.senderReturnAddress === undefined ? {} : { senderReturnAddress: event.senderReturnAddress }),
		};
		pi.events?.emit?.(PENDING_STAGE_MESSAGE_EVENT, forwarded);
		if (forwarded.handled && forwarded.completion !== undefined) return await forwarded.completion;
		return { outcome: "refused", reason: "Session not found" } satisfies DormantMessageResult;
	};

	const queue = async (run: DormantRun, event: DormantMessageEvent): Promise<DormantMessageResult | unknown> => {
		if (event.message.expectsReply === true) return { outcome: "refused", reason: DORMANT_ASK_REFUSAL };
		const queued = await withDormantRunWrite(activeStore, run.runId, async () => {
			// The run resumed while this send waited: it now belongs to the live owner.
			if (isLive(run.runId) || dormant.get(run.runId) !== run) return undefined;
			return await writeDormantMessage(run, event);
		});
		if (queued !== undefined) {
			if (queued.outcome === "queued" && dormant.get(run.runId) === run) announce(run);
			return queued;
		}
		return isLive(run.runId)
			? await redispatch(event)
			: { outcome: "refused", reason: `Workflow run ${run.runId} is no longer resumable from this session` };
	};

	const messages = pi.events?.on?.(PENDING_STAGE_MESSAGE_EVENT, (payload) => {
		if (disposed || !isDormantMessageEvent(payload) || payload.handled || payload.live === true) return;
		const target = parseWorkflowStageTarget(payload.target);
		const run = target === undefined ? undefined : dormant.get(target.rootRunId);
		if (run === undefined || isLive(run.runId)) return;
		payload.handled = true;
		payload.completion = queue(run, payload).catch((error: Error) => {
			// Another process took the run's lease: it resumed the run and owns its routes now.
			const resumedElsewhere = error instanceof JournalOwnershipError;
			if (resumedElsewhere) {
				dormant.delete(run.runId);
				releaseSubagents(run.runId, resumedElsewhereReason(run.runId));
			}
			return {
				outcome: "refused",
				reason: resumedElsewhere ? resumedElsewhereReason(run.runId) : error.message,
			} satisfies DormantMessageResult;
		});
	});

	const dispose = (): void => {
		disposed = true;
		clearRecheck();
		dormant.clear();
		releaseAllSubagents();
		unsubscribeStore();
		if (typeof revoked === "function") revoked();
		if (typeof messages === "function") messages();
	};
	pi.on?.("session_shutdown", () => {
		generation += 1;
		clearRecheck();
		dormant.clear();
		releaseAllSubagents();
	});
	return { settled: () => examined, dispose };
}

/** Persist one send in the dormant run's journal, under a brief lease that is released again. */
async function writeDormantMessage(run: DormantRun, event: DormantMessageEvent): Promise<DormantMessageResult> {
	const write = async (): Promise<DormantMessageResult> => {
		await run.backend.hydrateWorkflow(run.runId);
		const current = pendingStageMessagesForDurableRun(run.backend, run.runId);
		const receipt = await run.backend.readSettledPendingStageMessage?.(run.runId, event.message.id);
		const existing = receipt === undefined ? current : [...current, receipt];
		const senderGroup = event.from.groups?.includes(run.group) === true ? run.group : event.from.group;
		const input: PendingStageMessageInput = {
			runId: run.runId,
			stageKey: event.target,
			from: event.from,
			...(event.senderRegistrationName === undefined
				? {}
				: { senderRegistrationName: event.senderRegistrationName }),
			...(event.senderReturnAddress === undefined ? {} : { senderReturnAddress: event.senderReturnAddress }),
			message: event.message,
			queuedAt: new Date().toISOString(),
		};
		const stage = interruptedStage(run, event.target);
		const result: PendingStageQueueResult =
			stage === undefined
				? queueStickyStageMessage(existing, { ...input, targetPath: event.target }, senderGroup, run.group)
				: queueStageMessage(existing, { ...input, stageKey: stage.id }, senderGroup, run.group, {
						id: stage.id,
						...(stage.replayKey === undefined ? {} : { replayKey: stage.replayKey }),
						aliases: stage.id === stage.name ? [stage.id] : [stage.id, stage.name],
					});
		if (!result.ok) return queueRefusal(result, event.target);
		if (!result.deduplicated) {
			const persisted = result.messages.filter((entry: PendingStageMessage) => entry !== receipt);
			if (!(await run.backend.persistPendingStageMessages(run.runId, persisted)))
				return { outcome: "refused", reason: `Workflow run ${run.runId} is unavailable for queueing` };
		}
		if (result.entry.status === "delivered") return { outcome: "delivered" };
		if (result.entry.status === "undeliverable")
			return {
				outcome: "refused",
				reason: result.entry.undeliverableReason ?? "Pending-stage delivery was refused",
			};
		return { outcome: "queued", position: result.position ?? 1 };
	};
	return run.backend instanceof JournalDurableBackend ? run.backend.withWorkflowLease(run.runId, write) : write();
}

/** The interrupted root-run stage an exact path names; anything else queues sticky for its next match. */
function interruptedStage(run: DormantRun, target: string): StageSnapshot | undefined {
	const parsed = parseWorkflowStageTarget(target);
	if (parsed?.kind !== "path" || parsed.segments.length !== 1) return undefined;
	const key = parsed.segments[0]!;
	const byId = run.stages.filter((stage) => stage.id === key);
	const matches = byId.length > 0 ? byId : run.stages.filter((stage) => stage.name === key);
	return matches.length === 1 ? matches[0] : undefined;
}

function queueRefusal(result: Extract<PendingStageQueueResult, { ok: false }>, target: string): DormantMessageResult {
	if (result.reason === "capacity")
		return {
			outcome: "refused",
			reason: `Pending stage message queue is full (limit ${result.limit}) for ${target}`,
		};
	if (result.reason === "message_id_conflict")
		return {
			outcome: "refused",
			reason: `Intercom message ID '${result.messageId}' was already queued for ${target} with a different target, sender, or payload`,
			reasonCode: "message_id_conflict",
		};
	return { outcome: "refused", reason: "Target workflow run is in a different intercom group" };
}

function isAddressableStage(stage: StageSnapshot): boolean {
	return (
		ADDRESSABLE_STAGE_STATUSES.has(stage.status) &&
		stage.nodeKind !== "tool" &&
		stage.replayKey?.startsWith("prompt:") !== true
	);
}

function isDormantMessageEvent(value: unknown): value is DormantMessageEvent {
	if (typeof value !== "object" || value === null) return false;
	const event = value as Partial<DormantMessageEvent>;
	return (
		typeof event.handled === "boolean" &&
		typeof event.runId === "string" &&
		typeof event.target === "string" &&
		typeof event.from?.id === "string" &&
		typeof event.message?.id === "string" &&
		typeof event.message.timestamp === "number" &&
		typeof event.message.content?.text === "string"
	);
}
