import * as path from "node:path";
import { appendJsonl } from "../../shared/artifacts.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { parseSessionTokens } from "../../shared/session-tokens.ts";
import { outputEntryFromAsyncResult, runSingleStep } from "./subagent-runner-step.ts";
import type { RunnerExecutionState, SubagentStep } from "./subagent-runner-types.ts";
import { resetStepLiveDetail, updateStepFromChildEvent, updateStepModel, writeStatusPayload } from "./subagent-runner-state.ts";
import { tokenUsageFromAttempts } from "./subagent-runner-utils.ts";

export async function runSequentialStep(state: RunnerExecutionState, seqStep: SubagentStep, stepIndex: number): Promise<boolean> {
	const { statusPayload, asyncDir, id, cwd, placeholder, sessionEnabled, outputs, config, artifactsDir, artifactConfig, flatSteps } = state;
	const flatIndex = state.flatIndex;
	const stepStartTime = Date.now();
	statusPayload.currentStep = flatIndex;
	statusPayload.steps[flatIndex].status = "running";
	statusPayload.steps[flatIndex].activityState = undefined;
	statusPayload.activityState = undefined;
	resetStepLiveDetail(statusPayload.steps[flatIndex]);
	statusPayload.steps[flatIndex].skills = seqStep.skills;
	statusPayload.steps[flatIndex].startedAt = stepStartTime;
	statusPayload.steps[flatIndex].lastActivityAt = stepStartTime;
	statusPayload.lastActivityAt = stepStartTime;
	statusPayload.lastUpdate = stepStartTime;
	statusPayload.outputFile = path.join(asyncDir, `output-${flatIndex}.log`);
	writeStatusPayload(state);

	appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.step.started", ts: stepStartTime, runId: id, stepIndex: flatIndex, agent: seqStep.agent }));

	const singleResult = await runSingleStep(seqStep, {
		previousOutput: state.previousOutput, placeholder, cwd, sessionEnabled,
		outputs,
		sessionDir: config.sessionDir,
		artifactsDir, artifactConfig, id,
		flatIndex, flatStepCount: flatSteps.length,
		outputFile: path.join(asyncDir, `output-${flatIndex}.log`),
		piPackageRoot: config.piPackageRoot,
		piArgv1: config.piArgv1,
		childIntercomTarget: config.childIntercomTargets?.[flatIndex],
		orchestratorIntercomTarget: config.controlIntercomTarget,
		supervisorAuthorization: config.supervisorAuthorizations?.[flatIndex],
		nestedRoute: config.nestedRoute,
		registerInterrupt: (interrupt) => {
			state.activeChildInterrupt = interrupt;
		},
		onAttemptStart: (attempt) => updateStepModel(state, flatIndex, attempt.model, attempt.thinking, attempt.fastMode),
		onChildEvent: (event) => updateStepFromChildEvent(state, flatIndex, event),
		workflowStageSubagentGuard: config.workflowStageSubagentGuard,
	});
	if (seqStep.sessionFile) state.latestSessionFile = seqStep.sessionFile;

	state.previousOutput = singleResult.output;
	state.results.push({
		agent: singleResult.agent,
		output: singleResult.output,
		error: singleResult.error,
		success: singleResult.exitCode === 0,
		exitCode: singleResult.exitCode,
		sessionFile: singleResult.sessionFile,
		intercomTarget: singleResult.intercomTarget,
		model: singleResult.model,
		fastMode: singleResult.fastMode,
		attemptedModels: singleResult.attemptedModels,
		modelAttempts: singleResult.modelAttempts,
		artifactPaths: singleResult.artifactPaths,
		structuredOutput: singleResult.structuredOutput,
		structuredOutputPath: singleResult.structuredOutputPath,
		structuredOutputSchemaPath: singleResult.structuredOutputSchemaPath,
	});
	if (seqStep.outputName) {
		outputs[seqStep.outputName] = outputEntryFromAsyncResult({ agent: singleResult.agent, output: singleResult.output, structuredOutput: singleResult.structuredOutput }, stepIndex);
	}
	statusPayload.outputs = outputs;

	const cumulativeTokens = config.sessionDir ? parseSessionTokens(config.sessionDir) : null;
	let stepTokens = cumulativeTokens
		? {
			input: cumulativeTokens.input - state.previousCumulativeTokens.input,
			output: cumulativeTokens.output - state.previousCumulativeTokens.output,
			total: cumulativeTokens.total - state.previousCumulativeTokens.total,
		}
		: null;
	if (cumulativeTokens) {
		state.previousCumulativeTokens = cumulativeTokens;
	} else {
		stepTokens = tokenUsageFromAttempts(singleResult.modelAttempts);
		if (stepTokens) {
			state.previousCumulativeTokens = {
				input: state.previousCumulativeTokens.input + stepTokens.input,
				output: state.previousCumulativeTokens.output + stepTokens.output,
				total: state.previousCumulativeTokens.total + stepTokens.total,
			};
		}
	}

	const stepEndTime = Date.now();
	statusPayload.steps[flatIndex].status = singleResult.exitCode === 0 ? "complete" : "failed";
	statusPayload.steps[flatIndex].endedAt = stepEndTime;
	statusPayload.steps[flatIndex].durationMs = stepEndTime - stepStartTime;
	statusPayload.steps[flatIndex].exitCode = singleResult.exitCode;
	statusPayload.steps[flatIndex].model = singleResult.model;
	statusPayload.steps[flatIndex].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[flatIndex].thinking);
	statusPayload.steps[flatIndex].fastMode = singleResult.fastMode ? true : undefined;
	statusPayload.steps[flatIndex].attemptedModels = singleResult.attemptedModels;
	statusPayload.steps[flatIndex].modelAttempts = singleResult.modelAttempts;
	statusPayload.steps[flatIndex].error = singleResult.error;
	statusPayload.steps[flatIndex].structuredOutput = singleResult.structuredOutput;
	statusPayload.steps[flatIndex].structuredOutputPath = singleResult.structuredOutputPath;
	statusPayload.steps[flatIndex].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
	if (stepTokens) {
		statusPayload.steps[flatIndex].tokens = stepTokens;
		statusPayload.totalTokens = { ...state.previousCumulativeTokens };
	}
	statusPayload.lastUpdate = stepEndTime;
	writeStatusPayload(state);

	appendJsonl(state.eventsPath, JSON.stringify({
		type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed",
		ts: stepEndTime,
		runId: id,
		stepIndex: flatIndex,
		agent: seqStep.agent,
		exitCode: singleResult.exitCode,
		durationMs: stepEndTime - stepStartTime,
		tokens: stepTokens,
	}));
	state.flatIndex++;
	return singleResult.exitCode === 0;
}
