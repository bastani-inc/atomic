import type { AgentConfig } from "../../agents/agents.ts";
import type { RunSyncOptions, SingleResult } from "../../shared/types.ts";
import {
	STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS,
	formatStructuredOutputCorrectionPrompt,
	isStructuredOutputContractError,
	latestStructuredOutputToolErrorFromMessages,
} from "../shared/structured-output.ts";
import { emptyUsage, sumUsage } from "./execution-utils.ts";
import { runSingleAttempt } from "./execution-attempt.ts";
import type { RunSingleAttemptShared } from "./execution-attempt-types.ts";
import { shouldSuppressIntermediateStructuredOutputFailureUpdate, type RunSyncUpdate } from "./execution-updates.ts";

export async function runSingleAttemptWithStructuredOutputRetries(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	model: string | undefined,
	options: RunSyncOptions,
	shared: RunSingleAttemptShared,
): Promise<SingleResult> {
	let nextTask = task;
	let correctiveAttempts = 0;
	let finalResult: SingleResult | undefined;
	const aggregateUsage = emptyUsage();
	let totalToolCount = 0;
	let totalDurationMs = 0;

	while (true) {
		const suppressIntermediateStructuredOutputFailure = options.structuredOutput !== undefined
			&& correctiveAttempts < STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS
			&& options.onUpdate !== undefined;
		const attemptOptions = suppressIntermediateStructuredOutputFailure
			? {
				...options,
				onUpdate: (update: RunSyncUpdate) => {
					if (shouldSuppressIntermediateStructuredOutputFailureUpdate(update)) return;
					options.onUpdate?.(update);
				},
			}
			: options;
		const result = await runSingleAttempt(runtimeCwd, agent, nextTask, model, attemptOptions, shared);
		finalResult = result;
		sumUsage(aggregateUsage, result.usage);
		totalToolCount += result.progressSummary?.toolCount ?? 0;
		totalDurationMs += result.progressSummary?.durationMs ?? 0;

		if (!options.structuredOutput || !isStructuredOutputContractError(result.error)) break;
		const correctionError = latestStructuredOutputToolErrorFromMessages(result.messages) ?? result.error ?? "Structured output contract failed.";
		if (correctiveAttempts >= STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS) {
			result.error = correctionError;
			break;
		}
		correctiveAttempts += 1;
		nextTask = formatStructuredOutputCorrectionPrompt({
			originalTask: task,
			error: correctionError,
			attempt: correctiveAttempts,
		});
	}

	const result = finalResult ?? {
		agent: agent.name,
		task,
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
		error: "Subagent did not produce a result.",
	} satisfies SingleResult;
	result.usage = aggregateUsage;
	result.progressSummary = {
		toolCount: totalToolCount,
		tokens: aggregateUsage.input + aggregateUsage.output,
		durationMs: totalDurationMs,
	};
	return result;
}
