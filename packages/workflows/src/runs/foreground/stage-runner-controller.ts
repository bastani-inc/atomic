import {
	type AgentSession,
	AutoRoutingInferenceError,
	type CreateAgentSessionOptions,
	convertToLlm,
	type DetachedToolCall,
	type DetachedToolResult,
	isExtensionStartupFailure,
	isTaskCleanupError,
	isTransientExtensionStartupFailure,
	type ModelConstraints,
	type ModelRoute,
	type PromptOptions,
	parkWorkflowStageForRelease,
	parseModelConstraints,
	reportDebug,
	type SessionManager,
	type SessionStore,
	type StructuredOutputCapture,
	setsProviders,
} from "@bastani/atomic";
import { raceAbort } from "../../shared/abort.js";
import type { StageWaitSnapshot } from "../../shared/authoring-contract-stage.js";
import { RESUME_CONTINUATION_PROMPT } from "../../shared/resume-continuation.js";
import type { StageStartupPhase, StageStartupSnapshot } from "../../shared/stage-startup.js";
import {
	STAGE_WAIT_RETRY_ATTEMPTS,
	STAGE_WAIT_RETRY_BUDGET_MS,
	stageReopenFailureCause,
	stageWaitRetryDelayMs,
} from "../../shared/stage-wait.js";
import {
	StageRehydrationError,
	StageReleasedError,
	type StageReleasedProperty,
	StageReleaseError,
} from "../../shared/stage-wait-errors.js";
import type {
	StageContext,
	StageExecutionMeta,
	StageOptions,
	StageSendUserMessageOptions,
	StageUserMessageContent,
	WorkflowModelAttempt,
	WorkflowModelCatalogPort,
	WorkflowModelUsage,
	WorkflowModelValue,
} from "../../shared/types.js";
import { classifyFailureFrom } from "../../shared/workflow-failures-classifier.js";
import { ProcessCleanupUnconfirmedError } from "../../shared/workflow-infrastructure-error.js";
import {
	buildModelCandidatesFromCatalog,
	errorMessage,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	isUnrecognizedModelFailure,
	type ModelFallbackFailureOptions,
	resolveScopedModelsFromCatalog,
	type WorkflowResolvedModelCandidate,
	type WorkflowResolvedScopedModel,
	workflowModelId,
} from "../shared/model-fallback.js";
import {
	isWorkflowRateLimit,
	providerCooldownMs,
	providerRateLimitSnapshot,
	providerUnavailableMs,
	recordProviderRateLimit,
	workflowModelName,
	workflowProviderId,
	workflowRetryHint,
} from "../shared/provider-rate-limits.js";
import { nextRetryDecision, sleepOrAbort } from "../shared/retry.js";
import { isWorkflowPendingStageDeliveryFailure } from "./pending-stage-delivery.js";
import { stageSessionCompaction } from "./stage-background-compaction.js";
import { StageDeliveryActivity, type StageDeliveryActivityListener } from "./stage-delivery-activity.js";
import { stageSessionQueueUpdateEvent } from "./stage-queued-user-messages.js";
import { routeStageModel } from "./stage-routing.js";
import { StageArtifactCapture } from "./stage-runner-artifact-capture.js";
import { candidateLabel, modelAttemptReasoning } from "./stage-runner-candidate.js";
import { StageMessageAdmission } from "./stage-runner-message-admission.js";
import {
	hasAssistantMessageSince,
	lastAssistantTextFromSession,
	latestTerminalAssistantFailureSince,
	structuredOutputTurnDetail,
	WorkflowPromptEmptyCompletionFailure,
	WorkflowPromptModelFailure,
} from "./stage-runner-messages.js";
import {
	missingAdapter,
	readStoredStageMessages,
	stripWorkflowOnlyOptions,
	unavailableSync,
} from "./stage-runner-options.js";
import { StageSessionPause, type StageSessionPauseResumeResult } from "./stage-runner-pause.js";
import {
	DetachedResultsNotSaved,
	resultsAnsweringTranscript,
	storedTranscript,
	unansweredToolCallIds,
} from "./stage-runner-reopen.js";
import { StageSessionReplacement } from "./stage-runner-replacement.js";
import { sendStageUserMessage } from "./stage-runner-send-user-message.js";
import {
	asAgentSession,
	attachCreatedStageSession,
	cleanupFailedStageSessionBinding,
	disposeStageSession,
	isStageSessionQuiescent,
	normalizeSessionCreateResult,
	StageSessionBindingCleanupFailure,
	shutdownStageSession,
	stageError,
} from "./stage-runner-session.js";
import { buildStageSessionOptions } from "./stage-runner-session-options.js";
import {
	isStructuredOutputContractFailure,
	STRUCTURED_OUTPUT_MISSING_ERROR,
	structuredOutputToolErrorFromEvent,
} from "./stage-runner-structured-output.js";
import type {
	AgentSessionConsumer,
	StageModelFallbackMeta,
	StageQueuedImage,
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionCreateResult,
	StageSessionEvent,
	StageSessionRuntime,
	StageUserMessagePreparation,
	WorkflowRetrySettings,
	WorkflowSettingsManager,
} from "./stage-runner-types.js";
import {
	isUnresolvedContextOverflowFailure,
	nextResumedContextOverflowFallbackIndex,
	terminatingToolCallId,
	unresolvedContextOverflowFailure,
	unresolvedContextOverflowMessage,
} from "./stage-runner-unresolved-overflow.js";
import { waitForStageStartup } from "./stage-startup-wait.js";

/** Stage extension state the subagents extension reads to end, rather than keep restorable, a closing stage's children. */
export const WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE = "atomic:workflow-stage-closed-for-good";

/**
 * Stage extension state the subagents extension sets to end a stage's children when its generation, closed resumably,
 * ends for good later.
 */
export const WORKFLOW_STAGE_END_CHILDREN_STATE = "atomic:workflow-stage-end-children";

interface CandidateWalk {
	readonly remaining: Set<number>;
	readonly rateLimitFailures: Map<number, number>;
	/** Candidates dropped only because their rate-limit budget ran out. */
	readonly rateLimited: Set<number>;
	/** Whole-chain cooldown waits already spent (#3984). */
	cooldownRounds: number;
}

type RetryPauseResume = NonNullable<ReturnType<StageSessionPause["currentResume"]>>;

/**
 * Extension startup is not a model request: the model classifiers never decide it.
 * A transient one (a broker or socket that did not come up in time under load) is
 * worth a fresh session, first on the same candidate and then on the next. A
 * deterministic one fails identically for every candidate, so it ends the stage.
 */
function candidateCooldownMs(value: WorkflowModelValue | undefined, now?: number): number {
	return providerCooldownMs(workflowProviderId(value), workflowModelName(value), now);
}

function candidateUnavailableMs(value: WorkflowModelValue | undefined, now?: number): number {
	return providerUnavailableMs(workflowProviderId(value), workflowModelName(value), now);
}

function isRetryableSameCandidateFailure(error: unknown): boolean {
	if (isExtensionStartupFailure(error)) return isTransientExtensionStartupFailure(error);
	return isRetryableSameModelFailure(error);
}

function mayAdvanceToNextCandidate(error: unknown, options: ModelFallbackFailureOptions): boolean {
	if (isExtensionStartupFailure(error)) return isTransientExtensionStartupFailure(error);
	return isRetryableModelFailure(error, options);
}

type StageMessage = StageSessionRuntime["messages"][number];
type StageAssistantMessage = Extract<StageMessage, { role: "assistant" }>;

type AttemptUsageTotals = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
};

/**
 * A present usage object is meaningful when any token bucket, the total token
 * count, or the provider-reported total cost is positive. Reject the entire
 * provider record when any aggregated value is non-finite or negative so
 * malformed telemetry cannot poison a durable stage checkpoint.
 */
function hasMeaningfulUsage(usage: StageAssistantMessage["usage"] | undefined): boolean {
	if (usage === undefined) return false;
	const values = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite, usage.totalTokens, usage.cost.total];
	return values.every((value) => Number.isFinite(value) && value >= 0) && values.some((value) => value > 0);
}

/**
 * Aggregate the assistant-message usage admitted since the latched attempt
 * boundary, plus usage accrued from error assistants that a retry restoration
 * removed from the live transcript. Returns undefined when nothing meaningful
 * was seen, so no `usage: undefined` enters the serializable attempt record.
 */
function usageForAttempt(
	messages: readonly StageMessage[],
	start: number,
	discarded: AttemptUsageTotals,
): WorkflowModelUsage | undefined {
	const totals = { ...discarded };
	let meaningful = totals.turns > 0;

	for (const message of messages.slice(start)) {
		if (message.role !== "assistant" || !hasMeaningfulUsage(message.usage)) continue;
		totals.input += message.usage.input;
		totals.output += message.usage.output;
		totals.cacheRead += message.usage.cacheRead;
		totals.cacheWrite += message.usage.cacheWrite;
		totals.cost += message.usage.cost.total;
		totals.turns += 1;
		meaningful = true;
	}

	return meaningful ? totals : undefined;
}

interface ThrownErrorRetryState {
	readonly controller: AbortController;
	pauseResume?: RetryPauseResume;
}

/** Observes a controlled pause raised while a session creation is in flight. */
interface CreationPauseObserver {
	pauseResume?: RetryPauseResume;
}

interface SessionCreationPauseResult {
	readonly kind: "paused";
	readonly resumeMessage?: string;
}

function isSessionCreationPauseResult(
	value: StageSessionRuntime | SessionCreationPauseResult,
): value is SessionCreationPauseResult {
	return "kind" in value && value.kind === "paused";
}

class StageSessionCreationCancelled extends Error {
	constructor() {
		super("atomic-workflows: stage session creation was cancelled while paused");
		this.name = "StageSessionCreationCancelled";
	}
}

/**
 * Options for a resume message that replaces a paused prompt's text. The message is the
 * operator's own text, so it is read literally, as an idle stage's resume message is sent.
 */
function resumeMessageOptions(sdkOptions: PromptOptions | undefined): PromptOptions {
	return { ...sdkOptions, expandPromptTemplates: false };
}

function stageUserMessageText(message: StageSessionRuntime["messages"][number]): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}
function retrySettingsManagerFromError(error: unknown): WorkflowSettingsManager | undefined {
	if (error === null || typeof error !== "object") return undefined;
	const manager = (error as { readonly settingsManager?: unknown }).settingsManager;
	if (manager === null || typeof manager !== "object") return undefined;
	const candidate = manager as Partial<WorkflowSettingsManager>;
	return typeof candidate.getRetrySettings === "function" ? (candidate as WorkflowSettingsManager) : undefined;
}

type RetryableAgentSession = AgentSession & {
	_runAgentContinue(): Promise<void>;
};

function retryableAgentSession(activeSession: StageSessionRuntime): RetryableAgentSession | undefined {
	const session = asAgentSession(activeSession);
	if (session === undefined) return undefined;
	const candidate = session as AgentSession & { readonly _runAgentContinue?: unknown };
	return typeof candidate._runAgentContinue === "function" ? (session as RetryableAgentSession) : undefined;
}

/**
 * pi-agent-core requires the last message of a continued transcript to convert
 * to a `user` or `toolResult` provider message (`agent-loop.js` `agentLoopContinue`);
 * anything else is rejected once the request reaches the provider.
 *
 * The raw tail is not enough to answer that. A retry that restored live state
 * can leave a retained non-error assistant, or a `custom`/`bashExecution`/
 * `branchSummary` message that Atomic's converter drops when it is excluded
 * from context or empty — leaving an assistant as the converted tail. Evaluate
 * the same `convertToLlm()` result Atomic sends.
 */
function canContinueFromTranscript(activeSession: StageSessionRuntime): boolean {
	const converted = convertToLlm([...activeSession.messages]);
	const last = converted[converted.length - 1];
	return last !== undefined && (last.role === "user" || last.role === "toolResult");
}

class ThrownErrorRetryPaused extends Error {
	constructor(readonly resume: RetryPauseResume) {
		super("atomic-workflows: thrown-error retry paused");
		this.name = "ThrownErrorRetryPaused";
	}
}

/**
 * Everything the controller needs only while its session is resident. A stage that releases its session drops this,
 * and its next residency starts with a fresh one, so a waiting stage keeps none of it. The stage's own identity,
 * listeners, captured answers and delivery-activity subscribers live on the controller instead: they outlive a wait.
 */
class StageResidency {
	/** Consumer cancellation never releases the underlying creation owner. */
	startupWait = new AbortController();
	readonly messageAdmission = new StageMessageAdmission();
	readonly replacement = new StageSessionReplacement();
	readonly thrownErrorRetryStates = new Set<ThrownErrorRetryState>();
	readonly creationPauseObservers = new Set<CreationPauseObserver>();
	readonly listenerUnsubscribes = new Map<(event: StageSessionEvent) => void, () => void>();
	readonly terminatingToolCallIds = new Set<string>();
}

const NO_TERMINATING_TOOL_CALLS: ReadonlySet<string> = new Set();

/** Waits between turns: any use of the stage reopens its session. A tool wait instead holds input until it is woken. */
function reopensOnUse(wait: StageWaitSnapshot | undefined): wait is StageWaitSnapshot {
	return wait !== undefined && wait.kind !== "tool";
}

/** Input sent to a stage waiting on a tool call, queued into its reopened session before the turn continues. */
interface HeldStageInput {
	readonly content: StageUserMessageContent;
	readonly kind: "steer" | "followUp";
	/** Absent: the session's own default for queued text. */
	readonly expandPromptTemplates: boolean | undefined;
}

function splitStageContent(content: StageUserMessageContent): { text: string; images: StageQueuedImage[] | undefined } {
	if (typeof content === "string") return { text: content, images: undefined };
	const text = content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const images = content.filter((part): part is StageQueuedImage => part.type === "image");
	return { text, images: images.length === 0 ? undefined : images };
}

export class StageSessionController {
	private session: StageSessionRuntime | undefined;
	private activeCreation: Promise<StageSessionRuntime> | undefined;
	/** The creation promise a candidate walk still owns, if one is advancing. */
	private ownedCreationPromise: Promise<StageSessionRuntime> | undefined;
	private abortGeneration = 0;
	private routeAuthorityWait: AbortController | undefined;
	private startup: StageStartupSnapshot | undefined;
	private abortReason: Error | DOMException | string | undefined;
	private abortReasonGeneration = 0;
	private sessionPromise: Promise<StageSessionRuntime> | undefined;
	private sessionShutdownPromise: Promise<void> | undefined;
	/** #3020: an unowned failed binding cannot be replaced until cleanup proves release. Never reset this fence. */
	private bindingCleanupFailure: StageSessionBindingCleanupFailure | undefined;
	private reattachSessionId: string | undefined;
	private lastPromptStartIndex: number | undefined;
	/** Message index latched once per high-level candidate prompt; never re-read later. */
	private attemptUsageStartIndex: number | undefined;
	/** Usage accrued from error assistants removed by retry restoration. */
	private discardedAttemptUsage: AttemptUsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
	private latestStructuredOutputToolErrorValue: string | undefined;
	private structuredOutputExecutionFailureValue: string | undefined;
	private structuredOutputCycleAttemptMark: number | undefined;
	private unsubscribeTerminateWatcher: (() => void) | undefined;
	/** Removes this stage's listener from the run's abort signal. */
	private unbindAbortSignal: (() => void) | undefined;
	private sessionInternalRetries = 0;
	private unresolvedContextOverflowMessage: string | undefined;
	private generationSealed = false;
	private disposed = false;
	private pendingDisposal = false;
	private disposalPromise: Promise<void> | undefined;
	private pendingThinkingLevel: Parameters<StageContext["setThinkingLevel"]>[0] | undefined;
	private requestedThinkingLevel: Parameters<StageContext["setThinkingLevel"]>[0] | undefined;
	private readonly pendingListeners = new Set<(event: StageSessionEvent) => void>();
	private readonly pauseControl = new StageSessionPause(
		() => this.session ?? this.residencyState?.replacement.retiringSession,
	);
	/** What only the resident session needs; dropped when the session is released. Created on first need. */
	private residencyState: StageResidency | undefined;
	private readonly hasExplicitModelFallbackConfig: boolean;
	private candidatesPromise: Promise<WorkflowResolvedModelCandidate[]> | undefined;
	private scopedModelsPromise: Promise<WorkflowResolvedScopedModel[] | undefined> | undefined;
	private modelRoute: ModelRoute | undefined;
	private routingPromise: Promise<void> | undefined;
	private explicitModel: CreateAgentSessionOptions["model"];
	private activeCandidateIndex: number | undefined;
	private selectedModel: string | undefined;
	private sharedModelRuntime: CreateAgentSessionOptions["modelRuntime"];
	private sharedOrchestrationContext: CreateAgentSessionOptions["orchestrationContext"];
	private resumeCurrentSession = false;
	private readonly modelAttempts: WorkflowModelAttempt[] = [];
	private readonly rateLimitProviders = new Set<string>();
	private rateLimitWait: { provider: string; until: number } | undefined;
	private readonly modelWarnings: string[] = [];
	private readonly pendingFallbackWarnings: string[] = [];
	private readonly modelCatalog: WorkflowModelCatalogPort | undefined;
	private sessionSettingsManager: WorkflowSettingsManager | undefined;
	private pendingCreationResumeMessage: string | undefined;
	private readonly deliveryActivity = new StageDeliveryActivity();
	private readonly artifactCapture = new StageArtifactCapture();
	/** Set only when the caller supplied the session manager, so disposing the session never closes its store. */
	private callerSessionManager: SessionManager | undefined;
	/** Set while the session is released and the stage waits; cleared once the stage is woken. */
	private releasedWait: StageWaitSnapshot | undefined;
	/** Results of detached calls the next prompt segment records before it continues the turn. */
	private pendingDetachedResults: readonly DetachedToolResult[] | undefined;
	/** Input sent while the stage waits on a tool call, queued into the reopened session before it continues. */
	private heldWhileReleased: HeldStageInput[] | undefined;
	/** Set while the stage waits on detached calls with its session still live: inline, or resident for the wait. */
	private waitingInline = false;
	/** Cancels the detached calls of the current wait; set only while the stage waits on them. */
	private abortDetachedCalls: ((reason: Error | DOMException | string) => void) | undefined;
	/** Callers that need the session while it is released wait for the stage to wake. Created on first need. */
	private releasedWaitEnded: PromiseWithResolvers<void> | undefined;
	/** A durably resumed stage looks for detached calls its transcript ends on once, on its first prompt. */
	private resumedDetachedCallsChecked = false;
	/** The reopening of a released stage that callers needing its session join. */
	private rehydration: Promise<void> | undefined;
	/** A release between turns under way: callers join it first, so the stage never reopens halfway through it. */
	private releasing: Promise<boolean> | undefined;
	/** The model and thinking level of the session the stage last released: all it keeps of that session (#4309). */
	private releasedSettings: Pick<StageSessionRuntime, "model" | "thinkingLevel"> | undefined;
	/**
	 * The wait of the session the stage gave up, until a session of the stage is ready again: while the stage has no
	 * session, a read of it reports the session as released, also once that wait has ended without reopening it (#4309).
	 */
	private givenUp: StageWaitSnapshot | undefined;
	/** Why the session a tool wait gave up could not be reopened, until a session of the stage is ready again (#4309). */
	private reopenFailure: unknown;
	/** Cancels the wait between two attempts to reopen the session when the stage is aborted. */
	private reopenBackoff: AbortController | undefined;
	/** Prompts of the stage that have not settled; a stage with one cannot be released by its author. */
	private promptsInFlight = 0;
	/** When the stage's session last did anything: a prompt, a message or a session event. */
	private lastActivityAt = Date.now();

