/**
 * Stage runner — creates an AgentSession-like StageContext for a workflow stage.
 *
 * The public stage surface mirrors the supported subset of pi's SDK
 * AgentSession. The executor wraps prompt() for lifecycle tracking and owns
 * disposal; workflow authors get direct SDK session methods without a custom
 * prompt abstraction.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { SessionManager, type AgentSession, type CreateAgentSessionOptions, type PromptOptions } from "@bastani/atomic";
import type {
  CompleteStageOpts,
  StageContext,
  StageExecutionMeta,
  StageOptions,
  StageOutputOptions,
  StagePromptOptions,
  WorkflowMaxOutput,
  WorkflowModelAttempt,
  WorkflowModelCatalogPort,
} from "../../shared/types.js";
import {
  buildModelCandidatesFromCatalog,
  errorMessage,
  isRetryableModelFailure,
  workflowModelId,
  type WorkflowResolvedModelCandidate,
} from "../shared/model-fallback.js";

export interface StageSessionRuntime {
  prompt(text: string, options?: PromptOptions): Promise<string | void>;
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  subscribe(listener: (event: Parameters<AgentSession["subscribe"]>[0] extends (event: infer T) => void ? T : never) => void): () => void;
  readonly sessionFile: string | undefined;
  readonly sessionId: string;
  setModel(model: Parameters<AgentSession["setModel"]>[0]): Promise<void>;
  setThinkingLevel(level: Parameters<AgentSession["setThinkingLevel"]>[0]): void;
  cycleModel(): ReturnType<AgentSession["cycleModel"]>;
  cycleThinkingLevel(): ReturnType<AgentSession["cycleThinkingLevel"]>;
  readonly agent: AgentSession["agent"];
  readonly model: AgentSession["model"];
  readonly thinkingLevel: AgentSession["thinkingLevel"];
  readonly messages: AgentSession["messages"];
  readonly isStreaming: AgentSession["isStreaming"];
  /** Number of SDK-level queued steering/follow-up messages, when supported. */
  readonly pendingMessageCount?: number;
  navigateTree: AgentSession["navigateTree"];
  compact: AgentSession["compact"];
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText?: () => string | undefined;
}

export type StageSessionCreateOptions = CreateAgentSessionOptions & Pick<StageOptions, "mcp" | "fallbackModels">;

export interface AgentSessionAdapter {
  create(options: StageSessionCreateOptions, meta?: StageExecutionMeta): Promise<StageSessionRuntime>;
}

export interface StageModelFallbackMeta {
  readonly model?: string;
  readonly attemptedModels?: readonly string[];
  readonly modelAttempts?: readonly WorkflowModelAttempt[];
  readonly warnings?: readonly string[];
}

export interface PromptAdapter {
  prompt(text: string, meta?: StageExecutionMeta): Promise<string>;
}

