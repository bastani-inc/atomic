import { Agent, type AgentMessage, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, isContextOverflow, streamSimple } from "@earendil-works/pi-ai";
import { formatCopilotProviderError } from "../copilot-errors.ts";
import { getEffectiveInputBudget } from "../context-window.ts";
import {
	buildEvictionTargets,
	buildMaxFeasibleDeletionRequest,
	computeCompactionFeasibility,
	computeLivenessBudget,
	type CompactionFitStrategy,
} from "./context-compaction-feasibility.ts";
import type {
	CompactableTranscript,
	ContextCompactionParameters,
	ContextCompactionPreparation,
	ValidatedContextDeletionResult,
} from "./context-compaction-types.ts";
import { CONTEXT_COMPACTION_AUTO_QUERY } from "./context-compaction-types.ts";
import {
	createContextCompactionBudgetDetails,
	contextCompactionProgressKey,
	contextCompactionProgressPercent,
	contextCompactionTargetLabel,
	contextCompactionTargetMet,
	formatErrorMessage,
} from "./context-compaction-metrics.ts";
import {
	getTranscriptCompactionParameters,
	normalizeContextCompactionParameters,
} from "./context-compaction-strategy.ts";
import {
	CONTEXT_COMPACTION_BUDGET_TOOL_NAME,
	CONTEXT_DELETE_TOOL_NAME,
	CONTEXT_GREP_DELETE_TOOL_NAME,
	CONTEXT_READ_ENTRY_TOOL_NAME,
	CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME,
} from "./context-deletion-tool-definitions.ts";
import { createContextDeletionTool } from "./context-deletion-tools.ts";
import { validateContextDeletionRequest } from "./context-deletion-application.ts";
import {
	buildContextCompactionPrompt,
	CONTEXT_COMPACTION_SYSTEM_PROMPT,
	writeContextCompactionTranscriptFile,
} from "./context-compaction-prompt.ts";

function createContextCompactionTargetNudgeMessage(
	result: ValidatedContextDeletionResult | undefined,
	parameters: ContextCompactionParameters,
): AgentMessage {
	const currentReductionPercent = contextCompactionProgressPercent(result);
	const targetLabel = contextCompactionTargetLabel(parameters);
	const tokensToDelete = result
		? createContextCompactionBudgetDetails(result.stats, 0, undefined, parameters, 0, 0).tokensToDeleteForTarget
		: undefined;
	const remainingText = tokensToDelete !== undefined ? ` Delete about ${tokensToDelete} more token(s) if safe candidates exist.` : "";
	return {
		role: "user",
		content: [
			{
				type: "text",
				text: `The strict ${targetLabel} context-reduction requirement is not met yet; current validated reduction is ${currentReductionPercent}%.${remainingText} Continue removing low-value message entries or message content blocks using ${CONTEXT_DELETE_TOOL_NAME} or ${CONTEXT_GREP_DELETE_TOOL_NAME}. Use the focus query ${JSON.stringify(parameters.query)} to preserve relevant context. Call ${CONTEXT_COMPACTION_BUDGET_TOOL_NAME} to verify progress, and do not provide a final answer until the validated reduction is at least ${targetLabel}.`,
			},
		],
		timestamp: Date.now(),
	};
}
function createContextCompactionAssistantMessage(
	model: Model<Api>,
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage !== undefined ? { errorMessage } : {}),
		timestamp: Date.now(),
	};
}

function createContextCompactionStopStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	queueMicrotask(() => {
		const message = createContextCompactionAssistantMessage(model, [{ type: "text", text }], "stop");
		stream.push({ type: "done", reason: "stop", message });
		stream.end(message);
	});
	return stream;
}

function isContextCompactionOverflowError(model: Model<Api>, errorMessage: string): boolean {
	return isContextOverflow(
		createContextCompactionAssistantMessage(model, [], "error", errorMessage),
		model.contextWindow,
	);
}

interface ContextDeletionRun {
	validatedResult: ValidatedContextDeletionResult | undefined;
	lastToolError: string | undefined;
	providerError: string | undefined;
}

