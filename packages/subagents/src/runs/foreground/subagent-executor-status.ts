import { type ExtensionAPI, type ExtensionContext, isStaleExtensionContextError } from "@bastani/atomic";
import { type IntercomBridgeState, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.js";
import {
	buildSubagentResultIntercomPayload,
	deliverSubagentResultIntercomEvent,
	formatSubagentResultReceipt,
	resolveSubagentResultStatus,
	stripDetailsOutputsForIntercomReceipt,
} from "../../intercom/result-intercom.js";
import {
	type ControlEvent,
	type Details,
	type SingleResult,
	SUBAGENT_CONTROL_EVENT,
	SUBAGENT_CONTROL_INTERCOM_EVENT,
	type SubagentRunMode,
	type SubagentState,
	type SubagentToolResult,
} from "../../shared/types.js";
import { compactForegroundDetails, getSingleResultOutput } from "../../shared/utils.js";
import {
	formatControlIntercomMessage,
	formatControlNoticeMessage,
	shouldNotifyControlEvent,
} from "../shared/subagent-control.js";
import { deliverLocalCompletionNotification } from "./completion-notification.js";
import type { ExecutionContextData, ExecutorDeps, ForegroundControl } from "./subagent-executor-types.js";

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
	if (control.currentTool && control.currentToolStartedAt)
		facts.push(
			`tool ${control.currentTool} for ${Math.floor(Math.max(0, Date.now() - control.currentToolStartedAt) / 1000)}s`,
		);
	else if (control.currentTool) facts.push(`tool ${control.currentTool}`);
	if (control.currentPath) facts.push(`path ${control.currentPath}`);
	if (control.turnCount !== undefined) facts.push(`${control.turnCount} turns`);
	if (control.tokens !== undefined) facts.push(`${control.tokens} tokens`);
	if (control.toolCount !== undefined) facts.push(`${control.toolCount} tools`);
	if (!control.lastActivityAt) {
		if (control.currentActivityState === "needs_attention") return ["needs attention", ...facts].join(" | ");
		if (control.currentActivityState === "active_long_running")
			return ["active but long-running", ...facts].join(" | ");
		return facts.length ? facts.join(" | ") : undefined;
	}
	const seconds = Math.floor(Math.max(0, Date.now() - control.lastActivityAt) / 1000);
	if (control.currentActivityState === "needs_attention") return [`no activity for ${seconds}s`, ...facts].join(" | ");
	if (control.currentActivityState === "active_long_running")
		return [`active but long-running; last activity ${seconds}s ago`, ...facts].join(" | ");
	return [`active ${seconds}s ago`, ...facts].join(" | ");
}

export function foregroundStatusResult(control: ForegroundControl): SubagentToolResult {
	const activity = formatForegroundActivity(control);
	const lines = [
		`Run: ${control.runId}`,
		"State: running",
		`Mode: ${control.mode}`,
		control.currentAgent
			? `Current: ${control.currentAgent}${control.currentIndex !== undefined ? ` step ${control.currentIndex + 1}` : ""}`
			: undefined,
		activity ? `Activity: ${activity}` : undefined,
	].filter((line): line is string => Boolean(line));
	return { content: [{ type: "text", text: lines.join("\n") }], details: { mode: "management", results: [] } };
}

export function emitControlNotification(input: {
	pi: ExtensionAPI;
	controlConfig: ExecutionContextData["controlConfig"];
	intercomBridge: Pick<IntercomBridgeState, "active" | "orchestratorTarget">;
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
		try {
			input.pi.events.emit(SUBAGENT_CONTROL_EVENT, payload);
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			// Control notices are best effort after a parent runtime replacement.
		}
	}
	if (
		input.event.type !== "active_long_running" &&
		input.controlConfig.notifyChannels.includes("intercom") &&
		input.intercomBridge.active &&
		input.intercomBridge.orchestratorTarget
	) {
		try {
			input.pi.events.emit(SUBAGENT_CONTROL_INTERCOM_EVENT, {
				...payload,
				to: input.intercomBridge.orchestratorTarget,
				message: formatControlIntercomMessage(input.event, childIntercomTarget),
			});
		} catch (error) {
			if (!isStaleExtensionContextError(error)) throw error;
			// Intercom control notices are best effort after a parent runtime replacement.
		}
	}
}

