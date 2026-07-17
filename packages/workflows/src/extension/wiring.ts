/**
 * Runtime wiring helpers — construct StageAdapters from pi runtime
 * surfaces.
 *
 * `buildRuntimeAdapters` uses pi's in-process SDK (`createAgentSession`)
 * for workflow stages. The factory is imported directly from
 * `@bastani/atomic` (a peer dependency) because the
 * modern pi `ExtensionAPI` does NOT inject `createAgentSession` onto the
 * extension surface — it is a top-level package export. Workflow authors
 * can pass `createAgentSession` options directly to
 * `ctx.stage(name, options?)`; the executor strips workflow-only `mcp`
 * before session creation.
 *
 * Workflow-level HIL routing (`ctx.ui.input/confirm/select/editor`) stays in
 * the store-backed background UI adapter. In-stage HIL (`ask_user_question`)
 * is injected here because it must bind the stage SDK session to pi's live UI
 * context and mark the corresponding graph node as awaiting user input.
 *
 * cross-ref: src/runs/foreground/stage-runner.ts
 *            src/extension/index.ts
 *            pi docs/sdk.md createAgentSession
 */

import type {
  CreateAgentSessionOptions,
  DefaultResourceLoaderInheritanceSnapshot,
} from "@bastani/atomic";
import type { StageAdapters, StageSessionCreateResult, StageSessionRuntime } from "../runs/foreground/stage-runner.js";
import type { StageExecutionMeta, StageOptions } from "../shared/types.js";
import { stageUiBroker, type StageUiBroker } from "../shared/stage-ui-broker.js";
import { prepareAtomicStageSessionOptions } from "./atomic-stage-session.js";
import type { PiCodingAgentSdk, PrepareAtomicStageSessionOptions } from "./atomic-stage-session.js";
export { prepareAtomicStageSessionOptions } from "./atomic-stage-session.js";
export type { AtomicCreateAgentSessionOptions, PiCodingAgentSdk, PiSdkResourceLoader, PiSdkSettingsManager, PrepareAtomicStageSessionOptions } from "./atomic-stage-session.js";
import type { PiCustomOverlayFactory, PiCustomOverlayOptions, PiUISurface } from "./ui-surface.js";
export type { PiCustomComponent, PiCustomOverlayFactory, PiCustomOverlayFactoryTui, PiCustomOverlayFunction, PiCustomOverlayOptions, PiEditorComponent, PiEditorFactory, PiHostCustomUiState, PiHostCustomUiStateListener, PiKeybindings, PiOverlayHandle, PiOverlayOptions, PiRemoteTerminalControl, PiTheme, PiUIDialogOptions, PiUISurface, UIWiringSurface } from "./ui-surface.js";

// ---------------------------------------------------------------------------
// Minimal pi surface
// ---------------------------------------------------------------------------

/**
 * Minimal pi runtime surface needed to build stage adapters.
 *
 * SDK stage creation imports `createAgentSession` directly from
 * `@bastani/atomic` (≥ 0.74 — the pi SDK exposes it as a
 * top-level package export, NOT on the `ExtensionAPI` surface). The
 * optional `createAgentSession` field here is a test seam so callers can
 * inject a stub session factory; production code does not require it.
 */
export interface PiExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface PiExecOpts {
  signal?: AbortSignal;
  timeout?: number;
}

type StageLateMessageRouter = NonNullable<
  NonNullable<CreateAgentSessionOptions["orchestrationContext"]>["lateMessageRouter"]
>;

const LATE_STAGE_MESSAGE_EVENT = "atomic:workflow-stage-late-message";
type LateStageMessage = Parameters<StageLateMessageRouter["routeMessage"]>[0];
type LateStageMessageEvent = {
  handled: boolean;
  completion?: Promise<void>;
  batch: boolean;
  messages: LateStageMessage[];
  options?: Parameters<StageLateMessageRouter["routeMessage"]>[1];
};

