/** Durable `ctx.stage` / `ctx.task` replay and checkpoint helpers. */

import type { SessionStore } from "@bastani/atomic";
import { assertStageOwnedSessionExists, type StageOwnedSession } from "../engine/run-resume-preflight.js";
import type { ParallelFailFastScope } from "../runs/foreground/executor-types.js";
import { readStoredStageMessages } from "../runs/foreground/stage-runner-options.js";
import { RESUME_CONTINUATION_PROMPT } from "../shared/resume-continuation.js";
import type { StageWaitToolResult } from "../shared/stage-wait.js";
import { StageRehydrationError, StageReleasedError, type StageReleasedProperty } from "../shared/stage-wait-errors.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs, stageTimingFields } from "../shared/timing.js";
import type {
	StageContext,
	StageOptions,
	WorkflowChildResult,
	WorkflowOutputValues,
	WorkflowSerializableValue,
	WorkflowTaskOptions,
	WorkflowTaskResult,
	WorkflowThinkingLevel,
} from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import { activeStageTopology, durableStageCheckpointMetadata } from "./stage-topology.js";
import { recordCheckpointDurably } from "./tool-primitive.js";
import type { DurableReleasedStageResume, DurableStageCheckpoint, DurableStageRunTopology } from "./types.js";
import { parseWorkflowChildResult } from "./workflow-child-result.js";
import { stageWorktreeSnapshot } from "./worktree-snapshots.js";
export type DurableCompletedStageCheckpoint = DurableStageCheckpoint & { readonly output: WorkflowSerializableValue };

export interface DurableStageDeps {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextCheckpointId: () => string;
	readonly nextReplayKey: (stageName: string) => string;
	readonly replayKeyForCompletedStage?: (stage: StageSnapshot) => string | undefined;
	readonly runTopology?: DurableStageRunTopology;
	readonly sourceOrderForStage?: (stage: StageSnapshot) => number | undefined;
	readonly now?: () => number;
	readonly beforeCheckpoint?: () => void | Promise<void>;
	readonly recordLiveCheckpoint?: import("./worktree-snapshot-recorder.js").WorkflowSnapshotRecord;
	readonly stageDirectories?: (stage: StageSnapshot) => readonly string[];
}

export async function recordStageCheckpoint(
	deps: DurableStageDeps,
	stage: StageSnapshot,
	options?: { readonly metadataOnly?: boolean },
): Promise<boolean> {
	if (stage.status !== "completed" && stage.status !== "failed" && stage.status !== "skipped") return false;
	const replayKey = deps.replayKeyForCompletedStage?.(stage) ?? stage.replayKey ?? deps.nextReplayKey(stage.name);
	const metadata = durableStageCheckpointMetadata(stage, deps.runTopology, deps.sourceOrderForStage?.(stage));
	const hasExistingOutput = deps.backend.getStageOutput(deps.workflowId, replayKey) !== undefined;
	const metadataOnly = options?.metadataOnly === true || stage.status !== "completed" || hasExistingOutput;
	const checkpoint: DurableStageCheckpoint = metadataOnly
		? {
				kind: "stage",
				workflowId: deps.workflowId,
				checkpointId: stageMetadataCheckpointId(replayKey, stage),
				name: stage.name,
				replayKey,
				completedAt: stage.endedAt ?? Date.now(),
				...metadata,
			}
		: {
				kind: "stage",
				workflowId: deps.workflowId,
				checkpointId: stableCheckpointId("stage", replayKey),
				name: stage.name,
				replayKey,
				output: stageOutput(stage),
				completedAt: stage.endedAt ?? Date.now(),
				...metadata,
			};
	await deps.beforeCheckpoint?.();
	if (stage.status === "completed" && stage.replayed !== true && deps.recordLiveCheckpoint) {
		const snapshot = (await deps.recordLiveCheckpoint(checkpoint, undefined, deps.stageDirectories?.(stage))).at(-1);
		if (snapshot !== undefined) stage.snapshot = stageWorktreeSnapshot(snapshot);
	} else await recordCheckpointDurably(deps.backend, checkpoint);
	return true;
}

// Duration-only session updates are bucketed; identity changes still persist immediately.
const STAGE_SESSION_DURATION_BUCKET_MS = 30_000;

function stageSessionDurationBucket(durationMs: number | undefined): number {
	return Math.floor((durationMs ?? 0) / STAGE_SESSION_DURATION_BUCKET_MS);
}

export async function recordStageSessionCheckpoint(
	deps: DurableStageDeps,
	stage: StageSnapshot,
	options?: { readonly force?: boolean },
): Promise<boolean> {
	const replayKey = deps.replayKeyForCompletedStage?.(stage) ?? stage.replayKey ?? deps.nextReplayKey(stage.name);
	if (stage.sessionId === undefined) return false;
	const checkpointNow = deps.now?.() ?? Date.now();
	const durationMs = elapsedStageMs(stage, checkpointNow) ?? 0;
	const current = deps.backend.getStageSession(deps.workflowId, replayKey);
	if (
		options?.force !== true &&
		current !== undefined &&
		current.sessionId === stage.sessionId &&
		current.startedAt === stage.startedAt &&
		stageSessionDurationBucket(current.durationMs) === stageSessionDurationBucket(durationMs)
	)
		return false;
	const checkpoint: DurableStageCheckpoint = {
		kind: "stage",
		workflowId: deps.workflowId,
		checkpointId: stageSessionCheckpointId(
			replayKey,
			stage,
			durationMs,
			options?.force === true ? checkpointNow : undefined,
		),
		name: stage.name,
		replayKey,
		...durableStageCheckpointMetadata(stage, deps.runTopology, deps.sourceOrderForStage?.(stage)),
		...(stage.sessionId !== undefined ? { sessionId: stage.sessionId } : {}),
		sessionFile: stage.sessionFile,
		...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
		durationMs,
		completedAt: checkpointNow,
	};
	await deps.beforeCheckpoint?.();
	await recordCheckpointDurably(deps.backend, checkpoint);
	return true;
}

const MID_SESSION_RESUME_PROMPT = RESUME_CONTINUATION_PROMPT;

