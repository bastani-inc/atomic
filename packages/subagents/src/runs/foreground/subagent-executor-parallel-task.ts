import { currentModelFullId } from "../shared/model-fallback.ts";
import { buildChainInstructions, type ResolvedStepBehavior } from "../../shared/settings.ts";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "../shared/single-output.ts";
import { mapConcurrent } from "../../shared/utils.ts";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type { WorktreeSetup } from "../shared/worktree.ts";
import {
	type AgentProgress,
	type ArtifactConfig,
	type ControlEvent,
	type IntercomEventBus,
	type MaxOutputConfig,
	type SingleResult,
	type SubagentState,
	type SubagentToolResult,
} from "../../shared/types.ts";
import type { ExtensionContext } from "@bastani/atomic";
import type { SubagentExecutorRuntimeDeps, TaskParam } from "./subagent-executor-types.ts";
import { resolveParallelTaskCwd } from "./subagent-executor-worktree.ts";

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	ctx: ExtensionContext;
	intercomEvents: IntercomEventBus;
	signal: AbortSignal;
	runId: string;
	sessionDirForIndex: (idx?: number) => string | undefined;
	sessionFileForIndex: (idx?: number) => string | undefined;
	shareEnabled: boolean;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	maxOutput?: MaxOutputConfig;
	paramsCwd: string;
	maxSubagentDepths: number[];
	workflowStageSubagentGuard?: boolean;
	availableModels: ModelInfo[];
	modelOverrides: (string | undefined)[];
	behaviors: ResolvedStepBehavior[];
	firstProgressIndex: number;
	controlConfig: import("../../shared/types.ts").ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: SubagentToolResult) => void;
	worktreeSetup?: WorktreeSetup;
	runtime: Pick<SubagentExecutorRuntimeDeps, "runSync">;
}

export async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const readInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildChainInstructions({ ...behavior, output: false, reads: false }, input.paramsCwd, index === input.firstProgressIndex)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			outputPath,
		);
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			input.foregroundControl.currentAgent = task.agent;
			input.foregroundControl.currentIndex = index;
			input.foregroundControl.currentActivityState = undefined;
			input.foregroundControl.updatedAt = Date.now();
			input.foregroundControl.interrupt = () => {
				if (interruptController.signal.aborted) return false;
				interruptController.abort();
				input.foregroundControl!.currentActivityState = undefined;
				input.foregroundControl!.updatedAt = Date.now();
				return true;
			};
		}
		const agentConfig = input.agents.find((agent) => agent.name === task.agent);
		return input.runtime.runSync(input.ctx.cwd, input.agents, task.agent, taskText, {
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index,
			sessionDir: input.sessionDirForIndex(index),
			sessionFile: input.sessionFileForIndex(index),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			maxOutput: input.maxOutput,
			outputPath,
			outputMode: behavior?.outputMode,
			maxSubagentDepth: input.maxSubagentDepths[index],
			workflowStageSubagentGuard: input.workflowStageSubagentGuard,
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			intercomSessionName: input.childIntercomTarget?.(task.agent, index),
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			nestedRoute: input.foregroundControl?.nestedRoute,
			modelOverride: input.modelOverrides[index],
			availableModels: input.availableModels,
			preferredModelProvider: input.ctx.model?.provider,
			currentModel: currentModelFullId(input.ctx.model),
			skills: effectiveSkills === false ? [] : effectiveSkills,
			onUpdate: input.onUpdate
				? (progressUpdate) => {
					const stepResults = progressUpdate.details?.results || [];
					const stepProgress = progressUpdate.details?.progress || [];
					if (input.foregroundControl && stepProgress.length > 0) {
						const current = stepProgress[0];
						input.foregroundControl.currentAgent = task.agent;
						input.foregroundControl.currentIndex = index;
						input.foregroundControl.currentActivityState = current?.activityState;
						input.foregroundControl.lastActivityAt = current?.lastActivityAt;
						input.foregroundControl.currentTool = current?.currentTool;
						input.foregroundControl.currentToolStartedAt = current?.currentToolStartedAt;
						input.foregroundControl.currentPath = current?.currentPath;
						input.foregroundControl.turnCount = current?.turnCount;
						input.foregroundControl.tokens = current?.tokens;
						input.foregroundControl.toolCount = current?.toolCount;
						input.foregroundControl.updatedAt = Date.now();
					}
					if (stepResults.length > 0) input.liveResults[index] = stepResults[0];
					if (stepProgress.length > 0) input.liveProgress[index] = stepProgress[0];
					const mergedResults = input.liveResults.filter((result): result is SingleResult => result !== undefined);
					const mergedProgress = input.liveProgress.filter((progress): progress is AgentProgress => progress !== undefined);
					input.onUpdate?.({
						content: progressUpdate.content,
						details: {
							mode: "parallel",
							results: mergedResults,
							progress: mergedProgress,
							controlEvents: progressUpdate.details?.controlEvents,
							totalSteps: input.tasks.length,
						},
					});
				}
				: undefined,
		}).finally(() => {
			if (input.foregroundControl?.currentIndex === index) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}
		});
	});
}
