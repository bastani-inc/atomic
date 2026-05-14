/**
 * Stage runner — creates an AgentSession-like StageContext for a workflow stage.
 *
 * The public stage surface mirrors the supported subset of pi's SDK
 * AgentSession. The executor wraps prompt() for lifecycle tracking and owns
 * disposal; workflow authors get direct SDK session methods without a custom
 * prompt/subagent abstraction.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { SessionManager, type AgentSession, type CreateAgentSessionOptions, type PromptOptions } from "@earendil-works/pi-coding-agent";
import type {
  CompleteStageOpts,
  StageContext,
  StageExecutionMeta,
  StageOptions,
  StageOutputOptions,
  StagePromptOptions,
  SubagentStageOpts,
  WorkflowMaxOutput,
} from "../../shared/types.js";

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
  navigateTree: AgentSession["navigateTree"];
  compact: AgentSession["compact"];
  abortCompaction(): void;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText?: () => string | undefined;
}

export interface AgentSessionAdapter {
  create(options: StageOptions, meta?: StageExecutionMeta): Promise<StageSessionRuntime>;
}

export interface PromptAdapter {
  prompt(text: string, meta?: StageExecutionMeta): Promise<string>;
}

export interface CompleteAdapter {
  complete(text: string, opts?: CompleteStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface SubagentAdapter {
  subagent(opts: SubagentStageOpts, meta?: StageExecutionMeta): Promise<string>;
}

export interface StageAdapters {
  agentSession?: AgentSessionAdapter;
  prompt?: PromptAdapter;
  complete?: CompleteAdapter;
  subagent?: SubagentAdapter;
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
    context,
    forkFromSessionFile,
    sessionDir,
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
  return sessionOptions;
}

function missingAdapter(): never {
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

function extractAssistantText(message: AgentSession["messages"][number]): string {
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
    if (!message || message.role !== "assistant") continue;
    const text = extractAssistantText(message).trim();
    if (text) return text;
  }
  return undefined;
}

function lastAssistantTextFromSession(
  activeSession: StageSessionRuntime | undefined,
  fallback: string | undefined,
): string | undefined {
  if (!activeSession) return fallback;
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

  // Wire the executor's abort signal to the pause deferred so a kill
  // (or other forced abort) doesn't leave a paused stage hanging on a
  // resume signal that will never arrive.
  if (signal) {
    const onAbort = (): void => {
      if (!pauseRequest) return;
      const req = pauseRequest;
      pauseRequest = null;
      req.deferred.reject(
        new Error(`pi-workflows: stage "${stageName}" aborted while paused`),
      );
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }

  async function ensureSession(): Promise<StageSessionRuntime> {
    if (disposed) throw new Error(`pi-workflows: stage "${stageName}" session has been disposed`);
    if (!sessionPromise) {
      sessionPromise = (async () => {
        const created = adapters.agentSession
          ? await adapters.agentSession.create(stripWorkflowOnlyOptions(stageOptions), meta)
          : missingAdapter();
        session = created;
        if (pendingThinkingLevel !== undefined) {
          created.setThinkingLevel(pendingThinkingLevel);
        }
        for (const listener of pendingListeners) {
          listenerUnsubscribes.set(listener, created.subscribe(listener));
        }
        return created;
      })();
    }
    return sessionPromise;
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
      const s = await ensureSession();
      // Pause/resume loop: when a controlled pause aborts the SDK call,
      // swallow the resulting abort, suspend on `pauseRequest.deferred`,
      // and either re-issue with the user's resume message or return the
      // accumulated assistant text when resume carries no message.
      let nextText: string | undefined = text;
      while (nextText !== undefined) {
        try {
          await s.prompt(nextText, sdkOptions);
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
      const rawText = lastAssistantTextFromSession(session, lastAssistantText) ?? "";
      lastAssistantText = await finalizePromptOutput(rawText, outputOptions, runtimeCwd);
      return lastAssistantText;
    },

    async complete(text, completeOpts) {
      if (!adapters.complete) {
        throw new Error(
          "pi-workflows: complete adapter not configured — provide a CompleteAdapter via RunOpts.adapters.complete",
        );
      }
      lastAssistantText = await adapters.complete.complete(text, completeOpts, meta);
      adapterMessages = assistantMessage(lastAssistantText);
      return lastAssistantText;
    },

    async subagent(subagentOpts) {
      if (!adapters.subagent) {
        throw new Error(
          "pi-workflows: subagent requires pi task delegation support",
        );
      }
      lastAssistantText = await adapters.subagent.subagent(subagentOpts, meta);
      adapterMessages = assistantMessage(lastAssistantText);
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

    async __requestPause() {
      if (pauseRequest) return;
      pauseRequest = { deferred: Promise.withResolvers<{ message?: string }>() };
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
