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
import {
  createStructuredOutputCapture,
  createStructuredOutputTool,
  shouldApplyCodexFastModeForScope,
  SessionManager,
  type AgentSession,
  type CreateAgentSessionOptions,
  type PromptOptions,
  type StructuredOutputCapture,
} from "@bastani/atomic";
import type {
  CompleteStageOpts,
  StageContext,
  StageExecutionMeta,
  StageOptions,
  StageOutputOptions,
  StagePromptOptions,
  WorkflowMaxOutput,
  WorkflowModelAttempt,
  WorkflowExecutionMode,
  WorkflowModelCatalogPort,
} from "../../shared/types.js";
import type { Static, TSchema } from "typebox";
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
  /** Settings manager supplied by the Atomic SDK when the adapter did not pre-create one. */
  readonly settingsManager?: WorkflowFastModeSettingsManager;
  navigateTree: AgentSession["navigateTree"];
  compact: AgentSession["compact"];
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText?: () => string | undefined;
}

export type StageSessionCreateOptions = CreateAgentSessionOptions & Pick<StageOptions, "mcp" | "fallbackModels" | "fallbackThinkingLevels">;

type WorkflowFastModeSettings = {
  readonly chat: boolean;
  readonly workflow: boolean;
};

type WorkflowFastModeSettingsManager = {
  getCodexFastModeSettings(): WorkflowFastModeSettings;
};

export interface StageSessionCreateResult {
  readonly session: StageSessionRuntime;
  readonly settingsManager?: WorkflowFastModeSettingsManager;
}

export interface AgentSessionAdapter {
  create(options: StageSessionCreateOptions, meta?: StageExecutionMeta): Promise<StageSessionRuntime | StageSessionCreateResult>;
}

export interface StageModelFallbackMeta {
  readonly model?: string;
  readonly fastMode?: boolean;
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
  /** Runtime execution mode forwarded to stage session adapters. */
  executionMode?: WorkflowExecutionMode;
  /** Internal: notifies the executor when an in-flight fallback changes model/fast metadata. */
  onModelFallbackMetaChange?: (meta: StageModelFallbackMeta) => void;
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
    schema: _schema,
    mcp: _mcp,
    fallbackModels: _fallbackModels,
    fallbackThinkingLevels: _fallbackThinkingLevels,
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
      "atomic-workflows: ctx.complete requires either RunOpts.adapters.complete or RunOpts.adapters.agentSession",
    );
  }
  throw new Error(
    "atomic-workflows: prompt adapter not configured — provide an AgentSessionAdapter via RunOpts.adapters.agentSession",
  );
}

function unavailableSync(property: string): never {
  throw new Error(
    `atomic-workflows: stage AgentSession property "${property}" is unavailable until the SDK session has been created`,
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

function lastAssistantTextFromMessages(messages: AgentSession["messages"]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Only assistant prose is a valid non-terminating turn output. A tool
    // result is the turn output ONLY when its tool terminated the turn, which
    // is handled separately by `terminatingToolResultText`.
    if (!message || message.role !== "assistant") continue;
    const text = extractMessageText(message).trim();
    if (text) return text;
  }
  return undefined;
}

function messageStopReason(message: AgentSession["messages"][number]): string | undefined {
  const record = message as { readonly stopReason?: unknown };
  return typeof record.stopReason === "string" ? record.stopReason : undefined;
}

function normalizedStopReason(stopReason: string | undefined): string | undefined {
  return stopReason?.toLowerCase().replace(/[_-]+/g, "");
}

function isTerminalAssistantFailureStopReason(stopReason: string | undefined): boolean {
  const normalized = normalizedStopReason(stopReason);
  return normalized === "error" || normalized === "aborted";
}

function isCleanAssistantStopReason(stopReason: string | undefined): boolean {
  const normalized = normalizedStopReason(stopReason);
  return normalized === "stop" || normalized === "tooluse" || normalized === "length";
}

function assistantErrorMessage(message: AgentSession["messages"][number]): string | undefined {
  const record = message as { readonly errorMessage?: unknown };
  return typeof record.errorMessage === "string" && record.errorMessage.trim().length > 0
    ? record.errorMessage
    : undefined;
}

function latestTerminalAssistantFailureSince(
  messages: AgentSession["messages"],
  startIndex: number,
): AgentSession["messages"][number] | undefined {
  for (let index = messages.length - 1; index >= startIndex; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") continue;
    const stopReason = messageStopReason(message);
    if (isTerminalAssistantFailureStopReason(stopReason)) return message;
    if (isCleanAssistantStopReason(stopReason)) return undefined;
    if (assistantErrorMessage(message) === undefined && extractMessageText(message).trim().length > 0) {
      return undefined;
    }
  }
  return undefined;
}

class WorkflowPromptModelFailure extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(errorMessage(cause));
    this.name = "WorkflowPromptModelFailure";
    this.cause = cause;
  }
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
 * Returns the trailing tool-result text ONLY when the most recent
 * conversational message is a tool result whose tool call actually returned
 * `terminate: true` (tracked at runtime from the session's tool_execution_end
 * events — see `terminatingToolCallIds`). Returns `undefined` for a turn that
 * ended on an assistant response, OR on a tool result from a non-terminating
 * tool (e.g. a turn aborted/errored right after a tool call) — both fall back
 * to the last assistant message.
 */
