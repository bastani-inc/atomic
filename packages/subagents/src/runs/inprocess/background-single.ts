import * as fs from "node:fs";
import * as path from "node:path";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { injectSingleProgressInstruction, writeInitialProgressFile } from "../../shared/settings.ts";
import {
	ASYNC_DIR,
	resolveChildMaxSubagentDepth,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
} from "../../shared/types.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { runSingleInProcess } from "../foreground/inprocess-run-sync.ts";
import { resolveChildIntercomGroup } from "../shared/intercom-group.ts";
import { filterSpawnableModelCandidates } from "../shared/model-candidate-filter.ts";
import { buildModelCandidates } from "../shared/model-fallback.ts";
import {
	injectSingleOutputInstruction,
	normalizeSingleOutputOverride,
	resolveSingleOutputPath,
	validateFileOnlyOutputMode,
} from "../shared/single-output.ts";
import {
	type AsyncExecutionResult,
	type AsyncSingleParams,
	formatAsyncStartError,
	formatAsyncStartedMessage,
	UNAVAILABLE_SUBAGENT_SKILL_ERROR,
} from "./background.ts";

/**
 * Execute a single agent asynchronously using the in-process runner.
 *
 * The returned promise resolves after admission and continuation, not after the
 * model attempt. Terminal delivery happens through the existing detached-exit
 * callback and in-memory result path.
 */
export async function executeAsyncSingle(id: string, params: AsyncSingleParams): Promise<AsyncExecutionResult> {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		workflowStageSubagentGuard,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(
		skillNames,
		runnerCwd,
		ctx.cwd,
	);
	if (missingSkills.includes("subagent")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);

	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const asyncDir = path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to create async run directory '${asyncDir}': ${message}`);
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd);
	const outputMode = params.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	let taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	if (params.progress) {
		const progressDir =
			artifactConfig.enabled && artifactsDir
				? path.join(artifactsDir, "progress", id)
				: path.join(asyncDir, "progress");
		writeInitialProgressFile(progressDir);
		taskWithOutputInstruction = injectSingleProgressInstruction(taskWithOutputInstruction, progressDir);
	}

	const availableModels = params.availableModels;
	const knownModelProviders = params.knownModelProviders;
	const rawModelCandidates = buildModelCandidates(
		params.modelOverride ?? agentConfig.model,
		agentConfig.fallbackModels,
		availableModels,
		ctx.currentModelProvider,
		ctx.currentModel,
		agentConfig.fallbackThinkingLevels,
	);
	const filteredCandidates = filterSpawnableModelCandidates({
		candidates: rawModelCandidates,
		availableModels,
		knownModelProviders,
		currentModel: ctx.currentModel,
	});
	if (rawModelCandidates.length > 0 && filteredCandidates.candidates.length === 0) {
		return formatAsyncStartError("single", "No spawnable subagent model candidates after pre-spawn filtering.");
	}

	const childAgent = { ...agentConfig, systemPrompt };
	const result = await runSingleInProcess(runnerCwd, childAgent, taskWithOutputInstruction, {
		cwd: runnerCwd,
		runId: id,
		sessionDir: path.join(sessionRoot ?? asyncDir, "session"),
		sessionFile,
		artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
		artifactConfig,
		maxOutput,
		outputPath,
		outputMode,
		backgroundContinuation: true,
		maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
		workflowStageSubagentGuard,
		workflowSessionMetadata: ctx.workflowSessionMetadata,
		controlConfig,
		supervisorAuthorization: params.supervisorAuthorization,
		intercomSessionName: childIntercomTarget?.(agent, 0),
		orchestratorIntercomTarget: controlIntercomTarget,
		intercomGroup: resolveChildIntercomGroup(params.group, ctx.intercomGroup, undefined),
		modelOverride: filteredCandidates.candidates[0] ?? params.modelOverride ?? agentConfig.model,
		availableModels,
		knownModelProviders,
		preferredModelProvider: ctx.currentModelProvider,
		currentModel: ctx.currentModel,
		skills: resolvedSkills.map((skill) => skill.name),
		testSession: params.testSession,
		onDetachedExit: (completed) => {
			const envelope = completed.envelope?.trim() ? completed.envelope : "(no output)";
			ctx.pi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {
				id,
				runId: id,
				asyncDir,
				agent,
				status: completed.status,
				summary: envelope,
				envelope,
				timestamp: Date.now(),
				sessionFile: completed.sessionFile,
				results: [
					{
						agent,
						output: envelope,
						status: completed.status,
						index: 0,
						intercomTarget: childIntercomTarget?.(agent, 0),
					},
				],
				result: completed,
			});
		},
	});

	ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
		id,
		asyncDir,
		sessionId: result.path,
		mode: "single",
		agent,
		agents: [agent],
	});
	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
		details: { mode: "single", runId: id, results: [result], asyncId: id, asyncDir },
		...(result.status === "error" ? { isError: true } : {}),
	};
}
