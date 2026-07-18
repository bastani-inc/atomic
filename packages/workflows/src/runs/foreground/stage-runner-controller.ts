import { shouldApplyCodexFastModeForScope, type AgentSession, type CreateAgentSessionOptions, type PromptOptions, type StructuredOutputCapture } from "@bastani/atomic";
import type { StageContext, StageExecutionMeta, StageOptions, StageSendUserMessageOptions, StageUserMessageContent, WorkflowModelAttempt, WorkflowModelCatalogPort } from "../../shared/types.js";
import { buildModelCandidatesFromCatalog, errorMessage, isRetryableModelFailure, workflowModelId, type WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";
import { candidateLabel, effectiveCandidateReasoning, modelAttemptReasoning } from "./stage-runner-candidate.js";
import { WorkflowPromptModelFailure, lastAssistantTextFromSession, latestTerminalAssistantFailureSince } from "./stage-runner-messages.js";
import { missingAdapter, stripWorkflowOnlyOptions, unavailableSync } from "./stage-runner-options.js";
import { asAgentSession, attachCreatedStageSession, disposeStageSession, normalizeSessionCreateResult } from "./stage-runner-session.js";
import { structuredOutputToolErrorFromEvent } from "./stage-runner-structured-output.js";
import { buildStageSessionOptions } from "./stage-runner-session-options.js";
import { sendStageUserMessage } from "./stage-runner-send-user-message.js";
import { StageMessageAdmission } from "./stage-runner-message-admission.js";
import { nextResumedContextOverflowFallbackIndex, terminatingToolCallId, unresolvedContextOverflowFailure, unresolvedContextOverflowMessage } from "./stage-runner-unresolved-overflow.js";
import type { AgentSessionConsumer, StageModelFallbackMeta, StageRunnerOpts, StageSessionCreateOptions, StageSessionCreateResult, StageSessionEvent, StageSessionRuntime, WorkflowFastModeSettingsManager } from "./stage-runner-types.js";
import { StageSessionReplacement } from "./stage-runner-replacement.js";

type PauseRequest = {
  deferred: PromiseWithResolvers<{ message?: string }>;
};

export class StageSessionController {
  private session: StageSessionRuntime | undefined;
  private activeCreation: Promise<StageSessionRuntime> | undefined;
  private sessionPromise: Promise<StageSessionRuntime> | undefined;
  private reattachSessionFile: string | undefined;
  private readonly terminatingToolCallIds = new Set<string>();
  private latestStructuredOutputToolErrorValue: string | undefined;
  private unsubscribeTerminateWatcher: (() => void) | undefined;
  private unresolvedContextOverflowMessage: string | undefined;
  private generationSealed = false;
  private disposed = false;
  private pendingThinkingLevel: Parameters<StageContext["setThinkingLevel"]>[0] | undefined;
  private readonly pendingListeners = new Set<(event: StageSessionEvent) => void>();
  private readonly listenerUnsubscribes = new Map<(event: StageSessionEvent) => void, () => void>();
  private pauseRequest: PauseRequest | null = null;
  private readonly hasExplicitModelFallbackConfig: boolean;
  private candidatesPromise: Promise<WorkflowResolvedModelCandidate[]> | undefined;
  private activeCandidateIndex: number | undefined;
  private selectedModel: string | undefined;
  private sharedModelRegistry: CreateAgentSessionOptions["modelRegistry"];
  private sharedOrchestrationContext: CreateAgentSessionOptions["orchestrationContext"];
  private resumeCurrentSession = false;
  private readonly modelAttempts: WorkflowModelAttempt[] = [];
  private readonly modelWarnings: string[] = [];
  private readonly pendingFallbackWarnings: string[] = [];
  private readonly modelCatalog: WorkflowModelCatalogPort | undefined;
  private sessionSettingsManager: WorkflowFastModeSettingsManager | undefined;
  private readonly replacement = new StageSessionReplacement();
  private readonly messageAdmission = new StageMessageAdmission();

  constructor(
    private readonly opts: StageRunnerOpts,
    private readonly meta: StageExecutionMeta,
    private readonly effectiveStageOptions: StageOptions | undefined,
    private readonly structuredOutputCapture: StructuredOutputCapture<unknown> | undefined,
  ) {
    this.hasExplicitModelFallbackConfig =
      effectiveStageOptions?.model !== undefined || (effectiveStageOptions?.fallbackModels?.length ?? 0) > 0;
    this.modelCatalog = opts.models === undefined
      ? undefined
      : {
          ...opts.models,
          recordWarning: (warning: string): void => {
            this.modelWarnings.push(warning);
            opts.models?.recordWarning?.(warning);
          },
        } satisfies WorkflowModelCatalogPort;
    this.bindAbortSignal();
  }

  get currentSession(): StageSessionRuntime | undefined { return this.session; }

  get latestStructuredOutputToolError(): string | undefined { return this.latestStructuredOutputToolErrorValue; }

  resetStructuredOutputToolError(): void { this.latestStructuredOutputToolErrorValue = undefined; }
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

  setThinkingLevel(level: Parameters<StageContext["setThinkingLevel"]>[0]): void { this.pendingThinkingLevel = level; this.session?.setThinkingLevel(level); }

  async ensureSession(consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
    if (this.disposed) throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
    if (this.session !== undefined) return this.session;
    if (!this.sessionPromise) this.sessionPromise = this.createInitialSession(consumer);
    return this.sessionPromise;
  }

  async ensureSessionFromFile(sessionFile: string, consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
    if (!this.sessionPromise && !this.session) this.reattachSessionFile = sessionFile;
    const session = await this.ensureSession(consumer);
    await session.closeWorkflowStageGeneration?.();
    return session;
  }

  async sendUserMessage(content: StageUserMessageContent, options?: StageSendUserMessageOptions, beforeDelivery?: () => void):
    Promise<Awaited<ReturnType<typeof sendStageUserMessage>>> {
    return this.messageAdmission.run(async (release) => sendStageUserMessage(
      await this.ensureSession("prompt"), content, options, () => { beforeDelivery?.(); release(); },
    ));
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
      await this.promptWithPauseResume(await this.ensureSession(consumer), text, sdkOptions);
      return;
    }

    const candidates = await this.modelCandidates();
    if (candidates.length === 0) {
      await this.promptWithPauseResume(await this.ensureSession(consumer), text, sdkOptions);
      return;
    }

    if (await this.tryResumeCurrentSession(text, sdkOptions, candidates)) return;
    let index = this.activeCandidateIndex ?? 0;
    while (index < candidates.length) {
      const candidate = candidates[index]!;
      const activeSession = this.session && this.activeCandidateIndex === index
        ? this.session
        : await this.createSession(candidate, consumer);
      this.activeCandidateIndex = index;
      this.selectedModel = candidate.id;
      this.notifyModelFallbackMetaChange();
      try {
        const { terminalScanStartIndex } = await this.promptWithPauseResume(activeSession, text, sdkOptions);
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
    for (const unsubscribe of this.listenerUnsubscribes.values()) unsubscribe();
    this.listenerUnsubscribes.clear();
    this.pendingListeners.clear();
    this.unsubscribeTerminateWatcher?.();
    this.unsubscribeTerminateWatcher = undefined;
    this.terminatingToolCallIds.clear();
    await this.replacement.dispose();
    await disposeStageSession(this.session);
  }

  async requestPause(): Promise<void> {
    if (this.pauseRequest) return;
    const deferred = Promise.withResolvers<{ message?: string }>();
    void deferred.promise.catch(() => {});
    const request = { deferred };
    this.pauseRequest = request;
    try { await this.session?.abort(); } catch (error) {
      if (this.pauseRequest === request) { this.pauseRequest = null; deferred.reject(error); }
      throw error;
    }
  }

  resume(message?: string): void {
    const req = this.pauseRequest;
    if (!req) return;
    this.pauseRequest = null;
    req.deferred.resolve({ message });
  }

  isPaused(): boolean { return this.pauseRequest !== null; }
  sessionMeta(): { sessionId: string | undefined; sessionFile: string | undefined } {
    return { sessionId: this.session?.sessionId, sessionFile: this.session?.sessionFile };
  }

  agentSession(): AgentSession | undefined { return asAgentSession(this.session); }

  pendingMessageCount(): number { return typeof this.session?.pendingMessageCount === "number" ? this.session.pendingMessageCount : 0; }

  private bindAbortSignal(): void {
    const { signal } = this.opts;
    if (!signal) return;
    const abortReason = (): Error | DOMException | string => {
      const reason = signal.reason;
      if (reason instanceof Error || reason instanceof DOMException || typeof reason === "string") return reason;
      return new DOMException("workflow killed", "AbortError");
    };
    const onAbort = (): void => {
      void this.session?.abort().catch(() => {});
      if (!this.pauseRequest) return;
      const req = this.pauseRequest;
      this.pauseRequest = null;
      req.deferred.reject(abortReason());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
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
    if (!this.hasExplicitModelFallbackConfig) return this.createSession(undefined, consumer);
    const candidates = await this.modelCandidates();
    const first = candidates[0];
    if (first === undefined) return this.createSession(undefined, consumer);
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
    return this.createSession(first, consumer);
  }


  private createSession(
    candidate: WorkflowResolvedModelCandidate | undefined,
    consumer: AgentSessionConsumer,
    resumeOptions?: { restoreSavedModel?: boolean },
  ): Promise<StageSessionRuntime> {
    const creation = this.createSessionAttempt(candidate, consumer, resumeOptions);
    this.activeCreation = creation;
    void creation.finally(() => {
      if (this.activeCreation === creation) this.activeCreation = undefined;
    }).catch(() => {});
    return creation;
  }

  private async createSessionAttempt(
    candidate: WorkflowResolvedModelCandidate | undefined,
    consumer: AgentSessionConsumer,
    resumeOptions?: { restoreSavedModel?: boolean },
  ): Promise<StageSessionRuntime> {
    this.applyCandidateThinking(candidate);
    const stageOptions = buildStageSessionOptions({
      effectiveStageOptions: this.effectiveStageOptions,
      candidate,
      restoreSavedModel: resumeOptions?.restoreSavedModel,
      reattachSessionFile: this.reattachSessionFile,
      sharedModelRegistry: this.sharedModelRegistry,
    });
    const created = this.opts.adapters.agentSession
      ? await this.opts.adapters.agentSession.create(
          stripWorkflowOnlyOptions(stageOptions, this.opts.defaultSessionDir, this.meta) as StageSessionCreateOptions,
          {
            ...this.meta,
            stageOptions,
            ...(this.sharedOrchestrationContext !== undefined
              ? { orchestrationContext: this.sharedOrchestrationContext }
              : {}),
          },
        )
      : missingAdapter(consumer);
    return attachCreatedStageSession(created, this.disposed, this.opts.stageName, (result) => this.attachSession(result));
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
    if (this.sharedModelRegistry === undefined) {
      const withRegistry = result.session as Partial<Pick<AgentSession, "modelRegistry">>;
      if (withRegistry.modelRegistry !== undefined) this.sharedModelRegistry = withRegistry.modelRegistry;
    }
    this.sessionSettingsManager = result.settingsManager ?? result.session.settingsManager;
    if (this.pendingThinkingLevel !== undefined) result.session.setThinkingLevel(this.pendingThinkingLevel);
    for (const listener of this.pendingListeners) {
      this.listenerUnsubscribes.set(listener, result.session.subscribe(listener));
    }
    this.unsubscribeTerminateWatcher?.();
    this.unsubscribeTerminateWatcher = result.session.subscribe((event) => {
      const terminatingId = terminatingToolCallId(event);
      if (terminatingId !== undefined) this.terminatingToolCallIds.add(terminatingId);
      this.unresolvedContextOverflowMessage = unresolvedContextOverflowMessage(event) ?? this.unresolvedContextOverflowMessage;
      this.latestStructuredOutputToolErrorValue =
        structuredOutputToolErrorFromEvent(event) ?? this.latestStructuredOutputToolErrorValue;
    });
    return result.session;
  }

  private async disposeCurrentSession(): Promise<void> {
    const current = this.session;
    this.replacement.retire(current);
    this.session = undefined;
    this.sessionPromise = undefined;
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
      const pendingPauseBeforePrompt = this.pauseRequest;
      if (pendingPauseBeforePrompt) {
        const { message } = await pendingPauseBeforePrompt.deferred.promise;
        nextText = message;
        if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
        continue;
      }
      const promptStartIndex = activeSession.messages.length;
      this.unresolvedContextOverflowMessage = undefined;
      try {
        await activeSession.prompt(nextText, sdkOptions);
        const pendingPauseAfterPrompt = this.pauseRequest;
        if (pendingPauseAfterPrompt) {
          const { message } = await pendingPauseAfterPrompt.deferred.promise;
          this.throwUnresolvedContextOverflowIfPresent();
          nextText = message;
          if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
          continue;
        }
        this.throwUnresolvedContextOverflowIfPresent();
        return { terminalScanStartIndex: promptStartIndex };
      } catch (err) {
        const pendingPauseAfterThrow = this.pauseRequest;
        if (pendingPauseAfterThrow) {
          const { message } = await pendingPauseAfterThrow.deferred.promise;
          this.throwUnresolvedContextOverflowIfPresent();
          nextText = message;
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
    try {
      const { terminalScanStartIndex } = await this.promptWithPauseResume(resumedSession, text, sdkOptions);
      const terminalFailure = latestTerminalAssistantFailureSince(resumedSession.messages, terminalScanStartIndex);
      if (terminalFailure === undefined || this.capturedStructuredOutputForAttempt()) {
        this.modelAttempts.push({ model: resumedLabel, success: true });
        this.pendingFallbackWarnings.length = 0;
        this.resumeCurrentSession = true;
        return true;
      }
      throw new WorkflowPromptModelFailure(terminalFailure);
    } catch (err) {
      if (this.capturedStructuredOutputForAttempt() && isRetryableModelFailure(err)) {
        this.modelAttempts.push({ model: resumedLabel, success: true });
        this.pendingFallbackWarnings.length = 0;
        this.resumeCurrentSession = true;
        return true;
      }
      const message = errorMessage(err);
      this.modelAttempts.push({ model: resumedLabel, success: false, error: message });
      if (this.opts.signal?.aborted || !isRetryableModelFailure(err)) {
        this.modelWarnings.push(...this.pendingFallbackWarnings);
        this.pendingFallbackWarnings.length = 0;
        this.notifyModelFallbackMetaChange();
        throw err;
      }
      const resumedOverflowNextIndex = nextResumedContextOverflowFallbackIndex(err, this.activeCandidateIndex, candidates.length);
      if (resumedOverflowNextIndex === "terminal") { this.modelWarnings.push(...this.pendingFallbackWarnings); this.pendingFallbackWarnings.length = 0; this.notifyModelFallbackMetaChange(); throw err; }
      this.pendingFallbackWarnings.push(resumedOverflowNextIndex === undefined ? `[fallback] resume on ${resumedLabel} failed: ${message}. Restarting fallback from ${candidateLabel(candidates[0]!)}.` : `[fallback] resume on ${resumedLabel} failed: ${message}. Retrying with ${candidateLabel(candidates[resumedOverflowNextIndex]!)}.`);
      await this.disposeCurrentSession(); this.activeCandidateIndex = resumedOverflowNextIndex; return false;
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
    this.modelAttempts.push({ model: candidate.id, success: false, ...modelAttemptReasoning(candidate, this.effectiveStageOptions?.thinkingLevel), error: message });
    if (this.opts.signal?.aborted || !isRetryableModelFailure(err) || index === candidates.length - 1) {
      this.modelWarnings.push(...this.pendingFallbackWarnings);
      this.pendingFallbackWarnings.length = 0;
      this.notifyModelFallbackMetaChange();
      return "throw";
    }
    const nextCandidate = candidates[index + 1]!;
    this.pendingFallbackWarnings.push(`[fallback] ${candidateLabel(candidate)} failed: ${message}. Retrying with ${candidateLabel(nextCandidate)}.`);
    await this.disposeCurrentSession();
    return "retry";
  }

  private capturedStructuredOutputForAttempt(): boolean {
    return this.structuredOutputCapture?.called === true && this.opts.signal?.aborted !== true;
  }

  private recordSuccessfulAttempt(candidate: WorkflowResolvedModelCandidate): void {
    this.modelAttempts.push({ model: candidate.id, success: true, ...modelAttemptReasoning(candidate, this.effectiveStageOptions?.thinkingLevel) });
    this.pendingFallbackWarnings.length = 0; this.resumeCurrentSession = true;
  }

  private notifyModelFallbackMetaChange(): void { this.opts.onModelFallbackMetaChange?.(this.currentModelFallbackMeta()); }

  private applyCandidateThinking(candidate: WorkflowResolvedModelCandidate | undefined): void {
    this.pendingThinkingLevel = candidate === undefined
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
  private throwUnresolvedContextOverflowIfPresent(): void { const message = this.unresolvedContextOverflowMessage; this.unresolvedContextOverflowMessage = undefined; if (message !== undefined) throw unresolvedContextOverflowFailure(message); }
}
