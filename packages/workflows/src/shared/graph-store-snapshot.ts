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
		// Fall through to the bounded legacy fields below.
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
		pendingStageDeliveryAvailable: _pendingStageDeliveryAvailable,
		attemptedModels: _attemptedModels,
		modelAttempts: _modelAttempts,
		// Agent-stage results can be unbounded and graph cards do not render
		// them. Tool cards render a constant body, so `resultSummary` is kept
		// for status surfaces while the bounded full payload below backs the
		// read-only detail view.
		result: _result,
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

function compactRun(run: RunSnapshot): RunSnapshot {
	const { inputs: _inputs, result: sourceResult, stages, toolNodes, pendingPrompt, ...metadata } = run;
	const result = compactRunResult(sourceResult, run.exited === true && run.status === "failed");
	return {
		...metadata,
		inputs: {},
		stages: stages.map(compactStage),
		...(toolNodes !== undefined ? { toolNodes: toolNodes.map(compactToolNode) } : {}),
		...(pendingPrompt !== undefined ? { pendingPrompt: clonePrompt(pendingPrompt) } : {}),
		...(result !== undefined ? { result } : {}),
	};
}

export function createGraphStoreSnapshot(
	runs: readonly RunSnapshot[],
	notices: readonly WorkflowNotice[],
	version: number,
): StoreSnapshot {
	const snapshot: StoreSnapshot = {
		runs: runs.map(compactRun),
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
