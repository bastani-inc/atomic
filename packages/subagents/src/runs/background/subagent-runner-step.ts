import * as fs from "node:fs";
import * as path from "node:path";
import { getArtifactPaths } from "../../shared/artifacts.ts";
import { detectSubagentError } from "../../shared/utils.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { captureSingleOutputSnapshot, finalizeSingleOutput, formatSavedOutputReference, resolveSingleOutput, type SingleOutputSnapshot } from "../shared/single-output.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { outputEntryFromAsyncResult, resolveOutputReferences } from "../shared/chain-outputs.ts";
import {
	STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS,
	createStructuredOutputRuntime,
	formatStructuredOutputCorrectionPrompt,
	isStructuredOutputContractError,
	latestStructuredOutputToolErrorFromMessages,
	readStructuredOutput,
} from "../shared/structured-output.ts";
import { formatModelAttemptNote, isRetryableModelFailure } from "../shared/model-fallback.ts";
import type { ArtifactPaths, ModelAttempt } from "../../shared/types.ts";
import type { RunPiStreamingResult, SingleStepContext, SubagentStep } from "./subagent-runner-types.ts";
import { emptyUsage, fastModeForStepAttempt } from "./subagent-runner-utils.ts";
import { runPiStreaming } from "./subagent-runner-streaming.ts";

export { outputEntryFromAsyncResult };

