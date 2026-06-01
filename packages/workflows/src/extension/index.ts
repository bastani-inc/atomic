import { renderCall } from "./render-call.js";
import { renderResult } from "./render-result.js";
import type {
  RenderResultOpts,
  WorkflowInputEntry,
  WorkflowToolResult,
} from "./render-result.js";
import { renderInputsSchema } from "../shared/render-inputs-schema.js";
import { WorkflowParametersSchema } from "./workflow-schema.js";
import { renderRunBanner, renderRunSummary } from "./renderers.js";
import type { RunEndPayload, RunStartPayload } from "./renderers.js";
import type { RunStatus, StageSnapshot, StageStatus, ToolEvent } from "../shared/store-types.js";
import { store } from "../shared/store.js";
import { stageUiBroker } from "../shared/stage-ui-broker.js";
import {
  coerceStageInputAnswer,
  hasStageInputAnswerContent,
  type StageInputAnswer,
} from "../shared/stage-prompt.js";
import { restoreOnSessionStart } from "../shared/persistence-restore.js";
import type { SessionManager } from "../shared/persistence-restore.js";
import { installCompactionHook } from "../shared/persistence-compaction-policy.js";
import {
  killRun,
  killAllRuns,
  resumeRun,
  pauseRun,
  pauseAllRuns,
  interruptRun,
  interruptAllRuns,
  inspectRun,
  type RunDetail,
} from "../runs/background/status.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { stageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import { registerIntercomParentSession } from "../intercom/intercom-bridge.js";
import { subscribeIntercomControl } from "../intercom/result-intercom.js";
import { buildIntercomCallbacks } from "../intercom/intercom-routing.js";
import {
  installStoreWidget,
  installToolExecutionHooks,
} from "../tui/store-widget-installer.js";
import type { WidgetFactory } from "../tui/store-widget-installer.js";
import { buildGraphOverlayAdapter } from "../tui/overlay-adapter.js";
import type { OverlayPiSurface } from "../tui/overlay-adapter.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { renderSessionList } from "../tui/session-list.js";
import { selectRunsForPicker } from "../tui/session-picker.js";
import { renderRunDetail } from "../tui/run-detail.js";

import { openSessionPicker, openKillConfirm } from "../tui/session-overlays.js";
import {
  openInlineInputsForm,
  registerInlineFormRenderer,
} from "../tui/inline-form-overlay.js";
import {
  registerChatSurfaceRenderer,
  emitChatSurface,
} from "../tui/chat-surface-message.js";
import { openInputsPicker } from "../tui/inputs-overlay.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { createExtensionRuntime } from "./runtime.js";
import type { ExtensionRuntime } from "./runtime.js";
import {
  discoverWorkflows,
  discoverStartupWorkflowsSync,
} from "./discovery.js";
import type { DiscoveryResult } from "./discovery.js";
import {
  loadWorkflowConfig,
  toScopedDiscoveryConfig,
  WORKFLOW_CONFIG_DEFAULTS,
  withWorkflowDefaults,
} from "./config-loader.js";
import {
  createWorkflowLifecycleNotificationState,
  installWorkflowLifecycleNotifications,
  registerLifecycleNoticeRenderer,
  resetWorkflowLifecycleNotificationState,
  seedWorkflowLifecycleNotificationState,
  withWorkflowLifecycleNotificationsSuppressed,
  withWorkflowLifecycleNotificationsSuppressedAsync,
} from "./lifecycle-notifications.js";
import type { WorkflowLifecycleNotificationConfig } from "./lifecycle-notifications.js";
import {
  createWorkflowHilAnswerNotificationState,
  installWorkflowHilAnswerNotifications,
  registerHilAnswerNoticeRenderer,
  resetWorkflowHilAnswerNotificationState,
} from "./hil-answer-notifications.js";
import type { ConfigLoadResult } from "./config-loader.js";
import type {
  WorkflowPersistencePort,
  WorkflowMcpPort,
  WorkflowRuntimeConfig,
  WorkflowChainStep,
  WorkflowDirectTaskItem,
  WorkflowDetails,
  WorkflowMaxOutput,
  WorkflowModelCatalogPort,
  WorkflowModelInfo,
  StageOptions,
  WorkflowExecutionPolicy,
} from "../shared/types.js";
import { INTERACTIVE_WORKFLOW_POLICY, NON_INTERACTIVE_WORKFLOW_POLICY } from "../shared/types.js";
import { buildRuntimeAdapters } from "./wiring.js";
import type { PiUISurface } from "./wiring.js";
import { createStatusWriter } from "./status-writer.js";
import type { StatusWriter } from "./status-writer.js";
import { setMcpScope, clearMcpScope } from "./mcp.js";
import type { PiMcpExtensionAPI, PiEventBus } from "./mcp.js";
import type { StageSessionRuntime } from "../runs/foreground/stage-runner.js";
import { WORKFLOW_STAGE_SUBAGENT_GUARD_ENV, getEnvValue, type CreateAgentSessionOptions } from "@bastani/atomic";

export const WORKFLOW_TOOL_DESCRIPTION =
  "Run named workflows or direct one-off task/tasks/chain workflows; " +
  "discover with list/get/inputs, inspect status/stages/stage details/transcripts, " +
  "send prompt answers or steering, pause/resume/interrupt/kill runs, and reload workflow resources.";

// ---------------------------------------------------------------------------
// Minimal ExtensionAPI structural types
// No `any`; all optional fields use explicit union with undefined.
// cross-ref: pi docs/skills/authoring-extensions.md (ExtensionAPI shape)
// ---------------------------------------------------------------------------

/** Theme object passed to renderCall/renderResult slots (opaque — not consumed in stubs). */
export type PiTheme = Record<string, string>;

/** Context object passed to renderCall/renderResult slots. */
export interface PiRenderContext {
  state?: {
    runId?: string;
    stages?: unknown[];
  };
  invalidate?: () => void;
}

/** Options bag passed to renderResult. */
export interface PiRenderResultOpts extends RenderResultOpts {}

export interface PiRenderComponent {
  render(width: number): string[];
  invalidate?: () => void;
  includes(searchString: string): boolean;
}

export interface PiMessageRenderComponent {
  render(width: number): string[];
  invalidate?: () => void;
}

export type PiMessageRendererResult = string | PiMessageRenderComponent | undefined;

function textRenderComponent(text: string): PiRenderComponent {
  return dynamicTextRenderComponent(() => text);
}

function dynamicTextRenderComponent(renderText: (width: number) => string): PiRenderComponent {
  return {
    render(width: number): string[] {
      return renderText(width).split("\n");
    },
    includes(searchString: string): boolean {
      return renderText(120).includes(searchString);
    },
  };
}

/**
 * Completion for a slash-command argument. Matches pi-tui's `AutocompleteItem`.
 * `value` is the text inserted on selection; `label` is the menu display; the
 * optional `description` is the secondary line. Without `value`, pi-tui crashes
 * in `getBestAutocompleteMatchIndex` (`value.startsWith(prefix)`).
 * cross-ref: @earendil-works/pi-tui autocomplete AutocompleteItem
 */
export interface PiArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

/**
 * Canonical slash command options for pi.registerCommand(name, options).
 * Mirrors `RegisteredCommand` from pi's `extensibility/extensions/types.ts`
 * minus the `name` field (which is the first arg to registerCommand).
 * cross-ref: research/docs/2026-05-11-pi-coding-agent-reference.md §4.2
 */
export type PiArgumentCompletionResult = PiArgumentCompletion[] | null;

export interface PiCommandOptions {
  description: string;
  handler: (args: string, ctx: PiCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (partial: string) => PiArgumentCompletionResult;
}

/**
 * Context provided to slash command handlers. Aligns with pi's
 * `ExtensionCommandContext` (subset of what we actually consume): the
 * host always supplies `ui` and `ui.notify`, so callers print via
 * `ctx.ui.notify("…", "info")` directly — no wrapper indirection.
 */
interface PiRuntimeModel {
  readonly provider: string;
  readonly id: string;
}

interface PiRuntimeModelRegistry {
  getAvailable(): PiRuntimeModel[];
}

interface PiModelContext {
  readonly model?: PiRuntimeModel;
  readonly modelRegistry?: PiRuntimeModelRegistry;
}

export interface PiCommandContext extends PiModelContext {
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  } & PiUISurface;
  /**
   * False when the host bound a no-op UI surface (print/JSON `-p` modes).
   * Absent on older hosts and unit-test stubs; treat absence as interactive.
   */
  hasUI?: boolean;
}

/** CLI flag registration options. Mirrors the inline options on `ExtensionAPI.registerFlag`. */
export interface PiFlagNamedOpts {
  description: string;
  type?: "string" | "boolean";
  default?: unknown;
}

/**
 * Pi's AgentToolResult shape — returned by `execute` and consumed by
 * `renderResult`. `details` carries the original workflow result for the
 * renderer; `content` is what the model sees on tool completion.
 */
export interface PiAgentToolResult<TDetails> {
  content: Array<
    { type: "text"; text: string } | { type: "image"; [key: string]: unknown }
  >;
  details: TDetails;
  terminate?: boolean;
}

/** Tool registration options aligned with pi's `ToolDefinition`. */
export interface PiToolOpts<TArgs, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: unknown; // TypeBox TSchema — pi consumes it opaquely
  renderShell?: "default" | "self";
  /**
   * Pi calls execute positionally: `(toolCallId, params, signal, onUpdate, ctx)`.
   * cross-ref: pi-coding-agent dist/core/extensions/types.d.ts ToolDefinition.execute
   */
  execute: (
    toolCallId: string,
    params: TArgs,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: PiAgentToolResult<TDetails>) => void) | undefined,
    ctx: PiExecuteContext,
  ) => Promise<PiAgentToolResult<TDetails>>;
  /** Pi passes args directly as the first positional arg (not wrapped). */
  renderCall?: (
    args: TArgs,
    theme: PiTheme,
    context: PiRenderContext,
  ) => PiRenderComponent | string;
  /** Pi passes the full AgentToolResult as the first positional arg. */
  renderResult?: (
    result: PiAgentToolResult<TDetails>,
    opts: PiRenderResultOpts,
    theme: PiTheme,
    context: PiRenderContext,
  ) => PiRenderComponent | string;
}

/** Execution context provided to tool execute handlers. */
export interface PiExecuteContext extends PiModelContext {
  sessionId?: string;
  ui?: PiUISurface;
  hasUI?: boolean;
  orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
  sessionManager?: SessionManager & {
    getSessionFile?: () => string | undefined;
  };
  [key: string]: unknown;
}

/**
 * Structural subset of pi's `ExtensionAPI` (see
 * `packages/coding-agent/src/extensibility/extensions/types.ts`) covering
 * the methods this extension consumes. Fields are optional so test
 * mocks can stub a minimal surface; production runtime supplies all of
 * them.
 */
export interface WorkflowResourceInfo {
  readonly path: string;
  readonly enabled: boolean;
  readonly metadata?: {
    readonly source?: string;
    readonly scope?: string;
    readonly origin?: string;
    readonly baseDir?: string;
  };
}