	private get residency(): StageResidency {
		this.residencyState ??= new StageResidency();
		return this.residencyState;
	}

	/** `capturesAnswers`: the generation writes an output artifact from its answers. */
	beginOutputGeneration(capturesAnswers = true): void {
		this.artifactCapture.reset(capturesAnswers);
	}

	outputGenerationMessages(): StageSessionRuntime["messages"] {
		return this.artifactCapture.messages();
	}

	async navigateTree(
		...args: Parameters<StageSessionRuntime["navigateTree"]>
	): ReturnType<StageSessionRuntime["navigateTree"]> {
		const session = await this.ensureSession();
		// Preserve answers from snapshot-only adapters before replacing their context.
		this.artifactCapture.messages();
		try {
			return await session.navigateTree(...args);
		} finally {
			this.artifactCapture.rememberContext(session);
		}
	}

	constructor(
		private readonly opts: StageRunnerOpts,
		private readonly meta: StageExecutionMeta,
		private readonly effectiveStageOptions: StageOptions | undefined,
		private readonly structuredOutputCapture: StructuredOutputCapture<unknown> | undefined,
	) {
		this.hasExplicitModelFallbackConfig =
			effectiveStageOptions?.model !== undefined || (effectiveStageOptions?.fallbackModels?.length ?? 0) > 0;
		this.modelCatalog =
			opts.models === undefined
				? undefined
				: ({
						...opts.models,
						recordWarning: (warning: string): void => {
							this.modelWarnings.push(warning);
							opts.models?.recordWarning?.(warning);
						},
					} satisfies WorkflowModelCatalogPort);
		this.bindAbortSignal();
	}

	get currentSession(): StageSessionRuntime | undefined {
		return this.session;
	}

	get currentPromptStartIndex(): number | undefined {
		return this.lastPromptStartIndex;
	}

	resetStructuredOutputToolError(): void {
		this.latestStructuredOutputToolErrorValue = undefined;
	}

	structuredOutputExecutionFailure(): string | undefined {
		return this.structuredOutputExecutionFailureValue;
	}

	/**
	 * Mark where the current candidate's structured-output correction cycle
	 * begins, so exhausting that cycle can reclassify every attempt it recorded
	 * (issue #2812).
	 */
	beginStructuredOutputCandidateCycle(): void {
		this.structuredOutputCycleAttemptMark = this.modelAttempts.length;
	}

	/**
	 * Why the latest schema-backed turn finished without a `structured_output`
	 * call. A failed tool call already explains itself; anything else is a clean
	 * turn whose shape has to be named, or the external cause stays invisible
	 * (issue #2812).
	 */
	structuredOutputFailureReason(): string {
		const toolError = this.latestStructuredOutputToolErrorValue;
		if (toolError !== undefined) return toolError;
		const messages = this.session?.messages;
		if (messages === undefined) return STRUCTURED_OUTPUT_MISSING_ERROR;
		return `${STRUCTURED_OUTPUT_MISSING_ERROR} ${structuredOutputTurnDetail(messages, this.lastPromptStartIndex ?? 0)}`;
	}

	/**
	 * A candidate that burned its whole structured-output correction budget has
	 * failed, however clean its turns looked. Route it through the chain rate
	 * limits already use (issue #2812): reclassify the attempts it recorded,
	 * warn, dispose the session, and point the walk at the next candidate, which
	 * the caller then re-prompts with the original stage prompt and a fresh
	 * correction budget. Returns whether such a candidate exists.
	 */
	async failCandidateForStructuredOutputExhaustion(error: string): Promise<boolean> {
		const mark = this.structuredOutputCycleAttemptMark ?? 0;
		this.structuredOutputCycleAttemptMark = undefined;
		// Every clean-looking turn in this cycle was recorded as a success. None
		// of them produced the structured result the stage requires.
		for (let attemptIndex = mark; attemptIndex < this.modelAttempts.length; attemptIndex += 1) {
			const attempt = this.modelAttempts[attemptIndex];
			if (attempt === undefined || !attempt.success) continue;
			this.modelAttempts[attemptIndex] = { ...attempt, success: false, error };
		}
		const candidates = this.hasExplicitModelFallbackConfig ? await this.modelCandidates() : [];
		const index = this.activeCandidateIndex ?? 0;
		const candidate = candidates[index];
		const nextCandidate = candidates[index + 1];
		if (this.opts.signal?.aborted || candidate === undefined || nextCandidate === undefined) {
			this.modelWarnings.push(...this.pendingFallbackWarnings);
			this.pendingFallbackWarnings.length = 0;
			this.notifyModelFallbackMetaChange();
			return false;
		}
		this.pendingFallbackWarnings.push(
			`[fallback] ${candidateLabel(candidate)} failed: ${error}. Retrying with ${candidateLabel(nextCandidate)}.`,
		);
		// Unlike a rate-limit advance, nothing else in the run reveals that this
		// candidate failed: its turns returned cleanly and its attempts are the
		// only trace. Flush the warning now so it survives a fallback that then
		// succeeds, instead of being cleared with the pending batch (issue #2812).
		this.modelWarnings.push(...this.pendingFallbackWarnings);
		this.pendingFallbackWarnings.length = 0;
		await this.disposeCurrentSession(index + 1);
		this.notifyModelFallbackMetaChange();
		return true;
	}
	requireSession(property: string): StageSessionRuntime {
		if (!this.session) unavailableSync(property);
		return this.session;
	}

	lastAssistantText(fallback: string | undefined): string | undefined {
		return lastAssistantTextFromSession(
			this.session,
			fallback,
			this.residencyState?.terminatingToolCallIds ?? NO_TERMINATING_TOOL_CALLS,
		);
	}

	subscribe(listener: (event: StageSessionEvent) => void): () => void {
		this.pendingListeners.add(listener);
		if (this.session) this.residency.listenerUnsubscribes.set(listener, this.session.subscribe(listener));
		return () => {
			this.pendingListeners.delete(listener);
			const unsubscribe = this.residencyState?.listenerUnsubscribes.get(listener);
			this.residencyState?.listenerUnsubscribes.delete(listener);
			unsubscribe?.();
		};
	}

	async setThinkingLevel(level: Parameters<StageContext["setThinkingLevel"]>[0]): Promise<void> {
		if (this.session) await this.session.setThinkingLevel(level);
		else this.requestedThinkingLevel = level;
		this.pendingThinkingLevel = level;
	}

	get awaitingAutoPrompt(): boolean {
		return (
			this.effectiveStageOptions?.model === "auto" &&
			this.modelRoute === undefined &&
			this.explicitModel === undefined
		);
	}

	async preparePrompt(text: string): Promise<void> {
		if (!this.awaitingAutoPrompt && this.routingPromise === undefined) return;
		if (!this.routingPromise) {
			this.beginStartup();
			// A failed routing attempt is not memoized: the next prompt routes again.
			const routing: Promise<void> = (async () => {
				const route = this.modelCatalog?.routeModel;
				if (!route) throw new Error("Workflow stage auto routing requires a routing-capable model catalog.");
				const options = this.effectiveStageOptions;
				const thinking = this.pendingThinkingLevel;
				const constraints = [
					...(options?.inheritedModelConstraints ?? []),
					parseModelConstraints(options?.modelConstraints),
					...(thinking === undefined ? [] : [{ allowedEfforts: [thinking] }]),
				].filter((c): c is ModelConstraints => c !== undefined);
				try {
					this.modelRoute = await routeStageModel(route, {
						task: text,
						stageName: this.opts.stageName,
						constraints,
						signal: this.residency.startupWait.signal,
						selection: options?.routerSelection,
						...(options?.taskNeeds ? { taskNeeds: options.taskNeeds } : {}),
						...(setsProviders(parseModelConstraints(options?.modelConstraints))
							? { overrideProviderSettings: true }
							: {}),
					});
				} catch (error) {
					this.residency.startupWait.signal.throwIfAborted();
					this.opts.signal?.throwIfAborted();
					// #3206: only a total routing-inference failure (Jev and the chat
					// structured-output fallback both failed) degrades, and only to a
					// current chat model that satisfies every routing constraint.
					if (!(error instanceof AutoRoutingInferenceError) || error.currentModelRoute === undefined) throw error;
					this.modelRoute = error.currentModelRoute;
					const warning = `workflows: stage auto routing failed; running "${this.opts.stageName}" on the current chat model ${this.modelRoute.modelOverride}.`;
					reportDebug("model-routing", "stage-routing-fallback", { message: warning }, () =>
						this.modelCatalog?.recordWarning?.(warning),
					);
				}
				this.modelRoute.assertCurrent();
				this.meta.stageOptions = { ...options, model: this.modelRoute.modelOverride };
				this.opts.onModelFallbackMetaChange?.(this.currentModelFallbackMeta());
			})().catch((error: unknown) => {
				if (this.routingPromise === routing) {
					this.routingPromise = undefined;
					this.modelRoute = undefined;
				}
				if (this.residency.startupWait.signal.aborted || this.opts.signal?.aborted) throw error;
				this.settleStartup(true);
				// #4031: classified as the routing failure it wraps, never by the stage name in this message.
				throw classifyFailureFrom(
					new Error(
						`atomic-workflows: stage "${this.opts.stageName}" failed during startup phase model-resolution: ${errorMessage(error)}`,
						{ cause: error },
					),
					error,
				);
			});
			this.routingPromise = routing;
		}
		await this.routingPromise;
	}

	assertAutoExecutionCurrent(): void {
		if (!this.modelRoute) return;
		this.residency.startupWait.signal.throwIfAborted();
		this.opts.signal?.throwIfAborted();
		this.modelRoute.assertCurrent();
	}

	async setModel(model: NonNullable<CreateAgentSessionOptions["model"]>): Promise<void> {
		if (this.awaitingAutoPrompt && !this.routingPromise) this.explicitModel = model;
		await (await this.ensureSession()).setModel(model);
	}
	private checkedSession(session: StageSessionRuntime): StageSessionRuntime {
		if (this.modelRoute && (!session.model || !this.modelRoute.allowsModel(session.model, session.thinkingLevel)))
			throw new Error("Workflow stage execution model no longer satisfies routing constraints.");
		return session;
	}

	ensureSession(consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
		// A stage that is not releasing, released or rehydrating opens its session directly: an async wrapper returning
		// openSession()'s promise would delay an idle delivery's turn start, and its Working lease, by two microtasks.
		if (this.releasing === undefined && this.releasedWait === undefined && this.rehydration === undefined)
			return this.openSession(consumer);
		return this.ensureReopenedSession(consumer);
	}

	private async ensureReopenedSession(consumer: AgentSessionConsumer): Promise<StageSessionRuntime> {
		if (this.releasing !== undefined) await this.joinRelease();
		if (reopensOnUse(this.releasedWait) || this.rehydration !== undefined) await this.rehydrate();
		else if (this.releasedWait !== undefined) {
			this.releasedWaitEnded ??= Promise.withResolvers<void>();
			await this.releasedWaitEnded.promise;
		}
		return this.openSession(consumer);
	}

	/** The stage's session, created or reopened as needed. Reopening a released stage calls this directly. */
	private async openSession(consumer: AgentSessionConsumer): Promise<StageSessionRuntime> {
		if (this.awaitingAutoPrompt && this.routingPromise === undefined)
			throw new Error(
				"Workflow stage auto requires prompt text before model-dependent session operations. Call prompt first or set a concrete model.",
			);
		if (this.routingPromise !== undefined) await this.routingPromise;
		if (this.bindingCleanupFailure !== undefined) throw this.bindingCleanupFailure;
		if (this.sessionShutdownPromise !== undefined) {
			const generation = this.abortGeneration;
			await this.sessionShutdownPromise;
			if (this.disposed || this.opts.signal?.aborted || this.abortGeneration !== generation)
				throw this.staleCreationReason(generation);
		}
		if (this.disposed) throw stageError(this.opts.stageName, "session has been disposed");
		this.opts.signal?.throwIfAborted();
		if (this.session !== undefined && this.activeCreation === undefined) return this.checkedSession(this.session);
		if (!this.sessionPromise) {
			this.beginStartup();
			const pending = this.createInitialSession(consumer);
			this.sessionPromise = pending;
			// One creation gate: the walk owns this promise while it advances
			// candidates, so a concurrent caller joins it instead of racing it.
			this.ownedCreationPromise = pending;
			const release = (failed = false): void => {
				if (this.ownedCreationPromise === pending) this.ownedCreationPromise = undefined;
				this.settleStartup(failed);
			};
			// Ordinary creation failures may be retried by a later caller; failed
			// binding cleanup is separately sticky. Clear by identity so a walk that
			pending.then(
				() => release(),
				() => {
					release(true);
					if (this.sessionPromise === pending) {
						this.sessionPromise = undefined;
						this.activeCandidateIndex = undefined;
					}
				},
			);
		}
		const ready = waitForStageStartup(this.sessionPromise, this.residency.startupWait.signal);
		return this.modelRoute ? this.checkedSession(await ready) : ready;
	}

	async ensureSessionFromId(
		sessionId: string,
		consumer: AgentSessionConsumer = "prompt",
	): Promise<StageSessionRuntime> {
		// Only a session this call reopens is an archived transcript whose generation ends here. A
		// live session, or one still being created (a pool worker records its id first, #3996), is the
		// stage's running generation: closing it would refuse every later tool call of the stage. A stage
		// with an explicit fallback chain creates its session through the candidate walk, which holds
		// `activeCreation` rather than the shared `sessionPromise`.
		if (this.releasedWait !== undefined) return this.ensureSession(consumer);
		const joinsLiveGeneration =
			!this.sessionShutdownPromise &&
			(this.sessionPromise !== undefined ||
				this.session !== undefined ||
				this.activeCreation !== undefined ||
				this.ownedCreationPromise !== undefined);
		if (!this.sessionShutdownPromise && !joinsLiveGeneration) this.reattachSessionId = sessionId;
		const session = await this.ensureSession(consumer);
		if (!joinsLiveGeneration || this.generationSealed) await session.closeWorkflowStageGeneration?.();
		return session;
	}

	async sendUserMessage(
		content: StageUserMessageContent,
		options?: StageSendUserMessageOptions,
		beforeDelivery?: () => void,
		preparation?: StageUserMessagePreparation,
	): Promise<Awaited<ReturnType<typeof sendStageUserMessage>>> {
		// A message sent while the stage releases its session reaches it after the release, never halfway through it.
		if (this.releasing !== undefined) await this.joinRelease();
		if (this.holdsInput()) {
			// Held whole, with its delivery and options, until the stage is woken; it is not durable meanwhile. A session
			// still live takes it into its queue now, where the turn its results continue finds it.
			preparation?.beforePreparation?.();
			const kind = options?.deliverAs === "steer" ? "steer" : "followUp";
			beforeDelivery?.();
			const expandPromptTemplates = options?.expandPromptTemplates ?? false;
			if (!this.holdWhileReleased(content, kind, { expandPromptTemplates }))
				await this.queueIntoWaitingTurn(content, kind, expandPromptTemplates);
			return kind;
		}
		this.lastActivityAt = Date.now();
		try {
			const action = await this.deliverUserMessage(content, options, beforeDelivery, preparation);
			// A message that started a turn may have left it waiting on detached tool calls; carry that turn on too.
			if (action === "prompt") await this.continueDetachedTurns(undefined, "prompt");
			return action;
		} finally {
			this.lastActivityAt = Date.now();
		}
	}

