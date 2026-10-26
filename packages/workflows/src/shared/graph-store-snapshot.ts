import { flattenTruncatedString } from "./flat-string.js";
import type {
	PendingPrompt,
	RunSnapshot,
	StageInputRequest,
	StageSnapshot,
	StoreSnapshot,
	ToolEvent,
	ToolNodeSnapshot,
	WorkflowChildReplaySnapshot,
	WorkflowNotice,
} from "./store-types.js";
import { boundedToolPayload, boundedToolPayloadRecord, boundedToolText } from "./tool-payload-bounds.js";
import type { WorkflowOutputValues, WorkflowSerializableValue } from "./types.js";

export const COMPACT_RESULT_FIELD_LIMIT = 1024;
const COMPACT_EXIT_OUTPUT_LIMIT = COMPACT_RESULT_FIELD_LIMIT * 4;

function compactResultField(value: WorkflowSerializableValue | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	if (value.length <= COMPACT_RESULT_FIELD_LIMIT) return value;
	// Flattened, not just sliced: `graphSnapshot()` memoizes this projection, so a
	// SlicedString here would keep the whole run result alive inside the store.
	return flattenTruncatedString(value.slice(0, COMPACT_RESULT_FIELD_LIMIT));
}

function compactRunResult(
	result: WorkflowOutputValues | undefined,
	preserveExitedOutputs = false,
): WorkflowOutputValues | undefined {
	if (result === undefined) return undefined;
	const status = compactResultField(result.status);
	const summary = compactResultField(result.summary);
	const remainingWork = compactResultField(result.remaining_work);
	const resultText = compactResultField(result.result);
	// The engine-owned budget stop carries its exceeded dimension in the result;
	// keep it so notices can name the exhausted budget without the full report.
	const budgetDimension =
		status === "budget_exceeded" &&
		(result.dimension === "duration" || result.dimension === "tokens" || result.dimension === "cost")
			? result.dimension
			: undefined;
	const compact: WorkflowOutputValues = {
		...(status !== undefined ? { status } : {}),
		...(summary !== undefined ? { summary } : {}),
		...(remainingWork !== undefined ? { remaining_work: remainingWork } : {}),
		...(resultText !== undefined ? { result: resultText } : {}),
		...(budgetDimension !== undefined ? { dimension: budgetDimension } : {}),
	};
	if (!preserveExitedOutputs) return Object.keys(compact).length === 0 ? undefined : compact;
	return compactExitedOutputs(result, compact);
}

function compactExitedOutputs(
	result: WorkflowOutputValues,
	compact: WorkflowOutputValues,
): WorkflowOutputValues | undefined {
	try {
		const serialized = JSON.stringify(result);
		if (serialized !== undefined && serialized.length <= COMPACT_EXIT_OUTPUT_LIMIT) {
			const parsed: unknown = JSON.parse(serialized);
			if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
				return compactExitedObject(parsed as Record<string, WorkflowSerializableValue>);
			}
		}
	} catch {
		// Keep the bounded display fields when full serialization is unavailable.
	}
	return Object.keys(compact).length === 0 ? undefined : compact;
}

function compactExitedObject(result: Record<string, WorkflowSerializableValue>): WorkflowOutputValues | undefined {
	const compacted = { ...result };
	for (const key of ["status", "summary", "remaining_work", "result"]) {
		const value = compacted[key];
		if (typeof value === "string") compacted[key] = compactResultField(value) ?? "";
	}
	return Object.keys(compacted).length === 0 ? undefined : compacted;
}

// Both cloners are called only from a `!== undefined` guard at their call sites,
// so they take and return a concrete value; an internal undefined branch here
// would be unreachable and would only weaken the type for every caller.
function clonePrompt(prompt: PendingPrompt): PendingPrompt {
	return {
		...prompt,
		...(prompt.choices !== undefined ? { choices: [...prompt.choices] } : {}),
	};
}

function cloneInputRequest(request: StageInputRequest): StageInputRequest {
	return {
		...request,
		questions: request.questions.map((question) => ({
			...question,
			options: question.options.map((option) => ({ ...option })),
		})),
	};
}

function compactToolEvents(events: readonly ToolEvent[]): ToolEvent[] {
	const event = events.at(-1);
	return event === undefined ? [] : [{ name: event.name }];
}

function compactWorkflowChild(child: WorkflowChildReplaySnapshot): WorkflowChildReplaySnapshot {
	return {
		...child,
		outputs: {},
		outputCount: child.outputCount ?? Object.keys(child.outputs).length,
	};
}