export interface CompleteAdapter {
  complete(text: string, opts?: CompleteStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface StageAdapters {
  agentSession?: AgentSessionAdapter;
  prompt?: PromptAdapter;
  complete?: CompleteAdapter;
}

export interface StageRunnerOpts {
  stageId: string;
  stageName: string;
  adapters: StageAdapters;
  /** Options passed to ctx.stage(name, options?). Forwarded to createAgentSession except mcp. */
  stageOptions?: StageOptions;
  /** Run ID of the containing workflow execution — forwarded to session adapter metadata. */
  runId: string;
  /** AbortSignal from the executor's own AbortController — forwarded to session adapter metadata. */
  signal?: AbortSignal;
  /** Optional model catalog used for fallback validation/resolution. */
  models?: WorkflowModelCatalogPort;
}

export interface InternalStageContext extends StageContext {
  /** Internal cleanup hook; intentionally omitted from the public StageContext type. */
  __dispose(): Promise<void>;
  /** Internal result snapshot hook for the workflow store/TUI. */
  __getLastAssistantText(): string | undefined;
  getLastAssistantText(): string | undefined;
  /**
   * Internal: eagerly create the underlying SDK AgentSession without
   * sending a prompt. Used by the live stage-control registry when a
   * user attaches to a stage and types their first message before the
   * workflow body's natural first `prompt()` lands.
   */
  __ensureSession(): Promise<void>;
  /**
   * Internal: snapshot of currently-known SDK session metadata. Returns
   * `undefined` keys when the session has not yet been created.
   */
  __sessionMeta(): { sessionId: string | undefined; sessionFile: string | undefined };
  /** Internal: live coding-agent session when the adapter returned one. */
  __agentSession(): AgentSession | undefined;
  /** Internal: SDK queued steering/follow-up message count, when available. */
  __pendingMessageCount(): number;
  /** Internal: selected/effective model and fallback attempt metadata. */
  __modelFallbackMeta(): StageModelFallbackMeta;
  /**
   * Internal: register a controlled-pause request. The executor's
   * tracked stage call uses this to distinguish a user-initiated pause
   * from an unrelated abort and to wait for `__resume()` before
   * resolving the awaiter.
   */
  __requestPause(): Promise<void>;
  /**
   * Internal: complete a pending controlled pause. If `message` is
   * provided it is sent to the SDK session before the awaiter resolves.
   */
  __resume(message?: string): Promise<void>;
  /** Internal: true while a controlled pause is in flight. */
  __isPaused(): boolean;
}

function stripWorkflowOnlyOptions(options: StageOptions | undefined): CreateAgentSessionOptions {
  if (!options) return {};
  const {
    mcp: _mcp,
    fallbackModels: _fallbackModels,
    context,
    forkFromSessionFile,
    sessionDir,
    gitWorktreeDir: _gitWorktreeDir,
    baseBranch: _baseBranch,
    ...sessionOptions
  } = options;
  if (sessionOptions.sessionManager === undefined) {
    const cwd = sessionOptions.cwd ?? process.cwd();
    if (context === "fork" && forkFromSessionFile !== undefined) {
      sessionOptions.sessionManager = SessionManager.forkFrom(forkFromSessionFile, cwd, sessionDir);
    } else if (sessionDir !== undefined) {
      sessionOptions.sessionManager = SessionManager.create(cwd, sessionDir);
    }
  }
  return sessionOptions as CreateAgentSessionOptions;
}

type AgentSessionConsumer = "prompt" | "complete";

function missingAdapter(consumer: AgentSessionConsumer): never {
  if (consumer === "complete") {
    throw new Error(
      "pi-workflows: ctx.complete requires either RunOpts.adapters.complete or RunOpts.adapters.agentSession",
    );
  }
  throw new Error(
    "pi-workflows: prompt adapter not configured — provide an AgentSessionAdapter via RunOpts.adapters.agentSession",
  );
}

function unavailableSync(property: string): never {
  throw new Error(
    `pi-workflows: stage AgentSession property "${property}" is unavailable until the SDK session has been created`,
  );
}

type TextLikeContent = {
  readonly type?: string;
  readonly text?: string;
};

type MessageWithTextContent = {
  readonly content?: string | readonly TextLikeContent[];
};

function extractMessageText(message: AgentSession["messages"][number]): string {
  const { content } = message as MessageWithTextContent;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

function lastOutputTextFromMessages(messages: AgentSession["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.role !== "assistant" && message.role !== "toolResult")) continue;
    const text = extractMessageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

/**
 * When an agent turn ends on a tool that returned `terminate: true`, control
 * returns with the tool result as the final conversational message and no
 * trailing assistant response (see the structured-output contract in the
 * Atomic extension docs). That tool result is the deterministic output of the
 * turn, so it must win over any prose the model emitted *before* the tool call
 * in the same assistant message (which `getLastAssistantText()` would otherwise
 * surface). This keeps terminating structured-output tools such as the `goal`
 * and `ralph` review gates' `review_decision` tool deterministic regardless of
 * surrounding narration.
 *
 * Returns the trailing tool-result text when the most recent conversational
 * message is a tool result, or `undefined` when the turn ended on an assistant
 * response (the normal, non-terminating case).
 */
function terminatingToolResultText(messages: AgentSession["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "toolResult") {
      const text = extractMessageText(message).trim();
      return text.length > 0 ? text : undefined;
    }
    if (message.role === "assistant") return undefined;
    // Skip non-conversational roles (system/user) while locating the tail.
  }
  return undefined;
}

function asAgentSession(activeSession: StageSessionRuntime | undefined): AgentSession | undefined {
  if (!activeSession) return undefined;
  const candidate = activeSession as StageSessionRuntime & Partial<Pick<AgentSession, "state" | "sessionManager" | "modelRegistry" | "getContextUsage">>;
  if (
    candidate.state !== undefined &&
    candidate.sessionManager !== undefined &&
    candidate.modelRegistry !== undefined &&
    typeof candidate.getContextUsage === "function"
  ) {
    return candidate as AgentSession;
  }
  return undefined;
}

function lastAssistantTextFromSession(
  activeSession: StageSessionRuntime | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!activeSession) return fallback;
  // A `terminate: true` tool result is the deterministic turn output and must
  // take precedence over prose the model emitted before the terminating tool
  // call (which getLastAssistantText() would surface).
  const terminatingText = terminatingToolResultText(activeSession.messages);
  if (terminatingText !== undefined) return terminatingText;
  const direct = activeSession.getLastAssistantText?.();
  if (direct !== undefined && direct.trim()) return direct;
  return lastOutputTextFromMessages(activeSession.messages) ?? direct ?? fallback;
}

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 5000;

function normalizeMaxOutput(maxOutput: WorkflowMaxOutput | undefined): Required<WorkflowMaxOutput> {
  return {
    bytes: maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    lines: maxOutput?.lines ?? DEFAULT_MAX_OUTPUT_LINES,
  };
}

function truncateByLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return { text: "", truncated: text.length > 0 };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return { text: lines.slice(0, maxLines).join("\n"), truncated: true };
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) low = mid;
    else high = mid - 1;
  }
  return { text: text.slice(0, low), truncated: true };
}

