import type {
  ChatMessageEntry,
  ChatMessageRenderOptions,
  ChatSessionHost,
  ReadonlyFooterDataProvider,
} from "@bastani/atomic";
import type { EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import type { Store } from "../shared/store.js";
import type {
  MountedStageCustomUi,
  StageUiBroker,
} from "../shared/stage-ui-broker.js";
import type { RunStatus, StageNotice, StageStatus } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { PromptCardState } from "./prompt-card.js";

export const VIEW_LINE_COUNT = 32;
export const PROMPT_SCROLL_STEP_ROWS = 4;
export const HEADER_ROWS = 1;
export const SEP_ROWS = 1;
export const STAGE_CHAT_MOUSE_SCROLL_TOGGLE_LABEL = "ctrl+t";

export function isReadOnlyArchiveStatus(status: StageStatus): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

export interface StageChatViewOpts {
  store: Store;
  graphTheme: GraphTheme;
  runId: string;
  stageId: string;
  /** The workflow display name, used in the title chrome `<workflow> / <stage>`. */
  workflowName: string;
  /**
   * Live stage-control handle when available. When absent the chat is
   * inspect-only (settled stage with no live handle).
   */
  handle?: StageControlHandle;
  /** Called when the user presses Ctrl+D (back to graph). */
  onDetach: (reason?: StageChatDetachReason, metadata?: StageChatDetachMetadata) => void;
  /** Called when the user presses Escape (close the whole popup). */
  onClose: () => void;
  /** Request a host TUI repaint after SDK events mutate local chat state. */
  requestRender?: () => void;
  /**
   * Re-assert overlay keyboard focus. Showing a stage custom UI (e.g. the
   * readiness gate) must make the overlay the focused pi-tui component again,
   * otherwise key events keep going elsewhere and the UI looks frozen (#1120).
   */
  requestFocus?: () => void;
  /** Live pi-tui host objects. When present, stage input uses pi's editor UI. */
  piTui?: TUI;
  piTheme?: unknown;
  piKeybindings?: unknown;
  /** Currently installed host editor factory, inherited from extension `ctx.ui.setEditorComponent()`. */
  piEditorFactory?: (
    tui: TUI,
    theme: EditorTheme,
    keybindings: unknown,
  ) => EditorComponent;
  /** Parent chat rendering settings and extension renderers inherited from the host UI. */
  getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>
    | undefined;
  /** Parent host expansion state for tool-output/live-detail widgets. */
  getToolsExpanded?: () => boolean;
  /** Toggle parent host expansion state for tool-output/live-detail widgets. */
  setToolsExpanded?: (expanded: boolean) => void;
  /** Parent footer data provider inherited from the host UI for core footer/usage rendering. */
  footerData?: ReadonlyFooterDataProvider;
  /**
   * Optional accessor returning the current terminal row count. The chat
   * surface expands its body band to roughly `viewportRows` minus the fixed
   * header / loader / editor / footer rows so the popup fills the
   * terminal under pi-tui's `width: "100%" / maxHeight: "100%"` geometry.
   * Returning `undefined` falls back to the constant 32-row frame.
   */
  getViewportRows?: () => number | undefined;
  /** Broker that routes stage-local custom UI, such as ask_user_question, into this node. */
  stageUiBroker?: StageUiBroker;
  /**
   * Ownership guard for prompt submission. The attach shell uses this to ensure
   * stale/hidden/non-active stage-chat instances cannot settle a prompt unless
   * the user is currently attached to this exact workflow node.
   */
  canSubmitPrompt?: (runId: string, stageId: string, promptId: string) => boolean;
}

export type StageChatDetachReason = "user" | "prompt-resolved";

export interface StageChatDetachMetadata {
  readonly suppressNextGraphSubmit?: boolean;
}

export interface NoticeEntry {
  readonly role: "notice";
  readonly text: string;
  readonly noticeId: string;
  readonly kind: StageNotice["kind"];
  readonly value: string;
  readonly from?: string;
  readonly meta?: string;
}

export type TranscriptEntry = NoticeEntry | ChatMessageEntry;

export interface TranscriptDebugEntry {
  readonly role: string;
  readonly text: string;
  readonly toolCallId: string;
  readonly state: string;
  readonly output: string;
}

export interface PaintOpts {
  bold?: boolean;
  italic?: boolean;
  bg?: string;
}

export interface StageChatViewContext {
  focused: boolean;
  store: Store;
  theme: GraphTheme;
  runId: string;
  stageId: string;
  workflowName: string;
  handle: StageControlHandle | undefined;
  onDetach: (reason?: StageChatDetachReason, metadata?: StageChatDetachMetadata) => void;
  onClose: () => void;
  requestRender: (() => void) | undefined;
  requestFocus: (() => void) | undefined;
  focusHoldTimer: ReturnType<typeof setInterval> | undefined;
  getViewportRows: (() => number | undefined) | undefined;
  piTui: TUI | undefined;
  piTheme: unknown;
  piKeybindings: unknown;
  piEditorFactory: StageChatViewOpts["piEditorFactory"] | undefined;
  getToolsExpanded: (() => boolean) | undefined;
  setToolsExpanded: ((expanded: boolean) => void) | undefined;
  chatHost: ChatSessionHost<NoticeEntry>;
  stageUiBroker: StageUiBroker;
  canSubmitPrompt: ((runId: string, stageId: string, promptId: string) => boolean) | undefined;
  mountedCustomUi: MountedStageCustomUi | null;
  mountingRequestId: string | null;
  promptState: PromptCardState | null;
  promptEditor: EditorComponent | null;
  promptEditorPromptId: string | null;
  promptEditorSubmitFromEnter: boolean;
  promptScrollOffset: number;
  promptMaxScroll: number;
  localPaused: boolean;
  mouseScrollCaptureEnabled: boolean;
  lastObservedStageStatus: StageStatus | undefined;
  lastObservedRunStatus: RunStatus | undefined;
  seenNoticeIds: Set<string>;
  _unsubscribeStore: (() => void) | null;
  _unsubscribeHandle: (() => void) | null;
  _unregisterStageUiHost: (() => void) | null;
}
