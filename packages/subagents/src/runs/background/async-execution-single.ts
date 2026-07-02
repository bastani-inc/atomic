import * as fs from "node:fs";
import * as path from "node:path";
import { getEnvValue } from "@bastani/atomic";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { getSubagentCodexFastModeSettings, resolveSubagentCodexFastModeScope, resolveSubagentModelFastModeMetadata } from "../../shared/fast-mode.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { ASYNC_DIR, RESULTS_DIR, SUBAGENT_ASYNC_STARTED_EVENT, resolveChildMaxSubagentDepth } from "../../shared/types.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import { applyThinkingSuffix, SUBAGENT_INTERCOM_SESSION_NAME_ENV } from "../shared/pi-args.ts";
import { injectSingleOutputInstruction, normalizeSingleOutputOverride, resolveSingleOutputPath, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import { buildModelCandidates, resolveModelCandidate } from "../shared/model-fallback.ts";
import { filterSpawnableModelCandidates } from "../shared/model-candidate-filter.ts";
import { NESTED_RUNS_DIR, nestedResultsPath, resolveInheritedNestedRouteFromEnv, resolveNestedParentAddressFromEnv, writeNestedEvent } from "../shared/nested-events.ts";
import {
	UNAVAILABLE_SUBAGENT_SKILL_ERROR,
	formatAsyncStartedMessage,
	formatAsyncStartError,
	piPackageRoot,
	spawnRunner,
} from "./async-execution-common.ts";
import type { AsyncExecutionResult, AsyncSingleParams, AsyncSpawnResult } from "./async-execution-types.ts";

/**
 * Execute a single agent asynchronously
 */
export function executeAsyncSingle(
	id: string,
	params: AsyncSingleParams,
): AsyncExecutionResult {
	const {
		agent,
		agentConfig,
		ctx,
		cwd,
		maxOutput,
		artifactsDir,
		artifactConfig,
		shareEnabled,
		sessionRoot,
		sessionFile,
		maxSubagentDepth,
		workflowStageSubagentGuard,
		worktreeSetupHook,
		worktreeSetupHookTimeoutMs,
		controlConfig,
		controlIntercomTarget,
		childIntercomTarget,
		nestedRoute,
	} = params;
	const task = params.task ?? "";
	const runnerCwd = resolveChildCwd(ctx.cwd, cwd);
	const skillNames = params.skills ?? agentConfig.skills ?? [];
	const availableModels = params.availableModels;
	const knownModelProviders = params.knownModelProviders;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, runnerCwd, ctx.cwd);
	if (missingSkills.includes("subagent")) return formatAsyncStartError("single", UNAVAILABLE_SUBAGENT_SKILL_ERROR);
	let systemPrompt = agentConfig.systemPrompt?.trim() ?? "";
	if (resolvedSkills.length > 0) {
		const injection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(NESTED_RUNS_DIR, inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: `Failed to create async run directory '${asyncDir}': ${message}` }],
			isError: true,
			details: { mode: "single" as const, results: [] },
		};
	}

	const effectiveOutput = normalizeSingleOutputOverride(params.output, agentConfig.output);
	const outputPath = resolveSingleOutputPath(effectiveOutput, ctx.cwd, runnerCwd);
	const outputMode = params.outputMode ?? "inline";
	const validationError = validateFileOnlyOutputMode(outputMode, outputPath, `Async single run (${agent})`);
	if (validationError) return formatAsyncStartError("single", validationError);
	const taskWithOutputInstruction = injectSingleOutputInstruction(task, outputPath);
	const model = applyThinkingSuffix(
		resolveModelCandidate(params.modelOverride ?? agentConfig.model, availableModels, ctx.currentModelProvider),
		agentConfig.thinking,
	);
	const rawModelCandidates = buildModelCandidates(params.modelOverride ?? agentConfig.model, agentConfig.fallbackModels, availableModels, ctx.currentModelProvider, ctx.currentModel)
		.map((candidate) => applyThinkingSuffix(candidate, agentConfig.thinking))
		.filter((candidate): candidate is string => typeof candidate === "string");
	const filteredCandidates = filterSpawnableModelCandidates({
		candidates: rawModelCandidates,
		availableModels,
		knownModelProviders,
		currentModel: applyThinkingSuffix(ctx.currentModel, agentConfig.thinking),
	});
	const modelCandidates = filteredCandidates.candidates;
	const fastModeSettings = getSubagentCodexFastModeSettings(runnerCwd);
	const fastModeScope = resolveSubagentCodexFastModeScope(workflowStageSubagentGuard);
	let spawnResult: AsyncSpawnResult = {};
	try {
		spawnResult = spawnRunner(
			{
				id,
				steps: [
					{
						agent,
						task: taskWithOutputInstruction,
						cwd: runnerCwd,
						model,
						thinking: resolveEffectiveThinking(model, agentConfig.thinking),
						...resolveSubagentModelFastModeMetadata({ model, modelCandidates, cwd: runnerCwd, settings: fastModeSettings, scope: fastModeScope }),
						modelCandidates,
						modelAttempts: filteredCandidates.skippedAttempts,
						codexFastModeSettings: fastModeSettings,
						codexFastModeScope: fastModeScope,
						tools: agentConfig.tools,
						extensions: agentConfig.extensions,
						mcpDirectTools: agentConfig.mcpDirectTools,
						systemPrompt,
						systemPromptMode: agentConfig.systemPromptMode,
						inheritProjectContext: agentConfig.inheritProjectContext,
						inheritSkills: agentConfig.inheritSkills,
						skills: resolvedSkills.map((r) => r.name),
						outputPath,
						outputMode,
						sessionFile,
						maxSubagentDepth: resolveChildMaxSubagentDepth(maxSubagentDepth, agentConfig.maxSubagentDepth),
						workflowStageSubagentGuard,
					},
				],
				resultPath: inheritedNestedRoute ? nestedResultsPath(inheritedNestedRoute.rootRunId, id) : path.join(RESULTS_DIR, `${id}.json`),
				cwd: runnerCwd,
				placeholder: "{previous}",
				maxOutput,
				artifactsDir: artifactConfig.enabled ? artifactsDir : undefined,
				artifactConfig,
				share: shareEnabled,
				sessionDir: sessionRoot ? path.join(sessionRoot, `async-${id}`) : undefined,
				asyncDir,
				sessionId: ctx.currentSessionId,
				piPackageRoot,
				piArgv1: process.argv[1],
				worktreeSetupHook,
				worktreeSetupHookTimeoutMs,
				controlConfig,
				controlIntercomTarget,
				childIntercomTargets: childIntercomTarget ? [childIntercomTarget(agent, 0)] : undefined,
				resultMode: "single",
				nestedRoute: nestedRoute ?? inheritedNestedRoute,
				workflowStageSubagentGuard,
				nestedSelf: inheritedNestedRoute && nestedAddress ? {
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					depth: nestedAddress.depth,
					path: nestedAddress.path,
				} : undefined,
			},
			id,
			runnerCwd,
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${message}`);
	}

	if (spawnResult.error) {
		return formatAsyncStartError("single", `Failed to start async run '${id}': ${spawnResult.error}`);
	}

	if (spawnResult.pid) {
		if (inheritedNestedRoute && nestedAddress) {
			const now = Date.now();
			try {
				writeNestedEvent(inheritedNestedRoute, {
					type: "subagent.nested.started",
					ts: now,
					parentRunId: nestedAddress.parentRunId,
					parentStepIndex: nestedAddress.parentStepIndex,
					child: {
						id,
						parentRunId: nestedAddress.parentRunId,
						parentStepIndex: nestedAddress.parentStepIndex,
						depth: nestedAddress.depth,
						path: nestedAddress.path,
						asyncDir,
						pid: spawnResult.pid,
						ownerIntercomTarget: getEnvValue(SUBAGENT_INTERCOM_SESSION_NAME_ENV),
						leafIntercomTarget: childIntercomTarget?.(agent, 0),
						intercomTarget: childIntercomTarget?.(agent, 0),
						ownerState: "live",
						mode: "single",
						state: "running",
						agent,
						agents: [agent],
						chainStepCount: 1,
						startedAt: now,
						lastUpdate: now,
					},
				});
			} catch (error) {
				console.error("Failed to emit nested async start event:", error);
			}
		}
		ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, {
			id,
			pid: spawnResult.pid,
			sessionId: ctx.currentSessionId,
			mode: "single",
			agent,
			task: task?.slice(0, 50),
			cwd: runnerCwd,
			asyncDir,
			nestedRoute,
		});
	}

	return {
		content: [{ type: "text", text: formatAsyncStartedMessage(`Async: ${agent} [${id}]`) }],
		details: { mode: "single", runId: id, results: [], asyncId: id, asyncDir },
	};
}