	private deliverUserMessage(
		content: StageUserMessageContent,
		options: StageSendUserMessageOptions | undefined,
		beforeDelivery: (() => void) | undefined,
		preparation: StageUserMessagePreparation | undefined,
	): Promise<Awaited<ReturnType<typeof sendStageUserMessage>>> {
		return this.residency.messageAdmission.run(async (release) => {
			const pausedDelivery = this.pauseControl.deferRunnerOwnedDelivery(() =>
				this.sendUserMessage(content, options, beforeDelivery, preparation),
			);
			if (pausedDelivery !== undefined) {
				release();
				return pausedDelivery;
			}
			preparation?.beforePreparation?.();
			const sessionId = preparation?.sessionId;
			const deliver = async (activity?: StageDeliveryActivity) => {
				if (this.effectiveStageOptions?.model === "auto")
					await this.preparePrompt(
						typeof content === "string"
							? content
							: content
									.filter((part) => part.type === "text")
									.map((part) => part.text)
									.join("\n"),
					);
				const activeSession =
					sessionId === undefined
						? await this.ensureSession("prompt")
						: await this.ensureSessionFromId(sessionId, "prompt");
				const pausedDelivery = this.pauseControl.deferRunnerOwnedDelivery(() =>
					sendStageUserMessage(
						activeSession,
						content,
						options,
						beforeDelivery,
						release,
						this.residency.messageAdmission,
						activity,
					),
				);
				if (pausedDelivery !== undefined) {
					release();
					return pausedDelivery;
				}
				return sendStageUserMessage(
					activeSession,
					content,
					options,
					beforeDelivery,
					release,
					this.residency.messageAdmission,
					activity,
				);
			};
			if (this.session === undefined || sessionId !== undefined)
				return this.deliveryActivity.runWithLease(() => deliver());
			return deliver(this.deliveryActivity);
		});
	}
	/** Internal pre-stream delivery lifecycle consumed by an attached stage chat. */
	subscribeDeliveryActivity(listener: StageDeliveryActivityListener): () => void {
		return this.deliveryActivity.subscribe(listener);
	}

	/**
	 * Whether the stage's generation closed while the stage still ran: closed, but not by the stage's own
	 * seal or close. Its tool calls were refused from then on, so it cannot have done its work (#3996).
	 */
	generationClosedUnderStage(): boolean {
		return !this.generationSealed && this.sharedOrchestrationContext?.messageAdmission?.isOpen() === false;
	}
	/** With `closedForGood`, the stage finished or its run ended: its subagent children end with it, not resumable. */
	sealGeneration(closedForGood = false): void {
		if (closedForGood)
			this.sharedOrchestrationContext?.messageAdmission?.extensionState.set(WORKFLOW_STAGE_CLOSED_FOR_GOOD_STATE, {
				closedForGood,
			});
		this.generationSealed = true;
		this.sharedOrchestrationContext?.messageAdmission?.boundary.seal();
		this.session?.sealWorkflowStageGeneration?.();
	}
	async closeGeneration(closedForGood = false): Promise<void> {
		this.sealGeneration(closedForGood);
		const pending = this.activeCreation ?? this.sessionPromise;
		const session = pending ? await pending : this.session;
		try {
			await session?.closeWorkflowStageGeneration?.();
		} catch (error) {
			throw isTaskCleanupError(error) ? new ProcessCleanupUnconfirmedError(error) : error;
		}
		this.artifactCapture.close();
		// A generation that already closed resumably (its stage blocked) ends its children now that it ends for good.
		if (closedForGood) {
			const end = this.sharedOrchestrationContext?.messageAdmission?.extensionState.get(
				WORKFLOW_STAGE_END_CHILDREN_STATE,
			);
			if (end && "endChildren" in end && typeof end.endChildren === "function") end.endChildren();
		}
	}

	/**
	 * Prompt the stage, and carry the turn across every wait on a detached tool call: the session is released while
	 * the stage waits and reopened from the store when the results arrive, and the same turn continues without a new
	 * user message.
	 */
	async promptWithFallback(
		text: string,
		sdkOptions: PromptOptions | undefined,
		consumer: AgentSessionConsumer = "prompt",
		newSessionText?: string,
	): Promise<void> {
		this.promptsInFlight += 1;
		this.lastActivityAt = Date.now();
		try {
			if (reopensOnUse(this.releasedWait)) await this.rehydrate();
			if (!(await this.resumeDetachedCalls(sdkOptions, consumer)))
				await this.promptSegment(text, sdkOptions, consumer, newSessionText);
			await this.continueDetachedTurns(sdkOptions, consumer);
		} finally {
			this.promptsInFlight -= 1;
			this.lastActivityAt = Date.now();
		}
	}

	/**
	 * Let the session detach long tool calls only when the stage may release while it waits; a session that cannot be
	 * reopened keeps every wait resident, and the run reports that once.
	 */
	private applyToolDetachment(session: StageSessionRuntime): void {
		const policy = this.opts.waiting?.policy;
		if (policy === undefined || session.setToolDetachment === undefined) return;
		if (this.canReleaseSession(session)) {
			session.setToolDetachment(policy);
			return;
		}
		this.opts.waiting?.resident(
			new StageReleaseError("not-reopenable", {
				runId: this.opts.runId,
				stageId: this.opts.stageId,
				stageName: this.opts.stageName,
				sessionId: session.sessionId,
			}),
		);
	}

	/** Whether the stage gives up its session while it waits and can reopen it from the store afterwards. */
	private canReleaseSession(session: StageSessionRuntime): boolean {
		if (this.opts.waiting === undefined) return false;
		if (this.callerSessionManager !== undefined) return true;
		return asAgentSession(session)?.sessionManager.isPersisted() === true;
	}

	/**
	 * A stage resumed after its process died may end on a turn that issued detachable calls and never got the model's
	 * answer. When its previous process recorded the results of every call the turn waits on, the turn continues from
	 * them; otherwise the calls without a result start again, with their ids and arguments, and the turn continues once
	 * they finish, instead of the stage being prompted again. A turn whose results were all recorded continues at once.
	 * Which calls still wait is read from the transcript the store holds, not from the context the model sees (#4309).
	 */
	private async resumeDetachedCalls(
		sdkOptions: PromptOptions | undefined,
		consumer: AgentSessionConsumer,
	): Promise<boolean> {
		if (this.resumedDetachedCallsChecked || this.effectiveStageOptions?.resumeFromSessionId === undefined)
			return false;
		this.resumedDetachedCallsChecked = true;
		const session = await this.ensureSession(consumer);
		const replayKey = this.effectiveStageOptions.durableReplayKey;
		const recorded =
			replayKey === undefined ? undefined : this.opts.waiting?.dispatcher.takeResultsForResume(replayKey);
		const pendingTurn = session.hasPendingDetachedTurn?.() === true;
		const fromRecord =
			recorded === undefined || !pendingTurn
				? undefined
				: resultsAnsweringTranscript(recorded, storedTranscript(session));
		// A record that answers no turn the transcript waits on is spent: the calls start again and record their own.
		if (recorded !== undefined && fromRecord === undefined) this.opts.waiting?.resultsInTranscript();
		if (!pendingTurn) return false;
		const calls = fromRecord === undefined ? (session.redispatchDetachedToolCalls?.() ?? []) : [];
		const results =
			fromRecord ??
			(calls.length === 0 ? [] : await this.waitForDetachedCalls(calls, this.opts.waiting?.policy?.afterMs));
		await this.continueWithResults(results, sdkOptions, consumer);
		return true;
	}

	private async continueDetachedTurns(
		sdkOptions: PromptOptions | undefined,
		consumer: AgentSessionConsumer,
	): Promise<void> {
		while (true) {
			const calls = this.session?.takeDetachedToolCalls?.() ?? [];
			if (calls.length === 0) return;
			const releaseAfterMs = this.opts.waiting?.policy === undefined ? undefined : 0;
			await this.continueWithResults(await this.waitForDetachedCalls(calls, releaseAfterMs), sdkOptions, consumer);
		}
	}

	/**
	 * Continue the turn from the results of its detached calls. Until the session has saved the results, the stage is
	 * still bringing its session back: when the session store or the network fails the save, the stage gives the session
	 * up, reopens it from the store and hands the results over again, at most {@link STAGE_WAIT_RETRY_ATTEMPTS} times in
	 * all after the same backoff as a reopening. A store still failing then throws a `StageRehydrationError`
	 * (`phase: "resume-turn"`) that blocks the run resumably, the results kept in the stage's record (#4309).
	 */
	private async continueWithResults(
		results: readonly DetachedToolResult[],
		sdkOptions: PromptOptions | undefined,
		consumer: AgentSessionConsumer,
	): Promise<void> {
		const startedAt = Date.now();
		for (let attempt = 1; ; attempt++) {
			this.pendingDetachedResults = results;
			try {
				await this.promptSegment(RESUME_CONTINUATION_PROMPT, sdkOptions, consumer);
				return;
			} catch (error) {
				if (!(error instanceof DetachedResultsNotSaved)) throw error;
				this.throwUnlessResultsSaveRetries(error.failure, attempt, startedAt);
			} finally {
				this.pendingDetachedResults = undefined;
			}
			await this.reopenToSaveResults(results, attempt);
		}
	}

	/**
	 * Hand the session the results its turn continues from; the stage's record drops them only once the transcript the
	 * store holds has them. A save the store or the network failed throws {@link DetachedResultsNotSaved}, and a session
	 * that returns without having saved them fails the turn with a `StageRehydrationError` (`results-not-saved`): a stage
	 * never completes on a turn still waiting on a call.
	 */
	private async continueFromResults(
		session: StageSessionRuntime,
		resume: NonNullable<StageSessionRuntime["resumeDetachedTurn"]>,
		results: readonly DetachedToolResult[],
	): Promise<void> {
		const awaited = unansweredToolCallIds(storedTranscript(session));
		const unsaved = (): string[] => {
			const unanswered = new Set(unansweredToolCallIds(storedTranscript(session)));
			return awaited.filter((toolCallId) => unanswered.has(toolCallId));
		};
		try {
			await resume.call(session, results);
		} catch (error) {
			if (stageReopenFailureCause(error) === "transient" && unsaved().length > 0)
				throw new DetachedResultsNotSaved(error);
			throw error;
		}
		// Only an `AgentSession` reads back what its store holds; another runtime's transcript is its own report.
		const missing = asAgentSession(session) === undefined ? [] : unsaved();
		if (missing.length > 0)
			throw new StageRehydrationError(
				{
					runId: this.opts.runId,
					stageId: this.opts.stageId,
					stageName: this.opts.stageName,
					sessionId: session.sessionId,
					toolCallIds: missing,
					phase: "resume-turn",
				},
				{ code: "results-not-saved" },
			);
		this.opts.waiting?.resultsInTranscript();
	}

	/**
	 * Classify a failed save of the results a turn continues from, as a failed reopening is: the run's abort rethrows its
	 * reason, a session the stage cannot reopen from a store keeps the failure's own classification, and a store still
	 * failing after the last attempt throws a `StageRehydrationError` that blocks the run resumably.
	 */
	private throwUnlessResultsSaveRetries(failure: unknown, attempt: number, startedAt: number): void {
		const { signal } = this.opts;
		if (signal?.aborted) throw signal.reason;
		const session = this.session;
		if (this.disposed || session === undefined || !this.canReleaseSession(session)) throw failure;
		if (attempt < STAGE_WAIT_RETRY_ATTEMPTS) return;
		throw new StageRehydrationError(
			{
				runId: this.opts.runId,
				stageId: this.opts.stageId,
				stageName: this.opts.stageName,
				sessionId: session.sessionId,
				phase: "resume-turn",
				attempts: attempt,
				elapsedMs: Date.now() - startedAt,
				timeoutMs: STAGE_WAIT_RETRY_BUDGET_MS,
			},
			{ cause: failure },
		);
	}

	/**
	 * Give the session up and reopen it from the store before the results are handed over again, so the next attempt
	 * continues from what the store holds. Meanwhile the stage waits released on the calls whose results it holds, as for
	 * any wait on a tool: its input is held, its pause holds the reopening, and its abort ends the wait.
	 */
	private async reopenToSaveResults(results: readonly DetachedToolResult[], attempt: number): Promise<void> {
		const hooks = this.opts.waiting!;
		const wait: StageWaitSnapshot = {
			kind: "tool",
			since: Date.now(),
			toolCalls: results.map(({ toolCallId, toolName }) => ({ toolCallId, toolName })),
		};
		try {
			await this.releaseSession(wait);
			await hooks.enter(wait);
			await this.waitBeforeReopening(attempt);
		} catch (error) {
			// As for a wait that ended without a wake: a later caller reopens the session as for any released stage.
			this.releasedWait = undefined;
			this.releasedWaitEnded?.reject(error);
			this.releasedWaitEnded = undefined;
			throw error;
		}
		await this.reopen(wait);
	}

	/**
	 * Wait for detached calls. Calls still running after `releaseAfterMs` wait with the session released; without a
	 * threshold the stage stays resident for the whole wait. While the session stays live, a message sent to the stage
	 * joins the turn the results continue rather than starting one of its own.
	 */
	private async waitForDetachedCalls(
		calls: readonly DetachedToolCall[],
		releaseAfterMs: number | undefined,
	): Promise<readonly DetachedToolResult[]> {
		const session = this.session;
		const hooks = this.opts.waiting;
		if (
			hooks === undefined ||
			releaseAfterMs === undefined ||
			session === undefined ||
			!this.canReleaseSession(session)
		) {
			this.waitingInline = true;
			try {
				return await raceAbort(Promise.all(calls.map((call) => call.result)), this.opts.signal);
			} catch (error) {
				for (const call of calls) call.abort(this.workflowAbortReason());
				throw error;
			} finally {
				this.waitingInline = false;
			}
		}
		// The run's dispatcher collects the results: the stage keeps no promise chain of its own over the calls.
		hooks.dispatcher.watchToolResults(hooks.wakeKey, calls);
		const woken = hooks.dispatcher.park(hooks.wakeKey, "tool-results");
		if (releaseAfterMs > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			this.waitingInline = true;
			try {
				const settled = await Promise.race([
					woken,
					new Promise<undefined>((resolve) => {
						timer = setTimeout(() => resolve(undefined), releaseAfterMs);
					}),
				]);
				if (settled !== undefined) return settled.results;
			} catch (error) {
				for (const call of calls) call.abort(this.workflowAbortReason());
				throw error;
			} finally {
				clearTimeout(timer);
				// The release below marks the stage waiting before it gives anything up, so input is held throughout.
				this.waitingInline = false;
			}
		}
		const wait: StageWaitSnapshot = {
			kind: "tool",
			since: Date.now(),
			toolCalls: calls.map((call) => ({ toolCallId: call.toolCallId, toolName: call.toolName })),
		};
		return this.waitReleased(wait, calls, woken);
	}

	/** Release the session and wait for the run's wake dispatcher to deliver the results, then reopen the session. */
	private async waitReleased(
		wait: StageWaitSnapshot,
		calls: readonly DetachedToolCall[],
		woken: Promise<{ readonly results: readonly DetachedToolResult[] }>,
	): Promise<readonly DetachedToolResult[]> {
		const hooks = this.opts.waiting!;
		const { dispatcher, wakeKey } = hooks;
		dispatcher.register({ runId: this.opts.runId, stageId: this.opts.stageId, reason: wait.kind, wakeKey });
		this.abortDetachedCalls = (reason) => {
			for (const call of calls) call.abort(reason);
		};
		let delivered: readonly DetachedToolResult[];
		try {
			await this.releaseSession(wait);
			await hooks.enter(wait);
			delivered = (await woken).results;
		} catch (error) {
			this.abortDetachedCalls?.(
				error instanceof Error || typeof error === "string" ? error : this.workflowAbortReason(),
			);
			// The wait ended without a wake: a later caller reopens the session as for any released stage.
			this.releasedWait = undefined;
			this.releasedWaitEnded?.reject(error);
			this.releasedWaitEnded = undefined;
			throw error;
		} finally {
			dispatcher.unregister(wakeKey);
			this.abortDetachedCalls = undefined;
		}
		await this.reopen(wait, delivered);
		return delivered;
	}

	/** Give up the live session; the stage keeps its listeners, queue and identity, and reopens the same session. */
	private async releaseSession(wait: StageWaitSnapshot): Promise<void> {
		const current = this.session;
		if (current === undefined) return;
		const cleared = (current as StageSessionRuntime & { clearQueue?: AgentSession["clearQueue"] }).clearQueue?.();
		// Queued text was already prepared by the session; it is queued again literally, with its own images.
		for (const [lane, kind] of [
			["steering", "steer"],
			["followUp", "followUp"],
		] as const) {
			for (const [index, text] of (cleared?.[lane] ?? []).entries()) {
				const images = cleared?.images?.[lane][index];
				const content: StageUserMessageContent = images === undefined ? text : [{ type: "text", text }, ...images];
				this.holdInput({ content, kind, expandPromptTemplates: false });
			}
		}
		this.releasedWait = wait;
		this.givenUp = wait;
		this.reattachSessionId = current.sessionId;
		this.releasedSettings = { model: current.model, thinkingLevel: current.thinkingLevel };
		this.session = undefined;
		this.sessionPromise = undefined;
		this.resumeCurrentSession = false;
		this.sessionSettingsManager = undefined;
		// The session manager holds the whole transcript; the reopened session gets a fresh one from the store.
		this.callerSessionManager = undefined;
		this.artifactCapture.releaseSession();
		// Everything that belongs to this residency goes with the session; the next residency starts afresh.
		const residency = this.residencyState;
		this.residencyState = undefined;
		if (residency !== undefined) {
			residency.messageAdmission.dispose();
			for (const unsubscribe of residency.listenerUnsubscribes.values()) unsubscribe();
			void residency.replacement.dispose();
		}
		this.unsubscribeTerminateWatcher?.();
		this.unsubscribeTerminateWatcher = undefined;
		this.unbindAbortSignal?.();
		this.unbindAbortSignal = undefined;
		// The stage's task host stops reaching for the session it is about to lose; the next session rebinds it.
		if (this.sharedOrchestrationContext !== undefined) parkWorkflowStageForRelease(this.sharedOrchestrationContext);
		await disposeStageSession(current);
		const compaction = stageSessionCompaction(current);
		if (compaction !== undefined) {
			for (const listener of this.pendingListeners) listener({ type: "background_compaction", compaction });
		}
	}

