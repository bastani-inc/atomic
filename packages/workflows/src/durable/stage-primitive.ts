/** Durable `ctx.stage` / `ctx.task` replay and checkpoint helpers. */

import type { ParallelFailFastScope } from "../runs/foreground/executor-types.js";
import { RESUME_CONTINUATION_PROMPT } from "../shared/resume-continuation.js";
import type { StageSnapshot } from "../shared/store-types.js";
import { elapsedStageMs } from "../shared/timing.js";
import type {
	StageContext,
	StageOptions,
	WorkflowChildResult,
	WorkflowOutputValues,
	WorkflowSerializableValue,
	WorkflowTaskOptions,
	WorkflowTaskResult,
} from "../shared/types.js";
import type { DurableWorkflowBackend } from "./backend.js";
import { durableHash } from "./backend.js";
import { activeStageTopology, durableStageCheckpointMetadata } from "./stage-topology.js";
import { recordCheckpointDurably } from "./tool-primitive.js";
import type { DurableStageCheckpoint, DurableStageRunTopology } from "./types.js";
import { parseLegacyWorkflowChildResult, parseWorkflowChildResult } from "./workflow-child-result.js";
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
	await recordCheckpointDurably(deps.backend, checkpoint);
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
	if (stage.sessionFile === undefined) return false;
	const checkpointNow = deps.now?.() ?? Date.now();
	const durationMs = elapsedStageMs(stage, checkpointNow) ?? 0;
	const current = deps.backend.getStageSession(deps.workflowId, replayKey);
	if (
		options?.force !== true &&
		current !== undefined &&
		current.sessionId === stage.sessionId &&
		current.sessionFile === stage.sessionFile &&
		current.startedAt === stage.startedAt &&
		stageSessionDurationBucket(current.durationMs) === stageSessionDurationBucket(durationMs)
	)
		return false;
	const checkpoint: DurableStageCheckpoint = {
		kind: "stage",
		workflowId: deps.workflowId,
		checkpointId: stageSessionCheckpointId(replayKey, stage, durationMs),
		name: stage.name,
		replayKey,
		...durableStageCheckpointMetadata(stage, deps.runTopology, deps.sourceOrderForStage?.(stage)),
		...(stage.sessionId !== undefined ? { sessionId: stage.sessionId } : {}),
		sessionFile: stage.sessionFile,
		...(stage.startedAt !== undefined ? { startedAt: stage.startedAt } : {}),
		durationMs,
		completedAt: checkpointNow,
	};
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
	readonly stage: (name: string, options: StageOptions | undefined, replayKey: string) => StageContext;
	readonly recordCachedStage?: (name: string, replayKey: string, checkpoint: DurableCompletedStageCheckpoint) => void;
}): (name: string, options?: StageOptions) => StageContext {
	return (name: string, options?: StageOptions): StageContext => {
		const replayKey = input.nextReplayKey(name);
		const cached = stageCheckpointWithOutput(input.backend, input.workflowId, replayKey);
		if (cached !== undefined) {
			input.recordCachedStage?.(name, replayKey, cached);
			return createCachedStageContext(name, cached.output, cached.result);
		}
		const session = input.backend.getStageSession(input.workflowId, replayKey);
		const isMidSessionResume = session?.sessionFile !== undefined;
		const topology = activeStageTopology(input.backend, input.workflowId, replayKey);
		const durableStageId =
			topology?.stageId ?? pendingStageIdForReplay(input.backend, input.workflowId, replayKey, name);
		const liveOptions: StageOptions | undefined = {
			...(options ?? {}),
			durableReplayKey: replayKey,
			...(durableStageId !== undefined ? { durableStageId } : {}),
			...(topology !== undefined ? { durableParentIds: [...topology.parentIds] } : {}),
			...(isMidSessionResume
				? {
						resumeFromSessionFile: session.sessionFile,
						durableAccumulatedDurationMs: session.durationMs ?? 0,
					}
				: {}),
		};
		const live = withMidSessionResumePrompt(input.stage(name, liveOptions, replayKey), isMidSessionResume);
		if (options?.schema === undefined) return live;
		return wrapSchemaStageForDurability({
			stage: live,
			workflowId: input.workflowId,
			backend: input.backend,
			replayKey,
			name,
		});
	};
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
	readonly recordCachedTask?: (
		name: string,
		replayKey: string,
		checkpoint: DurableCompletedStageCheckpoint,
		stageFailFastScope?: ParallelFailFastScope,
	) => void;
	readonly afterLiveResult?: (name: string) => Promise<void>;
	readonly signal?: AbortSignal;
	readonly registerTailControl?: (registration: {
		readonly nodeId: string;
		readonly name: string;
		readonly controller: AbortController;
		readonly settled: Promise<void>;
	}) => () => void;
}): (name: string, options: WorkflowTaskOptions) => Promise<WorkflowTaskResult> {
	return async (
		name: string,
		options: WorkflowTaskOptions,
		stageFailFastScope?: ParallelFailFastScope,
	): Promise<WorkflowTaskResult> => {
		const replayKey = input.nextReplayKey(`task:${name}`);
		const replayed = replayableTaskResult(name, input.backend, input.workflowId, replayKey);
		if (replayed !== undefined) {
			input.recordCachedTask?.(name, replayKey, replayed.checkpoint, stageFailFastScope);
			return replayed.result;
		}
		const session = input.backend.getStageSession(input.workflowId, replayKey);
		const topology = activeStageTopology(input.backend, input.workflowId, replayKey);
		const taskOptions: WorkflowTaskOptions = {
			...options,
			durableReplayKey: replayKey,
			...(topology !== undefined
				? {
						durableStageId: topology.stageId,
						durableParentIds: [...topology.parentIds],
					}
				: {}),
			...(session?.sessionFile !== undefined
				? {
						resumeFromSessionFile: session.sessionFile,
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
			await awaitAbortable(
				signal,
				recordCheckpointDurably(
					input.backend,
					{
						kind: "stage",
						workflowId: input.workflowId,
						checkpointId: stableCheckpointId("task", replayKey),
						name,
						replayKey,
						output: result,
						completedAt: Date.now(),
						...taskCheckpointMetadata(result),
						...(completedTopology !== undefined ? { topology: completedTopology } : {}),
					},
					signal,
				),
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
		...(base.fastMode !== undefined || checkpoint.fastMode !== undefined
			? { fastMode: base.fastMode ?? checkpoint.fastMode }
			: {}),
		...(base.attemptedModels !== undefined || checkpoint.attemptedModels !== undefined
			? { attemptedModels: [...(base.attemptedModels ?? checkpoint.attemptedModels ?? [])] }
			: {}),
		...(base.modelAttempts !== undefined || checkpoint.modelAttempts !== undefined
			? { modelAttempts: [...(base.modelAttempts ?? checkpoint.modelAttempts ?? [])] }
			: {}),
		...(base.warnings !== undefined || checkpoint.warnings !== undefined
			? { warnings: [...(base.warnings ?? checkpoint.warnings ?? [])] }
			: {}),
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

function createCachedStageContext(name: string, output: WorkflowSerializableValue, result?: string): StageContext {
	const text = result ?? (typeof output === "string" ? output : JSON.stringify(output));
	const unsupported = async (): Promise<never> => {
		throw new Error(
			`Stage "${name}" was replayed from a durable checkpoint; live session operations are unavailable.`,
		);
	};
	const cached = {
		name,
		async prompt() {
			return output as Awaited<ReturnType<StageContext["prompt"]>>;
		},
		async complete() {
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
		setThinkingLevel() {},
		cycleModel: unsupported,
		cycleThinkingLevel() {
			return undefined;
		},
		agent: undefined,
		model: undefined,
		thinkingLevel: undefined,
		messages: [],
		isStreaming: false,
		navigateTree: unsupported,
		compact: unsupported,
		abortCompaction() {},
		abort: async () => {},
	};
	return cached as never as StageContext;
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
		...(result.fastMode !== undefined ? { fastMode: result.fastMode } : {}),
		...(result.attemptedModels !== undefined ? { attemptedModels: [...result.attemptedModels] } : {}),
		...(result.modelAttempts !== undefined ? { modelAttempts: [...result.modelAttempts] } : {}),
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
	return {
		...replayValueCheckpoint,
		...preferredHydrationTopology(replayValueCheckpoint, checkpoints),
		...(replayValueCheckpoint.startedAt === undefined ? metadataValue(checkpoints, "startedAt") : {}),
		...(replayValueCheckpoint.endedAt === undefined ? metadataValue(checkpoints, "endedAt") : {}),
		...(replayValueCheckpoint.durationMs === undefined ? metadataValue(checkpoints, "durationMs") : {}),
		...(replayValueCheckpoint.result === undefined ? metadataValue(checkpoints, "result") : {}),
		...(replayValueCheckpoint.sessionId === undefined ? metadataValue(checkpoints, "sessionId") : {}),
		...(replayValueCheckpoint.sessionFile === undefined ? metadataValue(checkpoints, "sessionFile") : {}),
		...(replayValueCheckpoint.model === undefined ? metadataValue(checkpoints, "model") : {}),
		...(replayValueCheckpoint.fastMode === undefined ? metadataValue(checkpoints, "fastMode") : {}),
		...(replayValueCheckpoint.attemptedModels === undefined ? metadataValue(checkpoints, "attemptedModels") : {}),
		...(replayValueCheckpoint.modelAttempts === undefined ? metadataValue(checkpoints, "modelAttempts") : {}),
		...(replayValueCheckpoint.structured === undefined ? metadataValue(checkpoints, "structured") : {}),
		...(replayValueCheckpoint.artifacts === undefined ? metadataValue(checkpoints, "artifacts") : {}),
		...(replayValueCheckpoint.warnings === undefined ? metadataValue(checkpoints, "warnings") : {}),
	};
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

function stageSessionCheckpointId(replayKey: string, stage: StageSnapshot, durationMs: number): string {
	return `${stableCheckpointId("stage-session", replayKey)}:${durableHash({
		sessionId: stage.sessionId ?? "",
		sessionFile: stage.sessionFile ?? "",
		startedAt: stage.startedAt ?? 0,
		durationMs,
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
	const now = Date.now();
	const sourceStageId = checkpoint?.topology?.run?.runId === runId ? checkpoint.topology.stageId : undefined;
	const stageId = sourceStageId ?? cachedStageId(runId, replayKey);
	const result = checkpoint?.result ?? (typeof output === "string" ? output : JSON.stringify(output));
	const endedAt = checkpoint?.endedAt ?? checkpoint?.completedAt ?? now;
	const hasCurrentIdentity =
		checkpoint?.topology?.sourceOrder !== undefined ||
		checkpoint?.topology?.status !== undefined ||
		checkpoint?.topology?.occurrenceKey !== undefined ||
		checkpoint?.topology?.boundary !== undefined;
	const childResult =
		parseWorkflowChildResult(output) ?? (hasCurrentIdentity ? undefined : parseLegacyWorkflowChildResult(output));
	const workflowChild = childResult === undefined ? undefined : workflowChildSnapshotFromResult(childResult);
	const executionOrder = checkpoint?.topology?.order ?? checkpoint?.topology?.sourceOrder;
	const snapshot: StageSnapshot = {
		id: stageId,
		name,
		status: "completed",
		parentIds: parentIds !== undefined ? Object.freeze([...parentIds]) : [],
		startedAt: checkpoint?.startedAt ?? endedAt,
		endedAt,
		durationMs: checkpoint?.durationMs ?? 0,
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
		...(checkpoint?.fastMode !== undefined ? { fastMode: checkpoint.fastMode } : {}),
		...(checkpoint?.attemptedModels !== undefined ? { attemptedModels: checkpoint.attemptedModels } : {}),
		...(checkpoint?.modelAttempts !== undefined ? { modelAttempts: checkpoint.modelAttempts } : {}),
		...(checkpoint?.structured !== undefined ? { structured: checkpoint.structured } : {}),
		...(checkpoint?.artifacts !== undefined ? { artifacts: checkpoint.artifacts } : {}),
		...(checkpoint?.warnings !== undefined ? { warnings: checkpoint.warnings } : {}),
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
	const sourceParents = sourceStageId === undefined ? undefined : checkpoint.topology?.parentIds;
	const run = store.runs().find((candidate) => candidate.id === runId);
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
	};
}
