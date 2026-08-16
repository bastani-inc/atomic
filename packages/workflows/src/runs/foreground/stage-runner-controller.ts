import {
	type AgentSession,
	type CreateAgentSessionOptions,
	convertToLlm,
	type PromptOptions,
	type StructuredOutputCapture,
	shouldApplyCodexFastModeForScope,
} from "@bastani/atomic";
import type {
	StageContext,
	StageExecutionMeta,
	StageOptions,
	StageSendUserMessageOptions,
	StageUserMessageContent,
	WorkflowModelAttempt,
	WorkflowModelCatalogPort,
	WorkflowModelUsage,
} from "../../shared/types.js";
import {
	buildModelCandidatesFromCatalog,
	errorMessage,
	isRetryableModelFailure,
	isRetryableSameModelFailure,
	type WorkflowResolvedModelCandidate,
	workflowModelId,
} from "../shared/model-fallback.js";
import { nextRetryDecision, sleepOrAbort } from "../shared/retry.js";
import { StageDeliveryActivity, type StageDeliveryActivityListener } from "./stage-delivery-activity.js";
import { stageSessionQueueUpdateEvent } from "./stage-queued-user-messages.js";
import { candidateLabel, effectiveCandidateReasoning, modelAttemptReasoning } from "./stage-runner-candidate.js";
import { StageMessageAdmission } from "./stage-runner-message-admission.js";
import {
	lastAssistantTextFromSession,
	latestTerminalAssistantFailureSince,
	WorkflowPromptModelFailure,
} from "./stage-runner-messages.js";
import { missingAdapter, stripWorkflowOnlyOptions, unavailableSync } from "./stage-runner-options.js";
import { StageSessionPause, type StageSessionPauseResumeResult } from "./stage-runner-pause.js";
import { StageSessionReplacement } from "./stage-runner-replacement.js";
import { sendStageUserMessage } from "./stage-runner-send-user-message.js";
import {
	asAgentSession,
	attachCreatedStageSession,
	disposeStageSession,
	normalizeSessionCreateResult,
} from "./stage-runner-session.js";
import { buildStageSessionOptions } from "./stage-runner-session-options.js";
import { structuredOutputToolErrorFromEvent } from "./stage-runner-structured-output.js";
import type {
	AgentSessionConsumer,
	StageModelFallbackMeta,
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionCreateResult,
	StageSessionEvent,
	StageSessionRuntime,
	StageUserMessagePreparation,
	WorkflowFastModeSettingsManager,
	WorkflowRetrySettings,
} from "./stage-runner-types.js";
import {
	isUnresolvedContextOverflowFailure,
	nextResumedContextOverflowFallbackIndex,
	terminatingToolCallId,
	unresolvedContextOverflowFailure,
	unresolvedContextOverflowMessage,
} from "./stage-runner-unresolved-overflow.js";

type RetryPauseResume = NonNullable<ReturnType<StageSessionPause["currentResume"]>>;

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

