import type { ChatMessageRenderOptions, ReadonlyFooterDataProvider } from "@bastani/atomic";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { Store } from "../shared/store.js";
import type { StageUiBroker } from "../shared/stage-ui-broker.js";
import type { GraphTheme } from "./graph-theme.js";
import type { StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { EnsurePostMortemStageHandleResult } from "../runs/foreground/postmortem-stage-chat.js";

export interface AttachUiStatusSurface {
  setStatus?: (key: string, value: string | undefined) => void;
}

export type PostMortemHandleResolution = EnsurePostMortemStageHandleResult | undefined;

export interface WorkflowAttachPaneOpts {
  store: Store;
  graphTheme: GraphTheme;
  runId: string | null;
  /**
   * Live stage-control registry. The pane resolves stage handles when
   * the user attaches to a node. Defaults to the singleton registry.
   */
  stageControlRegistry?: StageControlRegistry;
  /**
   * Resolver that revives an interactive post-mortem chat handle for an
   * eligible terminal agent stage that has a valid retained session but no
   * process-local handle (generic attach/connect, restored/replayed durable
   * snapshots). Unavailable results retain their reason so the pane can render
   * a truthful actionable read-only fallback. Called only after a live
   * `stageControlRegistry.get()` miss.
   */
  resolvePostMortemHandle?: (runId: string, stageId: string) => PostMortemHandleResolution;
  /** Broker used to route stage-local custom UI such as ask_user_question into attached chats. */
  stageUiBroker?: StageUiBroker;
  /**
   * Optional UI status surface. When present, attaching/detaching
   * updates the `pi-workflows` status tag with `<workflow>/<stage>`.
   */
  uiStatus?: AttachUiStatusSurface;
  /** Called when the user closes (Escape in graph mode). */
  onClose: () => void;
  /** Called when the user requests the host to hide the popup. */
  onHide?: () => void;
  /** Called when the user quits/detaches the active run (q in graph mode). */
  onQuit?: (runId: string) => void;
  /** Called when the user resolves a HIL prompt via the graph view. */
  onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  /** Live pi-tui host objects used by attached stage chat to reuse coding-agent editor UI. */
  piTui?: TUI;
  piTheme?: unknown;
  piKeybindings?: unknown;
  /** Host custom editor factory installed by extensions via ctx.ui.setEditorComponent(). */
  piEditorFactory?: (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;
  /** Parent chat rendering settings and extension renderers, inherited from the host UI. */
  getChatRenderSettings?: () => Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">> | undefined;
  /** Parent host tool-output/live-detail expansion state, inherited from the host UI. */
  getToolsExpanded?: () => boolean;
  /** Parent host tool-output/live-detail expansion setter, inherited from the host UI. */
  setToolsExpanded?: (expanded: boolean) => void;
  /** Parent footer data provider, inherited so attached chats can render the core coding-agent footer. */
  footerData?: ReadonlyFooterDataProvider;
  /**
   * Optional override: pre-select chat mode for a stage on construction.
   * Used by `/workflow attach <runId> <stageId>` so the popup opens
   * directly on the node's chat.
   */
  initialAttachStageId?: string;
  /** Owning nested run for `initialAttachStageId`; omitted stages resolve through the root graph. */
  initialAttachRunId?: string;
  /**
   * Optional accessor returning the current terminal row count. Threaded
   * into both `GraphView` and `StageChatView` so the overlay renders a
   * frame that fills the full viewport instead of a fixed 32-row pane.
   * Returns `undefined` when the host has not surfaced terminal
   * dimensions; views fall back to their constant row budget.
   */
  getViewportRows?: () => number | undefined;
  /**
   * Render-tick callback supplied by the overlay host. Forwarded to the
   * embedded `GraphView` so its 10 FPS animation tick (running-stage
   * border pulse, duration counter) can request frames without a key
   * press. The host gates the underlying `tui.requestRender` on overlay
   * visibility so a hidden pane stays cheap.
   */
  requestRender?: () => void;
  /**
   * Host hook to re-assert overlay keyboard focus. Threaded into the attached
   * stage chat so showing a broker custom UI (e.g. the readiness gate) refocuses
   * the overlay and the UI is not left input-dead (#1120).
   */
  requestFocus?: () => void;
  /**
   * Host hook for terminal mouse reporting. Graph mode uses wheel input
   * for canvas scrolling. Stage-chat mode captures wheel input by default so
   * transcript/prompt scrolling stays inside the active workflow chat; ctrl+t
   * toggles copy mode, which disables capture for terminal text selection.
   */
  setMouseScrollTracking?: (enabled: boolean) => void;
  /** Optional clock injection for deterministic transition-quarantine tests. */
  now?: () => number;
}

export type WorkflowAttachPaneMode = "graph" | "stage-chat";