function terminatingToolResultText(
  messages: AgentSession["messages"],
  terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    if (message.role === "toolResult") {
      // The trailing message is a tool result. It is the deterministic turn
      // output only if THIS tool call returned `terminate: true`; otherwise the
      // turn ended on this tool for another reason (abort/error) and the last
      // assistant message is the real output.
      const toolCallId = (message as { toolCallId?: unknown }).toolCallId;
      if (typeof toolCallId !== "string" || !terminatingToolCallIds.has(toolCallId)) {
        return undefined;
      }
      const text = extractMessageText(message).trim();
      return text.length > 0 ? text : undefined;
    }
    if (message.role === "assistant") return undefined;
    // Skip non-conversational roles (system/user) while locating the tail.
  }
  return undefined;
}

/**
 * A stage session backed by a real Atomic `AgentSession` exposes its
 * `extensionRunner`. When workflow wiring binds extensions to a stage session it
 * replays the `session_start` lifecycle (see wiring.ts `bindExtensions`), so
 * extensions such as MCP begin per-session initialization. Tearing that session
 * down with `dispose()` alone invalidates the extension runtime WITHOUT emitting
 * `session_shutdown`, so those extensions never receive a graceful teardown
 * signal: MCP, for example, logs a spurious stale-context "initialization
 * failed" error when its deferred init races with disposal, and leaves any child
 * MCP servers running.
 *
 * The test stub session (createTestAgentSession) has no `extensionRunner`, so the
 * capability is optional and feature-detected at runtime.
 */
type StageSessionExtensionRunner = {
  hasHandlers(eventType: string): boolean;
  emit(event: { readonly type: "session_shutdown"; readonly reason: "quit" }): Promise<unknown>;
};

function stageSessionExtensionRunner(
  current: StageSessionRuntime,
): StageSessionExtensionRunner | undefined {
  const runner = (current as StageSessionRuntime & { extensionRunner?: StageSessionExtensionRunner })
    .extensionRunner;
  if (runner && typeof runner.hasHandlers === "function" && typeof runner.emit === "function") {
    return runner;
  }
  return undefined;
}

/**
 * Dispose a stage session, mirroring the host `AgentSessionRuntime` teardown:
 * emit `session_shutdown` before `dispose()` whenever the session exposes a
 * compatible extension runner, so extensions tear down per-session resources
 * (and bump their lifecycle generation) instead of being silently invalidated.
 * A throwing shutdown handler must never strand the session, so disposal always
 * runs.
 */