	/** Reopen the released stage once, however many callers need its session: they all join the same reopening. */
	private reopen(wait: StageWaitSnapshot, results?: readonly DetachedToolResult[]): Promise<void> {
		const rehydration = this.reopenReleasedSession(wait, results).finally(() => {
			if (this.rehydration === rehydration) this.rehydration = undefined;
		});
		this.rehydration = rehydration;
		return rehydration;
	}

	/**
	 * Take the stage's admission back and reopen its session from the store. The results a tool wait was woken with are
	 * recorded first, so a stage that cannot reopen continues from them on resume. A store that is briefly unreachable
	 * is tried again; a stage that still cannot reopen keeps waiting released, with its record, and throws.
	 */
	private async reopenReleasedSession(
		wait: StageWaitSnapshot,
		results: readonly DetachedToolResult[] | undefined,
	): Promise<void> {
		const hooks = this.opts.waiting!;
		let session: StageSessionRuntime;
		try {
			if (results !== undefined) await hooks.recordResults(wait, results);
			session = await this.reopenWithRetries(wait, hooks);
		} catch (error) {
			// Nothing wakes a tool wait again: callers waiting for its session learn why it never came.
			if (wait.kind === "tool") {
				this.releasedWait = undefined;
				this.reopenFailure = error;
				this.bindAbortSignal();
				const ended = this.releasedWaitEnded;
				this.releasedWaitEnded = undefined;
				ended?.reject(error);
			}
			throw error;
		}
		if (reopensOnUse(wait)) hooks.dispatcher.unregister(hooks.wakeKey);
		const ended = this.releasedWaitEnded;
		this.releasedWaitEnded = undefined;
		const held = this.heldWhileReleased ?? [];
		this.heldWhileReleased = undefined;
		for (const input of held) {
			const { text, images } = splitStageContent(input.content);
			const options =
				input.expandPromptTemplates === undefined
					? undefined
					: { expandPromptTemplates: input.expandPromptTemplates };
			if (input.kind === "steer") await session.steer(text, images, options);
			else await session.followUp(text, images, options);
		}
		this.lastActivityAt = Date.now();
		ended?.resolve();
		await hooks.rehydrated(wait);
	}

	/**
	 * Reopen the session, taking the stage's admission for each attempt and giving it back after a failed one. Only a
	 * failure of the session store or the network is tried again, at most {@link STAGE_WAIT_RETRY_ATTEMPTS} times in
	 * all, after a backoff that the stage's pause holds and its abort or the run's ends.
	 */
	private async reopenWithRetries(
		wait: StageWaitSnapshot,
		hooks: NonNullable<StageRunnerOpts["waiting"]>,
	): Promise<StageSessionRuntime> {
		const startedAt = Date.now();
		for (let attempt = 1; ; attempt++) {
			await this.takePauseResume();
			await hooks.leave(wait);
			this.releasedWait = undefined;
			this.bindAbortSignal();
			try {
				return await this.openSession("prompt");
			} catch (error) {
				this.unbindAbortSignal?.();
				this.unbindAbortSignal = undefined;
				this.releasedWait = wait;
				await hooks.reopenFailed(wait);
				this.throwUnlessReopenRetries(error, attempt, startedAt);
			}
			await this.waitBeforeReopening(attempt);
		}
	}

	/** A paused stage reopens only once resumed; the resume message reaches the reopened session as steering. */
	private async takePauseResume(): Promise<void> {
		const pause = this.pauseControl.currentResume();
		if (pause === undefined) return;
		const resumed = await pause;
		await resumed.runnerOwnedDeliverySettlement;
		if (resumed.message !== undefined)
			this.holdInput({ content: resumed.message, kind: "steer", expandPromptTemplates: false });
	}

	/**
	 * Classify a failed attempt to reopen by its cause: the run's abort rethrows its reason, a missing session and any
	 * failure that is not the store's or the network's end the reopening at once, and a store still unreachable after
	 * the last attempt throws a `StageRehydrationError` that blocks the run resumably.
	 */
	private throwUnlessReopenRetries(error: unknown, attempt: number, startedAt: number): void {
		const { signal } = this.opts;
		if (signal?.aborted) throw signal.reason;
		if (this.disposed) throw error;
		const cause = stageReopenFailureCause(error);
		if (cause === "other") throw error;
		const fields = {
			runId: this.opts.runId,
			stageId: this.opts.stageId,
			stageName: this.opts.stageName,
			...(this.reattachSessionId === undefined ? {} : { sessionId: this.reattachSessionId }),
		};
		if (cause === "session-not-found")
			throw new StageRehydrationError(fields, { code: "session-not-found", cause: error });
		if (attempt < STAGE_WAIT_RETRY_ATTEMPTS) return;
		throw new StageRehydrationError(
			{
				...fields,
				phase: "reopen",
				attempts: attempt,
				elapsedMs: Date.now() - startedAt,
				timeoutMs: STAGE_WAIT_RETRY_BUDGET_MS,
			},
			{ cause: error },
		);
	}

	private async waitBeforeReopening(attempt: number): Promise<void> {
		const backoff = new AbortController();
		this.reopenBackoff = backoff;
		try {
			const { signal } = this.opts;
			await sleepOrAbort(
				stageWaitRetryDelayMs(attempt),
				signal === undefined ? backoff.signal : AbortSignal.any([backoff.signal, signal]),
			);
		} finally {
			this.reopenBackoff = undefined;
		}
	}

	private cancelReleasedWait(reason: Error | DOMException | string): void {
		const hooks = this.opts.waiting;
		if (hooks === undefined || this.releasedWait?.kind !== "tool") return;
		hooks.dispatcher.cancel(hooks.wakeKey, reason);
	}

	/** True while the stage waits with its session released. */
	isReleased(): boolean {
		return this.releasedWait !== undefined;
	}

	/**
	 * True while the stage has no session because it gave it up: it waits released, is reopening it, or its wait ended
	 * without reopening it (a failed reopen or an abort). False while a session is live, for a stage that never opened
	 * one, and once the stage is disposed (#4309).
	 */
	sessionReleased(): boolean {
		return this.session === undefined && this.givenUp !== undefined && !this.disposed;
	}

	/** The session id a released stage reopens. */
	releasedSessionId(): string | undefined {
		return this.sessionReleased() ? this.reattachSessionId : undefined;
	}

	/** Throw {@link StageReleasedError} for a read of `property`, which needs the session, while it is released. */
	throwIfReleased(property: StageReleasedProperty): void {
		if (!this.sessionReleased()) return;
		throw new StageReleasedError(
			{
				runId: this.opts.runId,
				stageId: this.opts.stageId,
				stageName: this.opts.stageName,
				...(this.reattachSessionId === undefined ? {} : { sessionId: this.reattachSessionId }),
				property,
				...(this.releasedWait === undefined ? {} : { waitKind: this.releasedWait.kind }),
				...(this.reopenFailure === undefined ? {} : { reopenFailed: true }),
			},
			this.reopenFailure === undefined ? undefined : { cause: this.reopenFailure },
		);
	}

	/**
	 * While the session is released: the model and thinking level it had when it was released, a thinking level set
	 * since taking precedence. Undefined while the session is resident or was never opened.
	 */
	releasedModelSettings(): Partial<Pick<StageSessionRuntime, "model" | "thinkingLevel">> | undefined {
		if (!this.sessionReleased()) return undefined;
		return {
			model: this.releasedSettings?.model,
			thinkingLevel: this.requestedThinkingLevel ?? this.releasedSettings?.thinkingLevel,
		};
	}

	/** The released session's messages, read from the session store; the session stays released (#4309). */
	readReleasedMessages(): Promise<StageSessionRuntime["messages"]> {
		const options = this.effectiveStageOptions;
		return readStoredStageMessages(
			{ ...options, cwd: options?.cwd ?? this.opts.defaultCwd },
			this.opts.defaultSessionDir,
			this.reattachSessionId!,
		);
	}

	/**
	 * True while the stage waits on a tool call: released, or with its session still live, inline or resident. A message
	 * sent meanwhile joins the turn the results continue, never a turn of its own (#4309).
	 */
	holdsInput(): boolean {
		return this.releasedWait?.kind === "tool" || this.waitingInline;
	}

	/**
	 * Hold text sent to a stage waiting on a tool call; it reaches the reopened session, with the same options, before
	 * the turn continues. Returns false when the stage is not waiting on a tool call with its session released.
	 */
	holdWhileReleased(
		content: StageUserMessageContent,
		kind: "steer" | "followUp",
		options?: { readonly expandPromptTemplates?: boolean },
	): boolean {
		if (this.releasedWait?.kind !== "tool") return false;
		this.holdInput({ content, kind, expandPromptTemplates: options?.expandPromptTemplates });
		return true;
	}

	private holdInput(input: HeldStageInput): void {
		this.heldWhileReleased ??= [];
		this.heldWhileReleased.push(input);
	}

	/** Queue a message into the live session of a stage waiting on its tool calls; the continued turn takes it. */
	private async queueIntoWaitingTurn(
		content: StageUserMessageContent,
		kind: "steer" | "followUp",
		expandPromptTemplates: boolean,
	): Promise<void> {
		const { text, images } = splitStageContent(content);
		const session = await this.ensureSession();
		if (kind === "steer") await session.steer(text, images, { expandPromptTemplates });
		else await session.followUp(text, images, { expandPromptTemplates });
	}

	/** `stage.release()`: give up the session between prompts until `rehydrate()` or the next message. */
	async release(): Promise<void> {
		await this.releaseBetweenTurns("release");
	}

	/**
	 * Release a stage the workflow holds without using; false when it is busy, keeps its session by policy, or cannot
	 * be reopened. The next message or `rehydrate()` reopens it.
	 */
	releaseIdle(): Promise<boolean> {
		return this.releaseBetweenTurns("idle");
	}

	/** Release the stage while its readiness question waits on a human; false when it cannot release now. */
	releaseForPrompt(): Promise<boolean> {
		return this.releaseBetweenTurns("prompt");
	}

	/**
	 * When the stage last became idle with its session resident, or undefined while it is busy, released or has no
	 * session. The run's idle scan releases it once this is older than its threshold.
	 */
	idleSince(): number | undefined {
		if (this.releasedWait !== undefined || this.promptsInFlight > 0 || !this.isIdleForRelease()) return undefined;
		return this.lastActivityAt;
	}

	/**
	 * Release between turns. An explicit `release()` refuses a busy stage with a typed error; the automatic kinds only
	 * release a stage that is quiet, may release by policy, and has nothing queued.
	 */
	private async releaseBetweenTurns(kind: "release" | "idle" | "prompt"): Promise<boolean> {
		if (this.releasing !== undefined) await this.joinRelease();
		if (this.releasedWait !== undefined || this.disposed) return false;
		const session = this.session;
		const hooks = this.opts.waiting;
		if (session === undefined) return false;
		const explicit = kind === "release";
		const busy =
			this.promptsInFlight > 0 ||
			session.isStreaming ||
			this.residencyState?.messageAdmission.isBusy() === true ||
			this.activeCreation !== undefined;
		const fields = {
			runId: this.opts.runId,
			stageId: this.opts.stageId,
			stageName: this.opts.stageName,
			sessionId: session.sessionId,
		};
		if (busy) {
			if (explicit) throw new StageReleaseError("stage-busy", fields);
			return false;
		}
		if (hooks === undefined || !this.canReleaseSession(session)) {
			if (explicit) throw new StageReleaseError("not-reopenable", fields);
			return false;
		}
		if (!explicit && (hooks.policy === undefined || !this.isIdleForRelease())) return false;
		const releasing = this.commitRelease({ kind, since: Date.now() }, hooks);
		this.releasing = releasing;
		try {
			return await releasing;
		} finally {
			if (this.releasing === releasing) this.releasing = undefined;
		}
	}

	/**
	 * One transition: give up the session, then mark the stage waiting with the dispatcher and the executor. Every
	 * caller that would reopen the stage joins the transition first, so the stage is never marked waiting once reopened.
	 */
	private async commitRelease(
		wait: StageWaitSnapshot,
		hooks: NonNullable<StageRunnerOpts["waiting"]>,
	): Promise<boolean> {
		await this.releaseSession(wait);
		if (this.releasedWait !== wait) return false;
		hooks.dispatcher.register({
			runId: this.opts.runId,
			stageId: this.opts.stageId,
			reason: wait.kind,
			wakeKey: hooks.wakeKey,
		});
		await hooks.enter(wait);
		return true;
	}

	/** Wait for a release under way to settle; its own caller learns how it ended. */
	private async joinRelease(): Promise<void> {
		await Promise.allSettled([this.releasing]);
	}

	/**
	 * A durably resumed stage whose process stopped while it waited between turns starts released: it keeps no session
	 * until a call that is not answered from the run's record needs one, which reopens `sessionId` from the store.
	 */
	resumeReleased(wait: StageWaitSnapshot, sessionId: string): void {
		const hooks = this.opts.waiting;
		if (hooks === undefined || !reopensOnUse(wait) || this.session !== undefined || this.disposed) return;
		this.releasedWait = wait;
		this.givenUp = wait;
		this.reattachSessionId = sessionId;
		this.unbindAbortSignal?.();
		this.unbindAbortSignal = undefined;
		hooks.dispatcher.register({
			runId: this.opts.runId,
			stageId: this.opts.stageId,
			reason: wait.kind,
			wakeKey: hooks.wakeKey,
		});
	}

	/**
	 * `stage.rehydrate()`: reopen a stage released between turns, or one whose wait ended without reopening its session,
	 * as its next prompt would. Does nothing for a resident stage, or one waiting on a tool call, which its result wakes.
	 */
	async rehydrate(): Promise<void> {
		if (this.releasing !== undefined) await this.joinRelease();
		if (this.rehydration !== undefined) return this.rehydration;
		const wait = this.releasedWait;
		if (reopensOnUse(wait) && !this.disposed) return this.reopen(wait);
		if (wait === undefined && this.sessionReleased()) await this.ensureSession();
	}

	private async promptSegment(
		text: string,
		sdkOptions: PromptOptions | undefined,
		consumer: AgentSessionConsumer = "prompt",
		newSessionText?: string,
	): Promise<void> {
		if (this.effectiveStageOptions?.model === "auto" && this.pendingDetachedResults === undefined)
			await this.preparePrompt(text);
		if (
			this.session !== undefined &&
			this.activeCreation === undefined &&
			this.ownedCreationPromise === undefined &&
			this.residency.startupWait.signal.aborted
		) {
			this.opts.signal?.throwIfAborted();
			this.residency.startupWait = new AbortController();
		}
		if (!this.hasExplicitModelFallbackConfig) {
			try {
				const activeSession = await this.ensureSession(consumer);
				const resumedText = this.pendingCreationResumeMessage;
				this.pendingCreationResumeMessage = undefined;
				const value = activeSession.model ?? "default";
				const candidate = { id: workflowModelId(value) ?? "default", value };
				this.beginAttemptUsage(activeSession);
				try {
					await this.promptWithThrownErrorRetry(
						activeSession,
						resumedText ?? text,
						resumedText === undefined ? sdkOptions : resumeMessageOptions(sdkOptions),
					);
				} catch (error) {
					await this.handleCandidateFailure(error, candidate, [candidate], 0);
					throw error;
				}
				this.recordSuccessfulAttempt(candidate);
			} catch (error) {
				if (error instanceof StageSessionCreationCancelled) return;
				throw error;
			}
			return;
		}

		// An attached session is not usable until its creation/readiness owner
		// settles. Join before every explicit-model reuse path, including resume.
		const readinessOwner = this.ownedCreationPromise ?? this.activeCreation;
		if (readinessOwner !== undefined) await waitForStageStartup(readinessOwner, this.residency.startupWait.signal);

		if (this.session === undefined) this.beginStartup();
		const startupSignal = this.residency.startupWait.signal;
		const candidates = await waitForStageStartup(this.modelCandidates(), startupSignal);
		if (candidates.length === 0) {
			try {
				const activeSession = await this.ensureSession(consumer);
				const resumedText = this.pendingCreationResumeMessage;
				this.pendingCreationResumeMessage = undefined;
				await this.promptWithThrownErrorRetry(
					activeSession,
					resumedText ?? text,
					resumedText === undefined ? sdkOptions : resumeMessageOptions(sdkOptions),
				);
				this.artifactCapture.settleAttempt(true);
			} catch (error) {
				this.artifactCapture.settleAttempt(false);
				if (error instanceof StageSessionCreationCancelled) return;
				throw error;
			}
			return;
		}

		// A creation already in flight — an eager walk, or a concurrent caller —
		// owns the candidate chain. Join it rather than starting a second walk that
		// would duplicate provider work and leak whichever session lost the race.
		const creationOwner = this.ownedCreationPromise ?? this.activeCreation;
		if (creationOwner !== undefined) await waitForStageStartup(creationOwner, startupSignal);

		// A paused creation resumed with a replacement objective: that text is
		// authoritative for this prompt and must not be dropped here.
		const resumedText = this.pendingCreationResumeMessage;
		this.pendingCreationResumeMessage = undefined;
		let promptText = resumedText ?? text;
		let promptOptions = resumedText === undefined ? sdkOptions : resumeMessageOptions(sdkOptions);
		const useResumeMessage = (message: string | undefined): void => {
			if (message === undefined) return;
			promptText = message;
			promptOptions = resumeMessageOptions(sdkOptions);
		};
		const walk = this.candidateWalk(candidates, this.activeCandidateIndex ?? 0);
		if (await this.tryResumeCurrentSession(promptText, promptOptions, candidates, walk)) return;
		// A follow-up written for the conversation it continues (a structured-output
		// correction) cannot stand alone in a session that never saw the stage
		// prompt, so every session the walk prompts from here receives the caller's
		// self-contained text instead (issue #3323).
		if (resumedText === undefined && newSessionText !== undefined) promptText = newSessionText;
		let index = this.activeCandidateIndex ?? 0;
		while (index < candidates.length) {
			// Attachment may have acquired the creation walk while shutdown drained.
			// Join that entire walk, including its failures, rather than accounting
			// for the same successor attempt twice or restarting a rejected candidate.
			if (this.ownedCreationPromise !== undefined || this.activeCreation !== undefined) {
				try {
					await waitForStageStartup(this.ownedCreationPromise ?? this.activeCreation!, startupSignal);
				} catch (error) {
					if (error instanceof StageSessionCreationCancelled) return;
					throw error;
				}
				index = this.activeCandidateIndex ?? index;
				useResumeMessage(this.pendingCreationResumeMessage);
				this.pendingCreationResumeMessage = undefined;
			}
			const readyIndex = await this.selectReadyCandidate(candidates, walk, index);
			if (readyIndex === undefined) return;
			index = readyIndex;
			useResumeMessage(this.pendingCreationResumeMessage);
			this.pendingCreationResumeMessage = undefined;
			const candidate = candidates[index]!;
			try {
				if (this.session !== undefined && this.activeCandidateIndex !== index)
					await this.disposeCurrentSession(index);
				const created =
					this.session && this.activeCandidateIndex === index
						? this.session
						: await waitForStageStartup(
								this.createSessionWithThrownErrorRetry(candidate, consumer),
								startupSignal,
							);
				if (isSessionCreationPauseResult(created)) {
					if (created.resumeMessage === undefined) return;
					useResumeMessage(created.resumeMessage);
					continue;
				}
				const activeSession = created;
				this.activeCandidateIndex = index;
				this.selectedModel = candidate.id;
				this.notifyModelFallbackMetaChange();
				this.beginAttemptUsage(activeSession);
				const { terminalScanStartIndex } = await this.promptWithThrownErrorRetry(
					activeSession,
					promptText,
					promptOptions,
				);
				const terminalFailure = latestTerminalAssistantFailureSince(activeSession.messages, terminalScanStartIndex);
				if (terminalFailure !== undefined) {
					if (this.capturedStructuredOutputForAttempt()) {
						this.recordSuccessfulAttempt(candidate);
						return;
					}
					throw new WorkflowPromptModelFailure(terminalFailure);
				}
				this.recordSuccessfulAttempt(candidate);
				return;
			} catch (err) {
				const failure = await this.handleCandidateFailure(err, candidate, candidates, index, walk);
				if (failure === "handled") return;
				if (failure === "throw") {
					this.settleStartup(true);
					throw err;
				}
				index = this.activeCandidateIndex ?? index + 1;
			}
		}
	}

