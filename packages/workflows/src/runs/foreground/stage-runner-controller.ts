import { getModelDefaultContextWindow, getSupportedContextWindows, SessionManager, shouldApplyCodexFastModeForScope, type AgentSession, type CreateAgentSessionOptions, type PromptOptions, type StructuredOutputCapture } from "@bastani/atomic";
import type { StageContext, StageExecutionMeta, StageOptions, WorkflowModelAttempt, WorkflowModelCatalogPort } from "../../shared/types.js";
import { buildModelCandidatesFromCatalog, errorMessage, isRetryableModelFailure, workflowModelId, type WorkflowResolvedModelCandidate } from "../shared/model-fallback.js";
import { WorkflowPromptModelFailure, lastAssistantTextFromSession, latestTerminalAssistantFailureSince } from "./stage-runner-messages.js";
import { missingAdapter, stripWorkflowOnlyOptions, unavailableSync } from "./stage-runner-options.js";
import { asAgentSession, disposeStageSession, normalizeSessionCreateResult } from "./stage-runner-session.js";
import { structuredOutputToolErrorFromEvent } from "./stage-runner-structured-output.js";
import type { AgentSessionConsumer, StageModelFallbackMeta, StageRunnerOpts, StageSessionCreateOptions, StageSessionCreateResult, StageSessionEvent, StageSessionRuntime, WorkflowFastModeSettingsManager } from "./stage-runner-types.js";

type PauseRequest = {
  deferred: PromiseWithResolvers<{ message?: string }>;
};

export class StageSessionController {
  private session: StageSessionRuntime | undefined;
  private sessionPromise: Promise<StageSessionRuntime> | undefined;
  private reattachSessionFile: string | undefined;
  private readonly terminatingToolCallIds = new Set<string>();
  private latestStructuredOutputToolErrorValue: string | undefined;
  private unsubscribeTerminateWatcher: (() => void) | undefined;
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
  private resumeCurrentSession = false;
  private readonly modelAttempts: WorkflowModelAttempt[] = [];
  private readonly modelWarnings: string[] = [];
  private readonly pendingFallbackWarnings: string[] = [];
  private readonly modelCatalog: WorkflowModelCatalogPort | undefined;
  private sessionSettingsManager: WorkflowFastModeSettingsManager | undefined;

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

  setThinkingLevel(level: Parameters<StageContext["setThinkingLevel"]>[0]): void {
    this.pendingThinkingLevel = level; this.session?.setThinkingLevel(level);
  }

  async ensureSession(consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
    if (this.disposed) throw new Error(`atomic-workflows: stage "${this.opts.stageName}" session has been disposed`);
    if (this.session !== undefined) return this.session;
    if (!this.sessionPromise) this.sessionPromise = this.createInitialSession(consumer);
    return this.sessionPromise;
  }

  async ensureSessionFromFile(sessionFile: string, consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
    if (this.sessionPromise || this.session) return this.ensureSession(consumer);
    this.reattachSessionFile = sessionFile;
    return this.ensureSession(consumer);
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
    await disposeStageSession(this.session);
  }

  async requestPause(): Promise<void> {
    if (this.pauseRequest) return;
    const deferred = Promise.withResolvers<{ message?: string }>();
    void deferred.promise.catch(() => {});
    this.pauseRequest = { deferred };
    await this.session?.abort();
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

  private stageOptionsForCandidate(
    candidate: WorkflowResolvedModelCandidate | undefined,
    resumeOptions?: { restoreSavedModel?: boolean },
  ): StageOptions | undefined {
    const optionsForCandidate: StageOptions = candidate === undefined
      ? { ...(this.effectiveStageOptions ?? {}) }
      : {
          ...(this.effectiveStageOptions ?? {}),
          model: candidate.value,
          ...(candidate.reasoningLevel !== undefined ? { thinkingLevel: candidate.reasoningLevel } : {}),
          ...(candidate.contextWindow !== undefined ? { contextWindow: candidate.contextWindow } : {}),
          fallbackModels: undefined,
          fallbackThinkingLevels: undefined,
        };
    if (resumeOptions?.restoreSavedModel) delete optionsForCandidate.model;
    // Pin a tiered model's natural default (short) context window when neither
    // the `(1m)` model-string token nor an explicit stage-level contextWindow
    // selects one for a fresh (non-resumed) stage session. This prevents a
    // persisted interactive context-window preference (e.g. a previously
    // selected long tier) from leaking into workflow stages, so a tiered model
    // uses its short tier unless the author explicitly opts into the long tier
    // via the `(1m)` token or the numeric contextWindow option. Single-window
    // models carry no selectable long tier, so they are left untouched.
    if (
      resumeOptions?.restoreSavedModel !== true &&
      this.reattachSessionFile === undefined &&
      optionsForCandidate.contextWindow === undefined &&
      candidate !== undefined &&
      typeof candidate.value !== "string" &&
      getSupportedContextWindows(candidate.value).length > 1
    ) {
      optionsForCandidate.contextWindow = getModelDefaultContextWindow(candidate.value);
    }
    if (this.reattachSessionFile !== undefined && optionsForCandidate.sessionManager === undefined) {
      const cwd = optionsForCandidate.cwd ?? process.cwd();
      optionsForCandidate.sessionManager = SessionManager.open(
        this.reattachSessionFile,
        optionsForCandidate.sessionDir,
        cwd,
      );
      optionsForCandidate.context = undefined;
      optionsForCandidate.forkFromSessionFile = undefined;
    }
    if (this.sharedModelRegistry !== undefined && optionsForCandidate.modelRegistry === undefined) {
      optionsForCandidate.modelRegistry = this.sharedModelRegistry;
    }
    return Object.keys(optionsForCandidate).length === 0 ? undefined : optionsForCandidate;
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

  private async createSession(
    candidate: WorkflowResolvedModelCandidate | undefined,
    consumer: AgentSessionConsumer,
    resumeOptions?: { restoreSavedModel?: boolean },
  ): Promise<StageSessionRuntime> {
    this.applyCandidateThinking(candidate);
    const stageOptions = this.stageOptionsForCandidate(candidate, resumeOptions);
    const created = this.opts.adapters.agentSession
      ? await this.opts.adapters.agentSession.create(
          stripWorkflowOnlyOptions(stageOptions, this.opts.defaultSessionDir) as StageSessionCreateOptions,
          { ...this.meta, stageOptions },
        )
      : missingAdapter(consumer);
    return this.attachSession(created);
  }

  private attachSession(created: StageSessionRuntime | StageSessionCreateResult): StageSessionRuntime {
    const result = normalizeSessionCreateResult(created);
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
      this.recordTerminatingToolCall(event);
      this.latestStructuredOutputToolErrorValue =
        structuredOutputToolErrorFromEvent(event) ?? this.latestStructuredOutputToolErrorValue;
    });
    return result.session;
  }

