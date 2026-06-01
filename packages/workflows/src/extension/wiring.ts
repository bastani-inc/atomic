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

import { basename } from "node:path";
import type { ChatMessageRenderOptions, CreateAgentSessionOptions } from "@bastani/atomic";
import type { StageAdapters, StageSessionCreateResult, StageSessionRuntime } from "../runs/foreground/stage-runner.js";
import type { StageExecutionMeta, StageOptions } from "../shared/types.js";
import { stageUiBroker, type StageUiBroker } from "../shared/stage-ui-broker.js";

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

export interface RuntimeWiringSurface {
  exec?: (command: string, args: string[], opts?: PiExecOpts) => Promise<PiExecResult>;
  ui?: PiUISurface;
  /** Test seam: inject a stub session factory instead of importing the SDK. */
  createAgentSession?: (options?: CreateAgentSessionOptions) => Promise<StageSessionCreateResult>;
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

/**
 * Lazily-resolved pi SDK session factory. Imported from
 * `@bastani/atomic` on first use so the heavy SDK module
 * (filesystem discovery, resource loader, model registry) is not loaded
 * until an actual workflow stage runs. This is the canonical production
 * default — the modern pi SDK (≥ 0.74) exposes `createAgentSession` as a
 * top-level package export and does NOT inject it onto the ExtensionAPI,
 * so the workflow extension must reach into the SDK directly.
 *
 * cross-ref: node_modules/@bastani/atomic/docs/sdk.md
 *            node_modules/@bastani/atomic/dist/core/sdk.d.ts
 */
export interface PiSdkSettingsManager {
  getCodexFastModeSettings(): { readonly chat: boolean; readonly workflow: boolean };
}
export interface PiSdkResourceLoader {
  reload(): Promise<void>;
}
interface PiSdkSessionManager {
  getCwd(): string;
}
export interface PiCodingAgentSdk {
  getAgentDir(): string;
  getBuiltinPackagePaths?: () => string[];
  SettingsManager: {
    create(cwd?: string, agentDir?: string): PiSdkSettingsManager;
  };
  DefaultResourceLoader: new (options: {
    cwd: string;
    agentDir: string;
    settingsManager?: PiSdkSettingsManager;
    builtinPackagePaths?: string[];
  }) => PiSdkResourceLoader;
  createAgentSession(options?: AtomicCreateAgentSessionOptions): Promise<{ session: StageSessionRuntime }>;
}
type AtomicCreateAgentSessionOptions = Omit<CreateAgentSessionOptions, "settingsManager" | "resourceLoader" | "sessionManager"> & {
  settingsManager?: PiSdkSettingsManager;
  resourceLoader?: PiSdkResourceLoader;
  sessionManager?: PiSdkSessionManager;
};

function resolveSessionCwd(options: AtomicCreateAgentSessionOptions | undefined): string {
  return options?.cwd ?? options?.sessionManager?.getCwd() ?? process.cwd();
}

/**
 * Prepare Atomic SDK stage-session options with Atomic-first resource loading.
 *
 * The Atomic SDK's documented defaults are intentionally significant:
 * omitted `agentDir` means credentials/models/settings can be read from the
 * primary `~/.atomic/agent` paths first while still considering legacy
 * `~/.pi/agent` compatibility paths when the SDK supports multiple config
 * directories. Passing the computed default back as an explicit `agentDir`
 * would accidentally turn that multi-dir behavior into a single-dir override.
 *
 * A user-supplied `agentDir` is still preserved exactly and remains an
 * explicit override. A user-supplied `resourceLoader` is also preserved; in
 * that case cwd/agentDir no longer control resource discovery and only affect
 * session naming/tool path resolution, matching the pi SDK docs.
 */
export async function prepareAtomicStageSessionOptions(
  options: CreateAgentSessionOptions | undefined,
  sdk: PiCodingAgentSdk,
): Promise<AtomicCreateAgentSessionOptions | undefined> {
  const atomicOptions = options as AtomicCreateAgentSessionOptions | undefined;
  if (atomicOptions?.resourceLoader !== undefined) return atomicOptions;

  const cwd = resolveSessionCwd(atomicOptions);
  const hasAgentDirOverride = atomicOptions?.agentDir !== undefined;
  const agentDir = atomicOptions?.agentDir ?? sdk.getAgentDir();
  const settingsManager =
    atomicOptions?.settingsManager ?? sdk.SettingsManager.create(cwd, agentDir);
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    builtinPackagePaths: stageBuiltinPackagePaths(sdk.getBuiltinPackagePaths?.() ?? []),
  });
  await resourceLoader.reload();

  return {
    ...atomicOptions,
    cwd,
    ...(hasAgentDirOverride ? { agentDir } : {}),
    settingsManager,
    resourceLoader,
  };
}