function withMidSessionResumePrompt<T extends StageContext>(stage: T, enabled: boolean): T {
	if (!enabled) return stage;
	// Override in place: spreading would eagerly read lazy session getters before prompt().
	const originalPrompt = stage.prompt.bind(stage);
	Object.defineProperty(stage, "prompt", {
		value: (_text: string, options?: Parameters<StageContext["prompt"]>[1]) =>
			originalPrompt(MID_SESSION_RESUME_PROMPT, options as never),
		writable: true,
		configurable: true,
		enumerable: true,
	});
	return stage;
}

/**
 * The latest resumable session record of each stage and task replay key, as the run's journal holds it. A record
 * carrying `wait` means the stage was waiting with its session released when it was written.
 */
export function latestStageSessionCheckpoints(
	backend: DurableWorkflowBackend,
	workflowId: string,
): Map<string, DurableStageCheckpoint> {
	const latest = new Map<string, DurableStageCheckpoint>();
	for (const checkpoint of backend.listCheckpoints(workflowId)) {
		if (checkpoint.kind !== "stage" || checkpoint.sessionId === undefined) continue;
		const previous = latest.get(checkpoint.replayKey);
		if (previous === undefined || checkpoint.completedAt >= previous.completedAt)
			latest.set(checkpoint.replayKey, checkpoint);
	}
	return latest;
}

/** A stage the run's previous process left waiting with its session released. */
export interface DurableWaitingStage {
	readonly replayKey: string;
	readonly stageName: string;
	readonly stageId?: string;
	readonly sessionId: string;
	/** Where a file-backed store kept the transcript, when the stage recorded it. */
	readonly sessionFile?: string;
	/** `"stage"`: the session is in the store the stage's own `sessionStore` option supplied, not the run's. */
	readonly sessionStorage?: "stage";
	readonly wait: import("../shared/authoring-contract-stage.js").StageWaitSnapshot;
}

/**
 * Every stage of the run that its previous process left waiting, from one pass over the run's checkpoints (`latest`,
 * when the caller already made that pass). Only the run's own stages: a pooled root's journal also holds the
 * checkpoints of its pool's children, whose sessions live in the pool's stores, and a child run checks its own stages
 * through its scoped view before its body runs (#4318, #4440).
 */
export function durableWaitingStages(
	backend: DurableWorkflowBackend,
	workflowId: string,
	latest: ReadonlyMap<string, DurableStageCheckpoint> = latestStageSessionCheckpoints(backend, workflowId),
): DurableWaitingStage[] {
	const waiting: DurableWaitingStage[] = [];
	for (const checkpoint of latest.values()) {
		if (checkpoint.wait === undefined || checkpoint.sessionId === undefined) continue;
		const ownerRunId = checkpoint.topology?.run?.runId;
		if (ownerRunId !== undefined && ownerRunId !== workflowId) continue;
		waiting.push({
			replayKey: checkpoint.replayKey,
			stageName: checkpoint.name,
			...(checkpoint.topology?.stageId === undefined ? {} : { stageId: checkpoint.topology.stageId }),
			sessionId: checkpoint.sessionId,
			...(checkpoint.sessionFile === undefined ? {} : { sessionFile: checkpoint.sessionFile }),
			...(checkpoint.sessionStorage === "stage" ? { sessionStorage: "stage" as const } : {}),
			wait: checkpoint.wait,
		});
	}
	return waiting;
}

/**
 * The results each stage's detached calls delivered that the run's previous process recorded before the stage's
 * transcript held them, by the stage's replay key. A resumed stage continues its turn from them instead of running
 * the calls again (#4309).
 */
export function durableRecordedToolResults(
	backend: DurableWorkflowBackend,
	workflowId: string,
	latest: ReadonlyMap<string, DurableStageCheckpoint> = latestStageSessionCheckpoints(backend, workflowId),
): Map<string, readonly StageWaitToolResult[]> {
	const recorded = new Map<string, readonly StageWaitToolResult[]>();
	for (const checkpoint of latest.values())
		if (checkpoint.waitResults !== undefined && checkpoint.waitResults.length > 0)
			recorded.set(checkpoint.replayKey, checkpoint.waitResults);
	return recorded;
}

/**
 * A stage whose previous process stopped while it waited between turns (`release` or `idle`) resumes released and
 * replays its finished calls from the record, instead of being prompted to continue. Undefined for every other stage,
 * and for a record that cannot answer the calls it says finished.
 */
function releasedStageResume(
	checkpoint: DurableStageCheckpoint | undefined,
	cached: DurableCompletedStageCheckpoint | undefined,
): DurableReleasedStageResume | undefined {
	const wait = checkpoint?.wait;
	const sessionId = checkpoint?.sessionId;
	if (wait === undefined || sessionId === undefined || (wait.kind !== "release" && wait.kind !== "idle"))
		return undefined;
	const promptsCompleted = wait.promptsCompleted ?? 0;
	// A stage that completed answers at least its first call from the record; a record without that count predates it.
	if (cached === undefined) return promptsCompleted === 0 ? { wait, sessionId, promptsCompleted } : undefined;
	if (promptsCompleted === 0) return undefined;
	return {
		wait,
		sessionId,
		promptsCompleted,
		recorded: {
			output: cached.output,
			...(cached.result === undefined ? {} : { result: cached.result }),
			...(cached.structured === undefined ? {} : { structured: cached.structured }),
		},
	};
}

