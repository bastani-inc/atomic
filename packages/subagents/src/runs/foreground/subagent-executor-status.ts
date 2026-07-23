import type { ExtensionAPI } from "@bastani/atomic";
import { compactForegroundDetails, compactForegroundResult, getSingleResultOutput } from "../../shared/utils.ts";
import {
	attachNestedChildrenToResultChildren,
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.ts";
import { formatNestedRunStatusLines } from "../shared/nested-render.ts";
import { formatControlIntercomMessage, formatControlNoticeMessage, shouldNotifyControlEvent } from "../shared/subagent-control.ts";
import { deliverLocalCompletionNotification } from "../background/completion-notification.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import {
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	type ControlEvent,
	type Details,
	type NestedRunSummary,
	type SingleResult,
	type SubagentRunMode,
	type SubagentState,
	type SubagentToolResult,
} from "../../shared/types.ts";
import { resolveSubagentIntercomTarget, type IntercomBridgeState } from "../../intercom/intercom-bridge.ts";
import type { ExecutorDeps, ExecutionContextData, ForegroundControl } from "./subagent-executor-types.ts";

export function getForegroundControl(state: SubagentState, runId: string | undefined): ForegroundControl | undefined {
	if (runId) return state.foregroundControls.get(runId);
	if (state.lastForegroundControlId) {
		const latest = state.foregroundControls.get(state.lastForegroundControlId);
		if (latest) return latest;
	}
	let newest: ForegroundControl | undefined;
	for (const control of state.foregroundControls.values()) {
		if (!newest || control.updatedAt > newest.updatedAt) newest = control;
	}
	return newest;
}

function formatForegroundActivity(control: ForegroundControl): string | undefined {
	const facts: string[] = [];
	if (control.currentTool && control.currentToolStartedAt) facts.push(`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running") return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running") return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

export function foregroundStatusResult(control: ForegroundControl): SubagentToolResult {
	let nestedWarning: string | undefined;
	try {
		updateForegroundNestedProjection(control);
	} catch (error) {
		nestedWarning = `Nested status unavailable: ${error instanceof Error ? error.message : String(error)}`;
	}
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent ? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}` : undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	lines.push(...formatNestedRunStatusLines(control.nestedChildren, { indent: "", commandHints: true, maxLines: 20 }));
	if (nestedWarning) lines.push(`Warning: ${nestedWarning}`);
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

export function retainedForegroundStatusResult(state: SubagentState, runId: string): SubagentToolResult | undefined {
	const run = state.foregroundRuns?.get(runId);
	if (!run) return undefined;
	const statuses = run.children.map((child) => child.status);
	const stateLabel = statuses.includes("detached") ? "detached"
		: statuses.includes("failed") ? "failed"
		: statuses.includes("paused") ? "paused"
		: statuses.every((status) => status === "completed") ? "completed"
		: statuses[0] ?? "unknown";
	const lines = [`Run: ${run.runId}`, `State: ${stateLabel}`, `Mode: ${run.mode}`];
	for (const child of run.children) {
		lines.push(`Child ${child.index + 1}: ${child.agent} (${child.status})`);
		const output = child.result ? getSingleResultOutput(child.result) : "";
		if (output) lines.push(output);
		else if (child.result?.error) lines.push(child.result.error);
	}
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

const earlyDetachedResults = new WeakMap<SubagentState, Map<string, Map<number, SingleResult>>>();
const MAX_EARLY_DETACHED_RUNS = 50;
const MAX_EARLY_DETACHED_CHILDREN_PER_RUN = 50;


function takeEarlyDetachedResult(state: SubagentState, runId: string, index: number): SingleResult | undefined {
	const byRun = earlyDetachedResults.get(state);
	const byIndex = byRun?.get(runId);
	const result = byIndex?.get(index);
	byIndex?.delete(index);
	if (byIndex?.size === 0) byRun?.delete(runId);
	return result;
}

export function rememberForegroundRun(state: SubagentState, input: { runId: string; mode: "single" | "parallel" | "chain"; cwd: string; results: SingleResult[] }): void {
	state.foregroundRuns ??= new Map();
	state.foregroundRuns.set(input.runId, {
		runId: input.runId,
		mode: input.mode,
		cwd: input.cwd,
		updatedAt: Date.now(),
		children: input.results.map((originalResult, index) => {
			const result = takeEarlyDetachedResult(state, input.runId, index) ?? originalResult;
			return {
				agent: result.agent,
				index,
				status: resolveSubagentResultStatus({ exitCode: result.exitCode, interrupted: result.interrupted, detached: result.detached }),
				...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
				result,
			};
		}),
	});
	while (state.foregroundRuns.size > 50) {
		const oldest = [...state.foregroundRuns.values()].sort((left, right) => left.updatedAt - right.updatedAt)[0];
		if (!oldest) break;
		state.foregroundRuns.delete(oldest.runId);
	}
}

export function replaceForegroundRunChild(state: SubagentState, runId: string, index: number, result: SingleResult): void {
	const retainedResult = compactForegroundResult(result);
	const run = state.foregroundRuns?.get(runId);
	if (!run) {
		let byRun = earlyDetachedResults.get(state);
		if (!byRun) {
			byRun = new Map();
			earlyDetachedResults.set(state, byRun);
		}
		let byIndex = byRun.get(runId);
		if (!byIndex) {
			byIndex = new Map();
			byRun.set(runId, byIndex);
		}
		byIndex.set(index, retainedResult);
		while (byIndex.size > MAX_EARLY_DETACHED_CHILDREN_PER_RUN) {
			const oldestIndex = byIndex.keys().next().value;
			if (oldestIndex === undefined) break;
			byIndex.delete(oldestIndex);
		}
		while (byRun.size > MAX_EARLY_DETACHED_RUNS) {
			const oldestRun = byRun.keys().next().value;
			if (oldestRun === undefined) break;
			byRun.delete(oldestRun);
		}
		return;
	}
	const child = run.children.find((entry) => entry.index === index);
	if (!child || child.status !== "detached") return;
	child.status = resolveSubagentResultStatus({ exitCode: retainedResult.exitCode, interrupted: retainedResult.interrupted, detached: retainedResult.detached });
	child.result = retainedResult;
	if (retainedResult.sessionFile) child.sessionFile = retainedResult.sessionFile;
	run.updatedAt = Date.now();
}

export function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ExecutionContextData["controlConfig"];
	intercomBridge: IntercomBridgeState;
	event: ControlEvent;
}): void {
	if (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;
	const childIntercomTarget = input.intercomBridge.active
		? resolveSubagentIntercomTarget(input.event.runId, input.event.agent, input.event.index)
		: undefined;
	const payload = {
		event: input.event,
		source: "foreground" as const,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(input.event, childIntercomTarget),
	};
	if (input.controlConfig.notifyChannels.includes("event")) {
		input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
	}
	if (input.event.type !== "active_long_running" && input.controlConfig.notifyChannels.includes("intercom") && input.intercomBridge.active && input.intercomBridge.orchestratorTarget) {
		input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
			...payload,
			to: input.intercomBridge.orchestratorTarget,
			message: formatControlIntercomMessage(input.event, childIntercomTarget),
		});
	}
}