	currentModelFallbackMeta(): StageModelFallbackMeta {
		const attemptedModels = this.modelAttempts.map((attempt) => attempt.model);
		const model =
			(this.modelRoute ? workflowModelId(this.session?.model) : undefined) ??
			this.selectedModel ??
			workflowModelId(this.session?.model);
		const thinkingLevel = this.session?.thinkingLevel ?? this.pendingThinkingLevel;
		const rateLimits = [...this.rateLimitProviders].flatMap((provider) => {
			const snapshot = providerRateLimitSnapshot(provider);
			return snapshot === undefined
				? []
				: [
						{
							...snapshot,
							...(this.rateLimitWait?.provider === provider ? { waitingUntil: this.rateLimitWait.until } : {}),
						},
					];
		});
		return {
			...(this.modelRoute ? { routerSelection: this.modelRoute.routerSelection } : {}),
			...(model !== undefined ? { model } : {}),
			...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
			...(attemptedModels.length > 0 ? { attemptedModels } : {}),
			...(this.modelAttempts.length > 0 ? { modelAttempts: [...this.modelAttempts] } : {}),
			...(rateLimits.length > 0 ? { rateLimits } : {}),
			...(this.modelWarnings.length > 0 ? { warnings: [...this.modelWarnings] } : {}),
		};
	}

	async disposeAll(): Promise<void> {
		if (this.disposalPromise !== undefined) return this.disposalPromise;
		if (this.pauseControl.isConfirmedPaused()) {
			this.pendingDisposal = true;
			return;
		}
		this.pendingDisposal = false;
		this.disposalPromise = this.finishDisposeAll();
		return this.disposalPromise;
	}

	private async finishDisposeAll(): Promise<void> {
		this.disposed = true;
		const reason = stageError(this.opts.stageName, "session has been disposed");
		this.markAbort(reason);
		this.cancelReleasedWait(reason);
		this.pauseControl.reject(reason);
		for (const unsubscribe of this.residencyState?.listenerUnsubscribes.values() ?? []) unsubscribe();
		this.residencyState?.listenerUnsubscribes.clear();
		this.pendingListeners.clear();
		this.unsubscribeTerminateWatcher?.();
		this.unsubscribeTerminateWatcher = undefined;
		// The run's signal outlives this stage: a listener left on it keeps the disposed session reachable
		// for as long as the run goes on.
		this.unbindAbortSignal?.();
		this.unbindAbortSignal = undefined;
		this.residencyState?.terminatingToolCallIds.clear();
		this.residencyState?.messageAdmission.dispose();
		this.deliveryActivity.dispose();
		await this.residencyState?.replacement.dispose();
		// The creation owner also owns any attached-but-not-ready session. It
		// disposes that session only after its final readiness callback settles.
		if (this.activeCreation === undefined) await disposeStageSession(this.session);
	}

	/**
	 * A disposal deferred by a confirmed pause still has to happen once that
	 * pause is gone. Abort/kill rejects the parked waiter, so the session and its
	 * listeners must be torn down here rather than leaked.
	 */
	private async drainPendingDisposal(): Promise<void> {
		if (!this.pendingDisposal) return;
		await this.disposeAll();
	}

	async abort(): Promise<void> {
		const reason = new DOMException("stage aborted", "AbortError");
		this.markAbort(reason);
		this.cancelReleasedWait(reason);
		this.pauseControl.reject(reason);
		try {
			await this.session?.abort();
		} finally {
			await this.drainPendingDisposal();
		}
	}
	requestPause(): Promise<void> {
		const pause = this.pauseControl.requestPause();
		const resume = this.pauseControl.currentResume();
		if (resume !== undefined) {
			this.pauseThrownErrorRetries(resume);
			// A creation in flight cannot see the pause request itself, because
			// completing the resume clears it before creation settles.
			for (const observer of this.residencyState?.creationPauseObservers ?? []) {
				if (observer.pauseResume !== undefined) continue;
				observer.pauseResume = resume;
				this.latchCreationResume(resume);
			}
		}
		return pause;
	}
	resume(
		message?: string,
		beforeResolve?: (result: StageSessionPauseResumeResult) => void,
		beforeRelease?: () => void,
	): Promise<StageSessionPauseResumeResult> {
		return this.pauseControl.resume(message, beforeResolve, beforeRelease).then((result) => {
			// Ownership has returned to live execution, but a handle released while
			// paused may already be gone from the registry. Keep the deferred-disposal
			// marker so terminal teardown can drain it for this ownerless execution.
			return result;
		});
	}
	isPaused(): boolean {
		return this.pauseControl.isPaused();
	}
	sessionMeta(): { sessionId: string | undefined; sessionFile: string | undefined } {
		return { sessionId: this.session?.sessionId, sessionFile: this.session?.sessionFile };
	}
	agentSession(): AgentSession | undefined {
		return asAgentSession(this.session);
	}
	pendingMessageCount(): number {
		return typeof this.session?.pendingMessageCount === "number" ? this.session.pendingMessageCount : 0;
	}

	/** Store holding this session's saved conversation, when it outlives the session itself. */
	persistedSessionStore(): SessionStore | undefined {
		return this.session === undefined ? undefined : this.callerSessionManager?.getSessionStore();
	}

	/** True when no message, turn, creation, retry, pause, or queue work still needs the live session. */
	/** True while a message, the stage's own prompt included, holds or waits for the turn loop. */
	isTurnLoopBusy(): boolean {
		return this.residencyState?.messageAdmission.isBusy() === true;
	}

	isIdleForRelease(): boolean {
		const session = this.session;
		if (session === undefined || this.disposed || this.pendingDisposal || this.disposalPromise !== undefined)
			return false;
		if (this.activeCreation !== undefined || this.ownedCreationPromise !== undefined) return false;
		const residency = this.residencyState;
		if (this.sessionShutdownPromise !== undefined || residency?.replacement.retiringSession !== undefined)
			return false;
		if (this.pauseControl.isPaused()) return false;
		if ((residency?.thrownErrorRetryStates.size ?? 0) > 0) return false;
		if (residency?.messageAdmission.isBusy() === true) return false;
		return isStageSessionQuiescent(session);
	}

	private bindAbortSignal(): void {
		const { signal } = this.opts;
		if (!signal) return;
		const abortReason = (): Error | DOMException | string => {
			const reason = signal.reason;
			if (reason instanceof Error || reason instanceof DOMException || typeof reason === "string") return reason;
			return new DOMException("workflow killed", "AbortError");
		};
		const onAbort = (): void => {
			const reason = abortReason();
			this.markAbort(reason);
			void this.session?.abort().catch(() => {});
			this.pauseControl.reject(reason);
			void this.drainPendingDisposal().catch(() => {});
		};
		if (signal.aborted) onAbort();
		else {
			signal.addEventListener("abort", onAbort, { once: true });
			this.unbindAbortSignal = () => signal.removeEventListener("abort", onAbort);
		}
	}

	private markAbort(reason: Error | DOMException | string): void {
		this.abortGeneration += 1;
		this.abortReason = reason;
		this.abortReasonGeneration = this.abortGeneration;
		this.routeAuthorityWait?.abort(reason);
		this.residencyState?.startupWait.abort(reason);
		this.reopenBackoff?.abort(reason);
		if (this.startup?.state === "active") {
			this.startup = { ...this.startup, state: "cancelled" };
			this.opts.onStartupChange?.(this.startup);
		}
		this.abortThrownErrorRetries(reason);
	}

	private pauseThrownErrorRetries(resume: RetryPauseResume): void {
		for (const state of this.residencyState?.thrownErrorRetryStates ?? []) {
			if (state.pauseResume !== undefined) continue;
			state.pauseResume = resume;
			state.controller.abort(new ThrownErrorRetryPaused(resume));
		}
	}

	private abortThrownErrorRetries(reason?: Error | DOMException | string): void {
		const states = this.residencyState?.thrownErrorRetryStates;
		for (const state of states ?? []) state.controller.abort(reason);
		states?.clear();
	}

	/** `retry.fallbackOnContentFilter`: whether a content-filter refusal spends the next candidate. */
	private fallbackFailureOptions(): ModelFallbackFailureOptions {
		return { fallbackOnContentFilter: this.retrySettings()?.fallbackOnContentFilter !== false };
	}

	private retrySettings(): WorkflowRetrySettings | undefined {
		const managers = [
			this.sessionSettingsManager,
			this.session?.settingsManager,
			this.effectiveStageOptions?.settingsManager,
		];
		for (const manager of managers) {
			if (manager === undefined || typeof manager.getRetrySettings !== "function") continue;
			return manager.getRetrySettings();
		}
		return undefined;
	}
	/**
	 * Latch a fresh high-level usage window against the active session. The
	 * boundary is the message length before the candidate prompt, so retries,
	 * pause/re-prompts, and recording never re-read a later index.
	 */
	private beginAttemptUsage(session: StageSessionRuntime): void {
		this.sessionInternalRetries = 0;
		this.attemptUsageStartIndex = session.messages.length;
		this.discardedAttemptUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	}

	/**
	 * Consume the current window exactly once. A session-creation failure has no
	 * window: clear the latch instead of reading a previous session's messages.
	 */
	private takeAttemptUsage(session: StageSessionRuntime | undefined): WorkflowModelUsage | undefined {
		const start = this.attemptUsageStartIndex;
		const usage =
			session === undefined || start === undefined
				? undefined
				: usageForAttempt(session.messages, start, this.discardedAttemptUsage);
		this.clearAttemptUsage();
		return usage;
	}

	private clearAttemptUsage(): void {
		this.attemptUsageStartIndex = undefined;
		this.discardedAttemptUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	}

	/**
	 * Keep the usage of an error assistant that a retry restoration is about to
	 * remove from the live transcript, so the final attempt total still counts it.
	 */
	private accrueDiscardedAttemptUsage(message: StageAssistantMessage): void {
		if (!hasMeaningfulUsage(message.usage)) return;
		this.discardedAttemptUsage.input += message.usage.input;
		this.discardedAttemptUsage.output += message.usage.output;
		this.discardedAttemptUsage.cacheRead += message.usage.cacheRead;
		this.discardedAttemptUsage.cacheWrite += message.usage.cacheWrite;
		this.discardedAttemptUsage.cost += message.usage.cost.total;
		this.discardedAttemptUsage.turns += 1;
	}

	/**
	 * Drop this attempt's failed input from live state before a same-candidate
	 * retry, keeping unrelated concurrent messages. The durable transcript keeps
	 * everything; this mirrors main-chat retry, which also only edits live state.
	 *
	 * `keepPrompt` retains the admitted stage prompt because the continuation
	 * path resumes the existing turn with `_runAgentContinue()`, and pi-agent-core
	 * rejects a transcript that does not end in a user or tool-result message.
	 * Returns the retained prompt so a later re-`prompt()` can drop it.
	 */
	private restoreSessionMessages(
		session: StageSessionRuntime,
		snapshot: StageSessionRuntime["messages"],
		promptText: string,
		keepPrompt: boolean,
		discardAttemptTurns = false,
	): StageSessionRuntime["messages"][number] | undefined {
		const snapshotMessages = new Set(snapshot);
		const admitted = session.messages.filter((message) => !snapshotMessages.has(message));
		for (const message of admitted) {
			if (message.role !== "assistant" || (!discardAttemptTurns && message.stopReason !== "error")) continue;
			this.accrueDiscardedAttemptUsage(message);
		}
		const failedAssistantIndex = admitted.findLastIndex(
			(message) => message.role === "assistant" && message.stopReason === "error",
		);
		const promptUser = admitted
			.slice(0, failedAssistantIndex < 0 ? admitted.length : failedAssistantIndex)
			.findLast((message) => message.role === "user" && stageUserMessageText(message) === promptText);
		const retainedMessages = admitted.filter((message) => {
			if (message === promptUser) return keepPrompt;
			if (message.role === "assistant") return !discardAttemptTurns && message.stopReason !== "error";
			if (message.role === "toolResult" && discardAttemptTurns) return false;
			return ["user", "toolResult", "custom", "bashExecution", "branchSummary"].includes(message.role);
		});
		session.messages.splice(0, session.messages.length, ...snapshot, ...retainedMessages);
		return keepPrompt ? promptUser : undefined;
	}

	/** Remove a prompt retained for a continuation that will not happen. */
	private dropRetainedPrompt(
		session: StageSessionRuntime,
		retained: StageSessionRuntime["messages"][number] | undefined,
	): void {
		if (retained === undefined) return;
		const index = session.messages.indexOf(retained);
		if (index >= 0) session.messages.splice(index, 1);
	}
	private candidateWalk(candidates: readonly WorkflowResolvedModelCandidate[], start: number): CandidateWalk {
		for (const candidate of candidates) {
			const provider = workflowProviderId(candidate.value);
			if (provider !== undefined) this.rateLimitProviders.add(provider);
		}
		return {
			remaining: new Set(candidates.map((_, index) => index).filter((index) => index >= start)),
			rateLimitFailures: new Map(),
			rateLimited: new Set(),
			cooldownRounds: 0,
		};
	}

	private recordCandidateFailure(
		walk: CandidateWalk,
		index: number,
		error: unknown,
		candidates: readonly WorkflowResolvedModelCandidate[],
	): void {
		const failures = (walk.rateLimitFailures.get(index) ?? 0) + 1 + this.sessionInternalRetries;
		this.sessionInternalRetries = 0;
		const settings = this.retrySettings();
		const retries = settings?.enabled === false ? 0 : (settings?.maxRetries ?? 2);
		// A limit that resets beyond the retry-delay cap is exhausted for this walk, like a spent quota:
		// when another candidate is left, move on at once and never wait for it.
		const rateLimited =
			isWorkflowRateLimit(error) &&
			!([...walk.remaining].some((other) => other !== index) && this.candidateUnavailable(candidates[index]?.value));
		if (rateLimited) {
			walk.rateLimitFailures.set(index, failures);
			if (failures <= retries) return;
			walk.rateLimited.add(index);
		}
		walk.remaining.delete(index);
		// #3984: when every candidate left is throttled, the chain is not exhausted but cooling. Give each
		// throttled candidate a fresh budget and wait for the earliest cooldown (none when one is already
		// ready), if it fits the retry-hint cap, at most `retry.maxRetries` times per walk.
		if (!rateLimited || walk.remaining.size > 0 || walk.cooldownRounds >= retries) return;
		// A candidate whose cooldown already ended counts as zero: it is ready now and needs no wait.
		const cooldowns = [...walk.rateLimited].map((limited) => candidateCooldownMs(candidates[limited]?.value));
		if (cooldowns.length === 0) return;
		if (Math.min(...cooldowns) > this.maxCooldownWaitMs()) return;
		walk.cooldownRounds += 1;
		for (const limited of walk.rateLimited) {
			walk.remaining.add(limited);
			walk.rateLimitFailures.delete(limited);
		}
		walk.rateLimited.clear();
	}