export interface RuntimeWiringSurface {
  exec?: (command: string, args: string[], opts?: PiExecOpts) => Promise<PiExecResult>;
  ui?: PiUISurface;
  /** Resource-loader inheritance snapshot supplied by Atomic's ExtensionAPI. */
  getResourceLoaderInheritanceSnapshot?: () => DefaultResourceLoaderInheritanceSnapshot | undefined;
  /** Test seam: inject a stub session factory instead of importing the SDK. */
  createAgentSession?: (options?: CreateAgentSessionOptions) => Promise<StageSessionCreateResult>;
  sendMessage?: StageLateMessageRouter["routeMessage"];
  sendMessages?: StageLateMessageRouter["routeMessages"];
  events?: { emit?: (channel: string, data: Record<string, unknown>) => void };
}

export interface RuntimeAdapterBuildOptions {
  /** Test seam for SDK session creation. */
  createAgentSession?: (options?: CreateAgentSessionOptions) => Promise<StageSessionCreateResult>;
  /** Broker that routes stage-local custom UI into attached workflow nodes. */
  stageUiBroker?: StageUiBroker;
}

type BindableStageSession = StageSessionRuntime & {
  bindExtensions?: (bindings: {
    uiContext?: ReturnType<typeof makeStageExtensionUiContext>;
  }) => Promise<void>;
};


function isTestContext(): boolean {
  // Node's test runner sets NODE_TEST_CONTEXT; Bun's test runner sets NODE_ENV=test.
  return process.env["NODE_TEST_CONTEXT"] !== undefined || process.env["NODE_ENV"] === "test";
}

async function createPiSdkAgentSession(
  options?: CreateAgentSessionOptions,
  prepareOptions?: PrepareAtomicStageSessionOptions,
): Promise<StageSessionCreateResult> {
  const sdk = await import("@bastani/atomic") as PiCodingAgentSdk;
  const sessionOptions = await prepareAtomicStageSessionOptions(options, sdk, prepareOptions);
  const result = await sdk.createAgentSession(sessionOptions);
  // `CreateAgentSessionResult` is `{ session, extensionsResult, modelFallbackMessage? }`;
  // workflow stages only consume `.session` (structurally an `AgentSession`,
  // which is a superset of our `StageSessionRuntime` projection).
  const resultSettingsManager = result.session.settingsManager;
  const settingsManager = sessionOptions?.settingsManager ?? resultSettingsManager;
  return {
    session: result.session,
    ...(settingsManager?.getCodexFastModeSettings !== undefined
      ? { settingsManager }
      : {}),
  };
}

async function createTestAgentSession(_options?: CreateAgentSessionOptions): Promise<StageSessionCreateResult> {
  let lastAssistantText: string | undefined;
  const session: StageSessionRuntime = {
    async prompt(text: string): Promise<string> {
      lastAssistantText = `stub:sdk:${text.slice(0, 120)}`;
      return lastAssistantText;
    },
    async steer(_text: string): Promise<void> {},
    async followUp(_text: string): Promise<void> {},
    subscribe(): () => void {
      return () => {};
    },
    sessionFile: undefined,
    sessionId: `test-session-${crypto.randomUUID()}`,
    async setModel(_model): Promise<void> {},
    setThinkingLevel(_level): void {},
    async cycleModel() {
      return undefined;
    },
    cycleThinkingLevel() {
      return undefined;
    },
    agent: Object.create(null) as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "off",
    messages: [] as StageSessionRuntime["messages"],
    isStreaming: false as StageSessionRuntime["isStreaming"],
    async navigateTree(): ReturnType<StageSessionRuntime["navigateTree"]> {
      return { cancelled: true };
    },
    async compact(): ReturnType<StageSessionRuntime["compact"]> {
      return {
        compactedText: "[User]: retained",
        firstKeptEntryId: "kept",
        tokensBefore: 0,
        promptVersion: 3,
        parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" },
        rung: "planned",
        stats: {
          linesBefore: 0,
          linesDeleted: 0,
          linesKept: 0,
          rangeCount: 0,
          tokensBefore: 0,
          tokensAfter: 0,
          percentReduction: 0,
        },
      };
    },
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    getLastAssistantText(): string | undefined {
      return lastAssistantText;
    },
  };
  return { session };
}

function stripWorkflowOnlyOptions(options: (StageOptions | CreateAgentSessionOptions) | undefined): CreateAgentSessionOptions | undefined {
  if (!options) return options;
  const maybeWorkflowOptions = options as StageOptions;
  const { schema: _schema, mcp: _mcp, fallbackModels: _fallbackModels, ...sessionOptions } = maybeWorkflowOptions;
  return sessionOptions as CreateAgentSessionOptions;
}