export function createForegroundControlNotifier(
	data: Pick<ExecutionContextData, "controlConfig" | "intercomBridge">,
	deps: Pick<ExecutorDeps, "pi">,
): (event: ControlEvent) => void {
	return (event) =>
		emitControlNotification({
			pi: deps.pi,
			controlConfig: data.controlConfig,
			intercomBridge: data.intercomBridge,
			event,
		});
}

export function workflowStageAcceptsDetachedNotification(ctx: Pick<ExtensionContext, "orchestrationContext">): boolean {
	return ctx.orchestrationContext?.messageAdmission?.isOpen() !== false;
}

function resultSummaryForIntercom(result: SingleResult): string {
	const output = getSingleResultOutput(result);
	if (result.status === "error" && result.error) {
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
 * Reuses the detached completion pipeline (dedupe, ordering barrier, triggerTurn).
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
	void deliverLocalCompletionNotification(
		pi.events,
		{
			id: runId,
			runId,
			agent: result.agent,
			status: result.status,
			summary: resultSummaryForIntercom(result),
			...(result.interrupted ? { state: "interrupted" } : {}),
			timestamp: Date.now(),
			...(result.progressSummary?.durationMs !== undefined ? { durationMs: result.progressSummary.durationMs } : {}),
			...(result.sessionFile ? { sessionFile: result.sessionFile } : {}),
			...(input.totalTasks !== undefined && input.totalTasks > 1
				? { taskIndex: index, totalTasks: input.totalTasks }
				: {}),
			noticeLabel: "Detached subagent task",
		},
		`foreground-detach-${runId}-${index}`,
	).catch((error) => {
		if (!isStaleExtensionContextError(error)) {
			console.error("Failed to emit detached subagent completion notification:", error);
		}
	});
}

async function emitForegroundResultIntercom(input: {
	pi: ExtensionAPI;
	intercomBridge: IntercomBridgeState;
	runId: string;
	mode: SubagentRunMode;
	results: SingleResult[];
}): Promise<ReturnType<typeof buildSubagentResultIntercomPayload> | null> {
	if (!input.intercomBridge.active || !input.intercomBridge.orchestratorTarget) return null;
	const children = input.results.flatMap((result, index) =>
		result.detached
			? []
			: [
					{
						agent: result.agent,
						status: resolveSubagentResultStatus({
							status: result.status,
							interrupted: result.interrupted,
							detached: result.detached,
						}),
						summary: resultSummaryForIntercom(result),
						index,
						...(result.cause ? { cause: result.cause } : {}),
						artifactPath: result.artifactPaths?.outputPath,
						sessionPath: result.sessionFile,
						intercomTarget: resolveSubagentIntercomTarget(input.runId, result.agent, index),
					},
				],
	);
	if (children.length === 0) return null;
	const payload = buildSubagentResultIntercomPayload({
		to: input.intercomBridge.orchestratorTarget,
		runId: input.runId,
		mode: input.mode,
		children,
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
}): Promise<{ text: string; details: Details } | null> {
	const payload = await emitForegroundResultIntercom({
		pi: input.pi,
		intercomBridge: input.intercomBridge,
		runId: input.runId,
		mode: input.mode,
		results: input.details.results,
	});
	if (!payload) return null;
	return {
		text: formatSubagentResultReceipt({ mode: input.mode, runId: input.runId, payload }),
		details: stripDetailsOutputsForIntercomReceipt(input.details),
	};
}

export { compactForegroundDetails };