function stageUserMessageText(message: StageSessionRuntime["messages"][number]): string | undefined {
	if (message.role !== "user") return undefined;
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("");
}
function retrySettingsManagerFromError(error: unknown): WorkflowFastModeSettingsManager | undefined {
	if (error === null || typeof error !== "object") return undefined;
	const manager = (error as { readonly settingsManager?: unknown }).settingsManager;
	if (manager === null || typeof manager !== "object") return undefined;
	const candidate = manager as Partial<WorkflowFastModeSettingsManager>;
	return typeof candidate.getCodexFastModeSettings === "function"
		? (candidate as WorkflowFastModeSettingsManager)
		: undefined;
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

export class StageSessionController {
	private session: StageSessionRuntime | undefined;
	private activeCreation: Promise<StageSessionRuntime> | undefined;
	/** The creation promise a candidate walk still owns, if one is advancing. */
	private ownedCreationPromise: Promise<StageSessionRuntime> | undefined;
	private abortGeneration = 0;
	private abortReason: Error | DOMException | string | undefined;
	private abortReasonGeneration = 0;
	private sessionPromise: Promise<StageSessionRuntime> | undefined;
	private reattachSessionFile: string | undefined;
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
	private readonly terminatingToolCallIds = new Set<string>();
	private latestStructuredOutputToolErrorValue: string | undefined;
	private unsubscribeTerminateWatcher: (() => void) | undefined;
	private unresolvedContextOverflowMessage: string | undefined;
	private generationSealed = false;
	private disposed = false;
	private pendingThinkingLevel: Parameters<StageContext["setThinkingLevel"]>[0] | undefined;
	private readonly pendingListeners = new Set<(event: StageSessionEvent) => void>();
	private readonly listenerUnsubscribes = new Map<(event: StageSessionEvent) => void, () => void>();
	private readonly pauseControl = new StageSessionPause(() => this.session);
	private readonly hasExplicitModelFallbackConfig: boolean;
	private candidatesPromise: Promise<WorkflowResolvedModelCandidate[]> | undefined;
	private activeCandidateIndex: number | undefined;
	private selectedModel: string | undefined;
	private sharedModelRuntime: CreateAgentSessionOptions["modelRuntime"];
	private sharedOrchestrationContext: CreateAgentSessionOptions["orchestrationContext"];
	private resumeCurrentSession = false;
	private readonly modelAttempts: WorkflowModelAttempt[] = [];
	private readonly modelWarnings: string[] = [];
	private readonly pendingFallbackWarnings: string[] = [];
	private readonly modelCatalog: WorkflowModelCatalogPort | undefined;
	private sessionSettingsManager: WorkflowFastModeSettingsManager | undefined;
	private readonly thrownErrorRetryStates = new Set<ThrownErrorRetryState>();
	private readonly creationPauseObservers = new Set<CreationPauseObserver>();
	private readonly replacement = new StageSessionReplacement();
	private pendingCreationResumeMessage: string | undefined;
	private readonly messageAdmission = new StageMessageAdmission();
	private readonly deliveryActivity = new StageDeliveryActivity();

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

	get latestStructuredOutputToolError(): string | undefined {
		return this.latestStructuredOutputToolErrorValue;
	}

	resetStructuredOutputToolError(): void {
		this.latestStructuredOutputToolErrorValue = undefined;
	}
	requireSession(property: string): StageSessionRuntime {
		if (!this.session) unavailableSync(property);
		return this.session;
	}

	lastAssistantText(fallback: string | undefined): string | undefined {
		return lastAssistantTextFromSession(this.session, fallback, this.terminatingToolCallIds);
	}

	subscribe(listener: (event: StageSessionEvent) => void): () => void {
		this.pendingListeners.add(listener);
		if (this.session) this.listenerUnsubscribes.set(listener, this.session.subscribe(listener));
		return () => {
			this.pendingListeners.delete(listener);
			const unsubscribe = this.listenerUnsubscribes.get(listener);
			this.listenerUnsubscribes.delete(listener);
			unsubscribe?.();
		};
	}

	setThinkingLevel(level: Parameters<StageContext["setThinkingLevel"]>[0]): void {
		this.pendingThinkingLevel = level;
		this.session?.setThinkingLevel(level);
	}

	async ensureSession(consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
		if (this.disposed) throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
		if (this.session !== undefined) return this.session;
		if (!this.sessionPromise) {
			const pending = this.createInitialSession(consumer);
			this.sessionPromise = pending;
			// One creation gate: the walk owns this promise while it advances
			// candidates, so a concurrent caller joins it instead of racing it.
			this.ownedCreationPromise = pending;
			const release = (): void => {
				if (this.ownedCreationPromise === pending) this.ownedCreationPromise = undefined;
			};
			// A terminal creation failure must not be replayed to every later
			// caller. Clear by identity so a walk that replaced the promise, or a
			// cancellation that already cleared it, is left alone.
			pending.then(release, () => {
				release();
				if (this.sessionPromise === pending) this.sessionPromise = undefined;
			});
		}
		return this.sessionPromise;
	}

	async ensureSessionFromFile(
		sessionFile: string,
		consumer: AgentSessionConsumer = "prompt",
	): Promise<StageSessionRuntime> {
		if (!this.sessionPromise && !this.session) this.reattachSessionFile = sessionFile;
		const session = await this.ensureSession(consumer);
		await session.closeWorkflowStageGeneration?.();
		return session;
	}

	async sendUserMessage(
		content: StageUserMessageContent,
		options?: StageSendUserMessageOptions,
		beforeDelivery?: () => void,
		preparation?: StageUserMessagePreparation,
	): Promise<Awaited<ReturnType<typeof sendStageUserMessage>>> {
		return this.messageAdmission.run(async (release) => {
			const pausedDelivery = this.pauseControl.deferRunnerOwnedDelivery(() =>
				this.sendUserMessage(content, options, beforeDelivery, preparation),
			);
			if (pausedDelivery !== undefined) {
				release();
				return pausedDelivery;
			}
			preparation?.beforePreparation?.();
			const sessionFile = preparation?.sessionFile;
			const deliver = async (activity?: StageDeliveryActivity) => {
				const activeSession =
					sessionFile === undefined
						? await this.ensureSession("prompt")
						: await this.ensureSessionFromFile(sessionFile, "prompt");
				const pausedDelivery = this.pauseControl.deferRunnerOwnedDelivery(() =>
					sendStageUserMessage(
						activeSession,
						content,
						options,
						beforeDelivery,
						release,
						this.messageAdmission,
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
					this.messageAdmission,
					activity,
				);
			};
			if (this.session === undefined || sessionFile !== undefined)
				return this.deliveryActivity.runWithLease(() => deliver());
			return deliver(this.deliveryActivity);
		});
	}
	/** Internal pre-stream delivery lifecycle consumed by an attached stage chat. */
	subscribeDeliveryActivity(listener: StageDeliveryActivityListener): () => void {
		return this.deliveryActivity.subscribe(listener);
	}

	sealGeneration(): void {
		this.generationSealed = true;
		this.sharedOrchestrationContext?.messageAdmission?.boundary.seal();
		this.session?.sealWorkflowStageGeneration?.();
	}
	async closeGeneration(): Promise<void> {
		this.sealGeneration();
		const pending = this.activeCreation ?? this.sessionPromise;
		const session = pending ? await pending : this.session;
		await session?.closeWorkflowStageGeneration?.();
	}

	async promptWithFallback(
		text: string,
		sdkOptions: PromptOptions | undefined,
		consumer: AgentSessionConsumer = "prompt",
	): Promise<void> {
		if (!this.hasExplicitModelFallbackConfig) {
			try {
				const activeSession = await this.ensureSession(consumer);
				const resumedText = this.pendingCreationResumeMessage;
				this.pendingCreationResumeMessage = undefined;
				await this.promptWithThrownErrorRetry(activeSession, resumedText ?? text, sdkOptions);
			} catch (error) {
				if (error instanceof StageSessionCreationCancelled) return;
				throw error;
			}
			return;
		}

		const candidates = await this.modelCandidates();
		if (candidates.length === 0) {
			try {
				const activeSession = await this.ensureSession(consumer);
				const resumedText = this.pendingCreationResumeMessage;
				this.pendingCreationResumeMessage = undefined;
				await this.promptWithThrownErrorRetry(activeSession, resumedText ?? text, sdkOptions);
			} catch (error) {
				if (error instanceof StageSessionCreationCancelled) return;
				throw error;
			}
			return;
		}

		// A creation already in flight — an eager walk, or a concurrent caller —
		// owns the candidate chain. Join it rather than starting a second walk that
		// would duplicate provider work and leak whichever session lost the race.
		if (this.session === undefined && this.sessionPromise !== undefined) {
			try {
				await this.sessionPromise;
			} catch (error) {
				if (error instanceof StageSessionCreationCancelled) return;
				// The exhausted walk cleared its own promise by identity; fall through
				// and let the walk below report the failure for this prompt.
			}
		}

		// A paused creation resumed with a replacement objective: that text is
		// authoritative for this prompt and must not be dropped here.
		const resumedText = this.pendingCreationResumeMessage;
		this.pendingCreationResumeMessage = undefined;
		let promptText = resumedText ?? text;
		if (await this.tryResumeCurrentSession(promptText, sdkOptions, candidates)) return;
		let index = this.activeCandidateIndex ?? 0;
		while (index < candidates.length) {
			const candidate = candidates[index]!;
			try {
				const created =
					this.session && this.activeCandidateIndex === index
						? this.session
						: await this.createSessionWithThrownErrorRetry(candidate, consumer);
				if (isSessionCreationPauseResult(created)) {
					if (created.resumeMessage === undefined) return;
					promptText = created.resumeMessage;
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
					sdkOptions,
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
				const failure = await this.handleCandidateFailure(err, candidate, candidates, index);
				if (failure === "handled") return;
				if (failure === "throw") throw err;
				index += 1;
			}
		}
	}

	currentModelFallbackMeta(): StageModelFallbackMeta {
		const attemptedModels = this.modelAttempts.map((attempt) => attempt.model);
		const model = this.selectedModel ?? workflowModelId(this.session?.model);
		const fastMode = this.isWorkflowFastModeEnabled();
		return {
			...(model !== undefined ? { model } : {}),
			...(fastMode !== undefined ? { fastMode } : {}),
			...(attemptedModels.length > 0 ? { attemptedModels } : {}),
			...(this.modelAttempts.length > 0 ? { modelAttempts: [...this.modelAttempts] } : {}),
			...(this.modelWarnings.length > 0 ? { warnings: [...this.modelWarnings] } : {}),
		};
	}

	async disposeAll(): Promise<void> {
		this.disposed = true;
		const reason = new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
		this.markAbort(reason);
		this.pauseControl.reject(reason);
		for (const unsubscribe of this.listenerUnsubscribes.values()) unsubscribe();
		this.listenerUnsubscribes.clear();
		this.pendingListeners.clear();
		this.unsubscribeTerminateWatcher?.();
		this.unsubscribeTerminateWatcher = undefined;
		this.terminatingToolCallIds.clear();
		this.messageAdmission.dispose();
		this.deliveryActivity.dispose();
		await this.replacement.dispose();
		await disposeStageSession(this.session);
	}

	async abort(): Promise<void> {
		const reason = new DOMException("stage aborted", "AbortError");
		this.markAbort(reason);
		this.pauseControl.reject(reason);
		await this.session?.abort();
	}
	requestPause(): Promise<void> {
		const pause = this.pauseControl.requestPause();
		const resume = this.pauseControl.currentResume();
		if (resume !== undefined) {
			this.pauseThrownErrorRetries(resume);
			// A creation in flight cannot see the pause request itself, because
			// completing the resume clears it before creation settles.
			for (const observer of this.creationPauseObservers) {
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
		return this.pauseControl.resume(message, beforeResolve, beforeRelease);
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
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	}

	private markAbort(reason: Error | DOMException | string): void {
		this.abortGeneration += 1;
		this.abortReason = reason;
		this.abortReasonGeneration = this.abortGeneration;
		this.abortThrownErrorRetries(reason);
	}

	private pauseThrownErrorRetries(resume: RetryPauseResume): void {
		for (const state of this.thrownErrorRetryStates) {
			if (state.pauseResume !== undefined) continue;
			state.pauseResume = resume;
			state.controller.abort(new ThrownErrorRetryPaused(resume));
		}
	}

	private abortThrownErrorRetries(reason?: Error | DOMException | string): void {
		for (const state of this.thrownErrorRetryStates) state.controller.abort(reason);
		this.thrownErrorRetryStates.clear();
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
	): StageSessionRuntime["messages"][number] | undefined {
		const snapshotMessages = new Set(snapshot);
		const admitted = session.messages.filter((message) => !snapshotMessages.has(message));
		// Error assistants the filter below removes still carry real provider
		// usage; accrue it before the splice so the retry total keeps it.
		for (const message of admitted) {
			if (message.role !== "assistant" || message.stopReason !== "error") continue;
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
			if (message.role === "assistant") return message.stopReason !== "error";
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
	private async sleepForThrownErrorRetry(delayMs: number, state: ThrownErrorRetryState): Promise<void> {
		this.thrownErrorRetryStates.add(state);
		const currentResume = this.pauseControl.currentResume();
		if (currentResume !== undefined) {
			state.pauseResume = currentResume;
			state.controller.abort(new ThrownErrorRetryPaused(currentResume));
		}
		try {
			await sleepOrAbort(delayMs, state.controller.signal);
		} finally {
			this.thrownErrorRetryStates.delete(state);
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
		this.thrownErrorRetryStates.add(state);
		try {
			await continuationSession._runAgentContinue();
		} catch (error) {
			const resume = state.pauseResume ?? this.pauseControl.currentResume();
			if (resume === undefined) throw error;
			return settlePause(resume);
		} finally {
			this.thrownErrorRetryStates.delete(state);
		}
		const pauseAfterContinue = state.pauseResume ?? this.pauseControl.currentResume();
		if (pauseAfterContinue !== undefined) return settlePause(pauseAfterContinue);
		return { kind: "continued" };
	}

	private async promptWithThrownErrorRetry(
		activeSession: StageSessionRuntime,
		text: string,
		sdkOptions: PromptOptions | undefined,
	): Promise<{ readonly terminalScanStartIndex: number }> {
		let retryAttempt = 0;
		let nextText = text;
		let retryAdmittedPrompt = false;
		let retainedPrompt: StageSessionRuntime["messages"][number] | undefined;
		let terminalScanStartIndex: number | undefined;
		while (true) {
			const messagesBeforeAttempt = [...activeSession.messages];
			try {
				if (retryAdmittedPrompt) {
					const continuationSession = retryableAgentSession(activeSession);
					if (continuationSession !== undefined) {
						const outcome = await this.continueWithPauseResume(continuationSession);
						if (outcome.kind === "continued") {
							return {
								terminalScanStartIndex:
									terminalScanStartIndex ?? this.lastPromptStartIndex ?? messagesBeforeAttempt.length,
							};
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
						continue;
					}
					// No continuation is possible after all, so the retained prompt
					// must not survive into the re-prompt below.
					this.dropRetainedPrompt(activeSession, retainedPrompt);
					retainedPrompt = undefined;
					retryAdmittedPrompt = false;
				}
				const result = await this.promptWithPauseResume(activeSession, nextText, sdkOptions);
				return {
					terminalScanStartIndex: terminalScanStartIndex ?? result.terminalScanStartIndex,
				};
			} catch (error) {
				const errorSettingsManager = retrySettingsManagerFromError(error);
				if (errorSettingsManager !== undefined) this.sessionSettingsManager = errorSettingsManager;
				// An already-unresolved context overflow is terminal for this model:
				// compaction has run and failed, so another identical request cannot
				// help. It stays fallbackable so `handleCandidateFailure()` advances.
				// Same-model retry eligibility is narrower than fallback eligibility:
				// auth, model-unavailable, and request-incompatible failures advance
				// to the next candidate immediately instead of burning the retry
				// budget on a request the same model has already rejected.
				const retryableFailure = isRetryableModelFailure(error);
				const sameCandidateRetryable =
					isRetryableSameModelFailure(error) && !isUnresolvedContextOverflowFailure(error);
				const decision = nextRetryDecision(this.retrySettings(), retryAttempt, sameCandidateRetryable);
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
						if (this.disposed)
							throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
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
					continue;
				}
				if (this.disposed)
					throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
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

	private modelCandidates(): Promise<WorkflowResolvedModelCandidate[]> {
		if (!this.candidatesPromise) {
			this.candidatesPromise = buildModelCandidatesFromCatalog({
				primaryModel: this.effectiveStageOptions?.model,
				fallbackModels: this.effectiveStageOptions?.fallbackModels,
				fallbackThinkingLevels: this.effectiveStageOptions?.fallbackThinkingLevels,
				catalog: this.modelCatalog,
			});
		}
		return this.candidatesPromise;
	}

	private async createInitialSession(consumer: AgentSessionConsumer): Promise<StageSessionRuntime> {
		if (!this.hasExplicitModelFallbackConfig) {
			return this.createSessionObservingPause(undefined, consumer).catch((error) =>
				this.createInitialSessionWithRetry(undefined, consumer, { error }),
			);
		}
		const candidates = await this.modelCandidates();
		const first = candidates[0];
		if (first === undefined) {
			return this.createSessionObservingPause(undefined, consumer).catch((error) =>
				this.createInitialSessionWithRetry(undefined, consumer, { error }),
			);
		}
		if (this.reattachSessionFile !== undefined) {
			const resumed = await this.createSession(undefined, consumer, { restoreSavedModel: true });
			const restoredId = workflowModelId(resumed.model);
			const restoredIndex = restoredId === undefined ? -1 : candidates.findIndex((entry) => entry.id === restoredId);
			this.activeCandidateIndex = restoredIndex >= 0 ? restoredIndex : undefined;
			this.selectedModel = restoredId ?? first.id;
			this.resumeCurrentSession = true;
			return resumed;
		}
		this.activeCandidateIndex = 0;
		this.selectedModel = first.id;
		return this.createSessionObservingPause(first, consumer).catch((error) =>
			this.createInitialSessionCandidateWalk(candidates, consumer, 0, { error }),
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
		while (index < candidates.length) {
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
				if ((await this.handleCandidateFailure(error, candidate, candidates, index)) !== "retry") throw error;
				index += 1;
			}
		}
		throw lastError ?? new Error(`atomic-workflows: stage "${this.opts.stageName}" has no usable model candidate`);
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
		this.creationPauseObservers.add(observer);
		const creation = this.createSession(candidate, consumer);
		const settle = (): void => {
			this.creationPauseObservers.delete(observer);
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
				const errorSettingsManager = retrySettingsManagerFromError(error);
				if (errorSettingsManager !== undefined) this.sessionSettingsManager = errorSettingsManager;
				const decision = nextRetryDecision(this.retrySettings(), retryAttempt, isRetryableSameModelFailure(error));
				if (
					decision === undefined ||
					this.disposed ||
					this.opts.signal?.aborted === true ||
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
					if (this.disposed)
						throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
					throw sleepError;
				}
				if (this.disposed)
					throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
				if (this.opts.signal?.aborted) throw this.workflowAbortReason();
			}
		}
	}

	private createSession(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
		resumeOptions?: { restoreSavedModel?: boolean },
	): Promise<StageSessionRuntime> {
		const creation = this.createSessionAttempt(candidate, consumer, resumeOptions);
		this.activeCreation = creation;
		void creation
			.finally(() => {
				if (this.activeCreation === creation) this.activeCreation = undefined;
			})
			.catch(() => {});
		return creation;
	}

	private async createSessionAttempt(
		candidate: WorkflowResolvedModelCandidate | undefined,
		consumer: AgentSessionConsumer,
		resumeOptions?: { restoreSavedModel?: boolean },
	): Promise<StageSessionRuntime> {
		const startGeneration = this.abortGeneration;
		this.applyCandidateThinking(candidate);
		const stageOptions = buildStageSessionOptions({
			effectiveStageOptions: this.effectiveStageOptions,
			candidate,
			restoreSavedModel: resumeOptions?.restoreSavedModel,
			reattachSessionFile: this.reattachSessionFile,
			sharedModelRuntime: this.sharedModelRuntime,
		});
		let created: StageSessionRuntime | StageSessionCreateResult;
		try {
			created = this.opts.adapters.agentSession
				? await this.opts.adapters.agentSession.create(
						stripWorkflowOnlyOptions(
							stageOptions,
							this.opts.defaultSessionDir,
							this.meta,
						) as StageSessionCreateOptions,
						{
							...this.meta,
							stageOptions,
							...(this.sharedOrchestrationContext !== undefined
								? { orchestrationContext: this.sharedOrchestrationContext }
								: {}),
						},
					)
				: missingAdapter(consumer);
		} catch (error) {
			if (this.disposed || this.opts.signal?.aborted === true || this.abortGeneration !== startGeneration)
				throw this.disposed
					? new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`)
					: this.staleCreationReason(startGeneration);
			throw error;
		}
		if (this.disposed || this.opts.signal?.aborted === true || this.abortGeneration !== startGeneration) {
			await disposeStageSession(normalizeSessionCreateResult(created).session).catch(() => {});
			if (this.disposed)
				throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
			throw this.staleCreationReason(startGeneration);
		}
		const session = attachCreatedStageSession(created, this.disposed, this.opts.stageName, (result) =>
			this.attachSession(result),
		);
		if (session instanceof Promise) return await session;
		await this.opts.onSessionReady?.();
		return session;
	}

	private attachSession(created: StageSessionRuntime | StageSessionCreateResult): StageSessionRuntime {
		const result = normalizeSessionCreateResult(created);
		const orchestrationContext = asAgentSession(result.session)?.orchestrationContext;
		if (this.sharedOrchestrationContext === undefined && orchestrationContext !== undefined) {
			this.sharedOrchestrationContext = orchestrationContext;
		}
		if (this.generationSealed) result.session.sealWorkflowStageGeneration?.();
		this.replacement.adopt(result.session);
		this.session = result.session;
		if (this.sharedModelRuntime === undefined) {
			const withRegistry = result.session as Partial<Pick<AgentSession, "modelRuntime">>;
			if (withRegistry.modelRuntime !== undefined) this.sharedModelRuntime = withRegistry.modelRuntime;
		}
		this.sessionSettingsManager = result.settingsManager ?? result.session.settingsManager;
		if (this.pendingThinkingLevel !== undefined) result.session.setThinkingLevel(this.pendingThinkingLevel);
		for (const listener of this.pendingListeners) {
			this.listenerUnsubscribes.set(listener, result.session.subscribe(listener));
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
		this.unsubscribeTerminateWatcher?.();
		this.unsubscribeTerminateWatcher = result.session.subscribe((event) => {
			const terminatingId = terminatingToolCallId(event);
			if (terminatingId !== undefined) this.terminatingToolCallIds.add(terminatingId);
			this.unresolvedContextOverflowMessage =
				unresolvedContextOverflowMessage(event) ?? this.unresolvedContextOverflowMessage;
			this.latestStructuredOutputToolErrorValue =
				structuredOutputToolErrorFromEvent(event) ?? this.latestStructuredOutputToolErrorValue;
		});
		return result.session;
	}

	private async disposeCurrentSession(): Promise<void> {
		this.abortThrownErrorRetries(new Error(`atomic-workflows: stage "${this.opts.stageName}" session was replaced`));
		const current = this.session;
		this.messageAdmission.reset();
		this.replacement.retire(current);
		this.session = undefined;
		// A candidate walk still advancing owns the shared creation promise: clearing
		// it here would let a concurrent caller start a second walk, duplicating
		// provider work and leaking whichever session lost the race.
		if (this.sessionPromise !== this.ownedCreationPromise) this.sessionPromise = undefined;
		this.sessionSettingsManager = undefined;
		this.resumeCurrentSession = false;
		for (const unsubscribe of this.listenerUnsubscribes.values()) unsubscribe();
		this.listenerUnsubscribes.clear();
		this.unsubscribeTerminateWatcher?.();
		this.unsubscribeTerminateWatcher = undefined;
		this.terminatingToolCallIds.clear();
	}

	private async promptWithPauseResume(
		activeSession: StageSessionRuntime,
		initialText: string,
		sdkOptions: PromptOptions | undefined,
	): Promise<{ readonly terminalScanStartIndex: number }> {
		let nextText: string | undefined = initialText;
		while (nextText !== undefined) {
			const pendingPauseBeforePrompt = this.pauseControl.currentResume();
			if (pendingPauseBeforePrompt) {
				const resumed = await pendingPauseBeforePrompt;
				await resumed.runnerOwnedDeliverySettlement;
				nextText = resumed.message;
				if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
				continue;
			}
			const promptStartIndex = activeSession.messages.length;
			this.lastPromptStartIndex = promptStartIndex;
			this.unresolvedContextOverflowMessage = undefined;
			try {
				await activeSession.prompt(nextText, sdkOptions);
				const pendingPauseAfterPrompt = this.pauseControl.currentResume();
				if (pendingPauseAfterPrompt) {
					const resumed = await pendingPauseAfterPrompt;
					await resumed.runnerOwnedDeliverySettlement;
					this.throwUnresolvedContextOverflowIfPresent();
					nextText = resumed.message;
					if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
					continue;
				}
				this.throwUnresolvedContextOverflowIfPresent();
				return { terminalScanStartIndex: promptStartIndex };
			} catch (err) {
				const pendingPauseAfterThrow = this.pauseControl.currentResume();
				if (pendingPauseAfterThrow) {
					const resumed = await pendingPauseAfterThrow;
					await resumed.runnerOwnedDeliverySettlement;
					this.throwUnresolvedContextOverflowIfPresent();
					nextText = resumed.message;
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
	): Promise<boolean> {
		if (!this.resumeCurrentSession || this.session === undefined) return false;
		this.resumeCurrentSession = false;
		const resumedSession = this.session;
		const resumedLabel = this.selectedModel ?? workflowModelId(resumedSession.model) ?? candidates[0]!.id;
		this.notifyModelFallbackMetaChange();
		this.beginAttemptUsage(resumedSession);
		try {
			const { terminalScanStartIndex } = await this.promptWithThrownErrorRetry(resumedSession, text, sdkOptions);
			const terminalFailure = latestTerminalAssistantFailureSince(resumedSession.messages, terminalScanStartIndex);
			if (terminalFailure === undefined || this.capturedStructuredOutputForAttempt()) {
				const usage = this.takeAttemptUsage(resumedSession);
				this.modelAttempts.push({
					model: resumedLabel,
					success: true,
					...(usage === undefined ? {} : { usage }),
				});
				this.pendingFallbackWarnings.length = 0;
				this.resumeCurrentSession = true;
				return true;
			}
			throw new WorkflowPromptModelFailure(terminalFailure);
		} catch (err) {
			if (this.capturedStructuredOutputForAttempt() && isRetryableModelFailure(err)) {
				const usage = this.takeAttemptUsage(resumedSession);
				this.modelAttempts.push({
					model: resumedLabel,
					success: true,
					...(usage === undefined ? {} : { usage }),
				});
				this.pendingFallbackWarnings.length = 0;
				this.resumeCurrentSession = true;
				return true;
			}
			const message = errorMessage(err);
			const usage = this.takeAttemptUsage(resumedSession);
			this.modelAttempts.push({
				model: resumedLabel,
				success: false,
				...(usage === undefined ? {} : { usage }),
				error: message,
			});
			if (this.opts.signal?.aborted || !isRetryableModelFailure(err)) {
				this.modelWarnings.push(...this.pendingFallbackWarnings);
				this.pendingFallbackWarnings.length = 0;
				this.notifyModelFallbackMetaChange();
				throw err;
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
			this.pendingFallbackWarnings.push(
				resumedOverflowNextIndex === undefined
					? `[fallback] resume on ${resumedLabel} failed: ${message}. Restarting fallback from ${candidateLabel(candidates[0]!)}.`
					: `[fallback] resume on ${resumedLabel} failed: ${message}. Retrying with ${candidateLabel(candidates[resumedOverflowNextIndex]!)}.`,
			);
			await this.disposeCurrentSession();
			this.activeCandidateIndex = resumedOverflowNextIndex;
			return false;
		}
	}

	private async handleCandidateFailure(
		err: unknown,
		candidate: WorkflowResolvedModelCandidate,
		candidates: readonly WorkflowResolvedModelCandidate[],
		index: number,
	): Promise<"handled" | "retry" | "throw"> {
		const message = errorMessage(err);
		if (this.capturedStructuredOutputForAttempt() && isRetryableModelFailure(err)) {
			this.recordSuccessfulAttempt(candidate);
			return "handled";
		}
		const usage = this.takeAttemptUsage(this.session);
		this.modelAttempts.push({
			model: candidate.id,
			success: false,
			...modelAttemptReasoning(candidate, this.effectiveStageOptions?.thinkingLevel),
			...(usage === undefined ? {} : { usage }),
			error: message,
		});
		if (this.opts.signal?.aborted || !isRetryableModelFailure(err) || index === candidates.length - 1) {
			this.modelWarnings.push(...this.pendingFallbackWarnings);
			this.pendingFallbackWarnings.length = 0;
			this.notifyModelFallbackMetaChange();
			return "throw";
		}
		const nextCandidate = candidates[index + 1]!;
		this.pendingFallbackWarnings.push(
			`[fallback] ${candidateLabel(candidate)} failed: ${message}. Retrying with ${candidateLabel(nextCandidate)}.`,
		);
		await this.disposeCurrentSession();
		return "retry";
	}

	private capturedStructuredOutputForAttempt(): boolean {
		return this.structuredOutputCapture?.called === true && this.opts.signal?.aborted !== true;
	}

	private recordSuccessfulAttempt(candidate: WorkflowResolvedModelCandidate): void {
		const usage = this.takeAttemptUsage(this.session);
		this.modelAttempts.push({
			model: candidate.id,
			success: true,
			...modelAttemptReasoning(candidate, this.effectiveStageOptions?.thinkingLevel),
			...(usage === undefined ? {} : { usage }),
		});
		this.pendingFallbackWarnings.length = 0;
		this.resumeCurrentSession = true;
	}

	private notifyModelFallbackMetaChange(): void {
		this.opts.onModelFallbackMetaChange?.(this.currentModelFallbackMeta());
	}

	private applyCandidateThinking(candidate: WorkflowResolvedModelCandidate | undefined): void {
		this.pendingThinkingLevel =
			candidate === undefined
				? this.effectiveStageOptions?.thinkingLevel
				: effectiveCandidateReasoning(candidate, this.effectiveStageOptions?.thinkingLevel);
	}
	private isWorkflowFastModeEnabled(): boolean | undefined {
		const model = this.session?.model;
		const settingsManager = this.sessionSettingsManager ?? this.effectiveStageOptions?.settingsManager;
		return model === undefined || settingsManager === undefined
			? undefined
			: shouldApplyCodexFastModeForScope(model, settingsManager.getCodexFastModeSettings(), "workflow");
	}
	private throwUnresolvedContextOverflowIfPresent(): void {
		const message = this.unresolvedContextOverflowMessage;
		this.unresolvedContextOverflowMessage = undefined;
		if (message !== undefined) throw unresolvedContextOverflowFailure(message);
	}
}
