import * as fs from "node:fs";
import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import { extractTextFromContent, extractToolArgsPreview } from "../../shared/utils.ts";
import { DEFAULT_CONTROL_CONFIG, buildControlEvent, claimControlNotification, deriveActivityState, formatControlIntercomMessage, formatControlNoticeMessage } from "../shared/subagent-control.ts";
import { flattenSteps, isDynamicRunnerGroup, isParallelGroup } from "../shared/parallel-utils.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	nextLongRunningTrigger,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import type { TokenUsage } from "../../shared/types.ts";
import type { ChildEvent, RunnerExecutionState, RunnerStatusPayload, RunnerStatusStep, SubagentRunConfig } from "./subagent-runner-types.ts";
import { appendRecentStepOutput, resetStepLiveDetail } from "./subagent-runner-utils.ts";

const mutatingFailureWindowMs = 5 * 60_000;

function initialStepStatus(step: { agent: string; phase?: string; label?: string; outputName?: string; structured?: boolean; sessionFile?: string; skills?: string[] | false; model?: string; thinking?: string; fastMode?: boolean; modelCandidates?: string[] }): RunnerStatusStep {
	return {
		agent: step.agent,
		phase: step.phase,
		label: step.label,
		outputName: step.outputName,
		structured: step.structured,
		status: "pending",
		...(step.sessionFile ? { sessionFile: step.sessionFile } : {}),
		skills: step.skills as RunnerStatusStep["skills"],
		model: step.model,
		thinking: step.thinking,
		...(step.fastMode ? { fastMode: true } : {}),
		attemptedModels: step.modelCandidates && step.modelCandidates.length > 0 ? step.modelCandidates : step.model ? [step.model] : undefined,
		recentTools: [],
		recentOutput: [],
	};
}

export function createRunnerExecutionState(config: SubagentRunConfig): RunnerExecutionState {
	const { id, steps, resultPath, cwd, placeholder, taskIndex, totalTasks, maxOutput, artifactsDir, artifactConfig } = config;
	const overallStartTime = Date.now();
	const shareEnabled = config.share === true;
	const asyncDir = config.asyncDir;
	const statusPath = path.join(asyncDir, "status.json");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	const logPath = path.join(asyncDir, `subagent-log-${id}.md`);
	const controlConfig = config.controlConfig ?? DEFAULT_CONTROL_CONFIG;
	const parallelGroups: Array<{ start: number; count: number; stepIndex: number }> = [];
	const initialStatusSteps: RunnerStatusStep[] = [];
	let flatStepCount = 0;
	for (let stepIndex = 0; stepIndex < steps.length; stepIndex++) {
		const step = steps[stepIndex]!;
		if (isParallelGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: step.parallel.length, stepIndex });
			for (const task of step.parallel) initialStatusSteps.push(initialStepStatus(task));
			flatStepCount += step.parallel.length;
		} else if (isDynamicRunnerGroup(step)) {
			parallelGroups.push({ start: flatStepCount, count: 1, stepIndex });
			initialStatusSteps.push({
				agent: `expand:${step.parallel.agent}`,
				phase: step.phase ?? step.parallel.phase,
				label: step.label ?? step.parallel.label ?? `Dynamic fanout (${step.collect.as})`,
				outputName: step.collect.as,
				structured: Boolean(step.collect.outputSchema),
				status: "pending",
				recentTools: [],
				recentOutput: [],
			});
			flatStepCount++;
		} else {
			initialStatusSteps.push(initialStepStatus(step));
			flatStepCount++;
		}
	}
	const flatSteps = flattenSteps(steps);
	const sessionEnabled = Boolean(config.sessionDir)
		|| shareEnabled
		|| flatSteps.some((step) => Boolean(step.sessionFile));
	const statusPayload: RunnerStatusPayload = {
		runId: id,
		...(config.sessionId ? { sessionId: config.sessionId } : {}),
		mode: config.resultMode ?? (flatSteps.length > 1 ? "chain" : "single"),
		state: "running",
		lastActivityAt: overallStartTime,
		startedAt: overallStartTime,
		lastUpdate: overallStartTime,
		pid: process.pid,
		cwd,
		currentStep: 0,
		chainStepCount: steps.length,
		parallelGroups,
		workflowGraph: config.workflowGraph,
		steps: initialStatusSteps,
		artifactsDir,
		sessionDir: config.sessionDir,
		outputFile: path.join(asyncDir, "output-0.log"),
	};
	fs.mkdirSync(asyncDir, { recursive: true });
	const state: RunnerExecutionState = {
		config,
		id,
		steps,
		resultPath,
		cwd,
		placeholder,
		taskIndex,
		totalTasks,
		maxOutput,
		artifactsDir,
		artifactConfig,
		previousOutput: "",
		outputs: {},
		results: [],
		overallStartTime,
		shareEnabled,
		asyncDir,
		statusPath,
		eventsPath,
		logPath,
		controlConfig,
		interrupted: false,
		previousCumulativeTokens: { input: 0, output: 0, total: 0 } satisfies TokenUsage,
		flatSteps,
		sessionEnabled,
		statusPayload,
		flatIndex: 0,
		mutatingFailureStates: initialStatusSteps.map(() => createMutatingFailureState()),
		pendingToolResults: initialStatusSteps.map(() => undefined),
		emittedControlEventKeys: new Set(),
		activeLongRunningSteps: new Set(),
	};
	writeStatusPayload(state);
	return state;
}

