import * as path from "node:path";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { appendJsonl } from "../../shared/artifacts.ts";
import { DEFAULT_MAX_OUTPUT, truncateOutput } from "../../shared/types.ts";
import { createShareLink, exportSessionHtml, writeRunLog } from "./subagent-runner-output.ts";
import { findLatestSessionFile } from "./subagent-runner-utils.ts";
import { cleanupActivityTimer, writeStatusPayload } from "./subagent-runner-state.ts";
import type { RunnerExecutionState } from "./subagent-runner-types.ts";

export async function finalizeRun(state: RunnerExecutionState): Promise<void> {
	const { config, results, maxOutput, flatSteps, statusPayload, artifactsDir, cwd, asyncDir, id } = state;
	let summary = results.map((r) => `${r.agent}:\n${r.output}`).join("\n\n");
	let truncated = false;

	if (maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
		const lastArtifactPath = results[results.length - 1]?.artifactPaths?.outputPath;
		const truncResult = truncateOutput(summary, config, lastArtifactPath);
		if (truncResult.truncated) {
			summary = truncResult.text;
			truncated = true;
		}
	}

	const resultMode = config.resultMode ?? statusPayload.mode;
	const agentName = flatSteps.length === 1
		? flatSteps[0].agent
		: resultMode === "parallel"
			? `parallel:${flatSteps.map((s) => s.agent).join("+")}`
			: `chain:${flatSteps.map((s) => s.agent).join("->")}`;
	let sessionFile: string | undefined;
	let shareUrl: string | undefined;
	let gistUrl: string | undefined;
	let shareError: string | undefined;

	if (state.shareEnabled) {
		sessionFile = config.sessionDir ? (findLatestSessionFile(config.sessionDir) ?? undefined) : undefined;
		if (!sessionFile && state.latestSessionFile) sessionFile = state.latestSessionFile;
		if (sessionFile) {
			try {
				const exportDir = config.sessionDir ?? path.dirname(sessionFile);
				const htmlPath = await exportSessionHtml(sessionFile, exportDir, config.piPackageRoot);
				const share = createShareLink(htmlPath);
				if ("error" in share) shareError = share.error;
				else {
					shareUrl = share.shareUrl;
					gistUrl = share.gistUrl;
				}
			} catch (err) {
				shareError = String(err);
			}
		} else {
			shareError = "Session file not found.";
		}
	}

	cleanupActivityTimer(state);
	const effectiveSessionFile = sessionFile ?? state.latestSessionFile;
	const runEndedAt = Date.now();
	statusPayload.state = state.interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed";
	statusPayload.activityState = undefined;
	statusPayload.endedAt = runEndedAt;
	statusPayload.lastUpdate = runEndedAt;
	statusPayload.sessionFile = effectiveSessionFile;
	statusPayload.shareUrl = shareUrl;
	statusPayload.gistUrl = gistUrl;
	statusPayload.shareError = shareError;
	if (statusPayload.state === "failed" && !statusPayload.error) {
		const failedStep = statusPayload.steps.find((s) => s.status === "failed");
		if (failedStep?.agent) statusPayload.error = `Step failed: ${failedStep.agent}`;
	}
	writeStatusPayload(state);
	appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.run.completed", ts: runEndedAt, runId: id, status: statusPayload.state, durationMs: runEndedAt - state.overallStartTime }));
	writeRunLog(state.logPath, {
		id,
		mode: statusPayload.mode,
		cwd,
		startedAt: state.overallStartTime,
		endedAt: runEndedAt,
		steps: statusPayload.steps.map((step) => ({ agent: step.agent, status: step.status, durationMs: step.durationMs })),
		summary,
		truncated,
		artifactsDir,
		sessionFile: effectiveSessionFile,
		shareUrl,
		shareError,
	});

	try {
		writeAtomicJson(state.resultPath, {
			id,
			agent: agentName,
			mode: resultMode,
			success: !state.interrupted && results.every((r) => r.success),
			state: state.interrupted ? "paused" : results.every((r) => r.success) ? "complete" : "failed",
			summary: state.interrupted ? "Paused after interrupt. Waiting for explicit next action." : summary,
			results: results.map((r) => ({
				agent: r.agent,
				output: r.output,
				error: r.error,
				success: r.success,
				skipped: r.skipped || undefined,
				sessionFile: r.sessionFile,
				intercomTarget: r.intercomTarget,
				model: r.model,
				fastMode: r.fastMode,
				attemptedModels: r.attemptedModels,
				modelAttempts: r.modelAttempts,
				artifactPaths: r.artifactPaths,
				truncated: r.truncated,
				structuredOutput: r.structuredOutput,
				structuredOutputPath: r.structuredOutputPath,
				structuredOutputSchemaPath: r.structuredOutputSchemaPath,
			})),
			outputs: state.outputs,
			workflowGraph: statusPayload.workflowGraph,
			exitCode: state.interrupted || results.every((r) => r.success) ? 0 : 1,
			timestamp: runEndedAt,
			durationMs: runEndedAt - state.overallStartTime,
			truncated,
			artifactsDir,
			cwd,
			asyncDir,
			sessionId: config.sessionId,
			sessionFile: effectiveSessionFile,
			intercomTarget: config.controlIntercomTarget,
			shareUrl,
			gistUrl,
			shareError,
			...(state.taskIndex !== undefined && { taskIndex: state.taskIndex }),
			...(state.totalTasks !== undefined && { totalTasks: state.totalTasks }),
		});
	} catch (err) {
		console.error(`Failed to write result file ${state.resultPath}:`, err);
	}
}