export function createForegroundControlNotifier(data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">, deps: Pick<ExecutorDeps, "pi">): (event: ControlEvent) => void {
	return (event) => emitControlNotification({
		pi: deps.pi,
		controlConfig: data.controlConfig,
		intercomBridge: data.intercomBridge,
		event,
	});
}

function resultSummaryForIntercom(result: SingleResult): string {
	const output = getSingleResultOutput(result);
	if (result.exitCode !== 0 && result.error) {
		return output ? `${result.error}\n\nOutput:\n${output}` : result.error;
	}
	return output || result.error || "(no output)";
}

/**
 * Deliver a completion notice to the parent session for a foreground child
 * that detached for intercom coordination and later exited. Foreground runs
 * normally return their results inline in the tool result, but a detached
 * child outlives that tool call, so without this the parent never learns the
 * child finished (see run history: detached parallel runs completed silently).
 * Reuses the async completion pipeline (dedupe, ordering barrier, triggerTurn).
 */
export function notifyDetachedForegroundChildExit(input: {
	pi: ExtensionAPI;
	runId: string;
	mode: SubagentRunMode;
	index: number;
	totalTasks?: number;
	result: SingleResult;
}): void {
	const { pi, runId, index, result } = input;
	void deliverLocalCompletionNotification(pi.events, {
		id: runId,
		runId,
		agent: result.agent,
		success: result.exitCode === 0 && !result.interrupted && !result.error,
		summary: resultSummaryForIntercom(result),
		exitCode: result.exitCode,
		...(result.interrupted ? { state: "paused" } : {}),
		timestamp: Date.now(),
		...(result.progressSummary?.durationMs !== undefined ? { durationMs: result.progressSummary.durationMs } : {}),
		...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
		...(input.totalTasks !== undefined && input.totalTasks > 1 ? { taskIndex: index, totalTasks: input.totalTasks } : {}),
		noticeLabel: "Detached subagent task",
	}, `foreground-detach-${runId}-${index}`);
}

async function emitForegroundResultIntercom(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	results: SingleResult[];
	chainSteps?: number;
	nestedChildren?: NestedRunSummary[];
}): Promise<ReturnType<typeof buildSubagentResultIntercomPayload> | null> {
	if (!input.intercomBridge.active || !input.intercomBridge.orchestratorTarget) return null;
	const children = input.results.flatMap((result, index) => result.detached ? [] : [{
		agent: result.agent,
		status: resolveSubagentResultStatus({
			exitCode: result.exitCode,
			interrupted: result.interrupted,
			detached: result.detached,
		}),
		summary: resultSummaryForIntercom(result),
		index,
		artifactPath: result.artifactPaths?.outputPath,
		sessionPath: result.sessionFile,
		intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, index),
	}]);
	if (children.length === 0) return null;
	const payload = buildSubagentResultIntercomPayload({
		to: input.intercomBridge.orchestratorTarget,
		runId: input.runId,
		mode: input.mode,
		source: "foreground",
		children: attachNestedChildrenToResultChildren(input.runId, children, input.nestedChildren),
		...(typeof input.chainSteps === "number" ? { chainSteps: input.chainSteps } : {}),
	});
	const delivered = await deliverSubagentResultIntercomEvent(input.pi.events, payload);
	if (!delivered) return null;
	return payload;
}

export async function maybeBuildForegroundIntercomReceipt(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	details: Details;
	nestedChildren?: NestedRunSummary[];
}): Promise<{ text: string; details: Details } | null> {
	const payload = await emitForegroundResultIntercom({
		pi: input.pi,
		intercomBridge: input.intercomBridge,
		runId: input.runId,
		mode: input.mode,
		results: input.details.results,
		...(typeof input.details.totalSteps === "number" ? { chainSteps: input.details.totalSteps } : {}),
		...(input.nestedChildren?.length ? { nestedChildren: input.nestedChildren } : {}),
	});
	if (!payload) return null;
	return {
		text: formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload }),
		details: stripDetailsOutputsForIntercomReceipt(input.details),
	};
}

export { compactForegroundDetails };