function emitNestedSelfEvent(state: RunnerExecutionState, type: "subagent.nested.updated" | "subagent.nested.completed"): void {
	const { config, statusPayload, asyncDir, id } = state;
	if (!config.nestedRoute || !config.nestedSelf) return;
	try {
		writeNestedEvent(config.nestedRoute, {
			type,
			ts: Date.now(),
			parentRunId: config.nestedSelf.parentRunId,
			parentStepIndex: config.nestedSelf.parentStepIndex,
			child: nestedSummaryFromAsyncStatus(statusPayload, asyncDir, {
				id,
				parentRunId: config.nestedSelf.parentRunId,
				parentStepIndex: config.nestedSelf.parentStepIndex,
				depth: config.nestedSelf.depth,
				path: config.nestedSelf.path,
				mode: statusPayload.mode,
				ts: Date.now(),
			}),
		});
	} catch (error) {
		console.error("Failed to emit nested async status event:", error);
	}
}

function refreshWorkflowGraph(state: RunnerExecutionState): void {
	const { config, statusPayload } = state;
	if (!config.workflowGraph) return;
	const graph = structuredClone(statusPayload.workflowGraph ?? config.workflowGraph);
	const normalize = (status: RunnerStatusStep["status"]): "pending" | "running" | "completed" | "failed" | "paused" | "detached" => {
		if (status === "complete" || status === "completed") return "completed";
		if (status === "running" || status === "failed" || status === "paused" || status === "pending") return status;
		return "pending";
	};
	const updateNode = (node: NonNullable<typeof graph.nodes>[number]): void => {
		if (node.flatIndex !== undefined) {
			const step = statusPayload.steps[node.flatIndex];
			if (step) {
				node.status = normalize(step.status);
				node.error = step.error;
			}
			if (statusPayload.currentStep === node.flatIndex) graph.currentNodeId = node.id;
		}
		for (const child of node.children ?? []) updateNode(child);
		if (node.children?.length) {
			if (node.children.every((child) => child.status === "completed")) node.status = "completed";
			else if (node.children.some((child) => child.status === "running")) node.status = "running";
			else if (node.children.some((child) => child.status === "failed")) node.status = "failed";
			else if (node.children.some((child) => child.status === "paused")) node.status = "paused";
		}
		if (node.error) node.status = "failed";
	};
	for (const node of graph.nodes) updateNode(node);
	statusPayload.workflowGraph = graph;
}

export function writeStatusPayload(state: RunnerExecutionState): void {
	refreshWorkflowGraph(state);
	writeAtomicJson(state.statusPath, state.statusPayload);
	emitNestedSelfEvent(state, state.statusPayload.state === "running" || state.statusPayload.state === "queued" ? "subagent.nested.updated" : "subagent.nested.completed");
}

