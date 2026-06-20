import * as fs from "node:fs";
import * as path from "node:path";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import {
	buildChainInstructions,
	removeChainDir,
	resolveStepBehavior,
	suppressProgressForReadOnlyTask,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { getSingleResultOutput, resolveChildCwd } from "../../shared/utils.ts";
import { normalizeSkillInput } from "../../agents/skills.ts";
import { resolveChildMaxSubagentDepth } from "../../shared/types.ts";
import { outputEntryFromResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import { currentModelFullId, resolveModelCandidate } from "../shared/model-fallback.ts";
import { recordRun } from "../shared/run-history.ts";
import { validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { buildChainExecutionDetails, buildChainExecutionErrorResult } from "./chain-execution-details.ts";
import type { BehaviorOverride } from "./chain-clarify.ts";
import type { ChainExecutionMutableState, ChainExecutionResult, ChainRuntimeContext } from "./chain-execution-types.ts";

export async function runSequentialChainStep(input: {
	context: ChainRuntimeContext;
	state: ChainExecutionMutableState;
	seqStep: SequentialStep;
	stepIndex: number;
	stepTemplate: string;
	tuiOverride?: BehaviorOverride;
}): Promise<ChainExecutionResult | undefined> {
	const { context, state, seqStep, stepIndex, stepTemplate, tuiOverride } = input;
	const agentConfig = context.agents.find((agent) => agent.name === seqStep.agent);
	if (!agentConfig) {
		removeChainDir(context.chainDir);
		return {
			content: [{ type: "text", text: `Unknown agent: ${seqStep.agent}` }],
			isError: true,
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex })),
		};
	}

	const stepOverride: StepOverrides = {
		output: tuiOverride?.output !== undefined ? tuiOverride.output : seqStep.output,
		outputMode: seqStep.outputMode,
		reads: tuiOverride?.reads !== undefined ? tuiOverride.reads : seqStep.reads,
		progress: tuiOverride?.progress !== undefined ? tuiOverride.progress : seqStep.progress,
		skills: tuiOverride?.skills !== undefined ? tuiOverride.skills : normalizeSkillInput(seqStep.skill),
	};
	const behavior = suppressProgressForReadOnlyTask(
		resolveStepBehavior(agentConfig, stepOverride, context.chainSkills),
		stepTemplate,
		context.originalTask,
	);
	const isFirstProgress = behavior.progress && !state.progressCreated;
	if (isFirstProgress) state.progressCreated = true;

	const templateHasPrevious = stepTemplate.includes("{previous}");
	const { prefix, suffix } = buildChainInstructions(
		behavior,
		context.chainDir,
		isFirstProgress,
		templateHasPrevious ? undefined : state.prev,
	);

	let stepTask = resolveOutputReferences(stepTemplate, state.outputs);
	stepTask = stepTask.replace(/\{task\}/g, context.originalTask);
	stepTask = stepTask.replace(/\{previous\}/g, state.prev);
	stepTask = stepTask.replace(/\{chain_dir\}/g, context.chainDir);
	const cleanTask = stepTask;
	stepTask = prefix + stepTask + suffix;

	const effectiveModel =
		tuiOverride?.model
		?? (seqStep.model ? resolveModelCandidate(seqStep.model, context.availableModels, context.ctx.model?.provider) : null)
		?? resolveModelCandidate(agentConfig.model, context.availableModels, context.ctx.model?.provider);
	const outputPath = typeof behavior.output === "string"
		? (path.isAbsolute(behavior.output) ? behavior.output : path.join(context.chainDir, behavior.output))
		: undefined;
	const validationError = validateFileOnlyOutputMode(behavior.outputMode, outputPath, `Chain step ${stepIndex + 1} (${seqStep.agent})`);
	if (validationError) return buildChainExecutionErrorResult(validationError, context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex }));

	const maxSubagentDepth = resolveChildMaxSubagentDepth(context.params.maxSubagentDepth, agentConfig.maxSubagentDepth);
	const interruptController = new AbortController();
	if (context.foregroundControl) {
		context.foregroundControl.currentAgent = seqStep.agent;
		context.foregroundControl.currentIndex = state.globalTaskIndex;
		context.foregroundControl.currentActivityState = undefined;
		context.foregroundControl.updatedAt = Date.now();
		context.foregroundControl.interrupt = () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			context.foregroundControl!.currentActivityState = undefined;
			context.foregroundControl!.updatedAt = Date.now();
			return true;
		};
	}

	const flatIndex = state.globalTaskIndex;
	const structuredRuntime = seqStep.outputSchema
		? createStructuredOutputRuntime(seqStep.outputSchema, path.join(context.chainDir, "structured-output"))
		: undefined;
	const result = await context.executeRunSync(context.ctx.cwd, context.agents, seqStep.agent, stepTask, {
		cwd: resolveChildCwd(context.cwd ?? context.ctx.cwd, seqStep.cwd),
		signal: context.signal,
		interruptSignal: interruptController.signal,
		allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
		intercomEvents: context.intercomEvents,
		runId: context.runId,
		index: flatIndex,
		sessionDir: context.sessionDirForIndex(flatIndex),
		sessionFile: context.sessionFileForIndex?.(flatIndex),
		share: context.shareEnabled,
		artifactsDir: context.artifactConfig.enabled ? context.artifactsDir : undefined,
		artifactConfig: context.artifactConfig,
		outputPath,
		outputMode: behavior.outputMode,
		maxSubagentDepth,
		workflowStageSubagentGuard: context.params.workflowStageSubagentGuard,
		controlConfig: context.controlConfig,
		onControlEvent: context.onControlEvent,
		intercomSessionName: context.childIntercomTarget?.(seqStep.agent, flatIndex),
		orchestratorIntercomTarget: context.orchestratorIntercomTarget,
		nestedRoute: context.params.nestedRoute,
		modelOverride: effectiveModel,
		availableModels: context.availableModels,
		currentModel: currentModelFullId(context.ctx.model),
		preferredModelProvider: context.ctx.model?.provider,
		skills: behavior.skills === false ? [] : behavior.skills,
		structuredOutput: structuredRuntime,
		onUpdate: context.onUpdate ? (update) => {
			const stepResults = update.details?.results || [];
			const stepProgress = update.details?.progress || [];
			if (context.foregroundControl && stepProgress.length > 0) {
				const current = stepProgress[0];
				context.foregroundControl.currentAgent = seqStep.agent;
				context.foregroundControl.currentIndex = flatIndex;
				context.foregroundControl.currentActivityState = current?.activityState;
				context.foregroundControl.lastActivityAt = current?.lastActivityAt;
				context.foregroundControl.currentTool = current?.currentTool;
				context.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
				context.foregroundControl.currentPath = current?.currentPath;
				context.foregroundControl.turnCount = current?.turnCount;
				context.foregroundControl.tokens = current?.tokens;
				context.foregroundControl.toolCount = current?.toolCount;
				context.foregroundControl.updatedAt = Date.now();
			}
			context.onUpdate?.({
				...update,
				details: {
					mode: "chain",
					results: state.results.concat(stepResults),
					progress: state.allProgress.concat(stepProgress),
					controlEvents: update.details?.controlEvents,
					chainAgents: context.chainAgents,
					totalSteps: context.totalSteps,
					currentStepIndex: stepIndex,
					outputs: state.outputs,
					workflowGraph: buildWorkflowGraphSnapshot({
						runId: context.runId,
						mode: "chain",
						steps: context.chainSteps,
						results: state.results.concat(stepResults),
						currentStepIndex: stepIndex,
						currentFlatIndex: flatIndex,
						dynamicChildren: state.dynamicChildren,
						dynamicGroupStatuses: state.dynamicGroupStatuses,
					}),
				},
			});
		} : undefined,
	});
	if (context.foregroundControl?.currentIndex === flatIndex) {
		context.foregroundControl.interrupt = undefined;
		context.foregroundControl.updatedAt = Date.now();
	}
	recordRun(seqStep.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);

	state.globalTaskIndex++;
	state.results.push(result);
	if (result.progress) state.allProgress.push(result.progress);
	if (result.artifactPaths) state.allArtifactPaths.push(result.artifactPaths);

	if (result.interrupted) {
		return {
			content: [{ type: "text", text: `Chain paused after interrupt at step ${stepIndex + 1} (${result.agent}). Waiting for explicit next action.` }],
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex - 1 })),
		};
	}
	if (result.detached) {
		return {
			content: [{ type: "text", text: `Chain detached for intercom coordination at step ${stepIndex + 1} (${result.agent}). Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex - 1 })),
		};
	}
	if (result.exitCode !== 0) {
		const summary = buildChainSummary(context.chainSteps, state.results, context.chainDir, "failed", {
			index: stepIndex,
			error: result.error || "Chain failed",
		});
		return {
			content: [{ type: "text", text: summary }],
			details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: stepIndex, currentFlatIndex: state.globalTaskIndex - 1 })),
			isError: true,
		};
	}

	if (behavior.output) {
		try {
			const expectedPath = path.isAbsolute(behavior.output) ? behavior.output : path.join(context.chainDir, behavior.output);
			if (!fs.existsSync(expectedPath)) {
				const dirFiles = fs.readdirSync(context.chainDir);
				const mdFiles = dirFiles.filter((file) => file.endsWith(".md") && file !== "progress.md");
				const warning = mdFiles.length > 0
					? `Agent wrote to different file(s): ${mdFiles.join(", ")} instead of ${behavior.output}`
					: `Agent did not create expected output file: ${behavior.output}`;
				result.error = result.error ? `${result.error}\n${warning}` : warning;
			}
		} catch {
			// Ignore validation errors; this diagnostic should not mask successful chain output.
		}
	}

	if (seqStep.as) state.outputs[seqStep.as] = outputEntryFromResult(result, stepIndex);
	state.prev = getSingleResultOutput(result);
	return undefined;
}