async function runContextDeletionAssistant(
	inputTranscript: CompactableTranscript,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel: ThinkingLevel = "off",
	parameters: ContextCompactionParameters = getTranscriptCompactionParameters(inputTranscript),
): Promise<ContextDeletionRun> {
	const transcript: CompactableTranscript = { ...inputTranscript, parameters };
	const maxTokens = model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY;
	if (signal?.aborted) {
		throw new Error("Context compaction failed: Request was aborted");
	}
	const transcriptFile = writeContextCompactionTranscriptFile(transcript);
	const promptMessage: AgentMessage = {
		role: "user",
		content: [{ type: "text", text: buildContextCompactionPrompt(transcript, transcriptFile.path, parameters) }],
		timestamp: Date.now(),
	};
	const deletionTool = createContextDeletionTool(transcript, { contextWindow: model.contextWindow, ...parameters });
	const agent = new Agent({
		initialState: {
			systemPrompt: CONTEXT_COMPACTION_SYSTEM_PROMPT,
			model,
			thinkingLevel,
			tools: deletionTool.tools,
		},
		toolExecution: "parallel",
		streamFn: async (requestModel, context, streamOptions) => {
			const currentResult = deletionTool.getValidatedResult();
			if (contextCompactionTargetMet(currentResult, parameters)) {
				return createContextCompactionStopStream(
					requestModel,
					`Reached the strict ${contextCompactionTargetLabel(parameters)} context-reduction requirement (${currentResult.stats.percentReduction}%); using the validated deletions recorded so far.`,
				);
			}
			return streamSimple(requestModel, context, {
				...streamOptions,
				maxTokens,
				apiKey,
				headers: headers ?? streamOptions?.headers,
			});
		},
	});

	let lastNudgedProgressKey: string | undefined;
	const unsubscribeNudge = agent.subscribe((event, eventSignal) => {
		if (event.type !== "turn_end" || signal?.aborted || eventSignal.aborted) return;
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;
		if (event.message.content.some((content) => content.type === "toolCall")) return;
		const currentResult = deletionTool.getValidatedResult();
		if (contextCompactionTargetMet(currentResult, parameters)) return;
		const progressKey = contextCompactionProgressKey(currentResult);
		if (progressKey === lastNudgedProgressKey) return;
		lastNudgedProgressKey = progressKey;
		agent.followUp(createContextCompactionTargetNudgeMessage(currentResult, parameters));
	});

	const abortOnSignal = () => agent.abort();
	signal?.addEventListener("abort", abortOnSignal, { once: true });
	try {
		await agent.prompt(promptMessage);
	} catch (error) {
		if (signal?.aborted) {
			throw new Error("Context compaction failed: Request was aborted");
		}
		throw new Error(`Context compaction failed: ${formatCopilotProviderError(model.provider, formatErrorMessage(error))}`);
	} finally {
		signal?.removeEventListener("abort", abortOnSignal);
		unsubscribeNudge();
		transcriptFile.cleanup();
	}

	if (signal?.aborted) {
		throw new Error("Context compaction failed: Request was aborted");
	}
	if (agent.state.errorMessage) {
		const formattedErrorMessage = formatCopilotProviderError(model.provider, agent.state.errorMessage);
		if (isContextCompactionOverflowError(model, agent.state.errorMessage)) {
			return {
				validatedResult: deletionTool.getValidatedResult(),
				lastToolError: deletionTool.getLastError(),
				providerError: formattedErrorMessage === agent.state.errorMessage ? undefined : formattedErrorMessage,
			};
		}
		throw new Error(`Context compaction failed: ${formattedErrorMessage}`);
	}
	if (deletionTool.getCallCount() === 0) {
		throw new Error(
			`Context compaction did not call any transcript inspection, budget, or deletion tools (${CONTEXT_SEARCH_TRANSCRIPT_TOOL_NAME}, ${CONTEXT_READ_ENTRY_TOOL_NAME}, ${CONTEXT_COMPACTION_BUDGET_TOOL_NAME}, ${CONTEXT_DELETE_TOOL_NAME}, or ${CONTEXT_GREP_DELETE_TOOL_NAME})`,
		);
	}
	return {
		validatedResult: deletionTool.getValidatedResult(),
		lastToolError: deletionTool.getLastError(),
		providerError: undefined,
	};
}

function hasMetContextCompactionTarget(
	run: ContextDeletionRun,
	parameters: ContextCompactionParameters,
): run is ContextDeletionRun & { validatedResult: ValidatedContextDeletionResult } {
	return contextCompactionTargetMet(run.validatedResult, parameters);
}

function formatContextCompactionTargetFailureMessage(
	attempts: readonly ContextDeletionRunAttempt[],
	parameters: ContextCompactionParameters,
): string {
	const targetLabel = contextCompactionTargetLabel(parameters);
	if (attempts.length === 0) {
		return `Context compaction did not meet the strict ${targetLabel} reduction requirement`;
	}
	const attemptDetails = attempts
		.map((attempt) => {
			const reduction = contextCompactionProgressPercent(attempt.validatedResult);
			const deletionCount = attempt.validatedResult?.deletedTargets.length ?? 0;
			const toolErrorText = attempt.lastToolError ? `; last deletion tool error: ${attempt.lastToolError}` : "";
			const providerErrorText = attempt.providerError ? `; provider error: ${attempt.providerError}` : "";
			return `attempt reached ${reduction}% with ${deletionCount} validated deletion target(s)${toolErrorText}${providerErrorText}`;
		})
		.join("; ");
	return `Context compaction did not meet the strict ${targetLabel} reduction requirement; ${attemptDetails}`;
}

interface ContextDeletionRunAttempt extends ContextDeletionRun {}