function compactStage(stage: StageSnapshot): StageSnapshot {
	const {
		toolEvents,
		workflowChild,
		workflowChildRun,
		pendingPrompt,
		promptFootprint,
		inputRequest,
		notices,
		mcpScope: _mcpScope,
		attemptedModels: _attemptedModels,
		modelAttempts: _modelAttempts,
		// Agent-stage results can be unbounded and graph cards do not render
		// them. Tool cards render a constant body, so `resultSummary` is kept
		// for status surfaces while the bounded full payload below backs the
		// read-only detail view.
		result: _result,
		// `structured` aliases the object the executor handed back to author
		// code, and this projection is deep-frozen below. Re-exporting it would
		// freeze execution-owned state that a later stage still has to mutate.
		// `store.snapshot()` and durable checkpoints keep the complete value.
		structured: _structured,
		...metadata
	} = stage;
	return {
		...metadata,
		parentIds: [...stage.parentIds],
		toolEvents: compactToolEvents(toolEvents),
		...(workflowChild !== undefined ? { workflowChild: compactWorkflowChild(workflowChild) } : {}),
		...(workflowChildRun !== undefined ? { workflowChildRun: { ...workflowChildRun } } : {}),
		...(pendingPrompt !== undefined ? { pendingPrompt: clonePrompt(pendingPrompt) } : {}),
		...(promptFootprint !== undefined ? { promptFootprint: clonePrompt(promptFootprint) } : {}),
		...(inputRequest !== undefined ? { inputRequest: cloneInputRequest(inputRequest) } : {}),
		...(notices !== undefined ? { notices: notices.map((notice) => ({ ...notice })) } : {}),
	};
}

function compactToolNode(node: ToolNodeSnapshot): ToolNodeSnapshot {
	return {
		...node,
		parentIds: [...node.parentIds],
		// Author payloads may be cyclic, may throw on property access, and may be
		// arbitrarily large. `boundedToolPayload` contains all three so building a
		// snapshot cannot throw and one version cannot retain a whole payload.
		...(node.args !== undefined ? { args: boundedToolPayloadRecord(node.args) } : {}),
		...(node.result !== undefined ? { result: boundedToolPayload(node.result) } : {}),
		...(node.source !== undefined ? { source: boundedToolText(node.source) } : {}),
	};
}

function compactRun(
	run: RunSnapshot,
	stages: StageSnapshot[] = run.stages.map(compactStage),
	toolNodes: ToolNodeSnapshot[] = run.toolNodes.map(compactToolNode),
): RunSnapshot {
	const {
		inputs: _inputs,
		result: sourceResult,
		stages: _stages,
		toolNodes: _toolNodes,
		pendingPrompt,
		...metadata
	} = run;
	const result = compactRunResult(sourceResult, run.exited === true && run.status === "failed");
	return {
		...metadata,
		inputs: {},
		stages,
		toolNodes,
		...(pendingPrompt !== undefined ? { pendingPrompt: clonePrompt(pendingPrompt) } : {}),
		...(result !== undefined ? { result } : {}),
	};
}

/** Own enumerable keys and values of a source object when its projection was built. */
interface SourceShape<T extends object> {
	readonly keys: readonly (keyof T)[];
	readonly values: readonly T[keyof T][];
}

function sourceShape<T extends object>(value: T): SourceShape<T> {
	const keys = Object.keys(value) as (keyof T)[];
	return { keys, values: keys.map((key) => value[key]) };
}

/** Whether `value` still holds exactly the same own fields, in order, by identity. */
function sameSourceShape<T extends object>(value: T, shape: SourceShape<T>): boolean {
	// `for…in` visits a plain object's own keys in `Object.keys` order without allocating them.
	let index = 0;
	for (const key in value) {
		if (index >= shape.keys.length || key !== shape.keys[index] || value[key] !== shape.values[index]) return false;
		index++;
	}
	return index === shape.keys.length;
}

interface ProjectedStage {
	readonly shape: SourceShape<StageSnapshot>;
	/** Arrays the executor and store grow in place, so their identity alone does not show a change. */
	readonly parentCount: number;
	readonly toolEventCount: number;
	readonly lastToolEvent: ToolEvent | undefined;
	readonly noticeCount: number | undefined;
	readonly compact: StageSnapshot;
}

interface ProjectedToolNode {
	readonly shape: SourceShape<ToolNodeSnapshot>;
	readonly parentCount: number;
	readonly compact: ToolNodeSnapshot;
}