function emitLateIntercomRoute(
  pi: RuntimeWiringSurface,
  messages: LateStageMessage[],
  options: LateStageMessageEvent["options"] | undefined,
  batch: boolean,
): Promise<void> | undefined {
  if (!messages.some((message) => message.customType === "intercom_message") || !pi.events?.emit) return undefined;
  const event: LateStageMessageEvent = { handled: false, messages, options, batch };
  pi.events.emit(LATE_STAGE_MESSAGE_EVENT, event as unknown as Record<string, unknown>);
  if (!event.handled) return undefined;
  return event.completion ?? Promise.resolve();
}

function makeWorkflowStageOrchestrationContext(
  meta: StageExecutionMeta,
  pi: RuntimeWiringSurface,
): NonNullable<CreateAgentSessionOptions["orchestrationContext"]> {
  return {
    kind: "workflow-stage",
    workflowRunId: meta.runId,
    workflowStageId: meta.stageId,
    workflowStageName: meta.stageName,
    constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
    lateMessageRouter: {
      routeMessage(message, options) {
        const intercomRoute = emitLateIntercomRoute(pi, [message], options, false);
        if (intercomRoute) return intercomRoute;
        if (!pi.sendMessage) throw new Error("atomic-workflows: main-chat late-message route is unavailable");
        return pi.sendMessage(message, options);
      },
      routeMessages(messages, options) {
        const intercomRoute = emitLateIntercomRoute(pi, messages, options, true);
        if (intercomRoute) return intercomRoute;
        if (pi.sendMessages) return pi.sendMessages(messages, options);
        const sendMessage = pi.sendMessage;
        if (!sendMessage) throw new Error("atomic-workflows: main-chat late-message route is unavailable");
        return (async () => {
          for (const [index, message] of messages.entries()) {
            await sendMessage(message, index === 0 ? options : { deliverAs: "followUp" });
          }
        })();
      },
    },
  };
}

function withWorkflowStageSessionOptions(
  options: CreateAgentSessionOptions,
  meta: StageExecutionMeta | undefined,
  pi: RuntimeWiringSurface,
): CreateAgentSessionOptions {
  // Workflow stage sessions should never see the workflow tool, even when older
  // meta-less callers cannot receive the richer runtime orchestration context.
  // Non-interactive workflow runs also remove ask_user_question so child agents
  // cannot block unattended automation on a prompt that no user can answer.
  const policyExcludedTools = meta?.executionMode === "non_interactive"
    ? ["workflow", "ask_user_question"]
    : ["workflow"];
  const excludedTools = Array.from(
    new Set([...(options.excludedTools ?? []), ...policyExcludedTools]),
  );
  return {
    ...options,
    excludedTools,
    ...(meta
      ? { orchestrationContext: meta.orchestrationContext ?? makeWorkflowStageOrchestrationContext(meta, pi) }
      : {}),
  };
}

function shouldBindStageUiContext(pi: RuntimeWiringSurface, meta: StageExecutionMeta | undefined): boolean {
  if (meta?.executionMode === "non_interactive") return false;
  return pi.ui !== undefined || meta !== undefined;
}