function truncateOutput(text: string, maxOutput: WorkflowMaxOutput | undefined): string {
  const limits = normalizeMaxOutput(maxOutput);
  const byLines = truncateByLines(text, limits.lines);
  const byBytes = truncateByBytes(byLines.text, limits.bytes);
  if (!byLines.truncated && !byBytes.truncated) return text;
  return `${byBytes.text}\n\n[workflow output truncated; limits: ${limits.bytes} bytes, ${limits.lines} lines]`;
}

function countLines(text: string): number {
  if (!text) return 0;
  const newlineMatches = text.match(/\r\n|\r|\n/g);
  return (newlineMatches?.length ?? 0) + (/[\r\n]$/.test(text) ? 0 : 1);
}

function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function savedOutputReference(outputPath: string, fullOutput: string): string {
  const absolutePath = resolve(outputPath);
  const bytes = Buffer.byteLength(fullOutput, "utf8");
  const lines = countLines(fullOutput);
  return `Output saved to: ${absolutePath} (${formatByteSize(bytes)}, ${lines} ${lines === 1 ? "line" : "lines"}). Read this file if needed.`;
}

function resolveOutputPath(
  output: string | false | undefined,
  runtimeCwd: string,
  requestedCwd: string | undefined,
): string | undefined {
  if (typeof output !== "string" || output.length === 0) return undefined;
  if (isAbsolute(output)) return output;
  const baseCwd = requestedCwd === undefined
    ? runtimeCwd
    : isAbsolute(requestedCwd)
      ? requestedCwd
      : resolve(runtimeCwd, requestedCwd);
  return resolve(baseCwd, output);
}