interface ProjectedRun {
	readonly source: RunSnapshot;
	readonly shape: SourceShape<RunSnapshot>;
	readonly stages: ReadonlyMap<StageSnapshot, ProjectedStage>;
	readonly toolNodes: ReadonlyMap<ToolNodeSnapshot, ProjectedToolNode>;
	readonly compact: RunSnapshot;
}

function projectStage(stage: StageSnapshot): ProjectedStage {
	return {
		shape: sourceShape(stage),
		parentCount: stage.parentIds.length,
		toolEventCount: stage.toolEvents.length,
		lastToolEvent: stage.toolEvents.at(-1),
		noticeCount: stage.notices?.length,
		compact: compactStage(stage),
	};
}

function stageUnchanged(stage: StageSnapshot, projected: ProjectedStage): boolean {
	return (
		sameSourceShape(stage, projected.shape) &&
		stage.parentIds.length === projected.parentCount &&
		stage.toolEvents.length === projected.toolEventCount &&
		stage.toolEvents.at(-1) === projected.lastToolEvent &&
		stage.notices?.length === projected.noticeCount
	);
}

function projectToolNode(node: ToolNodeSnapshot): ProjectedToolNode {
	return { shape: sourceShape(node), parentCount: node.parentIds.length, compact: compactToolNode(node) };
}

function toolNodeUnchanged(node: ToolNodeSnapshot, projected: ProjectedToolNode): boolean {
	return sameSourceShape(node, projected.shape) && node.parentIds.length === projected.parentCount;
}

/**
 * Builds the frozen graph projection of a store incrementally (#4009).
 *
 * `createGraphStoreSnapshot` re-projects and re-freezes every run on each store version, so a
 * pooled fan-out with hundreds of child runs paid for all of them on every publication. This
 * builder keeps the frozen run, stage and tool-node projections of the previous build and
 * reuses each one whose source is unchanged, so a build costs the changed nodes plus one
 * identity check per field of the others. Its output is equal, field for field and in key
 * order, to `createGraphStoreSnapshot` over the same state; unchanged runs, stages and tool
 * nodes are additionally the same frozen objects as in the previous build.
 *
 * A source counts as unchanged when it is the same object holding the same own fields by
 * identity, its in-place grown arrays have the same length and tail, and no store change
 * scoped to it (`markChanged`) arrived since the previous build. A change scoped to a run
 * re-projects that run's own fields, one scoped to a stage or tool node re-projects that node,
 * and an unscoped one re-projects everything, which keeps in-place edits of nested values made
 * through store methods visible.
 */
export class GraphStoreSnapshotBuilder {
	/** By run id; an unscoped change drops them all, so a removed run's payloads do not outlive it. */
	private projected = new Map<string, ProjectedRun>();
	private readonly changedRuns = new Set<string>();
	private readonly changedStages = new Map<string, Set<string>>();
	private readonly changedToolNodes = new Map<string, Set<string>>();

	/** Records a store change; `change` scopes it to one run, or one stage or tool node of it. */
	markChanged(change?: { readonly runId: string; readonly stageId?: string; readonly toolNodeId?: string }): void {
		if (change === undefined) {
			this.projected.clear();
			this.changedRuns.clear();
			this.changedStages.clear();
			this.changedToolNodes.clear();
			return;
		}
		if (change.stageId === undefined && change.toolNodeId === undefined) {
			this.changedRuns.add(change.runId);
			return;
		}
		if (change.stageId !== undefined) addScoped(this.changedStages, change.runId, change.stageId);
		if (change.toolNodeId !== undefined) addScoped(this.changedToolNodes, change.runId, change.toolNodeId);
	}

	build(runs: readonly RunSnapshot[], notices: readonly WorkflowNotice[], version: number): StoreSnapshot {
		const previous = this.projected;
		const next = new Map<string, ProjectedRun>();
		const compactRuns: RunSnapshot[] = [];
		for (const run of runs) {
			const known = previous.get(run.id);
			const reusable = known?.source === run ? known : undefined;
			const projected =
				reusable !== undefined && !this.changedRuns.has(run.id) && this.runUnchanged(run, reusable)
					? reusable
					: this.projectRun(run, reusable);
			next.set(run.id, projected);
			compactRuns.push(projected.compact);
		}
		this.projected = next;
		this.changedRuns.clear();
		this.changedStages.clear();
		this.changedToolNodes.clear();
		const snapshot: StoreSnapshot = {
			runs: compactRuns,
			notices: notices.map((notice) => ({ ...notice })),
			version,
		};
		deepFreezeGraphValue(snapshot);
		return snapshot;
	}