export async function contextCompact(
	preparation: ContextCompactionPreparation,
	model: Model<Api>,
	apiKey: string,
	headers?: Record<string, string>,
	signal?: AbortSignal,
	thinkingLevel: ThinkingLevel = "off",
): Promise<ValidatedContextDeletionResult> {
	const parameters = normalizeContextCompactionParameters(
		preparation.parameters ?? preparation.transcript.parameters,
		preparation.parameters?.query ?? preparation.transcript.parameters?.query ?? CONTEXT_COMPACTION_AUTO_QUERY,
	);
	const transcript: CompactableTranscript = { ...preparation.transcript, parameters };
	const attempts: ContextDeletionRunAttempt[] = [];
	const standardRun = await runContextDeletionAssistant(
		transcript,
		model,
		apiKey,
		headers,
		signal,
		thinkingLevel,
		parameters,
	);

	// meet_target: the planner met the quality target under full protection AND
	// the result fits the liveness budget. If the target is met but the result
	// still overflows the liveness budget, fall through to the graduated ladder
	// (best_effort / evict_protected / strict failure) instead of returning a
	// result that cannot keep the session continuable.
	const budget = computeLivenessBudget(getEffectiveInputBudget(model), transcript.settings.reserveTokens);
	if (
		hasMetContextCompactionTarget(standardRun, parameters) &&
		standardRun.validatedResult.stats.tokensAfter <= budget.tokens
	) {
		return withFitStrategy(standardRun.validatedResult, "meet_target");
	}
	// Graduated-protection fallback ladder. Feasibility decides which strategy is
	// required; the first strategy that produces a budget-fitting validated result
	// wins. See specs/2026-06-27-context-compaction-graduated-protection.md.
	const feasibility = computeCompactionFeasibility(transcript, parameters, budget);
	const plannerResult = standardRun.validatedResult;
	const maxFeasibleRequest = buildMaxFeasibleDeletionRequest(transcript);
	let maxFeasibleResult: ValidatedContextDeletionResult | undefined;
	try {
		maxFeasibleResult = validateContextDeletionRequest(maxFeasibleRequest, transcript);
	} catch {
		// Validator disagrees with the oracle's conservative feasible request.
		// Keep the planner result as a fallback so strict failure still reports honestly.
	}

	// best_effort (planner fits): the quality target is provably infeasible AND
	// the planner's validated result already fits the liveness budget. A merely
	// under-performing planner (feasible target, missed reduction) is NOT accepted
	// here — it falls through to the maximal-feasible or strict-failure path.
	if (
		plannerResult &&
		feasibility.targetFeasible === false &&
		plannerResult.stats.tokensAfter <= budget.tokens
	) {
		return withFitStrategy(plannerResult, "best_effort");
	}

	// best_effort (maximal feasible unprotected fits): the planner's own result
	// is over budget (or absent), but a more aggressive unprotected deletion set
	// would fit the budget. Deterministically build and validate the maximal
	// feasible unprotected deletion request and accept it if it fits — including
	// the no-op case where the protected transcript already fits with zero safe
	// deletions.
	if (
		feasibility.fitsBudgetAtMaxDeletion === true &&
		maxFeasibleResult &&
		maxFeasibleResult.stats.tokensAfter <= budget.tokens
	) {
		return withFitStrategy(maxFeasibleResult, "best_effort");
	}

	// evict_protected: protected mass overflows the budget. Start from the
	// deterministic maximal feasible unprotected deletion set, then force-evict
	// oldest protected task-bearing entries only as needed. This avoids evicting
	// protected context just because the planner missed unprotected deletions.
	if (feasibility.fitsBudgetAtMaxDeletion === false) {
		const evictionBaseline = maxFeasibleResult?.deletedTargets ?? plannerResult?.deletedTargets ?? [];
		const eviction = buildEvictionTargets(transcript, evictionBaseline, budget);
		if (eviction.deletions.length > 0) {
			try {
				const evictedResult = validateContextDeletionRequest(
					{ deletions: eviction.deletions },
					transcript,
					{ evict: true },
				);
				if (evictedResult.stats.tokensAfter <= budget.tokens && evictedResult.deletedTargets.length > 0) {
					return withFitStrategy(
						{
							...evictedResult,
							evictedProtectedEntryIds: eviction.evictedProtectedEntryIds,
						},
						"evict_protected",
					);
				}
			} catch {
				// Eviction validation failed (e.g. tool-pairing invariant). Fall through
				// to the strict-failure error so the run reports honestly instead of
				// silently swallowing the failure.
			}
		}
	}

	attempts.push({ ...standardRun });
	throw new Error(formatContextCompactionTargetFailureMessage(attempts, parameters));
}

/**
 * Stamp a `ValidatedContextDeletionResult` with the strategy that produced it
 * and the achieved reduction percent, without changing the deletion plan.
 */
function withFitStrategy(
	result: ValidatedContextDeletionResult,
	fitStrategy: CompactionFitStrategy,
): ValidatedContextDeletionResult {
	return {
		...result,
		fitStrategy,
		achievedReductionPercent: result.stats.percentReduction,
	};
}