export async function runSingleStep(
	step: SubagentStep,
	ctx: SingleStepContext,
): Promise<{
	agent: string;
	output: string;
	exitCode: number | null;
	error?: string;
	model?: string;
	fastMode?: boolean;
	attemptedModels?: string[];
	modelAttempts?: ModelAttempt[];
	artifactPaths?: ArtifactPaths;
	interrupted?: boolean;
	sessionFile?: string;
	intercomTarget?: string;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	structuredOutputSchemaPath?: string;
}> {
	const effectiveStructuredOutput = step.structuredOutput ?? (step.structuredOutputSchema
		? createStructuredOutputRuntime(step.structuredOutputSchema, path.join(path.dirname(ctx.outputFile), "structured-output"))
		: undefined);
	const placeholderRegex = new RegExp(ctx.placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
	let task = step.task.replace(placeholderRegex, () => ctx.previousOutput);
	task = resolveOutputReferences(task, ctx.outputs ?? {});
	const sessionEnabled = Boolean(step.sessionFile) || ctx.sessionEnabled;
	const sessionDir = step.sessionFile ? undefined : ctx.sessionDir;

	let artifactPaths: ArtifactPaths | undefined;
	if (ctx.artifactsDir && ctx.artifactConfig?.enabled !== false) {
		const index = ctx.flatStepCount > 1 ? ctx.flatIndex : undefined;
		artifactPaths = getArtifactPaths(ctx.artifactsDir, ctx.id, step.agent, index);
		fs.mkdirSync(ctx.artifactsDir, { recursive: true });
		if (ctx.artifactConfig?.includeInput !== false) {
			fs.writeFileSync(artifactPaths.inputPath, `# Task for ${step.agent}\n\n${task}`, "utf-8");
		}
	}

	// `!== undefined` is intentional: an explicitly empty array means every candidate
	// was removed by pre-spawn filtering (see filterSpawnableModelCandidates) and must
	// be respected — do not "simplify" this back to `.length > 0`, which would spawn a
	// doomed default attempt. The empty case is surfaced as an error below.
	const candidates = step.modelCandidates !== undefined
		? step.modelCandidates
		: step.model
			? [step.model]
			: [undefined];
	const attemptedModels: string[] = [];
	const modelAttempts: ModelAttempt[] = [...(step.modelAttempts ?? [])];
	const attemptNotes: string[] = modelAttempts
		.filter((attempt) => !attempt.success && attempt.exitCode === null && attempt.error)
		.map((attempt) => `[fallback] ${attempt.error}`);
	const pendingAttemptNotes: string[] = [];
	const eventsPath = path.join(path.dirname(ctx.outputFile), "events.jsonl");
	let finalResult: RunPiStreamingResult | undefined;
	let finalFastMode: boolean | undefined;
	let finalOutputSnapshot: SingleOutputSnapshot | undefined;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const attemptFastMode = fastModeForStepAttempt(step, candidate);
		ctx.onAttemptStart?.({ model: candidate, thinking: resolveEffectiveThinking(candidate, step.thinking), fastMode: attemptFastMode ? true : undefined });
		if (candidate) attemptedModels.push(candidate);
		let nextTask = task;
		let correctiveAttempts = 0;
		let tryNextModel = false;

		while (true) {
			const outputSnapshot = captureSingleOutputSnapshot(step.outputPath);
			if (effectiveStructuredOutput) {
				try {
					if (fs.existsSync(effectiveStructuredOutput.outputPath)) fs.unlinkSync(effectiveStructuredOutput.outputPath);
				} catch {
					// Missing/stale structured-output files are handled after the child exits.
				}
			}
			const { args, env, tempDir } = buildPiArgs({
				baseArgs: ["--mode", "json", "-p"],
				task: nextTask,
				sessionEnabled,
				sessionDir,
				sessionFile: step.sessionFile,
				model: candidate,
				inheritProjectContext: step.inheritProjectContext,
				inheritSkills: step.inheritSkills,
				tools: step.tools,
				extensions: step.extensions,
				systemPrompt: step.systemPrompt,
				systemPromptMode: step.systemPromptMode,
				mcpDirectTools: step.mcpDirectTools,
				cwd: step.cwd ?? ctx.cwd,
				promptFileStem: step.agent,
				intercomSessionName: ctx.childIntercomTarget,
				orchestratorIntercomTarget: ctx.orchestratorIntercomTarget,
				runId: ctx.id,
				childAgentName: step.agent,
				childIndex: ctx.flatIndex,
				parentEventSink: ctx.nestedRoute?.eventSink,
				parentControlInbox: ctx.nestedRoute?.controlInbox,
				parentRootRunId: ctx.nestedRoute?.rootRunId,
				parentCapabilityToken: ctx.nestedRoute?.capabilityToken,
				codexFastModeSettings: step.codexFastModeSettings,
				codexFastModeScope: step.codexFastModeScope,
				structuredOutput: effectiveStructuredOutput,
			});
			const run = await runPiStreaming(
				args,
				step.cwd ?? ctx.cwd,
				ctx.outputFile,
				env,
				ctx.piPackageRoot,
				ctx.piArgv1,
				step.maxSubagentDepth,
				step.workflowStageSubagentGuard ?? ctx.workflowStageSubagentGuard,
				{ eventsPath, runId: ctx.id, stepIndex: ctx.flatIndex, agent: step.agent },
				ctx.registerInterrupt,
				ctx.onChildEvent,
			);
			cleanupTempDir(tempDir);

			const hiddenError = run.exitCode === 0 && !run.error ? detectSubagentError(run.messages) : null;
			let structuredOutput: unknown;
			let structuredError: string | undefined;
			if (effectiveStructuredOutput && run.exitCode === 0 && !run.error && !hiddenError?.hasError) {
				const structured = readStructuredOutput(effectiveStructuredOutput);
				if (structured.error) structuredError = structured.error;
				else structuredOutput = structured.value;
			}
			const structuredContractError = structuredError
				? latestStructuredOutputToolErrorFromMessages(run.messages) ?? structuredError
				: undefined;
			const effectiveExitCode = structuredContractError
				? 1
				: hiddenError?.hasError
				? (hiddenError.exitCode ?? 1)
				: run.error && run.exitCode === 0
					? 1
					: run.exitCode;
			const error = structuredContractError
				?? (hiddenError?.hasError
					? hiddenError.details
						? `${hiddenError.errorType} failed (exit ${effectiveExitCode}): ${hiddenError.details}`
						: `${hiddenError.errorType} failed with exit code ${effectiveExitCode}`
					: run.error || (run.exitCode !== 0 && run.stderr.trim() ? run.stderr.trim() : undefined));
			const attemptModel = candidate ?? run.model ?? step.model ?? "default";
			const attempt: ModelAttempt = {
				model: attemptModel,
				reasoningLevel: resolveEffectiveThinking(attemptModel, step.thinking),
				success: effectiveExitCode === 0 && !error,
				exitCode: effectiveExitCode,
				error,
				usage: run.usage,
			};
			modelAttempts.push(attempt);
			finalFastMode = attemptFastMode;
			finalOutputSnapshot = outputSnapshot;
			finalResult = { ...run, exitCode: effectiveExitCode, model: candidate ?? run.model, error, structuredOutput } as RunPiStreamingResult & { structuredOutput?: unknown };
			if (attempt.success) break;
			if (
				effectiveStructuredOutput
				&& isStructuredOutputContractError(structuredContractError)
				&& correctiveAttempts < STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS
			) {
				correctiveAttempts += 1;
				nextTask = formatStructuredOutputCorrectionPrompt({
					originalTask: task,
					error: structuredContractError!,
					attempt: correctiveAttempts,
				});
				continue;
			}
			const retrySignal = run.modelFailureSignal ?? error;
			if (
				structuredContractError === undefined
				&& hiddenError?.hasError !== true
				&& isRetryableModelFailure(retrySignal)
				&& index < candidates.length - 1
			) {
				pendingAttemptNotes.push(formatModelAttemptNote(attempt, candidates[index + 1]));
				tryNextModel = true;
				break;
			}
			attemptNotes.push(...pendingAttemptNotes);
			break;
		}
		if (!tryNextModel) break;
	}

	if (!finalResult && candidates.length === 0 && modelAttempts.length > 0) {
		finalResult = {
			stderr: "",
			exitCode: 1,
			messages: [],
			usage: emptyUsage(),
			error: "No spawnable subagent model candidates after pre-spawn filtering.",
			finalOutput: "",
		};
	}

	const rawOutput = finalResult?.finalOutput ?? "";
	const outputForPersistence = rawOutput;
	const resolvedOutput = step.outputPath && finalResult?.exitCode === 0
		? resolveSingleOutput(step.outputPath, outputForPersistence, finalOutputSnapshot)
		: { fullOutput: outputForPersistence };
	const output = resolvedOutput.fullOutput;
	const outputReference = resolvedOutput.savedPath ? formatSavedOutputReference(resolvedOutput.savedPath, output) : undefined;
	let outputForSummary = output;
	if (attemptNotes.length > 0) {
		outputForSummary = `${attemptNotes.join("\n")}\n\n${outputForSummary}`.trim();
	}
	const finalizedOutput = finalizeSingleOutput({
		fullOutput: outputForSummary,
		outputPath: step.outputPath,
		outputMode: step.outputMode,
		exitCode: finalResult?.exitCode ?? 1,
		savedPath: resolvedOutput.savedPath,
		outputReference,
		saveError: resolvedOutput.saveError,
	});
	outputForSummary = finalizedOutput.displayOutput;
	const effectiveFinalExitCode = finalResult?.exitCode ?? 1;
	const effectiveFinalError = finalResult?.error;

	if (artifactPaths && ctx.artifactConfig?.enabled !== false) {
		if (ctx.artifactConfig?.includeOutput !== false) {
			fs.writeFileSync(artifactPaths.outputPath, output, "utf-8");
		}
		if (ctx.artifactConfig?.includeMetadata !== false) {
			fs.writeFileSync(
				artifactPaths.metadataPath,
				JSON.stringify({
					runId: ctx.id,
					agent: step.agent,
					task,
					exitCode: effectiveFinalExitCode,
					model: finalResult?.model,
					...(finalFastMode ? { fastMode: true } : {}),
					attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
					modelAttempts,
					skills: step.skills,
					timestamp: Date.now(),
				}, null, 2),
				"utf-8",
			);
		}
	}

	return {
		agent: step.agent,
		output: outputForSummary,
		exitCode: effectiveFinalExitCode,
		error: effectiveFinalError,
		sessionFile: step.sessionFile,
		intercomTarget: ctx.childIntercomTarget,
		model: finalResult?.model,
		...(finalFastMode ? { fastMode: true } : {}),
		attemptedModels: attemptedModels.length > 0 ? attemptedModels : undefined,
		modelAttempts,
		artifactPaths,
		interrupted: finalResult?.interrupted,
		structuredOutput: (finalResult as (RunPiStreamingResult & { structuredOutput?: unknown }) | undefined)?.structuredOutput,
		structuredOutputPath: effectiveStructuredOutput?.outputPath,
		structuredOutputSchemaPath: effectiveStructuredOutput?.schemaPath,
	};
}