export interface ExtensionAPI {
  registerTool?: <TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) => void;
  /**
   * `pi.registerCommand(name, options)` — sole slash-command registration
   * surface. Mirrors pi's `ExtensionAPI.registerCommand`.
   */
  registerCommand?: (name: string, options: PiCommandOptions) => void;
  registerMessageRenderer?: (
    event: string,
    renderer: (payload: unknown) => PiMessageRendererResult,
  ) => void;
  /**
   * Inject a custom message into chat history. Used by inline workflow surfaces
   * such as `workflows:input-form`; cards stay in scrollback and are
   * re-rendered by the registered renderer on every `tui.requestRender()`.
   */
  sendMessage?: <T = unknown>(
    message: {
      customType: string;
      content?: string;
      display?: boolean;
      details?: T;
    },
    options?: {
      triggerTurn?: boolean;
      deliverAs?: "steer" | "followUp" | "nextTurn" | "interrupt";
      interruptAbortMessage?: string;
    },
  ) => void | Promise<void>;
  registerFlag?: (name: string, opts: PiFlagNamedOpts) => void;
  /** Return package-provided workflow files discovered by Atomic's package loader. */
  getWorkflowResources?: () => readonly WorkflowResourceInfo[];
  /**
   * Register a keyboard shortcut.
   * Present on pi >= 1.x; absent on older runtimes.
   */
  registerShortcut?: (
    key: string,
    opts: {
      description: string;
      handler: (ctx?: PiCommandContext) => void | Promise<void>;
    },
  ) => void;
  /**
   * Read the model's currently-active tool names. Present on pi's ExtensionAPI;
   * absent on older runtimes.
   */
  getActiveTools?: () => string[];
  /**
   * Replace the model's active tool set by name. Present on pi's ExtensionAPI;
   * absent on older runtimes.
   */
  setActiveTools?: (toolNames: string[]) => void;
  /**
   * Sets the current session name. Present on pi's ExtensionAPI.
   */
  setSessionName?: (name: string) => void | Promise<void>;
  /**
   * pi events bus — used for workflow-scoped MCP events and subagent
   * lifecycle/result routing.
   */
  events?: {
    emit?: (event: string, payload: Record<string, unknown>) => void;
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
  /**
   * Execute a shell command and return stdout/stderr/exit code.
   * Present on the pi ExtensionAPI.
   */
  exec?: (
    command: string,
    args: string[],
    opts?: { signal?: AbortSignal; timeout?: number },
  ) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
  /** Test seam: inject a stub session factory instead of importing the pi SDK at runtime. */
  createAgentSession?: (
    options?: CreateAgentSessionOptions,
  ) => Promise<{ session: StageSessionRuntime }>;
  /** Test/degraded-runtime seam: skip project/global discovery work at startup. */
  disableAsyncDiscovery?: boolean;
  // -------------------------------------------------------------------------
  // Persistence API (§5.6)
  // -------------------------------------------------------------------------
  /** Appends a typed entry to the session transcript. Returns the entry ID. */
  appendEntry?: (
    type: string,
    payload: Record<string, unknown>,
  ) => string | undefined;
  /** Labels an entry for /tree bookmark filtering. */
  setLabel?: (entryId: string, label: string) => void;
  /** Appends a synthetic system/assistant message entry. */
  appendCustomMessageEntry?: (
    content: string,
    meta?: Record<string, unknown>,
  ) => string | undefined;
  // -------------------------------------------------------------------------
  // Lifecycle events (§5.6, §8.1 Phase D)
  // -------------------------------------------------------------------------
  /** Register a listener for a pi lifecycle event (e.g. session_start, session_before_compact). */
  on?: (
    event: string,
    handler: (
      event?: unknown,
      ctx?: PiCommandContext & {
        sessionManager?: SessionManager;
        hasUI?: boolean;
      },
    ) => void | object | Promise<void | object>,
  ) => void;
  // -------------------------------------------------------------------------
  // Session manager (§5.6 restore)
  // -------------------------------------------------------------------------
  sessionManager?: SessionManager;
  ui?: {
    setWidget?: (
      key: string,
      factory: WidgetFactory | undefined,
      opts?: { placement?: string },
    ) => void;
    /**
     * Spawn a custom TUI component (overlay or inline).
     * When overlay: true, the panel floats over existing content.
     * Returns a handle with close() to dismiss, or undefined when unsupported.
     */
    custom?: PiUISurface["custom"];
  } & PiUISurface;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workflow tool argument shape
// ---------------------------------------------------------------------------

export interface WorkflowToolArgs extends StageOptions {
  /** Canonical named workflow identifier. */
  workflow?: string;
  inputs?: Record<string, unknown>;
  action?:
    | "run"
    | "list"
    | "get"
    | "status"
    | "stages"
    | "stage"
    | "transcript"
    | "send"
    | "pause"
    | "interrupt"
    | "kill"
    | "resume"
    | "reload"
    | "inputs";
  /** Canonical run identifier or unique prefix for status/interrupt/kill/resume. */
  runId?: string;
  /** Apply supported run-control actions to all in-flight runs. */
  all?: boolean;
  /** Stage id, unique prefix, or name for stage-scoped resume. */
  stageId?: string;
  /** Optional message forwarded when resuming paused work. */
  message?: string;
  statusFilter?: StageStatus | "all";
  format?: "text" | "json";
  limit?: number;
  tail?: number;
  includeToolOutput?: boolean;
  text?: string;
  response?: unknown;
  delivery?: "auto" | "answer" | "prompt" | "steer" | "followUp" | "resume";
  promptId?: string;
  reason?: string;
  /** Direct single-task mode, or root task string when chain is present. */
  task?: WorkflowDirectTaskItem | string;
  /** Direct top-level parallel mode. */
  tasks?: WorkflowDirectTaskItem[];
  /** Direct sequential/parallel chain mode. */
  chain?: WorkflowChainStep[];
  chainName?: string;
  context?: "fresh" | "fork";
  /** Internal host-derived parent session file for context:"fork". */
  forkFromSessionFile?: string;
  concurrency?: number;
  failFast?: boolean;
  async?: boolean;
  intercom?: {
    enabled?: boolean;
    delivery?: "off" | "notify" | "result" | "control-and-result";
    parentSession?: string;
    notifyOn?: Array<
      "active_long_running" | "needs_attention" | "completed" | "failed"
    >;
  };
  output?: string | false;
  outputMode?: "inline" | "file-only";
  reads?: readonly string[] | false;
  chainDir?: string;
  maxOutput?: WorkflowMaxOutput;
  artifacts?: boolean;
  worktree?: boolean;
  gitWorktreeDir?: string;
  baseBranch?: string;
}

// ---------------------------------------------------------------------------
// Tool parameter schema
// ---------------------------------------------------------------------------

const workflowParameters = WorkflowParametersSchema;

function hasDirectExecutionMode(args: WorkflowToolArgs): boolean {
  return (
    (args.task !== undefined && typeof args.task === "object") ||
    Array.isArray(args.tasks) ||
    Array.isArray(args.chain)
  );
}

function directModeCount(args: WorkflowToolArgs): number {
  return [
    args.task !== undefined && typeof args.task === "object",
    Array.isArray(args.tasks),
    Array.isArray(args.chain),
  ].filter(Boolean).length;
}

function hasNamedExecutionMode(args: WorkflowToolArgs): boolean {
  return typeof args.workflow === "string" && args.workflow.trim().length > 0;
}

function directRequestsFork(args: WorkflowToolArgs): boolean {
  if (args.context === "fork") return true;
  if (
    args.task !== undefined &&
    typeof args.task === "object" &&
    args.task.context === "fork"
  )
    return true;
  if (args.tasks?.some((task) => task.context === "fork")) return true;
  return (
    args.chain?.some((step) =>
      "parallel" in step
        ? step.parallel.some((task) => task.context === "fork")
        : step.context === "fork",
    ) ?? false
  );
}

function withForkParentSession(
  args: WorkflowToolArgs,
  ctx: PiExecuteContext,
): WorkflowToolArgs {
  if (!directRequestsFork(args) || args.forkFromSessionFile !== undefined)
    return args;
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  return typeof sessionFile === "string" && sessionFile.length > 0
    ? { ...args, forkFromSessionFile: sessionFile }
    : args;
}

function workflowRunResultFromDetails(
  details: WorkflowDetails,
): WorkflowToolResult {
  return {
    action: "run",
    name: `direct-${details.mode}`,
    runId: details.runId ?? "",
    status: details.status,
    result: details.output,
    details,
    error: details.error,
    stages: [],
  };
}

function stringifyWorkflowToolResult(result: WorkflowToolResult): string {
  return JSON.stringify(result, null, 2);
}

function compactWorkflowToolMessage(
  result: Extract<WorkflowToolResult, {
    action: "send" | "pause" | "reload" | "interrupt" | "kill" | "resume";
  }>,
): string {
  if (result.action === "reload") {
    return `${result.action}: ${result.status} — ${result.message}`;
  }
  const target = [
    result.runId,
    result.action === "send" ? result.stageId : undefined,
  ].filter((part): part is string => part !== undefined && part.length > 0)
    .join("/");
  return `${result.action}:${target ? ` ${target}` : ""} ${result.status} — ${result.message}`;
}

function renderTranscriptToolContent(
  result: Extract<WorkflowToolResult, { action: "transcript" }>,
): string {
  const lines = [
    `action: transcript`,
    `runId: ${result.runId}`,
    `stageId: ${result.stageId}`,
    `source: ${result.source}`,
    `truncated: ${result.truncated}`,
  ];
  if (result.sessionId) lines.push(`sessionId: ${result.sessionId}`);
  if (result.sessionFile) lines.push(`sessionFile: ${result.sessionFile}`);
  if (result.entries.length === 0) {
    lines.push("entries: none");
    return lines.join("\n");
  }
  lines.push("entries:");
  result.entries.forEach((entry, index) => {
    const metadata = [
      `[${index + 1}]`,
      `role=${entry.role}`,
      entry.toolName ? `tool=${entry.toolName}` : undefined,
      entry.timestamp !== undefined ? `timestamp=${entry.timestamp}` : undefined,
    ].filter((part): part is string => part !== undefined);
    lines.push(metadata.join(" "));
    if (entry.text !== undefined) lines.push(entry.text);
    if (entry.output !== undefined) {
      lines.push("tool output:");
      lines.push(entry.output);
    }
    if (entry.text === undefined && entry.output === undefined) {
      lines.push("(no body)");
    }
  });
  return lines.join("\n");
}

function renderStagesToolContent(
  result: Extract<WorkflowToolResult, { action: "stages" }>,
): string {
  const lines = [
    "action: stages",
    `runId: ${result.runId}`,
    `filter: ${result.filter}`,
  ];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.stages.length === 0) {
    lines.push("stages: none");
    return lines.join("\n");
  }
  lines.push("stages:");
  result.stages.forEach((stage, index) => {
    lines.push(`[${index + 1}] ${stage.name} (${stage.id}) ${stage.status}`);
    if (stage.sessionId) lines.push(`sessionId: ${stage.sessionId}`);
    if (stage.sessionFile) lines.push(`sessionFile: ${stage.sessionFile}`);
    if (stage.error) lines.push(`error: ${stage.error}`);
    if (stage.awaitingInputSince !== undefined) {
      lines.push(`awaitingInputSince: ${stage.awaitingInputSince}`);
    }
    if (stage.pendingPrompt !== undefined) {
      lines.push("pendingPrompt:");
      lines.push(JSON.stringify(stage.pendingPrompt, null, 2));
    }
    if (stage.inputRequest !== undefined) {
      lines.push("inputRequest:");
      lines.push(JSON.stringify(stage.inputRequest, null, 2));
    }
  });
  return lines.join("\n");
}

function renderStageToolContent(
  result: Extract<WorkflowToolResult, { action: "stage" }>,
): string {
  const lines = ["action: stage", `runId: ${result.runId}`];
  if (result.error || result.stage === undefined) {
    lines.push(`error: ${result.error ?? "stage not found"}`);
    return lines.join("\n");
  }
  lines.push("stage:");
  lines.push(JSON.stringify(result.stage, null, 2));
  return lines.join("\n");
}

function renderWorkflowToolContent(
  result: WorkflowToolResult,
  args: WorkflowToolArgs,
): string {
  if (args.format === "json") return stringifyWorkflowToolResult(result);

  switch (result.action) {
    case "transcript":
      return renderTranscriptToolContent(result);
    case "stages":
      return renderStagesToolContent(result);
    case "stage":
      return renderStageToolContent(result);
    case "send":
    case "pause":
    case "reload":
    case "interrupt":
    case "kill":
    case "resume":
      return compactWorkflowToolMessage(result);
    case "list":
    case "status":
    case "statusDetail":
    case "inputs":
    case "get":
    case "run":
      return stringifyWorkflowToolResult(result);
  }
}

function workflowGetResult(
  runtime: ExtensionRuntime,
  args: WorkflowToolArgs,
): WorkflowToolResult {
  const workflow = args.workflow ?? "";
  const def = runtime.registry.get(workflow);
  if (!def) {
    return {
      action: "get",
      workflow,
      error: `Workflow not found: "${workflow}"`,
    };
  }
  const inputs = Object.entries(def.inputs).map(([name, schema]) => ({
    name,
    type: schema.type,
    description: schema.description,
    required: schema.required,
    default: "default" in schema ? schema.default : undefined,
    choices: schema.type === "select" ? schema.choices : undefined,
  }));
  return {
    action: "get",
    workflow: def.normalizedName,
    details: {
      mode: "inspection",
      action: "get",
      status: "completed",
      output: {
        workflow: def.normalizedName,
        name: def.name,
        description: def.description,
        inputs,
      },
      progress: { completed: 0, total: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// Stage tool helpers
// ---------------------------------------------------------------------------

type WorkflowStageSummary = {
  id: string;
  name: string;
  status: StageStatus;
  sessionId?: string;
  sessionFile?: string;
  error?: string;
  awaitingInputSince?: number;
  pendingPrompt?: StageSnapshot["pendingPrompt"];
  inputRequest?: StageSnapshot["inputRequest"];
};

type WorkflowTranscriptEntry = {
  role: string;
  text?: string;
  toolName?: string;
  output?: string;
  timestamp?: number;
};

type MessageContentBlock = { readonly type?: string; readonly text?: string };
type MessageLike = {
  readonly role?: string;
  readonly content?: string | readonly MessageContentBlock[];
  readonly name?: string;
  readonly toolName?: string;
  readonly timestamp?: number;
  readonly createdAt?: number;
};

function cloneStage(stage: StageSnapshot): StageSnapshot {
  return structuredClone(stage);
}

function summarizeStage(stage: StageSnapshot): WorkflowStageSummary {
  return {
    id: stage.id,
    name: stage.name,
    status: stage.status,
    sessionId: stage.sessionId,
    sessionFile: stage.sessionFile,
    error: stage.error,
    awaitingInputSince: stage.awaitingInputSince,
    pendingPrompt: stage.pendingPrompt === undefined
      ? undefined
      : structuredClone(stage.pendingPrompt),
    inputRequest: stage.inputRequest === undefined
      ? undefined
      : structuredClone(stage.inputRequest),
  };
}

const DEFAULT_TRANSCRIPT_LIMIT = 50;

function boundedCount(args: WorkflowToolArgs): number {
  const raw = args.tail ?? args.limit;
  if (raw === undefined) return DEFAULT_TRANSCRIPT_LIMIT;
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.floor(raw);
}

function applyEntryLimit<T>(
  entries: readonly T[],
  args: WorkflowToolArgs,
): { entries: T[]; truncated: boolean } {
  const count = boundedCount(args);
  if (count === 0) {
    return { entries: [], truncated: false };
  }
  if (entries.length <= count) {
    return { entries: [...entries], truncated: false };
  }
  return { entries: entries.slice(entries.length - count), truncated: true };
}

function messageText(content: MessageLike["content"]): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  let sawTextBlock = false;
  const text = content
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        sawTextBlock = true;
        return block.text;
      }
      return "";
    })
    .join("");
  return sawTextBlock ? text : undefined;
}

function transcriptEntryFromMessage(message: MessageLike): WorkflowTranscriptEntry {
  const entry: WorkflowTranscriptEntry = { role: message.role ?? "unknown" };
  const text = messageText(message.content);
  if (text !== undefined) entry.text = text;
  const toolName = message.toolName ?? message.name;
  if (toolName !== undefined) entry.toolName = toolName;
  const timestamp = message.timestamp ?? message.createdAt;
  if (timestamp !== undefined) entry.timestamp = timestamp;
  return entry;
}

function transcriptEntriesFromToolEvents(
  events: readonly ToolEvent[],
  includeOutput: boolean,
): WorkflowTranscriptEntry[] {
  return events.map((event) => ({
    role: "tool",
    toolName: event.name,
    output: includeOutput ? event.output : undefined,
    timestamp: event.endedAt ?? event.startedAt,
  }));
}

function hasPayloadProperty(args: WorkflowToolArgs): boolean {
  return (
    args.text !== undefined ||
    args.response !== undefined ||
    args.message !== undefined
  );
}

function promptPayloadFromArgs(args: WorkflowToolArgs): unknown {
  if (args.response !== undefined) return args.response;
  if (args.text !== undefined) return args.text;
  return args.message;
}

/**
 * Shape a `send` payload into a headless answer for a brokered stage prompt
 * (ask_user_question / readiness gate). A structured `response` (object or
 * JSON string) is normalized so it matches the question's options instead of
 * being forwarded verbatim as a result that violates the QuestionnaireResult
 * contract; otherwise the plain text / message payload is matched against
 * option labels / indices by the stage prompt adapter.
 */
function brokerAnswerFromArgs(args: WorkflowToolArgs): StageInputAnswer {
  if (args.response !== undefined) {
    const coerced = coerceStageInputAnswer(args.response);
    if (hasStageInputAnswerContent(coerced)) return coerced;
  }
  const text = textPayloadFromArgs(args);
  return text !== undefined ? { text } : {};
}

function textPayloadFromArgs(args: WorkflowToolArgs): string | undefined {
  if (args.text !== undefined) return args.text;
  if (typeof args.response === "string") {
    return args.response;
  }
  if (args.message !== undefined) return args.message;
  return undefined;
}

type WorkflowSendToolResult = Extract<WorkflowToolResult, { action: "send" }>;

function workflowSendResult(
  runId: string,
  stageId: string,
  delivery: WorkflowSendToolResult["delivery"],
  status: WorkflowSendToolResult["status"],
  message: string,
): WorkflowSendToolResult {
  return { action: "send", runId, stageId, delivery, status, message };
}

function sortTranscriptEntriesChronologically(
  entries: readonly WorkflowTranscriptEntry[],
): WorkflowTranscriptEntry[] {
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const aTimestamp = a.entry.timestamp;
      const bTimestamp = b.entry.timestamp;
      if (
        typeof aTimestamp === "number" &&
        typeof bTimestamp === "number" &&
        aTimestamp !== bTimestamp
      ) {
        return aTimestamp - bTimestamp;
      }
      return a.index - b.index;
    })
    .map(({ entry }) => entry);
}

function terminalTranscriptEntry(
  role: "assistant" | "notice",
  text: string,
  endedAt: number | undefined,
): WorkflowTranscriptEntry {
  const entry: WorkflowTranscriptEntry = { role, text };
  if (endedAt !== undefined) entry.timestamp = endedAt;
  return entry;
}

function snapshotTranscriptEntries(
  snapshot: StageSnapshot | undefined,
  includeOutput: boolean,
): WorkflowTranscriptEntry[] {
  if (snapshot === undefined) return [];
  const entries: WorkflowTranscriptEntry[] = [
    ...transcriptEntriesFromToolEvents(snapshot.toolEvents ?? [], includeOutput),
  ];
  if (snapshot.result !== undefined) {
    entries.push(terminalTranscriptEntry("assistant", snapshot.result, snapshot.endedAt));
  }
  if (snapshot.error !== undefined) {
    entries.push(terminalTranscriptEntry("notice", snapshot.error, snapshot.endedAt));
  }
  return sortTranscriptEntriesChronologically(entries);
}

function formatAlreadyEndedRetainedMessage(runId: string): string {
  return `Run ${runId.slice(0, 8)} already ended; retained for inspection.`;
}

function stageFailureMessage(
  runId: string,
  resultReason: string,
  action: "pause" | "interrupt",
): string {
  switch (resultReason) {
    case "not_found":
      return `Run not found: ${runId}`;
    case "already_ended":
      return `Run already ended: ${runId}`;
    case "stage_not_found":
      return `Stage not found for run: ${runId}`;
    default:
      return `No active stages to ${action} for run: ${runId}`;
  }
}

function inFlightRunCount(): number {
  return store.runs().filter((run) => run.endedAt === undefined).length;
}

function reloadBlockedMessage(count = inFlightRunCount()): string {
  return `Reload skipped: ${count} workflow run(s) still in flight. Wait for them to finish, or pause/kill them before reloading workflow resources.`;
}

function allStageConflictMessage(action: "pause" | "interrupt" | "kill"): string {
  return `Cannot ${action} --all with a stageId; omit stageId or target a single run.`;
}

class WorkflowReloadBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowReloadBlockedError";
  }
}

function reloadFailureMessage(error: unknown): string {
  if (error instanceof WorkflowReloadBlockedError) return error.message;
  return `Reload failed: ${error instanceof Error ? error.message : String(error)}`;
}

function hasWorkflowStageSubagentGuardEnv(): boolean {
  return getEnvValue(WORKFLOW_STAGE_SUBAGENT_GUARD_ENV) === "1";
}

function isWorkflowStageToolContext(ctx: PiExecuteContext): boolean {
  return hasWorkflowStageSubagentGuardEnv() || ctx.orchestrationContext?.kind === "workflow-stage";
}

/**
 * Legacy message retained for consumers that imported the old refusal string.
 * Non-interactive sessions now keep the workflow tool and `/workflow` command
 * available; policy gates only interactive pickers and human-input workflows.
 */
