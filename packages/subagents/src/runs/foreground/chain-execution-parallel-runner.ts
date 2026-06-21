import * as path from "node:path";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.ts";
import { mapConcurrent, resolveChildCwd } from "../../shared/utils.ts";
import { MAX_CONCURRENCY, resolveChildMaxSubagentDepth, type SingleResult } from "../../shared/types.ts";
import {
	buildChainInstructions,
	suppressProgressForReadOnlyTask,
	writeInitialProgressFile,
	type ResolvedStepBehavior,
} from "../../shared/settings.ts";
import { recordRun } from "../shared/run-history.ts";
import { currentModelFullId, resolveModelCandidate } from "../shared/model-fallback.ts";
import { buildWorkflowGraphSnapshot } from "../shared/workflow-graph.ts";
import { diffWorktrees, formatWorktreeDiffSummary, type WorktreeSetup } from "../shared/worktree.ts";
import { resolveOutputReferences } from "../shared/chain-outputs.ts";
import { createStructuredOutputRuntime } from "../shared/structured-output.ts";
import type { ParallelChainRunInput } from "./chain-execution-types.ts";

export function ensureParallelProgressFile(
	chainDir: string,
	progressCreated: boolean,
	parallelBehaviors: ResolvedStepBehavior[],
): boolean {
	if (progressCreated || !parallelBehaviors.some((behavior) => behavior.progress)) return progressCreated;
	writeInitialProgressFile(chainDir);
	return true;
}

export function appendParallelWorktreeSummary(
	output: string,
	worktreeSetup: WorktreeSetup | undefined,
	diffsDir: string,
	agents: string[],
): string {
	if (!worktreeSetup) return output;
	const diffs = diffWorktrees(worktreeSetup, agents, diffsDir);
	const diffSummary = formatWorktreeDiffSummary(diffs);
	return diffSummary ? `${output}\n\n${diffSummary}` : output;
}

export async function runParallelChainTasks(input: ParallelChainRunInput): Promise<SingleResult[]> {
	const concurrency = input.step.concurrency ?? MAX_CONCURRENCY;
	const failFast = input.step.failFast ?? false;
	let aborted = false;

	return mapConcurrent(input.step.parallel, concurrency, async (task, taskIndex) => {
		if (aborted && failFast) {
			return {
				agent: task.agent,
				task: "(skipped)",
				exitCode: -1,
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				error: "Skipped due to fail-fast",
			} as SingleResult;
		}

		const taskTemplate = input.parallelTemplates[taskIndex] ?? "{previous}";
		const behavior = suppressProgressForReadOnlyTask(input.parallelBehaviors[taskIndex]!, taskTemplate, input.originalTask);
		const templateHasPrevious = taskTemplate.includes("{previous}");
		const { prefix, suffix } = buildChainInstructions(
			behavior,
			input.chainDir,
			false,
			templateHasPrevious ? undefined : input.prev,
		);

		let taskStr = resolveOutputReferences(taskTemplate, input.outputs);
		taskStr = taskStr.replace(/\{task\}/g, input.originalTask);
		taskStr = taskStr.replace(/\{previous\}/g, input.prev);
		taskStr = taskStr.replace(/\{chain_dir\}/g, input.chainDir);
		const cleanTask = taskStr;
		taskStr = prefix + taskStr + suffix;

		const taskAgentConfig = input.agents.find((agent) => agent.name === task.agent);
		const effectiveModel =
			(task.model ? resolveModelCandidate(task.model, input.availableModels, input.ctx.model?.provider) : null)
			?? resolveModelCandidate(taskAgentConfig?.model, input.availableModels, input.ctx.model?.provider);
		const maxSubagentDepth = resolveChildMaxSubagentDepth(input.maxSubagentDepth, taskAgentConfig?.maxSubagentDepth);
		const taskCwd = input.worktreeSetup
			? input.worktreeSetup.worktrees[taskIndex]!.agentCwd
			: resolveChildCwd(input.cwd ?? input.ctx.cwd, task.cwd);
		const outputPath = typeof behavior.output === "string"
			? (path.isAbsolute(behavior.output) ? behavior.output : path.join(input.chainDir, behavior.output))
			: undefined;
		const interruptController = new AbortController();
		if (input.foregroundControl) {
			input.foregroundControl.currentAgent = task.agent;
			input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
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

		const structuredRuntime = task.outputSchema
			? createStructuredOutputRuntime(task.outputSchema, path.join(input.chainDir, "structured-output"))
			: undefined;
		const result = await input.runSync(input.ctx.cwd, input.agents, task.agent, taskStr, {
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: taskAgentConfig?.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: input.intercomEvents,
			runId: input.runId,
			index: input.globalTaskIndex + taskIndex,
			sessionDir: input.sessionDirForIndex(input.globalTaskIndex + taskIndex),
			sessionFile: input.sessionFileForIndex?.(input.globalTaskIndex + taskIndex),
			share: input.shareEnabled,
			artifactsDir: input.artifactConfig.enabled ? input.artifactsDir : undefined,
			artifactConfig: input.artifactConfig,
			outputPath,
			outputMode: behavior.outputMode,
			maxSubagentDepth,
			workflowStageSubagentGuard: input.workflowStageSubagentGuard,
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			intercomSessionName: input.childIntercomTarget?.(task.agent, input.globalTaskIndex + taskIndex),
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			nestedRoute: input.nestedRoute,
			modelOverride: effectiveModel,
			availableModels: input.availableModels,
			currentModel: currentModelFullId(input.ctx.model),
			preferredModelProvider: input.ctx.model?.provider,
			skills: behavior.skills === false ? [] : behavior.skills,
			structuredOutput: structuredRuntime,
			onUpdate: input.onUpdate ? (progressUpdate) => {
				const stepResults = progressUpdate.details?.results || [];
				const stepProgress = progressUpdate.details?.progress || [];
				if (input.foregroundControl && stepProgress.length > 0) {
					const current = stepProgress[0];
					input.foregroundControl.currentAgent = task.agent;
					input.foregroundControl.currentIndex = input.globalTaskIndex + taskIndex;
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
				input.onUpdate?.({
					...progressUpdate,
					details: {
						mode: "chain",
						results: input.results.concat(stepResults),
						progress: input.allProgress.concat(stepProgress),
						controlEvents: progressUpdate.details?.controlEvents,
						chainAgents: input.chainAgents,
						totalSteps: input.totalSteps,
						currentStepIndex: input.stepIndex,
						outputs: input.outputs,
						workflowGraph: buildWorkflowGraphSnapshot({
							runId: input.runId,
							mode: "chain",
							steps: input.chainSteps,
							results: input.results.concat(stepResults),
							currentStepIndex: input.stepIndex,
							currentFlatIndex: input.globalTaskIndex + taskIndex,
							dynamicChildren: input.dynamicChildren,
							dynamicGroupStatuses: input.dynamicGroupStatuses,
						}),
					},
				});
			} : undefined,
		});
		if (input.foregroundControl?.currentIndex === input.globalTaskIndex + taskIndex) {
			input.foregroundControl.interrupt = undefined;
			input.foregroundControl.updatedAt = Date.now();
		}

		if (result.exitCode !== 0 && failFast) aborted = true;
		recordRun(task.agent, cleanTask, result.exitCode, result.progressSummary?.durationMs ?? 0);
		return result;
	});
}