function splitPromptOptions(options: StagePromptOptions | undefined): {
  sdkOptions: PromptOptions | undefined;
  outputOptions: StageOutputOptions;
} {
  if (!options) return { sdkOptions: undefined, outputOptions: {} };
  const sdkOptions: PromptOptions = {};
  if (options.expandPromptTemplates !== undefined) sdkOptions.expandPromptTemplates = options.expandPromptTemplates;
  if (options.images !== undefined) sdkOptions.images = options.images;
  if (options.streamingBehavior !== undefined) sdkOptions.streamingBehavior = options.streamingBehavior;
  if (options.source !== undefined) sdkOptions.source = options.source;
  if (options.preflightResult !== undefined) sdkOptions.preflightResult = options.preflightResult;

  const outputOptions: StageOutputOptions = {
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(options.context !== undefined ? { context: options.context } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxOutput !== undefined ? { maxOutput: options.maxOutput } : {}),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
  };

  return {
    sdkOptions: Object.keys(sdkOptions).length === 0 ? undefined : sdkOptions,
    outputOptions,
  };
}

function validatePromptOutputOptions(outputOptions: StageOutputOptions): void {
  if (outputOptions.outputMode === "file-only" && (typeof outputOptions.output !== "string" || outputOptions.output.length === 0)) {
    throw new Error(
      "pi-workflows: prompt sets outputMode: \"file-only\" but does not configure an output file. Set output to a path or use outputMode: \"inline\".",
    );
  }
}

async function finalizePromptOutput(
  fullOutput: string,
  outputOptions: StageOutputOptions,
  runtimeCwd: string,
): Promise<string> {
  const outputPath = resolveOutputPath(outputOptions.output, runtimeCwd, outputOptions.cwd);
  validatePromptOutputOptions(outputOptions);

  const displayOutput = truncateOutput(fullOutput, outputOptions.maxOutput);
  if (outputPath === undefined) return displayOutput;

  try {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, fullOutput, "utf8");
  } catch (err) {
    return `${displayOutput}\n\nOutput file error: ${outputPath}\n${err instanceof Error ? err.message : String(err)}`;
  }

  const reference = savedOutputReference(outputPath, fullOutput);
  return outputOptions.outputMode === "file-only"
    ? reference
    : `${displayOutput}\n\n${reference}`;
}