export const WORKFLOW_NON_INTERACTIVE_MESSAGE =
  "Workflows are policy-gated in non-interactive (-p) mode; deterministic non-HiL workflows can run headlessly.";

export function workflowPolicyFromContext(ctx?: { readonly hasUI?: boolean }): WorkflowExecutionPolicy {
  if (ctx?.hasUI === false) {
    return NON_INTERACTIVE_WORKFLOW_POLICY;
  }
  return INTERACTIVE_WORKFLOW_POLICY;
}

function isRunStatus(value: string): value is RunStatus {
  switch (value) {
    case "pending":
    case "running":
    case "paused":
    case "completed":
    case "failed":
    case "killed":
      return true;
    default:
      return false;
  }
}

function fallbackRunDetailFromResult(
  workflowName: string,
  inputs: Readonly<Record<string, unknown>>,
  result: Extract<WorkflowToolResult, { action: "run"; runId: string }>,
): RunDetail {
  const now = Date.now();
  const stages = result.stages?.map((stage) => structuredClone(stage)) ?? [];
  // This path is a degraded last-resort view used only when the retained run
  // snapshot has disappeared before output rendering. Timestamps are synthetic,
  // so prefer a conservative failed status over fabricating success if the tool
  // result status is not one of the known run states.
  return {
    runId: result.runId,
    name: result.name ?? workflowName,
    status: isRunStatus(result.status) ? result.status : "failed",
    mode: stages.length > 1 ? "chain" : "single",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    inputs,
    stages,
    result: result.result,
    error: result.error,
  };
}

function emitTerminalRunDetailSurface(
  pi: ExtensionAPI,
  workflowName: string,
  inputs: Readonly<Record<string, unknown>>,
  result: Extract<WorkflowToolResult, { action: "run"; runId: string }>,
): void {
  const inspected = inspectRun(result.runId);
  const detail = inspected.ok
    ? inspected.detail
    : fallbackRunDetailFromResult(workflowName, inputs, result);
  emitChatSurface(
    pi,
    { kind: "detail", detail },
    { content: renderRunDetail(detail, { width: 100 }) },
  );
}

export const WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE = "workflows:command-output";

interface WorkflowCommandOutputDetails {
  readonly command: string;
  readonly workflowName?: string;
}

function emitWorkflowCommandOutput(
  pi: ExtensionAPI,
  content: string,
  details: WorkflowCommandOutputDetails,
): void {
  if (typeof pi.sendMessage !== "function") return;
  void pi.sendMessage<WorkflowCommandOutputDetails>({
    customType: WORKFLOW_COMMAND_OUTPUT_CUSTOM_TYPE,
    content,
    display: true,
    details,
  });
}

interface WorkflowCommandReporter {
  info(message: string): void;
  error(message: string): void;
}

function formatAvailableWorkflowNames(names: readonly string[]): string {
  return names.length > 0 ? names.join(", ") : "(none)";
}

const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

function deAdvertiseAskUserQuestionWhenHeadless(
  pi: ExtensionAPI,
  hasUI: boolean | undefined,
): void {
  if (hasUI !== false) return;
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;

  const activeTools = pi.getActiveTools();
  if (!activeTools.includes(ASK_USER_QUESTION_TOOL_NAME)) return;

  pi.setActiveTools(activeTools.filter((toolName) => toolName !== ASK_USER_QUESTION_TOOL_NAME));
}

class WorkflowHeadlessCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowHeadlessCommandError";
  }
}

function createWorkflowCommandReporter(
  ctx: PiCommandContext,
  policy: WorkflowExecutionPolicy = workflowPolicyFromContext(ctx),
  pi?: ExtensionAPI,
): WorkflowCommandReporter {
  return {
    info(message: string): void {
      if (policy.mode === "non_interactive") {
        if (pi) {
          emitWorkflowCommandOutput(pi, message, { command: "message" });
        }
        return;
      }
      ctx.ui.notify(message, "info");
    },
    error(message: string): void {
      if (policy.mode === "non_interactive") {
        throw new WorkflowHeadlessCommandError(message);
      }
      ctx.ui.notify(message, "error");
    },
  };
}

// ---------------------------------------------------------------------------
// Tool execute — dispatch with real registry for list/inputs/run (Phase E)
//                + real status/interrupt/resume (Phase D)
// ---------------------------------------------------------------------------