function stageBuiltinPackagePaths(paths: readonly string[]): string[] {
  // Workflow stages are child AgentSessions owned by the workflow extension.
  // Loading the workflows extension again inside that child session replays its
  // `session_start` lifecycle and clears/kills the parent workflow store. Keep
  // the other builtin packages (subagents, mcp, web-access, intercom), but do
  // not recursively install workflows into workflow stage sessions.
  return paths.filter((path) => basename(path) !== "workflows");
}

async function createPiSdkAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<StageSessionCreateResult> {
  const sdk = await import("@bastani/atomic") as PiCodingAgentSdk;
  const sessionOptions = await prepareAtomicStageSessionOptions(options, sdk);
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
      return { summary: "", firstKeptEntryId: "", tokensBefore: 0 };
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
  const { mcp: _mcp, fallbackModels: _fallbackModels, ...sessionOptions } = maybeWorkflowOptions;
  return sessionOptions as CreateAgentSessionOptions;
}

function makeWorkflowStageOrchestrationContext(meta: StageExecutionMeta): NonNullable<CreateAgentSessionOptions["orchestrationContext"]> {
  return {
    kind: "workflow-stage",
    workflowRunId: meta.runId,
    workflowStageId: meta.stageId,
    workflowStageName: meta.stageName,
    constraints: {
      disableWorkflowTool: true,
      maxSubagentDepth: 1,
    },
  };
}

function withWorkflowStageSessionOptions(
  options: CreateAgentSessionOptions,
  meta: StageExecutionMeta | undefined,
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
    ...(meta ? { orchestrationContext: makeWorkflowStageOrchestrationContext(meta) } : {}),
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
    (isTestContext() ? createTestAgentSession : createPiSdkAgentSession);
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

// ---------------------------------------------------------------------------
// UI adapter — maps pi ctx.ui dialog surface to WorkflowUIAdapter
// ---------------------------------------------------------------------------

/**
 * Subset of pi's ExtensionUIDialogOptions consumed by the adapter.
 * Structurally matched against @bastani/atomic
 * ExtensionUIDialogOptions.
 */
export interface PiUIDialogOptions {
  /** AbortSignal to programmatically dismiss the dialog. */
  signal?: AbortSignal;
  /** Timeout in milliseconds. */
  timeout?: number;
}

/**
 * Structural subset of pi-tui's `OverlayOptions` that this extension
 * consumes when mounting overlays via `ctx.ui.custom(factory, options)`.
 * Mirrors @earendil-works/pi-tui dist/tui.d.ts `OverlayOptions`.
 *
 * Only the fields actually forwarded by this extension are typed. Pi may
 * accept additional fields in the future; values pass through verbatim.
 */
export interface PiOverlayOptions {
  /** Overlay width — number = columns, "N%" = percent of terminal columns. */
  width?: number | string;
  /** Minimum overlay width in columns. */
  minWidth?: number;
  /** Overlay maximum height — number = rows, "N%" = percent of terminal rows. */
  maxHeight?: number | string;
  /** Anchor edge / corner. Pi-tui accepts named anchors like "center". */
  anchor?: string;
  /** Horizontal offset (columns) applied after anchor resolution. */
  offsetX?: number;
  /** Vertical offset (rows) applied after anchor resolution. */
  offsetY?: number;
  /** Explicit overlay top row (0-indexed) — overrides anchor vertical. */
  row?: number;
  /** Explicit overlay left column (0-indexed) — overrides anchor horizontal. */
  col?: number;
  /** Margin inset, scalar or per-edge object. */
  margin?: number | { top?: number; right?: number; bottom?: number; left?: number };
  /** Responsive visibility predicate. */
  visible?: boolean | ((terminal: { rows: number; columns: number }) => boolean);
  /** When `true`, overlay does not capture focus. */
  nonCapturing?: boolean;
}

export interface PiCustomComponent {
  render(width: number): string[];
  handleInput?: (data: string) => void;
  invalidate?: () => void;
  dispose?: () => void;
}

/**
 * Handle exposed by pi's TUI for controlling a live overlay. Mirrors the
 * shape from @earendil-works/pi-tui `OverlayHandle` — `setHidden(true)`
 * temporarily hides the overlay (cheap to flip on/off, used for a
 * show/hide toggle), `hide()` permanently dismisses it.
 */
export interface PiOverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
}