	private async selectReadyCandidate(
		candidates: readonly WorkflowResolvedModelCandidate[],
		walk: CandidateWalk,
		start: number,
	): Promise<number | undefined> {
		while (walk.remaining.size > 0) {
			this.opts.signal?.throwIfAborted();
			let earliest: { index: number; delay: number } | undefined;
			let earliestUnavailable: { index: number; delay: number } | undefined;
			// One clock reading per scan: candidates sharing a provider cooldown must see the same remaining
			// time, or a later candidate whose read lands after the cooldown ends jumps ahead of the walk order.
			const now = Date.now();
			for (let offset = 0; offset < candidates.length; offset += 1) {
				const index = (start + offset) % candidates.length;
				if (!walk.remaining.has(index)) continue;
				const candidate = candidates[index]!;
				const delay = candidateCooldownMs(candidate.value, now);
				// An exhausted quota or a reset beyond the wait cap is used only when nothing else is left.
				if (this.candidateUnavailable(candidate.value, now)) {
					if (earliestUnavailable === undefined || delay < earliestUnavailable.delay)
						earliestUnavailable = { index, delay };
					continue;
				}
				if (delay === 0) return index;
				if (earliest === undefined || delay < earliest.delay) earliest = { index, delay };
			}
			earliest ??= earliestUnavailable;
			if (earliest === undefined) return undefined;
			if (earliest.delay === 0) return earliest.index;
			try {
				await this.sleepForRateLimit(workflowProviderId(candidates[earliest.index]!.value), earliest.delay);
			} catch (error) {
				if (!(error instanceof ThrownErrorRetryPaused)) throw error;
				const resumed = await error.resume;
				await resumed.runnerOwnedDeliverySettlement;
				if (resumed.message === undefined) return undefined;
				this.pendingCreationResumeMessage = resumed.message;
			}
		}
		return undefined;
	}

	private currentProvider(): string | undefined {
		return workflowProviderId(this.currentModelValue());
	}

	private currentModelValue(): WorkflowModelValue | undefined {
		return this.session?.model ?? this.selectedModel ?? this.effectiveStageOptions?.model;
	}

	/** Longest cooldown worth waiting for: the retry-hint cap the same-model retry policy uses. */
	private maxCooldownWaitMs(): number {
		const settings = this.retrySettings();
		return settings?.maxRetryDelayMs || (settings?.maxAgentDelayMs ?? 60_000);
	}

	private candidateUnavailable(value: WorkflowModelValue | undefined, now?: number): boolean {
		if (candidateUnavailableMs(value, now) > 0) return true;
		const cooldown = candidateCooldownMs(value, now);
		return cooldown > 0 && cooldown > this.maxCooldownWaitMs();
	}

	private async sleepForRateLimit(provider: string | undefined, delay: number): Promise<void> {
		if (provider !== undefined) this.rateLimitProviders.add(provider);
		const wait = provider === undefined ? undefined : { provider, until: Date.now() + delay };
		this.rateLimitWait = wait;
		this.notifyModelFallbackMetaChange();
		try {
			await this.sleepForThrownErrorRetry(Math.min(delay, 60_000), { controller: new AbortController() });
		} finally {
			if (this.rateLimitWait === wait) this.rateLimitWait = undefined;
			this.notifyModelFallbackMetaChange();
		}
	}

	private async waitForProvider(value: WorkflowModelValue | undefined): Promise<void> {
		const provider = workflowProviderId(value);
		let delay = candidateCooldownMs(value);
		while (delay > 0) {
			await this.sleepForRateLimit(provider, delay);
			delay = candidateCooldownMs(value);
		}
	}

	private async sleepForThrownErrorRetry(delayMs: number, state: ThrownErrorRetryState): Promise<void> {
		this.residency.thrownErrorRetryStates.add(state);
		const currentResume = this.pauseControl.currentResume();
		if (currentResume !== undefined) {
			state.pauseResume = currentResume;
			state.controller.abort(new ThrownErrorRetryPaused(currentResume));
		}
		try {
			await sleepOrAbort(delayMs, state.controller.signal);
		} finally {
			this.residency.thrownErrorRetryStates.delete(state);
		}
	}

	/**
	 * Resume the existing turn under the same pause rules as a prompt.
	 *
	 * A controlled pause aborts the in-flight request, which must not be mistaken
	 * for a terminal model failure: the stage would advance a candidate and become
	 * unrecoverable by resume.
	 */
	private async continueWithPauseResume(
		continuationSession: RetryableAgentSession,
	): Promise<{ readonly kind: "continued" } | { readonly kind: "paused"; readonly message?: string }> {
		const settlePause = async (resume: RetryPauseResume): Promise<{ kind: "paused"; message?: string }> => {
			const resumed = await resume;
			await resumed.runnerOwnedDeliverySettlement;
			return { kind: "paused", ...(resumed.message === undefined ? {} : { message: resumed.message }) };
		};
		const pauseBeforeContinue = this.pauseControl.currentResume();
		if (pauseBeforeContinue !== undefined) return settlePause(pauseBeforeContinue);

		const state: ThrownErrorRetryState = { controller: new AbortController() };
		this.residency.thrownErrorRetryStates.add(state);
		try {
			await this.waitForProvider(this.currentModelValue());
			await continuationSession._runAgentContinue();
		} catch (error) {
			const resume = state.pauseResume ?? this.pauseControl.currentResume();
			if (resume === undefined) throw error;
			return settlePause(resume);
		} finally {
			this.residency.thrownErrorRetryStates.delete(state);
		}
		const pauseAfterContinue = state.pauseResume ?? this.pauseControl.currentResume();
		if (pauseAfterContinue !== undefined) return settlePause(pauseAfterContinue);
		return { kind: "continued" };
	}

	/**
	 * Whether a failure nothing recognizes gets this candidate's same-model retries before the stage's own chain moves
	 * on. It does when the chain has a candidate after this one, which the failure would otherwise switch to on its
	 * first occurrence; with none it fails at once. The main chat applies the same rule to its chain (#4223).
	 */
	private async retriesUnrecognizedFailure(error: unknown): Promise<boolean> {
		if (!this.hasExplicitModelFallbackConfig || !isUnrecognizedModelFailure(error)) return false;
		const candidates = await this.modelCandidates();
		return candidates[(this.activeCandidateIndex ?? 0) + 1] !== undefined;
	}

	private async promptWithThrownErrorRetry(
		activeSession: StageSessionRuntime,
		text: string,
		sdkOptions: PromptOptions | undefined,
	): Promise<{ readonly terminalScanStartIndex: number }> {
		let retryAttempt = 0;
		let nextText = text;
		let nextOptions = sdkOptions;
		let retryAdmittedPrompt = false;
		let retainedPrompt: StageSessionRuntime["messages"][number] | undefined;
		let terminalScanStartIndex: number | undefined;
		while (true) {
			this.checkedSession(activeSession);
			// Same-model retries must not accept answers from an earlier failed iteration.
			this.artifactCapture.beginAttempt(activeSession);
			const messagesBeforeAttempt = [...activeSession.messages];
			try {
				if (retryAdmittedPrompt) {
					const continuationSession = retryableAgentSession(activeSession);
					if (continuationSession !== undefined) {
						const outcome = await this.continueWithPauseResume(continuationSession);
						if (outcome.kind === "continued") {
							const continuedScanStartIndex =
								terminalScanStartIndex ?? this.lastPromptStartIndex ?? messagesBeforeAttempt.length;
							this.throwIfEmptyCompletion(activeSession, continuedScanStartIndex);
							// A retried unrecognized failure that fails again spends the next retry, not the chain.
							const continuedFailure = latestTerminalAssistantFailureSince(
								activeSession.messages,
								continuedScanStartIndex,
							);
							if (continuedFailure !== undefined && (await this.retriesUnrecognizedFailure(continuedFailure)))
								throw new WorkflowPromptModelFailure(continuedFailure);
							return { terminalScanStartIndex: continuedScanStartIndex };
						}
						// A controlled pause interrupted the continuation. The resumed
						// objective owns the turn from here, so re-prompt with it rather
						// than resuming a turn the operator replaced.
						this.dropRetainedPrompt(activeSession, retainedPrompt);
						retainedPrompt = undefined;
						retryAdmittedPrompt = false;
						retryAttempt = 0;
						terminalScanStartIndex = undefined;
						if (outcome.message === undefined) {
							return { terminalScanStartIndex: activeSession.messages.length };
						}
						nextText = outcome.message;
						nextOptions = resumeMessageOptions(sdkOptions);
						continue;
					}
					// No continuation is possible after all, so the retained prompt
					// must not survive into the re-prompt below.
					this.dropRetainedPrompt(activeSession, retainedPrompt);
					retainedPrompt = undefined;
					retryAdmittedPrompt = false;
				}
				const result = await this.promptWithPauseResume(activeSession, nextText, nextOptions);
				const terminalFailure = latestTerminalAssistantFailureSince(
					activeSession.messages,
					result.terminalScanStartIndex,
				);
				if (
					terminalFailure !== undefined &&
					(isWorkflowRateLimit(terminalFailure) || (await this.retriesUnrecognizedFailure(terminalFailure)))
				)
					throw new WorkflowPromptModelFailure(terminalFailure);
				return {
					terminalScanStartIndex: terminalScanStartIndex ?? result.terminalScanStartIndex,
				};
			} catch (error) {
				// The stage brings its session back for a save of its results that failed; no model was at fault.
				if (error instanceof DetachedResultsNotSaved) throw error;
				const errorSettingsManager = retrySettingsManagerFromError(error);
				if (errorSettingsManager !== undefined) this.sessionSettingsManager = errorSettingsManager;
				// An already-unresolved context overflow is terminal for this model:
				// compaction has run and failed, so another identical request cannot
				// help. It stays fallbackable so `handleCandidateFailure()` advances.
				// Same-model retry eligibility is narrower than fallback eligibility:
				// auth, model-unavailable, and request-incompatible failures advance
				// to the next candidate immediately instead of burning the retry
				// budget on a request the same model has already rejected.
				const retryableFailure = isRetryableModelFailure(error, this.fallbackFailureOptions());
				const sameCandidateRetryable =
					(isRetryableSameModelFailure(error) || (await this.retriesUnrecognizedFailure(error))) &&
					!isUnresolvedContextOverflowFailure(error);
				recordProviderRateLimit(this.currentProvider(), error, workflowModelName(this.currentModelValue()));
				if (this.hasExplicitModelFallbackConfig && isWorkflowRateLimit(error)) {
					this.restoreSessionMessages(activeSession, messagesBeforeAttempt, nextText, false, true);
					throw error;
				}
				const decision = nextRetryDecision(
					this.retrySettings(),
					retryAttempt,
					sameCandidateRetryable,
					workflowRetryHint(error),
				);
				const continuationSession = retryableAgentSession(activeSession);
				const admittedMessages = activeSession.messages.length > messagesBeforeAttempt.length;
				const willRetry =
					decision !== undefined &&
					!this.disposed &&
					this.opts.signal?.aborted !== true &&
					!this.capturedStructuredOutputForAttempt();
				// The continuation path resumes the same turn, so it needs the
				// admitted prompt to stay; the re-prompt path re-sends it.
				const willContinue = continuationSession !== undefined && admittedMessages;
				if (retryableFailure && willRetry) {
					this.artifactCapture.settleAttempt(false);
					retainedPrompt =
						this.restoreSessionMessages(activeSession, messagesBeforeAttempt, nextText, willContinue) ??
						retainedPrompt;
				}
				if (!willRetry) throw error;
				terminalScanStartIndex ??= this.lastPromptStartIndex ?? messagesBeforeAttempt.length;
				retryAttempt = decision.attempt;
				const state: ThrownErrorRetryState = { controller: new AbortController() };
				let pauseResume: RetryPauseResume | undefined;
				try {
					await this.sleepForThrownErrorRetry(decision.delayMs, state);
				} catch (sleepError) {
					if (sleepError instanceof ThrownErrorRetryPaused) pauseResume = sleepError.resume;
					else {
						if (this.opts.signal?.aborted) throw this.workflowAbortReason();
						if (this.disposed) throw stageError(this.opts.stageName, "session has been disposed");
						throw sleepError;
					}
				}
				if (pauseResume !== undefined) {
					const resumed = await pauseResume;
					retryAttempt = 0;
					retryAdmittedPrompt = false;
					terminalScanStartIndex = undefined;
					// A resumed prompt re-sends its text, so the retained input would
					// otherwise be duplicated.
					this.dropRetainedPrompt(activeSession, retainedPrompt);
					retainedPrompt = undefined;
					if (resumed.message === undefined) {
						return { terminalScanStartIndex: activeSession.messages.length };
					}
					nextText = resumed.message;
					nextOptions = resumeMessageOptions(sdkOptions);
					continue;
				}
				if (this.disposed) throw stageError(this.opts.stageName, "session has been disposed");
				if (this.opts.signal?.aborted) throw this.workflowAbortReason();
				// Only resume the existing turn when the restored transcript still
				// satisfies pi-agent-core's continuation contract. A retained
				// non-error assistant tail would otherwise be rejected, so fall back
				// to re-prompting and drop the input that path re-sends.
				retryAdmittedPrompt = willContinue && canContinueFromTranscript(activeSession);
				if (!retryAdmittedPrompt) {
					this.dropRetainedPrompt(activeSession, retainedPrompt);
					retainedPrompt = undefined;
				}
			}
		}
	}

	private workflowAbortReason(): Error | DOMException | string {
		const reason = this.opts.signal?.reason;
		if (reason instanceof Error || reason instanceof DOMException || typeof reason === "string") return reason;
		return new DOMException("workflow killed", "AbortError");
	}

	private staleCreationReason(startGeneration: number): Error | DOMException | string {
		if (this.opts.signal?.aborted) return this.workflowAbortReason();
		if (this.abortReasonGeneration > startGeneration && this.abortReason !== undefined) return this.abortReason;
		return new DOMException("stage aborted", "AbortError");
	}

	/** Scoped models resolve once, through the same catalog rules as the primary model. */
	private scopedModels(): Promise<WorkflowResolvedScopedModel[] | undefined> {
		const scopedModels = this.effectiveStageOptions?.scopedModels;
		if (scopedModels === undefined) return Promise.resolve(undefined);
		this.scopedModelsPromise ??= resolveScopedModelsFromCatalog({
			scopedModels: scopedModels.map((entry) => entry.model as WorkflowModelValue),
			catalog: this.modelCatalog,
		});
		return this.scopedModelsPromise;
	}

	private modelCandidates(): Promise<WorkflowResolvedModelCandidate[]> {
		if (!this.candidatesPromise) {
			const resolved = buildModelCandidatesFromCatalog({
				primaryModel: this.modelRoute?.modelOverride ?? this.explicitModel ?? this.effectiveStageOptions?.model,
				fallbackModels: [
					...(this.modelRoute?.fallbackModels ?? []),
					...(this.effectiveStageOptions?.fallbackModels ?? []),
				],
				catalog: this.modelCatalog,
				includeCurrentModel: this.modelRoute !== undefined,
			});
			this.candidatesPromise = this.modelRoute
				? resolved.then((candidates) => {
						if (!this.modelRoute) return candidates;
						this.modelRoute.assertCurrent();
						const effort = this.modelRoute.routerSelection.effort ?? undefined;
						const seenModels = new Set<string>();
						const allowed = candidates
							.filter((candidate) => {
								if (
									typeof candidate.value === "string" ||
									!this.modelRoute!.allowsModel(candidate.value, candidate.reasoningLevel ?? effort)
								)
									return false;
								const id = `${candidate.value.provider}/${candidate.value.id}`;
								if (seenModels.has(id)) return false;
								seenModels.add(id);
								return true;
							})
							.map((candidate) => ({
								...candidate,
								...(candidate.reasoningLevel === undefined && effort !== undefined
									? { reasoningLevel: effort as WorkflowResolvedModelCandidate["reasoningLevel"] }
									: {}),
							}));
						if (allowed.length === 0)
							throw new Error("Workflow stage auto has no eligible execution candidates.");
						return allowed;
					})
				: resolved;
		}
		return this.candidatesPromise;
	}

	private async createInitialSession(consumer: AgentSessionConsumer): Promise<StageSessionRuntime> {
		const generation = this.abortGeneration;
		if (!this.hasExplicitModelFallbackConfig) {
			return this.createSessionObservingPause(undefined, consumer).catch((error) =>
				this.createInitialSessionWithRetry(undefined, consumer, { error }),
			);
		}
		const candidates = await this.modelCandidates();
		if (this.abortGeneration !== generation || this.opts.signal?.aborted || this.disposed)
			throw this.staleCreationReason(generation);
		const initialIndex = this.activeCandidateIndex ?? 0;
		const first = candidates[initialIndex];
		if (first === undefined) {
			return this.createSessionObservingPause(undefined, consumer).catch((error) =>
				this.createInitialSessionWithRetry(undefined, consumer, { error }),
			);
		}
		if (this.reattachSessionId !== undefined) {
			const resumed = await this.createSession(undefined, consumer, { restoreSavedModel: true });
			const restoredId = workflowModelId(resumed.model);
			const exactRestoredIndex =
				restoredId === undefined
					? -1
					: candidates.findIndex(
							(entry) => entry.id === restoredId && entry.reasoningLevel === resumed.thinkingLevel,
						);
			// An unspecified effort accepts the SDK's effective effort, but must not
			// shadow a later candidate explicitly declaring the saved reasoning tier.
			const restoredIndex =
				exactRestoredIndex >= 0
					? exactRestoredIndex
					: candidates.findIndex((entry) => entry.id === restoredId && entry.reasoningLevel === undefined);
			this.activeCandidateIndex = restoredIndex >= 0 ? restoredIndex : undefined;
			this.selectedModel = restoredId ?? first.id;
			this.resumeCurrentSession = true;
			return resumed;
		}
		this.activeCandidateIndex = initialIndex;
		this.selectedModel = first.id;
		return this.createSessionObservingPause(first, consumer).catch((error) =>
			this.createInitialSessionCandidateWalk(candidates, consumer, initialIndex, { error }),
		);
	}

