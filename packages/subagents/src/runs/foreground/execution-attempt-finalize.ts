import type { AgentProgress, ControlEvent, RunSyncOptions, SingleResult } from "../../shared/types.ts";
import { detectSubagentError, getFinalOutput } from "../../shared/utils.ts";
import { readStructuredOutput } from "../shared/structured-output.ts";
import { formatSavedOutputReference, resolveSingleOutput } from "../shared/single-output.ts";
import { artifactOutputByResult, snapshotProgress, snapshotResult } from "./execution-utils.ts";
import type { RunSingleAttemptShared } from "./execution-attempt-types.ts";

export function finalizeSingleAttempt(input: {
	result: SingleResult;
	progress: AgentProgress;
	exitCode: number;
	interruptedByControl: boolean;
	allControlEvents: ControlEvent[];
	options: RunSyncOptions;
	shared: RunSingleAttemptShared;
	startTime: number;
}): SingleResult {
	const { result, progress, options, shared, allControlEvents } = input;
	result.exitCode = input.exitCode;
	if (input.interruptedByControl) {
		result.exitCode = 0;
		result.interrupted = true;
		result.error = undefined;
		result.finalOutput = result.finalOutput || "Interrupted. Waiting for explicit next action.";
		result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
		progress.activityState = undefined;
		progress.durationMs = Date.now() - input.startTime;
		result.progressSummary = {
			toolCount: progress.toolCount,
			tokens: progress.tokens,
			durationMs: progress.durationMs,
		};
		return result;
	}
	if (result.detached) {
		result.exitCode = 0;
		result.finalOutput = "Detached for intercom coordination.";
		return result;
	}

	if (result.error && result.exitCode === 0) result.exitCode = 1;
	if (result.exitCode === 0 && !result.error) {
		const errInfo = detectSubagentError(result.messages ?? []);
		if (errInfo.hasError) {
			result.exitCode = errInfo.exitCode ?? 1;
			result.error = errInfo.details
				? `${errInfo.errorType} failed (exit ${errInfo.exitCode}): ${errInfo.details}`
				: `${errInfo.errorType} failed with exit code ${errInfo.exitCode}`;
		}
	}
	if (options.structuredOutput && result.exitCode === 0 && !result.error) {
		const structured = readStructuredOutput(options.structuredOutput);
		result.structuredOutputSchemaPath = options.structuredOutput.schemaPath;
		result.structuredOutputPath = options.structuredOutput.outputPath;
		if (structured.error) {
			result.exitCode = 1;
			result.error = structured.error;
		} else {
			result.structuredOutput = structured.value;
		}
	}

	progress.status = result.exitCode === 0 ? "completed" : "failed";
	progress.durationMs = Date.now() - input.startTime;
	if (result.error) {
		progress.error = result.error;
		if (progress.currentTool) progress.failedTool = progress.currentTool;
	}

	result.progressSummary = {
		toolCount: progress.toolCount,
		tokens: progress.tokens,
		durationMs: progress.durationMs,
	};

	let fullOutput = getFinalOutput(result.messages ?? []);
	if (options.outputPath && result.exitCode === 0) {
		const resolvedOutput = resolveSingleOutput(options.outputPath, fullOutput, shared.outputSnapshot);
		fullOutput = resolvedOutput.fullOutput;
		result.savedOutputPath = resolvedOutput.savedPath;
		result.outputSaveError = resolvedOutput.saveError;
		if (resolvedOutput.savedPath) {
			result.outputReference = formatSavedOutputReference(resolvedOutput.savedPath, fullOutput);
		}
	}
	artifactOutputByResult.set(result, fullOutput);
	result.outputMode = options.outputMode ?? "inline";
	result.finalOutput = options.outputMode === "file-only" && result.savedOutputPath && result.outputReference
		? result.outputReference.message
		: fullOutput;
	result.controlEvents = allControlEvents.length ? allControlEvents : undefined;
	if (options.onUpdate) {
		const finalText = result.finalOutput || result.error || "(no output)";
		const progressSnapshot = snapshotProgress(progress);
		const resultSnapshot = snapshotResult(result, progressSnapshot);
		options.onUpdate({
			content: [{ type: "text", text: finalText }],
			details: {
				mode: "single",
				results: [resultSnapshot],
				progress: [progressSnapshot],
				controlEvents: allControlEvents.length ? allControlEvents : undefined,
			},
		});
	}
	return result;
}
