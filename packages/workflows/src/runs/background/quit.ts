import type { DurableWorkflowBackend } from "../../durable/backend.js";
import { getDurableBackend } from "../../durable/factory.js";
import { recordRunTimingCheckpoint } from "../../durable/run-timing.js";
import {
	getLoadableDurableWorkflow,
	transitionDurableWorkflowStatus,
} from "../../durable/workflow-status-transition.js";
import type { ToolAdmissionBoundary } from "../../engine/run-tool-admission-boundary.js";
import {
	toolControlRegistry as defaultToolControlRegistry,
	sameToolNodeIdentity,
	settleAbortedToolNodes,
	TOOL_QUIT_SETTLEMENT_TIMEOUT_MS,
	type ToolControlHandle,
	type ToolControlRegistry,
} from "../../engine/run-tool-control-registry.js";
import { WorkflowGracefulQuitError } from "../../engine/workflow-tool-abort.js";
import { expandWorkflowGraph } from "../../shared/expanded-workflow-graph.js";
import { topLevelWorkflowRuns } from "../../shared/run-visibility.js";
import { store as defaultStore } from "../../shared/store.js";
import { readGraphStoreSnapshot } from "../../shared/store-observation.js";
import type { Store } from "../../shared/store-public-types.js";
import type { RunSnapshot, StageSnapshot } from "../../shared/store-types.js";
import type { WorkflowCancelledToolNode, WorkflowToolNodeIdentity } from "../../shared/types.js";
import {
	stageControlRegistry as defaultStageControlRegistry,
	type StageControlHandle,
	type StageControlRegistry,
} from "../foreground/stage-control-registry.js";
import { jobTracker as defaultJobTracker, type JobTracker } from "./job-tracker.js";
import { expandedControlRunIds } from "./workflow-lifecycle-aggregate.js";

export type QuitRunResult =
	| {
			readonly ok: true;
			readonly runId: string;
			readonly paused: readonly StageSnapshot[];
			/** Tool nodes aborted by this quit, settled or abandoned, with owning run. */
			readonly cancelledTools: readonly WorkflowCancelledToolNode[];
			/** Aborted nodes whose callback ignored its signal within the bounded wait. */
			readonly abandonedTools: readonly WorkflowToolNodeIdentity[];
	  }
	| {
			readonly ok: false;
			readonly runId: string;
			readonly reason: "not_found" | "already_ended" | "no_active_stages" | "stage_not_found";
	  };

type QuitAllRunResult =
	| QuitRunResult
	| {
			readonly ok: false;
			readonly runId: string;
			readonly reason: "pause_failed";
			readonly message: string;
	  };

/**
 * Gracefully quit workflow work without destructive cancellation.
 *
 * This is the graceful public quit primitive. Order matters, because quit is
 * documented as an exact durability boundary:
 *
 * 1. pause every controllable stage and await its acknowledgement;
 * 2. close the root-shared `ctx.tool` admission boundary, so no root or nested
 *    run can admit another callback, and await open registration sections;
 * 3. rescan every root/nested tool handle — after the close the set can only
 *    shrink, so one scan is enough and no rescan loop can spin;
 * 4. abort that set, wait a bounded interval, and publish settled/abandoned
 *    nodes as cancelled;
 * 5. only then record the durable paused transition and the resumable run.
 *
 * Step 4 is the point of no return: an aborted callback cannot be un-aborted,
 * and the executor that observed the abort suspends without writing any
 * terminal record. So once it has run, step 5 publishes the local paused record
 * whatever the durable transition does — a durable failure that skipped it left
 * a run reported as running with nothing running it, and no live handle for a
 * retry to rediscover. Only `resumable` follows the durable outcome.
 *
 * A callback that ignores its signal is abandoned rather than pinning quit; its
 * `{runId, nodeId}` identity is reported in `abandonedTools`.
 *
 * It deliberately does NOT abort through the cancellation registry or append a
 * terminal `workflow.run.end` entry. Destructive cancellation remains an
 * internal lifecycle mechanism.
 */