async function disposeStageSession(current: StageSessionRuntime | undefined): Promise<void> {
  if (!current) return;
  const runner = stageSessionExtensionRunner(current);
  if (runner?.hasHandlers("session_shutdown")) {
    try {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
    } catch (error) {
      console.error("atomic-workflows: stage session_shutdown handler failed", error);
    }
  }
  await current.dispose();
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
  terminatingToolCallIds: ReadonlySet<string>,
): string | undefined {
  if (!activeSession) return fallback;
  // A tool that returned `terminate: true` ends the turn with its tool result
  // as the final message; that result is the deterministic stage output and
  // wins over prose emitted before the terminating tool call. Detection is by
  // the tool call's actual runtime terminate flag — NOT merely "the last
  // message is a tool result".
  const terminatingText = terminatingToolResultText(activeSession.messages, terminatingToolCallIds);
  if (terminatingText !== undefined) return terminatingText;
  // Otherwise the turn output is the last assistant message — never a tool
  // result from a non-terminating tool.
  const direct = activeSession.getLastAssistantText?.();
  if (direct !== undefined && direct.trim()) return direct;
  return lastAssistantTextFromMessages(activeSession.messages) ?? direct ?? fallback;
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

const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

function structuredOutputPrompt(text: string): string {
  return `${text}\n\nFinal output contract:\n- Your final action MUST be a structured_output tool call.\n- Pass the schema fields directly as tool arguments; do not wrap them in { value: ... } unless the schema explicitly defines a top-level value field.\n- Do not emit a prose final answer instead of structured_output.\n- If you need to inspect files or run commands first, do so, then call structured_output exactly once.`;
}

function stringifyStructuredOutputValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`atomic-workflows: structured_output returned a non-serializable value: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stageOptionsWithStructuredOutput(
  options: StageOptions | undefined,
  capture: StructuredOutputCapture<unknown> | undefined,
): StageOptions | undefined {
  if (!options?.schema || !capture) return options;
  const tools = options.tools === undefined
    ? undefined
    : Array.from(new Set([...options.tools, STRUCTURED_OUTPUT_TOOL_NAME]));
  const excludedTools = options.excludedTools?.filter((toolName) => toolName !== STRUCTURED_OUTPUT_TOOL_NAME);
  return {
    ...options,
    ...(tools !== undefined ? { tools } : {}),
    ...(excludedTools !== undefined ? { excludedTools } : {}),
    customTools: [
      ...(options.customTools ?? []),
      createStructuredOutputTool({
        schema: options.schema as TSchema,
        capture: capture as StructuredOutputCapture<Static<TSchema>>,
      }),
    ],
  };
}

function validatePromptOutputOptions(outputOptions: StageOutputOptions): void {
  if (outputOptions.outputMode === "file-only" && (typeof outputOptions.output !== "string" || outputOptions.output.length === 0)) {
    throw new Error(
      "atomic-workflows: prompt sets outputMode: \"file-only\" but does not configure an output file. Set output to a path or use outputMode: \"inline\".",
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
  const { stageId, stageName, adapters, runId, signal, stageOptions, executionMode } = opts;
  const structuredOutputCapture = stageOptions?.schema ? createStructuredOutputCapture<unknown>() : undefined;
  const effectiveStageOptions = stageOptionsWithStructuredOutput(stageOptions, structuredOutputCapture);
  const meta: StageExecutionMeta = { runId, stageId, stageName, signal, stageOptions: effectiveStageOptions, executionMode };
  let session: StageSessionRuntime | undefined;
  let sessionPromise: Promise<StageSessionRuntime> | undefined;
  let lastAssistantText: string | undefined;
  // Tool-call ids whose tool returned `terminate: true` at runtime, observed
  // from the session's `tool_execution_end` events. The SDK ends the turn on a
  // terminating tool, so its tool result is the deterministic stage output; a
  // trailing tool result from any other tool is NOT. See
  // `lastAssistantTextFromSession`. The tool result *message* does not carry the
  // terminate flag, so it must be tracked from the live event stream.
  const terminatingToolCallIds = new Set<string>();
  let unsubscribeTerminateWatcher: (() => void) | undefined;
  const recordTerminatingToolCall = (event: unknown): void => {
    if (event === null || typeof event !== "object") return;
    const record = event as Record<string, unknown>;
    if (record["type"] !== "tool_execution_end") return;
    const result = record["result"];
    if (result === null || typeof result !== "object") return;
    if ((result as Record<string, unknown>)["terminate"] !== true) return;
    const callId = record["toolCallId"];
    if (typeof callId === "string" && callId.length > 0) {
      terminatingToolCallIds.add(callId);
    }
  };
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
    effectiveStageOptions?.model !== undefined || (effectiveStageOptions?.fallbackModels?.length ?? 0) > 0;
  let candidatesPromise: Promise<WorkflowResolvedModelCandidate[]> | undefined;
  let activeCandidateIndex: number | undefined;
  let selectedModel: string | undefined;
  const modelAttempts: WorkflowModelAttempt[] = [];
  const modelWarnings: string[] = [];
  const pendingFallbackWarnings: string[] = [];
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
        primaryModel: effectiveStageOptions?.model,
        fallbackModels: effectiveStageOptions?.fallbackModels,
        fallbackThinkingLevels: effectiveStageOptions?.fallbackThinkingLevels,
        catalog: modelCatalog,
      });
    }
    return candidatesPromise;
  }

  function stageOptionsForCandidate(candidate: WorkflowResolvedModelCandidate | undefined): StageOptions | undefined {
    if (candidate === undefined) return effectiveStageOptions;
    return {
      ...(effectiveStageOptions ?? {}),
      model: candidate.value,
      ...(candidate.reasoningLevel !== undefined ? { thinkingLevel: candidate.reasoningLevel } : {}),
      fallbackModels: undefined,
      fallbackThinkingLevels: undefined,
    };
  }

  let sessionSettingsManager: WorkflowFastModeSettingsManager | undefined;

  function isWorkflowFastModeEnabled(): boolean | undefined {
    const model = session?.model;
    const settingsManager = sessionSettingsManager ?? effectiveStageOptions?.settingsManager;
    if (model === undefined || settingsManager === undefined) return undefined;
    return shouldApplyCodexFastModeForScope(model, settingsManager.getCodexFastModeSettings(), "workflow");
  }

  function currentModelFallbackMeta(): StageModelFallbackMeta {
    const attemptedModels = modelAttempts.map((attempt) => attempt.model);
    const model = selectedModel ?? workflowModelId(session?.model);
    const fastMode = isWorkflowFastModeEnabled();
    return {
      ...(model !== undefined ? { model } : {}),
      ...(fastMode !== undefined ? { fastMode } : {}),
      ...(attemptedModels.length > 0 ? { attemptedModels } : {}),
      ...(modelAttempts.length > 0 ? { modelAttempts: [...modelAttempts] } : {}),
      ...(modelWarnings.length > 0 ? { warnings: [...modelWarnings] } : {}),
    };
  }

  function notifyModelFallbackMetaChange(): void {
    opts.onModelFallbackMetaChange?.(currentModelFallbackMeta());
  }

  function normalizeSessionCreateResult(created: StageSessionRuntime | StageSessionCreateResult): StageSessionCreateResult {
    if ("session" in created) return created;
    return { session: created };
  }

  function effectiveCandidateReasoning(candidate: WorkflowResolvedModelCandidate): StageOptions["thinkingLevel"] | undefined {
    return candidate.reasoningLevel ?? effectiveStageOptions?.thinkingLevel;
  }

  function modelAttemptReasoning(candidate: WorkflowResolvedModelCandidate): Pick<WorkflowModelAttempt, "reasoningLevel"> {
    const reasoningLevel = effectiveCandidateReasoning(candidate);
    return reasoningLevel !== undefined ? { reasoningLevel } : {};
  }

  function applyCandidateThinking(candidate: WorkflowResolvedModelCandidate | undefined): void {
    pendingThinkingLevel = candidate === undefined
      ? effectiveStageOptions?.thinkingLevel
      : effectiveCandidateReasoning(candidate);
  }

  function candidateLabel(candidate: WorkflowResolvedModelCandidate): string {
    return candidate.reasoningLevel !== undefined ? `${candidate.id}:${candidate.reasoningLevel}` : candidate.id;
  }

  function attachSession(created: StageSessionRuntime | StageSessionCreateResult): StageSessionRuntime {
    const result = normalizeSessionCreateResult(created);
    session = result.session;
    sessionSettingsManager = result.settingsManager ?? result.session.settingsManager;
    if (pendingThinkingLevel !== undefined) {
      result.session.setThinkingLevel(pendingThinkingLevel);
    }
    for (const listener of pendingListeners) {
      listenerUnsubscribes.set(listener, result.session.subscribe(listener));
    }
    // Track terminating tool calls for this session so the stage result text is
    // derived deterministically from a tool that actually ended the turn.
    unsubscribeTerminateWatcher?.();
    unsubscribeTerminateWatcher = result.session.subscribe((event) => recordTerminatingToolCall(event));
    return result.session;
  }

  async function createSession(
    candidate: WorkflowResolvedModelCandidate | undefined,
    consumer: AgentSessionConsumer,
  ): Promise<StageSessionRuntime> {
    applyCandidateThinking(candidate);
    const created = adapters.agentSession
      ? await adapters.agentSession.create(stripWorkflowOnlyOptions(stageOptionsForCandidate(candidate)) as StageSessionCreateOptions, {
        ...meta,
        stageOptions: stageOptionsForCandidate(candidate),
      })
      : missingAdapter(consumer);
    return attachSession(created);
  }

  async function ensureSession(consumer: AgentSessionConsumer = "prompt"): Promise<StageSessionRuntime> {
    if (disposed) throw new Error(`atomic-workflows: stage "${stageName}" session has been disposed`);
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
    sessionSettingsManager = undefined;
    for (const unsubscribe of listenerUnsubscribes.values()) unsubscribe();
    listenerUnsubscribes.clear();
    unsubscribeTerminateWatcher?.();
    unsubscribeTerminateWatcher = undefined;
    terminatingToolCallIds.clear();
    await disposeStageSession(current);
  }

  async function promptWithPauseResume(
    activeSession: StageSessionRuntime,
    initialText: string,
    sdkOptions: PromptOptions | undefined,
  ): Promise<{ readonly terminalScanStartIndex: number }> {
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
        if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
        continue;
      }
      const promptStartIndex = activeSession.messages.length;
      try {
        await activeSession.prompt(nextText, sdkOptions);
        const pendingPauseAfterPrompt = pauseRequest;
        if (pendingPauseAfterPrompt) {
          const { message } = await pendingPauseAfterPrompt.deferred.promise;
          nextText = message;
          if (nextText === undefined) return { terminalScanStartIndex: activeSession.messages.length };
          continue;
        }
        return { terminalScanStartIndex: promptStartIndex };
      } catch (err) {
        const pendingPauseAfterThrow = pauseRequest;
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
      notifyModelFallbackMetaChange();
      try {
        const { terminalScanStartIndex } = await promptWithPauseResume(activeSession, text, sdkOptions);
        const terminalFailure = latestTerminalAssistantFailureSince(activeSession.messages, terminalScanStartIndex);
        if (terminalFailure !== undefined) {
          throw new WorkflowPromptModelFailure(terminalFailure);
        }
        modelAttempts.push({ model: candidate.id, success: true, ...modelAttemptReasoning(candidate) });
        pendingFallbackWarnings.length = 0;
        return;
      } catch (err) {
        const message = errorMessage(err);
        modelAttempts.push({ model: candidate.id, success: false, ...modelAttemptReasoning(candidate), error: message });
        if (signal?.aborted || !isRetryableModelFailure(err) || index === candidates.length - 1) {
          modelWarnings.push(...pendingFallbackWarnings);
          pendingFallbackWarnings.length = 0;
          notifyModelFallbackMetaChange();
          throw err;
        }
        const nextCandidate = candidates[index + 1]!;
        pendingFallbackWarnings.push(`[fallback] ${candidateLabel(candidate)} failed: ${message}. Retrying with ${candidateLabel(nextCandidate)}.`);
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
      const runtimeCwd = typeof effectiveStageOptions?.cwd === "string" ? effectiveStageOptions.cwd : process.cwd();
      validatePromptOutputOptions(outputOptions);
      if (adapters.prompt) {
        if (structuredOutputCapture) {
          throw new Error("atomic-workflows: stage schema requires an AgentSessionAdapter so the structured_output tool can be registered.");
        }
        const rawText = await adapters.prompt.prompt(text, meta);
        lastAssistantText = await finalizePromptOutput(rawText, outputOptions, runtimeCwd);
        adapterMessages = assistantMessage(lastAssistantText);
        return lastAssistantText;
      }
      await promptWithFallback(structuredOutputCapture ? structuredOutputPrompt(text) : text, sdkOptions);
      if (structuredOutputCapture) {
        if (!structuredOutputCapture.called) {
          throw new Error("atomic-workflows: stage configured with schema must finish by calling structured_output.");
        }
        const rawStructuredText = stringifyStructuredOutputValue(structuredOutputCapture.value);
        lastAssistantText = await finalizePromptOutput(rawStructuredText, outputOptions, runtimeCwd);
        return structuredOutputCapture.value as never;
      }
      const rawText = lastAssistantTextFromSession(session, lastAssistantText, terminatingToolCallIds) ?? "";
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
          "atomic-workflows: complete options require a CompleteAdapter via RunOpts.adapters.complete",
        );
      }
      // Intentional fallback: when a CompleteAdapter is not configured,
      // `ctx.complete()` can still use the stage AgentSession for simple text
      // completions. Completion-specific options require the dedicated adapter.
      await promptWithFallback(text, undefined, "complete");
      lastAssistantText = lastAssistantTextFromSession(session, lastAssistantText, terminatingToolCallIds) ?? "";
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

    async compact() {
      return (await ensureSession()).compact();
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
      unsubscribeTerminateWatcher?.();
      unsubscribeTerminateWatcher = undefined;
      terminatingToolCallIds.clear();
      await disposeStageSession(session);
    },

    __getLastAssistantText() {
      return lastAssistantTextFromSession(session, lastAssistantText, terminatingToolCallIds);
    },

    getLastAssistantText() {
      return lastAssistantTextFromSession(session, lastAssistantText, terminatingToolCallIds);
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
      return currentModelFallbackMeta();
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
