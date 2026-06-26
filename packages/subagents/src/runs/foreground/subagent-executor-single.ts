import { randomUUID } from "node:crypto";
import { APP_NAME } from "@bastani/atomic";
import { ChainClarifyComponent, type ChainClarifyResult } from "./chain-clarify.ts";
import { currentModelFullId, resolveModelCandidate } from "../shared/model-fallback.ts";
import { toModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { discoverAvailableSkills, normalizeSkillInput } from "../../agents/skills.ts";
import { recordRun } from "../shared/run-history.ts";
import { getSingleResultOutput, compactForegroundDetails } from "../../shared/utils.ts";
import { updateForegroundNestedProjection } from "../shared/nested-events.ts";
import { resolveStepBehavior } from "../../shared/settings.ts";
import {
	INTERCOM_BRIDGE_MARKER,
	resolveSubagentIntercomTarget,
} from "../../intercom/intercom-bridge.ts";
import {
	finalizeSingleOutput,
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import {
	resolveChildMaxSubagentDepth,
	resolveSubagentDepthPolicy,
	wrapForkTask,
	type AgentProgress,
	type ArtifactPaths,
	type SingleResult,
	type SubagentToolResult,
} from "../../shared/types.ts";
import type { ExecutionContextData, ResolvedExecutorDeps } from "./subagent-executor-types.ts";
import { createForegroundControlNotifier, maybeBuildForegroundIntercomReceipt, rememberForegroundRun } from "./subagent-executor-status.ts";

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

export async function runSinglePath(data: ExecutionContextData, deps: ResolvedExecutorDeps): Promise<SubagentToolResult> {
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
		sessionRoot,
		controlConfig,
	} = data;
	const onControlEvent = createForegroundControlNotifier(data, deps);
	const childIntercomTarget = data.intercomBridge.active ? resolveSubagentIntercomTarget(runId, params.agent!, 0) : undefined;
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
	let task = params.task ?? "";
	let modelOverride: string | undefined = resolveModelCandidate(
		(params.model as string | undefined) ?? agentConfig.model,
		availableModels,
		currentProvider,
	);
	let skillOverride: string[] | false | undefined = normalizeSkillInput(params.skill);
	const rawOutput = params.output !== undefined ? params.output : agentConfig.output;
	let effectiveOutput = normalizeSingleOutputOverride(rawOutput, agentConfig.output);
	const effectiveOutputMode = params.outputMode ?? "inline";
	const depthPolicy = resolveSubagentDepthPolicy(ctx, deps.config.maxSubagentDepth);
	const currentMaxSubagentDepth = depthPolicy.maxSubagentDepth;
	const workflowStageSubagentGuard = depthPolicy.workflowStageSubagentGuard;
	const maxSubagentDepth = resolveChildMaxSubagentDepth(currentMaxSubagentDepth, agentConfig.maxSubagentDepth);

	if (params.clarify === true && ctx.hasUI) {
		const behavior = resolveStepBehavior(agentConfig, { output: effectiveOutput, skills: skillOverride });
		const availableSkills = discoverAvailableSkills(effectiveCwd);

		const result = await ctx.ui.custom<ChainClarifyResult>(
			(tui, theme, _kb, done) =>
				new ChainClarifyComponent(
					tui, theme,
					[agentConfig],
					[task],
					task,
					undefined,
					[behavior],
					availableModels,
					currentProvider,
					availableSkills,
					done,
					"single",
				),
			{ overlay: true, overlayOptions: { anchor: "center", width: 84, maxHeight: "80%" } },
		);

		if (!result || !result.confirmed) {
			return { content: [{ type: "text", text: "Cancelled" }], details: { mode: "single", results: [] } };
		}

		task = result.templates[0]!;
		const override = result.behaviorOverrides[0];
		if (override?.model) modelOverride = override.model;
		if (override?.output !== undefined) effectiveOutput = normalizeSingleOutputOverride(override.output, agentConfig.output);
		if (override?.skills !== undefined) skillOverride = override.skills;

		if (result.runInBackground) {
			if (!deps.runtime.isAsyncAvailable()) {
				return {
					content: [{ type: "text", text: `Background mode requires upstream jiti for TypeScript execution but it could not be found. Ensure the ${APP_NAME}-subagents package dependencies are installed.` }],
					isError: true,
					details: { mode: "single" as const, results: [] },
				};
			}
			const id = randomUUID();
			const asyncCtx = {
				pi: deps.pi,
				cwd: ctx.cwd,
				currentSessionId: deps.state.currentSessionId!,
				currentModelProvider: ctx.model?.provider,
				currentModel: currentModelFullId(ctx.model),
			};
			return deps.runtime.executeAsyncSingle(id, {
				agent: params.agent!,
				task: params.context === "fork" ? wrapForkTask(task) : task,
				agentConfig,
				ctx: asyncCtx,
				availableModels,
				cwd: effectiveCwd,
				maxOutput: params.maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				shareEnabled,
				sessionRoot,
				sessionFile: sessionFileForIndex(0),
				skills: skillOverride === false ? [] : skillOverride,
				output: effectiveOutput,
				outputMode: effectiveOutputMode,
				modelOverride,
				maxSubagentDepth,
				workflowStageSubagentGuard,
				worktreeSetupHook: deps.config.worktreeSetupHook,
				worktreeSetupHookTimeoutMs: deps.config.worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
				childIntercomTarget: data.intercomBridge.active ? (agent, index) => resolveSubagentIntercomTarget(id, agent, index) : undefined,
			});
		}
	}

	if (params.context === "fork") {
		task = wrapForkTask(task);
	}
	const cleanTask = task;
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, effectiveCwd);
	const validationError = validateFileOnlyOutputMode(effectiveOutputMode, outputPath, `Single run (${params.agent})`);
	if (validationError) {
		return { content: [{ type: "text", text: validationError }], isError: true, details: { mode: "single", results: [] } };
	}
	task = injectSingleOutputInstruction(task, outputPath);

	let effectiveSkills: string[] | undefined;
	if (skillOverride === false) {
		effectiveSkills = [];
	} else {
		effectiveSkills = skillOverride;
	}
	const interruptController = new AbortController();
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

	const forwardSingleUpdate = onUpdate
		? (update: SubagentToolResult) => {
			if (foregroundControl) {
				const firstProgress = update.details?.progress?.[0];
				foregroundControl.currentAgent = params.agent;
				foregroundControl.currentIndex = firstProgress?.index ?? 0;
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
		}
		: undefined;

	const r = await deps.runtime.runSync(ctx.cwd, agents, params.agent!, task, {
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
		maxSubagentDepth,
		workflowStageSubagentGuard,
		onUpdate: forwardSingleUpdate,
		controlConfig,
		onControlEvent,
		intercomSessionName: childIntercomTarget,
		orchestratorIntercomTarget: data.intercomBridge.active ? data.intercomBridge.orchestratorTarget : undefined,
		nestedRoute: foregroundControl?.nestedRoute,
		index: 0,
		modelOverride,
		availableModels,
		preferredModelProvider: currentProvider,
		currentModel: currentModelFullId(ctx.model),
		skills: effectiveSkills,
	});
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
	recordRun(params.agent!, cleanTask, r.exitCode, r.progressSummary?.durationMs ?? 0);

	if (r.progress) allProgress.push(r.progress);
	if (r.artifactPaths) allArtifactPaths.push(r.artifactPaths);

	const fullOutput = getSingleResultOutput(r);
	const finalizedOutput = finalizeSingleOutput({
		fullOutput,
		truncatedOutput: r.truncation?.text,
		outputPath,
		outputMode: r.outputMode,
		exitCode: r.exitCode,
		savedPath: r.savedOutputPath,
		outputReference: r.outputReference,
		saveError: r.outputSaveError,
	});
	const details = compactForegroundDetails({
		mode: "single",
		runId,
		results: [r],
		progress: params.includeProgress ? allProgress : undefined,
		artifacts: allArtifactPaths.length ? { dir: artifactsDir, files: allArtifactPaths } : undefined,
		truncation: r.truncation,
	});
	rememberForegroundRun(deps.state, { runId, mode: "single", cwd: effectiveCwd, results: details.results });

	if (!r.detached && !r.interrupted) {
		if (foregroundControl) updateForegroundNestedProjection(foregroundControl);
		const intercomReceipt = await maybeBuildForegroundIntercomReceipt({
			pi: deps.pi,
			intercomBridge: data.intercomBridge,
			runId,
			mode: "single",
			details,
			...(foregroundControl?.nestedChildren?.length ? { nestedChildren: foregroundControl.nestedChildren } : {}),
		});
		if (intercomReceipt) {
			return {
				content: [{ type: "text", text: intercomReceipt.text }],
				details: intercomReceipt.details,
				...(r.exitCode !== 0 ? { isError: true } : {}),
			};
		}
	}

	if (r.detached) {
		return {
			content: [{ type: "text", text: `Detached for intercom coordination: ${params.agent}. Reply to the supervisor request first. After the child exits, start a fresh follow-up if needed.` }],
			details,
		};
	}

	if (r.interrupted) {
		return {
			content: [{ type: "text", text: `Run paused after interrupt (${params.agent}). Waiting for explicit next action.` }],
			details,
		};
	}

	if (r.exitCode !== 0)
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