export function markDynamicGraphGroup(state: RunnerExecutionState, stepIndex: number, status: "completed" | "failed" | "running", error?: string): void {
	const groupNode = state.statusPayload.workflowGraph?.nodes.find((node) => node.id === `step-${stepIndex}`);
	if (!groupNode) return;
	groupNode.status = status;
	groupNode.error = error;
}

function stepOutputActivityAt(state: RunnerExecutionState, index: number): number {
	const step = state.statusPayload.steps[index];
	let lastActivityAt = step?.lastActivityAt ?? step?.startedAt ?? state.overallStartTime;
	const outputPath = path.join(state.asyncDir, `output-${index}.log`);
	try {
		lastActivityAt = Math.max(lastActivityAt, fs.statSync(outputPath).mtimeMs);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error(`Failed to inspect async output file '${outputPath}':`, error);
	}
	return lastActivityAt;
}

function appendControlEvent(state: RunnerExecutionState, event: ReturnType<typeof buildControlEvent>) {
	const { controlConfig, config, statusPayload, eventsPath } = state;
	if (!controlConfig.enabled) return;
	const childIntercomTarget = config.childIntercomTargets?.[event.index ?? statusPayload.currentStep];
	const channels = event.type === "active_long_running"
		? controlConfig.notifyChannels.filter((channel) => channel !== "intercom")
		: controlConfig.notifyChannels;
	if (channels.length === 0 || !claimControlNotification(controlConfig, event, state.emittedControlEventKeys, childIntercomTarget)) return;
	appendJsonl(eventsPath, JSON.stringify({
		type: "subagent.control",
		event,
		channels,
		childIntercomTarget,
		noticeText: formatControlNoticeMessage(event, childIntercomTarget),
		...(config.controlIntercomTarget && channels.includes("intercom") ? {
			intercom: { to: config.controlIntercomTarget, message: formatControlIntercomMessage(event, childIntercomTarget) },
		} : {}),
	}));
}

function syncTopLevelCurrentTool(statusPayload: RunnerStatusPayload): void {
	const activeStep = statusPayload.steps
		.filter((step) => step.status === "running" && typeof step.currentTool === "string" && step.currentTool.length > 0)
		.sort((left, right) => (right.currentToolStartedAt ?? 0) - (left.currentToolStartedAt ?? 0))[0];
	statusPayload.currentTool = activeStep?.currentTool;
	statusPayload.currentToolStartedAt = activeStep?.currentToolStartedAt;
	statusPayload.currentPath = activeStep?.currentPath;
}

function maybeEmitActiveLongRunning(state: RunnerExecutionState, flatIndex: number, now: number): boolean {
	const { controlConfig, statusPayload, id } = state;
	if (!controlConfig.enabled || state.activeLongRunningSteps.has(flatIndex)) return false;
	const step = statusPayload.steps[flatIndex];
	if (!step || step.status !== "running" || step.activityState === "needs_attention") return false;
	const reason = nextLongRunningTrigger(controlConfig, { startedAt: step.startedAt ?? state.overallStartTime, now, turns: step.turnCount ?? 0, tokens: step.tokens?.total ?? 0 });
	if (!reason) return false;
	state.activeLongRunningSteps.add(flatIndex);
	const previous = step.activityState;
	step.activityState = "active_long_running";
	statusPayload.activityState = statusPayload.activityState === "needs_attention" ? "needs_attention" : "active_long_running";
	appendControlEvent(state, buildControlEvent({
		type: "active_long_running", from: previous, to: "active_long_running", runId: id, agent: step.agent, index: flatIndex, ts: now,
		message: `${step.agent} is still active but long-running`, reason, turns: step.turnCount, tokens: step.tokens?.total, toolCount: step.toolCount,
		currentTool: step.currentTool, currentToolDurationMs: step.currentToolStartedAt ? Math.max(0, now - step.currentToolStartedAt) : undefined,
		currentPath: step.currentPath, elapsedMs: now - (step.startedAt ?? state.overallStartTime),
	}));
	return true;
}