function makeStageExtensionUiContext(
  ui: PiUISurface,
  meta: StageExecutionMeta | undefined,
  broker: StageUiBroker,
) {
  return {
    select: ui.select ?? (async () => undefined),
    confirm: ui.confirm ?? (async () => false),
    input: ui.input ?? (async () => undefined),
    notify: ui.notify ?? (() => undefined),
    onTerminalInput: ui.onTerminalInput ?? (() => () => undefined),
    setStatus: ui.setStatus ?? (() => undefined),
    setWorkingMessage: ui.setWorkingMessage ?? (() => undefined),
    setWorkingVisible: ui.setWorkingVisible ?? (() => undefined),
    setWorkingIndicator: ui.setWorkingIndicator ?? (() => undefined),
    setHiddenThinkingLabel: ui.setHiddenThinkingLabel ?? (() => undefined),
    setWidget: ui.setWidget ?? (() => undefined),
    setFooter: ui.setFooter ?? (() => undefined),
    setHeader: ui.setHeader ?? (() => undefined),
    setTitle: ui.setTitle ?? (() => undefined),
    custom: async <T = undefined>(factory: PiCustomOverlayFactory<T>, options?: PiCustomOverlayOptions): Promise<T> => {
      if (meta !== undefined) {
        return broker.requestCustomUi(
          meta.runId,
          meta.stageId,
          factory,
          options,
          meta.signal,
        );
      }
      if (ui.custom) {
        const result = await ui.custom(factory as PiCustomOverlayFactory, options ?? { overlay: true });
        return result as T;
      }
      throw new Error("atomic-workflows: ask_user_question UI is unavailable");
    },
    pasteToEditor: ui.pasteToEditor ?? (() => undefined),
    setEditorText: ui.setEditorText ?? (() => undefined),
    getEditorText: ui.getEditorText ?? (() => ""),
    editor: ui.editor ?? (async () => undefined),
    addAutocompleteProvider: ui.addAutocompleteProvider ?? (() => undefined),
    setEditorComponent: ui.setEditorComponent ?? (() => undefined),
    getEditorComponent: ui.getEditorComponent ?? (() => undefined),
    theme: ui.theme,
    getAllThemes: ui.getAllThemes ?? (() => []),
    getTheme: ui.getTheme ?? (() => undefined),
    setTheme: ui.setTheme ?? (() => ({ success: false, error: "atomic-workflows: theme UI is unavailable" })),
    getToolsExpanded: ui.getToolsExpanded ?? (() => false),
    setToolsExpanded: ui.setToolsExpanded ?? (() => undefined),
    getChatRenderSettings: ui.getChatRenderSettings ?? (() => undefined),
  };
}

/**
 * Build StageAdapters from available pi runtime surfaces.
 *
 * The resulting stage adapter creates an in-process pi SDK AgentSession
 * for each workflow stage. There is no subprocess and no custom NDJSON parsing
 * path here; stage.prompt() delegates directly to AgentSession.prompt().
 *
 * Session factory resolution (narrowest → widest):
 *   1. `options.createAgentSession` — per-call test seam.
 *   2. `pi.createAgentSession` — wiring-surface test seam.
 *   3. in-process test stub when running under `bun:test` / `node:test`.
 *   4. lazy dynamic import of `createAgentSession` from
 *      `@bastani/atomic` — the canonical production
 *      default (pi SDK ≥ 0.74 exposes it as a top-level package export,
 *      NOT on the `ExtensionAPI` surface).
 */
export function buildRuntimeAdapters(
  pi: RuntimeWiringSurface,
  options: RuntimeAdapterBuildOptions = {},
): StageAdapters {
  const createSession =
    options.createAgentSession ??
    pi.createAgentSession ??
    (isTestContext()
      ? createTestAgentSession
      : (sessionOptions?: CreateAgentSessionOptions) =>
        createPiSdkAgentSession(sessionOptions, {
          resourceLoaderInheritanceSnapshot: pi.getResourceLoaderInheritanceSnapshot?.(),
        }));
  const broker = options.stageUiBroker ?? stageUiBroker;
  const adapters: StageAdapters = {
    agentSession: {
      async create(stageOptions: CreateAgentSessionOptions & Pick<StageOptions, "mcp" | "fallbackModels">, meta?: StageExecutionMeta): Promise<StageSessionRuntime | StageSessionCreateResult> {
        // Atomic's SDK handles extension / skills / prompt-template /
        // slash-command discovery via the SettingsManager / ResourceLoader.
        // The production default deliberately uses normal DefaultResourceLoader
        // discovery so stage sessions inherit the same project/global theme,
        // extensions, tools, prompts, and skills as the parent chat. Callers
        // can still opt into a custom resource set by passing `resourceLoader`
        // through `stage(name, options)`.
        const sessionOptions = withWorkflowStageSessionOptions(
          stripWorkflowOnlyOptions(stageOptions) ?? {},
          meta,
          pi,
        );
        const result = await createSession(sessionOptions);
        const bindable = result.session as BindableStageSession;
        if (shouldBindStageUiContext(pi, meta) && typeof bindable.bindExtensions === "function") {
          await bindable.bindExtensions({
            uiContext: makeStageExtensionUiContext(pi.ui ?? {}, meta, broker),
          });
        }
        return result;
      },
    },
  };

  return adapters;
}