export async function quitRun(
	runId: string,
	opts?: {
		store?: Store;
		stageControlRegistry?: StageControlRegistry;
		toolControlRegistry?: ToolControlRegistry;
		jobs?: JobTracker;
	},
): Promise<QuitRunResult> {
	const activeStore = opts?.store ?? defaultStore;
	const registry = opts?.stageControlRegistry ?? defaultStageControlRegistry;
	const toolControls = opts?.toolControlRegistry ?? defaultToolControlRegistry;
	const jobs = opts?.jobs ?? defaultJobTracker;
	const run = activeStore.runs().find((candidate) => candidate.id === runId);
	if (!run) return { ok: false, runId, reason: "not_found" };
	if (run.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };

	const graph = expandWorkflowGraph(readGraphStoreSnapshot(activeStore), runId);
	const handles = controllableHandles(activeStore, registry, runId);
	const admissionBoundaries = controllableAdmissionBoundaries(activeStore, toolControls, runId);
	const promptStages = graph.stages.filter(
		(stage) =>
			stage.pendingPrompt !== undefined || stage.inputRequest !== undefined || stage.status === "awaiting_input",
	);
	const hasPausedState = run.status === "paused" || graph.stages.some((stage) => stage.status === "paused");
	const hasLiveToolWork =
		controllableToolHandles(activeStore, toolControls, runId).length > 0 ||
		admissionBoundaries.some((boundary) => boundary.hasPendingAdmissions);
	// Nothing controllable: leave admission open so an ordinary between-stages run
	// keeps working exactly as before.
	if (handles.length === 0 && !hasLiveToolWork && promptStages.length === 0 && !hasPausedState) {
		return { ok: false, runId, reason: "no_active_stages" };
	}

	const paused: StageSnapshot[] = [];
	const pausedRunIds = new Set<string>();
	const pausable = handles.filter(({ handle }) => handle.status !== "paused");
	const settled = await Promise.allSettled(pausable.map(({ handle }) => handle.pause()));
	const pauseFailures: string[] = [];
	settled.forEach((result, index) => {
		const target = pausable[index]!;
		if (result.status === "rejected") {
			const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
			pauseFailures.push(`${target.controlRunId}/${target.handle.stageId}: ${message}`);
			return;
		}
		const controlRun = activeStore.runs().find((candidate) => candidate.id === target.controlRunId);
		if (controlRun?.endedAt !== undefined) return;
		activeStore.recordStagePaused(target.controlRunId, target.handle.stageId);
		const stage = activeStore
			.runs()
			.find((candidate) => candidate.id === target.controlRunId)
			?.stages.find((candidate) => candidate.id === target.handle.stageId);
		if (stage?.status === "paused") {
			pausedRunIds.add(target.controlRunId);
			paused.push(structuredClone(stage));
		}
	});
	if (pauseFailures.length > 0) {
		throw new Error(`Failed to pause workflow stages: ${pauseFailures.join("; ")}`);
	}

	for (const promptStage of promptStages) {
		const target = promptStage.workflowGraphTarget;
		activeStore.recordStagePaused(target.runId, target.stageId);
		pausedRunIds.add(target.runId);
	}
	// Durability boundary. Closing admission first is what makes the following
	// scan final: a callback admitted while the stage pauses were still being
	// acknowledged is included, and none can start afterwards — not even while
	// `markDurableQuit()` awaits the backend.
	await closeToolAdmission(admissionBoundaries, runId);
	const toolHandles = controllableToolHandles(activeStore, toolControls, runId);
	const abandonedTools = await abortInFlightTools(activeStore, toolHandles);
	const cancelledTools = collectCancelledToolNodes(activeStore, toolHandles);
	// A nested run whose tool was aborted has no paused stage of its own; mark it
	// paused too so the boundary's live state matches the root's.
	for (const handle of toolHandles) if (handle.runId !== runId) pausedRunIds.add(handle.runId);
	const current = activeStore.runs().find((candidate) => candidate.id === runId);
	if (current === undefined) return { ok: false, runId, reason: "not_found" };
	if (current.endedAt !== undefined) return { ok: false, runId, reason: "already_ended" };
	// A quit that aborted a call is committed: each of those callbacks observed a
	// whole-run quit, so its executor suspends without writing any terminal
	// record, and only the publication below can report that the run stopped.
	const suspendedByAbort = toolHandles.length > 0;
	const publish = (resumable: boolean): void => {
		publishLocalQuit(activeStore, runId, pausedRunIds, resumable);
		// An abandoned callback keeps its executor alive, but that executor is no
		// longer authoritative for this run id: detach it so `/workflow resume`
		// relaunches a fresh executor instead of adopting the stale job and
		// reporting a running run nothing is actually running. Cooperative quits
		// settle on their own and unregister themselves.
		if (abandonedTools.length > 0) jobs.detach(runId, jobs.get(runId));
	};
	let durableTransition: DurableQuitOutcome;
	try {
		durableTransition = await markDurableQuit(runId, current);
	} catch (error) {
		if (!suspendedByAbort) throw error;
		publish(false);
		throw new Error(unrecordedDurableQuitMessage(error), { cause: error });
	}
	if (durableTransition === "refused") {
		if (suspendedByAbort) publish(false);
		return { ok: false, runId, reason: "already_ended" };
	}
	publish(true);
	return { ok: true, runId, paused, cancelledTools, abandonedTools };
}