export function updateStepModel(state: RunnerExecutionState, flatIndex: number, model: string | undefined, thinking: string | undefined, fastMode?: boolean, now = Date.now()): void {
	const step = state.statusPayload.steps[flatIndex];
	if (!step) return;
	step.model = model;
	step.thinking = thinking;
	step.fastMode = fastMode ? true : undefined;
	state.statusPayload.lastUpdate = now;
	writeStatusPayload(state);
}

export function updateStepFromChildEvent(state: RunnerExecutionState, flatIndex: number, event: ChildEvent): void {
	const step = state.statusPayload.steps[flatIndex];
	if (!step) return;
	const now = Date.now();
	state.statusPayload.currentStep = flatIndex;
	if (event.type === "tool_execution_start" && event.toolName) {
		const mutates = isMutatingTool(event.toolName, event.args);
		const currentPath = resolveCurrentPath(event.toolName, event.args);
		step.toolCount = (step.toolCount ?? 0) + 1;
		step.currentTool = event.toolName;
		step.currentToolArgs = extractToolArgsPreview(event.args ?? {});
		step.currentToolStartedAt = now;
		step.currentPath = currentPath;
		state.pendingToolResults[flatIndex] = { tool: event.toolName, path: currentPath, mutates, startedAt: now };
		state.statusPayload.toolCount = (state.statusPayload.toolCount ?? 0) + 1;
		syncTopLevelCurrentTool(state.statusPayload);
	} else if (event.type === "tool_execution_end") {
		if (step.currentTool) {
			step.recentTools ??= [];
			step.recentTools.push({ tool: step.currentTool, args: step.currentToolArgs || "", endMs: now });
		}
		step.currentTool = undefined;
		step.currentToolArgs = undefined;
		step.currentToolStartedAt = undefined;
		step.currentPath = undefined;
		syncTopLevelCurrentTool(state.statusPayload);
	} else if (event.type === "tool_result_end" && event.message) {
		const toolSnapshot = state.pendingToolResults[flatIndex];
		state.pendingToolResults[flatIndex] = undefined;
		const resultText = extractTextFromContent(event.message.content);
		appendRecentStepOutput(step, resultText.split("\n").slice(-10));
		if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
			const failureState = state.mutatingFailureStates[flatIndex]!;
			recordMutatingFailure(failureState, { tool: toolSnapshot.tool, path: toolSnapshot.path, error: resultText.split("\n").find((line) => line.trim())?.trim().slice(0, 180) ?? "mutating tool failed", ts: now }, mutatingFailureWindowMs);
			if (state.controlConfig.enabled && shouldEscalateMutatingFailures(failureState, state.controlConfig.failedToolAttemptsBeforeAttention) && step.activityState !== "needs_attention") {
				const previous = step.activityState;
				step.activityState = "needs_attention";
				state.statusPayload.activityState = "needs_attention";
				appendControlEvent(state, buildControlEvent({ type: "needs_attention", from: previous, to: "needs_attention", runId: state.id, agent: step.agent, index: flatIndex, ts: now, message: `${step.agent} needs attention after repeated mutating tool failures`, reason: "tool_failures", turns: step.turnCount, tokens: step.tokens?.total, toolCount: step.toolCount, currentTool: toolSnapshot.tool, currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined, currentPath: toolSnapshot.path, recentFailureSummary: summarizeRecentMutatingFailures(failureState) }));
			}
		} else if (toolSnapshot?.mutates) {
			resetMutatingFailureState(state.mutatingFailureStates[flatIndex]!);
		}
	} else if (event.type === "message_end" && event.message?.role === "assistant") {
		appendRecentStepOutput(step, extractTextFromContent(event.message.content).split("\n").slice(-10));
		step.turnCount = (step.turnCount ?? 0) + 1;
		const usage = event.message.usage;
		if (usage) {
			const input = usage.input ?? usage.inputTokens ?? 0;
			const output = usage.output ?? usage.outputTokens ?? 0;
			const previousInput = step.tokens?.input ?? 0;
			const previousOutput = step.tokens?.output ?? 0;
			step.tokens = { input: previousInput + input, output: previousOutput + output, total: previousInput + previousOutput + input + output };
			const totalInput = state.statusPayload.totalTokens?.input ?? 0;
			const totalOutput = state.statusPayload.totalTokens?.output ?? 0;
			state.statusPayload.totalTokens = { input: totalInput + input, output: totalOutput + output, total: totalInput + totalOutput + input + output };
		}
		state.statusPayload.turnCount = Math.max(state.statusPayload.turnCount ?? 0, step.turnCount);
	}
	syncTopLevelCurrentTool(state.statusPayload);
	step.lastActivityAt = now;
	state.statusPayload.lastActivityAt = now;
	state.statusPayload.lastUpdate = now;
	maybeEmitActiveLongRunning(state, flatIndex, now);
	writeStatusPayload(state);
}

