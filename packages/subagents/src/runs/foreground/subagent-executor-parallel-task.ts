import { join } from "node:path";
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
import { createExecutionScheduler } from "../shared/parallel-utils.js";
import { injectSingleOutputInstruction, resolveSingleOutputPath } from "../shared/single-output.js";
import type { WorktreeSetup } from "../shared/worktree.js";
import { markLiveResultIndices } from "./subagent-executor-live-update.js";
import type { SubagentExecutorRuntimeDeps, TaskParam } from "./subagent-executor-types.js";
import { resolveParallelTaskCwd } from "./subagent-executor-worktree.js";
import { runAgentTask } from "./task-execution.js";

interface ForegroundParallelRunInput {
	tasks: TaskParam[];
	taskTexts: string[];
	agents: AgentConfig[];
	agentConfigs?: AgentConfig[];
	ctx: ExtensionContext;
	resourceLoaderInheritanceSnapshot?: import("@bastani/atomic").DefaultResourceLoaderInheritanceSnapshot;
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
	modelRoutes?: (import("../shared/model-router.js").ModelRoute | undefined)[];
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
	schedule?: (dispatch: () => Promise<void>) => void;
	liveResults: (SingleResult | undefined)[];
	liveProgress: (AgentProgress | undefined)[];
	onUpdate?: (r: SubagentToolResult) => void;
	onDetachedExit?: (index: number, result: SingleResult) => void;
	onTaskTerminal?: (index: number) => void;
	wait?: import("@bastani/atomic").WaitPolicy;
	onExecution?: (index: number, runtimeCwd: string, options: RunSyncOptions) => void;
	worktreeSetup?: WorktreeSetup;
	runtime: Pick<SubagentExecutorRuntimeDeps, "runSync">;
}

/** Legacy callers observe detachment, but execution capacity stays held until exit. */
export function runUnboundParallelTask(
	options: RunSyncOptions,
	agent: string,
	task: string,
	schedule: (dispatch: () => Promise<void>) => void,
	run: (options: RunSyncOptions) => Promise<SingleResult>,
): Promise<SingleResult> {
	const observed = Promise.withResolvers<SingleResult>();
	const finished = Promise.withResolvers<void>();
	let started = false;
	let yielded = false;
	const yieldQueued = () => {
		if (started) return;
		yielded = true;
		observed.resolve({
			agent,
			task,
			status: "continued",
			detached: true,
			detachedReason: "intercom-coordination",
			messages: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
		});
	};
	options.intercomDetachSignal?.addEventListener("abort", yieldQueued, { once: true });
	schedule(async () => {
		started = true;
		try {
			const result = await run({
				...options,
				onDetachedExit: (result) => {
					try {
						options.onDetachedExit?.(result);
					} finally {
						finished.resolve();
					}
				},
			});
			observed.resolve(result);
			if (!result.detached) {
				finished.resolve();
				if (yielded) options.onDetachedExit?.(result);
			}
			await finished.promise;
		} catch (error) {
			observed.reject(error);
		}
	});
	if (options.intercomDetachSignal?.aborted) yieldQueued();
	return observed.promise.finally(() => options.intercomDetachSignal?.removeEventListener("abort", yieldQueued));
}