	/**
	 * Creation-only version of the prompt candidate walk.
	 *
	 * An eagerly created session (`ctx.__ensureSession()`, an eager stage call, a
	 * control attach) has no prompt to drive `promptWithFallback()`, so without
	 * this a candidate whose creation keeps failing would exhaust its retries and
	 * throw while the configured fallbacks were never tried.
	 */
	private async createInitialSessionCandidateWalk(
		candidates: readonly WorkflowResolvedModelCandidate[],
		consumer: AgentSessionConsumer,
		startIndex: number,
		initialFailure: { readonly error: unknown } | undefined,
	): Promise<StageSessionRuntime> {
		let index = startIndex;
		let pendingFailure = initialFailure;
		let lastError: unknown = initialFailure?.error;
		const walk = this.candidateWalk(candidates, startIndex);
		while (index < candidates.length) {
			if (pendingFailure === undefined) {
				const readyIndex = await this.selectReadyCandidate(candidates, walk, index);
				if (readyIndex === undefined) throw new StageSessionCreationCancelled();
				index = readyIndex;
			}
			const candidate = candidates[index]!;
			this.activeCandidateIndex = index;
			this.selectedModel = candidate.id;
			try {
				const created = await this.createSessionWithThrownErrorRetry(candidate, consumer, pendingFailure);
				pendingFailure = undefined;
				if (!isSessionCreationPauseResult(created)) {
					this.notifyModelFallbackMetaChange();
					return created;
				}
				if (created.resumeMessage === undefined) {
					// A pause without a replacement objective cancels this pending
					// creation. Let the next prompt start a fresh creation attempt.
					this.pendingCreationResumeMessage = undefined;
					this.sessionPromise = undefined;
					throw new StageSessionCreationCancelled();
				}
				// The replacement objective belongs to the next prompt; this
				// candidate is still the one being created.
				this.pendingCreationResumeMessage = created.resumeMessage;
			} catch (error) {
				if (error instanceof StageSessionCreationCancelled) throw error;
				pendingFailure = undefined;
				lastError = error;
				const failure = await this.handleCandidateFailure(error, candidate, candidates, index, walk);
				if (failure === "handled") throw new StageSessionCreationCancelled();
				if (failure !== "retry") throw error;
				index = this.activeCandidateIndex ?? index + 1;
			}
		}
		throw lastError ?? stageError(this.opts.stageName, "has no usable model candidate");
	}

	private async createInitialSessionWithRetry(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
		initialFailure?: { readonly error: unknown },
	): Promise<StageSessionRuntime> {
		let pendingFailure = initialFailure;
		while (true) {
			const created = await this.createSessionWithThrownErrorRetry(candidate, consumer, pendingFailure);
			pendingFailure = undefined;
			if (!isSessionCreationPauseResult(created)) return created;
			if (created.resumeMessage === undefined) {
				// A pause without a replacement objective cancels this pending
				// creation. Let the next prompt start a fresh creation attempt.
				this.pendingCreationResumeMessage = undefined;
				this.sessionPromise = undefined;
				throw new StageSessionCreationCancelled();
			}
			this.pendingCreationResumeMessage = created.resumeMessage;
		}
	}

	/**
	 * Latch a paused creation's replacement objective for the next prompt.
	 *
	 * The created session is already attached, so the pause cannot cancel it
	 * without leaking it; the replacement text becomes the next prompt's input.
	 */
	private latchCreationResume(resume: RetryPauseResume): void {
		void resume
			.then(async (resolved) => {
				await resolved.runnerOwnedDeliverySettlement;
				if (resolved.message !== undefined) this.pendingCreationResumeMessage = resolved.message;
			})
			.catch(() => {});
	}

	/**
	 * Create while a controlled pause can still be observed.
	 *
	 * `requestPause()` latches its resume into every registered creation observer,
	 * so a pause that both starts and finishes while the adapter is still in
	 * flight is caught. Checking `currentResume()` after the await would miss it,
	 * because completing a resume clears the pause request.
	 *
	 * The creation promise is returned untouched, and observers are kept out of
	 * the thrown-retry set: this must add no microtask hop and must not alter
	 * abort or backoff semantics. An attached stream stays observable in the
	 * caller's own turn.
	 */
	private createSessionObservingPause(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
	): Promise<StageSessionRuntime> {
		const activePause = this.pauseControl.currentResume();
		const observer: CreationPauseObserver = { pauseResume: activePause };
		if (activePause !== undefined) this.latchCreationResume(activePause);
		this.residency.creationPauseObservers.add(observer);
		const creation = this.createSession(candidate, consumer);
		const settle = (): void => {
			this.residency.creationPauseObservers.delete(observer);
		};
		creation.then(settle, settle);
		return creation;
	}

	private async createSessionWithThrownErrorRetry(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
		initialFailure?: { readonly error: unknown },
	): Promise<StageSessionRuntime | SessionCreationPauseResult> {
		let retryAttempt = 0;
		let pendingFailure = initialFailure;
		while (true) {
			try {
				if (pendingFailure !== undefined) {
					const failure = pendingFailure;
					pendingFailure = undefined;
					throw failure.error;
				}
				return await this.createSessionObservingPause(candidate, consumer);
			} catch (error) {
				if (error instanceof StageSessionBindingCleanupFailure) throw error;
				const errorSettingsManager = retrySettingsManagerFromError(error);
				if (errorSettingsManager !== undefined) this.sessionSettingsManager = errorSettingsManager;
				// A stage refused its queued Intercom instructions will be refused them
				// by every retry, so the terminal delivery failure is never eligible —
				// independent of what the shared model-failure classifier makes of it.
				const decision = isWorkflowPendingStageDeliveryFailure(error)
					? undefined
					: nextRetryDecision(
							this.retrySettings(),
							retryAttempt,
							isRetryableSameCandidateFailure(error),
							workflowRetryHint(error),
						);
				const candidateModel = candidate?.value ?? candidate?.id;
				recordProviderRateLimit(workflowProviderId(candidateModel), error, workflowModelName(candidateModel));
				if (candidate !== undefined && isWorkflowRateLimit(error)) throw error;
				if (
					decision === undefined ||
					this.disposed ||
					this.opts.signal?.aborted === true ||
					this.residency.startupWait.signal.aborted ||
					this.capturedStructuredOutputForAttempt()
				) {
					throw error;
				}
				retryAttempt = decision.attempt;
				const state: ThrownErrorRetryState = { controller: new AbortController() };
				try {
					await this.sleepForThrownErrorRetry(decision.delayMs, state);
				} catch (sleepError) {
					if (sleepError instanceof ThrownErrorRetryPaused) {
						const resumed = await sleepError.resume;
						return {
							kind: "paused",
							...(resumed.message === undefined ? {} : { resumeMessage: resumed.message }),
						};
					}
					if (this.opts.signal?.aborted) throw this.workflowAbortReason();
					if (this.disposed) throw stageError(this.opts.stageName, "session has been disposed");
					throw sleepError;
				}
				if (this.disposed) throw stageError(this.opts.stageName, "session has been disposed");
				if (this.opts.signal?.aborted) throw this.workflowAbortReason();
			}
		}
	}

	private createSession(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
		resumeOptions?: { restoreSavedModel?: boolean },
	): Promise<StageSessionRuntime> {
		if (this.bindingCleanupFailure !== undefined) return Promise.reject(this.bindingCleanupFailure);
		if (this.sessionShutdownPromise !== undefined) {
			const generation = this.abortGeneration;
			return this.sessionShutdownPromise.then(() => {
				if (this.disposed || this.opts.signal?.aborted || this.abortGeneration !== generation)
					throw this.staleCreationReason(generation);
				return this.createSession(candidate, consumer, resumeOptions);
			});
		}
		if (this.activeCreation !== undefined) return this.activeCreation;
		if (this.session !== undefined) return Promise.resolve(this.session);
		this.residency.startupWait.signal.throwIfAborted();
		const creation = this.createSessionAttempt(candidate, consumer, resumeOptions);
		this.activeCreation = creation;
		void creation
			.finally(() => {
				if (this.activeCreation === creation) this.activeCreation = undefined;
				this.settleStartup();
			})
			.catch(() => {});
		return creation;
	}

	private settleStartup(failed = false): void {
		if (this.activeCreation !== undefined || this.ownedCreationPromise !== undefined || this.startup === undefined)
			return;
		if (this.startup.state === "dispatched" || this.startup.phase === "ready") return;
		if (this.startup.state === "active" && !failed && this.bindingCleanupFailure === undefined) return;
		this.startup = {
			...this.startup,
			state: this.startup.state === "active" ? "failed" : this.startup.state,
			ownershipPending: this.bindingCleanupFailure !== undefined,
			...(this.bindingCleanupFailure === undefined ? { settledAt: Date.now() } : {}),
		};
		this.opts.onStartupChange?.(this.startup);
	}

	private beginStartup(): void {
		if (
			this.activeCreation !== undefined ||
			this.ownedCreationPromise !== undefined ||
			this.sessionPromise !== undefined
		)
			return;
		this.opts.signal?.throwIfAborted();
		if (this.residency.startupWait.signal.aborted) this.residency.startupWait = new AbortController();
		this.reportStartupPhase("model-resolution", true);
	}

	private reportStartupPhase(phase: StageStartupPhase, reset = false): void {
		if (!reset && this.startup !== undefined && this.startup.state !== "active") return;
		const now = Date.now();
		this.startup = {
			phase,
			startedAt: reset ? now : (this.startup?.startedAt ?? now),
			phaseStartedAt: now,
			state: phase === "first-dispatch" ? "dispatched" : "active",
			ownershipPending: phase !== "first-dispatch" && phase !== "ready",
		};
		this.opts.onStartupChange?.(this.startup);
	}

	/**
	 * Built outside `createSessionAttempt` on purpose: under JavaScriptCore a closure created inside an async function
	 * keeps the locals that function saved at its last await, so a reporter made there would keep the attempt's session
	 * reachable for as long as the stage holds its meta, including while the stage waits with that session released.
	 */
	private startupPhaseReporter(startGeneration: number): (phase: StageStartupPhase) => void {
		return (phase) => {
			if (this.abortGeneration === startGeneration) this.reportStartupPhase(phase);
		};
	}

	private async createSessionAttempt(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
		resumeOptions?: { restoreSavedModel?: boolean },
	): Promise<StageSessionRuntime> {
		const startGeneration = this.abortGeneration;
		if (this.disposed || this.opts.signal?.aborted) throw this.staleCreationReason(startGeneration);
		this.modelRoute?.assertCurrent();
		this.reportStartupPhase("route-authority");
		const authority = this.opts.routeAuthorityReady?.();
		if (authority !== undefined) {
			const wait = new AbortController();
			this.routeAuthorityWait = wait;
			try {
				await raceAbort(authority.completion, wait.signal);
				authority.assertCurrent();
				if (this.disposed || this.opts.signal?.aborted || this.abortGeneration !== startGeneration)
					throw this.staleCreationReason(startGeneration);
			} finally {
				if (this.routeAuthorityWait === wait) this.routeAuthorityWait = undefined;
			}
		}
		this.reportStartupPhase("resource-preparation");
		const scopedModels = await this.scopedModels();
		if (this.disposed || this.opts.signal?.aborted || this.abortGeneration !== startGeneration)
			throw this.staleCreationReason(startGeneration);
		// Saved effort must survive attachment so the restored candidate can be identified.
		if (resumeOptions?.restoreSavedModel) this.pendingThinkingLevel = undefined;
		else if (candidate?.reasoningLevel !== undefined || this.pendingThinkingLevel === undefined)
			this.applyCandidateThinking(candidate);
		const stageOptions = await buildStageSessionOptions({
			effectiveStageOptions: this.effectiveStageOptions,
			candidate,
			ownsFallbackChain: this.hasExplicitModelFallbackConfig,
			scopedModels,
			restoreSavedModel: resumeOptions?.restoreSavedModel,
			reattachSessionId: this.reattachSessionId,
			sharedModelRuntime: this.sharedModelRuntime,
			defaultCwd: this.opts.defaultCwd,
		});
		if (stageOptions && this.modelRoute) stageOptions.isFallbackModelAllowed = this.modelRoute.allowsModel;
		let created: StageSessionRuntime | StageSessionCreateResult;
		try {
			this.modelRoute?.assertCurrent();
			if (
				this.modelRoute &&
				candidate &&
				(typeof candidate.value === "string" ||
					!this.modelRoute.allowsModel(candidate.value, candidate.reasoningLevel))
			)
				throw new Error("Workflow stage execution candidate is no longer eligible.");
			const adapter = this.opts.adapters.agentSession ?? missingAdapter(consumer);
			const createOptions = (await stripWorkflowOnlyOptions(
				stageOptions,
				this.opts.defaultSessionDir,
				this.meta,
				this.opts.pendingStageDelivery,
				this.residency.startupWait.signal,
			)) as StageSessionCreateOptions;
			this.callerSessionManager = createOptions.sessionManager;
			created = await adapter.create(createOptions, {
				...this.meta,
				startupSignal: this.residency.startupWait.signal,
				isFallbackAttempt: candidate !== undefined && candidate !== (await this.modelCandidates())[0],
				...(this.residency.replacement.retiringSession !== undefined
					? { replacesSession: this.residency.replacement.retiringSession }
					: {}),
				onStartupPhase: this.startupPhaseReporter(startGeneration),
				stageOptions,
				...(this.sharedOrchestrationContext !== undefined
					? { orchestrationContext: this.sharedOrchestrationContext }
					: {}),
			});
		} catch (error) {
			if (error instanceof StageSessionBindingCleanupFailure) {
				this.bindingCleanupFailure = error;
				throw error;
			}
			if (this.disposed || this.opts.signal?.aborted === true || this.abortGeneration !== startGeneration)
				throw this.disposed
					? stageError(this.opts.stageName, "session has been disposed")
					: this.staleCreationReason(startGeneration);
			throw error;
		}
		if (this.disposed || this.opts.signal?.aborted === true || this.abortGeneration !== startGeneration) {
			await disposeStageSession(normalizeSessionCreateResult(created).session).catch(() => {});
			if (this.disposed) throw stageError(this.opts.stageName, "session has been disposed");
			throw this.staleCreationReason(startGeneration);
		}
		this.reportStartupPhase("session-attachment");
		const session = attachCreatedStageSession(created, this.disposed, this.opts.stageName, (result) =>
			this.attachSession(result),
		);
		const attachedSession = session instanceof Promise ? await session : session;
		this.reportStartupPhase("delivery-readiness");
		try {
			const thinkingLevel =
				this.requestedThinkingLevel ??
				(asAgentSession(attachedSession) === undefined ? this.pendingThinkingLevel : undefined);
			if (thinkingLevel !== undefined) {
				await attachedSession.setThinkingLevel(thinkingLevel);
				this.requestedThinkingLevel = undefined;
			}
			await this.sharedOrchestrationContext?.pendingStageDelivery?.ready(attachedSession.sessionId);
			if (
				this.effectiveStageOptions?.durableReplayKey !== undefined &&
				this.effectiveStageOptions.resumeFromSessionId !== undefined
			)
				await attachedSession.startPendingRecovery?.("workflow_stage_resume");
			await this.opts.onSessionReady?.();
			if (this.disposed || this.opts.signal?.aborted || this.abortGeneration !== startGeneration)
				throw this.staleCreationReason(startGeneration);
		} catch (reason) {
			// Attachment is not readiness. The retained creation owns cleanup on
			// both rejection and cancellation; never expose this identity for reuse.
			if (this.session === attachedSession) this.session = undefined;
			try {
				await cleanupFailedStageSessionBinding(attachedSession, reason);
			} catch (error) {
				if (error instanceof StageSessionBindingCleanupFailure) this.bindingCleanupFailure = error;
				throw error;
			}
			throw reason;
		}
		this.givenUp = undefined;
		this.reopenFailure = undefined;
		this.reportStartupPhase("ready");
		return attachedSession;
	}

	private attachSession(created: StageSessionRuntime | StageSessionCreateResult): StageSessionRuntime {
		const result = normalizeSessionCreateResult(created);
		const orchestrationContext = asAgentSession(result.session)?.orchestrationContext;
		if (this.sharedOrchestrationContext === undefined && orchestrationContext !== undefined) {
			this.sharedOrchestrationContext = orchestrationContext;
		}
		if (this.generationSealed) result.session.sealWorkflowStageGeneration?.();
		this.residency.replacement.adopt(result.session);
		this.session = result.session;
		this.applyToolDetachment(result.session);
		this.sessionSettingsManager = result.settingsManager ?? result.session.settingsManager;
		if (this.sharedModelRuntime === undefined) {
			const withRegistry = result.session as Partial<Pick<AgentSession, "modelRuntime">>;
			if (withRegistry.modelRuntime !== undefined) this.sharedModelRuntime = withRegistry.modelRuntime;
		}
		for (const listener of this.pendingListeners) {
			this.residency.listenerUnsubscribes.set(listener, result.session.subscribe(listener));
		}
		// The session may already hold a queue — transferred from the session it
		// just replaced, or restored with it — and it published that queue while
		// these listeners were bound to nothing. Replay the one snapshot they
		// missed, so a handle's projection and any mounted chat start from the
		// session's real pending state rather than from empty.
		const missedQueueUpdate = stageSessionQueueUpdateEvent(result.session);
		if (missedQueueUpdate !== undefined) {
			for (const listener of this.pendingListeners) listener(missedQueueUpdate);
		}
		// Likewise its background compaction state: a replacement or reopened session may already hold a
		// saved result, and a stage must not keep showing the state of the session it replaced.
		const compaction = stageSessionCompaction(result.session);
		if (compaction !== undefined) {
			for (const listener of this.pendingListeners) listener({ type: "background_compaction", compaction });
		}
		this.unsubscribeTerminateWatcher?.();
		let applyingFallback = false;
		const onSessionEvent = this.opts.onSessionEvent;
		this.unsubscribeTerminateWatcher = result.session.subscribe((event) => {
			if (onSessionEvent !== undefined) {
				// A caller's event observer must never break the stage it observes; a `void`
				// callback may still be async, so its rejection is settled here too.
				try {
					void Promise.resolve(onSessionEvent(event)).catch(() => {});
				} catch {}
			}
			this.lastActivityAt = Date.now();
			if (event.type === "auto_retry_start") this.sessionInternalRetries += 1;
			if (event.type === "model_fallback_start") applyingFallback = true;
			// SDK effort-only fallbacks suppress model_changed, but emit thinking_level_changed
			// after applying both model and effort. Ignore effort changes outside fallback selection.
			if (
				(event.type === "model_changed" && event.source === "fallback") ||
				(event.type === "thinking_level_changed" && applyingFallback)
			) {
				applyingFallback = false;
				this.selectedModel = workflowModelId(event.type === "model_changed" ? event.model : result.session.model);
				this.notifyModelFallbackMetaChange();
			}
			this.artifactCapture.onEvent(result.session, event);
			const terminatingId = terminatingToolCallId(event);
			if (terminatingId !== undefined) this.residency.terminatingToolCallIds.add(terminatingId);
			this.unresolvedContextOverflowMessage =
				unresolvedContextOverflowMessage(event) ?? this.unresolvedContextOverflowMessage;
			const structuredOutputToolError = structuredOutputToolErrorFromEvent(event);
			if (structuredOutputToolError !== undefined) {
				this.latestStructuredOutputToolErrorValue = structuredOutputToolError;
				if (!isStructuredOutputContractFailure(structuredOutputToolError))
					this.structuredOutputExecutionFailureValue ??= structuredOutputToolError;
			}
		});
		return result.session;
	}

