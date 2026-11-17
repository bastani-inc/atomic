import type { Store } from "../shared/store.js";
import { readGraphStoreSnapshot, subscribeStoreInvalidation } from "../shared/store-observation.js";
import type { StoreSnapshot } from "../shared/store-types.js";

export interface LiveWidgetAPI {
	on?: (event: string, handler: (payload: unknown, context?: unknown) => void) => void;
	events?: {
		on?: (event: string, handler: (payload: unknown) => void) => void;
	};
}

interface ToolExecutionStartPayload {
	toolName?: string;
	tool_name?: string;
	name?: string;
	runId?: string;
	run_id?: string;
	stageId?: string;
	stage_id?: string;
	toolCallId?: string;
	tool_call_id?: string;
	toolUseId?: string;
	tool_use_id?: string;
	id?: string;
	input?: Record<string, unknown>;
	args?: Record<string, unknown>;
	ts?: number;
}

interface ToolExecutionEndPayload extends ToolExecutionStartPayload {
	output?: string;
	endedAt?: number;
	ended_at?: number;
	error?: string;
}

export function installToolExecutionHooks(pi: LiveWidgetAPI, storeInstance: Store): void {
	const eventBusOn = pi.events?.on;
	const extensionOn = pi.on;
	if (typeof eventBusOn !== "function" && typeof extensionOn !== "function") return;

	interface StageScope {
		readonly runId: string;
		readonly stageId: string;
	}

	interface ActiveToolCall extends StageScope {
		readonly callId: string;
		readonly name: string;
		readonly startedAt: number;
	}

	const terminalRunStatuses = new Set(["completed", "failed", "killed", "skipped", "cancelled", "blocked"]);
	const terminalStageStatuses = new Set(["completed", "failed", "skipped"]);
	const activeToolCalls = new Map<string, ActiveToolCall>();

	function activeCallKey(runId: string, stageId: string, callId: string): string {
		return `${runId}\0${stageId}\0${callId}`;
	}

	function firstNonEmptyString(...values: readonly unknown[]): string | null {
		for (const value of values) {
			if (typeof value === "string" && value.length > 0) return value;
		}
		return null;
	}

	function resolveExplicitStageScope(payload: ToolExecutionStartPayload): StageScope | null {
		const runId = firstNonEmptyString(payload.runId, payload.run_id);
		const stageId = firstNonEmptyString(payload.stageId, payload.stage_id);
		if (runId === null || stageId === null) return null;
		return { runId, stageId };
	}

	function hasLiveStageScope(scope: StageScope, snap: StoreSnapshot): boolean {
		const run = snap.runs.find((candidate) => candidate.id === scope.runId);
		if (!run || run.endedAt !== undefined || terminalRunStatuses.has(run.status)) return false;
		const stage = run.stages.find((candidate) => candidate.id === scope.stageId);
		return stage !== undefined && !terminalStageStatuses.has(stage.status);
	}

	function pruneActiveToolCalls(snap: StoreSnapshot): void {
		for (const [key, call] of activeToolCalls) {
			if (!hasLiveStageScope(call, snap)) activeToolCalls.delete(key);
		}
	}

	function activeToolCallForPayload(payload: ToolExecutionStartPayload): { key: string; call: ActiveToolCall } | null {
		const scope = resolveExplicitStageScope(payload);
		if (!scope) return null;

		const key = activeCallKey(scope.runId, scope.stageId, toolCallId(payload));
		const call = activeToolCalls.get(key);
		return call ? { key, call } : null;
	}

	// Pruning an empty set needs no snapshot; reading one per store change cost a projection (#4009).
	subscribeStoreInvalidation(storeInstance, () => {
		if (activeToolCalls.size > 0) pruneActiveToolCalls(readGraphStoreSnapshot(storeInstance));
	});

	function recordToolStart(payload: unknown): void {
		if (!isToolExecutionPayload(payload)) return;

		const snap = readGraphStoreSnapshot(storeInstance);
		pruneActiveToolCalls(snap);

		const scope = resolveExplicitStageScope(payload);
		if (!scope || !hasLiveStageScope(scope, snap)) return;

		const callId = toolCallId(payload);
		const key = activeCallKey(scope.runId, scope.stageId, callId);
		if (activeToolCalls.has(key)) return;

		const name = toolName(payload);
		const startedAt = payload.ts ?? Date.now();
		activeToolCalls.set(key, { ...scope, callId, name, startedAt });
		storeInstance.recordToolStart(scope.runId, scope.stageId, {
			name,
			input: toolInput(payload),
			startedAt,
		});
	}

	function recordToolUpdate(payload: unknown): void {
		if (!isToolExecutionPayload(payload)) return;

		pruneActiveToolCalls(readGraphStoreSnapshot(storeInstance));

		if (!activeToolCallForPayload(payload)) return;
		// Updates are attach-only until the store has an explicit update API.
	}

	function recordToolEnd(payload: unknown): void {
		if (!isToolExecutionPayload(payload)) return;

		pruneActiveToolCalls(readGraphStoreSnapshot(storeInstance));

		const active = activeToolCallForPayload(payload);
		if (!active) return;

		storeInstance.recordToolEnd(active.call.runId, active.call.stageId, {
			name: active.call.name,
			input: toolInput(payload),
			startedAt: active.call.startedAt,
			endedAt: payload.endedAt ?? payload.ended_at ?? Date.now(),
			output: payload.output,
		});
		activeToolCalls.delete(active.key);
	}

	const safeStart = safelyHandle(recordToolStart);
	const safeUpdate = safelyHandle(recordToolUpdate);
	const safeEnd = safelyHandle(recordToolEnd);

	if (typeof eventBusOn === "function") {
		eventBusOn.call(pi.events, "tool_execution_start", safeStart);
		eventBusOn.call(pi.events, "tool_execution_update", safeUpdate);
		eventBusOn.call(pi.events, "tool_execution_end", safeEnd);
	}
	if (typeof extensionOn === "function") {
		extensionOn.call(pi, "tool_execution_start", safeStart);
		extensionOn.call(pi, "tool_execution_update", safeUpdate);
		extensionOn.call(pi, "tool_execution_end", safeEnd);
		extensionOn.call(pi, "tool_call", safeStart);
		extensionOn.call(pi, "tool_result", safeEnd);
	}
}

function isToolExecutionPayload(payload: unknown): payload is ToolExecutionEndPayload {
	return typeof payload === "object" && payload !== null;
}

function safelyHandle(handler: (payload: unknown) => void): (payload: unknown) => void {
	return (payload: unknown): void => {
		try {
			handler(payload);
		} catch {
			// Event hooks must not crash pi runtime when optional event payloads vary.
		}
	};
}

function toolName(payload: ToolExecutionStartPayload): string {
	return payload.toolName ?? payload.tool_name ?? payload.name ?? "unknown";
}

function toolCallId(payload: ToolExecutionStartPayload): string {
	return (
		payload.toolCallId ??
		payload.tool_call_id ??
		payload.toolUseId ??
		payload.tool_use_id ??
		payload.id ??
		"__ask_user_question__"
	);
}

function toolInput(payload: ToolExecutionStartPayload): Record<string, unknown> | undefined {
	return payload.input ?? payload.args;
}