function pendingStageIdForReplay(
	backend: DurableWorkflowBackend,
	workflowId: string,
	replayKey: string,
	stageName: string,
): string | undefined {
	const candidates = new Set(
		(backend.getWorkflow(workflowId)?.pendingStageMessages ?? [])
			.filter(
				(entry) =>
					entry.stageReplayKey === replayKey ||
					(entry.stageReplayKey === undefined && entry.stageKey === stageName),
			)
			.map((entry) => entry.stageId)
			.filter((stageId): stageId is string => stageId !== undefined),
	);
	return candidates.size === 1 ? candidates.values().next().value : undefined;
}
export function createDurableStagePrimitive(input: {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextReplayKey: (stageName: string) => string;
	readonly stage: (
		name: string,
		options: StageOptions,
		replayKey: string,
	) => StageContext & { readonly __resumeReleased?: (resume: DurableReleasedStageResume) => void };
	readonly durableIntercomGroup?: (replayKey: string, stageId: string | undefined) => string | undefined;
	readonly beforeCall?: () => void | Promise<void>;
	readonly beforeCheckpoint?: () => void | Promise<void>;
	readonly recordCachedStage?: (
		name: string,
		replayKey: string,
		checkpoint: DurableCompletedStageCheckpoint,
	) => void | Promise<void>;
	/**
	 * Read the stored messages of a replayed stage's session, from the store the stage would reopen it from with
	 * `options`. Defaults to the stage's own `sessionStore`, `sessionManager` or `sessionDir`, then the default store.
	 */
	readonly readStoredMessages?: (options: StageOptions, sessionId: string) => Promise<readonly object[]>;
}): (name: string, options?: StageOptions, reservedReplayKey?: string) => StageContext {
	// The session records the previous process left, read once: a stage writes its own records only after it starts.
	let priorSessions: Map<string, DurableStageCheckpoint> | undefined;
	return (name: string, options?: StageOptions, reservedReplayKey?: string): StageContext => {
		const replayKey = reservedReplayKey ?? input.nextReplayKey(name);
		priorSessions ??= latestStageSessionCheckpoints(input.backend, input.workflowId);
		const priorSession = priorSessions.get(replayKey);
		priorSessions.delete(replayKey);
		const cached = stageCheckpointWithOutput(input.backend, input.workflowId, replayKey);
		// A stage held across a wait between turns stays live after it completed: its later calls may still run.
		const released = releasedStageResume(priorSession, cached);
		if (cached !== undefined && released === undefined) {
			const recorded = input.recordCachedStage?.(name, replayKey, cached);
			// A transcript the stage kept in its own store is read only from the store the workflow passes it now.
			const ownedStore = (cached.sessionStorage ?? priorSession?.sessionStorage) === "stage";
			const readStoredMessages = (sessionId: string): Promise<readonly object[]> =>
				(input.readStoredMessages ?? readStoredStageMessagesWithOwnStore)(options ?? {}, sessionId);
			return withStageWriteBarrier(
				createCachedStageContext({
					name,
					runId: input.workflowId,
					checkpoint: cached,
					recorded,
					readStoredMessages: ownedStore
						? async (sessionId) => {
								await assertStageOwnedSessionExists(stageOwnedStore(options), {
									runId: input.workflowId,
									stageName: name,
									...(cached.topology?.stageId === undefined ? {} : { stageId: cached.topology.stageId }),
									sessionId,
								});
								return readStoredMessages(sessionId);
							}
						: readStoredMessages,
				}),
				input.beforeCall,
			);
		}
		const session = input.backend.getStageSession(input.workflowId, replayKey);
		const resumeSessionId = released?.sessionId ?? session?.sessionId;
		const topology = activeStageTopology(input.backend, input.workflowId, replayKey);
		const durableStageId =
			topology?.stageId ?? pendingStageIdForReplay(input.backend, input.workflowId, replayKey, name);
		const durableIntercomGroup = topology?.intercomGroup ?? input.durableIntercomGroup?.(replayKey, durableStageId);
		const liveOptions: StageOptions = {
			...(options ?? {}),
			durableReplayKey: replayKey,
			...(durableStageId !== undefined ? { durableStageId } : {}),
			...(topology !== undefined ? { durableParentIds: [...topology.parentIds] } : {}),
			...(durableIntercomGroup !== undefined ? { durableIntercomGroup } : {}),
			...(resumeSessionId !== undefined
				? {
						resumeFromSessionId: resumeSessionId,
						...(session?.sessionFile !== undefined ? { resumeFromLegacySessionFile: session.sessionFile } : {}),
						routerSelection: session?.routerSelection,
						durableAccumulatedDurationMs: session?.durationMs ?? 0,
					}
				: {}),
		};
		const stage = input.stage(name, liveOptions, replayKey);
		// Stopped between turns: replay the finished calls from the record and send the next one as written. Stopped
		// inside a turn: continue that turn.
		if (released !== undefined) stage.__resumeReleased?.(released);
		// A session the stage kept in its own store is checked in the store the workflow passes the stage now, before
		// any call of the stage that opens or reads a session: the run's preflight could not know that store.
		const checked =
			priorSession?.sessionStorage === "stage" &&
			resumeSessionId !== undefined &&
			resumeSessionId === priorSession.sessionId
				? withStageOwnedSessionCheck(stage, stageOwnedStore(options), {
						runId: input.workflowId,
						stageName: name,
						...(durableStageId === undefined ? {} : { stageId: durableStageId }),
						sessionId: resumeSessionId,
					})
				: stage;
		const live = withStageWriteBarrier(
			withMidSessionResumePrompt(checked, resumeSessionId !== undefined && released === undefined),
			input.beforeCall,
		);
		if (options?.schema === undefined) return live;
		return wrapSchemaStageForDurability({
			stage: live,
			workflowId: input.workflowId,
			backend: input.backend,
			replayKey,
			beforeCheckpoint: input.beforeCheckpoint,
			name,
		});
	};
}

/** The calls of a stage that open, reopen or read its session, or change what it runs on. */
const SESSION_CALLS = [
	"prompt",
	"complete",
	"sendUserMessage",
	"steer",
	"followUp",
	"setModel",
	"setThinkingLevel",
	"cycleModel",
	"cycleThinkingLevel",
	"readMessages",
	"navigateTree",
	"compact",
	"rehydrate",
] as const satisfies readonly (keyof StageContext)[];

type SessionCall = (typeof SESSION_CALLS)[number];

/** The store a stage's own options name for its session: its `sessionStore`, or its `sessionManager`'s store. */
function stageOwnedStore(options: StageOptions | undefined): SessionStore | undefined {
	return options?.sessionStore ?? options?.sessionManager?.getSessionStore();
}

/**
 * `stage`, whose session is in its own store, with a check of the store the workflow passes it now before the first
 * of its {@link SESSION_CALLS}: a store without the session, or none, fails such calls typed. Once the check passes,
 * only that it passed is kept; concurrent first calls share the one check in flight.
 */
