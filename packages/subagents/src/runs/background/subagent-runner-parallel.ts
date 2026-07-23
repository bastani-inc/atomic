import * as path from "node:path";
import { appendJsonl } from "../../shared/artifacts.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import { aggregateParallelOutputs, mapConcurrent, MAX_PARALLEL_CONCURRENCY } from "../shared/parallel-utils.ts";
import { cleanupWorktrees, createWorktrees, findWorktreeTaskCwdConflict, formatWorktreeTaskCwdConflict, type WorktreeSetup } from "../shared/worktree.ts";
import { outputEntryFromAsyncResult, runSingleStep } from "./subagent-runner-step.ts";
import type { ParallelGroup, RunnerExecutionState } from "./subagent-runner-types.ts";
import { resetStepLiveDetail, updateStepFromChildEvent, updateStepModel, writeStatusPayload } from "./subagent-runner-state.ts";
import { tokenUsageFromAttempts } from "./subagent-runner-utils.ts";
import {
	appendParallelWorktreeSummary,
	ensureParallelProgressFile,
	markParallelGroupRunning,
	markParallelGroupSetupFailure,
	prepareParallelTaskRun,
} from "./subagent-runner-parallel-helpers.ts";

export async function runParallelGroup(state: RunnerExecutionState, group: ParallelGroup, stepIndex: number): Promise<boolean> {
	const { cwd, asyncDir, id, placeholder, sessionEnabled, outputs, config, artifactsDir, artifactConfig, flatSteps } = state;
	const { statusPayload } = state;
	const concurrency = group.concurrency ?? MAX_PARALLEL_CONCURRENCY;
	const failFast = group.failFast ?? false;
	const groupStartFlatIndex = state.flatIndex;
	let aborted = false;
	let worktreeSetup: WorktreeSetup | undefined;
	if (group.worktree) {
		const worktreeTaskCwdConflict = findWorktreeTaskCwdConflict(group.parallel, cwd);
		if (worktreeTaskCwdConflict) {
			const failedAt = Date.now();
			markParallelGroupSetupFailure({ statusPayload, results: state.results, group, groupStartFlatIndex, setupError: formatWorktreeTaskCwdConflict(worktreeTaskCwdConflict, cwd), failedAt, statusPath: state.statusPath, eventsPath: state.eventsPath, asyncDir, runId: id, stepIndex });
			state.flatIndex += group.parallel.length;
			return false;
		}
		try {
			worktreeSetup = createWorktrees(cwd, `${id}-s${stepIndex}`, group.parallel.length, {
				agents: group.parallel.map((task) => task.agent),
				setupHook: config.worktreeSetupHook ? { hookPath: config.worktreeSetupHook, timeoutMs: config.worktreeSetupHookTimeoutMs } : undefined,
			});
		} catch (error) {
			const setupError = error instanceof Error ? error.message : String(error);
			const failedAt = Date.now();
			markParallelGroupSetupFailure({ statusPayload, results: state.results, group, groupStartFlatIndex, setupError, failedAt, statusPath: state.statusPath, eventsPath: state.eventsPath, asyncDir, runId: id, stepIndex });
			state.flatIndex += group.parallel.length;
			return false;
		}
	}

	try {
		if (group.worktree) ensureParallelProgressFile(cwd, group);
		const groupStartTime = Date.now();
		markParallelGroupRunning({ statusPayload, group, groupStartFlatIndex, groupStartTime, statusPath: state.statusPath, eventsPath: state.eventsPath, asyncDir, runId: id, stepIndex });
		const parallelResults = await mapConcurrent(group.parallel, concurrency, async (task, taskIdx) => {
			const fi = groupStartFlatIndex + taskIdx;
			if (aborted && failFast) {
				const skippedAt = Date.now();
				statusPayload.steps[fi].status = "failed";
				statusPayload.steps[fi].error = "Skipped due to fail-fast";
				statusPayload.steps[fi].startedAt = skippedAt;
				statusPayload.steps[fi].endedAt = skippedAt;
				statusPayload.steps[fi].durationMs = 0;
				statusPayload.steps[fi].exitCode = -1;
				statusPayload.steps[fi].activityState = undefined;
				statusPayload.lastUpdate = skippedAt;
				writeStatusPayload(state);
				appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.step.failed", ts: skippedAt, runId: id, stepIndex: fi, agent: task.agent, exitCode: -1, durationMs: 0 }));
				return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
			}

			const taskStartTime = Date.now();
			statusPayload.currentStep = fi;
			statusPayload.steps[fi].status = "running";
			statusPayload.steps[fi].error = undefined;
			statusPayload.steps[fi].activityState = undefined;
			resetStepLiveDetail(statusPayload.steps[fi]);
			statusPayload.steps[fi].startedAt = taskStartTime;
			statusPayload.steps[fi].endedAt = undefined;
			statusPayload.steps[fi].durationMs = undefined;
			statusPayload.steps[fi].lastActivityAt = taskStartTime;
			statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
			statusPayload.lastActivityAt = taskStartTime;
			statusPayload.lastUpdate = taskStartTime;
			writeStatusPayload(state);
			appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));

			const taskSessionDir = config.sessionDir ? path.join(config.sessionDir, `parallel-${taskIdx}`) : undefined;
			const { taskForRun, taskCwd } = prepareParallelTaskRun(task, cwd, worktreeSetup, taskIdx);
			const singleResult = await runSingleStep(taskForRun, {
				previousOutput: state.previousOutput, placeholder, cwd: taskCwd, sessionEnabled, outputs,
				sessionDir: taskSessionDir,
				artifactsDir, artifactConfig, id,
				flatIndex: fi, flatStepCount: flatSteps.length,
				outputFile: path.join(asyncDir, `output-${fi}.log`),
				piPackageRoot: config.piPackageRoot,
				piArgv1: config.piArgv1,
				childIntercomTarget: config.childIntercomTargets?.[fi],
				orchestratorIntercomTarget: config.controlIntercomTarget,
				supervisorAuthorization: config.supervisorAuthorizations?.[fi],
				nestedRoute: config.nestedRoute,
				registerInterrupt: (interrupt) => {
					state.activeChildInterrupt = interrupt;
				},
				onAttemptStart: (attempt) => updateStepModel(state, fi, attempt.model, attempt.thinking, attempt.fastMode),
				onChildEvent: (event) => updateStepFromChildEvent(state, fi, event),
				workflowStageSubagentGuard: config.workflowStageSubagentGuard,
			});
			if (task.sessionFile) state.latestSessionFile = task.sessionFile;

			const taskEndTime = Date.now();
			const taskDuration = taskEndTime - taskStartTime;
			statusPayload.steps[fi].status = singleResult.exitCode === 0 ? "complete" : "failed";
			statusPayload.steps[fi].endedAt = taskEndTime;
			statusPayload.steps[fi].durationMs = taskDuration;
			statusPayload.steps[fi].exitCode = singleResult.exitCode;
			statusPayload.steps[fi].model = singleResult.model;
			statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
			statusPayload.steps[fi].fastMode = singleResult.fastMode ? true : undefined;
			statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
			statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
			statusPayload.steps[fi].error = singleResult.error;
			statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
			statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
			statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
			statusPayload.lastUpdate = taskEndTime;
			writeStatusPayload(state);
			appendJsonl(state.eventsPath, JSON.stringify({ type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed", ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent, exitCode: singleResult.exitCode, durationMs: taskDuration }));
			if (singleResult.exitCode !== 0 && failFast) aborted = true;
			return { ...singleResult, skipped: false };
		});

		state.flatIndex += group.parallel.length;
		for (let t = 0; t < group.parallel.length; t++) {
			const fi = groupStartFlatIndex + t;
			const sessionTokens = config.sessionDir ? parseSessionTokens(path.join(config.sessionDir, `parallel-${t}`)) : null;
			const taskTokens = sessionTokens ?? tokenUsageFromAttempts(parallelResults[t]?.modelAttempts);
			if (!taskTokens) continue;
			statusPayload.steps[fi].tokens = taskTokens;
			state.previousCumulativeTokens = { input: state.previousCumulativeTokens.input + taskTokens.input, output: state.previousCumulativeTokens.output + taskTokens.output, total: state.previousCumulativeTokens.total + taskTokens.total };
		}
		statusPayload.totalTokens = { ...state.previousCumulativeTokens };
		statusPayload.lastUpdate = Date.now();
		writeStatusPayload(state);

		for (const pr of parallelResults) {
			state.results.push({ agent: pr.agent, output: pr.output, error: pr.error, success: pr.exitCode === 0, exitCode: pr.exitCode, skipped: pr.skipped, sessionFile: pr.sessionFile, intercomTarget: pr.intercomTarget, model: pr.model, fastMode: pr.fastMode, attemptedModels: pr.attemptedModels, modelAttempts: pr.modelAttempts, artifactPaths: pr.artifactPaths, structuredOutput: pr.structuredOutput, structuredOutputPath: pr.structuredOutputPath, structuredOutputSchemaPath: pr.structuredOutputSchemaPath });
		}
		for (let t = 0; t < group.parallel.length; t++) {
			const outputName = group.parallel[t]?.outputName;
			if (outputName) outputs[outputName] = outputEntryFromAsyncResult({ agent: parallelResults[t]!.agent, output: parallelResults[t]!.output, structuredOutput: parallelResults[t]!.structuredOutput }, stepIndex);
		}
		statusPayload.outputs = outputs;

		state.previousOutput = aggregateParallelOutputs(parallelResults.map((r) => ({ agent: r.agent, output: r.output, exitCode: r.exitCode, error: r.error, model: r.model, fastMode: r.fastMode, attemptedModels: r.attemptedModels })));
		state.previousOutput = appendParallelWorktreeSummary(state.previousOutput, worktreeSetup, asyncDir, stepIndex, group);
		appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.parallel.completed", ts: Date.now(), runId: id, stepIndex, success: parallelResults.every((r) => r.exitCode === 0 || r.exitCode === -1) }));
		return !parallelResults.some((r) => r.exitCode !== 0 && r.exitCode !== -1);
	} finally {
		if (worktreeSetup) cleanupWorktrees(worktreeSetup);
	}
}
