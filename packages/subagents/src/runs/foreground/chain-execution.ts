/**
 * Public foreground chain execution API.
 */

import { collectKnownModelProviders, toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import {
	createChainDir,
	isDynamicParallelStep,
	isParallelStep,
	resolveChainTemplates,
	type ResolvedTemplates,
	type SequentialStep,
} from "../../shared/settings.ts";
import { buildChainSummary } from "../../shared/formatters.ts";
import { ChainOutputValidationError, validateChainOutputBindings } from "../shared/chain-outputs.ts";
import { buildChainExecutionDetails } from "./chain-execution-details.ts";
import { runDynamicParallelChainStep } from "./chain-execution-dynamic-step.ts";
import { runStaticParallelChainStep } from "./chain-execution-parallel-step.ts";
import { runSequentialChainStep } from "./chain-execution-sequential-step.ts";
import type {
	ChainExecutionDetailsInput,
	ChainExecutionMutableState,
	ChainExecutionParams,
	ChainExecutionResult,
	ChainRuntimeContext,
} from "./chain-execution-types.ts";
import { runSync } from "./execution.ts";

/**
 * Execute a chain of subagent steps.
 */
export async function executeChain(params: ChainExecutionParams): Promise<ChainExecutionResult> {
	const executeRunSync = params.runSync ?? runSync;
	const {
		chain: chainSteps,
		agents,
		ctx,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		intercomEvents,
		chainSkills: chainSkillsParam,
		chainDir: chainDirBase,
	} = params;
	const chainSkills = chainSkillsParam ?? [];
	const state: ChainExecutionMutableState = {
		results: [],
		outputs: {},
		dynamicChildren: {},
		dynamicGroupStatuses: {},
		allProgress: [],
		allArtifactPaths: [],
		prev: "",
		globalTaskIndex: 0,
		progressCreated: false,
	};
	const chainAgents = chainSteps.map((step) =>
		isParallelStep(step)
			? `[${step.parallel.map((task) => task.agent).join("+")}]`
			: isDynamicParallelStep(step)
				? `expand:${step.parallel.agent}`
				: (step as SequentialStep).agent,
	);
	const totalSteps = chainSteps.length;
	const makeDetailsInput = (overrides: Pick<Partial<ChainExecutionDetailsInput>, "currentStepIndex" | "currentFlatIndex"> = {}): ChainExecutionDetailsInput => ({
		results: state.results,
		...(includeProgress !== undefined ? { includeProgress } : {}),
		allProgress: state.allProgress,
		allArtifactPaths: state.allArtifactPaths,
		artifactsDir,
		chainAgents,
		chainSteps,
		totalSteps,
		runId,
		outputs: state.outputs,
		dynamicChildren: state.dynamicChildren,
		dynamicGroupStatuses: state.dynamicGroupStatuses,
		...overrides,
	});

	const firstStep = chainSteps[0]!;
	const originalTask = params.task
		?? (isParallelStep(firstStep)
			? firstStep.parallel[0]!.task!
			: isDynamicParallelStep(firstStep)
				? firstStep.parallel.task!
				: (firstStep as SequentialStep).task!);
	try {
		validateChainOutputBindings(chainSteps, { maxItems: params.dynamicFanoutMaxItems });
	} catch (error) {
		if (error instanceof ChainOutputValidationError) {
			return {
				content: [{ type: "text", text: error.message }],
				isError: true,
				details: buildChainExecutionDetails(makeDetailsInput()),
			};
		}
		throw error;
	}

	const chainDir = createChainDir(runId, chainDirBase);
	const templates: ResolvedTemplates = resolveChainTemplates(chainSteps);
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const knownModelProviders = collectKnownModelProviders(ctx.modelRegistry);
	const context: ChainRuntimeContext = {
		params,
		agents,
		ctx,
		intercomEvents,
		signal,
		runId,
		cwd,
		shareEnabled,
		sessionDirForIndex,
		sessionFileForIndex,
		artifactsDir,
		artifactConfig,
		includeProgress,
		onUpdate,
		onControlEvent,
		controlConfig,
		childIntercomTarget,
		orchestratorIntercomTarget,
		foregroundControl,
		chainSkills,
		chainDir,
		availableModels,
		knownModelProviders,
		originalTask,
		chainAgents,
		chainSteps,
		totalSteps,
		executeRunSync,
		makeDetailsInput,
	};

	for (let stepIndex = 0; stepIndex < chainSteps.length; stepIndex++) {
		const step = chainSteps[stepIndex]!;
		const stepTemplates = templates[stepIndex]!;
		let earlyResult: ChainExecutionResult | undefined;
		if (isParallelStep(step)) {
			earlyResult = await runStaticParallelChainStep({
				context,
				state,
				step,
				stepIndex,
				parallelTemplates: stepTemplates as string[],
			});
		} else if (isDynamicParallelStep(step)) {
			earlyResult = await runDynamicParallelChainStep({ context, state, step, stepIndex });
		} else {
			earlyResult = await runSequentialChainStep({
				context,
				state,
				seqStep: step as SequentialStep,
				stepIndex,
				stepTemplate: stepTemplates as string,
			});
		}
		if (earlyResult) return earlyResult;
	}

	const summary = buildChainSummary(chainSteps, state.results, chainDir, "completed");
	return {
		content: [{ type: "text", text: summary }],
		details: buildChainExecutionDetails(makeDetailsInput()),
	};
}