function withStageOwnedSessionCheck(
	stage: StageContext,
	store: SessionStore | undefined,
	owned: StageOwnedSession,
): StageContext {
	let verified = false;
	let inFlight: Promise<void> | undefined;
	const verify = async (): Promise<void> => {
		if (verified) return;
		inFlight ??= assertStageOwnedSessionExists(store, owned).finally(() => {
			inFlight = undefined;
		});
		await inFlight;
		verified = true;
	};
	const wrapped = Object.create(stage) as StageContext;
	for (const method of SESSION_CALLS) {
		const call = stage[method] as (...args: never[]) => ReturnType<StageContext[SessionCall]>;
		Object.defineProperty(wrapped, method, {
			value: async (...args: never[]) => {
				await verify();
				return call.apply(stage, args);
			},
			writable: true,
			configurable: true,
		});
	}
	return wrapped;
}

function withStageWriteBarrier(stage: StageContext, beforeCall?: () => void | Promise<void>): StageContext {
	if (beforeCall === undefined) return stage;
	const wrapped = Object.create(stage) as StageContext;
	Object.defineProperties(wrapped, {
		prompt: {
			value: async (...args: Parameters<StageContext["prompt"]>) => {
				await beforeCall();
				return stage.prompt(...args);
			},
		},
		complete: {
			value: async (...args: Parameters<StageContext["complete"]>) => {
				await beforeCall();
				return stage.complete(...args);
			},
		},
	});
	return wrapped;
}

export const TASK_RESULT_CHECKPOINT_CONTROL_PREFIX = "task-checkpoint:";

export function createDurableTaskPrimitive(input: {
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly nextReplayKey: (stageName: string) => string;
	readonly task: (
		name: string,
		options: WorkflowTaskOptions,
		stageFailFastScope?: ParallelFailFastScope,
	) => Promise<WorkflowTaskResult>;
	readonly durableIntercomGroup?: (replayKey: string, stageId: string | undefined) => string | undefined;
	readonly recordCachedTask?: (
		name: string,
		replayKey: string,
		checkpoint: DurableCompletedStageCheckpoint,
		stageFailFastScope?: ParallelFailFastScope,
	) => void | Promise<void>;
	readonly afterLiveResult?: (name: string) => Promise<void>;
	readonly beforeCheckpoint?: () => void | Promise<void>;
	readonly recordLiveCheckpoint?: import("./worktree-snapshot-recorder.js").WorkflowSnapshotRecord;
	readonly signal?: AbortSignal;
	readonly registerTailControl?: (registration: {
		readonly nodeId: string;
		readonly name: string;
		readonly controller: AbortController;
		readonly settled: Promise<void>;
	}) => () => void;
}): (
	name: string,
	options: WorkflowTaskOptions,
	stageFailFastScope?: ParallelFailFastScope,
) => Promise<WorkflowTaskResult> {
	return async (
		name: string,
		options: WorkflowTaskOptions,
		stageFailFastScope?: ParallelFailFastScope,
	): Promise<WorkflowTaskResult> => {
		const replayKey = input.nextReplayKey(`task:${name}`);
		const restartFromPrompt = options.durableRestartFromPrompt === true;
		const replayed = restartFromPrompt
			? undefined
			: replayableTaskResult(name, input.backend, input.workflowId, replayKey);
		if (replayed !== undefined) {
			await input.recordCachedTask?.(name, replayKey, replayed.checkpoint, stageFailFastScope);
			return replayed.result;
		}
		const supersedesRecordedResult =
			restartFromPrompt && input.backend.getStageOutput(input.workflowId, replayKey) !== undefined;
		const session = restartFromPrompt ? undefined : input.backend.getStageSession(input.workflowId, replayKey);
		const topology = activeStageTopology(input.backend, input.workflowId, replayKey);
		const durableIntercomGroup =
			topology?.intercomGroup ?? input.durableIntercomGroup?.(replayKey, topology?.stageId);
		const taskOptions: WorkflowTaskOptions = {
			...options,
			durableReplayKey: replayKey,
			...(topology !== undefined
				? {
						durableStageId: topology.stageId,
						durableParentIds: [...topology.parentIds],
					}
				: {}),
			...(durableIntercomGroup !== undefined ? { durableIntercomGroup } : {}),
			...(session?.sessionId !== undefined
				? {
						resumeFromSessionId: session.sessionId,
						...(session.sessionFile !== undefined ? { resumeFromLegacySessionFile: session.sessionFile } : {}),
						routerSelection: session.routerSelection,
						durableAccumulatedDurationMs: session.durationMs ?? 0,
					}
				: {}),
		};
		const result = await input.task(name, taskOptions, stageFailFastScope);
		const completedTopology = activeStageTopology(input.backend, input.workflowId, replayKey);
		const tailController = new AbortController();
		const settlement = Promise.withResolvers<void>();
		const unregisterTail = input.registerTailControl?.({
			nodeId: `${TASK_RESULT_CHECKPOINT_CONTROL_PREFIX}${replayKey}`,
			name,
			controller: tailController,
			settled: settlement.promise,
		});
		const signal = mergeAbortSignals(input.signal, tailController.signal);
		try {
			await input.beforeCheckpoint?.();
			if (signal?.aborted) throw abortReasonError(signal);
			const completedAt = Date.now();
			const checkpoint: DurableStageCheckpoint = {
				kind: "stage",
				workflowId: input.workflowId,
				checkpointId: supersedesRecordedResult
					? supersedingTaskCheckpointId(replayKey, completedAt)
					: stableCheckpointId("task", replayKey),
				name,
				replayKey,
				output: result,
				completedAt,
				...taskCheckpointMetadata(result),
				...(completedTopology !== undefined ? { topology: completedTopology } : {}),
			};
			await awaitAbortable(
				signal,
				input.recordLiveCheckpoint
					? input
							.recordLiveCheckpoint(checkpoint, signal, options.cwd === undefined ? [] : [options.cwd])
							.then(() => {})
					: recordCheckpointDurably(input.backend, checkpoint, signal),
			);
		} catch (error) {
			if (error instanceof Error) throw error;
			throw new Error(String(error));
		} finally {
			settlement.resolve();
			unregisterTail?.();
		}
		if (input.afterLiveResult !== undefined) await input.afterLiveResult(name);
		return result;
	};
}

