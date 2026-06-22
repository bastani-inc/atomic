import type { AgentConfig } from "../../agents/agents.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import {
	isParallelStep,
	removeChainDir,
	resolveStepBehavior,
	type ChainStep,
	type ResolvedTemplates,
	type SequentialStep,
	type StepOverrides,
} from "../../shared/settings.ts";
import { buildChainExecutionDetails } from "./chain-execution-details.ts";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import type { ChainClarificationOutcome, ChainRuntimeContext } from "./chain-execution-types.ts";

export async function resolveChainClarification(input: {
	context: ChainRuntimeContext;
	templates: ResolvedTemplates;
	shouldClarify: boolean;
}): Promise<ChainClarificationOutcome> {
	const { context } = input;
	if (!input.shouldClarify) return { templates: input.templates };

	const availableSkills = discoverAvailableSkills(context.cwd ?? context.ctx.cwd);
	const seqSteps = context.chainSteps as SequentialStep[];
	const agentConfigs: AgentConfig[] = [];
	for (const step of seqSteps) {
		const config = context.agents.find((agent) => agent.name === step.agent);
		if (!config) {
			removeChainDir(context.chainDir);
			return {
				result: {
					content: [{ type: "text", text: `Unknown agent: ${step.agent}` }],
					isError: true,
					details: buildChainExecutionDetails(context.makeDetailsInput({ currentStepIndex: seqSteps.indexOf(step) })),
				},
				templates: input.templates,
			};
		}
		agentConfigs.push(config);
	}

	const stepOverrides: StepOverrides[] = seqSteps.map((step) => ({
		output: step.output,
		outputMode: step.outputMode,
		reads: step.reads,
		progress: step.progress,
		skills: normalizeSkillInput(step.skill),
		model: step.model,
	}));
	const resolvedBehaviors = agentConfigs.map((config, index) =>
		resolveStepBehavior(config, stepOverrides[index]!, context.chainSkills),
	);
	const flatTemplates = input.templates as string[];
	const result = await context.ctx.ui.custom<ChainClarifyResult>(
		(tui, theme, _kb, done) =>
			new ChainClarifyComponent(
				tui,
				theme,
				agentConfigs,
				flatTemplates,
				context.originalTask,
				context.chainDir,
				resolvedBehaviors,
				context.availableModels,
				context.ctx.model?.provider,
				availableSkills,
				done,
			),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" },
		},
	);

	if (!result || !result.confirmed) {
		removeChainDir(context.chainDir);
		return {
			result: {
				content: [{ type: "text", text: "Chain cancelled" }],
				details: buildChainExecutionDetails(context.makeDetailsInput()),
			},
			templates: input.templates,
		};
	}

	if (result.runInBackground) {
		removeChainDir(context.chainDir);
		const updatedChain: ChainStep[] = context.chainSteps.map((step, index) => {
			if (isParallelStep(step)) return step;
			const override = result.behaviorOverrides[index];
			return {
				...step,
				task: result.templates[index]!,
				...(override?.model ? { model: override.model } : {}),
				...(override?.output !== undefined ? { output: override.output } : {}),
				...("outputMode" in step && step.outputMode !== undefined ? { outputMode: step.outputMode } : {}),
				...(override?.reads !== undefined ? { reads: override.reads } : {}),
				...(override?.progress !== undefined ? { progress: override.progress } : {}),
				...(override?.skills !== undefined ? { skill: override.skills } : {}),
			};
		});
		return {
			result: {
				content: [{ type: "text", text: "Launching in background..." }],
				details: buildChainExecutionDetails(context.makeDetailsInput()),
				requestedAsync: { chain: updatedChain, chainSkills: context.chainSkills },
			},
			templates: input.templates,
		};
	}

	return {
		templates: result.templates,
		tuiBehaviorOverrides: result.behaviorOverrides,
	};
}