export function createStageContext(opts: StageRunnerOpts): InternalStageContext {
  const { stageId, stageName, adapters, runId, signal, stageOptions } = opts;
  const meta: StageExecutionMeta = { runId, stageId, stageName, signal, stageOptions };
  let session: StageSessionRuntime | undefined;
  let sessionPromise: Promise<StageSessionRuntime> | undefined;
  let lastAssistantText: string | undefined;
  let adapterMessages: AgentSession["messages"] = [];
  let disposed = false;
  let pendingThinkingLevel: Parameters<StageContext["setThinkingLevel"]>[0] | undefined;
  const pendingListeners = new Set<(event: Parameters<StageContext["subscribe"]>[0] extends (event: infer T) => void ? T : never) => void>();
  const listenerUnsubscribes = new Map<(event: Parameters<StageContext["subscribe"]>[0] extends (event: infer T) => void ? T : never) => void, () => void>();

  /**
   * Pause/resume coordination. `pauseRequest` is non-null while a
   * controlled pause is pending. The executor's `runTrackedStageCall`
   * inspects this in its catch handler to distinguish a user pause
   * (await `pauseDeferred.promise`, then re-issue the call) from a
   * genuine SDK abort that should fail the stage.
   *
   * `pendingResumeMessage` is the next user message to feed back into
   * the SDK session when `__resume(message)` is called.
   */
  let pauseRequest: {
    deferred: PromiseWithResolvers<{ message?: string }>;
  } | null = null;

  // Wire the executor's abort signal to the live SDK session and pause
  // deferred so a kill (or other forced abort) doesn't leave a paused stage
  // hanging on a resume signal that will never arrive. Re-use the abort
  // reason instead of manufacturing a stage-specific error; shutdown/kill is
  // expected cancellation and should not surface as a noisy per-stage failure.
  if (signal) {
    const abortReason = (): Error | DOMException | string => {
      const reason = signal.reason;
      if (reason instanceof Error || reason instanceof DOMException || typeof reason === "string") {
        return reason;
      }
      return new DOMException("workflow killed", "AbortError");
    };
    const onAbort = (): void => {
      void session?.abort().catch(() => {});
      if (!pauseRequest) return;
      const req = pauseRequest;
      pauseRequest = null;
      req.deferred.reject(abortReason());
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  const hasExplicitModelFallbackConfig =
    stageOptions?.model !== undefined || (stageOptions?.fallbackModels?.length ?? 0) > 0;
  let candidatesPromise: Promise<WorkflowResolvedModelCandidate[]> | undefined;
  let activeCandidateIndex: number | undefined;
  let selectedModel: string | undefined;
  const modelAttempts: WorkflowModelAttempt[] = [];
  const modelWarnings: string[] = [];
  const modelCatalog = opts.models === undefined
    ? undefined
    : {
        ...opts.models,
        recordWarning: (warning: string): void => {
          modelWarnings.push(warning);
          opts.models?.recordWarning?.(warning);
        },
      } satisfies WorkflowModelCatalogPort;

  function modelCandidates(): Promise<WorkflowResolvedModelCandidate[]> {
    if (!candidatesPromise) {
      candidatesPromise = buildModelCandidatesFromCatalog({
        primaryModel: stageOptions?.model,
        fallbackModels: stageOptions?.fallbackModels,
        catalog: modelCatalog,
      });
    }
    return candidatesPromise;
  }

  function stageOptionsForCandidate(candidate: WorkflowResolvedModelCandidate | undefined): StageOptions | undefined {
    if (candidate === undefined) return stageOptions;
    return { ...(stageOptions ?? {}), model: candidate.value, fallbackModels: undefined };
  }

  function attachSession(created: StageSessionRuntime): StageSessionRuntime {
    session = created;
    if (pendingThinkingLevel !== undefined) {
      created.setThinkingLevel(pendingThinkingLevel);
    }
    for (const listener of pendingListeners) {
      listenerUnsubscribes.set(listener, created.subscribe(listener));
    }
    return created;
  }

  async function createSession(
    candidate: WorkflowResolvedModelCandidate | undefined,
    consumer: AgentSessionConsumer,
  ): Promise<StageSessionRuntime> {
    const created = adapters.agentSession
      ? await adapters.agentSession.create(stripWorkflowOnlyOptions(stageOptionsForCandidate(candidate)) as StageSessionCreateOptions, {
        ...meta,
        stageOptions: stageOptionsForCandidate(candidate),
      })
      : missingAdapter(consumer);
    return attachSession(created);
  }

  async function ensureSession(consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
    if (disposed) throw new Error(`pi-workflows: stage "${stageName}" session has been disposed`);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        if (!hasExplicitModelFallbackConfig) return createSession(undefined, consumer);
        const candidates = await modelCandidates();
        const first = candidates[0];
        if (first === undefined) return createSession(undefined, consumer);
        activeCandidateIndex = 0;
        selectedModel = first.id;
        return createSession(first, consumer);
      })();
    }
    return sessionPromise;
  }

  async function disposeCurrentSession(): Promise<void> {
    const current = session;
    session = undefined;
    sessionPromise = undefined;
    for (const unsubscribe of listenerUnsubscribes.values()) unsubscribe();
    listenerUnsubscribes.clear();
    await current?.dispose();
  }

  async function promptWithPauseResume(
    activeSession: StageSessionRuntime,
    initialText: string,
    sdkOptions: PromptOptions | undefined,
  ): Promise<void> {
    // Pause/resume loop: when a controlled pause aborts the SDK call,
    // swallow the resulting abort, suspend on `pauseRequest.deferred`,
    // and either re-issue with the user's resume message or return the
    // accumulated assistant text when resume carries no message.
    let nextText: string | undefined = initialText;
    while (nextText !== undefined) {
      const pendingPauseBeforePrompt = pauseRequest;
      if (pendingPauseBeforePrompt) {
        const { message } = await pendingPauseBeforePrompt.deferred.promise;
        nextText = message;
        if (nextText === undefined) return;
        continue;
      }
      try {
        await activeSession.prompt(nextText, sdkOptions);
        const pendingPauseAfterPrompt = pauseRequest;
        if (pendingPauseAfterPrompt) {
          const { message } = await pendingPauseAfterPrompt.deferred.promise;
          nextText = message;
          if (nextText === undefined) return;
          continue;
        }
        nextText = undefined;
      } catch (err) {
        if (pauseRequest) {
          const { message } = await pauseRequest.deferred.promise;
          nextText = message;
          continue;
        }
        throw err;
      }
    }
  }

  async function promptWithFallback(
    text: string,
    sdkOptions: PromptOptions | undefined,
    consumer: AgentSessionConsumer = "prompt",
  ): Promise<void> {
    if (!hasExplicitModelFallbackConfig) {
      await promptWithPauseResume(await ensureSession(consumer), text, sdkOptions);
      return;
    }

    const candidates = await modelCandidates();
    if (candidates.length === 0) {
      await promptWithPauseResume(await ensureSession(consumer), text, sdkOptions);
      return;
    }

    let index = activeCandidateIndex ?? 0;
    while (index < candidates.length) {
      const candidate = candidates[index]!;
      const activeSession = session && activeCandidateIndex === index
        ? session
        : await createSession(candidate, consumer);
      activeCandidateIndex = index;
      selectedModel = candidate.id;
      try {
        await promptWithPauseResume(activeSession, text, sdkOptions);
        modelAttempts.push({ model: candidate.id, success: true });
        return;
      } catch (err) {
        const message = errorMessage(err);
        modelAttempts.push({ model: candidate.id, success: false, error: message });
        if (signal?.aborted || !isRetryableModelFailure(message) || index === candidates.length - 1) {
          throw err;
        }
        const nextCandidate = candidates[index + 1]!;
        modelWarnings.push(`[fallback] ${candidate.id} failed: ${message}. Retrying with ${nextCandidate.id}.`);
        await disposeCurrentSession();
        index += 1;
      }
    }
  }

  function requireSession(property: string): StageSessionRuntime {
    if (!session) unavailableSync(property);
    return session;
  }

  return {
    name: stageName,

    async prompt(text, options) {
      const { sdkOptions, outputOptions } = splitPromptOptions(options);
      const runtimeCwd = typeof stageOptions?.cwd === "string" ? stageOptions.cwd : process.cwd();
      validatePromptOutputOptions(outputOptions);
      if (adapters.prompt) {
        const rawText = await adapters.prompt.prompt(text, meta);
        lastAssistantText = await finalizePromptOutput(rawText, outputOptions, runtimeCwd);
        adapterMessages = assistantMessage(lastAssistantText);
        return lastAssistantText;
      }
      await promptWithFallback(text, sdkOptions);
      const rawText = lastAssistantTextFromSession(session, lastAssistantText) ?? "";
      lastAssistantText = await finalizePromptOutput(rawText, outputOptions, runtimeCwd);
      return lastAssistantText;
    },

    async complete(text, completeOpts) {
      if (adapters.complete) {
        lastAssistantText = await adapters.complete.complete(text, completeOpts, meta);
        adapterMessages = assistantMessage(lastAssistantText);
        return lastAssistantText;
      }
      if (
        completeOpts?.model !== undefined ||
        completeOpts?.maxTokens !== undefined ||
        completeOpts?.fallbackModels !== undefined
      ) {
        throw new Error(
          "pi-workflows: complete options require a CompleteAdapter via RunOpts.adapters.complete",
        );
      }
      // Intentional fallback: when a CompleteAdapter is not configured,
      // `ctx.complete()` can still use the stage AgentSession for simple text
      // completions. Completion-specific options require the dedicated adapter.
      await promptWithFallback(text, undefined, "complete");
      lastAssistantText = lastAssistantTextFromSession(session, lastAssistantText) ?? "";
      return lastAssistantText;
    },

    async steer(text) {
      await (await ensureSession()).steer(text);
    },

    async followUp(text) {
      await (await ensureSession()).followUp(text);
    },

    subscribe(listener) {
      pendingListeners.add(listener);
      if (session) listenerUnsubscribes.set(listener, session.subscribe(listener));
      return () => {
        pendingListeners.delete(listener);
        const unsubscribe = listenerUnsubscribes.get(listener);
        listenerUnsubscribes.delete(listener);
        unsubscribe?.();
      };
    },

    get sessionFile() {
      return session?.sessionFile;
    },

    get sessionId() {
      return requireSession("sessionId").sessionId;
    },

    async setModel(model) {
      await (await ensureSession()).setModel(model);
    },

    setThinkingLevel(level) {
      pendingThinkingLevel = level;
      session?.setThinkingLevel(level);
    },

    async cycleModel() {
      return (await ensureSession()).cycleModel();
    },

    cycleThinkingLevel() {
      return requireSession("cycleThinkingLevel").cycleThinkingLevel();
    },

    get agent() {
      return requireSession("agent").agent;
    },

    get model() {
      return session?.model;
    },

    get thinkingLevel() {
      return requireSession("thinkingLevel").thinkingLevel;
    },

    get messages() {
      return session?.messages ?? adapterMessages;
    },

    get isStreaming() {
      return session?.isStreaming ?? false;
    },

    async navigateTree(targetId, options) {
      return (await ensureSession()).navigateTree(targetId, options);
    },

    async compact(customInstructions) {
      return (await ensureSession()).compact(customInstructions);
    },

    abortCompaction() {
      session?.abortCompaction();
    },

    async abort() {
      await session?.abort();
    },

    async __dispose() {
      disposed = true;
      for (const unsubscribe of listenerUnsubscribes.values()) unsubscribe();
      listenerUnsubscribes.clear();
      pendingListeners.clear();
      await session?.dispose();
    },

    __getLastAssistantText() {
      return lastAssistantTextFromSession(session, lastAssistantText);
    },

    getLastAssistantText() {
      return lastAssistantTextFromSession(session, lastAssistantText);
    },

    async __ensureSession() {
      await ensureSession();
    },

    __sessionMeta() {
      return {
        sessionId: session?.sessionId,
        sessionFile: session?.sessionFile,
      };
    },

    __agentSession() {
      return asAgentSession(session);
    },

    __pendingMessageCount() {
      return typeof session?.pendingMessageCount === "number" ? session.pendingMessageCount : 0;
    },

    __modelFallbackMeta() {
      const attemptedModels = modelAttempts.map((attempt) => attempt.model);
      const model = selectedModel ?? workflowModelId(session?.model);
      return {
        ...(model !== undefined ? { model } : {}),
        ...(attemptedModels.length > 0 ? { attemptedModels } : {}),
        ...(modelAttempts.length > 0 ? { modelAttempts: [...modelAttempts] } : {}),
        ...(modelWarnings.length > 0 ? { warnings: [...modelWarnings] } : {}),
      };
    },

    async __requestPause() {
      if (pauseRequest) return;
      const deferred = Promise.withResolvers<{ message?: string }>();
      // A shutdown may reject this deferred when no prompt awaiter is actively
      // observing it (for example a paused pending live stream). Keep the
      // original promise for real waiters, but mark expected cancellation as
      // observed so app-exit cleanup stays quiet.
      void deferred.promise.catch(() => {});
      pauseRequest = { deferred };
      // Best-effort: stop the current Pi op so the awaiter races abort.
      // The executor's `runTrackedStageCall` re-issues the call once
      // `__resume()` settles `pauseRequest.deferred`.
      await session?.abort();
    },

    async __resume(message?: string) {
      const req = pauseRequest;
      if (!req) return;
      pauseRequest = null;
      req.deferred.resolve({ message });
    },

    __isPaused() {
      return pauseRequest !== null;
    },
  };
}

function assistantMessage(text: string): AgentSession["messages"] {
  return [
    {
      role: "assistant",
      content: [{ type: "text", text }],
    },
  ] as AgentSession["messages"];
}