function abortReasonError(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("atomic-workflows: workflow cancelled");
}

function mergeAbortSignals(left?: AbortSignal, right?: AbortSignal): AbortSignal | undefined {
	if (left === undefined) return right;
	if (right === undefined) return left;
	return AbortSignal.any([left, right]);
}

function replayableTaskResult(
	name: string,
	backend: DurableWorkflowBackend,
	workflowId: string,
	replayKey: string,
): { readonly result: WorkflowTaskResult; readonly checkpoint: DurableCompletedStageCheckpoint } | undefined {
	const taskShaped = stageCheckpointWithOutput(backend, workflowId, replayKey, isWorkflowTaskResult);
	if (taskShaped !== undefined && isWorkflowTaskResult(taskShaped.output)) {
		return { result: completeTaskResult(name, taskShaped.output, taskShaped), checkpoint: taskShaped };
	}
	const terminal = stageCheckpointWithOutput(backend, workflowId, replayKey);
	if (terminal === undefined) return undefined;
	const result = taskResultFromTerminalCheckpoint(name, terminal);
	if (result === undefined) return undefined;
	return { result, checkpoint: { ...terminal, output: result } };
}

function taskResultFromTerminalCheckpoint(
	name: string,
	terminal: DurableCompletedStageCheckpoint,
): WorkflowTaskResult | undefined {
	if (isWorkflowTaskResult(terminal.output)) return completeTaskResult(name, terminal.output, terminal);
	if (terminal.structured !== undefined) {
		return completeTaskResult(
			name,
			{
				name,
				stageName: name,
				text: persistedTaskText(terminal, terminal.structured),
				structured: terminal.structured,
			},
			terminal,
		);
	}
	if (typeof terminal.output === "string") {
		return completeTaskResult(name, { name, stageName: name, text: terminal.output }, terminal);
	}
	if (terminal.output !== undefined) {
		return completeTaskResult(
			name,
			{
				name,
				stageName: name,
				text: terminal.result ?? taskTextFromValue(terminal.output),
				structured: terminal.output,
			},
			terminal,
		);
	}
	if (typeof terminal.result === "string") {
		return completeTaskResult(name, { name, stageName: name, text: terminal.result }, terminal);
	}
	return undefined;
}

function persistedTaskText(terminal: DurableCompletedStageCheckpoint, fallback: WorkflowSerializableValue): string {
	if (typeof terminal.result === "string") return terminal.result;
	if (typeof terminal.output === "string") return terminal.output;
	return taskTextFromValue(fallback);
}