	private async disposeCurrentSession(nextCandidateIndex: number | undefined): Promise<void> {
		// A later prompt must not replace a rejected cleanup barrier with an empty shutdown.
		if (this.sessionShutdownPromise !== undefined) await this.sessionShutdownPromise;
		const startGeneration = this.abortGeneration;
		this.abortThrownErrorRetries(stageError(this.opts.stageName, "session was replaced"));
		const current = this.session;
		this.residency.messageAdmission.reset();
		this.residency.replacement.retire(current);
		this.session = undefined;
		this.activeCandidateIndex = nextCandidateIndex;
		// A candidate walk still advancing owns the shared creation promise: clearing
		// it here would let a concurrent caller start a second walk, duplicating
		// provider work and leaking whichever session lost the race.
		if (this.sessionPromise !== this.ownedCreationPromise) this.sessionPromise = undefined;
		this.sessionSettingsManager = undefined;
		this.resumeCurrentSession = false;
		for (const unsubscribe of this.residency.listenerUnsubscribes.values()) unsubscribe();
		this.residency.listenerUnsubscribes.clear();
		this.unsubscribeTerminateWatcher?.();
		this.unsubscribeTerminateWatcher = undefined;
		this.residency.terminatingToolCallIds.clear();
		// #3020: every creator must wait for ownership release, not only the prompt
		// advancing fallback. Keep a failed barrier: shutdown failure is not proof
		// of release, so later attachment must fail rather than register a new owner.
		const shutdown = Promise.resolve().then(() => shutdownStageSession(current));
		this.sessionShutdownPromise = shutdown;
		void shutdown.then(
			() => {
				if (this.sessionShutdownPromise === shutdown) this.sessionShutdownPromise = undefined;
			},
			() => {},
		);
		await shutdown;
		if (this.disposed || this.opts.signal?.aborted === true || this.abortGeneration !== startGeneration)
			throw this.staleCreationReason(startGeneration);
	}

	private async promptWithPauseResume(
		activeSession: StageSessionRuntime,
		initialText: string,
		sdkOptions: PromptOptions | undefined,
	): Promise<{ readonly terminalScanStartIndex: number }> {
		let nextText: string | undefined = initialText;
		let nextOptions = sdkOptions;
		while (nextText !== undefined) {
			const pendingPauseBeforePrompt = this.pauseControl.currentResume();
			if (pendingPauseBeforePrompt) {
				const resumed = await pendingPauseBeforePrompt;
				await resumed.runnerOwnedDeliverySettlement;
				nextText = resumed.message;
				nextOptions = resumeMessageOptions(sdkOptions);
				// Detached results still continue their turn when the pause resumes without a message.
				if (nextText === undefined && this.pendingDetachedResults !== undefined) nextText = initialText;
				if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
				continue;
			}
			const promptStartIndex = activeSession.messages.length;
			this.lastPromptStartIndex = promptStartIndex;
			this.unresolvedContextOverflowMessage = undefined;
			try {
				this.reportStartupPhase("first-dispatch");
				// A live resume loops here without returning through the outer retry guard.
				this.checkedSession(activeSession);
				await this.waitForProvider(this.currentModelValue());
				const detachedResults = this.pendingDetachedResults;
				this.pendingDetachedResults = undefined;
				if (detachedResults !== undefined && activeSession.resumeDetachedTurn !== undefined) {
					// A resume message that replaced the continuation reaches the turn as steering, after the results.
					if (nextText !== initialText)
						await activeSession.steer(nextText, undefined, { expandPromptTemplates: false });
					await this.continueFromResults(activeSession, activeSession.resumeDetachedTurn, detachedResults);
				} else await activeSession.prompt(nextText, nextOptions);
				const pendingPauseAfterPrompt = this.pauseControl.currentResume();
				if (pendingPauseAfterPrompt) {
					const resumed = await pendingPauseAfterPrompt;
					await resumed.runnerOwnedDeliverySettlement;
					this.throwUnresolvedContextOverflowIfPresent();
					nextText = resumed.message;
					nextOptions = resumeMessageOptions(sdkOptions);
					if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
					continue;
				}
				this.throwUnresolvedContextOverflowIfPresent();
				this.throwIfEmptyCompletion(activeSession, promptStartIndex);
				return { terminalScanStartIndex: promptStartIndex };
			} catch (err) {
				// The results come back with the reopened session; a pause holds that reopening.
				if (err instanceof DetachedResultsNotSaved) throw err;
				const pendingPauseAfterThrow =
					err instanceof ThrownErrorRetryPaused ? err.resume : this.pauseControl.currentResume();
				if (pendingPauseAfterThrow) {
					const resumed = await pendingPauseAfterThrow;
					await resumed.runnerOwnedDeliverySettlement;
					this.throwUnresolvedContextOverflowIfPresent();
					nextText = resumed.message;
					nextOptions = resumeMessageOptions(sdkOptions);
					if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
					continue;
				}
				this.throwUnresolvedContextOverflowIfPresent();
				throw err;
			}
		}
		return { terminalScanStartIndex: activeSession.messages.length };
	}

	private async tryResumeCurrentSession(
		text: string,
		sdkOptions: PromptOptions | undefined,
		candidates: readonly WorkflowResolvedModelCandidate[],
		walk: CandidateWalk,
	): Promise<boolean> {
		if (!this.resumeCurrentSession || this.session === undefined) return false;
		const currentIndex = this.activeCandidateIndex ?? 0;
		if (
			!walk.remaining.has(currentIndex) ||
			candidateCooldownMs(this.currentModelValue()) > 0 ||
			this.candidateUnavailable(this.currentModelValue())
		) {
			const start = walk.rateLimitFailures.has(currentIndex) ? 0 : currentIndex;
			const index = await this.selectReadyCandidate(candidates, walk, start);
			if (index === undefined) return true;
			if (index !== this.activeCandidateIndex) {
				await this.disposeCurrentSession(index);
				return false;
			}
			const resumedText = this.pendingCreationResumeMessage;
			this.pendingCreationResumeMessage = undefined;
			if (resumedText !== undefined) {
				text = resumedText;
				sdkOptions = resumeMessageOptions(sdkOptions);
			}
		}
		this.resumeCurrentSession = false;
		const resumedSession = this.session;
		const resumedLabel = this.selectedModel ?? workflowModelId(resumedSession.model) ?? candidates[0]!.id;
		this.notifyModelFallbackMetaChange();
		this.beginAttemptUsage(resumedSession);
		try {
			const { terminalScanStartIndex } = await this.promptWithThrownErrorRetry(resumedSession, text, sdkOptions);
			const terminalFailure = latestTerminalAssistantFailureSince(resumedSession.messages, terminalScanStartIndex);
			if (terminalFailure === undefined || this.capturedStructuredOutputForAttempt()) {
				this.artifactCapture.settleAttempt(true);
				const usage = this.takeAttemptUsage(resumedSession);
				this.modelAttempts.push({
					model: resumedLabel,
					success: true,
					...(usage === undefined ? {} : { usage }),
				});
				this.pendingFallbackWarnings.length = 0;
				this.resumeCurrentSession = true;
				// Issue #2812: the resumed candidate's success is durable metadata too.
				this.notifySuccessfulModelFallbackMeta();
				return true;
			}
			throw new WorkflowPromptModelFailure(terminalFailure);
		} catch (err) {
			if (err instanceof DetachedResultsNotSaved) throw err;
			if (this.capturedStructuredOutputForAttempt() && isRetryableModelFailure(err, this.fallbackFailureOptions())) {
				this.artifactCapture.settleAttempt(true);
				const usage = this.takeAttemptUsage(resumedSession);
				this.modelAttempts.push({
					model: resumedLabel,
					success: true,
					...(usage === undefined ? {} : { usage }),
				});
				this.pendingFallbackWarnings.length = 0;
				this.resumeCurrentSession = true;
				// Issue #2812: see above — a corrective success must reach the callback.
				this.notifySuccessfulModelFallbackMeta();
				return true;
			}
			this.artifactCapture.settleAttempt(false);
			const message = errorMessage(err);
			const usage = this.takeAttemptUsage(resumedSession);
			this.modelAttempts.push({
				model: resumedLabel,
				success: false,
				...(usage === undefined ? {} : { usage }),
				error: message,
			});
			if (this.opts.signal?.aborted || !isRetryableModelFailure(err, this.fallbackFailureOptions())) {
				this.modelWarnings.push(...this.pendingFallbackWarnings);
				this.pendingFallbackWarnings.length = 0;
				this.notifyModelFallbackMetaChange();
				throw err;
			}
			if (isWorkflowRateLimit(err)) {
				for (let index = 0; index < currentIndex; index++) walk.remaining.add(index);
				this.recordCandidateFailure(walk, currentIndex, err, candidates);
				if (walk.remaining.size === 0) {
					this.notifyModelFallbackMetaChange();
					throw err;
				}
				this.resumeCurrentSession = true;
				return this.tryResumeCurrentSession(text, sdkOptions, candidates, walk);
			}
			const resumedOverflowNextIndex = nextResumedContextOverflowFallbackIndex(
				err,
				this.activeCandidateIndex,
				candidates.length,
			);
			if (resumedOverflowNextIndex === "terminal") {
				this.modelWarnings.push(...this.pendingFallbackWarnings);
				this.pendingFallbackWarnings.length = 0;
				this.notifyModelFallbackMetaChange();
				throw err;
			}
			if (resumedOverflowNextIndex !== undefined) {
				for (const index of walk.remaining) {
					if (index < resumedOverflowNextIndex) walk.remaining.delete(index);
				}
			} else {
				for (let index = 0; index < currentIndex; index++) walk.remaining.add(index);
			}
			this.pendingFallbackWarnings.push(
				resumedOverflowNextIndex === undefined
					? `[fallback] resume on ${resumedLabel} failed: ${message}. Restarting fallback from ${candidateLabel(candidates[0]!)}.`
					: `[fallback] resume on ${resumedLabel} failed: ${message}. Retrying with ${candidateLabel(candidates[resumedOverflowNextIndex]!)}.`,
			);
			await this.disposeCurrentSession(resumedOverflowNextIndex);
			return false;
		}
	}

	private async settleFailedCandidate(): Promise<void> {
		this.modelWarnings.push(...this.pendingFallbackWarnings);
		this.pendingFallbackWarnings.length = 0;
		this.notifyModelFallbackMetaChange();
		await this.residency.replacement.disposeRetired();
	}

	private async handleCandidateFailure(
		err: unknown,
		candidate: WorkflowResolvedModelCandidate,
		candidates: readonly WorkflowResolvedModelCandidate[],
		index: number,
		walk?: CandidateWalk,
	): Promise<"handled" | "retry" | "throw"> {
		// Neither spends a model attempt: a failed cleanup is sticky, and a failed save of a turn's results is tried again.
		if (err instanceof StageSessionBindingCleanupFailure || err instanceof DetachedResultsNotSaved) throw err;
		const message = errorMessage(err);
		// A terminal pending-stage delivery failure is not a model failure: every
		// candidate would be refused the same queued instructions. It records the one
		// attempt it actually spent and then stops, so no further candidate is walked
		// and no `[fallback]` warning claims a model was at fault.
		const terminalStageDelivery = isWorkflowPendingStageDeliveryFailure(err);
		if (
			!terminalStageDelivery &&
			this.capturedStructuredOutputForAttempt() &&
			isRetryableModelFailure(err, this.fallbackFailureOptions())
		) {
			this.recordSuccessfulAttempt(candidate);
			return "handled";
		}
		this.artifactCapture.settleAttempt(false);
		const usage = this.takeAttemptUsage(this.session);
		this.modelAttempts.push({
			model: candidate.id,
			success: false,
			...modelAttemptReasoning(candidate),
			...(usage === undefined ? {} : { usage }),
			error: message,
		});
		let nextIndex: number | undefined = index + 1 < candidates.length ? index + 1 : undefined;
		if (walk !== undefined) {
			this.recordCandidateFailure(walk, index, err, candidates);
			nextIndex = undefined;
			if (
				!this.opts.signal?.aborted &&
				!this.residency.startupWait.signal.aborted &&
				!terminalStageDelivery &&
				mayAdvanceToNextCandidate(err, this.fallbackFailureOptions())
			) {
				try {
					nextIndex = await this.selectReadyCandidate(candidates, walk, index + 1);
				} catch (error) {
					await this.settleFailedCandidate();
					throw error;
				}
				if (nextIndex === undefined && walk.remaining.size > 0) {
					await this.settleFailedCandidate();
					return "handled";
				}
			}
		}
		if (
			this.opts.signal?.aborted ||
			this.residency.startupWait.signal.aborted ||
			terminalStageDelivery ||
			!mayAdvanceToNextCandidate(err, this.fallbackFailureOptions()) ||
			nextIndex === undefined
		) {
			await this.settleFailedCandidate();
			return "throw";
		}
		const nextCandidate = candidates[nextIndex]!;
		this.pendingFallbackWarnings.push(
			`[fallback] ${candidateLabel(candidate)} failed: ${message}. Retrying with ${candidateLabel(nextCandidate)}.`,
		);
		await this.disposeCurrentSession(nextIndex);
		return "retry";
	}

	private capturedStructuredOutputForAttempt(): boolean {
		return this.structuredOutputCapture?.called === true && this.opts.signal?.aborted !== true;
	}

	private recordSuccessfulAttempt(candidate: WorkflowResolvedModelCandidate): void {
		this.artifactCapture.settleAttempt(true);
		const usage = this.takeAttemptUsage(this.session);
		if (this.modelRoute && this.session?.model)
			candidate = {
				id: workflowModelId(this.session.model)!,
				value: this.session.model,
				reasoningLevel: this.session.thinkingLevel,
			};
		this.modelAttempts.push({
			model: candidate.id,
			success: true,
			...modelAttemptReasoning(candidate),
			...(usage === undefined ? {} : { usage }),
		});
		this.pendingFallbackWarnings.length = 0;
		this.resumeCurrentSession = true;
		// Issue #2812: `onModelFallbackMetaChange` is the only boundary that
		// refreshes the running stage snapshot the durable checkpoint reads. Every
		// notification before this one is emitted on a selection or failure edge,
		// so without this call the last durable record of a stage that fell back
		// holds only the failed attempts, and a run interrupted between here and
		// terminal persistence resumes without the provenance of its own result.
		// Emitted last, after the pending warnings are cleared, so the payload is
		// exactly what the terminal snapshot will carry.
		this.notifySuccessfulModelFallbackMeta();
	}

	private notifyModelFallbackMetaChange(): void {
		this.opts.onModelFallbackMetaChange?.(this.currentModelFallbackMeta());
	}

	/**
	 * Issue #2812: `disposeAll()` neither awaits nor cancels a prompt already
	 * parked in the adapter. That prompt still resolves, and its success still
	 * belongs in `modelAttempts`. Publishing it does not: the stage snapshot is
	 * terminal by then, and the executor writes whatever a callback hands it, so
	 * a late success would stamp `success: true` onto an ended stage. Scoped to
	 * the success edges this repair added — the selection and failure edges keep
	 * the behavior they already had.
	 */
	private notifySuccessfulModelFallbackMeta(): void {
		if (this.disposed) return;
		this.notifyModelFallbackMetaChange();
	}

	private applyCandidateThinking(candidate: WorkflowResolvedModelCandidate | undefined): void {
		this.pendingThinkingLevel = candidate?.reasoningLevel;
	}
	private throwUnresolvedContextOverflowIfPresent(): void {
		const message = this.unresolvedContextOverflowMessage;
		this.unresolvedContextOverflowMessage = undefined;
		if (message !== undefined) throw unresolvedContextOverflowFailure(message);
	}

	/**
	 * A schema-backed prompt that resolved without any assistant message is an
	 * execution-layer failure, not a clean turn awaiting output correction
	 * (issue #3164). Cancellation wins: an aborted stage reports its abort reason
	 * rather than a provider failure the retry loop would try to repair.
	 */
	private throwIfEmptyCompletion(activeSession: StageSessionRuntime, promptStartIndex: number): void {
		if (this.structuredOutputCapture === undefined || this.structuredOutputCapture.called) return;
		if (this.disposed || hasAssistantMessageSince(activeSession.messages, promptStartIndex)) return;
		if (this.opts.signal?.aborted) throw this.workflowAbortReason();
		if (this.residency.startupWait.signal.aborted)
			throw this.abortReason ?? new DOMException("stage aborted", "AbortError");
		throw new WorkflowPromptEmptyCompletionFailure();
	}
}