	/**
	 * The frozen projection of one run, equal to its entry in the next `build`, which reuses it.
	 * Lets a reader of one run skip projecting every other run of the store (#4009).
	 */
	buildRun(run: RunSnapshot): RunSnapshot {
		const known = this.projected.get(run.id);
		const reusable = known?.source === run ? known : undefined;
		const projected =
			reusable !== undefined && !this.changedRuns.has(run.id) && this.runUnchanged(run, reusable)
				? reusable
				: this.projectRun(run, reusable);
		deepFreezeGraphValue(projected.compact);
		this.projected.set(run.id, projected);
		this.changedRuns.delete(run.id);
		this.changedStages.delete(run.id);
		this.changedToolNodes.delete(run.id);
		return projected.compact;
	}

	private runUnchanged(run: RunSnapshot, projected: ProjectedRun): boolean {
		if (!sameSourceShape(run, projected.shape)) return false;
		const { stages, toolNodes } = projected.compact;
		if (run.stages.length !== stages.length || run.toolNodes.length !== toolNodes.length) return false;
		const changedStages = this.changedStages.get(run.id);
		for (let index = 0; index < run.stages.length; index++) {
			const stage = run.stages[index]!;
			const known = projected.stages.get(stage);
			if (
				known === undefined ||
				known.compact !== stages[index] ||
				changedStages?.has(stage.id) === true ||
				!stageUnchanged(stage, known)
			)
				return false;
		}
		const changedToolNodes = this.changedToolNodes.get(run.id);
		for (let index = 0; index < run.toolNodes.length; index++) {
			const node = run.toolNodes[index]!;
			const known = projected.toolNodes.get(node);
			if (
				known === undefined ||
				known.compact !== toolNodes[index] ||
				changedToolNodes?.has(node.id) === true ||
				!toolNodeUnchanged(node, known)
			)
				return false;
		}
		return true;
	}

	private projectRun(run: RunSnapshot, previous: ProjectedRun | undefined): ProjectedRun {
		const changedStages = this.changedStages.get(run.id);
		const stages = new Map<StageSnapshot, ProjectedStage>();
		const compactStages: StageSnapshot[] = [];
		for (const stage of run.stages) {
			let projected = stages.get(stage) ?? previous?.stages.get(stage);
			if (projected === undefined || changedStages?.has(stage.id) === true || !stageUnchanged(stage, projected))
				projected = projectStage(stage);
			stages.set(stage, projected);
			compactStages.push(projected.compact);
		}
		const changedToolNodes = this.changedToolNodes.get(run.id);
		const toolNodes = new Map<ToolNodeSnapshot, ProjectedToolNode>();
		const compactToolNodes: ToolNodeSnapshot[] = [];
		for (const node of run.toolNodes) {
			let projected = toolNodes.get(node) ?? previous?.toolNodes.get(node);
			if (projected === undefined || changedToolNodes?.has(node.id) === true || !toolNodeUnchanged(node, projected))
				projected = projectToolNode(node);
			toolNodes.set(node, projected);
			compactToolNodes.push(projected.compact);
		}
		return {
			source: run,
			shape: sourceShape(run),
			stages,
			toolNodes,
			compact: compactRun(run, compactStages, compactToolNodes),
		};
	}
}

function addScoped(scopes: Map<string, Set<string>>, runId: string, nodeId: string): void {
	const ids = scopes.get(runId);
	if (ids === undefined) scopes.set(runId, new Set([nodeId]));
	else ids.add(nodeId);
}

export function createGraphStoreSnapshot(
	runs: readonly RunSnapshot[],
	notices: readonly WorkflowNotice[],
	version: number,
): StoreSnapshot {
	const snapshot: StoreSnapshot = {
		runs: runs.map((run) => compactRun(run)),
		notices: notices.map((notice) => ({ ...notice })),
		version,
	};
	deepFreezeGraphValue(snapshot);
	return snapshot;
}

function deepFreezeGraphValue(value: unknown): void {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return;
	Object.freeze(value);
	if (Array.isArray(value)) {
		for (const item of value) deepFreezeGraphValue(item);
		return;
	}
	for (const key of Object.keys(value as Record<string, unknown>)) {
		deepFreezeGraphValue((value as Record<string, unknown>)[key]);
	}
}
