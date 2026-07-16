import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Message } from "@earendil-works/pi-ai/compat";
import { attachPostExitStdioGuard, trySignalChild } from "../../shared/post-exit-stdio-guard.ts";
import { detectSubagentError, extractTextFromContent, extractToolArgsPreview, getFinalOutput } from "../../shared/utils.ts";
import { getSubagentDepthEnv } from "../../shared/types.ts";
import { formatPiSpawnError, getPiSpawnCommand, validatePiSpawnCwd } from "../shared/pi-spawn.ts";
import {
	assistantStopReason,
	isAssistantFailureStopReason,
	shouldStartSubagentFinalDrain,
} from "../shared/final-drain.ts";
import { modelFailureMessage } from "../shared/model-fallback.ts";
import { createAttemptWatchdog } from "../shared/attempt-watchdog.ts";
import type { ChildEvent, ChildEventContext, RunPiStreamingResult } from "./subagent-runner-types.ts";
import { createChildEventJournal } from "./async-event-journal.ts";
import { emptyUsage } from "./subagent-runner-utils.ts";

export function runPiStreaming(
	args: string[],
	cwd: string,
	outputFile: string,
	env?: Record<string, string | undefined>,
	piPackageRoot?: string,
	piArgv1?: string,
	maxSubagentDepth?: number,
	workflowStageSubagentGuard?: boolean,
	childEventContext?: ChildEventContext,
	registerInterrupt?: (interrupt: (() => void) | undefined) => void,
	onChildEvent?: (event: ChildEvent) => void,
): Promise<RunPiStreamingResult> {
	const cwdValidation = validatePiSpawnCwd(cwd);
	if (!cwdValidation.ok) {
		return Promise.resolve({
			stderr: "",
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: cwdValidation.error,
			finalOutput: "",
		});
	}
	return new Promise((resolve) => {
		const outputStream = fs.createWriteStream(outputFile, { flags: "w" });
		outputStream.on("error", () => undefined);
		let outputClosePromise: Promise<void> | undefined;
		const closeOutputStream = (): Promise<void> => {
			if (outputClosePromise) return outputClosePromise;
			outputClosePromise = new Promise((finish) => {
				if (outputStream.closed || outputStream.destroyed) { finish(); return; }
				let finished = false;
				const done = (): void => {
					if (finished) return;
					finished = true;
					finish();
				};
				outputStream.once("error", done);
				outputStream.end(done);
			});
			return outputClosePromise;
		};
		const spawnEnv = {
			...process.env,
			...(env ?? {}),
			...getSubagentDepthEnv(maxSubagentDepth, { workflowStageSubagentGuard }),
		};
		const spawnSpec = getPiSpawnCommand(args, {
			...(piPackageRoot ? { piPackageRoot } : {}),
			...(piArgv1 ? { argv1: piArgv1 } : {}),
		});
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
			env: spawnEnv,
			windowsHide: true,
		});
		const childEventJournal = createChildEventJournal(childEventContext?.eventsPath, child.stdout, {
			runId: childEventContext?.runId ?? "",
			stepIndex: childEventContext?.stepIndex,
			agent: childEventContext?.agent ?? "",
		});
		let stderr = "";
		let stdoutBuf = "";
		let stderrBuf = "";
		const messages: Message[] = [];
		const usage = emptyUsage();
		let model: string | undefined;
		let error: string | undefined;
		let assistantError: string | undefined;
		let assistantFailureSignal: unknown;
		let spawnErrorText: string | undefined;
		let interrupted = false;
		let activeToolExecutions = 0;
		const rawStdoutLines: string[] = [];

		const writeOutputLine = (line: string) => {
			if (!line.trim()) return;
			outputStream.write(`${line}\n`);
		};

		const writeOutputText = (text: string) => {
			for (const line of text.split("\n")) {
				writeOutputLine(line);
			}
		};

		const appendChildEvent = (event: Record<string, unknown> | ChildEvent) => {
			if (!childEventContext) return;
			childEventJournal.append({ ...event });
		};

		const appendChildLine = (type: "subagent.child.stdout" | "subagent.child.stderr", line: string) => {
			appendChildEvent({ type, line });
		};

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: ChildEvent;
			try {
				event = JSON.parse(line) as ChildEvent;
			} catch {
				rawStdoutLines.push(line);
				writeOutputLine(line);
				appendChildLine("subagent.child.stdout", line);
				return;
			}

			appendChildEvent(event);
			onChildEvent?.(event);

			// Track in-flight tool executions so the idle watchdog does not mistake a
			// slow, quiet tool call for a stalled attempt.
			if (event.type === "tool_execution_start") activeToolExecutions += 1;
			else if (event.type === "tool_execution_end") activeToolExecutions = Math.max(0, activeToolExecutions - 1);

			if (event.type === "tool_execution_start" && event.toolName) {
				const toolArgs = extractToolArgsPreview(event.args ?? {});
				writeOutputLine(toolArgs ? `${event.toolName}: ${toolArgs}` : event.toolName);
				return;
			}

			if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
				messages.push(event.message);
				const text = extractTextFromContent(event.message.content);
				if (text) writeOutputText(text);

				if (event.type !== "message_end" || event.message.role !== "assistant") return;
				if (event.message.model) model = event.message.model;
				const eventUsage = event.message.usage;
				if (eventUsage) {
					usage.turns++;
					usage.input += eventUsage.input ?? eventUsage.inputTokens ?? 0;
					usage.output += eventUsage.output ?? eventUsage.outputTokens ?? 0;
					usage.cacheRead += eventUsage.cacheRead ?? 0;
					usage.cacheWrite += eventUsage.cacheWrite ?? 0;
					usage.cost += eventUsage.cost?.total ?? 0;
				}
				const stopReason = assistantStopReason(event.message);
				if (event.message.errorMessage) {
					assistantError = event.message.errorMessage;
					assistantFailureSignal = event.message;
				}
				if (isAssistantFailureStopReason(stopReason)) {
					assistantError = modelFailureMessage(event.message);
					assistantFailureSignal = event.message;
				}
				if (shouldStartSubagentFinalDrain(event.message)) {
					if (extractTextFromContent(event.message.content).trim()) {
						assistantError = undefined;
						assistantFailureSignal = undefined;
					}
					cleanTerminalAssistantStopReceived = true;
					startFinalDrain();
				}
			}
		};

		const processStderrText = (text: string) => {
			stderr += text;
			stderrBuf += text;
			outputStream.write(text);
			if (!childEventContext) return;
			const lines = stderrBuf.split("\n");
			stderrBuf = lines.pop() || "";
			for (const line of lines) {
				if (!line.trim()) continue;
				appendChildLine("subagent.child.stderr", line);
			}
		};

		const FINAL_STOP_GRACE_MS = 1000;
		const HARD_KILL_MS = 3000;
		let childExited = false;
		let forcedTerminationSignal = false;
		let cleanTerminalAssistantStopReceived = false;
		let finalDrainTimer: NodeJS.Timeout | undefined;
		let finalHardKillTimer: NodeJS.Timeout | undefined;
		let settled = false;
		const clearStdioGuard = attachPostExitStdioGuard(child, { idleMs: 2000, hardMs: 8000 });
		const attemptWatchdog = createAttemptWatchdog({
			child,
			isSettled: () => settled,
			// An in-flight tool execution counts as watchdog activity so a slow, quiet
			// tool call is not mistaken for a stalled attempt. Caveat: the counter only
			// decrements on tool_execution_end, so if a tool ends abnormally without its
			// end event the idle watchdog is deferred indefinitely and the wall-clock cap
			// becomes the sole backstop — do not lower the wall cap assuming idle fires.
			isToolActive: () => activeToolExecutions > 0,
			onTimeout(message) {
				forcedTerminationSignal = true;
				error ??= message;
			},
		});
		child.stdout.on("data", (chunk: Buffer) => {
			attemptWatchdog.activity();
			const text = chunk.toString();
			stdoutBuf += text;
			const lines = stdoutBuf.split("\n");
			stdoutBuf = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		child.stderr.on("data", (chunk: Buffer) => {
			attemptWatchdog.activity();
			processStderrText(chunk.toString());
		});
		registerInterrupt?.(() => {
			if (settled) return;
			interrupted = true;
			if (!error) error = "Interrupted. Waiting for explicit next action.";
			trySignalChild(child, "SIGINT");
			setTimeout(() => {
				if (!settled) trySignalChild(child, "SIGTERM");
			}, 1000).unref?.();
		});
		const clearDrainTimers = () => {
			if (finalDrainTimer) {
				clearTimeout(finalDrainTimer);
				finalDrainTimer = undefined;
			}
			if (finalHardKillTimer) {
				clearTimeout(finalHardKillTimer);
				finalHardKillTimer = undefined;
			}
		};
		function startFinalDrain(): void {
			if (childExited || finalDrainTimer || settled) return;
			finalDrainTimer = setTimeout(() => {
				if (settled) return;
				const termSent = trySignalChild(child, "SIGTERM");
				if (!termSent) return;
				forcedTerminationSignal = true;
				if (!cleanTerminalAssistantStopReceived && !error && !assistantError) {
					error = `Subagent process did not exit within ${FINAL_STOP_GRACE_MS}ms after its final message. Forcing termination.`;
				}
				finalHardKillTimer = setTimeout(() => {
					if (settled) return;
					forcedTerminationSignal = trySignalChild(child, "SIGKILL") || forcedTerminationSignal;
				}, HARD_KILL_MS);
				finalHardKillTimer.unref?.();
			}, FINAL_STOP_GRACE_MS);
			finalDrainTimer.unref?.();
		}
		child.on("exit", () => {
			childExited = true;
			clearDrainTimers();
		});
		child.on("close", async (exitCode, signal) => {
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			attemptWatchdog.clear();
			if (stdoutBuf.trim()) processStdoutLine(stdoutBuf);
			if (stderrBuf.trim()) appendChildLine("subagent.child.stderr", stderrBuf);
			await Promise.all([closeOutputStream(), childEventJournal.close()]);
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const finalError = error ?? assistantError ?? spawnErrorText;
			const forcedDrainAfterFinalSuccess = forcedTerminationSignal && cleanTerminalAssistantStopReceived && !finalError;
			resolve({
				stderr,
				exitCode: interrupted || forcedDrainAfterFinalSuccess ? 0 : forcedTerminationSignal || signal ? (exitCode ?? 1) : exitCode,
				messages,
				usage,
				model,
				error: interrupted || forcedDrainAfterFinalSuccess ? undefined : finalError,
				finalOutput,
				interrupted,
				...(assistantFailureSignal !== undefined && finalError === assistantError
					? { modelFailureSignal: assistantFailureSignal }
					: {}),
			});
		});

		child.on("error", async (spawnError) => {
			// Capture the diagnostic before awaiting journal drain: `close` may fire
			// while this handler is suspended and win Promise settlement.
			spawnErrorText = formatPiSpawnError(spawnError, spawnSpec, cwd);
			settled = true;
			registerInterrupt?.(undefined);
			clearDrainTimers();
			clearStdioGuard();
			attemptWatchdog.clear();
			await Promise.all([closeOutputStream(), childEventJournal.close()]);
			const finalOutput = getFinalOutput(messages) || rawStdoutLines.join("\n").trim();
			const finalError = error ?? assistantError ?? spawnErrorText;
			resolve({
				stderr,
				exitCode: 1,
				messages,
				usage,
				model,
				error: finalError,
				finalOutput,
				...(assistantFailureSignal !== undefined && finalError === assistantError
					? { modelFailureSignal: assistantFailureSignal }
					: {}),
			});
		});
	});
}

export { detectSubagentError };
