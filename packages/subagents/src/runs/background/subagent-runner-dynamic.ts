import * as path from "node:path";
import { appendJsonl } from "../../shared/artifacts.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.ts";
import { aggregateParallelOutputs, mapConcurrent, MAX_PARALLEL_CONCURRENCY } from "../shared/parallel-utils.ts";
import { collectDynamicResults, DynamicFanoutError, materializeDynamicParallelStep, validateDynamicCollection } from "../shared/dynamic-fanout.ts";
import { runSingleStep } from "./subagent-runner-step.ts";
import type { RunnerExecutionState, RunnerStatusStep, RunnerStep, SubagentStep } from "./subagent-runner-types.ts";
import type { SupervisorAuthorization } from "../../intercom/supervisor-authorization.ts";
import { createMutatingFailureState } from "../shared/long-running-guard.ts";
import { markDynamicGraphGroup, resetStepLiveDetail, updateStepFromChildEvent, updateStepModel, writeStatusPayload } from "./subagent-runner-state.ts";

export async function runDynamicGroup(state: RunnerExecutionState, step: RunnerStep, stepIndex: number): Promise<boolean> {
	const { outputs, statusPayload, asyncDir, id, cwd, placeholder, sessionEnabled, config, artifactsDir, artifactConfig } = state;
	const groupStartFlatIndex = state.flatIndex;
	let materialized: ReturnType<typeof materializeDynamicParallelStep>;
	try {
		materialized = materializeDynamicParallelStep(step as Parameters<typeof materializeDynamicParallelStep>[0], outputs, stepIndex, { maxItems: config.dynamicFanoutMaxItems, allowRunnerFields: true });
		if (materialized.collectedOnEmpty) validateDynamicCollection((step as Parameters<typeof materializeDynamicParallelStep>[0]).collect.outputSchema, materialized.collectedOnEmpty);
	} catch (error) {
		const now = Date.now();
		const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
		statusPayload.state = "failed";
		statusPayload.error = message;
		statusPayload.currentStep = state.flatIndex;
		const placeholderStep = statusPayload.steps[groupStartFlatIndex];
		if (placeholderStep) {
			placeholderStep.status = "failed";
			placeholderStep.error = message;
			placeholderStep.startedAt = now;
			placeholderStep.endedAt = now;
			placeholderStep.durationMs = 0;
			placeholderStep.exitCode = 1;
		}
		statusPayload.lastUpdate = now;
		markDynamicGraphGroup(state, stepIndex, "failed", message);
		writeStatusPayload(state);
		const dynamicStep = step as Parameters<typeof materializeDynamicParallelStep>[0];
		state.results.push({ agent: dynamicStep.parallel.agent, output: message, error: message, success: false, exitCode: 1 });
		return false;
	}

	const dynamicStep = step as Parameters<typeof materializeDynamicParallelStep>[0];
	const parallelTemplate = dynamicStep.parallel as unknown as SubagentStep;
	if (materialized.parallel.length === 0) {
		const now = Date.now();
		const collection = materialized.collectedOnEmpty ?? [];
		outputs[dynamicStep.collect.as] = { text: JSON.stringify(collection), structured: collection, agent: dynamicStep.parallel.agent, stepIndex };
		statusPayload.outputs = outputs;
		const placeholderStep = statusPayload.steps[groupStartFlatIndex];
		if (placeholderStep) {
			placeholderStep.status = "complete";
			placeholderStep.startedAt = now;
			placeholderStep.endedAt = now;
			placeholderStep.durationMs = 0;
		}
		state.previousOutput = "Dynamic fanout produced 0 results.";
		state.flatIndex++;
		statusPayload.lastUpdate = now;
		markDynamicGraphGroup(state, stepIndex, "completed");
		writeStatusPayload(state);
		return true;
	}

	const dynamicSteps: SubagentStep[] = materialized.parallel.map((task) => ({
		...parallelTemplate,
		task: task.task ?? parallelTemplate.task,
		label: task.label ?? parallelTemplate.label,
		structuredOutput: undefined,
		structuredOutputSchema: parallelTemplate.structuredOutputSchema ?? parallelTemplate.structuredOutput?.schema,
	}));
	const dynamicStatusSteps: RunnerStatusStep[] = dynamicSteps.map((task) => ({
		agent: task.agent,
		phase: task.phase ?? dynamicStep.phase,
		label: task.label,
		outputName: undefined,
		structured: Boolean(task.structuredOutputSchema),
		status: "pending",
		...(task.sessionFile ? { sessionFile: task.sessionFile } : {}),
		skills: task.skills,
		model: task.model,
		thinking: task.thinking,
		attemptedModels: task.modelCandidates && task.modelCandidates.length > 0 ? task.modelCandidates : task.model ? [task.model] : undefined,
		recentTools: [],
		recentOutput: [],
	}));
	statusPayload.steps.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps);
	if (config.childIntercomTargets) config.childIntercomTargets = statusPayload.steps.map((statusStep, index) => resolveSubagentIntercomTarget(id, statusStep.agent, index));
	const dynamicAuthorizations = config.dynamicSupervisorAuthorizations?.[stepIndex];
	if (dynamicAuthorizations) {
		const authorizations = config.supervisorAuthorizations
			?? new Array<SupervisorAuthorization | undefined>(statusPayload.steps.length - dynamicStatusSteps.length + 1).fill(undefined);
		authorizations.splice(
			groupStartFlatIndex,
			1,
			...dynamicSteps.map((_, index) => dynamicAuthorizations[index]),
		);
		config.supervisorAuthorizations = authorizations;
	}
	state.mutatingFailureStates.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => createMutatingFailureState()));
	state.pendingToolResults.splice(groupStartFlatIndex, 1, ...dynamicStatusSteps.map(() => undefined));
	const materializedDelta = dynamicStatusSteps.length - 1;
	for (const group of statusPayload.parallelGroups) {
		if (group.stepIndex === stepIndex) {
			group.start = groupStartFlatIndex;
			group.count = dynamicStatusSteps.length;
		} else if (group.start > groupStartFlatIndex) {
			group.start += materializedDelta;
		}
	}
	if (statusPayload.workflowGraph) {
		const shiftFlatIndexes = (nodes: NonNullable<typeof statusPayload.workflowGraph>["nodes"]): void => {
			for (const node of nodes) {
				if (node.stepIndex !== undefined && node.stepIndex > stepIndex && node.flatIndex !== undefined && node.flatIndex >= groupStartFlatIndex) node.flatIndex += dynamicStatusSteps.length;
				if (node.children) shiftFlatIndexes(node.children);
			}
		};
		shiftFlatIndexes(statusPayload.workflowGraph.nodes);
		const groupNode = statusPayload.workflowGraph.nodes.find((node) => node.id === `step-${stepIndex}`);
		if (groupNode) {
			groupNode.children = materialized.items.map((item, itemIndex) => ({
				id: `step-${stepIndex}-item-${item.idKey}`,
				kind: "agent",
				agent: parallelTemplate.agent,
				phase: dynamicSteps[itemIndex]?.phase ?? dynamicStep.phase,
				label: dynamicSteps[itemIndex]?.label?.trim() || `${parallelTemplate.agent} ${item.key}`,
				status: "pending",
				flatIndex: groupStartFlatIndex + itemIndex,
				stepIndex,
				itemKey: item.key,
				structured: Boolean(dynamicSteps[itemIndex]?.structuredOutputSchema),
			}));
		}
	}
	writeStatusPayload(state);

	const concurrency = dynamicStep.concurrency ?? MAX_PARALLEL_CONCURRENCY;
	const failFast = dynamicStep.failFast ?? false;
	let aborted = false;
	const parallelResults = await mapConcurrent(dynamicSteps, concurrency, async (task, taskIdx) => {
		const fi = groupStartFlatIndex + taskIdx;
		if (aborted && failFast) {
			const skippedAt = Date.now();
			statusPayload.steps[fi].status = "failed";
			statusPayload.steps[fi].error = "Skipped due to fail-fast";
			statusPayload.steps[fi].startedAt = skippedAt;
			statusPayload.steps[fi].endedAt = skippedAt;
			statusPayload.steps[fi].durationMs = 0;
			statusPayload.steps[fi].exitCode = -1;
			statusPayload.lastUpdate = skippedAt;
			writeStatusPayload(state);
			return { agent: task.agent, output: "(skipped — fail-fast)", exitCode: -1 as number | null, skipped: true };
		}
		const taskStartTime = Date.now();
		statusPayload.currentStep = fi;
		statusPayload.steps[fi].status = "running";
		statusPayload.steps[fi].error = undefined;
		statusPayload.steps[fi].activityState = undefined;
		resetStepLiveDetail(statusPayload.steps[fi]);
		statusPayload.steps[fi].startedAt = taskStartTime;
		statusPayload.steps[fi].lastActivityAt = taskStartTime;
		statusPayload.outputFile = path.join(asyncDir, `output-${fi}.log`);
		statusPayload.lastActivityAt = taskStartTime;
		statusPayload.lastUpdate = taskStartTime;
		writeStatusPayload(state);
		appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.step.started", ts: taskStartTime, runId: id, stepIndex: fi, agent: task.agent }));
		const singleResult = await runSingleStep(task, {
			previousOutput: state.previousOutput, placeholder, cwd, sessionEnabled, outputs,
			sessionDir: config.sessionDir ? path.join(config.sessionDir, `dynamic-${stepIndex}-${taskIdx}`) : undefined,
			artifactsDir, artifactConfig, id,
			flatIndex: fi, flatStepCount: Math.max(statusPayload.steps.length, 1),
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
			onAttemptStart: (attempt) => updateStepModel(state, fi, attempt.model, attempt.thinking),
			onChildEvent: (event) => updateStepFromChildEvent(state, fi, event),
		});
		const taskEndTime = Date.now();
		statusPayload.steps[fi].status = singleResult.exitCode === 0 ? "complete" : "failed";
		statusPayload.steps[fi].endedAt = taskEndTime;
		statusPayload.steps[fi].durationMs = taskEndTime - taskStartTime;
		statusPayload.steps[fi].exitCode = singleResult.exitCode;
		statusPayload.steps[fi].model = singleResult.model;
		statusPayload.steps[fi].thinking = resolveEffectiveThinking(singleResult.model, statusPayload.steps[fi].thinking);
		statusPayload.steps[fi].attemptedModels = singleResult.attemptedModels;
		statusPayload.steps[fi].modelAttempts = singleResult.modelAttempts;
		statusPayload.steps[fi].error = singleResult.error;
		statusPayload.steps[fi].structuredOutput = singleResult.structuredOutput;
		statusPayload.steps[fi].structuredOutputPath = singleResult.structuredOutputPath;
		statusPayload.steps[fi].structuredOutputSchemaPath = singleResult.structuredOutputSchemaPath;
		statusPayload.lastUpdate = taskEndTime;
		writeStatusPayload(state);
		appendJsonl(state.eventsPath, JSON.stringify({ type: singleResult.exitCode === 0 ? "subagent.step.completed" : "subagent.step.failed", ts: taskEndTime, runId: id, stepIndex: fi, agent: task.agent, exitCode: singleResult.exitCode, durationMs: taskEndTime - taskStartTime }));
		if (singleResult.exitCode !== 0 && failFast) aborted = true;
		return { ...singleResult, skipped: false };
	});

	state.flatIndex += dynamicSteps.length;
	for (const pr of parallelResults) state.results.push({ agent: pr.agent, output: pr.output, error: pr.error, success: pr.exitCode === 0, exitCode: pr.exitCode, skipped: pr.skipped, sessionFile: pr.sessionFile, intercomTarget: pr.intercomTarget, model: pr.model, attemptedModels: pr.attemptedModels, modelAttempts: pr.modelAttempts, artifactPaths: pr.artifactPaths, structuredOutput: pr.structuredOutput, structuredOutputPath: pr.structuredOutputPath, structuredOutputSchemaPath: pr.structuredOutputSchemaPath });
	const collection = collectDynamicResults(dynamicStep as Parameters<typeof collectDynamicResults>[0], materialized.items, parallelResults as Parameters<typeof collectDynamicResults>[2]);
	const failures = parallelResults.filter((result) => result.exitCode !== 0 && result.exitCode !== -1);
	if (failures.length === 0) {
		try {
			validateDynamicCollection(dynamicStep.collect.outputSchema, collection);
			outputs[dynamicStep.collect.as] = { text: JSON.stringify(collection), structured: collection, agent: parallelTemplate.agent, stepIndex };
			statusPayload.outputs = outputs;
			markDynamicGraphGroup(state, stepIndex, "completed");
		} catch (error) {
			const message = error instanceof DynamicFanoutError ? error.message : error instanceof Error ? error.message : String(error);
			state.results.push({ agent: parallelTemplate.agent, output: message, error: message, success: false, exitCode: 1, structuredOutput: collection });
			statusPayload.error = message;
			markDynamicGraphGroup(state, stepIndex, "failed", message);
		}
	}
	state.previousOutput = aggregateParallelOutputs(parallelResults.map((r, i) => ({ agent: r.agent, taskIndex: i, output: r.output, exitCode: r.exitCode, error: r.error })), (i, agent) => `=== Dynamic Item ${i + 1} (${agent}, key ${materialized.items[i]?.key ?? i}) ===`);
	appendJsonl(state.eventsPath, JSON.stringify({ type: "subagent.dynamic.completed", ts: Date.now(), runId: id, stepIndex, success: failures.length === 0 }));
	if (failures.length > 0) markDynamicGraphGroup(state, stepIndex, "failed", failures[0]?.error ?? "Dynamic fanout child failed.");
	statusPayload.lastUpdate = Date.now();
	writeStatusPayload(state);
	return !(failures.length > 0 || statusPayload.error);
}