/**
 * Options accepted by Pi/pi's real `ctx.ui.custom(factory, options)`
 * overlay primitive. Aligned with the shape documented in
 * `@bastani/atomic docs/tui.md` and
 * `@earendil-works/pi-tui dist/tui.d.ts`.
 *
 * Host-compatibility note: pi's interactive
 * `ExtensionUiController.custom` hardcodes the overlay geometry when
 * `overlay: true` to `{ anchor: "bottom-center", width: "100%",
 * maxHeight: "100%", margin: 0 }`, and does NOT forward this object's
 * `overlayOptions` field. Consumers MUST NOT rely on `overlayOptions`
 * for actual placement in interactive pi mode — the field is
 * retained for forward-compatibility (future hosts and the test seam
 * may consume it).
 *
 * Workflow pickers (`session-overlays.ts`, `inputs-overlay.ts`) mount
 * with `overlay: false`, which causes the host to REPLACE the editor
 * with the picker inline at the editor's natural position — see
 * those files for rationale and `ui/workflows/Screenshot 2026-05-13
 * at 1.11.49 AM.png` for the target spacing.
 *
 * `onHandle` is honoured today only by the full-screen graph overlay
 * (`overlay-adapter.ts`); inline pickers leave it unset and dismiss
 * via the factory `done()` callback.
 */
export interface PiCustomOverlayOptions {
  /**
   * `true` mounts a floating popup; `false` mounts a focused
   * full-screen pi-tui pane that takes keyboard focus and renders in
   * place of the editor until the factory's `done()` callback fires.
   */
  overlay: boolean;
  /**
   * Geometry / anchoring intended for pi-tui's `resolveOverlayLayout`.
   * NOT forwarded by current pi interactive `custom()` — see
   * the host-compatibility note above. Treat as advisory metadata
   * until the host wires it through.
   */
  overlayOptions?: PiOverlayOptions;
  /**
   * Optional callback invoked with the OverlayHandle once pi-tui
   * mounts the overlay. Use to drive show/hide toggles without
   * re-mounting. Only the full-screen graph overlay path consumes
   * this today; inline pickers leave it unset and dismiss via the
   * factory `done()` callback.
   */
  onHandle?: (handle: PiOverlayHandle) => void;
}

/**
 * Surface of the Pi `TUI` instance exposed to overlay factories. The
 * `terminal` accessor is optional because some host implementations and
 * test mocks do not surface it; consumers must handle `undefined`.
 */
export interface PiCustomOverlayFactoryTui {
  requestRender?: () => void;
  terminal?: { rows?: number; columns?: number };
  setFocus?: (target: unknown) => void;
  start?: () => void;
  stop?: () => void;
  [key: string]: unknown;
}

export type PiTheme = unknown;
export type PiKeybindings = unknown;

export type PiCustomOverlayFactory<T = unknown> = (
  tui: PiCustomOverlayFactoryTui,
  theme: PiTheme,
  keybindings: PiKeybindings,
  done: (result: T) => void,
) => PiCustomComponent | Promise<PiCustomComponent>;

export type PiCustomOverlayFunction = (
  factory: PiCustomOverlayFactory,
  options: PiCustomOverlayOptions,
) => Promise<unknown> | unknown;

/**
 * Structural shape of pi's custom editor component. Interactive mode
 * currently installs extension editors through `InteractiveMode.setEditorComponent`,
 * which expects the richer `CustomEditor` surface and configures these methods
 * before mounting. Keep the extra methods optional for lightweight tests and
 * non-interactive shims, but real custom editors should implement them.
 *
 * The resize-handler contract (`setTopBorder` / `getTopBorderAvailableWidth`)
 * is invoked unconditionally by `InteractiveMode`'s `process.stdout` "resize"
 * listener — any custom editor mounted via `setEditorComponent` MUST provide
 * them or the host throws `TypeError` on the first terminal resize.
 */
