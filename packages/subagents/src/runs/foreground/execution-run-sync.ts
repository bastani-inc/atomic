import { existsSync } from "node:fs";
import type { AgentConfig } from "../../agents/agents.ts";
import { buildSkillInjection, resolveSkillsWithFallback } from "../../agents/skills.ts";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import { getSubagentCodexFastModeSettings, resolveSubagentCodexFastModeScope } from "../../shared/fast-mode.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
	DEFAULT_MAX_OUTPUT,
	type ArtifactPaths,
	type ModelAttempt,
	type RunSyncOptions,
	type SingleResult,
	truncateOutput,
} from "../../shared/types.ts";
import { findLatestSessionFile } from "../../shared/utils.ts";
import { applyThinkingSuffix } from "../shared/pi-args.ts";
import { captureSingleOutputSnapshot, validateFileOnlyOutputMode } from "../shared/single-output.ts";
import {
	buildModelCandidates,
	formatModelAttemptNote,
	isRetryableModelFailure,
} from "../shared/model-fallback.ts";
import { filterSpawnableModelCandidates } from "../shared/model-candidate-filter.ts";
import { artifactOutputByResult, emptyUsage, modelFailureSignalByResult, sumUsage } from "./execution-utils.ts";
import { runSingleAttemptWithStructuredOutputRetries } from "./execution-structured-retries.ts";
import { shouldSuppressIntermediateRetryableFailureUpdate } from "./execution-updates.ts";

/**
 * Run a subagent synchronously (blocking until complete)
 */