/**
 * Publish the local paused record for this workflow boundary.
 *
 * `resumable` follows the durable outcome rather than the local one: a pause the
 * durable backend never accepted is still real — the run stopped — but no future
 * process could resume from it, so it is not advertised as resumable. Recording
 * it keeps the run controllable, so a later `/workflow quit` re-attempts the
 * transition and upgrades the record.
 */
function publishLocalQuit(
	activeStore: Store,
	runId: string,
	pausedRunIds: ReadonlySet<string>,
	resumable: boolean,
): void {
	for (const pausedRunId of pausedRunIds) activeStore.recordRunPaused(pausedRunId);
	activeStore.recordRunPaused(runId, undefined, { exitReason: "quit", resumable });
}

/**
 * Report what the failed durable write left behind, not merely that it failed.
 *
 * Every caller already names the run ("Failed to quit run …: "), so this reads
 * as the rest of that sentence.
 */
function unrecordedDurableQuitMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return (
		`the in-flight ctx.tool work was cancelled but the durable paused transition failed: ${detail}.` +
		" The run is paused locally and is not resumable until a retried quit records it durably."
	);
}

/** Distinct admission boundaries owned by this workflow boundary's runs. */
function controllableAdmissionBoundaries(
	activeStore: Store,
	toolControls: ToolControlRegistry,
	runId: string,
): readonly ToolAdmissionBoundary[] {
	const boundaries = new Set<ToolAdmissionBoundary>();
	for (const controlRunId of expandedControlRunIds(activeStore, runId)) {
		const boundary = toolControls.admissionBoundary(controlRunId);
		if (boundary !== undefined) boundaries.add(boundary);
	}
	return [...boundaries];
}

/**
 * Refuse further `ctx.tool` admissions and wait for calls already inside their
 * short registration section. A call refused after this point receives the
 * graceful-quit signal, so it suspends the executor instead of failing the run.
 */
async function closeToolAdmission(boundaries: readonly ToolAdmissionBoundary[], runId: string): Promise<void> {
	if (boundaries.length === 0) return;
	const reason = new WorkflowGracefulQuitError(runId, `run ${runId}`);
	await Promise.all(boundaries.map((boundary) => boundary.closeForQuit(reason)));
}

/** In-flight tool nodes below this workflow boundary, including nested runs. */
function controllableToolHandles(
	activeStore: Store,
	toolControls: ToolControlRegistry,
	runId: string,
): readonly ToolControlHandle[] {
	return expandedControlRunIds(activeStore, runId).flatMap((controlRunId) => [...toolControls.active(controlRunId)]);
}

/**
 * Abort every selected tool node, wait a bounded interval for settlement, and
 * publish anything still unsettled as cancelled. Returns the abandoned
 * identities, keyed by owning run so nested duplicates stay distinguishable.
 */
async function abortInFlightTools(
	activeStore: Store,
	toolHandles: readonly ToolControlHandle[],
): Promise<readonly WorkflowToolNodeIdentity[]> {
	if (toolHandles.length === 0) return [];
	for (const handle of toolHandles) handle.abort("quit");
	const abandoned = await settleAbortedToolNodes(toolHandles, TOOL_QUIT_SETTLEMENT_TIMEOUT_MS);
	const endedAt = Date.now();
	for (const handle of toolHandles) {
		if (!abandoned.some((identity) => sameToolNodeIdentity(identity, handle))) continue;
		activeStore.recordToolNodeEnd(handle.runId, handle.nodeId, {
			status: "cancelled",
			endedAt,
			error: `atomic-workflows: ctx.tool ${handle.name} abandoned after quit; the callback ignored its abort signal`,
		});
	}
	return abandoned;
}