function taskTextFromValue(value: WorkflowSerializableValue): string {
	return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function completeTaskResult(
	name: string,
	base: WorkflowTaskResult,
	checkpoint: DurableStageCheckpoint,
): WorkflowTaskResult {
	return {
		name: typeof base.name === "string" && base.name.length > 0 ? base.name : name,
		stageName: typeof base.stageName === "string" && base.stageName.length > 0 ? base.stageName : name,
		text: base.text,
		...(base.structured !== undefined || checkpoint.structured !== undefined
			? { structured: base.structured !== undefined ? base.structured : checkpoint.structured }
			: {}),
		...(base.sessionId !== undefined || checkpoint.sessionId !== undefined
			? { sessionId: base.sessionId ?? checkpoint.sessionId }
			: {}),
		...(base.sessionFile !== undefined || checkpoint.sessionFile !== undefined
			? { sessionFile: base.sessionFile ?? checkpoint.sessionFile }
			: {}),
		...(base.artifacts !== undefined || checkpoint.artifacts !== undefined
			? { artifacts: [...(base.artifacts ?? checkpoint.artifacts ?? [])] }
			: {}),
		...(base.model !== undefined || checkpoint.model !== undefined ? { model: base.model ?? checkpoint.model } : {}),
		...(base.thinkingLevel !== undefined || checkpoint.thinkingLevel !== undefined
			? { thinkingLevel: base.thinkingLevel ?? checkpoint.thinkingLevel }
			: {}),
		...(base.attemptedModels !== undefined || checkpoint.attemptedModels !== undefined
			? { attemptedModels: [...(base.attemptedModels ?? checkpoint.attemptedModels ?? [])] }
			: {}),
		...(base.modelAttempts !== undefined || checkpoint.modelAttempts !== undefined
			? { modelAttempts: [...(base.modelAttempts ?? checkpoint.modelAttempts ?? [])] }
			: {}),
		...(base.rateLimits !== undefined || checkpoint.rateLimits !== undefined
			? { rateLimits: [...(base.rateLimits ?? checkpoint.rateLimits ?? [])] }
			: {}),
		...((base.routerSelection ?? checkpoint.routerSelection) !== undefined
			? { routerSelection: base.routerSelection ?? checkpoint.routerSelection }
			: {}),
		...(base.warnings !== undefined || checkpoint.warnings !== undefined
			? { warnings: [...(base.warnings ?? checkpoint.warnings ?? [])] }
			: {}),
		...(base.changeSet !== undefined ? { changeSet: base.changeSet } : {}),
	};
}

async function awaitAbortable(signal: AbortSignal | undefined, work: Promise<void>): Promise<void> {
	if (signal === undefined) {
		await work;
		return;
	}
	if (signal.aborted) {
		void work.catch(() => undefined);
		throw abortReasonError(signal);
	}
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			onAbort = () => reject(abortReasonError(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			work.then(resolve, reject);
		});
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

function wrapSchemaStageForDurability(input: {
	readonly stage: StageContext;
	readonly workflowId: string;
	readonly backend: DurableWorkflowBackend;
	readonly replayKey: string;
	readonly beforeCheckpoint?: () => void | Promise<void>;
	readonly name: string;
}): StageContext {
	const stage = input.stage;
	const wrapped = Object.create(stage) as StageContext;
	Object.defineProperty(wrapped, "prompt", {
		value: async (text: string, options?: Parameters<StageContext["prompt"]>[1]) => {
			const result = await stage.prompt(text, options);
			// Checkpoint both structured results AND empty string results so that
			// a schema-backed stage returning "" is replayed as "" rather than
			// being dropped (treated as no checkpoint).
			// cross-ref: issue #1498 — empty string stage outputs must survive durable checkpointing.
			if (typeof result !== "string" || result.length === 0) {
				await input.beforeCheckpoint?.();
				await recordCheckpointDurably(input.backend, {
					kind: "stage",
					workflowId: input.workflowId,
					checkpointId: stableCheckpointId("stage", input.replayKey),
					name: input.name,
					replayKey: input.replayKey,
					output: result as WorkflowSerializableValue,
					completedAt: Date.now(),
				});
			}
			return result;
		},
	});
	return wrapped;
}

/**
 * The context of a stage a resumed run replays from its durable checkpoint. The stage completed before the restart and
 * runs no session: like a released stage, `messages` and `agent` throw `StageReleasedError`, `readMessages()` reads the
 * transcript from the session store, and `model` and `thinkingLevel` return the values its checkpoint recorded.
 * `release()` has nothing to give up; `rehydrate()` has no live session to reopen and throws `StageRehydrationError`
 * (`replayed-stage`).
 */
function createCachedStageContext(input: {
	readonly name: string;
	readonly runId: string;
	readonly checkpoint: DurableCompletedStageCheckpoint;
	readonly recorded?: void | Promise<void>;
	readonly readStoredMessages: (sessionId: string) => Promise<readonly object[]>;
}): StageContext {
	const { name, checkpoint } = input;
	const { output, result } = checkpoint;
	const persistence = Promise.resolve(input.recorded);
	void persistence.catch(() => {});
	const text = result ?? (typeof output === "string" ? output : JSON.stringify(output));
	const unsupported = async (): Promise<never> => {
		throw new Error(
			`Stage "${name}" was replayed from a durable checkpoint; live session operations are unavailable.`,
		);
	};
	const fields = {
		runId: input.runId,
		stageName: name,
		...(checkpoint.sessionId === undefined ? {} : { sessionId: checkpoint.sessionId }),
		replayed: true,
	};
	const released = (property: StageReleasedProperty): never => {
		throw new StageReleasedError({ ...fields, property });
	};
	let requestedThinkingLevel: WorkflowThinkingLevel | undefined;
	const cached = {
		name,
		async prompt() {
			await persistence;
			return output as Awaited<ReturnType<StageContext["prompt"]>>;
		},
		async complete() {
			await persistence;
			return text;
		},
		sendUserMessage: unsupported,
		async steer() {},
		async followUp() {},
		subscribe() {
			return () => {};
		},
		sessionFile: undefined,
		sessionId: `durable-replay:${name}`,
		setModel: unsupported,
		setThinkingLevel(level: WorkflowThinkingLevel) {
			requestedThinkingLevel = level;
		},
		cycleModel: unsupported,
		cycleThinkingLevel() {
			return undefined;
		},
		get agent(): object {
			return released("agent");
		},
		get model(): string {
			return checkpoint.model ?? released("model");
		},
		get thinkingLevel(): WorkflowThinkingLevel {
			return (
				requestedThinkingLevel ??
				(checkpoint.thinkingLevel as WorkflowThinkingLevel | undefined) ??
				released("thinkingLevel")
			);
		},
		get messages(): readonly object[] {
			return released("messages");
		},
		async readMessages(): Promise<readonly object[]> {
			return checkpoint.sessionId === undefined ? [] : input.readStoredMessages(checkpoint.sessionId);
		},
		isStreaming: false,
		navigateTree: unsupported,
		compact: unsupported,
		abortCompaction() {},
		abort: async () => {},
		async release() {},
		async rehydrate(): Promise<never> {
			throw new StageRehydrationError(fields, { code: "replayed-stage" });
		},
	};
	return cached as never as StageContext;
}

/** A replayed stage's stored messages, from the store its own options select; a store this read opens is closed. */
function readStoredStageMessagesWithOwnStore(options: StageOptions, sessionId: string): Promise<readonly object[]> {
	return readStoredStageMessages(options, undefined, sessionId);
}

function stageOutput(stage: StageSnapshot): WorkflowSerializableValue {
	// Preserve empty string ("") distinctly from undefined (no result).
	// A stage that completed with empty assistant text must replay as empty,
	// not be collapsed into a status object.
	// cross-ref: issue #1498 — empty string stage outputs must survive durable checkpointing.
	if (stage.result !== undefined) return stage.result;
	return { status: stage.status, stageId: stage.id };
}

function taskCheckpointMetadata(result: WorkflowTaskResult): Partial<DurableStageCheckpoint> {
	return {
		result: result.text,
		...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
		...(result.sessionFile !== undefined ? { sessionFile: result.sessionFile } : {}),
		...(result.model !== undefined ? { model: result.model } : {}),
		...(result.thinkingLevel !== undefined ? { thinkingLevel: result.thinkingLevel } : {}),
		...(result.attemptedModels !== undefined ? { attemptedModels: [...result.attemptedModels] } : {}),
		...(result.modelAttempts !== undefined ? { modelAttempts: [...result.modelAttempts] } : {}),
		...(result.rateLimits !== undefined ? { rateLimits: [...result.rateLimits] } : {}),
		...(result.routerSelection !== undefined ? { routerSelection: result.routerSelection } : {}),
		...(result.structured !== undefined ? { structured: result.structured } : {}),
		...(result.artifacts !== undefined ? { artifacts: [...result.artifacts] } : {}),
		...(result.warnings !== undefined ? { warnings: [...result.warnings] } : {}),
	};
}

export function stageCheckpointWithOutput(
	backend: DurableWorkflowBackend,
	workflowId: string,
	replayKey: string,
	matchesOutput?: (value: WorkflowSerializableValue) => boolean,
): DurableCompletedStageCheckpoint | undefined {
	const checkpoints = backend
		.listCheckpoints(workflowId)
		.filter(
			(checkpoint): checkpoint is DurableStageCheckpoint =>
				checkpoint.kind === "stage" && checkpoint.replayKey === replayKey,
		);
	const outputCheckpoints = checkpoints.filter(
		(checkpoint): checkpoint is DurableCompletedStageCheckpoint => checkpoint.output !== undefined,
	);
	const replayValueCheckpoint =
		matchesOutput === undefined
			? outputCheckpoints[0]
			: outputCheckpoints.find((checkpoint) => matchesOutput(checkpoint.output));
	if (replayValueCheckpoint === undefined) return undefined;
	return mergeCheckpointHydrationMetadata(replayValueCheckpoint, checkpoints);
}

function mergeCheckpointHydrationMetadata(
	replayValueCheckpoint: DurableCompletedStageCheckpoint,
	checkpoints: readonly DurableStageCheckpoint[],
): DurableCompletedStageCheckpoint {
	if (checkpoints.length === 0 || replayValueCheckpoint.topology?.boundary?.event === "terminal") {
		return replayValueCheckpoint;
	}
	const merged: DurableCompletedStageCheckpoint = {
		...replayValueCheckpoint,
		...preferredHydrationTopology(replayValueCheckpoint, checkpoints),
		...(replayValueCheckpoint.startedAt === undefined ? metadataValue(checkpoints, "startedAt") : {}),
		...(replayValueCheckpoint.endedAt === undefined ? metadataValue(checkpoints, "endedAt") : {}),
		...(replayValueCheckpoint.durationMs === undefined ? metadataValue(checkpoints, "durationMs") : {}),
		...(replayValueCheckpoint.result === undefined ? metadataValue(checkpoints, "result") : {}),
		...(replayValueCheckpoint.sessionId === undefined ? metadataValue(checkpoints, "sessionId") : {}),
		...(replayValueCheckpoint.sessionFile === undefined ? metadataValue(checkpoints, "sessionFile") : {}),
		...(replayValueCheckpoint.model === undefined ? metadataValue(checkpoints, "model") : {}),
		...(replayValueCheckpoint.thinkingLevel === undefined ? metadataValue(checkpoints, "thinkingLevel") : {}),
		...(replayValueCheckpoint.attemptedModels === undefined ? metadataValue(checkpoints, "attemptedModels") : {}),
		...(replayValueCheckpoint.modelAttempts === undefined ? metadataValue(checkpoints, "modelAttempts") : {}),
		...(replayValueCheckpoint.rateLimits === undefined ? metadataValue(checkpoints, "rateLimits") : {}),
		...(replayValueCheckpoint.routerSelection === undefined ? metadataValue(checkpoints, "routerSelection") : {}),
		...(replayValueCheckpoint.structured === undefined ? metadataValue(checkpoints, "structured") : {}),
		...(replayValueCheckpoint.artifacts === undefined ? metadataValue(checkpoints, "artifacts") : {}),
		...(replayValueCheckpoint.warnings === undefined ? metadataValue(checkpoints, "warnings") : {}),
	};
	// Any record of the stage that says its session is in its own store says so for the stage.
	return merged.sessionStorage === undefined && checkpoints.some((checkpoint) => checkpoint.sessionStorage === "stage")
		? { ...merged, sessionStorage: "stage" }
		: merged;
}

function preferredHydrationTopology(
	replayValueCheckpoint: DurableCompletedStageCheckpoint,
	checkpoints: readonly DurableStageCheckpoint[],
): Pick<DurableStageCheckpoint, "topology"> | Record<string, never> {
	for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
		const topology = checkpoints[index]?.topology;
		if (topology?.boundary !== undefined) return { topology };
	}
	for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
		const topology = checkpoints[index]?.topology;
		if (topology?.run !== undefined) return { topology };
	}
	return replayValueCheckpoint.topology === undefined ? metadataValue(checkpoints, "topology") : {};
}

