import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import type { Message } from "@earendil-works/pi-ai/compat";
import type { AgentConfig } from "../../agents/agents.ts";
import {
	type AgentProgress,
	type RunSyncOptions,
	type SingleResult,
	INTERCOM_DETACH_REQUEST_EVENT,
	INTERCOM_DETACH_RESPONSE_EVENT,
	getSubagentDepthEnv,
} from "../../shared/types.ts";
import { extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
import { usageCostTotal } from "../../shared/usage-rollup.ts";
import { createJsonlWriter } from "../../shared/jsonl-writer.ts";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { applyThinkingSuffix, buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { formatPiSpawnError, getPiSpawnCommand, validatePiSpawnCwd } from "../shared/pi-spawn.ts";
import { assistantStopReason, isAssistantFailureStopReason, shouldStartSubagentFinalDrain } from "../shared/final-drain.ts";
import { modelFailureMessage } from "../shared/model-fallback.ts";
import { createAttemptWatchdog } from "../shared/attempt-watchdog.ts";
import {
	createMutatingFailureState,
	didMutatingToolFail,
	isMutatingTool,
	recordMutatingFailure,
	resetMutatingFailureState,
	resolveCurrentPath,
	shouldEscalateMutatingFailures,
	summarizeRecentMutatingFailures,
} from "../shared/long-running-guard.ts";
import { resolveSubagentModelFastMode } from "../../shared/fast-mode.ts";
import { appendRecentOutput, emptyUsage, modelFailureSignalByResult, snapshotProgress, snapshotResult } from "./execution-utils.ts";
import { createAttemptControlRuntime } from "./execution-attempt-control.ts";
import { finalizeSingleAttempt } from "./execution-attempt-finalize.ts";
import type { RunSingleAttemptShared } from "./execution-attempt-types.ts";

export async function runSingleAttempt(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: RunSingleAttemptShared,
): Promise<SingleResult> {
	const modelArg = applyThinkingSuffix(model, agent.thinking);
	const runCwd = options.cwd ?? runtimeCwd;
	const fastMode = resolveSubagentModelFastMode({
		model: modelArg,
		cwd: runCwd,
		settings: shared.fastModeSettings,
		scope: shared.fastModeScope,
	});
	const { args, env: sharedEnv, tempDir } = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task,
		sessionEnabled: shared.sessionEnabled,
		sessionDir: options.sessionDir,
		sessionFile: options.sessionFile,
		model,
		thinking: agent.thinking,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		tools: agent.tools,
		extensions: agent.extensions,
		systemPrompt: shared.systemPrompt,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: runCwd,
		promptFileStem: agent.name,
		intercomSessionName: options.intercomSessionName,
		orchestratorIntercomTarget: options.orchestratorIntercomTarget,
		runId: options.runId,
		childAgentName: agent.name,
		childIndex: options.index ?? 0,
		parentEventSink: options.nestedRoute?.eventSink,
		parentControlInbox: options.nestedRoute?.controlInbox,
		parentRootRunId: options.nestedRoute?.rootRunId,
		parentCapabilityToken: options.nestedRoute?.capabilityToken,
		codexFastModeSettings: shared.fastModeSettings,
		codexFastModeScope: shared.fastModeScope,
		structuredOutput: options.structuredOutput,
	});

	const result: SingleResult = {
		agent: agent.name,
		task: shared.originalTask ?? task,
		exitCode: 0,
		messages: [],
		usage: emptyUsage(),
		model: modelArg,
		...(fastMode ? { fastMode } : {}),
		artifactPaths: shared.artifactPaths,
		skills: shared.resolvedSkillNames,
		skillsWarning: shared.skillsWarning,
	};
	const startTime = Date.now();
	if (options.structuredOutput) {
		try {
			if (existsSync(options.structuredOutput.outputPath)) unlinkSync(options.structuredOutput.outputPath);
		} catch {
			// Missing/stale structured-output files are handled after the child exits.
		}
	}
	let interruptedByControl = false;
	const progress: AgentProgress = {
		index: options.index ?? 0,
		agent: agent.name,
		status: "running",
		task,
		skills: shared.resolvedSkillNames,
		recentTools: [],
		recentOutput: [...shared.attemptNotes],
		toolCount: 0,
		tokens: 0,
		durationMs: 0,
		lastActivityAt: startTime,
	};
	result.progress = progress;
	const controlRuntime = createAttemptControlRuntime({ options, agent, result, progress, startTime });
	const spawnEnv = {
		...process.env,
		...sharedEnv,
		...getSubagentDepthEnv(options.maxSubagentDepth, {
			workflowStageSubagentGuard: options.workflowStageSubagentGuard,
		}),
	};
	const cwdValidation = validatePiSpawnCwd(runCwd);
	if (!cwdValidation.ok) {
		cleanupTempDir(tempDir);
		result.error = cwdValidation.error;
		return finalizeSingleAttempt({
			result, progress, exitCode: 1, interruptedByControl, allControlEvents: controlRuntime.allControlEvents, options, shared, startTime,
		});
	}
	const exitCode = await new Promise<number>((resolve) => {
		const spawnSpec = getPiSpawnCommand(args);
		const proc = spawn(spawnSpec.command, spawnSpec.args, {
			cwd: runCwd,
			env: spawnEnv,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		const jsonlWriter = createJsonlWriter(shared.jsonlPath, proc.stdout);
		let buf = "";
		let processClosed = false;
		let settled = false;
		let detached = false;
		let intercomStarted = false;
		let assistantError: string | undefined;
		let assistantFailureSignal: unknown;
		let removeAbortListener: (() => void) | undefined;
		let removeInterruptListener: (() => void) | undefined;
		let activityTimer: NodeJS.Timeout | undefined;

		const detachForIntercom = () => {
			detached = true;
			processClosed = true;
			result.detached = true;
			result.detachedReason = "intercom coordination";
			progress.status = "detached";
			progress.durationMs = Date.now() - startTime;
			result.progressSummary = { toolCount: progress.toolCount, tokens: progress.tokens, durationMs: progress.durationMs };
			finish(-2);
		};

		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		const clearFinalDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		const startFinalDrain = () => {
			if (childExited || finalDrainTimer || settled || processClosed || detached) return;
			finalDrainTimer = setTimeout(() => {
				if (settled || processClosed || detached) return;
				const termSent = trySignalChild(proc, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !assistantError) {
					result.error = result.error ?? `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled || processClosed || detached) return;
					forcedTerminationSignal = trySignalChild(proc, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		};

		const unsubscribeIntercomDetach = options.intercomEvents?.on?.(INTERCOM_DETACH_REQUEST_EVENT, (payload) => {
			if (!options.allowIntercomDetach || detached || processClosed || !intercomStarted) return;
			if (!payload || typeof payload !== "object") return;
			const requestId = (payload as { requestId?: unknown }).requestId;
			if (typeof requestId !== "string" || requestId.length === 0) return;
			options.intercomEvents?.emit(INTERCOM_DETACH_RESPONSE_EVENT, { requestId, accepted: true });
			detachForIntercom();
		});

		const finish = (code: number) => {
			if (settled) return;
			settled = true;
			clearFinalDrainTimers();
			clearStdioGuard();
			attemptWatchdog.clear();
			if (activityTimer) {
				clearInterval(activityTimer);
				activityTimer = undefined;
			}
			unsubscribeIntercomDetach?.();
			removeAbortListener?.();
			removeInterruptListener?.();
			resolve(code);
		};

		let pendingToolResult: { tool: string; path?: string; mutates: boolean; startedAt?: number } | undefined;
		const mutatingFailures = createMutatingFailureState();
		const mutatingFailureWindowMs = 5 * 60_000;
		const emitUpdateSnapshot = (text: string) => {
			if (!options.onUpdate || processClosed) return;
			const progressSnapshot = snapshotProgress(progress);
			const resultSnapshot = snapshotResult(result, progressSnapshot);
			options.onUpdate({
				content: [{ type: "text", text }],
				details: {
					mode: "single",
					results: [resultSnapshot],
					progress: [progressSnapshot],
					controlEvents: controlRuntime.drainPendingControlEvents(),
				},
			});
		};
		const fireUpdate = () => {
			if (!options.onUpdate || processClosed) return;
			progress.durationMs = Date.now() - startTime;
			emitUpdateSnapshot(getFinalOutput(result.messages ?? []) || "(running...)");
		};

		const processLine = (line: string) => {
			if (!line.trim()) return;
			jsonlWriter.writeLine(line);
			let evt: { type?: string; message?: Message; toolName?: string; args?: unknown };
			try {
				evt = JSON.parse(line) as { type?: string; message?: Message; toolName?: string; args?: unknown };
			} catch {
				return;
			}

			const now = Date.now();
			progress.durationMs = now - startTime;
			progress.lastActivityAt = now;
			controlRuntime.updateActivityState(now);

			if (evt.type === "tool_execution_start") {
				const toolArgs = evt.args && typeof evt.args === "object" && !Array.isArray(evt.args) ? evt.args as Record<string, unknown> : {};
				if (options.allowIntercomDetach && (evt.toolName === "intercom" || evt.toolName === "contact_supervisor")) intercomStarted = true;
				progress.toolCount++;
				progress.currentTool = evt.toolName;
				progress.currentToolArgs = extractToolArgsPreview(toolArgs);
				progress.currentToolStartedAt = now;
				progress.currentPath = resolveCurrentPath(evt.toolName, toolArgs);
				pendingToolResult = { tool: evt.toolName ?? "tool", path: progress.currentPath, mutates: isMutatingTool(evt.toolName, toolArgs), startedAt: now };
				fireUpdate();
			}

			if (evt.type === "tool_execution_end") {
				if (progress.currentTool) {
					progress.recentTools.push({ tool: progress.currentTool, args: progress.currentToolArgs || "", endMs: now });
				}
				progress.currentTool = undefined;
				progress.currentToolArgs = undefined;
				progress.currentToolStartedAt = undefined;
				progress.currentPath = undefined;
				fireUpdate();
			}

			if (evt.type === "message_end" && evt.message) {
				result.messages?.push(evt.message);
				if (evt.message.role === "assistant") {
					result.usage.turns++;
					progress.turnCount = result.usage.turns;
					const u = evt.message.usage;
					if (u) {
						result.usage.input += u.input || 0;
						result.usage.output += u.output || 0;
						result.usage.cacheRead += u.cacheRead || 0;
						result.usage.cacheWrite += u.cacheWrite || 0;
						result.usage.cost += usageCostTotal(u.cost);
						progress.tokens = result.usage.input + result.usage.output;
					}
					if (!result.model && evt.message.model) result.model = evt.message.model;
					const assistantText = extractTextFromContent(evt.message.content);
					appendRecentOutput(progress, assistantText.split("\n").slice(-10));
					const stopReason = assistantStopReason(evt.message);
					if (evt.message.errorMessage) {
						assistantError = evt.message.errorMessage;
						assistantFailureSignal = evt.message;
					}
					if (isAssistantFailureStopReason(stopReason)) {
						assistantError = modelFailureMessage(evt.message);
						assistantFailureSignal = evt.message;
					}
					if (shouldStartSubagentFinalDrain(evt.message)) {
						if (assistantText.trim()) {
							assistantError = undefined;
							assistantFailureSignal = undefined;
						}
						cleanTerminalAssistantStopReceived = true;
						startFinalDrain();
					}
				}
				controlRuntime.updateActivityState(now);
				fireUpdate();
			}

			if (evt.type === "tool_result_end" && evt.message) {
				result.messages?.push(evt.message);
				const resultText = extractTextFromContent(evt.message.content);
				appendRecentOutput(progress, resultText.split("\n").slice(-10));
				const toolSnapshot = pendingToolResult;
				pendingToolResult = undefined;
				if (toolSnapshot?.mutates && didMutatingToolFail(resultText)) {
					recordMutatingFailure(mutatingFailures, {
						tool: toolSnapshot.tool,
						path: toolSnapshot.path,
						error: resultText.split("\n").find((row) => row.trim())?.trim().slice(0, 180) ?? "mutating tool failed",
						ts: now,
					}, mutatingFailureWindowMs);
					if (shouldEscalateMutatingFailures(mutatingFailures, controlRuntime.config.failedToolAttemptsBeforeAttention)) {
						controlRuntime.emitNeedsAttention(now, {
							message: `${agent.name} needs attention after repeated mutating tool failures`,
							reason: "tool_failures",
							currentTool: toolSnapshot.tool,
							currentPath: toolSnapshot.path,
							currentToolDurationMs: toolSnapshot.startedAt ? Math.max(0, now - toolSnapshot.startedAt) : undefined,
							recentFailureSummary: summarizeRecentMutatingFailures(mutatingFailures),
						});
					}
				} else if (toolSnapshot?.mutates) {
					resetMutatingFailureState(mutatingFailures);
				}
				fireUpdate();
			}
		};

		if (controlRuntime.config.enabled) {
			activityTimer = setInterval(() => {
				if (processClosed || settled || detached) return;
				const now = Date.now();
				if (controlRuntime.updateActivityState(now)) {
					progress.durationMs = now - startTime;
					fireUpdate();
				}
			}, 1000);
			activityTimer.unref?.();
		}

		let stderrBuf = "";
		const clearStdioGuard = attachPostExitStdioGuard(proc, { idleMs: 2000, hardMs: 8000 });
		const attemptWatchdog = createAttemptWatchdog({
			child: proc,
			isSettled: () => settled || processClosed || detached,
			// A slow, quiet tool call (long build/test run) must not be mistaken for a
			// stalled attempt: an in-flight tool execution counts as watchdog activity.
			// Caveat: `progress.currentTool` is cleared on tool_execution_end, so if a
			// tool ends abnormally without emitting its end event the idle watchdog is
			// deferred indefinitely and the wall-clock cap becomes the sole backstop for
			// this attempt — do not lower the wall cap assuming idle always fires.
			isToolActive: () => progress.currentTool !== undefined,
			onTimeout(message) {
				forcedTerminationSignal = true;
				result.error ??= message;
				progress.error = message;
			},
		});
		proc.stdout.on("data", (d) => {
			attemptWatchdog.activity();
			buf += d.toString();
			const lines = buf.split("\n");
			buf = lines.pop() || "";
			lines.forEach(processLine);
		});
		proc.stderr.on("data", (d) => {
			attemptWatchdog.activity();
			stderrBuf += d.toString();
		});
		proc.on("exit", () => {
			childExited = true;
			clearFinalDrainTimers();
		});
		proc.on("close", (code, signal) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			attemptWatchdog.clear();
			void jsonlWriter.close().catch(() => undefined);
			cleanupTempDir(tempDir);
			if (detached) {
				finish(-2);
				return;
			}
			processClosed = true;
			if (buf.trim()) processLine(buf);
			if (!result.error && assistantError) result.error = assistantError;
			if (assistantFailureSignal !== undefined && result.error === assistantError) {
				modelFailureSignalByResult.set(result, assistantFailureSignal);
			}
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !result.error;
			if (code !== 0 && stderrBuf.trim() && !result.error && !forcedDrainAfterFinalSuccess) result.error = stderrBuf.trim();
			const finalCode = forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (code ?? 1) : (code ?? 0);
			finish(finalCode);
		});
		proc.on("error", (error) => {
			clearFinalDrainTimers();
			clearStdioGuard();
			attemptWatchdog.clear();
			void jsonlWriter.close().catch(() => undefined);
			cleanupTempDir(tempDir);
			if (!result.error) result.error = formatPiSpawnError(error, spawnSpec, runCwd);
			finish(1);
		});

		if (options.signal) {
			const kill = () => {
				if (processClosed || detached) return;
				if (options.allowIntercomDetach && intercomStarted) {
					detachForIntercom();
					return;
				}
				proc.kill("SIGTERM");
				setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 3000);
			};
			if (options.signal.aborted) kill();
			else {
				options.signal.addEventListener("abort", kill, { once: true });
				removeAbortListener = () => options.signal?.removeEventListener("abort", kill);
			}
		}

		if (options.interruptSignal) {
			const interrupt = () => {
				if (processClosed || detached || settled) return;
				interruptedByControl = true;
				progress.status = "running";
				progress.durationMs = Date.now() - startTime;
				result.interrupted = true;
				result.finalOutput = "Interrupted. Waiting for explicit next action.";
				progress.activityState = undefined;
				fireUpdate();
				trySignalChild(proc, "SIGINT");
				setTimeout(() => {
					if (settled || processClosed || detached) return;
					trySignalChild(proc, "SIGTERM");
				}, 1000).unref?.();
			};
			if (options.interruptSignal.aborted) interrupt();
			else {
				options.interruptSignal.addEventListener("abort", interrupt, { once: true });
				removeInterruptListener = () => options.interruptSignal?.removeEventListener("abort", interrupt);
			}
		}
	});

	return finalizeSingleAttempt({
		result,
		progress,
		exitCode,
		interruptedByControl,
		allControlEvents: controlRuntime.allControlEvents,
		options,
		shared,
		startTime,
	});
}