  private async disposeCurrentSession(): Promise<void> {
    const current = this.session;
    this.session = undefined;
    this.sessionPromise = undefined;
    this.sessionSettingsManager = undefined;
    this.resumeCurrentSession = false;
    for (const unsubscribe of this.listenerUnsubscribes.values()) unsubscribe();
    this.listenerUnsubscribes.clear();
    this.unsubscribeTerminateWatcher?.();
    this.unsubscribeTerminateWatcher = undefined;
    this.terminatingToolCallIds.clear();
    await disposeStageSession(current);
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
      try {
        await activeSession.prompt(nextText, sdkOptions);
        const pendingPauseAfterPrompt = this.pauseRequest;
        if (pendingPauseAfterPrompt) {
          const { message } = await pendingPauseAfterPrompt.deferred.promise;
          nextText = message;
          if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
          continue;
        }
        return { terminalScanStartIndex: promptStartIndex };
      } catch (err) {
        const pendingPauseAfterThrow = this.pauseRequest;
        if (pendingPauseAfterThrow) {
          const { message } = await pendingPauseAfterThrow.deferred.promise;
          nextText = message;
          if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
          continue;
        }
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
      this.pendingFallbackWarnings.push(`[fallback] resume on ${resumedLabel} failed: ${message}. Restarting fallback from ${this.candidateLabel(candidates[0]!)}.`);
      await this.disposeCurrentSession();
      this.activeCandidateIndex = undefined;
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
    this.modelAttempts.push({ model: candidate.id, success: false, ...this.modelAttemptReasoning(candidate), error: message });
    if (this.opts.signal?.aborted || !isRetryableModelFailure(err) || index === candidates.length - 1) {
      this.modelWarnings.push(...this.pendingFallbackWarnings);
      this.pendingFallbackWarnings.length = 0;
      this.notifyModelFallbackMetaChange();
      return "throw";
    }
    const nextCandidate = candidates[index + 1]!;
    this.pendingFallbackWarnings.push(`[fallback] ${this.candidateLabel(candidate)} failed: ${message}. Retrying with ${this.candidateLabel(nextCandidate)}.`);
    await this.disposeCurrentSession();
    return "retry";
  }

  private capturedStructuredOutputForAttempt(): boolean {
    return this.structuredOutputCapture?.called === true && this.opts.signal?.aborted !== true;
  }

  private recordSuccessfulAttempt(candidate: WorkflowResolvedModelCandidate): void {
    this.modelAttempts.push({ model: candidate.id, success: true, ...this.modelAttemptReasoning(candidate) });
    this.pendingFallbackWarnings.length = 0; this.resumeCurrentSession = true;
  }

  private notifyModelFallbackMetaChange(): void { this.opts.onModelFallbackMetaChange?.(this.currentModelFallbackMeta()); }

  private effectiveCandidateReasoning(candidate: WorkflowResolvedModelCandidate): StageOptions["thinkingLevel"] | undefined {
    return candidate.reasoningLevel ?? this.effectiveStageOptions?.thinkingLevel;
  }

  private modelAttemptReasoning(candidate: WorkflowResolvedModelCandidate): Pick<WorkflowModelAttempt, "reasoningLevel"> {
    const reasoningLevel = this.effectiveCandidateReasoning(candidate); return reasoningLevel !== undefined ? { reasoningLevel } : {};
  }

  private applyCandidateThinking(candidate: WorkflowResolvedModelCandidate | undefined): void {
    this.pendingThinkingLevel = candidate === undefined
      ? this.effectiveStageOptions?.thinkingLevel
      : this.effectiveCandidateReasoning(candidate);
  }

  private candidateLabel(candidate: WorkflowResolvedModelCandidate): string {
    return candidate.reasoningLevel !== undefined ? `${candidate.id}:${candidate.reasoningLevel}` : candidate.id;
  }

  private isWorkflowFastModeEnabled(): boolean | undefined {
    const model = this.session?.model;
    const settingsManager = this.sessionSettingsManager ?? this.effectiveStageOptions?.settingsManager;
    if (model === undefined || settingsManager === undefined) return undefined;
    return shouldApplyCodexFastModeForScope(model, settingsManager.getCodexFastModeSettings(), "workflow");
  }

  private recordTerminatingToolCall(event: unknown): void {
    if (event === null || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    if (record["type"] !== "tool_execution_end") return;
    const result = record["result"];
    if (result === null || typeof result !== "object") return;
    if ((result as Record<string, unknown>)["terminate"] !== true) return;
    const callId = record["toolCallId"];
    if (typeof callId === "string" && callId.length > 0) this.terminatingToolCallIds.add(callId);
  }
}