export function updateRunnerActivityState(state: RunnerExecutionState, now: number): boolean {
	if (!state.controlConfig.enabled) return false;
	let changed = false;
	let runLastActivityAt = state.statusPayload.lastActivityAt ?? state.overallStartTime;
	for (let index = 0; index < state.statusPayload.steps.length; index++) {
		const step = state.statusPayload.steps[index]!;
		if (step.status !== "running") continue;
		const lastActivityAt = stepOutputActivityAt(state, index);
		runLastActivityAt = Math.max(runLastActivityAt, lastActivityAt);
		if (step.lastActivityAt !== lastActivityAt) {
			step.lastActivityAt = lastActivityAt;
			changed = true;
		}
		const idleState = deriveActivityState({ config: state.controlConfig, startedAt: step.startedAt ?? state.overallStartTime, lastActivityAt, now });
		if (idleState === "needs_attention") {
			const previous = step.activityState;
			step.activityState = "needs_attention";
			if (previous !== "needs_attention") {
				appendControlEvent(state, buildControlEvent({ from: previous, to: "needs_attention", runId: state.id, agent: step.agent, index, ts: now, lastActivityAt }));
				changed = true;
			}
		} else if (maybeEmitActiveLongRunning(state, index, now)) changed = true;
	}
	if (state.statusPayload.lastActivityAt !== runLastActivityAt) {
		state.statusPayload.lastActivityAt = runLastActivityAt;
		changed = true;
	}
	const nextRunState = state.statusPayload.steps.some((step) => step.activityState === "needs_attention")
		? "needs_attention"
		: state.statusPayload.steps.some((step) => step.activityState === "active_long_running")
			? "active_long_running"
			: undefined;
	if (nextRunState !== state.currentActivityState) {
		state.currentActivityState = nextRunState;
		state.statusPayload.activityState = nextRunState;
		changed = true;
	}
	state.statusPayload.lastUpdate = now;
	if (changed) writeStatusPayload(state);
	return changed;
}

export function startActivityTimer(state: RunnerExecutionState): void {
	if (!state.controlConfig.enabled) return;
	state.activityTimer = setInterval(() => {
		if (state.statusPayload.state !== "running") return;
		updateRunnerActivityState(state, Date.now());
	}, 1000);
	state.activityTimer.unref?.();
}

export function interruptRunner(state: RunnerExecutionState): void {
	if (state.interrupted || state.statusPayload.state !== "running") return;
	state.interrupted = true;
	const now = Date.now();
	state.statusPayload.state = "paused";
	state.currentActivityState = undefined;
	state.statusPayload.activityState = undefined;
	state.statusPayload.lastUpdate = now;
	for (const step of state.statusPayload.steps) {
		if (step.status === "running") {
			step.status = "paused";
			step.activityState = undefined;
			step.endedAt = now;
			step.durationMs = step.startedAt ? now - step.startedAt : undefined;
			step.lastActivityAt = now;
		}
	}
	writeStatusPayload(state);
	appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.run.paused", ts: now, runId: state.id }));
	state.activeChildInterrupt?.();
}

export function cleanupActivityTimer(state: RunnerExecutionState): void {
	if (!state.activityTimer) return;
	clearInterval(state.activityTimer);
	state.activityTimer = undefined;
}

export { resetStepLiveDetail };