function metadataValue<K extends keyof DurableStageCheckpoint>(
	checkpoints: readonly DurableStageCheckpoint[],
	key: K,
): Pick<DurableStageCheckpoint, K> | Record<string, never> {
	for (let index = checkpoints.length - 1; index >= 0; index -= 1) {
		const value = checkpoints[index]?.[key];
		if (value !== undefined) return { [key]: value } as Pick<DurableStageCheckpoint, K>;
	}
	return {};
}

export function createStageReplayKeyGenerator(_workflowId: string): (stageName: string, stageId?: string) => string {
	const counts = new Map<string, number>();
	return (stageName: string, _stageId?: string): string => {
		const next = (counts.get(stageName) ?? 0) + 1;
		counts.set(stageName, next);
		return `stage:${stageName}:${next}`;
	};
}

export function stableCheckpointId(kind: string, replayKey: string): string {
	return `${kind}:${replayKey}`;
}

/**
 * The record of a task restarted from its prompt after a result of it was recorded, such as an event child whose event
 * is handled again after a resume. A journal keeps the first record written under an id, so the restarted task's record
 * gets its own id. It keeps the replay key, so the run's stage outputs and its completed snapshot take the later record
 * for that stage in place of the earlier one.
 */
function supersedingTaskCheckpointId(replayKey: string, completedAt: number): string {
	return `${stableCheckpointId("task", replayKey)}:${durableHash({ completedAt })}`;
}

/**
 * `forcedAt` makes a forced record differ from an equal one written at another time, such as a stage's ended wait. The
 * wait and the results a waiting stage was woken with are part of the record's identity, so a change to either in the
 * same millisecond is a new record; the same record written again in that millisecond is one record (#4309).
 */
function stageSessionCheckpointId(
	replayKey: string,
	stage: StageSnapshot,
	durationMs: number,
	forcedAt: number | undefined,
): string {
	return `${stableCheckpointId("stage-session", replayKey)}:${durableHash({
		sessionId: stage.sessionId ?? "",
		startedAt: stage.startedAt ?? 0,
		durationMs,
		...(stage.wait === undefined ? {} : { wait: stage.wait }),
		...(stage.waitResults === undefined ? {} : { waitResults: stage.waitResults }),
		...(forcedAt === undefined ? {} : { forcedAt }),
	})}`;
}

export function cachedStageId(runId: string, replayKey: string): string {
	return `durable-${durableHash({ runId, replayKey })}`;
}
function stageMetadataCheckpointId(replayKey: string, stage: StageSnapshot): string {
	return `${stableCheckpointId("stage-meta", replayKey)}:${durableHash({
		stageId: stage.id,
		status: stage.status,
		endedAt: stage.endedAt ?? 0,
		durationMs: stage.durationMs ?? 0,
		result: stage.result ?? "",
	})}`;
}

