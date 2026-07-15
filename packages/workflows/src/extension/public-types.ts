import type {
  CreateAgentSessionOptions,
  DefaultResourceLoaderInheritanceSnapshot,
} from "@bastani/atomic";
import type { SessionManager } from "../shared/persistence-restore.js";
import type { StageSessionRuntime } from "../runs/foreground/stage-runner.js";
import type { StageStatus } from "../shared/store-types.js";
import type {
  StageOptions,
  WorkflowChainStep,
  WorkflowDirectTaskItem,
  WorkflowInputValues,
  WorkflowMaxOutput,
} from "../shared/types.js";
import type { WidgetFactory } from "../tui/store-widget-installer.js";
import type { RenderResultOpts, WorkflowToolResult } from "./render-result.js";
import type { PiUISurface } from "./wiring.js";

export type PiTheme = Record<string, string>;

export interface PiRenderContext {
  state?: {
    runId?: string;
    stages?: unknown[];
  };
  invalidate?: () => void;
}

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

export interface PiMessageRenderOptions {
  expanded: boolean;
}

export type PiMessageRendererResult = string | PiMessageRenderComponent | null | undefined;
export type PiMessageRenderer = (
  payload: unknown,
  options?: PiMessageRenderOptions,
  theme?: unknown,
) => PiMessageRendererResult;

export interface PiArgumentCompletion {
  value: string;
  label: string;
  description?: string;
}

export type PiArgumentCompletionResult = PiArgumentCompletion[] | null;

export interface PiCommandOptions {
  description: string;
  handler: (args: string, ctx: PiCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (partial: string) => PiArgumentCompletionResult | Promise<PiArgumentCompletionResult>;
}

export interface PiRuntimeModel {
  readonly provider: string;
  readonly id: string;
}

export interface PiRuntimeModelRegistry {
  getAvailable(): PiRuntimeModel[];
}

export interface PiModelContext {
  readonly model?: PiRuntimeModel;
  readonly modelRegistry?: PiRuntimeModelRegistry;
  readonly signal?: AbortSignal;
  discoverModelCatalog?(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface PiCommandContext extends PiModelContext {
  ui: {
    notify: (message: string, type?: "info" | "warning" | "error") => void;
  } & PiUISurface;
  hasUI?: boolean;
}

export interface PiFlagNamedOpts {
  description: string;
  type?: "string" | "boolean";
  default?: unknown;
}

export interface PiAgentToolResult<TDetails> {
  content: Array<
    { type: "text"; text: string } | { type: "image"; [key: string]: unknown }
  >;
  details: TDetails;
  terminate?: boolean;
}

export interface PiToolOpts<TArgs, TDetails> {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  promptGuidelines?: string[];
  renderShell?: "default" | "self";
  execute: (
    toolCallId: string,
    params: TArgs,
    signal: AbortSignal | undefined,
    onUpdate: ((partial: PiAgentToolResult<TDetails>) => void) | undefined,
    ctx: PiExecuteContext,
  ) => Promise<PiAgentToolResult<TDetails>>;
  renderCall?: (
    args: TArgs,
    theme: PiTheme,
    context: PiRenderContext,
  ) => PiRenderComponent | string;
  renderResult?: (
    result: PiAgentToolResult<TDetails>,
    opts: PiRenderResultOpts,
    theme: PiTheme,
    context: PiRenderContext,
  ) => PiRenderComponent | string;
}

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
  registerCommand?: (name: string, options: PiCommandOptions) => void;
  registerMessageRenderer?: (
    event: string,
    renderer: PiMessageRenderer,
  ) => void;
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
      excludeFromContext?: boolean;
      interruptAbortMessage?: string;
    },
  ) => void | Promise<void>;
  registerFlag?: (name: string, opts: PiFlagNamedOpts) => void;
  getWorkflowResources?: () => readonly WorkflowResourceInfo[];
  refreshWorkflowResources?: () => Promise<readonly WorkflowResourceInfo[]>;
  getResourceLoaderInheritanceSnapshot?: () => DefaultResourceLoaderInheritanceSnapshot | undefined;
  registerShortcut?: (
    key: string,
    opts: {
      description: string;
      handler: (ctx?: PiCommandContext) => void | Promise<void>;
    },
  ) => void;
  getActiveTools?: () => string[];
  setActiveTools?: (toolNames: string[]) => void;
  setSessionName?: (name: string) => void | Promise<void>;
  events?: {
    emit?: (event: string, payload: Record<string, unknown>) => void;
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
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
  createAgentSession?: (
    options?: CreateAgentSessionOptions,
  ) => Promise<{ session: StageSessionRuntime }>;
  disableAsyncDiscovery?: boolean;
  appendEntry?: (
    type: string,
    payload: Record<string, unknown>,
  ) => string | undefined;
  setLabel?: (entryId: string, label: string) => void;
  appendCustomMessageEntry?: (
    content: string,
    meta?: Record<string, unknown>,
  ) => string | undefined;
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
  sessionManager?: SessionManager;
  ui?: {
    setWidget?: (
      key: string,
      factory: WidgetFactory | undefined,
      opts?: { placement?: string },
    ) => void;
    custom?: PiUISurface["custom"];
  } & PiUISurface;
  [key: string]: unknown;
}

export interface WorkflowToolArgs extends StageOptions {
  workflow?: string;
  inputs?: WorkflowInputValues;
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
  runId?: string;
  all?: boolean;
  stageId?: string;
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
  task?: WorkflowDirectTaskItem | string;
  tasks?: WorkflowDirectTaskItem[];
  chain?: WorkflowChainStep[];
  chainName?: string;
  context?: "fresh" | "fork";
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

export type WorkflowExecuteToolResult = PiAgentToolResult<WorkflowToolResult>;
