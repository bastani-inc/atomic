import type { ChatMessageRenderOptions } from "@bastani/atomic";

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
export interface PiHostCustomUiState {
  blockingInlineCustomUiDepth: number;
  blockingInlineCustomUiActive: boolean;
  blockingInlineCustomUiFocusDeferred?: boolean;
}

export type PiHostCustomUiStateListener = (state: PiHostCustomUiState) => void;

export interface PiCustomOverlayOptions {
  /**
   * `true` mounts a floating popup; `false` mounts a focused
   * full-screen pi-tui pane that takes keyboard focus and renders in
   * place of the editor until the factory's `done()` callback fires.
   */
  overlay: boolean;
  /** Keep host inline custom UI pending in the background while this overlay is visible. */
  deferInlineCustomUiFocus?: boolean;
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
  /** Get host-owned inline custom UI focus state, if exposed by the host. */
  getHostCustomUiState?: () => PiHostCustomUiState;
  /** Observe host-owned inline custom UI focus state changes, if exposed by the host. */
  onHostCustomUiStateChange?: (listener: PiHostCustomUiStateListener) => () => void;
  /** Move focus to a mounted host-owned inline custom UI, if one is pending. */
  focusHostInlineCustomUi?: () => boolean;
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
 * Used by command/overlay code (graph mounts and picker overlays) to interact with `pi.ui.custom`, `pi.ui.confirm`,
 * etc. Workflow-level HIL routing — `ctx.ui.input/confirm/select/editor`
 * inside a workflow body — stays in the store-backed background adapter.
 * In-stage `ask_user_question` uses this surface to bind the live pi UI into
 * SDK stage sessions.
 */
export interface UIWiringSurface {
  ui?: PiUISurface;
}
