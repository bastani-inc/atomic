import * as fs from "node:fs";
import * as path from "node:path";
import { normalizeSkillInput } from "../../agents/skills.js";
import { INTERCOM_BRIDGE_MARKER, resolveSubagentIntercomTarget } from "../../intercom/intercom-bridge.js";
import { collectKnownModelProviders, type ModelInfo, toModelInfo } from "../../shared/model-info.js";
import { createCandidateModelResolver } from "../../shared/model-resolution.js";
import {
	injectSingleProgressInstruction,
	resolveSingleProgress,
	writeInitialProgressFile,
} from "../../shared/settings.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	type ForegroundChildExecution,
	isWorkflowStageOrchestrationContext,
	type ParentAskPauseRequest,
	type RunSyncOptions,
	type SingleResult,
	type SubagentToolResult,
	workflowSessionMetadataFromContext,
	wrapForkTask,
} from "../../shared/types.js";
import { compactForegroundDetails, getSingleResultOutput } from "../../shared/utils.js";
import { inheritedIntercomGroup, resolveChildIntercomGroup } from "../shared/intercom-group.js";
import { currentModelFullId, resolveModelCandidate } from "../shared/model-fallback.js";
import { recordRun } from "../shared/run-history.js";
import {
	finalizeSingleOutput,
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../shared/single-output.js";
import { formatParentAskPauseOutput } from "./parent-ask-output.js";
import {
	createForegroundControlNotifier,
	maybeBuildForegroundIntercomReceipt,
	notifyDetachedForegroundChildExit,
	rememberForegroundRun,
	replaceForegroundRunChild,
	retainForegroundChildExecution,
} from "./subagent-executor-status.js";
import type { ExecutionContextData, ForegroundControl, ResolvedExecutorDeps } from "./subagent-executor-types.js";

function formatFailedSingleRunOutput(result: SingleResult, displayOutput: string): string {
	const error = result.error || "Failed";
	const output = displayOutput.trim();
	const lines = [error];
	if (output && output !== error.trim()) {
		lines.push("", "Output:", output);
	}
	if (result.artifactPaths?.outputPath) {
		lines.push("", `Output artifact: ${result.artifactPaths.outputPath}`);
	}
	return lines.join("\n");
}

function cleanupTransientProgress(progressDir: string | undefined, artifactsEnabled: boolean): void {
	if (!progressDir || artifactsEnabled) return;
	try {
		fs.rmSync(progressDir, { recursive: true, force: true });
	} catch {
		// Scratch cleanup must never replace the child run's result or original error.
	}
}

export function createForwardSingleUpdate(
	onUpdate: ((r: SubagentToolResult) => void) | undefined,
	foregroundControl: ForegroundControl | undefined,
	agent: string,
	index: number,
): ((r: SubagentToolResult) => void) | undefined {
	if (!onUpdate) return undefined;
	return (update: SubagentToolResult) => {
		if (foregroundControl) {
			const firstProgress = update.details?.progress?.[0];
			foregroundControl.currentAgent = agent;
			foregroundControl.currentIndex = firstProgress?.index ?? index;
			foregroundControl.currentActivityState = firstProgress?.activityState;
			foregroundControl.lastActivityAt = firstProgress?.lastActivityAt;
			foregroundControl.currentTool = firstProgress?.currentTool;
			foregroundControl.currentToolStartedAt = firstProgress?.currentToolStartedAt;
			foregroundControl.currentPath = firstProgress?.currentPath;
			foregroundControl.turnCount = firstProgress?.turnCount;
			foregroundControl.tokens = firstProgress?.tokens;
			foregroundControl.toolCount = firstProgress?.toolCount;
			foregroundControl.updatedAt = Date.now();
		}
		onUpdate(update);
	};
}

export async function runSinglePath(
	data: ExecutionContextData,
	deps: ResolvedExecutorDeps,
): Promise<SubagentToolResult> {
	const {
		params,
		effectiveCwd,
		agents,
		ctx,
		signal,
		runId,
		sessionDirForIndex,
		sessionFileForIndex,
		shareEnabled,
		artifactConfig,
		artifactsDir,
		onUpdate,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active
		? resolveSubagentIntercomTarget(runId, params.agent!, 0)
		: undefined;
	const allProgress: AgentProgress[] = [];
	const allArtifactPaths: ArtifactPaths[] = [];
	const agentConfig = agents.find((a) => a.name === params.agent);
	if (!agentConfig) {
		return {
			content: [{ type: "text", text: `Unknown agent: ${params.agent}` }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}

	const currentProvider = ctx.model?.provider;
	const availableModels: ModelInfo[] = ctx.modelRegistry.getAvailable().map(toModelInfo);
	const knownModelProviders = collectKnownModelProviders(ctx.modelRegistry);
	let task = params.task ?? "";
	const modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	const skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	const effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const workflowStageSubagentGuard = isWorkflowStageOrchestrationContext(ctx);
	const progress = resolveSingleProgress(agentConfig, params.progress, task);

	if (params.context === "fork") {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd);
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return {
			content: [{ type: "text", text: validationError }],
			isError: true,
			details: { mode: "single", results: [] },
		};
	}
	// Single-agent progress is isolated by run so the injected contract cannot
	// overwrite a project's own progress.md or collide with another child.
	const progressDir = progress ? path.join(artifactsDir, "progress", runId) : undefined;
	if (progressDir) {
		writeInitialProgressFile(progressDir);
		task = injectSingleProgressInstruction(task, progressDir);
	}
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
	let parentAsk: ParentAskPauseRequest | undefined;
	const foregroundControl = deps.state.foregroundControls.get(runId);
	if (foregroundControl) {
		foregroundControl.currentAgent = params.agent;
		foregroundControl.currentIndex = 0;
		foregroundControl.currentActivityState = undefined;
		foregroundControl.updatedAt = Date.now();
		foregroundControl.interrupt = () => {
			if (interruptController.signal.aborted) return false;
			interruptController.abort();
			foregroundControl.currentActivityState = undefined;
			foregroundControl.updatedAt = Date.now();
			return true;
		};
	}

	const forwardSingleUpdate = createForwardSingleUpdate(onUpdate, foregroundControl, params.agent!, 0);

	let r: SingleResult;
	let execution: ForegroundChildExecution;
	try {
		const runOptions: RunSyncOptions = {
			cwd: effectiveCwd,
			signal,
			interruptSignal: interruptController.signal,
			allowIntercomDetach: agentConfig.systemPrompt?.includes(INTERCOM_BRIDGE_MARKER) === true,
			intercomEvents: deps.pi.events,
			runId,
			sessionDir: sessionDirForIndex(0),
			sessionFile: sessionFileForIndex(0),
			share: shareEnabled,
			artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
			artifactConfig,
			maxOutput: params.maxOutput,
			outputPath,
			outputMode: effectiveOutputMode,
			parentDepth: data.parentDepth,
			workflowStageSubagentGuard,
			workflowSessionMetadata: workflowSessionMetadataFromContext(ctx),
			onUpdate: forwardSingleUpdate,
			controlConfig,
			onControlEvent,
			intercomSessionName: childIntercomTarget,
			orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
			intercomGroup: resolveChildIntercomGroup(params.group, inheritedIntercomGroup(ctx), undefined),
			onParentAskClaim: (request) => {
				if (parentAsk) return;
				parentAsk = request;
				interruptController.abort();
			},
			onDetachedExit: (result) => {
				cleanupTransientProgress(progressDir, artifactConfig.enabled);
				if (result) {
					replaceForegroundRunChild(deps.state, runId, 0, result);
					notifyDetachedForegroundChildExit({ pi: deps.pi, runId, mode: "single", index: 0, result });
				}
			},
			index: 0,
			modelOverride,
			availableModels,
			knownModelProviders,
			resolveCandidateModel: createCandidateModelResolver(ctx.modelRegistry, currentProvider),
			preferredModelProvider: currentProvider,
			currentModel: currentModelFullId(ctx.model),
			currentThinkingLevel: ctx.thinkingLevel,
			skills: effectiveSkills,
		};
		execution = retainForegroundChildExecution(ctx.cwd, runOptions, params.agentScope);
		r = await deps.runtime.runSync(ctx.cwd, agents, params.agent!, task, runOptions);
	} catch (error) {
		cleanupTransientProgress(progressDir, artifactConfig.enabled);
		throw error;
	}
	// Detached children still own this storage until their process closes.
	if (!r.detached) cleanupTransientProgress(progressDir, artifactConfig.enabled);
	if (foregroundControl?.currentIndex === 0) {
		foregroundControl.interrupt = undefined;
		foregroundControl.currentActivityState = r.progress?.activityState;
		foregroundControl.lastActivityAt = r.progress?.lastActivityAt;
		foregroundControl.currentTool = r.progress?.currentTool;
		foregroundControl.currentToolStartedAt = r.progress?.currentToolStartedAt;
		foregroundControl.currentPath = r.progress?.currentPath;
		foregroundControl.turnCount = r.progress?.turnCount;
		foregroundControl.tokens = r.progress?.tokens;
		foregroundControl.toolCount = r.progress?.toolCount;
		foregroundControl.updatedAt = Date.now();
	}
	recordRun(params.agent!, cleanTask, r.status, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		status: r.status,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		parentAskPaused: parentAsk !== undefined && r.interrupted,
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
	});
	rememberForegroundRun(deps.state, {
		runId,
		mode: "single",
		cwd: effectiveCwd,
		children: [{ index: 0, result: details.results[0]!, execution }],
		...(parentAsk && r.interrupted
			? {
					parentAsk: {
						askingChildIndex: 0,
						releasedChildIndices: [0],
						unlaunchedChildIndices: [],
						request: parentAsk,
					},
				}
			: {}),
	});

	if (!r.detached && !r.interrupted) {
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.status === "error" ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [
				{
					type: "text",
					text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.`,
				},
			],
			details,
		};
	}

	if (parentAsk && r.interrupted) {
		return {
			content: [
				{
					type: "text",
					text: formatParentAskPauseOutput({
						askingChildIndex: 0,
						releasedChildIndices: [0],
						unlaunchedChildIndices: [],
						request: parentAsk,
					}),
				},
			],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [
				{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` },
			],
			details,
		};
	}

	if (r.status === "error")
		return {
			content: [{ type: "text", text: formatFailedSingleRunOutput(r, finalizedOutput.displayOutput) }],
			details,
			isError: true,
		};
	return {
		content: [{ type: "text", text: finalizedOutput.displayOutput || "(no output)" }],
		details,
	};
}