export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((a) => a.name === agentName);
	if (!agent) {
		return { agent: agentName, task, exitCode: 1, messages: [], usage: emptyUsage(), error: `Unknown agent: ${agentName}` };
	}
	const outputModeValidationError = validateFileOnlyOutputMode(options.outputMode, options.outputPath, `Single run (${agentName})`);
	if (outputModeValidationError) {
		return {
			agent: agentName,
			task,
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			outputMode: options.outputMode,
			error: outputModeValidationError,
		};
	}

	const shareEnabled = options.share === true;
	const sessionEnabled = Boolean(options.sessionFile || options.sessionDir) || shareEnabled;
	const skillNames = options.skills ?? agent.skills ?? [];
	const skillCwd = options.cwd ?? runtimeCwd;
	const { resolved: resolvedSkills, missing: missingSkills } = resolveSkillsWithFallback(skillNames, skillCwd, runtimeCwd);
	if (skillNames.some((skill) => skill.trim() === "subagent") && missingSkills.includes("subagent")) {
		return { agent: agentName, task, exitCode: 1, messages: [], usage: emptyUsage(), error: "Skills not found: subagent" };
	}
	let systemPrompt = agent.systemPrompt?.trim() || "";
	if (resolvedSkills.length > 0) {
		const skillInjection = buildSkillInjection(resolvedSkills);
		systemPrompt = systemPrompt ? `${systemPrompt}\n\n${skillInjection}` : skillInjection;
	}

	const rawCandidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		options.currentModel,
		agent.fallbackThinkingLevels,
	);
	const filteredCandidates = filterSpawnableModelCandidates({
		candidates: rawCandidates,
		availableModels: options.availableModels,
		knownModelProviders: options.knownModelProviders,
		currentModel: options.currentModel,
	});
	const candidates = filteredCandidates.candidates;
	const fastModeCwd = options.cwd ?? runtimeCwd;
	const fastModeSettings = getSubagentCodexFastModeSettings(fastModeCwd);
	const fastModeScope = resolveSubagentCodexFastModeScope(options.workflowStageSubagentGuard);
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [...filteredCandidates.skippedAttempts];
	const aggregateUsage = emptyUsage();
	const attemptNotes: string[] = filteredCandidates.skippedAttempts.map((attempt) => `[fallback] ${attempt.error}`);
	const pendingAttemptNotes: string[] = [];
	let totalToolCount = 0;
	let totalDurationMs = 0;

	let artifactPathsResult: ArtifactPaths | undefined;
	let jsonlPath: string | undefined;
	if (options.artifactsDir && options.artifactConfig?.enabled !== false) {
		artifactPathsResult = getArtifactPaths(options.artifactsDir, options.runId, agentName, options.index);
		ensureArtifactsDir(options.artifactsDir);
		if (options.artifactConfig?.includeInput !== false) {
			writeArtifact(artifactPathsResult.inputPath, `# Task for ${agentName}\n\n${task}`);
		}
		if (options.artifactConfig?.includeJsonl !== false) jsonlPath = artifactPathsResult.jsonlPath;
	}
	const persistArtifacts = (value: SingleResult): void => {
		if (!artifactPathsResult || options.artifactConfig?.enabled === false) return;
		value.artifactPaths = artifactPathsResult;
		if (options.artifactConfig?.includeOutput !== false) {
			writeArtifact(artifactPathsResult.outputPath, artifactOutputByResult.get(value) ?? value.finalOutput ?? "");
		}
		if (options.artifactConfig?.includeMetadata !== false) {
			writeMetadata(artifactPathsResult.metadataPath, {
				runId: options.runId, agent: agentName, task, exitCode: value.exitCode,
				usage: value.usage, model: value.model, fastMode: value.fastMode,
				attemptedModels: value.attemptedModels, modelAttempts: value.modelAttempts,
				durationMs: value.progressSummary?.durationMs, toolCount: value.progressSummary?.toolCount,
				error: value.error, skills: value.skills, skillsWarning: value.skillsWarning, timestamp: Date.now(),
			});
		}
	};

	let lastResult: SingleResult | undefined;
	const modelsToTry = candidates.length > 0 ? candidates : (rawCandidates.length === 0 ? [undefined] : []);
	for (let i = 0; i < modelsToTry.length; i++) {
		const candidate = modelsToTry[i];
		if (candidate) attemptedModels.push(candidate);
		const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);
		const detachedExit = options.onDetachedExit;
		let attemptOptions: RunSyncOptions = {
			...options,
			onDetachedExit: (recovered) => {
				recovered.attemptedModels = attemptedModels.length > 0 ? [...attemptedModels] : undefined;
				const recoveredModel = applyThinkingSuffix(candidate, agent.thinking) ?? recovered.model ?? agent.model ?? "default";
				const completedAttempt: ModelAttempt = {
					model: recoveredModel,
					reasoningLevel: resolveEffectiveThinking(recoveredModel, agent.thinking),
					success: recovered.exitCode === 0 && !recovered.error,
					exitCode: recovered.exitCode,
					error: recovered.error,
					usage: { ...recovered.usage },
				};
				recovered.modelAttempts = [...modelAttempts.slice(0, -1), completedAttempt];
				persistArtifacts(recovered);
				detachedExit?.(recovered);
			},
		};
		if (i < modelsToTry.length - 1 && options.onUpdate) {
			const forwardUpdate = options.onUpdate;
			attemptOptions = {
				...attemptOptions,
				onUpdate: (update) => {
					if (shouldSuppressIntermediateRetryableFailureUpdate(update)) return;
					forwardUpdate(update);
				},
			};
		}
		const result = await runSingleAttemptWithStructuredOutputRetries(runtimeCwd, agent, task, candidate, attemptOptions, {
			sessionEnabled,
			systemPrompt,
			resolvedSkillNames: resolvedSkills.length > 0 ? resolvedSkills.map((skill) => skill.name) : undefined,
			skillsWarning: missingSkills.length > 0 ? `Skills not found: ${missingSkills.join(", ")}` : undefined,
			jsonlPath,
			artifactPaths: artifactPathsResult,
			attemptNotes,
			outputSnapshot,
			fastModeSettings,
			fastModeScope,
			originalTask: task,
		});
		lastResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;
		const attemptSucceeded = result.exitCode === 0 && !result.error;
		const attemptModel = applyThinkingSuffix(candidate, agent.thinking) ?? result.model ?? agent.model ?? "default";
		const attempt: ModelAttempt = {
			model: attemptModel,
			reasoningLevel: resolveEffectiveThinking(attemptModel, agent.thinking),
			success: attemptSucceeded,
			exitCode: result.exitCode,
			error: result.error,
			usage: { ...result.usage },
		};
		modelAttempts.push(attempt);
		if (attemptSucceeded) break;
		if (result.detached) break;
		const retrySignal = modelFailureSignalByResult.get(result) ?? result.error;
		if (isRetryableModelFailure(retrySignal) && i < modelsToTry.length - 1) {
			pendingAttemptNotes.push(formatModelAttemptNote(attempt, modelsToTry[i + 1]));
			continue;
		}
		attemptNotes.push(...pendingAttemptNotes);
		break;
	}

	const result = lastResult ?? {
		agent: agentName,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: modelAttempts.length > 0
			? "No spawnable subagent model candidates after pre-spawn filtering."
			: "Subagent did not produce a result.",
	} satisfies SingleResult;

	result.usage = aggregateUsage;
	result.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined;
	result.modelAttempts = modelAttempts.length > 0 ? modelAttempts : undefined;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	if (attemptNotes.length > 0 && result.progress) {
		result.progress.recentOutput = [...attemptNotes, ...result.progress.recentOutput];
		if (result.progress.recentOutput.length > 50) result.progress.recentOutput.splice(50);
	}

	if (artifactPathsResult && options.artifactConfig?.enabled !== false && !result.detached) {
		persistArtifacts(result);

		if (options.maxOutput) {
			const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
			const truncationResult = truncateOutput(result.finalOutput ?? "", config, artifactPathsResult.outputPath);
			if (truncationResult.truncated) result.truncation = truncationResult;
		}
	} else if (options.maxOutput) {
		const config = { ...DEFAULT_MAX_OUTPUT, ...options.maxOutput };
		const truncationResult = truncateOutput(result.finalOutput ?? "", config);
		if (truncationResult.truncated) result.truncation = truncationResult;
	}

	if (options.sessionFile && (existsSync(options.sessionFile) || result.messages?.length)) {
		result.sessionFile = options.sessionFile;
	} else if (shareEnabled && options.sessionDir) {
		const sessionFile = findLatestSessionFile(options.sessionDir);
		if (sessionFile) result.sessionFile = sessionFile;
	}

	return result;
}
