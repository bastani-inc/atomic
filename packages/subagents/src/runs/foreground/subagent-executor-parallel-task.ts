import type { ExtensionContext } from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agents.js";
import { INTERCOM_BRIDGE_MARKER } from "../../intercom/intercom-bridge.js";
import { requestSupervisorAuthorization } from "../../intercom/supervisor-authorization.js";
import type { ModelInfo } from "../../shared/model-info.js";
import type { CandidateModelResolver } from "../../shared/model-resolution.js";
import { buildTaskInstructions, type ResolvedStepBehavior } from "../../shared/settings.js";
import type {
	AgentProgress,
	ArtifactConfig,
	ControlEvent,
	ForegroundParentAskPause,
	IntercomEventBus,
	MaxOutputConfig,
	RunSyncOptions,
	SingleResult,
	SubagentState,
	SubagentToolResult,
} from "../../shared/types.js";
import { workflowSessionMetadataFromContext } from "../../shared/types-depth.js";
import { mapConcurrent } from "../../shared/utils.js";
import { inheritedIntercomGroup, resolveChildIntercomGroup } from "../shared/intercom-group.js";
import { currentModelFullId } from "../shared/model-fallback.js";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "../shared/single-output.js";
import type { WorktreeSetup } from "../shared/worktree.js";
import type { SubagentExecutorRuntimeDeps, TaskParam } from "./subagent-executor-types.js";
import { resolveParallelTaskCwd } from "./subagent-executor-worktree.js";

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	agentConfigs?: AgentConfig[];
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
	parentDepth?: number;
	workflowStageSubagentGuard?: boolean;
	availableModels: ModelInfo[];
	knownModelProviders: string[];
	resolveCandidateModel: CandidateModelResolver;
	modelOverrides: (string | undefined)[];
	behaviors: ResolvedStepBehavior[];
	firstProgressIndex: number;
	controlConfig: import("../../shared/types.js").ResolvedControlConfig;
	onControlEvent?: (event: ControlEvent) => void;
	childIntercomTarget?: (agent: string, index: number) => string | undefined;
	orchestratorIntercomTarget?: string;
	setIntercomGroup?: string | true;
	sharedAutoIntercomGroup?: string;
	foregroundControl?: SubagentState["foregroundControls"] extends Map<string, infer T> ? T : never;
	concurrencyLimit: number;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: SubagentToolResult) => void;
	onParentAskPause?: (pause: ForegroundParentAskPause) => void;
	onDetachedExit?: (index: number, result: SingleResult) => void;
	onExecution?: (index: number, runtimeCwd: string, options: RunSyncOptions) => void;
	worktreeSetup?: WorktreeSetup;
	runtime: Pick<SubagentExecutorRuntimeDeps, "runSync">;
}

function skippedParallelResult(task: TaskParam, taskText: string, error: string): SingleResult {
	return {
		agent: task.agent,
		task: taskText,
		status: "skipped",
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		error,
	};
}