export async function runForegroundParallelTasks(input: ForegroundParallelRunInput): Promise<SingleResult[]> {
	const intercomDetachController = new AbortController();
	const host = input.ctx.getAgentTaskHost?.();
	// Admit observations independently; only actual execution holds a concurrency slot.
	const schedule = input.schedule ?? createExecutionScheduler(input.concurrencyLimit);
	return mapConcurrent(input.tasks, input.tasks.length, async (task, index) => {
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
		const supervisorAuthorization = await requestSupervisorAuthorization(
			input.intercomEvents,
			childIntercomTarget,
			input.ctx.getChildSessionOptions?.({
				tools: (input.agentConfigs?.[index] ?? input.agents.find((agent) => agent.name === task.agent))?.tools,
			}),
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
		const agentConfig = input.agentConfigs?.[index] ?? input.agents.find((agent) => agent.name === task.agent);
		const taskAgents = input.agentConfigs && agentConfig ? [agentConfig] : input.agents;
		const sharedProgress =
			index === input.behaviors.findIndex((candidate) => candidate.progress)
				? join(input.paramsCwd, "progress.md")
				: undefined;
		const runOptions: RunSyncOptions = {
			getChildSessionOptions: input.ctx.getChildSessionOptions,
			resourceLoaderInheritanceSnapshot: input.resourceLoaderInheritanceSnapshot,
			cwd: taskCwd,
			signal: input.signal,
			interruptSignal: interruptController.signal,
			...(sharedProgress ? { progressPath: sharedProgress, progressArtifactPath: sharedProgress } : {}),
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
			// Parallel requests use Intercom's correlated waiter in the original child.
			// The single-child terminal handoff would cancel unrelated siblings here.
			modelOverride: input.modelOverrides[index],
			modelRoute: input.modelRoutes?.[index],
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
						const indexedResults = input.liveResults.flatMap((result, resultIndex) =>
							result === undefined ? [] : [{ result, index: resultIndex }],
						);
						const mergedResults = indexedResults.map(({ result }) => result);
						const mergedProgress = input.liveProgress.filter(
							(progress): progress is AgentProgress => progress !== undefined,
						);
						const controlEvents = progressUpdate.details?.controlEvents?.map((event) => ({ ...event, index }));
						const artifactDir = progressUpdate.details?.artifacts?.dir;
						const artifactFiles = mergedResults.flatMap((result) =>
							result.artifactPaths ? [result.artifactPaths] : [],
						);
						const aggregateUpdate: SubagentToolResult = {
							content: progressUpdate.content,
							details: {
								mode: "parallel",
								results: mergedResults,
								progress: mergedProgress,
								...(controlEvents?.length ? { controlEvents } : {}),
								totalSteps: input.tasks.length,
								...(artifactDir && artifactFiles.length
									? { artifacts: { dir: artifactDir, files: artifactFiles } }
									: {}),
							},
						};
						markLiveResultIndices(
							aggregateUpdate,
							indexedResults.map(({ index: resultIndex }) => resultIndex),
						);
						input.onUpdate?.(aggregateUpdate);
					}
				: undefined,
		};
		runOptions.modelRoute?.assertCurrent();
		input.onExecution?.(index, input.ctx.cwd, runOptions);
		if (host) {
			if (input.wait?.kind !== "foreground") {
				runOptions.intercomDetachSignal = undefined;
				runOptions.onIntercomDetachCommit = undefined;
			}
			let terminalChild: SingleResult | undefined;
			const response = await runAgentTask({
				host,
				cwd: input.ctx.cwd,
				agents: taskAgents,
				agent: task.agent,
				task: taskText,
				intentTask: task.task,
				options: runOptions,
				wait: input.wait,
				runtime: input.runtime,
				// Dispatch also settles when native cancellation skips a queued runner.
				// Recover only after dispatch drains, never when its observation yields.
				schedule: (dispatch) => schedule(() => dispatch().finally(() => input.onTaskTerminal?.(index))),
				onTerminal: (child) => {
					terminalChild = child;
				},
			});
			if (terminalChild) return { ...terminalChild, taskResponse: response };
			return {
				agent: task.agent,
				task: task.task,
				status: "continued",
				messages: [],
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
				taskResponse: response,
			};
		}
		return runUnboundParallelTask(runOptions, task.agent, taskText, schedule, (options) =>
			input.runtime.runSync(input.ctx.cwd, taskAgents, task.agent, taskText, options),
		).finally(() => {
			if (input.foregroundControl?.currentIndex === index) {
				input.foregroundControl.interrupt = undefined;
				input.foregroundControl.updatedAt = Date.now();
			}
		});
	});
}