export interface PiEditorComponent {
  focused?: boolean;
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
  onSubmit?: (text: string) => void | Promise<void>;
  onChange?: (text: string) => void;
  onAutocompleteCancel?: () => void;
  onAutocompleteUpdate?: () => void;
  setUseTerminalCursor?(useTerminalCursor: boolean): void;
  getUseTerminalCursor?(): boolean;
  setAutocompleteMaxVisible?(maxVisible: number): void;
  getAutocompleteMaxVisible?(): number;
  setMaxHeight?(maxHeight: number | undefined): void;
  setHistoryStorage?(storage: object): void;
  setActionKeys?(action: string, keys: readonly string[]): void;
  setCustomKeyHandler?(key: string, handler: () => void): void;
  removeCustomKeyHandler?(key: string): void;
  clearCustomKeyHandlers?(): void;
  setAutocompleteProvider?(provider: object): void;
  addToHistory?(text: string): void;
  insertTextAtCursor?(text: string): void;
  getExpandedText?(): string;
  setPaddingX?(padding: number): void;
  setTopBorder?(content: unknown): void;
  getTopBorderAvailableWidth?(terminalWidth: number): number;
}

export type PiEditorFactory = (
  tui: { requestRender?: () => void },
  theme: unknown,
  keybindings: unknown,
) => PiEditorComponent;

/**
 * Structural type for the pi UI dialog surface.
 * Matches @bastani/atomic ExtensionUIContext dialog methods.
 * All fields optional — presence is checked at runtime before building adapter.
 */
export interface PiUISurface {
  /** Show a text input dialog. Returns undefined when user dismisses. */
  input?: (title: string, placeholder?: string, opts?: PiUIDialogOptions) => Promise<string | undefined>;
  /** Show a confirmation dialog. */
  confirm?: (title: string, message: string, opts?: PiUIDialogOptions) => Promise<boolean>;
  /** Show a selector and return the user's choice. Returns undefined when user dismisses. */
  select?: (title: string, options: string[], opts?: PiUIDialogOptions) => Promise<string | undefined>;
  /** Show a multi-line editor. Returns undefined when user dismisses. */
  editor?: (title: string, prefill?: string) => Promise<string | undefined>;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  onTerminalInput?: (handler: unknown) => () => void;
  setStatus?: (key: string, text: string | undefined) => void;
  setWorkingMessage?: (message?: string) => void;
  setWorkingVisible?: (visible: boolean) => void;
  setWorkingIndicator?: (options?: unknown) => void;
  setHiddenThinkingLabel?: (label?: string) => void;
  /** Set a live widget above or below the editor. */
  setWidget?: (
    key: string,
    factory:
      | string[]
      | ((tui: unknown, theme: unknown) => { render(width: number): string[]; dispose?(): void })
      | undefined,
    opts?: { placement?: string },
  ) => void;
  setFooter?: (factory: unknown) => void;
  setHeader?: (factory: unknown) => void;
  setTitle?: (title: string) => void;
  /** Show a custom component or overlay. */
  custom?: PiCustomOverlayFunction;
  pasteToEditor?: (text: string) => void;
  setEditorText?: (text: string) => void;
  getEditorText?: () => string;
  addAutocompleteProvider?: (factory: unknown) => void;
  /**
   * Install a custom editor (replaces the bottom input bar) until cleared
   * with `setEditorComponent(undefined)`. Used by the inline workflow
   * input form to capture per-field keystrokes.
   * cross-ref: docs/extensions.md §Custom Editor (pi-coding-agent).
   */
  setEditorComponent?: (factory: PiEditorFactory | undefined) => void;
  /** Return the currently-installed editor factory, or undefined for the default. */
  getEditorComponent?: () => PiEditorFactory | undefined;
  /** Current resolved Pi theme and theme helpers, forwarded to stage extensions. */
  theme?: unknown;
  getAllThemes?: () => Array<{ name: string; path: string | undefined }>;
  getTheme?: (name: string) => unknown;
  setTheme?: (theme: string | unknown) => { success: boolean; error?: string };
  getToolsExpanded?: () => boolean;
  setToolsExpanded?: (expanded: boolean) => void;
  getChatRenderSettings?: () => Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">> | undefined;
}

/**
 * Runtime surface that includes the optional UI dialog surface.
 * Used by command/overlay code (slash command kill confirm, graph overlay
 * mount, picker overlays) to interact with `pi.ui.custom`, `pi.ui.confirm`,
 * etc. Workflow-level HIL routing — `ctx.ui.input/confirm/select/editor`
 * inside a workflow body — stays in the store-backed background adapter.
 * In-stage `ask_user_question` uses this surface to bind the live pi UI into
 * SDK stage sessions.
 */
export interface UIWiringSurface {
  ui?: PiUISurface;
}