export function recordCachedStageIntoStore(
	store: import("../shared/store.js").Store,
	runId: string,
	name: string,
	replayKey: string,
	output: WorkflowSerializableValue,
	completedStageReplayKeys: Map<string, string>,
	parentIds?: readonly string[],
	checkpoint?: DurableCompletedStageCheckpoint,
): void {
	const sourceStageId = checkpoint?.topology?.run?.runId === runId ? checkpoint.topology.stageId : undefined;
	const stageId = sourceStageId ?? cachedStageId(runId, replayKey);
	const result = checkpoint?.result ?? (typeof output === "string" ? output : JSON.stringify(output));
	const childResult = parseWorkflowChildResult(output);
	const workflowChild = childResult === undefined ? undefined : workflowChildSnapshotFromResult(childResult);
	const executionOrder = checkpoint?.topology?.order ?? checkpoint?.topology?.sourceOrder;
	const snapshot: StageSnapshot = {
		id: stageId,
		name,
		status: "completed",
		parentIds: parentIds !== undefined ? Object.freeze([...parentIds]) : [],
		...stageTimingFields(checkpoint),
		result,
		replayKey,
		replayed: true,
		skippedReason: "durable checkpoint replay",
		toolEvents: [],
		attachable: false,
		...(executionOrder !== undefined ? { executionOrder } : {}),
		...(checkpoint?.topology !== undefined ? { replayedFromStageId: checkpoint.topology.stageId } : {}),
		...(workflowChild !== undefined ? { workflowChild } : {}),
		...(checkpoint?.sessionId !== undefined ? { sessionId: checkpoint.sessionId } : {}),
		...(checkpoint?.sessionFile !== undefined ? { sessionFile: checkpoint.sessionFile } : {}),
		...(checkpoint?.model !== undefined ? { model: checkpoint.model } : {}),
		...(checkpoint?.thinkingLevel !== undefined ? { thinkingLevel: checkpoint.thinkingLevel } : {}),
		...(checkpoint?.attemptedModels !== undefined ? { attemptedModels: checkpoint.attemptedModels } : {}),
		...(checkpoint?.modelAttempts !== undefined ? { modelAttempts: checkpoint.modelAttempts } : {}),
		...(checkpoint?.rateLimits !== undefined ? { rateLimits: checkpoint.rateLimits } : {}),
		...(checkpoint?.routerSelection !== undefined ? { routerSelection: checkpoint.routerSelection } : {}),
		...(checkpoint?.structured !== undefined ? { structured: checkpoint.structured } : {}),
		...(checkpoint?.artifacts !== undefined ? { artifacts: checkpoint.artifacts } : {}),
		...(checkpoint?.warnings !== undefined ? { warnings: checkpoint.warnings } : {}),
		...(checkpoint?.worktreeSnapshots?.length
			? { snapshot: stageWorktreeSnapshot(checkpoint.worktreeSnapshots.at(-1)!) }
			: {}),
	};
	store.recordStageStart(runId, snapshot);
	store.recordStageEnd(runId, snapshot);
	completedStageReplayKeys.set(stageId, replayKey);
}

/**
 * Record a cached durable stage into the store AND register it in the graph
 * frontier tracker so parent/frontier lineage is preserved for subsequent stages.
 * cross-ref: issue #1498 — replayed durable stages preserve graph lineage.
 */
export function recordCachedStageWithTracker(
	store: import("../shared/store.js").Store,
	tracker: import("../engine/graph-inference.js").GraphFrontierTracker,
	runId: string,
	name: string,
	replayKey: string,
	checkpoint: DurableCompletedStageCheckpoint,
	completedStageReplayKeys: Map<string, string>,
	stageFailFastScope?: ParallelFailFastScope,
	sourceToReplayedNodeIds?: Map<string, string>,
): void {
	const sourceStageId = checkpoint.topology?.run?.runId === runId ? checkpoint.topology.stageId : undefined;
	const stageId = sourceStageId ?? cachedStageId(runId, replayKey);
	let parentIds = tracker.onSpawn(stageId, name);
	if (stageFailFastScope?.detached === true) tracker.detach(stageId);
	const sourceParents = sourceStageId === undefined ? undefined : checkpoint.topology?.parentIds;
	const run = store.run(runId);
	const restored = sourceParents?.map(
		(sourceId) =>
			sourceToReplayedNodeIds?.get(sourceId) ??
			run?.stages.find((stage) => stage.id === sourceId || stage.replayedFromStageId === sourceId)?.id,
	);
	if (restored?.every((id): id is string => id !== undefined)) {
		parentIds = restored;
		tracker.replaceParents(stageId, parentIds);
	} else if (stageFailFastScope !== undefined) {
		parentIds = [...(stageFailFastScope.parentIds ?? [])];
		tracker.replaceParents(stageId, parentIds);
	}
	if (checkpoint.topology?.run?.runId === runId) sourceToReplayedNodeIds?.set(checkpoint.topology.stageId, stageId);
	recordCachedStageIntoStore(
		store,
		runId,
		name,
		replayKey,
		checkpoint.output,
		completedStageReplayKeys,
		parentIds,
		checkpoint,
	);
	tracker.onSettle(stageId);
}
function isWorkflowTaskResult(value: WorkflowSerializableValue): value is WorkflowTaskResult {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return typeof (value as Record<string, WorkflowSerializableValue>).text === "string";
}

function workflowChildSnapshotFromResult(
	result: WorkflowChildResult<WorkflowOutputValues>,
): StageSnapshot["workflowChild"] {
	return {
		alias: result.workflow,
		workflow: result.workflow,
		runId: result.runId,
		status: result.status,
		...(result.exited !== undefined ? { exited: result.exited } : {}),
		outputs: result.outputs,
		...(typeof result.exitReason === "string" ? { exitReason: result.exitReason } : {}),
		...(result.changeSet !== undefined ? { changeSet: result.changeSet } : {}),
	};
}