function collectCancelledToolNodes(
	activeStore: Store,
	toolHandles: readonly ToolControlHandle[],
): readonly WorkflowCancelledToolNode[] {
	return toolHandles.flatMap((handle) => {
		const node = activeStore
			.runs()
			.find((candidate) => candidate.id === handle.runId)
			?.toolNodes?.find((candidate) => candidate.id === handle.nodeId);
		if (node === undefined || node.status !== "cancelled") return [];
		return [{ runId: handle.runId, nodeId: handle.nodeId, node: structuredClone(node) }];
	});
}

function controllableHandles(
	activeStore: Store,
	registry: StageControlRegistry,
	runId: string,
): Array<{ controlRunId: string; handle: StageControlHandle }> {
	const graph = expandWorkflowGraph(readGraphStoreSnapshot(activeStore), runId);
	const controlRunIds = new Set<string>([runId]);
	for (const stage of graph.stages) controlRunIds.add(stage.workflowGraphTarget.runId);
	return [...controlRunIds].flatMap((controlRunId) =>
		registry
			.run(controlRunId)
			.stages()
			.filter(
				(handle) =>
					handle.status === "running" ||
					handle.status === "pending" ||
					handle.status === "awaiting_input" ||
					handle.status === "paused",
			)
			.map((handle) => ({ controlRunId, handle })),
	);
}

type DurableQuitOutcome = "transitioned" | "not_needed" | "refused";

async function markDurableQuit(runId: string, run: RunSnapshot): Promise<DurableQuitOutcome> {
	const backend = discoverDurableQuitBackend(runId);
	if (backend === undefined) return "not_needed";
	// The workflow is durably tracked, so a failure to persist the paused
	// transition or flush it must surface: swallowing it here would let quitRun
	// advertise a resumable pause no future process could resume from. The caller
	// still reconciles an already-suspended executor into a pause that is not
	// advertised as resumable, so the failure costs the promise, not the record.
	const transitioned = await transitionDurableWorkflowStatus(
		backend,
		runId,
		["running", "paused"],
		"paused",
		undefined,
		true,
	);
	if (!transitioned) return "refused";
	// Persist the exact accumulated run elapsed at quit time so a later durable
	// resume seeds the total workflow duration with prior-session time.
	recordRunTimingCheckpoint(backend, run);
	await backend.flush();
	return "transitioned";
}

/**
 * Resolve the durable backend only when `runId` is durably tracked. Discovery
 * stays best-effort for custom backends that throw on unsupported inspection;
 * the persistence writes performed after a positive match are intentionally
 * left to propagate so genuine durable failures are not masked.
 */
function discoverDurableQuitBackend(runId: string): DurableWorkflowBackend | undefined {
	try {
		const backend = getDurableBackend();
		return getLoadableDurableWorkflow(backend, runId) === undefined ? undefined : backend;
	} catch {
		return undefined;
	}
}

export async function quitAllRuns(opts?: {
	store?: Store;
	stageControlRegistry?: StageControlRegistry;
	toolControlRegistry?: ToolControlRegistry;
	jobs?: JobTracker;
}): Promise<QuitAllRunResult[]> {
	const activeStore = opts?.store ?? defaultStore;
	const inFlight = topLevelWorkflowRuns(activeStore.runs()).filter((run) => run.endedAt === undefined);
	const attempts = inFlight.map((run) =>
		quitRun(run.id, {
			store: activeStore,
			stageControlRegistry: opts?.stageControlRegistry,
			toolControlRegistry: opts?.toolControlRegistry,
			jobs: opts?.jobs,
		}),
	);
	const settled = await Promise.allSettled(attempts);
	return settled.map((result, index) => {
		if (result.status === "fulfilled") return result.value;
		const runId = inFlight[index]!.id;
		return {
			ok: false,
			runId,
			reason: "pause_failed",
			message: result.reason instanceof Error ? result.reason.message : String(result.reason),
		};
	});
}