export function makeExecuteWorkflowTool(
  runtime: ExtensionRuntime | ((ctx: PiExecuteContext) => ExtensionRuntime),
  getPersistence: () => WorkflowPersistencePort | undefined,
  reloadWorkflowResources: () => Promise<void> | void,
) {
  return async function executeWorkflowTool(
    args: WorkflowToolArgs,
    ctx: PiExecuteContext,
  ): Promise<WorkflowToolResult> {
    const action = args.action ?? "run";
    const runId = args.runId ?? "";
    if (isWorkflowStageToolContext(ctx)) {
      // Workflow stages must not invoke the workflow tool at all, including
      // read-only inspection actions. The tool is normally excluded from stage
      // sessions; this guard is a defense-in-depth fallback for stale or
      // hand-crafted registrations.
      return {
        action: "run",
        runId,
        status: "failed",
        error: "workflows cannot invoke workflows from workflow stages",
        stages: [],
      };
    }
    const activeRuntime =
      typeof runtime === "function" ? runtime(ctx) : runtime;
    const policy = workflowPolicyFromContext(ctx);

    switch (action) {
      case "get":
        return workflowGetResult(activeRuntime, args);

      case "list":
      case "inputs":
      case "run":
        if (action === "run" && hasDirectExecutionMode(args)) {
          const normalModeCount =
            directModeCount(args) + (hasNamedExecutionMode(args) ? 1 : 0);
          if (normalModeCount !== 1) {
            throw new Error(
              "Workflow extension: specify exactly one normal execution mode: workflow, task, tasks, or chain",
            );
          }
          const details = await activeRuntime.runDirect(
            withForkParentSession(args, ctx),
            { policy },
          );
          return workflowRunResultFromDetails(details);
        }
        // Delegate to registry-backed dispatcher.
        // Real errors propagate — no broad catch.
        return activeRuntime.dispatch(args, { policy });

      case "status": {
        // Detail mode — single-run lookup via id.
        const target = args.runId;
        if (target !== undefined) {
          const result = inspectRun(target);
          if (result.ok) {
            return {
              action: "statusDetail",
              runId: result.runId,
              detail: result.detail,
            };
          }
          return {
            action: "statusDetail",
            runId: target,
            error: `run not found: ${target}`,
          };
        }
        // List mode — emit all retained snapshots; the renderer produces the
        // canonical band + card surface.
        const snapshots = store.runs();
        return {
          action: "status",
          snapshots: snapshots.map((snapshot) => structuredClone(snapshot)),
        };
      }

      case "stages": {
        const target = resolveToolRunTarget(args, "No active run to inspect.");
        const filter = args.statusFilter ?? "all";
        if (target.kind === "all") {
          return {
            action: "stages",
            runId: "--all",
            filter,
            stages: [],
            error: "Stage listing requires a single run.",
          };
        }
        if (target.kind === "ambiguous") {
          return {
            action: "stages",
            runId: target.target,
            filter,
            stages: [],
            error: ambiguousRunMessage(target.target, target.matches),
          };
        }
        if (target.kind === "not_found") {
          return {
            action: "stages",
            runId: target.target,
            filter,
            stages: [],
            error: target.message,
          };
        }
        const run = store.runs().find((r) => r.id === target.runId);
        const stages = (run?.stages ?? [])
          .filter((stage) => filter === "all" || stage.status === filter)
          .map(summarizeStage);
        return { action: "stages", runId: target.runId, filter, stages };
      }

      case "stage": {
        const target = resolveToolRunTarget(args, "No active run to inspect.");
        if (target.kind === "all") {
          return {
            action: "stage",
            runId: "--all",
            error: "Stage inspection requires a single run.",
          };
        }
        if (target.kind === "ambiguous") {
          return {
            action: "stage",
            runId: target.target,
            error: ambiguousRunMessage(target.target, target.matches),
          };
        }
        if (target.kind === "not_found") {
          return {
            action: "stage",
            runId: target.target,
            error: target.message,
          };
        }
        const stage = resolveToolStageTarget(target.runId, args.stageId);
        if (!stage.ok || stage.stageId === undefined) {
          return {
            action: "stage",
            runId: target.runId,
            error: stage.ok
              ? "Stage id, prefix, or name is required."
              : stage.message,
          };
        }
        const run = store.runs().find((r) => r.id === target.runId);
        const snapshot = run?.stages.find((s) => s.id === stage.stageId);
        return snapshot
          ? { action: "stage", runId: target.runId, stage: cloneStage(snapshot) }
          : {
              action: "stage",
              runId: target.runId,
              error: `Stage not found in run ${target.runId.slice(0, 8)}: ${stage.stageId}`,
            };
      }

      case "transcript": {
        const target = resolveToolRunTarget(args, "No active run to inspect.");
        if (target.kind === "all") {
          return {
            action: "transcript",
            runId: "--all",
            stageId: "",
            source: "error",
            entries: [],
            truncated: false,
          };
        }
        if (target.kind === "ambiguous") {
          return {
            action: "transcript",
            runId: target.target,
            stageId: "",
            source: "error",
            entries: [
              { role: "notice", text: ambiguousRunMessage(target.target, target.matches) },
            ],
            truncated: false,
          };
        }
        if (target.kind === "not_found") {
          return {
            action: "transcript",
            runId: target.target,
            stageId: "",
            source: "error",
            entries: [{ role: "notice", text: target.message }],
            truncated: false,
          };
        }
        const stage = resolveToolStageTarget(target.runId, args.stageId);
        if (!stage.ok || stage.stageId === undefined) {
          return {
            action: "transcript",
            runId: target.runId,
            stageId: "",
            source: "error",
            entries: [
              {
                role: "notice",
                text: stage.ok
                  ? "Stage id, prefix, or name is required."
                  : stage.message,
              },
            ],
            truncated: false,
          };
        }
        const run = store.runs().find((r) => r.id === target.runId);
        const snapshot = run?.stages.find((s) => s.id === stage.stageId);
        const liveHandle = stageControlRegistry.get(target.runId, stage.stageId);
        if (liveHandle !== undefined) {
          const limited = applyEntryLimit(
            liveHandle.messages.map((m) => transcriptEntryFromMessage(m as MessageLike)),
            args,
          );
          return {
            action: "transcript",
            runId: target.runId,
            stageId: stage.stageId,
            source: "live",
            entries: limited.entries,
            truncated: limited.truncated,
            sessionId: liveHandle.sessionId,
            sessionFile: liveHandle.sessionFile,
          };
        }
        const fallback = snapshotTranscriptEntries(snapshot, args.includeToolOutput === true);
        const limited = applyEntryLimit(fallback, args);
        return {
          action: "transcript",
          runId: target.runId,
          stageId: stage.stageId,
          source: "snapshot",
          entries: limited.entries,
          truncated: limited.truncated,
          sessionId: snapshot?.sessionId,
          sessionFile: snapshot?.sessionFile,
        };
      }

      case "send": {
        const target = resolveToolRunTarget(args, "No active run to message.");
        const requestedDelivery = args.delivery ?? "auto";
        if (target.kind === "all") {
          return workflowSendResult("--all", "", requestedDelivery, "noop", "Send requires a single run.");
        }
        if (target.kind === "ambiguous") {
          return workflowSendResult(target.target, "", requestedDelivery, "noop", ambiguousRunMessage(target.target, target.matches));
        }
        if (target.kind === "not_found") {
          return workflowSendResult(target.target, "", requestedDelivery, "noop", target.message);
        }
        const stage = resolveToolStageTarget(target.runId, args.stageId);
        if (!stage.ok || stage.stageId === undefined) {
          return workflowSendResult(
            target.runId,
            "",
            requestedDelivery,
            "noop",
            stage.ok ? "Stage id, prefix, or name is required." : stage.message,
          );
        }
        const run = store.runs().find((r) => r.id === target.runId);
        const snapshot = run?.stages.find((s) => s.id === stage.stageId);
        // Brokered structured prompts (in-stage ask_user_question / readiness
        // gate) resolve through StageUiBroker rather than store.pendingPrompt.
        // Answer those first when one is pending and the promptId (if any) lines
        // up — otherwise fall through to the store-prompt / live-handle paths.
        const brokerPrompt = stageUiBroker.peekStagePrompt(target.runId, stage.stageId);
        const targetsBrokerPrompt =
          brokerPrompt !== undefined &&
          (args.promptId === undefined || args.promptId === brokerPrompt.id) &&
          (requestedDelivery === "answer" ||
            args.promptId !== undefined ||
            requestedDelivery === "auto");
        if (targetsBrokerPrompt && brokerPrompt !== undefined) {
          if (!hasPayloadProperty(args)) {
            return workflowSendResult(target.runId, stage.stageId, "answer", "noop", "Send requires text, response, or message.");
          }
          const ok = stageUiBroker.answerStagePrompt(target.runId, stage.stageId, brokerAnswerFromArgs(args), {
            answerSource: "workflow_tool",
          });
          return workflowSendResult(
            target.runId,
            stage.stageId,
            "answer",
            ok ? "ok" : "noop",
            ok ? `Answered input request ${brokerPrompt.id}.` : `No matching pending input request ${brokerPrompt.id}.`,
          );
        }
        const targetsPrompt =
          requestedDelivery === "answer" ||
          args.promptId !== undefined ||
          (requestedDelivery === "auto" && snapshot?.pendingPrompt !== undefined);
        if (targetsPrompt) {
          const promptId = args.promptId ?? snapshot?.pendingPrompt?.id;
          if (promptId === undefined) {
            return workflowSendResult(target.runId, stage.stageId, "answer", "noop", "No pending prompt to answer.");
          }
          if (!hasPayloadProperty(args)) {
            return workflowSendResult(target.runId, stage.stageId, "answer", "noop", "Send requires text, response, or message.");
          }
          if (stageUiBroker.wasStagePromptResolved(target.runId, stage.stageId, promptId)) {
            return workflowSendResult(
              target.runId,
              stage.stageId,
              "answer",
              "ok",
              `Input request ${promptId} was already answered.`,
            );
          }
          const ok = store.resolveStagePendingPrompt(target.runId, stage.stageId, promptId, promptPayloadFromArgs(args), {
            answerSource: "workflow_tool",
          });
          return workflowSendResult(
            target.runId,
            stage.stageId,
            "answer",
            ok ? "ok" : "noop",
            ok ? `Answered prompt ${promptId}.` : `No matching pending prompt ${promptId}.`,
          );
        }
        const text = textPayloadFromArgs(args);
        if (text === undefined) {
          return workflowSendResult(target.runId, stage.stageId, requestedDelivery, "noop", "Send requires text, response, or message.");
        }
        const handle = stageControlRegistry.get(target.runId, stage.stageId);
        if (handle === undefined) {
          return workflowSendResult(target.runId, stage.stageId, requestedDelivery, "noop", "No live handle for stage.");
        }
        if (requestedDelivery === "resume" || (requestedDelivery === "auto" && handle.status === "paused")) {
          await handle.resume(text);
          return workflowSendResult(target.runId, stage.stageId, "resume", "ok", "Resumed stage with message.");
        }
        if (requestedDelivery === "steer" || (requestedDelivery === "auto" && handle.isStreaming)) {
          await handle.steer(text);
          return workflowSendResult(target.runId, stage.stageId, "steer", "ok", "Steered live stage.");
        }
        if (requestedDelivery === "prompt") {
          await handle.prompt(text);
          return workflowSendResult(target.runId, stage.stageId, "prompt", "ok", "Prompt sent to stage.");
        }
        await handle.followUp(text);
        return workflowSendResult(target.runId, stage.stageId, "followUp", "ok", "Follow-up queued for stage.");
      }

      case "pause": {
        const target = resolveToolRunTarget(args, "No in-flight runs to pause.");
        if (target.kind === "all") {
          if (args.stageId !== undefined && args.stageId.length > 0) {
            return {
              action,
              runId: "--all",
              status: "noop",
              message: allStageConflictMessage("pause"),
            };
          }
          const results = pauseAllRuns();
          const paused = results.filter((r) => r.ok).length;
          return {
            action,
            runId: "--all",
            status: paused > 0 ? "paused" : "noop",
            message: paused > 0
              ? `Paused ${paused} run(s).`
              : "No in-flight runs to pause.",
          };
        }
        if (target.kind === "ambiguous") return { action, runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
        if (target.kind === "not_found") return { action, runId: target.target, status: "noop", message: target.message };
        const stage = resolveToolStageTarget(target.runId, args.stageId);
        if (!stage.ok) return { action, runId: target.runId, status: "noop", message: stage.message };
        const result = pauseRun(target.runId, { stageId: stage.stageId });
        return result.ok
          ? { action, runId: result.runId, status: "paused", message: `Paused ${result.paused.length} stage(s) on run ${result.runId.slice(0, 8)}.` }
          : {
              action,
              runId: target.runId,
              status: "noop",
              message: stageFailureMessage(target.runId, result.reason, "pause"),
            };
      }

      case "reload": {
        // Fast UX check; reloadWorkflowResourcesNow re-checks inside the
        // serialized reload queue and remains the authoritative TOCTOU guard.
        const activeRuns = inFlightRunCount();
        if (activeRuns > 0) {
          return {
            action: "reload",
            status: "noop",
            message: reloadBlockedMessage(activeRuns),
          };
        }
        try {
          await reloadWorkflowResources();
        } catch (error) {
          return {
            action: "reload",
            status: "noop",
            message: reloadFailureMessage(error),
          };
        }
        return {
          action: "reload",
          status: "ok",
          message: args.reason?.trim()
            ? `Reloaded workflow resources (${args.reason.trim()}).`
            : "Reloaded workflow resources.",
        };
      }

      case "kill": {
        const target = resolveToolRunTarget(args, "No in-flight runs to kill.");
        if (target.kind === "all") {
          if (args.stageId !== undefined && args.stageId.length > 0) {
            return {
              action,
              runId: "--all",
              status: "noop",
              message: allStageConflictMessage("kill"),
            };
          }
          const results = killAllRuns({
            cancellation: cancellationRegistry,
            persistence: getPersistence(),
          });
          const killed = results.filter((r) => r.ok).length;
          return {
            action,
            runId: "--all",
            status: killed > 0 ? "killed" : "noop",
            message:
              killed > 0
                ? `Killed and retained ${killed} run(s) for inspection.`
                : "No in-flight runs to kill.",
          };
        }
        if (target.kind === "ambiguous") {
          return { action, runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
        }
        if (target.kind === "not_found") {
          return { action, runId: target.target, status: "noop", message: target.message };
        }
        const result = killRun(target.runId, {
          cancellation: cancellationRegistry,
          persistence: getPersistence(),
        });
        if (result.ok) {
          return {
            action,
            runId: result.runId,
            status: "killed",
            message: `Run ${result.runId} killed and retained for inspection (was ${result.previousStatus}).`,
          };
        }
        return {
          action,
          runId: target.runId,
          status: "noop",
          message: result.reason === "already_ended"
            ? formatAlreadyEndedRetainedMessage(target.runId)
            // Defensive fallback: resolveRunTarget already found this run, and killRun no longer removes runs.
            : `Run not found: ${target.runId}`,
        };
      }

      case "interrupt": {
        // Interrupt is resumable: it pauses live work and keeps runs in history/status.
        const target = resolveToolRunTarget(args, "No in-flight runs to interrupt.");
        if (target.kind === "all") {
          if (args.stageId !== undefined && args.stageId.length > 0) {
            return {
              action,
              runId: "--all",
              status: "noop",
              message: allStageConflictMessage("interrupt"),
            };
          }
          const results = interruptAllRuns();
          const interrupted = results.filter((r) => r.ok).length;
          return {
            action,
            runId: "--all",
            status: interrupted > 0 ? "paused" : "noop",
            message:
              interrupted > 0
                ? `Interrupted ${interrupted} run(s).`
                : "No in-flight runs to interrupt.",
          };
        }
        if (target.kind === "ambiguous") {
          return { action, runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
        }
        if (target.kind === "not_found") {
          return { action, runId: target.target, status: "noop", message: target.message };
        }
        const stage = resolveToolStageTarget(target.runId, args.stageId);
        if (!stage.ok) {
          return { action, runId: target.runId, status: "noop", message: stage.message };
        }
        const result = interruptRun(target.runId, { stageId: stage.stageId });
        if (result.ok) {
          return {
            action,
            runId: result.runId,
            status: "paused",
            message: stage.stageId
              ? `Stage ${stage.stageId} interrupted on run ${result.runId} and can be resumed.`
              : `Run ${result.runId} interrupted and can be resumed.`,
          };
        }
        return {
          action,
          runId: target.runId,
          status: "noop",
          message: stageFailureMessage(target.runId, result.reason, "interrupt"),
        };
      }

      case "resume": {
        const target = resolveToolRunTarget(args, "No active run to resume.");
        if (target.kind === "all") {
          return { action: "resume", runId: "--all", status: "noop", message: "Resume does not support --all." };
        }
        if (target.kind === "ambiguous") {
          return { action: "resume", runId: target.target, status: "noop", message: ambiguousRunMessage(target.target, target.matches) };
        }
        if (target.kind === "not_found") {
          return { action: "resume", runId: target.target, status: "noop", message: target.message };
        }
        const stage = resolveToolStageTarget(target.runId, args.stageId);
        if (!stage.ok) {
          return { action: "resume", runId: target.runId, status: "noop", message: stage.message };
        }
        const run = store.runs().find((r) => r.id === target.runId);
        const isPaused =
          run?.status === "paused" ||
          (run?.stages.some((s) => s.status === "paused") ?? false);
        if (!isPaused && run?.status === "failed" && run.endedAt !== undefined && run.resumable !== false) {
          const continuation = activeRuntime.resumeFailedRun(target.runId, stage.stageId, { policy });
          return {
            action: "resume",
            runId: continuation.ok ? continuation.runId : target.runId,
            status: continuation.ok ? "running" : "noop",
            message: continuation.message,
          };
        }
        const result = resumeRun(target.runId, { stageId: stage.stageId, message: args.message });
        if (result.ok) {
          const message = result.message ?? (isPaused
            ? result.resumed.length === 0
              ? `No paused stages on run ${result.runId.slice(0, 8)}.`
              : `Resumed ${result.resumed.length} stage(s) on run ${result.runId.slice(0, 8)}${args.message ? ` with message: "${args.message}"` : ""}.`
            : `Snapshot available: run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`);
          return {
            action: "resume",
            runId: result.runId,
            status: "ok",
            message,
          };
        }
        return {
          action: "resume",
          runId: target.runId,
          status: "noop",
          message: `Run not found: ${target.runId}`,
        };
      }

      default: {
        // Exhaustive — all action variants handled above.
        const _exhaustive: never = action;
        throw new Error(`Workflow extension: unknown action "${_exhaustive}"`);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Slash command helpers
// ---------------------------------------------------------------------------

/**
 * Local registry of workflow command (name → handler). Populated by
 * `registerWorkflowCommand` alongside the host registration so the
 * `on("input", …)` interceptor below can dispatch our commands directly
 * — bypassing pi's optimistic `startPendingSubmission` flow which
 * fires the `Working… (esc to interrupt)` loader before the host knows
 * the input is a synchronous picker/connect UI, not a streaming turn.
 *
 * See `installInputInterceptor()` for the dispatch path and rationale.
 */
type WorkflowCommandHandler = PiCommandOptions["handler"];

interface ParsedWorkflowSlashCommand {
  name: string;
  args: string;
}

function parseWorkflowSlashCommand(text: string): ParsedWorkflowSlashCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return undefined;

  // First token (after `/`) is the command name. Whitespace splits
  // command from args; quote handling lives inside the command
  // handler itself (`tokenizeWorkflowArgs`).
  const firstSpace = trimmed.indexOf(" ");
  const name =
    firstSpace === -1 ? trimmed.slice(1) : trimmed.slice(1, firstSpace);
  const args = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1);

  return { name, args };
}

/**
 * Register a slash command with the host AND remember the handler so
 * the input interceptor can dispatch directly.
 *
 * `pi.registerCommand` is the sole supported registration surface
 * (mirrors pi's `ExtensionAPI.registerCommand`). When the host
 * lacks `registerCommand` (degraded runtime — RPC mode, headless, or a
 * mock that didn't stub it) we still populate the registry so the
 * input interceptor can intercept the command text the user typed.
 *
 * We forward to `pi.registerCommand` first so any host-side wrapping
 * (telemetry, logging, sandboxing) of `options.handler` lands in the
 * registry; the input interceptor then dispatches the same callable
 * the host would dispatch from `session.prompt`.
 */
function registerWorkflowCommand(
  pi: ExtensionAPI,
  name: string,
  options: PiCommandOptions,
  registry: Map<string, WorkflowCommandHandler>,
): void {
  pi.registerCommand?.(name, options);
  registry.set(name, options.handler);
}

/**
 * Install an `on("input", …)` interceptor that short-circuits the host
 * submission pipeline for our registered workflow commands.
 *
 * Why this exists
 * ---------------
 * pi's editor `onSubmit` handler unconditionally calls
 * `startPendingSubmission` for any text that isn't a built-in slash /
 * skill / bash / python command — this echoes the message into chat
 * scrollback AND starts the `Working… (esc to interrupt)` loader in
 * `statusContainer` before `session.prompt` even runs. The loader is
 * an optimistic affordance for the agent-streaming case; for our
 * synchronous picker/connect UIs (`/workflow connect`, `/workflow run`,
 * `/workflow pause`, …) it's noise — the
 * spinner sits above the picker until the handler returns.
 *
 * `runner.emitInput` runs BEFORE `startPendingSubmission` (see
 * `packages/coding-agent/src/modes/controllers/input-controller.ts`
 * `setupEditorSubmitHandler`). Returning `{ action: "handled" }` from an
 * `on("input", …)` handler short-circuits the function: the host
 * clears the editor and returns without echoing or starting the
 * loader. We dispatch the command handler ourselves with the same
 * context the host would have passed.
 *
 * Shape note: pi's `InputEventResult` is `{ action: "continue" } |
 * { action: "transform"; text; images? } | { action: "handled" }`. The
 * older `{ handled: true }` shape is silently ignored by the runner
 * (`result?.action === "handled"` check), which lets the loader fire.
 *
 * cross-ref:
 *   - pi docs/extensions.md (input event)
 *   - pi docs/slash-command-internals.md (#tryExecuteExtensionCommand)
 *   - pi packages/coding-agent/src/modes/interactive-mode.ts
 *     `startPendingSubmission` / `ensureLoadingAnimation`
 */
function installInputInterceptor(
  pi: ExtensionAPI,
  commands: Map<string, WorkflowCommandHandler>,
): void {
  if (typeof pi.on !== "function") return;

  pi.on("input", async (event, ctx) => {
    const text = (event as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") return undefined;
    const parsedCommand = parseWorkflowSlashCommand(text);
    if (!parsedCommand) return undefined;

    const { name, args } = parsedCommand;
    const handler = commands.get(name);
    if (!handler) return undefined; // not ours — let host run its normal flow.
    const commandCtx = ctx as PiCommandContext;
    try {
      await handler(args, commandCtx);
    } catch (err) {
      if (commandCtx.hasUI === false) {
        throw err;
      }
      // Match the host command runner for interactive contexts: swallow
      // handler exceptions so a throw never bubbles out and crashes the
      // editor submit pipeline. Surface the failure via `ctx.ui.notify` so
      // the user sees it. Headless contexts rethrow above because notify is
      // a no-op in print mode and would otherwise hide command failures.
      const message = err instanceof Error ? err.message : String(err);
      commandCtx.ui.notify(`/${name} failed: ${message}`, "error");
    }
    return { action: "handled" };
  });
}

function formatStartupDiagnostics(
  configResult: ConfigLoadResult | null,
  discoveryResult: DiscoveryResult | null,
): string | null {
  const lines: string[] = [];
  for (const diagnostic of configResult?.diagnostics ?? []) {
    lines.push(`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? "workflow config"}: ${diagnostic.message}`);
  }
  for (const diagnostic of discoveryResult?.errors ?? []) {
    lines.push(`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? "workflow discovery"}: ${diagnostic.message}`);
  }

  if (lines.length === 0) return null;

  const maxVisible = 8;
  const visible = lines.slice(0, maxVisible);
  const remaining = lines.length - visible.length;
  return [
    `Workflow discovery diagnostics (${lines.length}): some workflow resources were skipped or need attention.`,
    ...visible,
    ...(remaining > 0 ? [`- … ${remaining} more`] : []),
  ].join("\n");
}

/**
 * Resolve a user-supplied run identifier (full UUID or unique prefix) to
 * a concrete runId. The widget surfaces an 8-char prefix to keep the
 * status line scannable; users copy that prefix straight into the interrupt
 * slash command, so prefix matching is the expected affordance.
 */
type RunIdResolution =
  | { kind: "exact"; runId: string }
  | { kind: "ambiguous"; matches: string[] }
  | { kind: "not_found" };

function resolveRunIdPrefix(target: string): RunIdResolution {
  const runs = store.runs();
  const exact = runs.find((r) => r.id === target);
  if (exact) return { kind: "exact", runId: exact.id };

  const prefixed = runs.filter((r) => r.id.startsWith(target));
  if (prefixed.length === 0) return { kind: "not_found" };
  if (prefixed.length === 1) return { kind: "exact", runId: prefixed[0]!.id };
  return { kind: "ambiguous", matches: prefixed.map((r) => r.id) };
}

type ToolRunTarget =
  | { kind: "all" }
  | { kind: "run"; runId: string }
  | { kind: "ambiguous"; target: string; matches: string[] }
  | { kind: "not_found"; target: string; message: string };

function resolveToolRunTarget(
  args: WorkflowToolArgs,
  emptyMessage: string,
): ToolRunTarget {
  const rawTarget = args.runId?.trim() ?? "";
  if (args.all === true || rawTarget === "--all") return { kind: "all" };

  const target = rawTarget || store.activeRunId() || "";
  if (!target) return { kind: "not_found", target: rawTarget, message: emptyMessage };

  const resolved = resolveRunIdPrefix(target);
  if (resolved.kind === "exact") return { kind: "run", runId: resolved.runId };
  if (resolved.kind === "ambiguous") {
    return { kind: "ambiguous", target, matches: resolved.matches };
  }
  return { kind: "not_found", target, message: `Run not found: ${target}` };
}

type ToolStageTarget =
  | { ok: true; stageId?: string }
  | { ok: false; message: string };

function stageMatchesIdentifier(stage: { readonly id: string; readonly name: string }, target: string): boolean {
  return stage.id === target || stage.name === target || stage.id.startsWith(target);
}

function stageMatchLabel(stage: { readonly id: string; readonly name: string }): string {
  return `${stage.name} (${stage.id.slice(0, 12)})`;
}

function resolveStageTarget(runId: string, stageTarget?: string): ToolStageTarget {
  const target = stageTarget?.trim();
  if (!target) return { ok: true };

  const run = store.runs().find((r) => r.id === runId);
  const exactId = run?.stages.find((stage) => stage.id === target);
  if (exactId !== undefined) return { ok: true, stageId: exactId.id };

  const exactNames = run?.stages.filter((stage) => stage.name === target) ?? [];
  if (exactNames.length === 1) return { ok: true, stageId: exactNames[0]!.id };
  if (exactNames.length > 1) return { ok: false, message: `Ambiguous stage identifier "${target}" matches: ${exactNames.map(stageMatchLabel).join(", ")}` };

  const matches = run?.stages.filter((stage) => stageMatchesIdentifier(stage, target)) ?? [];
  if (matches.length === 0) return { ok: false, message: `Stage not found in run ${runId.slice(0, 8)}: ${target}` };
  if (matches.length > 1) return { ok: false, message: `Ambiguous stage identifier "${target}" matches: ${matches.map(stageMatchLabel).join(", ")}` };
  return { ok: true, stageId: matches[0]!.id };
}

function resolveToolStageTarget(runId: string, stageTarget?: string): ToolStageTarget {
  return resolveStageTarget(runId, stageTarget);
}

function ambiguousRunMessage(target: string, matches: readonly string[]): string {
  return `Ambiguous run prefix "${target}" matches: ${matches
    .map((id) => id.slice(0, 12))
    .join(", ")}`;
}

function overlaySurfaceFromContext(ctx?: {
  ui?: PiUISurface;
}): OverlayPiSurface | undefined {
  // Only forward `ctx.ui` to the overlay adapter when it actually
  // carries the `custom` mount surface. Inline pickers (replace-editor)
  // hand us a print-only `ui.notify` which would otherwise shadow
  // `pi.ui` inside the adapter and short-circuit the open.
  return typeof ctx?.ui?.custom === "function" ? { ui: ctx.ui } : undefined;
}

/**
 * Strip the clack-style `--yes` / `-y` confirmation skip flag from a token
 * list. Used by `/workflow interrupt` and `/workflow kill` to skip the confirmation overlay.
 */
export function stripYesFlag(tokens: string[]): {
  tokens: string[];
  yes: boolean;
} {
  const yes = tokens.some((t) => t === "--yes" || t === "-y");
  return { tokens: tokens.filter((t) => t !== "--yes" && t !== "-y"), yes };
}

/**
 * Shell-aware split for `/workflow <name> [args…]` chat tokens.
 *
 * `prompt="map the codebase"` is one token, not three. Both single and
 * double quotes are honoured; the quote characters themselves are kept
 * inside the token so {@link parseWorkflowArgs} can `JSON.parse` the
 * value and the wrapping quotes coerce it back to a plain string.
 * Backslash-escaping is **not** supported — workflow inputs are short,
 * the picker overlay is always available as a fallback for anything
 * exotic, and the simpler grammar matches what users type in shells.
 *
 * An unterminated quote is treated as if a closing quote sat at EOL —
 * we never throw on user input mid-stream; the parser downstream sees
 * a partial JSON literal and falls back to keeping it as a string.
 */
export function tokenizeWorkflowArgs(args: string): string[] {
  const tokens: string[] = [];
  let buf = "";
  let quote: '"' | "'" | undefined;
  let hasBuf = false;
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!;
    if (quote !== undefined) {
      buf += ch;
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      buf += ch;
      hasBuf = true;
      quote = ch;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (hasBuf) {
        tokens.push(buf);
        buf = "";
        hasBuf = false;
      }
      continue;
    }
    buf += ch;
    hasBuf = true;
  }
  if (hasBuf) tokens.push(buf);
  return tokens;
}

/**
 * Parse remaining args tokens as key=value pairs.
 * Tokens matching `key=value` are split on the first `=`.
 * Tokens that are standalone valid JSON objects/arrays are merged in.
 * All other tokens are ignored (non-kv positional args not supported).
 */
export function parseWorkflowArgs(tokens: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const token of tokens) {
    // Try JSON object/array merge
    if (
      (token.startsWith("{") && token.endsWith("}")) ||
      (token.startsWith("[") && token.endsWith("]"))
    ) {
      try {
        const parsed = JSON.parse(token) as unknown;
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed)
        ) {
          Object.assign(result, parsed as Record<string, unknown>);
        }
        continue;
      } catch {
        // not valid JSON — fall through to kv parse
      }
    }
    // key=value
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx);
      const raw = token.slice(eqIdx + 1);
      // Try to parse value as JSON for typed values (numbers, booleans, objects)
      let value: unknown = raw;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        // keep as string
      }
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistence port builder
// ---------------------------------------------------------------------------

/**
 * Build a WorkflowPersistencePort from the pi ExtensionAPI when persistence
 * is enabled. Returns undefined when:
 *   - persistRuns is false, OR
 *   - pi.appendEntry is absent (older pi runtime without persistence API).
 */
export function makePersistencePort(
  pi: ExtensionAPI,
  persistRuns: boolean,
): WorkflowPersistencePort | undefined {
  if (!persistRuns) return undefined;
  if (typeof pi.appendEntry !== "function") return undefined;

  const port: WorkflowPersistencePort = {
    appendEntry: (type, payload) => pi.appendEntry!(type, payload),
  };
  if (typeof pi.setLabel === "function") {
    port.setLabel = (entryId, label) => pi.setLabel!(entryId, label);
  }
  if (typeof pi.appendCustomMessageEntry === "function") {
    port.appendCustomMessageEntry = (content, meta) =>
      pi.appendCustomMessageEntry!(content, meta);
  }
  return port;
}

// ---------------------------------------------------------------------------
// MCP port builder
// ---------------------------------------------------------------------------

/**
 * Build a WorkflowMcpPort from the pi ExtensionAPI when MCP scope gating is
 * supported. Returns undefined when pi.events?.emit is absent (adapter not
 * installed or older runtime without events bus) — scoping becomes a no-op.
 */
export function makeMcpPort(pi: ExtensionAPI): WorkflowMcpPort | undefined {
  if (typeof pi.events?.emit !== "function") return undefined;

  // Adapt ExtensionAPI to the minimal PiMcpExtensionAPI shape expected by
  // setMcpScope / clearMcpScope. We only forward events.emit (confirmed above).
  const piForMcp: PiMcpExtensionAPI = {
    events: { emit: pi.events.emit as PiEventBus["emit"] },
  };

  return {
    setScope(stageId: string, allow: string[] | null, deny: string[] | null) {
      setMcpScope(piForMcp, {
        stageId,
        allow: allow ?? undefined,
        deny: deny ?? undefined,
      });
    },
    clearScope(stageId: string) {
      clearMcpScope(piForMcp, stageId);
    },
  };
}

// ---------------------------------------------------------------------------
// Factory — the default export consumed by the pi runtime
// ---------------------------------------------------------------------------

function factory(pi: ExtensionAPI): void {
  // -------------------------------------------------------------------------
  // 0. Build StageAdapters from pi runtime surfaces. Stage prompting uses
  //    pi's in-process SDK `createAgentSession()` surface; HIL prompts
  //    flow through the store-backed background adapter built inside
  //    `runDetached()` — they never touch pi.ui.
  // -------------------------------------------------------------------------
  const adapters = buildRuntimeAdapters(pi);

  // Local registry of workflow command (name → handler). Populated by
  // `registerWorkflowCommand` calls below and consumed by the
  // `pi.on("input", …)` interceptor at the end of the factory — see
  // `installInputInterceptor` for the rationale.
  const workflowCommands = new Map<string, WorkflowCommandHandler>();

  // -------------------------------------------------------------------------
  // 1. Create ExtensionRuntime — mutable ref seeded from startup discovery,
  //    upgraded to unified async discovery once discoverWorkflows() resolves.
  //
  //    runtimeProxy delegates all calls to runtimeRef.current so every
  //    registration closure automatically uses the most-current registry without
  //    needing to be re-registered.
  // -------------------------------------------------------------------------
  const persistenceRef: { current: WorkflowPersistencePort | undefined } = {
    current: makePersistencePort(pi, WORKFLOW_CONFIG_DEFAULTS.persistRuns),
  };

  // Build graph overlay adapter — wraps GraphView + pi.ui.custom.
  // noopOverlay returned when pi.ui?.custom is absent (degraded runtime).
  const overlay: GraphOverlayPort = buildGraphOverlayAdapter(pi, store, {
    onKillRun: (runId) => {
      const run = store.runs().find((r) => r.id === runId);
      const result = killRun(runId, {
        cancellation: cancellationRegistry,
        persistence: persistenceRef.current,
      });
      if (run && result.ok) {
        emitChatSurface(pi, {
          kind: "killed",
          run,
          previousStatus: result.previousStatus,
        });
      }
    },
  });

  const mcpPort: WorkflowMcpPort | undefined = makeMcpPort(pi);

  /**
   * Mutable ref for the resolved runtime config.
   * Seeded with WORKFLOW_CONFIG_DEFAULTS at startup; replaced after async config load.
   * Injected into every createExtensionRuntime() call so the dispatcher, executor,
   * and detached runner all receive the same resolved tunables.
   */
  const runtimeConfigRef: { current: WorkflowRuntimeConfig } = {
    current: {
      maxDepth: WORKFLOW_CONFIG_DEFAULTS.maxDepth,
      defaultConcurrency: WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency,
      persistRuns: WORKFLOW_CONFIG_DEFAULTS.persistRuns,
      statusFile: WORKFLOW_CONFIG_DEFAULTS.statusFile,
      resumeInFlight: WORKFLOW_CONFIG_DEFAULTS.resumeInFlight,
    },
  };

  /**
   * Mutable ref for the status writer instance.
   * Replaced (old unsubscribed) each time runtimeConfigRef is updated after
   * async config resolution. Starts as a no-op (statusFile defaults to false).
   */
  let statusWriterRef: StatusWriter = createStatusWriter(
    store,
    runtimeConfigRef.current,
  );
  let lifecycleNotificationsUnsubscribe: (() => void) | null = null;
  let lifecycleNotificationsActive = false;
  let hilAnswerNotificationsUnsubscribe: (() => void) | null = null;
  let hilAnswerNotificationsActive = false;
  const lifecycleNotificationState = createWorkflowLifecycleNotificationState();
  const hilAnswerNotificationState = createWorkflowHilAnswerNotificationState();
  const lifecycleNotificationConfigRef: { current: WorkflowLifecycleNotificationConfig } = {
    current: WORKFLOW_CONFIG_DEFAULTS.workflowNotifications,
  };
  const registerMessageRenderer: ExtensionAPI["registerMessageRenderer"] | undefined =
    typeof pi.registerMessageRenderer === "function"
      ? (event, renderer) => pi.registerMessageRenderer!(event, renderer)
      : undefined;
  registerLifecycleNoticeRenderer({
    rendererHost: pi,
    registerMessageRenderer,
  });
  registerHilAnswerNoticeRenderer({
    rendererHost: pi,
    registerMessageRenderer,
  });
  const sendWorkflowNotificationMessage: ExtensionAPI["sendMessage"] | undefined =
    typeof pi.sendMessage === "function"
      ? (message, options) => pi.sendMessage!(message, options)
      : undefined;
  const reinstallLifecycleNotifications = (): void => {
    lifecycleNotificationsUnsubscribe?.();
    lifecycleNotificationsUnsubscribe = null;
    if (!lifecycleNotificationsActive) return;
    lifecycleNotificationsUnsubscribe = installWorkflowLifecycleNotifications({
      store,
      config: lifecycleNotificationConfigRef.current,
      state: lifecycleNotificationState,
      seedExisting: true,
      sendMessage: sendWorkflowNotificationMessage,
    });
  };
  const reinstallHilAnswerNotifications = (): void => {
    hilAnswerNotificationsUnsubscribe?.();
    hilAnswerNotificationsUnsubscribe = null;
    if (!hilAnswerNotificationsActive) return;
    hilAnswerNotificationsUnsubscribe = installWorkflowHilAnswerNotifications({
      store,
      stageUiBroker,
      state: hilAnswerNotificationState,
      sendMessage: sendWorkflowNotificationMessage,
    });
  };

  async function runWithLifecycleSuppressedForPolicy<T>(
    policy: WorkflowExecutionPolicy,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (policy.mode !== "non_interactive" || policy.awaitTerminalRun !== true) {
      return fn();
    }
    return withWorkflowLifecycleNotificationsSuppressedAsync(
      lifecycleNotificationState,
      fn,
    );
  }
  let intercomParentSession: string | null = null;
  const intercomPort = {
    emit:
      typeof pi.events?.emit === "function"
        ? (event: string, payload: Record<string, unknown>) =>
            pi.events!.emit!(event, payload)
        : undefined,
    parentSession: () => intercomParentSession ?? undefined,
  };

  const startupDiscovery = discoverStartupWorkflowsSync();
  const runtimeRef: { current: ExtensionRuntime } = {
    current: createExtensionRuntime({
      registry: startupDiscovery.registry,
      workflowSources: startupDiscovery.sources,
      cwd: process.cwd(),
      adapters,
      cancellation: cancellationRegistry,
      persistence: persistenceRef.current,
      mcp: mcpPort,
      intercom: intercomPort,
      config: runtimeConfigRef.current,
    }),
  };
  const discoveryRef: { current: DiscoveryResult | null } = { current: null };
  const configLoadRef: { current: ConfigLoadResult | null } = { current: null };

  /** Stable proxy — all registrations close over this; delegates to runtimeRef.current. */
  const runtimeProxy: ExtensionRuntime = {
    get registry() {
      return runtimeRef.current.registry;
    },
    dispatch(args, options) {
      return runtimeRef.current.dispatch(args, options);
    },
    runDirect(args, options) {
      return runtimeRef.current.runDirect(args, options);
    },
    resumeFailedRun(sourceRunId, stageId, options) {
      return runtimeRef.current.resumeFailedRun(sourceRunId, stageId, options);
    },
  };

  function modelFullId(model: PiRuntimeModel): string {
    return `${String(model.provider)}/${model.id}`;
  }

  function workflowModelCatalogFromContext(
    ctx?: PiModelContext,
  ): WorkflowModelCatalogPort | undefined {
    if (ctx?.modelRegistry === undefined && ctx?.model === undefined)
      return undefined;
    return {
      listModels: async (): Promise<readonly WorkflowModelInfo[]> => {
        const available =
          ctx.modelRegistry?.getAvailable() ??
          (ctx.model === undefined ? [] : [ctx.model]);
        return available.map((model) => ({
          provider: String(model.provider),
          id: model.id,
          fullId: modelFullId(model),
          model: model as NonNullable<CreateAgentSessionOptions["model"]>,
        }));
      },
      ...(ctx.model !== undefined
        ? {
            currentModel: ctx.model as NonNullable<
              CreateAgentSessionOptions["model"]
            >,
            preferredProvider: String(ctx.model.provider),
          }
        : {}),
    };
  }

  function runtimeWithModels(
    models: WorkflowModelCatalogPort | undefined,
  ): ExtensionRuntime {
    if (models === undefined) return runtimeProxy;
    return createExtensionRuntime({
      registry: runtimeRef.current.registry,
      workflowSources: discoveryRef.current?.sources ?? startupDiscovery.sources,
      cwd: process.cwd(),
      adapters,
      cancellation: cancellationRegistry,
      persistence: persistenceRef.current,
      mcp: mcpPort,
      intercom: intercomPort,
      config: runtimeConfigRef.current,
      models,
    });
  }

  // The runtime normally does not depend on per-command UI, but model fallback
  // resolution uses the live command/tool context when pi exposes modelRegistry.
  function runtimeForContext(
    ctx?: { ui?: PiUISurface } & PiModelContext,
  ): ExtensionRuntime {
    return runtimeWithModels(workflowModelCatalogFromContext(ctx));
  }

  let intercomControlUnsubscribe: (() => void) | null = null;
  let workflowReloadQueue: Promise<void> = Promise.resolve();

  async function reloadWorkflowResources(options?: { allowInFlight?: boolean }): Promise<void> {
    const reload = workflowReloadQueue.then(() => reloadWorkflowResourcesNow(options));
    workflowReloadQueue = reload.catch(() => {});
    await reload;
  }

  async function reloadWorkflowResourcesNow(options?: { allowInFlight?: boolean }): Promise<void> {
    const activeRuns = inFlightRunCount();
    if (options?.allowInFlight !== true) {
      if (activeRuns > 0) {
        throw new WorkflowReloadBlockedError(reloadBlockedMessage(activeRuns));
      }
    } else if (activeRuns > 0 && process.env.ATOMIC_WORKFLOW_DEBUG === "1") {
      console.warn(
        `Workflow reload bypassed in-flight guard with ${activeRuns} active run(s).`,
      );
    }

    const configResult = await loadWorkflowConfig();
    configLoadRef.current = configResult;

    // Build scope-aware DiscoveryConfig: global entries → globalWorkflows (resolved
    // under <homeDir>/.atomic/agent), project entries → projectWorkflows (resolved under
    // projectRoot). Project keys override global keys. Paths pre-resolved to absolute.
    const { homedir } = await import("node:os");
    const hasGlobal = configResult.globalConfig != null;
    const hasProject = configResult.projectConfig != null;
    const discoveryConfig =
      hasGlobal || hasProject
        ? toScopedDiscoveryConfig(
            configResult.globalConfig ?? null,
            configResult.projectConfig ?? null,
            { projectRoot: process.cwd(), homeDir: homedir() },
          )
        : undefined;

    const packageWorkflowPaths = (pi.getWorkflowResources?.() ?? [])
      .filter((resource) => resource.enabled !== false)
      .map((resource) => resource.path);
    const result = await discoverWorkflows({ config: discoveryConfig, packageWorkflowPaths });
    discoveryRef.current = result;

    // Resolve effective config (fills in all defaults) and build WorkflowRuntimeConfig.
    const effectiveConfig = withWorkflowDefaults(configResult.config ?? {});
    runtimeConfigRef.current = {
      maxDepth: effectiveConfig.maxDepth,
      defaultConcurrency: effectiveConfig.defaultConcurrency,
      persistRuns: effectiveConfig.persistRuns,
      statusFile: effectiveConfig.statusFile,
      resumeInFlight: effectiveConfig.resumeInFlight,
    };
    lifecycleNotificationConfigRef.current = effectiveConfig.workflowNotifications;
    reinstallLifecycleNotifications();

    // Replace status writer with one that reflects the resolved config.
    // Unsubscribe the prior (no-op) writer before creating the new one.
    statusWriterRef.unsubscribe();
    statusWriterRef = createStatusWriter(store, runtimeConfigRef.current);

    persistenceRef.current = makePersistencePort(
      pi,
      effectiveConfig.persistRuns,
    );
    runtimeRef.current = createExtensionRuntime({
      registry: result.registry,
      workflowSources: result.sources,
      cwd: process.cwd(),
      adapters,
      cancellation: cancellationRegistry,
      persistence: persistenceRef.current,
      mcp: mcpPort,
      intercom: intercomPort,
      config: runtimeConfigRef.current,
    });
  }

  const executeWorkflowTool = makeExecuteWorkflowTool(
    (ctx) => runtimeForContext(ctx),
    () => persistenceRef.current,
    reloadWorkflowResources,
  );
  let storeWidgetUnsubscribe: (() => void) | null = null;

  // Start unified async discovery immediately.
  // On resolve: swap runtime ref so /workflow completions and dispatch see
  // project-local, user-global, and settings-provided workflows.
  // Load startup config before discovery so workflow paths and tunables are applied.
  const discoveryPromise = pi.disableAsyncDiscovery
    ? Promise.resolve()
    : reloadWorkflowResources({ allowInFlight: true });

  // -------------------------------------------------------------------------
  // 1. Register the `workflow` tool
  //    Pi's ToolDefinition.execute is positional: (toolCallId, params, signal,
  //    onUpdate, ctx) → Promise<AgentToolResult<TDetails>>. The internal
  //    `executeWorkflowTool` keeps its (args, ctx) shape for test ergonomics;
  //    we adapt here at the registration boundary only.
  //    cross-ref: pi-coding-agent dist/core/extensions/types.d.ts ToolDefinition
  // -------------------------------------------------------------------------
  if (typeof pi.registerTool === "function") {
    pi.registerTool<WorkflowToolArgs, WorkflowToolResult>({
      name: "workflow",
      label: "workflow",
      description: WORKFLOW_TOOL_DESCRIPTION,
      parameters: workflowParameters,
      renderShell: "self",
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        // Overlay is opt-in via F2 / ctrl+h; do not auto-open from a
        // tool-call dispatch path. Awaited non-interactive runs suppress
        // lifecycle steer notices until the terminal tool result is ready.
        const policy = workflowPolicyFromContext(ctx);
        const details = (params.action ?? "run") === "run"
          ? await runWithLifecycleSuppressedForPolicy(policy, () =>
              executeWorkflowTool(params, ctx),
            )
          : await executeWorkflowTool(params, ctx);
        return {
          content: [{ type: "text", text: renderWorkflowToolContent(details, params) }],
          details,
        };
      },
      renderCall: (args, _theme, _context) =>
        dynamicTextRenderComponent((width) => renderCall(args, { width })),
      renderResult: (result, opts, _theme, context) => {
        // Capture wall-clock ONCE per chat entry. The lambda below is
        // invoked on every TUI re-render; without a captured `now`, every
        // tick would recompute elapsed/running durations and trigger
        // pi-tui's full-redraw path for any entry above the viewport —
        // visible as whole-screen flicker on terminals without
        // synchronized output support (e.g. mosh).
        const capturedNow = Date.now();
        return dynamicTextRenderComponent((width) =>
          renderResult(result.details, {
            ...opts,
            width,
            now: capturedNow,
            runInputs: (context as { args?: WorkflowToolArgs }).args?.inputs,
          }),
        );
      },
    });
  }

  // -------------------------------------------------------------------------
  // 2. Register /workflow slash command
  // -------------------------------------------------------------------------
  /**
   * Shared top-level run-control handler.
   *
   *   connect [runId|prefix]              no arg → picker overlay; arg → attach to graph
   *   attach  [runId|prefix [stageId]]    open the in-place attach pane on a stage
   *   interrupt [runId|prefix|--all] [-y] confirmation overlay unless -y
   *   kill      [runId|prefix|--all] [-y] kill and retain for inspection
   *   pause     [runId|prefix [stageId]]    pause a run or specific stage
   *   resume  [runId|prefix [stageId] …]  resume paused work or reopen snapshot
   */
  async function handleRunControlCommand(
    action: "connect" | "interrupt" | "kill" | "attach" | "pause" | "resume",
    rest: string[],
    ctx: PiCommandContext,
    reporter: WorkflowCommandReporter = createWorkflowCommandReporter(ctx),
  ): Promise<boolean> {
    const policy = workflowPolicyFromContext(ctx);
    const print = (msg: string): void => reporter.info(msg);
    const fail = (msg: string): void => reporter.error(msg);
    const canOpenPicker = (ui: PiCommandContext["ui"] | undefined): boolean =>
      policy.allowInputPicker && typeof ui?.custom === "function";
    const confirmationPrompt = policy.allowHumanInput && typeof ctx.ui?.confirm === "function"
      ? ctx.ui.confirm.bind(ctx.ui)
      : undefined;
    const theme = deriveGraphTheme({});
    const failHeadlessAttachCommand = (
      targetAction: "connect" | "attach",
      runId: string,
      stageId?: string,
    ): boolean => {
      if (policy.allowInputPicker) return false;
      const displayTarget = stageId
        ? `${runId.slice(0, 8)} stage ${stageId.slice(0, 8)}`
        : runId.slice(0, 8);
      fail(
        `/workflow ${targetAction} requires an interactive UI surface and cannot attach in non-interactive mode. ` +
          `Target: ${displayTarget}. Use /workflow status ${runId.slice(0, 8)} or the workflow tool's status/stages/transcript actions for non-interactive inspection.`,
      );
      return true;
    };

    if (action === "connect") {
      const target = rest.find((t) => !t.startsWith("--"));
      if (!target) {
        // Picker mode — mount the overlay and route the resolved action.
        const ui = ctx.ui;
        if (!canOpenPicker(ui)) {
          fail(
            `${renderSessionList(store.runs(), { theme, includeAll: true })}\n\nPicker requires an interactive UI surface. Pass a runId: /workflow connect <id>`,
          );
          return true;
        }
        const result = await openSessionPicker(ui, store, theme, "connect");
        if (result.kind === "close") return true;
        if (result.kind === "connect") {
          overlay.open(result.runId, overlaySurfaceFromContext(ctx));
          return true;
        }
        if (result.kind === "kill") {
          const run = store.runs().find((r) => r.id === result.runId);
          if (!run) {
            fail(`Run not found: ${result.runId}`);
            return true;
          }
          if (run.endedAt !== undefined) {
            print(formatAlreadyEndedRetainedMessage(result.runId));
            return true;
          }
          const confirmed = await openKillConfirm(ui, run, theme);
          if (!confirmed) {
            print(
              `Cancelled. Run ${result.runId.slice(0, 8)} is still active.`,
            );
            return true;
          }
          const killed = killRun(result.runId, {
            cancellation: cancellationRegistry,
            persistence: persistenceRef.current,
          });
          if (killed.ok) {
            emitChatSurface(pi, {
              kind: "killed",
              run,
              previousStatus: killed.previousStatus,
            });
            print(`Run ${killed.runId.slice(0, 8)} killed and retained for inspection.`);
          } else if (killed.reason === "already_ended") {
            print(formatAlreadyEndedRetainedMessage(killed.runId));
          } else {
            fail(`Run not found: ${result.runId.slice(0, 8)}.`);
          }
          return true;
        }
        return true;
      }
      const resolved = resolveRunIdPrefix(target);
      if (resolved.kind === "not_found") {
        fail(
          `Run not found: ${target}\n\n${renderSessionList(store.runs(), { theme, includeAll: true })}`,
        );
        return true;
      }
      if (resolved.kind === "ambiguous") {
        fail(
          `Ambiguous run prefix "${target}" matches: ${resolved.matches
            .map((id) => id.slice(0, 12))
            .join(", ")}`,
        );
        return true;
      }
      if (failHeadlessAttachCommand("connect", resolved.runId)) {
        return true;
      }
      if (policy.allowInputPicker) {
        overlay.open(resolved.runId, overlaySurfaceFromContext(ctx));
      }
      print(
        `Attached to ${resolved.runId.slice(0, 8)}. h/ctrl+d hide · q kill · esc close.`,
      );
      return true;
    }

    if (action === "interrupt") {
      const { tokens: interruptArgs, yes } = stripYesFlag(rest);
      let target = interruptArgs.find((t) => !t.startsWith("--"));
      const wantsAll = interruptArgs.includes("--all");
      if (!target && !wantsAll) {
        target = store.activeRunId() ?? undefined;
        if (!target) {
          fail("No in-flight runs to interrupt.");
          return true;
        }
      }
      if (wantsAll) {
        const inFlight = store.runs().filter((r) => r.endedAt === undefined);
        if (inFlight.length === 0) {
          fail("No in-flight runs to interrupt.");
          return true;
        }
        if (!yes && confirmationPrompt) {
          const ok = await confirmationPrompt(
            `Interrupt all ${inFlight.length} in-flight workflow runs?`,
            `Pauses: ${inFlight.map((r) => `${r.name} (${r.id.slice(0, 8)})`).join(", ")}`,
          );
          if (!ok) {
            print("Cancelled.");
            return true;
          }
        }
        const results = interruptAllRuns();
        const interrupted = results.filter((r) => r.ok).length;
        if (interrupted > 0) {
          print(`Interrupted ${interrupted} run(s).`);
        } else {
          fail("No in-flight runs to interrupt.");
        }
        return true;
      }
      const resolved = resolveRunIdPrefix(target!);
      if (resolved.kind === "not_found") {
        fail(`Run not found: ${target}`);
        return true;
      }
      if (resolved.kind === "ambiguous") {
        fail(
          `Ambiguous run prefix "${target}" matches multiple runs: ${resolved.matches
            .map((id) => id.slice(0, 12))
            .join(", ")}`,
        );
        return true;
      }
      const run = store.runs().find((r) => r.id === resolved.runId);
      if (!yes && run && run.endedAt === undefined && confirmationPrompt) {
        const confirmed = await confirmationPrompt(
          `Interrupt workflow run ${run.name} (${run.id.slice(0, 8)})?`,
          "Pauses live work so it can be resumed later.",
        );
        if (!confirmed) {
          print(
            `Cancelled. Run ${resolved.runId.slice(0, 8)} is still active.`,
          );
          return true;
        }
      }
      const result = interruptRun(resolved.runId);
      if (result.ok) {
        print(
          `Run ${result.runId.slice(0, 8)} interrupted and can be resumed.`,
        );
      } else {
        fail(
          result.reason === "not_found"
            ? `Run not found: ${target}`
            : result.reason === "already_ended"
              ? `Run already ended: ${target}`
              : result.reason === "stage_not_found"
                ? `Stage not found for run ${resolved.runId.slice(0, 8)}.`
                : `No active stages to interrupt on run ${resolved.runId.slice(0, 8)}.`,
        );
      }
      return true;
    }

    if (action === "kill") {
      const { tokens: killArgs, yes } = stripYesFlag(rest);
      let target = killArgs.find((t) => !t.startsWith("--"));
      const wantsAll = killArgs.includes("--all");
      if (!target && !wantsAll) {
        target = store.activeRunId() ?? undefined;
        if (!target) {
          fail("No in-flight runs to kill.");
          return true;
        }
      }
      if (wantsAll) {
        const inFlight = store.runs().filter((r) => r.endedAt === undefined);
        if (inFlight.length === 0) {
          fail("No in-flight runs to kill.");
          return true;
        }
        if (!yes && confirmationPrompt) {
          const ok = await confirmationPrompt(
            `Kill ${inFlight.length} in-flight workflow runs? Killed runs are retained for inspection.`,
            `Aborts: ${inFlight.map((r) => `${r.name} (${r.id.slice(0, 8)})`).join(", ")}`,
          );
          if (!ok) {
            print("Cancelled.");
            return true;
          }
        }
        const results = killAllRuns({
          cancellation: cancellationRegistry,
          persistence: persistenceRef.current,
        });
        const killed = results.filter((r) => r.ok).length;
        if (killed > 0) {
          print(`Killed and retained ${killed} run(s) for inspection.`);
        } else {
          fail("No in-flight runs to kill.");
        }
        return true;
      }
      const resolved = resolveRunIdPrefix(target!);
      if (resolved.kind === "not_found") {
        fail(`Run not found: ${target}`);
        return true;
      }
      if (resolved.kind === "ambiguous") {
        fail(
          `Ambiguous run prefix "${target}" matches multiple runs: ${resolved.matches
            .map((id) => id.slice(0, 12))
            .join(", ")}`,
        );
        return true;
      }
      const run = store.runs().find((r) => r.id === resolved.runId);
      if (run?.endedAt !== undefined) {
        print(formatAlreadyEndedRetainedMessage(resolved.runId));
        return true;
      }
      if (!yes && run && confirmationPrompt) {
        const confirmed = await openKillConfirm(ctx.ui, run, theme);
        if (!confirmed) {
          print(
            `Cancelled. Run ${resolved.runId.slice(0, 8)} is still in history/status.`,
          );
          return true;
        }
      }
      const result = killRun(resolved.runId, {
        cancellation: cancellationRegistry,
        persistence: persistenceRef.current,
      });
      if (result.ok) {
        if (run) {
          emitChatSurface(pi, {
            kind: "killed",
            run,
            previousStatus: result.previousStatus,
          });
        }
        print(
          `Run ${result.runId.slice(0, 8)} killed and retained for inspection (was ${result.previousStatus}).`,
        );
      } else if (result.reason === "already_ended") {
        print(formatAlreadyEndedRetainedMessage(result.runId));
      } else {
        fail(`Run not found: ${target}`);
      }
      return true;
    }

    if (action === "attach") {
      const target = rest[0];
      const stageTarget = rest[1];
      let runId: string;
      if (!target) {
        const ui = ctx.ui;
        if (!canOpenPicker(ui)) {
          fail(
            `${renderSessionList(store.runs(), { theme, includeAll: true })}\n\nPicker requires an interactive UI surface. Pass a runId: /workflow attach <id> [stageId]`,
          );
          return true;
        }
        const picked = await openSessionPicker(ui, store, theme, "connect");
        if (picked.kind === "close") return true;
        if (picked.kind !== "connect") {
          // The picker may have surfaced interrupt from the `x` shortcut.
          // Forward through the existing interrupt flow for clarity.
          if (picked.kind === "kill") {
            return handleRunControlCommand(
              "kill",
              [picked.runId, "-y"],
              ctx,
              reporter,
            );
          }
          return true;
        }
        runId = picked.runId;
      } else {
        const resolved = resolveRunIdPrefix(target);
        if (resolved.kind === "not_found") {
          fail(`Run not found: ${target}`);
          return true;
        }
        if (resolved.kind === "ambiguous") {
          fail(
            `Ambiguous run prefix "${target}" matches: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`,
          );
          return true;
        }
        runId = resolved.runId;
      }
      const run = store.runs().find((r) => r.id === runId);
      let stageId: string | undefined;
      if (stageTarget && run) {
        const exact = run.stages.find((s) => s.id === stageTarget);
        const prefix =
          exact ?? run.stages.find((s) => s.id.startsWith(stageTarget));
        const byName = prefix ?? run.stages.find((s) => s.name === stageTarget);
        if (!byName) {
          fail(`Stage not found in run ${runId.slice(0, 8)}: ${stageTarget}`);
          return true;
        }
        stageId = byName.id;
      }
      if (failHeadlessAttachCommand("attach", runId, stageId)) {
        return true;
      }
      if (policy.allowInputPicker) {
        overlay.open(runId, overlaySurfaceFromContext(ctx), stageId);
      }
      const attachedStage = stageId ? run?.stages.find((s) => s.id === stageId) : undefined;
      print(
        stageId
          ? attachedStage?.status === "paused"
            ? `Attached to ${runId.slice(0, 8)} stage ${stageId.slice(0, 8)}. ctrl+d close · esc close.`
            : `Attached to ${runId.slice(0, 8)} stage ${stageId.slice(0, 8)}. ctrl+d return to graph · esc close.`
          : `Attached to ${runId.slice(0, 8)}. ↵ chat · ctrl+d detach.`,
      );
      return true;
    }

    if (action === "pause") {
      const target = rest[0];
      const stageTarget = rest[1];
      let runId: string;
      if (!target) {
        const ui = ctx.ui;
        if (!canOpenPicker(ui)) {
          const active = store.runs().filter((r) => r.endedAt === undefined);
          if (active.length === 0) {
            fail("No active runs to pause.");
            return true;
          }
          fail(
            `Picker requires an interactive UI surface. Active runs:\n${active.map((r) => `  ${r.id.slice(0, 8)}  ${r.name}`).join("\n")}\n\nUsage: /workflow pause <runId> [stageId]`,
          );
          return true;
        }
        const picked = await openSessionPicker(ui, store, theme, "pause");
        if (picked.kind !== "pause") return true;
        runId = picked.runId;
      } else {
        const resolved = resolveRunIdPrefix(target);
        if (resolved.kind === "not_found") {
          fail(`Run not found: ${target}`);
          return true;
        }
        if (resolved.kind === "ambiguous") {
          fail(
            `Ambiguous run prefix "${target}" matches: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`,
          );
          return true;
        }
        runId = resolved.runId;
      }
      let stageId: string | undefined;
      if (stageTarget) {
        const run = store.runs().find((r) => r.id === runId);
        const stage = run?.stages.find(
          (s) =>
            s.id === stageTarget ||
            s.id.startsWith(stageTarget) ||
            s.name === stageTarget,
        );
        if (!stage) {
          fail(`Stage not found in run ${runId.slice(0, 8)}: ${stageTarget}`);
          return true;
        }
        stageId = stage.id;
      }
      const result = pauseRun(runId, { stageId });
      if (!result.ok) {
        const why =
          result.reason === "not_found"
            ? `Run not found: ${runId.slice(0, 8)}`
            : result.reason === "already_ended"
              ? `Run ${runId.slice(0, 8)} already ended.`
              : result.reason === "no_active_stages"
                ? `No pausable stages on run ${runId.slice(0, 8)}.`
                : `Stage not found: ${stageTarget ?? "(unknown)"}`;
        fail(why);
        return true;
      }
      // Open the orchestrator overlay (graph for run-level pause, stage
      // chat when a stage was named). This mirrors connect/attach/resume:
      // the full-screen overlay hides Pi's "Working… (esc to interrupt)"
      // spinner, which otherwise stays visible because the host session
      // is still streaming whatever was happening before the pause hit.
      if (policy.allowInputPicker) {
        overlay.open(runId, overlaySurfaceFromContext(ctx), stageId);
      }
      print(
        result.paused.length === 0
          ? `No stages were paused on run ${runId.slice(0, 8)}.`
          : `Paused ${result.paused.length} stage(s) on run ${runId.slice(0, 8)}: ${result.paused.map((s) => s.name).join(", ")}`,
      );
      return true;
    }

    if (action === "resume") {
      const target = rest[0];
      const stageTarget = rest[1];
      const message = rest.slice(2).join(" ").trim() || undefined;
      let runId: string;
      if (!target) {
        const ui = ctx.ui;
        if (!canOpenPicker(ui)) {
          fail(`Usage: /workflow resume <runId> [stageId] [message…]`);
          return true;
        }
        const picked = await openSessionPicker(ui, store, theme, "resume");
        if (picked.kind !== "resume") return true;
        runId = picked.runId;
      } else {
        const resolved = resolveRunIdPrefix(target);
        if (resolved.kind === "not_found") {
          fail(`Run not found: ${target}`);
          return true;
        }
        if (resolved.kind === "ambiguous") {
          fail(
            `Ambiguous run prefix "${target}" matches: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`,
          );
          return true;
        }
        runId = resolved.runId;
      }
      let stageId: string | undefined;
      const run = store.runs().find((r) => r.id === runId);
      const resolvedStage = resolveStageTarget(runId, stageTarget);
      if (!resolvedStage.ok) {
        fail(resolvedStage.message);
        return true;
      }
      stageId = resolvedStage.stageId;
      const isPaused =
        run?.status === "paused" ||
        (run?.stages.some((s) => s.status === "paused") ?? false);
      if (!isPaused && run?.status === "failed" && run.endedAt !== undefined && run.resumable !== false) {
        const continuation = runtimeForContext(ctx).resumeFailedRun(runId, stageId, { policy });
        if (continuation.ok) {
          print(continuation.message);
        } else {
          fail(continuation.message);
        }
        return true;
      }
      const result = resumeRun(runId, { stageId, message });
      if (!result.ok) {
        fail(`Run not found: ${runId.slice(0, 8)}`);
        return true;
      }
      if (!isPaused) {
        // Non-paused fallback: reopen the orchestrator overlay as before when interactive.
        if (policy.allowInputPicker) {
          overlay.open(result.runId, overlaySurfaceFromContext(ctx));
        }
        print(
          result.message ?? `Snapshot available: run ${result.runId} (${result.snapshot.name}) \u2014 status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`,
        );
        return true;
      }
      // Paused live resume: when no message was provided and the picker
      // is available, open the attached chat so the user can talk to
      // the freshly-resumed stage.
      if (!message && stageId && policy.allowInputPicker) {
        overlay.open(runId, overlaySurfaceFromContext(ctx), stageId);
      }
      if (result.resumed.length === 0) {
        fail(`No paused stages on run ${runId.slice(0, 8)}.`);
      } else {
        print(`Resumed ${result.resumed.length} stage(s) on run ${runId.slice(0, 8)}${message ? ` with message: "${message}"` : ""}.`);
      }
      return true;
    }

    return false;
  }

  registerWorkflowCommand(
    pi,
    "workflow",
    {
      description:
        "Run or inspect Atomic workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status|connect|attach|interrupt|kill|pause|resume|inputs|reload] [args]",
      handler: async (args: string, ctx: PiCommandContext) => {
        const policy = workflowPolicyFromContext(ctx);
        const reporter = createWorkflowCommandReporter(ctx, policy, pi);
        const print = (msg: string): void => reporter.info(msg);
        const fail = (msg: string): void => reporter.error(msg);
        const withImplicitYesFlag = (tokens: string[]): string[] =>
          tokens.some((t) => t === "--yes" || t === "-y") ? tokens : [...tokens, "-y"];
        const showWorkflowInputs = async (
          workflowName: string,
          command: WorkflowCommandOutputDetails["command"] = "inputs",
        ): Promise<void> => {
          const result = await runtimeForContext(ctx).dispatch({
            workflow: workflowName,
            inputs: {},
            action: "inputs",
          }, { policy });
          if (result.action === "inputs" && "inputs" in result) {
            const r = result as Extract<
              WorkflowToolResult,
              { action: "inputs" }
            >;
            if (r.error) {
              const available = runtimeProxy.registry.names();
              fail(
                `${r.error}\nAvailable: ${formatAvailableWorkflowNames(available)}`,
              );
            } else {
              const schemaText = renderInputsSchema(workflowName, r.inputs, {
                theme: deriveGraphTheme({}),
              });
              if (policy.mode === "non_interactive") {
                emitWorkflowCommandOutput(pi, schemaText, {
                  command,
                  workflowName,
                });
              } else {
                print(schemaText);
              }
            }
          }
        };
        // Quote-aware split so `prompt="map the codebase"` stays a single
        // token. Plain `.split(/\s+/)` would mangle quoted multi-word values
        // into `prompt="map`, `the`, `codebase"` — the dispatch confirm then
        // renders `prompt=""map"` (see ui/qa-current-render-2.png).
        const parts = tokenizeWorkflowArgs(args);
        const subcommand = parts[0] ?? "";

        // -----------------------------------------------------------------------
        // connect — open the orchestrator pane (picker if no id).
        // attach  — open the in-place attach pane on a stage (or pick run).
        // pause   — pause a run or specific stage.
        // -----------------------------------------------------------------------
        if (subcommand === "connect") {
          await handleRunControlCommand("connect", parts.slice(1), ctx, reporter);
          return;
        }
        if (subcommand === "attach") {
          await handleRunControlCommand("attach", parts.slice(1), ctx, reporter);
          return;
        }
        if (subcommand === "pause") {
          await handleRunControlCommand("pause", parts.slice(1), ctx, reporter);
          return;
        }

        // -----------------------------------------------------------------------
        // list (default when no subcommand) — render the workflow catalogue
        // via the same renderer used by the LLM tool path.
        // -----------------------------------------------------------------------
        if (!subcommand || subcommand === "list") {
          const items = runtimeProxy.registry.all().map((def) => ({
            name: def.normalizedName,
            description: def.description,
            inputs: Object.entries(def.inputs).map(([iname, schema]) => ({
              name: iname,
              required: schema.required === true,
            })),
          }));
          emitChatSurface(pi, { kind: "list", entries: items });
          return;
        }

        // -----------------------------------------------------------------------
        // status — band-header rich list, or per-run detail when an id is
        // supplied. `/workflow status` lists all retained snapshots; `/workflow
        // status <id>` drills into a single run via the inspectRun detail block.
        // -----------------------------------------------------------------------
        if (subcommand === "status") {
          const target = parts[1];
          if (target && !target.startsWith("--")) {
            const resolved = resolveRunIdPrefix(target);
            if (resolved.kind === "not_found") {
              fail(`Run not found: ${target}`);
              return;
            }
            if (resolved.kind === "ambiguous") {
              fail(
                `Ambiguous run prefix "${target}" matches: ${resolved.matches
                  .map((id) => id.slice(0, 12))
                  .join(", ")}`,
              );
              return;
            }
            const inspected = inspectRun(resolved.runId);
            if (!inspected.ok) {
              fail(`Run not found: ${target}`);
              return;
            }
            emitChatSurface(pi, { kind: "detail", detail: inspected.detail });
            return;
          }
          // Status lists all retained snapshots by default; --all remains
          // accepted as a compatibility no-op.
          const rows = selectRunsForPicker(
            store.runs(),
            "",
            true,
            Date.now(),
          );
          emitChatSurface(pi, { kind: "status", runs: rows.map((r) => r.run) });
          return;
        }

        // -----------------------------------------------------------------------
        // reload — refresh workflow resources in-process when no workflows are
        // currently running. Reload swaps runtime/persistence wiring, so doing it
        // mid-flight would split active runs across old and new resources.
        // -----------------------------------------------------------------------
        if (subcommand === "reload") {
          const activeRuns = inFlightRunCount();
          if (activeRuns > 0) {
            fail(reloadBlockedMessage(activeRuns));
            return;
          }
          try {
            await reloadWorkflowResources();
            print("Reloaded workflow resources.");
          } catch (error) {
            fail(reloadFailureMessage(error));
          }
          return;
        }

        // -----------------------------------------------------------------------
        // interrupt — top-level chat fast path (no confirmation overlay).
        // -----------------------------------------------------------------------
        if (subcommand === "interrupt") {
          // The top-level chat command is the fast interrupt path surfaced by the
          // widget hint (`/workflow interrupt <id>`). The user's explicit slash
          // command should pause immediately, even when a confirm surface is
          // unavailable or would steal focus from the running workflow.
          const interruptArgs = parts.slice(1);
          await handleRunControlCommand(
            "interrupt",
            withImplicitYesFlag(interruptArgs),
            ctx,
            reporter,
          );
          return;
        }

        // -----------------------------------------------------------------------
        // kill — abort in-flight work, mark killed, and retain for inspection.
        // -----------------------------------------------------------------------
        if (subcommand === "kill") {
          const killArgs = parts.slice(1);
          await handleRunControlCommand(
            "kill",
            withImplicitYesFlag(killArgs),
            ctx,
            reporter,
          );
          return;
        }

        // -----------------------------------------------------------------------
        // resume — non-paused runs reopen the orchestrator pane (legacy
        // behaviour); paused runs resume live work through the registry.
        // -----------------------------------------------------------------------
        if (subcommand === "resume") {
          await handleRunControlCommand("resume", parts.slice(1), ctx, reporter);
          return;
        }

        // -----------------------------------------------------------------------
        // inputs — pretty-printed via theme; falls back to plain in non-TTY tests.
        // -----------------------------------------------------------------------
        if (subcommand === "inputs") {
          const workflowName = parts[1] ?? "";
          if (!workflowName) {
            fail("Usage: /workflow inputs <name>");
            return;
          }
          await showWorkflowInputs(workflowName);
          return;
        }

        // -----------------------------------------------------------------------
        // Workflow name dispatch — workflows always run as background tasks.
        // The chat editor remains usable; HIL prompts surface through the graph
        // viewer overlay (F2 / `/workflow connect`).
        // -----------------------------------------------------------------------
        const workflowName = subcommand;
        const inputTokens = parts.slice(1);

        if (inputTokens.includes("--help")) {
          await showWorkflowInputs(workflowName, "help");
          return;
        }

        const inputs = parseWorkflowArgs(inputTokens);
        // -----------------------------------------------------------------------
        // Interactive argument picker.
        //
        // Triggers when:
        //   - the workflow has at least one declared input (zero-input
        //     workflows go straight to dispatch — there's nothing to ask),
        //   - the user did not pass `--no-picker`,
        //   - an interactive TUI surface is available,
        //   - AND either no key=value was supplied or one of the required
        //     inputs is still missing after parsing.
        //
        // The picker is seeded with whatever the user *did* type, so a
        // partial invocation like `/workflow gen-spec research_doc=notes.md`
        // pre-fills that field and focuses the next unfilled required one.
        // -----------------------------------------------------------------------
        const wantsPickerSkip = inputTokens.includes("--no-picker");
        let mergedInputs = inputs;
        // Track whether the inputs picker actually showed a UI to the user.
        // We use this below to mount the orchestrator overlay on dispatch
        // success — same UX as `/workflow connect|attach|pause|resume`,
        // which all cover Pi's `⠴ Working… (esc to interrupt)` spinner
        // with the full-screen overlay instead of leaving it visible in
        // the chat while the workflow runs in the background.
        let pickerWasShown = false;
        // Prefer the sticky inline form when the host can install a custom
        // editor. If the host rejects that editor contract at runtime, fall
        // back to the supported overlay picker rather than surfacing the host
        // exception as a workflow command error.
        const canOpenPicker =
          policy.allowInputPicker &&
          !wantsPickerSkip &&
          (typeof ctx.ui?.setEditorComponent === "function" ||
            typeof ctx.ui?.custom === "function");
        if (canOpenPicker) {
          const schemaResult = await runtimeForContext(ctx).dispatch({
            workflow: workflowName,
            inputs: {},
            action: "inputs",
          }, { policy });
          const schema =
            schemaResult.action === "inputs" && "inputs" in schemaResult
              ? (schemaResult as Extract<
                  WorkflowToolResult,
                  { action: "inputs" }
                >)
              : undefined;
          const fields = schema?.inputs ?? [];
          const hasFields = fields.length > 0;
          const missingRequired = fields.some(
            (f: WorkflowInputEntry) =>
              f.required === true &&
              (inputs[f.name] === undefined ||
                (typeof inputs[f.name] === "string" &&
                  (inputs[f.name] as string).trim() === "")),
          );
          const noTokensAtAll = inputTokens.length === 0;
          if (hasFields && (noTokensAtAll || missingRequired)) {
            pickerWasShown = true;
            const pickerTheme = deriveGraphTheme({});
            let pickerResult =
              typeof ctx.ui?.setEditorComponent === "function"
                ? await openInlineInputsForm(pi, ctx, {
                    workflowName,
                    fields,
                    prefilled: inputs,
                    theme: pickerTheme,
                  })
                : { kind: "unsupported" as const };
            if (
              pickerResult.kind === "unsupported" &&
              typeof ctx.ui?.custom === "function"
            ) {
              pickerResult = await openInputsPicker(ctx.ui, {
                workflowName,
                fields,
                prefilled: inputs,
                theme: pickerTheme,
              });
            }
            if (pickerResult.kind === "cancel") {
              return;
            }
            if (pickerResult.kind === "run") {
              mergedInputs = pickerResult.values;
            }
          }
        }

        const result = await runWithLifecycleSuppressedForPolicy(policy, () =>
          runtimeForContext(ctx).dispatch({
            workflow: workflowName,
            inputs: mergedInputs,
            action: "run",
          }, { policy }),
        );
        if (result.action === "run" && "runId" in result) {
          const r = result as Extract<
            WorkflowToolResult,
            { action: "run"; runId: string }
          >;
          if (r.status === "failed" && r.runId === "") {
            if (r.error?.toLowerCase().includes("not found")) {
              const available = runtimeProxy.registry.names();
              fail(
                `Workflow not found: ${workflowName}\nAvailable: ${formatAvailableWorkflowNames(available)}`,
              );
            } else {
              fail(
                `Workflow "${workflowName}" failed: ${r.error ?? "unknown error"}`,
              );
            }
          } else if (r.status === "failed") {
            fail(
              `Workflow "${workflowName}" failed: ${r.error ?? "unknown error"}`,
            );
          } else {
            if (policy.mode === "non_interactive") {
              emitTerminalRunDetailSurface(pi, workflowName, mergedInputs, r);
              return;
            }
            // Always-background — the run is alive, the chat is free.
            // Route via emitChatSurface so the band+card chrome receives the
            // real chat content width via pi-tui's Component contract
            // (registered renderer returns `{ render(width): string[] }`),
            // not a `process.stdout.columns - 2` heuristic.
            emitChatSurface(pi, {
              kind: "dispatch",
              workflowName,
              runId: r.runId,
              inputs: mergedInputs,
            });
            // When the user reached this path via the inputs picker (i.e.
            // they didn't pre-supply all required args), open the
            // orchestrator overlay. The full-screen overlay covers the
            // chat statusContainer so Pi's working spinner is not left
            // visible behind the dispatch card. Direct invocations with
            // complete args remain opt-in via F2 / `/workflow connect`.
            if (pickerWasShown && typeof ctx.ui?.custom === "function") {
              overlay.open(r.runId, overlaySurfaceFromContext(ctx));
            }
          }
        }
        return;
      },
      getArgumentCompletions: (partial: string): PiArgumentCompletionResult => {
        const completeToken = (
          argumentText: string,
          candidates: PiArgumentCompletion[],
        ): PiArgumentCompletionResult => {
          const tokenStart = /\s$/.test(argumentText)
            ? argumentText.length
            : Math.max(
                argumentText.lastIndexOf(" "),
                argumentText.lastIndexOf("\t"),
              ) + 1;
          const head = argumentText.slice(0, tokenStart);
          const token = argumentText.slice(tokenStart);
          const filtered = candidates
            .filter((candidate) => candidate.value.startsWith(token))
            .map((candidate) => ({
              ...candidate,
              value: `${head}${candidate.value}`,
            }));
          return filtered.length > 0 ? filtered : null;
        };

        const workflowNameItems = (): PiArgumentCompletion[] =>
          runtimeProxy.registry.names().map((name) => ({
            value: `${name} `,
            label: name,
            description: `Run workflow: ${name}`,
          }));

        const runIdItems = (): PiArgumentCompletion[] =>
          store.runs().map((run) => ({
            value: `${run.id} `,
            label: run.id.slice(0, 8),
            description: `${run.name} — ${run.status}`,
          }));

        const adminCompletions: PiArgumentCompletion[] = [
          {
            value: "connect ",
            label: "connect",
            description: "Attach to a run (picker if no id)",
          },
          {
            value: "attach ",
            label: "attach",
            description: "Open the in-place attach pane on a node",
          },
          {
            value: "list ",
            label: "list",
            description: "List registered workflows",
          },
          {
            value: "status ",
            label: "status",
            description: "List current-session active and retained terminal runs",
          },
          {
            value: "interrupt ",
            label: "interrupt",
            description: "Interrupt a run",
          },
          {
            value: "kill ",
            label: "kill",
            description: "Kill and retain a run for inspection",
          },
          {
            value: "pause ",
            label: "pause",
            description: "Pause a run or stage",
          },
          {
            value: "resume ",
            label: "resume",
            description: "Re-open overlay for a run",
          },
          {
            value: "inputs ",
            label: "inputs",
            description: "Show a workflow's input schema",
          },
          {
            value: "reload ",
            label: "reload",
            description: "Reload workflow resources",
          },
        ];

        const parts = partial.trim().split(/\s+/).filter(Boolean);
        const subcommand = parts[0] ?? "";
        if (!partial.includes(" ")) {
          return completeToken(partial, [
            ...adminCompletions,
            ...workflowNameItems(),
          ]);
        }

        if (subcommand === "inputs") {
          return completeToken(partial, workflowNameItems());
        }

        if (subcommand === "status") {
          return completeToken(partial, runIdItems());
        }

        if (subcommand === "connect") {
          return completeToken(partial, runIdItems());
        }

        if (subcommand === "resume") {
          return completeToken(partial, runIdItems());
        }

        if (subcommand === "attach" || subcommand === "pause") {
          return completeToken(partial, runIdItems());
        }

        if (subcommand === "interrupt" || subcommand === "kill") {
          const verb = subcommand === "kill" ? "Kill and retain" : "Interrupt";
          return completeToken(partial, [
            {
              value: "--all ",
              label: "--all",
              description: `${verb} all in-flight runs`,
            },
            {
              value: "--yes ",
              label: "--yes",
              description: "Skip confirmation",
            },
            { value: "-y ", label: "-y", description: "Skip confirmation" },
            ...runIdItems(),
          ]);
        }

        // `partial` ends with whitespace and no subcommand was typed yet
        // (e.g. `/workflow `). pi's autocomplete is asking what to suggest
        // after the trailing space; offer the same admin + workflow-name
        // menu as the no-space branch above. Skipping this guard would call
        // `registry.get("")`, which throws TypeError from normalizeWorkflowName.
        if (!subcommand) {
          return completeToken(partial, [
            ...adminCompletions,
            ...workflowNameItems(),
          ]);
        }

        const workflow = runtimeProxy.registry.get(subcommand);
        if (!workflow) return null;

        const tokenStart = /\s$/.test(partial)
          ? partial.length
          : Math.max(partial.lastIndexOf(" "), partial.lastIndexOf("\t")) + 1;
        const token = partial.slice(tokenStart);
        const equalsIndex = token.indexOf("=");
        if (equalsIndex > 0) {
          const inputName = token.slice(0, equalsIndex);
          const schema = workflow.inputs[inputName];
          if (schema?.type === "select") {
            return completeToken(
              partial,
              schema.choices.map((choice) => ({
                value: `${inputName}=${choice} `,
                label: choice,
                description: inputName,
              })),
            );
          }
          if (schema?.type === "boolean") {
            return completeToken(partial, [
              {
                value: `${inputName}=true `,
                label: "true",
                description: inputName,
              },
              {
                value: `${inputName}=false `,
                label: "false",
                description: inputName,
              },
            ]);
          }
          return null;
        }

        const inputCompletions: PiArgumentCompletion[] = Object.entries(
          workflow.inputs,
        ).map(([name, schema]) => ({
          value: `${name}=`,
          label: name,
          description: schema.description,
        }));
        return completeToken(partial, [
          {
            value: "--no-picker ",
            label: "--no-picker",
            description: "Skip interactive input picker",
          },
          {
            value: "--help ",
            label: "--help",
            description: "Show this workflow's input schema",
          },
          ...inputCompletions,
        ]);
      },
    },
    workflowCommands,
  );

  // -------------------------------------------------------------------------
  // 3. Register message renderers for lifecycle events (§5.6)
  // -------------------------------------------------------------------------
  // Chat-scroll renderers are deliberately limited to run-level events
  // (start + end). Per-stage chatter is owned by the orchestrator pane —
  // duplicating it into chat scroll just creates visual noise and pushes
  // older chat content out of view every time a stage transitions.
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer("workflow.run.start", (payload) =>
      renderRunBanner(payload as RunStartPayload),
    );
    pi.registerMessageRenderer("workflow.run.end", (payload) =>
      renderRunSummary(payload as RunEndPayload),
    );
    // Inline workflow-input form (Option C in the design conversation):
    // a sticky chat-history card driven by a custom EditorComponent. The
    // renderer reads form state from the module-level store keyed by
    // `details.formId`. Registered once; openInlineInputsForm() emits the
    // card via pi.sendMessage on each invocation.
    registerInlineFormRenderer(pi, deriveGraphTheme({}));

    // Chat-scroll surfaces for /workflow run|list|status|status <id>. Bypasses
    // the default `notify`/`Text(paddingX=1)` path so band+card chrome
    // receives the *real* chat content width instead of a `cols - 2` heuristic.
    // See src/tui/chat-surface-message.ts for the contract.
    registerChatSurfaceRenderer(pi, deriveGraphTheme({}));
  }

  // -------------------------------------------------------------------------
  // 4. Persistence: session_start restore + session_before_compact hook (§5.6, Phase D)
  // -------------------------------------------------------------------------
  if (typeof pi.on === "function") {
    pi.on("session_before_switch", async (event, ctx) => {
      const reason = typeof event === "object" && event !== null && "reason" in event
        ? (event as { readonly reason?: string }).reason
        : undefined;
      if (reason !== "new" && reason !== "resume") return undefined;

      // "In-flight" intentionally includes paused runs: session_start kills any run
      // without endedAt, so warn for the same set that would be stopped by the switch.
      const inFlightWorkflowCount = inFlightRunCount();
      if (inFlightWorkflowCount === 0) return undefined;

      const confirmSessionSwitch = ctx?.ui?.confirm;
      // Headless/non-interactive callers intentionally fail open so automation cannot wedge.
      if (typeof confirmSessionSwitch !== "function") return undefined;

      const workflowNoun = inFlightWorkflowCount === 1 ? "workflow" : "workflows";
      const actionLabel = reason === "new" ? "Start a new session" : "Resume another session";
      const messageLabel = reason === "new" ? "Starting a new session" : "Resuming another session";
      const promptTitle = `${actionLabel} and stop ${inFlightWorkflowCount} in-flight ${workflowNoun}?`;
      const promptMessage =
        `${messageLabel} will stop/kill ${inFlightWorkflowCount} in-flight ${workflowNoun} and clear workflow history tied to the current session.`;
      let shouldSwitchSession: boolean | undefined;
      try {
        shouldSwitchSession = await confirmSessionSwitch(promptTitle, promptMessage);
      } catch {
        // Keep headless/failed UI behavior fail-open so session automation cannot wedge.
        return undefined;
      }
      if (shouldSwitchSession) return undefined;

      const cancelledLabel = reason === "new" ? "New session" : "Resume";
      ctx?.ui?.notify?.(`${cancelledLabel} cancelled; in-flight workflows were left unchanged.`, "info");
      return { cancel: true };
    });

    pi.on("session_start", async (_event, ctx) => {
      // Non-interactive (`-p` / `--mode json`) sessions keep the workflow tool
      // available for deterministic, non-HiL automation. Policy gates later
      // disable pickers and reject workflows declared human-in-the-loop.
      // Defense-in-depth for older/nonstandard hosts: remove only the
      // unavailable human-input tool from the active tool set.
      deAdvertiseAskUserQuestionWhenHeadless(pi, ctx?.hasUI);

      // Workflow lifecycle is scoped to the originating chat session.
      // A new session inherits a clean store; any leftover live runs from a
      // previous session in the same pi process are killed (subprocess
      // aborted), then all stale snapshots are cleared. `restoreOnSessionStart`
      // below loads *this* session's persisted runs from disk.
      killAllRuns({
        store,
        cancellation: cancellationRegistry,
        persistence: persistenceRef.current,
      });
      store.clear();
      resetWorkflowLifecycleNotificationState(lifecycleNotificationState);
      resetWorkflowHilAnswerNotificationState(hilAnswerNotificationState);
      stageControlRegistry.clear();

      // pi-intercom session naming lives here so we don't trip the
      // loader's "Action methods cannot be called during extension
      // loading" guard.
      intercomParentSession = registerIntercomParentSession(pi);

      // Ensure config+discovery are ready before restoring in-flight runs —
      // tunables must be resolved first.
      await discoveryPromise;
      lifecycleNotificationsActive = true;
      hilAnswerNotificationsActive = true;
      reinstallLifecycleNotifications();
      reinstallHilAnswerNotifications();
      if (ctx?.ui) {
        const diagnostics = formatStartupDiagnostics(configLoadRef.current, discoveryRef.current);
        if (diagnostics !== null) {
          ctx.ui.notify?.(diagnostics, "warning");
        }
        storeWidgetUnsubscribe?.();
        storeWidgetUnsubscribe = installStoreWidget({ ui: ctx.ui }, store);
      }

      const sessionManager = ctx?.sessionManager ?? pi.sessionManager;
      if (sessionManager) {
        const cfg = configLoadRef.current?.config;
        withWorkflowLifecycleNotificationsSuppressed(
          lifecycleNotificationState,
          () => {
            restoreOnSessionStart(
              sessionManager,
              {
                resumeInFlight: cfg?.resumeInFlight ?? "ask",
                persistRuns: cfg?.persistRuns ?? true,
              },
              store,
            );
            // The suppressed subscriber observes restore replay and marks matching
            // notices delivered. Seed explicitly as a defensive backstop for
            // runtimes without a lifecycle-notification subscriber installed.
            seedWorkflowLifecycleNotificationState(
              lifecycleNotificationState,
              store.snapshot(),
            );
          },
        );
      }
    });

    installCompactionHook(pi, store);
    pi.on("session_shutdown", (event) => {
      // Only application exit owns workflow teardown. Session replacement
      // paths (reload/new/resume/fork) are handled by session_start restore
      // logic so they do not masquerade as app-exit kills.
      const reason = typeof event === "object" && event !== null && "reason" in event
        ? (event as { readonly reason?: string }).reason
        : undefined;
      intercomControlUnsubscribe?.();
      intercomControlUnsubscribe = null;
      if (reason === "quit") {
        killAllRuns({
          store,
          cancellation: cancellationRegistry,
          persistence: persistenceRef.current,
        });
      }
      storeWidgetUnsubscribe?.();
      storeWidgetUnsubscribe = null;
      lifecycleNotificationsActive = false;
      hilAnswerNotificationsActive = false;
      lifecycleNotificationsUnsubscribe?.();
      lifecycleNotificationsUnsubscribe = null;
      hilAnswerNotificationsUnsubscribe?.();
      hilAnswerNotificationsUnsubscribe = null;
    });
  }

  storeWidgetUnsubscribe = installStoreWidget(pi, store);
  installToolExecutionHooks(pi, store);

  // -------------------------------------------------------------------------
  // 5. Register F2 keyboard shortcut — open graph overlay for active run.
  //     Falls back to noop when pi.registerShortcut is absent (degraded runtime).
  //     Existing API shape: (key, { description, handler }).
  //
  //     Note: the historical `ctrl+h` toggle was removed when workflow runs
  //     became background-by-default — a global toggle is no longer the
  //     primary way to manage visibility. Inside the pane, press `h` to
  //     hide (calls setHidden(true) on the overlay handle); re-open via
  //     `F2` or `/workflow connect <id>`.
  // -------------------------------------------------------------------------
  if (typeof pi.registerShortcut === "function") {
    // Prefer the in-flight run; if nothing's active, fall back to the
    // most recently observed run so users can still review what just
    // finished without typing `/workflow resume <id>`.
    const openPane = (ctx?: PiCommandContext): void => {
      const activeRunId = store.activeRunId();
      const fallback = activeRunId ?? store.runs().at(-1)?.id ?? null;
      overlay.open(fallback, overlaySurfaceFromContext(ctx));
    };

    pi.registerShortcut("F2", {
      description: "Open workflow orchestrator pane",
      handler: openPane,
    });
  }

  // -------------------------------------------------------------------------
  // 6. Register sibling integrations (Phase G — §5.8, §5.9, §5.10)
  // All registration calls are guarded; no throw when sibling is absent.
  // Note: registerIntercomParentSession (pi-intercom session naming) calls
  // pi.setSessionName which is an action method — see session_start handler
  // above for that registration.
  // -------------------------------------------------------------------------

  // pi-intercom: route subagent:control-intercom events to overlay/store callbacks.
  // buildIntercomCallbacks wires store.recordNotice, pi.ui.confirm (when present),
  // and pi.events.emit (when present) so escalations are never silently dropped.
  intercomControlUnsubscribe = subscribeIntercomControl(
    pi,
    buildIntercomCallbacks({
      store,
      emit:
        typeof pi.events?.emit === "function"
          ? (event, payload) => pi.events!.emit!(event, payload)
          : undefined,
      confirm:
        typeof pi.ui?.confirm === "function"
          ? (title, message) => pi.ui!.confirm!(title, message)
          : undefined,
    }),
  );

  // -------------------------------------------------------------------------
  // 7. Suppress pi's optimistic "Working… (esc to interrupt)" loader
  //    for our slash commands. Workflow commands are synchronous picker /
  //    connect / inspect UIs, not streaming turns — the loader is noise
  //    that pads chrome above the picker. The `on("input")` hook fires
  //    BEFORE `startPendingSubmission`, so returning `{ action: "handled" }`
  //    short-circuits the host before the loader starts. We dispatch the
  //    registered handler ourselves. See `installInputInterceptor` for
  //    the full rationale and host pipeline reference.
  // -------------------------------------------------------------------------
  installInputInterceptor(pi, workflowCommands);
}

export default factory;