export async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	const intercomDetachController = new AbortController();
	const parentAskController = new AbortController();
	const startedIndices = new Set<number>();
	const activeIndices = new Set<number>();
	return mapConcurrent(input.tasks, input.concurrencyLimit, async (task, index) => {
		if (parentAskController.signal.aborted) {
			return skippedParallelResult(task, input.taskTexts[index] ?? task.task, "Skipped after parent ask pause");
		}
		if (intercomDetachController.signal.aborted) {
			return skippedParallelResult(
				task,
				input.taskTexts[index] ?? task.task,
				"Skipped after foreground group detached for intercom coordination",
			);
		}
		const behavior = input.behaviors[index];
		const effectiveSkills = behavior?.skills;
		const taskCwd = resolveParallelTaskCwd(task, input.paramsCwd, input.worktreeSetup, index);
		const readInstructions = behavior
			? buildTaskInstructions({ ...behavior, output: false, progress: false }, taskCwd, false)
			: { prefix: "", suffix: "" };
		const progressInstructions = behavior
			? buildTaskInstructions(
					{ ...behavior, output: false, reads: false },
					input.paramsCwd,
					index === input.firstProgressIndex,
				)
			: { prefix: "", suffix: "" };
		const outputPath = resolveSingleOutputPath(behavior?.output, input.ctx.cwd, taskCwd);
		const taskText = injectSingleOutputInstruction(
			`${readInstructions.prefix}${input.taskTexts[index]!}${progressInstructions.suffix}`,
			outputPath,
		);
		const childIntercomTarget = input.childIntercomTarget?.(task.agent, index);
		const supervisorAuthorization = await requestSupervisorAuthorization(input.intercomEvents, childIntercomTarget);
		if (parentAskController.signal.aborted) {
			return skippedParallelResult(task, input.taskTexts[index] ?? task.task, "Skipped after parent ask pause");
		}
		if (intercomDetachController.signal.aborted) {
			return skippedParallelResult(
				task,
				input.taskTexts[index] ?? task.task,
				"Skipped after foreground group detached for intercom coordination",
			);
		}
		const interruptController = new AbortController();
		const interruptForParentAsk = () => interruptController.abort();
		parentAskController.signal.addEventListener("abort", interruptForParentAsk, { once: true });
		if (parentAskController.signal.aborted) interruptController.abort();
		startedIndices.add(index);
		activeIndices.add(index);
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
		const agentConfig = input.agentConfigs?.[index] ?? input.agents.find((agent) => agent.name === task.agent);
		const taskAgents = input.agentConfigs && agentConfig ? [agentConfig] : input.agents;
		const runOptions: RunSyncOptions = {
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
			parentDepth: input.parentDepth,
			workflowStageSubagentGuard: input.workflowStageSubagentGuard,
			workflowSessionMetadata: workflowSessionMetadataFromContext(input.ctx),
			controlConfig: input.controlConfig,
			onControlEvent: input.onControlEvent,
			intercomSessionName: childIntercomTarget,
			supervisorAuthorization,
			orchestratorIntercomTarget: input.orchestratorIntercomTarget,
			intercomGroup: resolveChildIntercomGroup(
				task.group ?? input.setIntercomGroup,
				inheritedIntercomGroup(input.ctx),
				input.sharedAutoIntercomGroup,
			),
			onDetachedExit: (result) => input.onDetachedExit?.(index, result),
			intercomDetachSignal: intercomDetachController.signal,
			onIntercomDetachCommit: () => intercomDetachController.abort(),
			onParentAskClaim: input.onParentAskPause
				? (request) => {
						if (parentAskController.signal.aborted) return;
						input.onParentAskPause?.({
							askingChildIndex: request.index,
							releasedChildIndices: [...activeIndices].sort((left, right) => left - right),
							unlaunchedChildIndices: input.tasks
								.map((_, taskIndex) => taskIndex)
								.filter((taskIndex) => !startedIndices.has(taskIndex)),
							request,
						});
						parentAskController.abort();
					}
				: undefined,
			modelOverride: input.modelOverrides[index],
			availableModels: input.availableModels,
			knownModelProviders: input.knownModelProviders,
			resolveCandidateModel: input.resolveCandidateModel,
			preferredModelProvider: input.ctx.model?.provider,
			currentModel: currentModelFullId(input.ctx.model),
			currentThinkingLevel: input.ctx.thinkingLevel,
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
						const mergedResults = input.liveResults.filter(
							(result): result is SingleResult => result !== undefined,
						);
						const mergedProgress = input.liveProgress.filter(
							(progress): progress is AgentProgress => progress !== undefined,
						);
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
		};
		input.onExecution?.(index, input.ctx.cwd, runOptions);
		return input.runtime.runSync(input.ctx.cwd, taskAgents, task.agent, taskText, runOptions).finally(() => {
			activeIndices.delete(index);
			parentAskController.signal.removeEventListener("abort", interruptForParentAsk);
			if (input.foregroundControl?.currentIndex === index) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}
		});
	});
}
