/**
 * GraphView — orchestrator overlay rendered as a pi-tui Component.
 *
 * Visual contract (DESIGN.md):
 *  - No manual ASCII frame. `pi.ui.custom({ overlay: true })` provides the
 *    popup chrome; this renderer leaves one unpainted row above and below
 *    the panel, then paints content on the canvas (`bg`) with full-width
 *    chrome rows for the header (top) and hints (bottom).
 *  - Section labels use the `  LABEL` pattern: mauve glyph + `textMuted`
 *    bold caps.
 *  - Hints follow `<key> <label>` separated by ` · ` in `dim`, active key
 *    letters in `text`, labels in `textMuted`.
 *  - No decorative progress bar. Counts live in the header pills.
 *
 * cross-ref:
 *   - github.com/bastani-inc/atomic packages/atomic-sdk/src/components/session-graph-panel.tsx
 *   - DESIGN.md §4 (Elevation), §5 (Components)
 */
import type { Component } from "@earendil-works/pi-tui";
import {
  Key,
  matchesKey,
  sliceColumns,
  truncateToWidth,
  visibleWidth,
} from "./text-helpers.js";
import type { Store } from "../shared/store.js";
import type {
  PendingPrompt,
  StageSnapshot,
  StoreSnapshot,
  RunSnapshot,
} from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { SwitcherState } from "./switcher.js";
import type { LayoutNode } from "./layout.js";
import {
  expandWorkflowGraph,
  expandedStageTarget,
  type ExpandedWorkflowGraph,
  type ExpandedWorkflowStage,
} from "../shared/expanded-workflow-graph.js";
import { computeLayout, NODE_W, NODE_H } from "./layout.js";
import { renderHeader, renderOutlinePill } from "./header.js";
import { renderNodeCard } from "./node-card.js";
import { renderSwitcher, filterStages } from "./switcher.js";
import { renderToasts, createToastManager } from "./toast.js";
import { hexToAnsi, hexBg, RESET, BOLD } from "./color-utils.js";
import { GraphCanvas } from "./graph-canvas.js";
import {
  createPromptCardState,
  defaultResponseFor,
  handlePromptCardInput,
  renderPromptCard,
  type PromptCardState,
} from "./prompt-card.js";
import { isKeybindingsLike, type KeybindingsLike } from "./keybindings-adapter.js";

export type GraphViewMode = "overlay" | "widget";

export interface GraphViewOpts {
  mode: GraphViewMode;
  runId: string | null;
  store: Store;
  graphTheme: GraphTheme;
  onClose?: () => void;
  /**
   * Invoked when the user presses `q` inside the pane on an in-flight
   * run. Fires immediately (no confirm) per the toggle-driven UX:
   * `h` hides without quitting; `q` is reserved for terminating the
   * current run.
   */
  onKill?: (runId: string) => void;
  /**
   * Invoked when the user presses `h` inside the pane. Hides without
   * unmounting (overlay-adapter calls `setHidden(true)`). Re-open via
   * `F2` or `/workflow connect <id>`.
   */
  onHide?: () => void;
  /**
   * Invoked when the user submits (or skips) a HIL prompt rendered inside
   * the pane. The callback typically calls `store.resolvePendingPrompt`;
   * GraphView itself stays UI-only.
   */
  onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  /**
   * Invoked when the user presses Enter on a focused graph node — the
   * parent attach shell swaps the popup interior to that stage's chat
   * pane. When unset, Enter is a no-op (preserves graph mode).
   */
  onStageAttach?: (runId: string, stageId: string) => void;
  /**
   * Invoked when the user presses `Ctrl+D` while in graph mode. Mirrors
   * the in-chat back affordance: detaches the whole popup (host calls
   * `setHidden(true)`). Falls back to `onHide` when unset.
   */
  onDetach?: () => void;
  /**
   * When provided, GraphView restores focus to this stage on construction
   * — used by the attach shell so returning from the chat lands the
   * cursor on the same node the user just attached to.
   */
  initialFocusedStageId?: string;
  /**
   * Optional accessor returning the current terminal row count. When
   * present in overlay mode the renderer expands the frame to roughly
   * `viewportRows` lines (clamped to at least the header + statusline
   * budget) so the popup fills the terminal under pi-tui's
   * `width: "100%" / maxHeight: "100%"` geometry. Returning `undefined`
   * falls back to the constant `OVERLAY_LINE_COUNT` rectangle.
   */
  getViewportRows?: () => number | undefined;
  /**
   * Invoked on each animation tick (~10 FPS) so the host can call
   * `tui.requestRender()`. Only wired in `overlay` mode; supplying it
   * starts the tick loop in the constructor so duration counters and
   * the running-stage border pulse refresh without requiring a key
   * press. The host is responsible for gating the underlying
   * `requestRender` on overlay visibility / focus (see
   * `overlay-adapter.ts`).
   */
  requestRender?: () => void;
  /** Host Pi keybindings manager used by run-level prompt cards. */
  piKeybindings?: unknown;
}

const HINT_KEYS: Array<{ key: string; label: string }> = [
  { key: "↑↓←→", label: "navigate" },
  { key: "↵", label: "attach" },
  { key: "/", label: "stages" },
  { key: "ctrl+d", label: "detach" },
  { key: "q", label: "kill" },
];

/**
 * Bottom mode pill. The status bar mirrors the top header band: a
 * three-row chrome strip with an outlined pill flush-left and hints
 * flowing right of it on the centre row.
 */
const MODE_PILL_LABEL = "GRAPH";

/**
 * Fixed line count emitted by `_renderOverlay`. pi-tui paints the
 * overlay in the same buffer as the chat, so a *variable* line count
 * causes the chat to scroll every time the focused-stage section grows
 * or shrinks — that's exactly the duplicate-rows bug we hit when
 * navigating with j/k. Padding to a constant height keeps the overlay
 * a stable rectangle that pi-tui can diff cell-by-cell.
 *
 * Mirrors the doom-overlay reference extension, which always emits the
 * same number of lines per frame regardless of game state.
 */
const OVERLAY_LINE_COUNT = 32;
const OVERLAY_VERTICAL_MARGIN_ROWS = 1;

/**
 * Animation tick period. Overlay re-renders fire on this cadence so
 * duration counters tick from active elapsed time (freezing while paused)
 * and the running-stage border lerps between `borderDim` and
 * `warning` without a key press. The host-supplied `requestRender`
 * gate prevents work while the overlay is hidden or unfocused.
 */
const ANIMATION_TICK_MS = 100;

/**
 * Full lerp period of `pulseT` for running-stage borders, in ms.
 * `pulsePhase ∈ [0, 1)` cycles every `PULSE_PERIOD_MS` so the sine
 * eased lerp inside `pickBorder` traces one full breath per cycle.
 */
const PULSE_PERIOD_MS = 2000;
const GRAPH_SCROLL_STEP_ROWS = 4;

export class GraphView implements Component {
  private mode: GraphViewMode;
  private runId: string | null;
  private store: Store;
  private graphTheme: GraphTheme;
  private onClose?: () => void;
  private onKill?: (runId: string) => void;
  private onHide?: () => void;
  private onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  private onStageAttach?: (runId: string, stageId: string) => void;
  private onDetach?: () => void;
  private initialFocusedStageId?: string;
  private getViewportRows?: () => number | undefined;
  private requestRender?: () => void;
  private piKeybindings?: unknown;

  /** Active HIL prompt state, set when `_rebuildLayout` sees a new prompt id. */
  private promptState: PromptCardState | null = null;

  private focusedIndex = 0;
  private switcherOpen = false;
  private switcherState: SwitcherState = { query: "", selectedIndex: 0 };
  private toastManager = createToastManager();
  private detailsExpanded = true;
  private cachedLayout: LayoutNode[] = [];
  private expandedGraph: ExpandedWorkflowGraph = { stages: [], targets: new Map() };
  private currentSnapshot: StoreSnapshot | null = null;
  private graphScrollOffset = 0;
  private graphScrollColOffset = 0;
  private pendingEnsureFocusedVisible = true;
  private lastAutoFocusedAwaitingInputKey: string | null = null;

  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _lastGTime: number | null = null;
  private _unsubscribe: (() => void) | null = null;

  constructor(opts: GraphViewOpts) {
    this.mode = opts.mode;
    this.runId = opts.runId;
    this.store = opts.store;
    this.graphTheme = opts.graphTheme;
    this.onClose = opts.onClose;
    this.onKill = opts.onKill;
    this.onHide = opts.onHide;
    this.onPromptResolve = opts.onPromptResolve;
    this.onStageAttach = opts.onStageAttach;
    this.onDetach = opts.onDetach;
    this.initialFocusedStageId = opts.initialFocusedStageId;
    this.getViewportRows = opts.getViewportRows;
    this.requestRender = opts.requestRender;
    this.piKeybindings = opts.piKeybindings;

    this._unsubscribe = this.store.subscribe((snap) => {
      this.currentSnapshot = snap;
      this._rebuildLayout();
    });
    this.currentSnapshot = this.store.snapshot();
    this._rebuildLayout();

    // Animation tick: while the overlay is mounted, fire a render
    // request every `ANIMATION_TICK_MS` so the duration counter on
    // each running stage advances and the border-pulse lerp animates
    // even when the user isn't pressing keys. Only overlay mode owns
    // visible animations; widget mode renders a single status line
    // that never needs a steady cadence. The host's `requestRender`
    // is responsible for gating on overlay visibility / focus — see
    // `overlay-adapter.ts` and `workflow-attach-pane.ts`. With that
    // gate in place the previous tmux scrollback "ghost overlay"
    // failure mode does not apply: pi-tui owns the screen buffer
    // and diff-blits frames in place.
    if (this.mode === "overlay" && this.requestRender) {
      this._intervalId = setInterval(() => {
        this.requestRender?.();
      }, ANIMATION_TICK_MS);
      (this._intervalId as { unref?: () => void }).unref?.();
    }
  }

  private _rebuildLayout(): void {
    const run = this._getCurrentRun();
    if (!run) {
      this.cachedLayout = [];
      this.expandedGraph = { stages: [], targets: new Map() };
      this.focusedIndex = 0;
      this.graphScrollOffset = 0;
      this.graphScrollColOffset = 0;
      this.pendingEnsureFocusedVisible = true;
      this.promptState = null;
      return;
    }

    const previousFocusedStageId = this.cachedLayout[this.focusedIndex]?.stage.id;
    const graphStages = this._graphStages(run);
    const nextLayout = computeLayout(graphStages, { orientation: "vertical" });
    this.cachedLayout = nextLayout;

    let focusNeedsReveal = this.pendingEnsureFocusedVisible;
    // One-shot: if the host passed `initialFocusedStageId`, snap the
    // cursor to that stage now that the layout exists. The attach shell
    // uses this when swapping back from chat mode so the focus lands on
    // the same node the user just attached to.
    if (this.initialFocusedStageId !== undefined) {
      const idx = this.cachedLayout.findIndex(
        (n) =>
          n.stage.id === this.initialFocusedStageId ||
          expandedStageTarget(this.expandedGraph, n.stage.id)?.stageId === this.initialFocusedStageId,
      );
      if (idx >= 0 && idx !== this.focusedIndex) {
        this.focusedIndex = idx;
        focusNeedsReveal = true;
      }
      this.initialFocusedStageId = undefined;
    } else if (previousFocusedStageId !== undefined) {
      const idx = this.cachedLayout.findIndex(
        (n) => n.stage.id === previousFocusedStageId,
      );
      if (idx >= 0 && idx !== this.focusedIndex) {
        this.focusedIndex = idx;
        focusNeedsReveal = true;
      }
    }

    const awaitingTarget = this._awaitingInputFocusTarget();
    if (awaitingTarget) {
      if (awaitingTarget.key !== this.lastAutoFocusedAwaitingInputKey) {
        this.focusedIndex = awaitingTarget.index;
        focusNeedsReveal = true;
        this.lastAutoFocusedAwaitingInputKey = awaitingTarget.key;
      }
    } else {
      this.lastAutoFocusedAwaitingInputKey = null;
    }

    if (this.cachedLayout.length === 0) {
      this.focusedIndex = 0;
      this.graphScrollOffset = 0;
      this.graphScrollColOffset = 0;
    } else if (this.focusedIndex >= this.cachedLayout.length) {
      this.focusedIndex = this.cachedLayout.length - 1;
      focusNeedsReveal = true;
    }
    this.pendingEnsureFocusedVisible = focusNeedsReveal;
    this._syncPromptState(run.pendingPrompt);
  }

  private _awaitingInputFocusTarget(): { index: number; key: string } | null {
    let newest: { index: number; key: string; createdAt: number } | null = null;
    for (let index = 0; index < this.cachedLayout.length; index++) {
      const stage = this.cachedLayout[index]!.stage;
      const target = this._awaitingInputKey(stage);
      if (!target) continue;
      if (!newest || target.createdAt >= newest.createdAt) {
        newest = { index, key: target.key, createdAt: target.createdAt };
      }
    }
    return newest ? { index: newest.index, key: newest.key } : null;
  }

  private _awaitingInputKey(stage: StageSnapshot): { key: string; createdAt: number } | null {
    const target = expandedStageTarget(this.expandedGraph, stage.id);
    const prefix = target ? `${target.runId}:${target.stageId}` : stage.id;
    if (stage.pendingPrompt) {
      return {
        key: `prompt:${prefix}:${stage.pendingPrompt.id}`,
        createdAt: stage.pendingPrompt.createdAt,
      };
    }
    if (stage.inputRequest) {
      return {
        key: `input-request:${prefix}:${stage.inputRequest.id}`,
        createdAt: stage.inputRequest.createdAt,
      };
    }
    if (stage.status === "awaiting_input") {
      return {
        key: `awaiting:${prefix}:${stage.awaitingInputSince ?? "active"}`,
        createdAt: stage.awaitingInputSince ?? stage.startedAt ?? 0,
      };
    }
    return null;
  }

  private _graphStages(run: RunSnapshot): ExpandedWorkflowStage[] {
    this.expandedGraph = this.currentSnapshot
      ? expandWorkflowGraph(this.currentSnapshot, run.id)
      : { stages: [], targets: new Map() };
    const stages = [...this.expandedGraph.stages];
    const hasStagePrompt = stages.some((stage) => stage.pendingPrompt !== undefined);
    if (!hasStagePrompt) return stages;
    return stages.filter((stage) => {
      // Prompt-node injection can leave unstarted author stages in the store
      // while the prompt node owns focus; hide only these inert placeholders.
      const isUnstartedPlaceholder =
        stage.status === "pending" &&
        stage.startedAt === undefined &&
        stage.pendingPrompt === undefined &&
        stage.toolEvents.length === 0;
      return !isUnstartedPlaceholder;
    });
  }

  /**
   * Mirror the run's `pendingPrompt` into a UI working state. A new prompt
   * id resets the state (caret + buffer); a cleared prompt drops the state
   * so the card disappears.
   */
  private _syncPromptState(prompt: PendingPrompt | undefined): void {
    if (!prompt) {
      this.promptState = null;
      return;
    }
    if (!this.promptState || this.promptState.prompt.id !== prompt.id) {
      this.promptState = createPromptCardState(prompt);
    }
  }

  private _getCurrentRun(): RunSnapshot | null {
    if (!this.currentSnapshot) return null;
    // Pin to the first run we see so a completed run stays visible after
    // `activeRunId()` clears. Caller can still pass an explicit runId.
    if (this.runId == null) {
      const activeId = this.store.activeRunId();
      if (activeId != null) {
        this.runId = activeId;
      }
    }
    if (this.runId == null) return null;
    return this.currentSnapshot.runs.find((r) => r.id === this.runId) ?? null;
  }

  /** Render to string lines. width = terminal columns. */
  render(width: number): string[] {
    if (this.mode === "widget") {
      return this._renderWidget(width);
    }
    return this._renderOverlay(width);
  }

  private _renderWidget(width: number): string[] {
    const run = this._getCurrentRun();
    if (!run) {
      return [`${hexToAnsi(this.graphTheme.dim)}no active workflow${RESET}`];
    }
    const displayStages = this._displayStages(run);
    const headerLines = renderHeader({ ...run, stages: displayStages }, { width, theme: this.graphTheme });
    const counts = this._counts(displayStages);
    const trailer =
      `${hexToAnsi(this.graphTheme.dim)}` +
      `${counts.completed}/${displayStages.length} done` +
      (counts.running > 0 ? ` · ${counts.running} running` : "") +
      (counts.failed > 0 ? ` · ${counts.failed} failed` : "") +
      (counts.blocked > 0 ? ` · ${counts.blocked} blocked` : "") +
      RESET;
    return [...headerLines, ` ${trailer}`];
  }

  /**
   * Number of rows the overlay frame must paint. Pi-tui anchors the
   * overlay vertically by counting rendered lines, so to truly fill the
   * terminal under `maxHeight: "100%"` the component must emit
   * approximately `terminal.rows` lines. When a host reports fewer
   * than the legacy 32 rows, honour that shorter viewport where the
   * graph chrome can still fit so the bottom status controls are not
   * clipped by pi-tui's overlay max-height slicing. A host that doesn't
   * surface terminal dimensions keeps the previous stable rectangle.
   */
  private _overlayLineCount(): number {
    const reported = this.getViewportRows?.();
    if (typeof reported !== "number" || !Number.isFinite(reported)) {
      return OVERLAY_LINE_COUNT;
    }
    // Header (3) + one body row + statusline (3) is the absolute
    // minimum useful frame. Margins are dropped automatically at this
    // size by `_overlayVerticalMarginRows`.
    return Math.max(7, Math.floor(reported));
  }

  /** Rows available for the graph body (between header and statusline). */
  private _overlayBodyRows(lineCount: number): number {
    return Math.max(1, lineCount - 3 /* header */ - 3 /* statusline */);
  }

  private _overlayVerticalMarginRows(lineCount = this._overlayLineCount()): number {
    return lineCount >= 9 ? OVERLAY_VERTICAL_MARGIN_ROWS : 0;
  }

  private _overlayPanelLineCount(): number {
    const lineCount = this._overlayLineCount();
    const margins = this._overlayVerticalMarginRows(lineCount) * 2;
    return Math.max(7, lineCount - margins);
  }

  private _marginRow(width: number): string {
    return " ".repeat(width);
  }

  private _withVerticalMargins(panelLines: string[], width: number): string[] {
    const expected = this._overlayLineCount();
    const marginRows = this._overlayVerticalMarginRows(expected);
    const panelTarget = this._overlayPanelLineCount();
    const body = panelLines.slice(0, panelTarget);
    while (body.length < panelTarget) body.push(this._blankRow(width));
    const margins = Array.from({ length: marginRows }, () => this._marginRow(width));
    const lines = [...margins, ...body, ...margins];
    if (lines.length > expected) return lines.slice(0, expected);
    while (lines.length < expected) {
      const insertAt = marginRows > 0 ? Math.max(0, lines.length - marginRows) : lines.length;
      lines.splice(insertAt, 0, this._blankRow(width));
    }
    return lines;
  }

  private _renderOverlay(width: number): string[] {
    const frameWidth = Math.max(40, width);
    const lines: string[] = [];
    const run = this._getCurrentRun();

    if (!run) {
      return this._renderEmptyState(frameWidth);
    }

    // 1. Header chrome (3 rows: outline pill + session name + counts).
    lines.push(
      ...renderHeader({ ...run, stages: this._displayStages(run) }, { width: frameWidth, theme: this.graphTheme }),
    );

    // 2. Graph occupies the full body. No section labels, no focused-
    //    stage panel — status colour on each card carries that signal.
    const graphLines = this._renderGraph(frameWidth);
    const bodyTarget = this._overlayBodyRows(this._overlayPanelLineCount());
    const visibleGraph = this._visibleGraphLines(
      graphLines,
      frameWidth,
      bodyTarget,
    );
    for (let i = 0; i < visibleGraph.topPad; i++)
      lines.push(this._blankRow(frameWidth));
    for (const line of visibleGraph.lines) {
      lines.push(this._canvasRow(line, frameWidth));
    }
    while (lines.length < 3 + bodyTarget)
      lines.push(this._blankRow(frameWidth));
    if (lines.length > 3 + bodyTarget) lines.length = 3 + bodyTarget;

    // 3. Switcher overlay — floats over the body when open.
    if (this.switcherOpen) {
      const bodyStart = 3;
      const bodyEnd = 3 + bodyTarget;
      for (let row = bodyStart; row < bodyEnd; row++) {
        lines[row] = this._blankRow(frameWidth);
      }
      const switcherWidth = Math.min(60, Math.max(40, frameWidth - 8));
      const switcherLines = renderSwitcher(this._displayStages(run), this.switcherState, {
        width: switcherWidth,
        theme: this.graphTheme,
      });
      const insertAt = Math.max(bodyStart, bodyStart + Math.min(2, Math.floor((bodyTarget - switcherLines.length) / 3)));
      const switcherLeft = Math.max(2, Math.floor((frameWidth - switcherWidth) / 2));
      for (let i = 0; i < switcherLines.length; i++) {
        const lineIdx = insertAt + i;
        if (lineIdx >= bodyEnd) break;
        const base = lines[lineIdx] ?? this._blankRow(frameWidth);
        const merged = this._overlayCard(base, switcherLines[i]!, switcherLeft, frameWidth);
        if (lineIdx < lines.length) lines[lineIdx] = merged;
        else lines.push(merged);
      }
    }

    // 4. Pending HIL prompt — floats over the graph body, centred. The
    //    chat editor remains free regardless: the overlay is the only
    //    surface that interacts with the prompt. When the stage switcher is
    //    open it owns the body/input, so hide the prompt card until it closes.
    if (this.promptState && !this.switcherOpen) {
      const cardWidth = Math.min(72, Math.max(40, frameWidth - 6));
      const cardLines = renderPromptCard({
        state: this.promptState,
        theme: this.graphTheme,
        width: cardWidth,
        cursorOn: ((Date.now() / 530) | 0) % 2 === 0,
      });
      const bodyStart = 3;
      const bodyEnd = 3 + bodyTarget;
      const slot = Math.max(
        bodyStart,
        bodyStart + Math.floor((bodyTarget - cardLines.length) / 2),
      );
      const leftPad = Math.max(0, Math.floor((frameWidth - cardWidth) / 2));
      for (let i = 0; i < cardLines.length; i++) {
        const lineIdx = slot + i;
        if (lineIdx >= bodyEnd) break;
        const base = lines[lineIdx] ?? this._blankRow(frameWidth);
        lines[lineIdx] = this._overlayCard(base, cardLines[i]!, leftPad, frameWidth);
      }
    }

    // 4. Toast overlay — top-right of header band.
    const toastLines = renderToasts(this.toastManager.active(), {
      theme: this.graphTheme,
    });
    if (toastLines.length > 0) {
      for (let i = 0; i < toastLines.length && i < lines.length; i++) {
        const existing = lines[i] ?? "";
        const merged = `${existing} ${toastLines[i]}`;
        lines[i] = truncateToWidth(merged, frameWidth, "", true);
      }
    }

    // 5. Three-row statusline pinned to the bottom.
    lines.push(...this._renderStatusline(frameWidth));

    return this._withVerticalMargins(lines, frameWidth);
  }

  private _renderEmptyState(width: number): string[] {
    const t = this.graphTheme;
    const muted = hexToAnsi(t.textMuted);
    const dim = hexToAnsi(t.dim);
    const accent = hexToAnsi(t.accent);
    const chromeBg = hexBg(t.backgroundPanel);

    const {
      top,
      mid,
      bot,
      visibleWidth: pillW,
    } = renderOutlinePill("ORCHESTRATOR", t.accent, chromeBg);
    const idleLabel = `  ${muted}idle${RESET}`;
    const fillerVisible = Math.max(0, width - 1 - pillW - 6 /* "  idle" */ - 2);
    const filler = " ".repeat(fillerVisible);
    const lines: string[] = [
      `${chromeBg} ${RESET}${top}${chromeBg}${" ".repeat(6 + fillerVisible)}${" ".repeat(2)}${RESET}`,
      `${chromeBg} ${RESET}${mid}${chromeBg}${idleLabel}${filler}${" ".repeat(2)}${RESET}`,
      `${chromeBg} ${RESET}${bot}${chromeBg}${" ".repeat(6 + fillerVisible)}${" ".repeat(2)}${RESET}`,
    ];
    const bodyTarget = this._overlayBodyRows(this._overlayPanelLineCount());
    const body: string[] = [
      this._canvasRow(`  ${muted}No active workflow run.${RESET}`, width),
      this._canvasRow(
        `  ${dim}Start one with ${accent}/workflow <name>${RESET}${dim} or press ${accent}F2${RESET}${dim} on an active run.${RESET}`,
        width,
      ),
    ];
    const topPad = Math.max(0, Math.floor((bodyTarget - body.length) / 2));
    for (let i = 0; i < topPad; i++) lines.push(this._blankRow(width));
    for (const l of body) lines.push(l);
    while (lines.length < 3 + bodyTarget) lines.push(this._blankRow(width));
    lines.push(...this._renderStatusline(width));
    return this._withVerticalMargins(lines, width);
  }

  private _renderGraph(width: number): string[] {
    const run = this._getCurrentRun();
    if (!run || this.cachedLayout.length === 0) {
      const dim = hexToAnsi(this.graphTheme.dim);
      return [
        this._centerCanvasContent(
          `${dim}waiting for stage events…${RESET}`,
          width,
        ),
      ];
    }

    const graphInner = Math.max(1, width - 4);
    const canvasWidth = this.cachedLayout.reduce(
      (max, node) => Math.max(max, node.x + NODE_W),
      0,
    );
    // Centre the whole graph horizontally when it fits; otherwise keep a
    // small gutter and reveal focused nodes by horizontally scrolling the
    // graph canvas. Do not switch to a compact list: the orchestrator pane
    // should always preserve the node-card graph view.
    const leftMargin = Math.max(
      2,
      canvasWidth <= graphInner ? Math.floor((graphInner - canvasWidth) / 2) : 2,
    );
    const viewportWidth = Math.max(1, width - leftMargin);
    const fullCanvasWidth = Math.max(canvasWidth, viewportWidth);
    this._clampGraphHorizontalScroll(fullCanvasWidth, viewportWidth);
    if (this.pendingEnsureFocusedVisible) {
      this._scrollFocusedColumnIntoView(viewportWidth, fullCanvasWidth);
    }

    // Pulse phase ∈ [0, 1) derived from wall-clock time so cards lerp
    // their border colour on the same beat regardless of how often
    // render() fires. The animation tick (`ANIMATION_TICK_MS`) only
    // controls render cadence — it does not advance the phase.
    const pulsePhase = (Date.now() % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;

    // 1. Plot parent → child edges into a sparse char canvas so they
    //    survive crisp through column gaps. Node-card bodies overwrite
    //    edge cells per-row when we compose the final output below.
    const edgeCanvas = new GraphCanvas();
    const edgeColor = this.graphTheme.borderDim;
    const nodeByStageId = new Map(
      this.cachedLayout.map((n) => [n.stage.id, n]),
    );
    for (const node of this.cachedLayout) {
      for (const parentId of node.stage.parentIds) {
        const parent = nodeByStageId.get(parentId);
        if (!parent) continue;
        this._plotEdge(
          edgeCanvas,
          parent.x,
          parent.y,
          node.x,
          node.y,
          edgeColor,
        );
      }
    }
    const edgeLines = edgeCanvas.toLines();

    // 2. Render each node card and record its row span / start column.
    interface Placement {
      startCol: number;
      width: number;
      line: string;
    }
    const placements: Map<number, Placement[]> = new Map();
    for (let ni = 0; ni < this.cachedLayout.length; ni++) {
      const node = this.cachedLayout[ni]!;
      const focused = ni === this.focusedIndex;
      const cardLines = renderNodeCard(node.stage, {
        width: NODE_W,
        height: NODE_H,
        focused,
        pulsePhase,
        theme: this.graphTheme,
        stages: this.cachedLayout.map((layoutNode) => layoutNode.stage),
      });
      for (let li = 0; li < cardLines.length; li++) {
        const rowIdx = node.y + li;
        let bucket = placements.get(rowIdx);
        if (!bucket) {
          bucket = [];
          placements.set(rowIdx, bucket);
        }
        bucket.push({ startCol: node.x, width: NODE_W, line: cardLines[li]! });
      }
    }

    // 3. Compose each output row by interleaving edge segments with the
    //    card placements at their assigned columns.
    const totalRows = Math.max(
      edgeLines.length,
      ...this.cachedLayout.map((n) => n.y + NODE_H),
    );
    const composed: string[] = [];
    for (let rowIdx = 0; rowIdx < totalRows; rowIdx++) {
      const edgeRowChars = this._edgeRowToCells(edgeLines[rowIdx] ?? "");
      const cards = placements.get(rowIdx) ?? [];
      composed.push(this._composeRow(edgeRowChars, cards, edgeColor));
    }

    // Pad the full graph canvas, then crop a horizontal viewport when the
    // fan-out is wider than the terminal. Cards/edges only paint cells they
    // occupy; everywhere else needs explicit bg so default terminal colours
    // never leak through.
    const bg = hexBg(this.graphTheme.bg);
    const leftPad = `${bg}${" ".repeat(leftMargin)}${RESET}`;
    return composed.map((line) => {
      const full = this._padCanvas(line, fullCanvasWidth);
      const sliced = this._sliceColumns(
        full,
        this.graphScrollColOffset,
        this.graphScrollColOffset + viewportWidth,
      );
      return `${leftPad}${this._padCanvas(sliced, viewportWidth)}`;
    });
  }

  private _visibleGraphLines(
    graphLines: string[],
    frameWidth: number,
    bodyRows: number,
  ): { lines: string[]; topPad: number } {
    if (graphLines.length <= bodyRows) {
      this.graphScrollOffset = 0;
      this.pendingEnsureFocusedVisible = false;
      return {
        lines: graphLines,
        topPad: Math.min(3, Math.max(0, Math.floor((bodyRows - graphLines.length) / 2))),
      };
    }

    this._clampGraphScroll(graphLines.length, bodyRows);
    if (this.pendingEnsureFocusedVisible) {
      this._scrollFocusedIntoView(frameWidth, bodyRows, graphLines.length);
      this.pendingEnsureFocusedVisible = false;
    }
    this._clampGraphScroll(graphLines.length, bodyRows);
    return {
      lines: graphLines.slice(
        this.graphScrollOffset,
        this.graphScrollOffset + bodyRows,
      ),
      topPad: 0,
    };
  }

  private _clampGraphScroll(totalRows: number, bodyRows: number): void {
    const maxOffset = Math.max(0, totalRows - bodyRows);
    this.graphScrollOffset = Math.max(
      0,
      Math.min(maxOffset, this.graphScrollOffset),
    );
  }

  private _clampGraphHorizontalScroll(totalCols: number, viewportCols: number): void {
    const maxOffset = Math.max(0, totalCols - viewportCols);
    this.graphScrollColOffset = Math.max(
      0,
      Math.min(maxOffset, this.graphScrollColOffset),
    );
  }

  private _scrollFocusedColumnIntoView(
    viewportCols: number,
    totalCols: number,
  ): void {
    const node = this.cachedLayout[this.focusedIndex];
    if (!node) return;
    const start = node.x;
    const end = node.x + NODE_W - 1;
    if (start < this.graphScrollColOffset) {
      this.graphScrollColOffset = start;
    } else if (end >= this.graphScrollColOffset + viewportCols) {
      this.graphScrollColOffset = end - viewportCols + 1;
    }
    this._clampGraphHorizontalScroll(totalCols, viewportCols);
  }

  private _scrollFocusedIntoView(
    frameWidth: number,
    bodyRows: number,
    totalRows: number,
  ): void {
    const range = this._focusedGraphRowRange(frameWidth);
    if (!range) return;
    if (range.start < this.graphScrollOffset) {
      this.graphScrollOffset = range.start;
    } else if (range.end >= this.graphScrollOffset + bodyRows) {
      this.graphScrollOffset = range.end - bodyRows + 1;
    }
    this._clampGraphScroll(totalRows, bodyRows);
  }

  private _focusedGraphRowRange(_frameWidth: number): { start: number; end: number } | null {
    const node = this.cachedLayout[this.focusedIndex];
    if (!node) return null;
    return { start: node.y, end: node.y + NODE_H - 1 };
  }

  /**
   * Plot a parent → child edge for the vertical orientation. The edge
   * exits from the parent's bottom-centre, runs through a horizontal
   * spine half-way down the gap, and re-enters from the child's
   * top-centre. Cells are merged by direction set so fan-out, fan-in,
   * and crossings produce stable orthogonal junctions instead of
   * stacked rounded corners.
   */
  private _plotEdge(
    canvas: GraphCanvas,
    px: number,
    py: number,
    cx: number,
    cy: number,
    color: string,
  ): void {
    const parentCol = px + Math.floor(NODE_W / 2);
    const childCol = cx + Math.floor(NODE_W / 2);
    const parentExitRow = py + NODE_H; // first row below parent's bottom border
    const childEntryRow = cy - 1; // last row above child's top border
    if (childEntryRow < parentExitRow) return;

    if (parentCol === childCol) {
      canvas.vline(parentCol, parentExitRow, childEntryRow, color);
      return;
    }

    const spineRow = Math.max(
      parentExitRow,
      Math.min(childEntryRow, Math.floor((parentExitRow + childEntryRow) / 2)),
    );

    // Down stub from parent into the spine row.
    if (spineRow > parentExitRow) {
      canvas.vline(parentCol, parentExitRow, spineRow - 1, color);
    }
    this._placeJunction(canvas, spineRow, parentCol, ["u", childCol > parentCol ? "r" : "l"], color);

    // Horizontal spine segment.
    const hloCol = Math.min(parentCol, childCol) + 1;
    const hhiCol = Math.max(parentCol, childCol) - 1;
    if (hhiCol >= hloCol) {
      canvas.hline(spineRow, hloCol, hhiCol, color);
    }
    this._placeJunction(canvas, spineRow, childCol, [childCol > parentCol ? "l" : "r", "d"], color);

    // Down stub from spine into child.
    if (childEntryRow > spineRow) {
      canvas.vline(childCol, spineRow + 1, childEntryRow, color);
    }
  }

  private _placeJunction(
    canvas: GraphCanvas,
    row: number,
    col: number,
    newDirs: Array<"u" | "d" | "l" | "r">,
    color: string,
  ): void {
    canvas.mergeCell(row, col, newDirs, color);
  }

  /**
   * Split the canvas-rendered edge row at card boundaries into spans of
   * `{ startCol, visibleWidth, content }` so the composer can interleave
   * cards without colliding.
   */
  private _edgeRowToCells(line: string): string {
    return line;
  }

  /**
   * Interleave a single edge row with the node cards that cross it.
   * Cards take precedence at their column ranges; edge characters fill
   * the gaps. Returns one composed line padded with spaces.
   */
  private _composeRow(
    edgeRow: string,
    cards: Array<{ startCol: number; width: number; line: string }>,
    _edgeColor: string,
  ): string {
    const bg = hexBg(this.graphTheme.bg);
    const sorted = cards.slice().sort((a, b) => a.startCol - b.startCol);
    let cursor = 0;
    let out = "";
    for (const card of sorted) {
      if (card.startCol > cursor) {
        // Edge segment up to card start — prepend bg so empty cells
        // in this stretch keep the body bg instead of falling back
        // to the terminal default once any prior RESET fired.
        out += `${bg}${this._edgeSegment(edgeRow, cursor, card.startCol)}`;
        cursor = card.startCol;
      }
      out += card.line;
      cursor += card.width;
    }
    // Trailing edge tail — same bg re-priming.
    out += `${bg}${this._edgeSegment(edgeRow, cursor, Math.max(cursor, visibleWidth(edgeRow)))}`;
    return out;
  }

  private _edgeSegment(line: string, fromCol: number, toCol: number): string {
    if (fromCol >= toCol) return "";
    const segment = this._sliceColumns(line, fromCol, toCol);
    const visible = visibleWidth(segment);
    return `${segment}${" ".repeat(Math.max(0, toCol - fromCol - visible))}`;
  }

  private _sliceColumns(line: string, fromCol: number, toCol: number): string {
    if (fromCol >= toCol) return "";
    return sliceColumns(line, fromCol, toCol - fromCol, true);
  }

  // -------------------------------------------------------------------------
  // Chrome / canvas / section helpers
  // -------------------------------------------------------------------------

  /**
   * Three-row statusline pinned to the bottom of the overlay. Mirrors
   * the header band: `backgroundPanel` chrome, outlined accent pill
   * flush-left, hints flowing right on the centre row.
   */
  private _renderStatusline(width: number): string[] {
    const t = this.graphTheme;
    const chromeBg = hexBg(t.backgroundPanel);
    const text = hexToAnsi(t.text);
    const muted = hexToAnsi(t.textMuted);
    const dim = hexToAnsi(t.dim);

    const {
      top,
      mid,
      bot,
      visibleWidth: pillW,
    } = renderOutlinePill(MODE_PILL_LABEL, t.accent, chromeBg);

    // Hints — `<key> <label>` separated by `  ·  `.
    const sep = `${chromeBg}  ${dim}·${RESET}${chromeBg}  `;
    const segments = HINT_KEYS.map(
      ({ key, label }) =>
        `${text}${BOLD}${key}${RESET}${chromeBg} ${muted}${label}${RESET}${chromeBg}`,
    );
    const hintsStyledRaw = segments.join(sep);

    const leftEdgePad = 1;
    const rightEdgePad = 2;
    const hintsBudget = Math.max(0, width - leftEdgePad - pillW - rightEdgePad);
    const hintsStyled = truncateToWidth(hintsStyledRaw, hintsBudget, "");
    const hintsVisibleLen = visibleWidth(hintsStyled);
    const fillerVisible = Math.max(0, hintsBudget - hintsVisibleLen);
    const filler = " ".repeat(fillerVisible);
    const blankAcross = " ".repeat(Math.max(0, width - leftEdgePad - pillW));

    return [
      `${chromeBg} ${RESET}${top}${chromeBg}${blankAcross}${RESET}`,
      `${chromeBg} ${RESET}${mid}${chromeBg}${filler}${hintsStyled}${chromeBg}${" ".repeat(rightEdgePad)}${RESET}`,
      `${chromeBg} ${RESET}${bot}${chromeBg}${blankAcross}${RESET}`,
    ];
  }

  /** Blank canvas row — single line of `bg`. */
  private _blankRow(width: number): string {
    return `${hexBg(this.graphTheme.bg)}${" ".repeat(width)}${RESET}`;
  }

  private _centerCanvasContent(content: string, width: number): string {
    const truncated = truncateToWidth(content, width, "…", true);
    const leftPad = Math.max(0, Math.floor((width - visibleWidth(truncated)) / 2));
    return `${" ".repeat(leftPad)}${truncated}`;
  }

  /** Wrap content in a canvas-bg row, padded to `width`. Re-emits the
   * bg ANSI right before the trailing fill so any internal `RESET`
   * from cards/edges doesn't let the terminal default bleed through. */
  private _canvasRow(content: string, width: number): string {
    const bg = hexBg(this.graphTheme.bg);
    const truncated = truncateToWidth(content, width, "…", true);
    const padLen = Math.max(0, width - visibleWidth(truncated));
    return `${bg}${truncated}${bg}${" ".repeat(padLen)}${RESET}`;
  }

  /** Pad pre-styled content out to canvas width without truncation.
   * Re-emits the body bg ANSI right before the trailing fill so any
   * internal RESET inside `content` doesn't leak the terminal default. */
  private _padCanvas(content: string, width: number): string {
    const bg = hexBg(this.graphTheme.bg);
    const padLen = Math.max(0, width - visibleWidth(content));
    return `${bg}${content}${bg}${" ".repeat(padLen)}${RESET}`;
  }

  /**
   * Compose a pre-styled card line over a canvas row at `leftPad` columns.
   * The base row keeps its `bg` (so background colour matches canvas);
   * the card slice replaces the cells starting at `leftPad`, and the
   * residual columns to the right are repainted with bg.
   *
   * We don't try to keep the parts of `base` that fall *under* the card
   * — pi-tui paints flat lines, not z-buffered cells, so the card's panel
   * background winning is fine.
   */
  private _overlayCard(
    _base: string,
    cardLine: string,
    leftPad: number,
    totalWidth: number,
  ): string {
    const bg = hexBg(this.graphTheme.bg);
    const cardW = visibleWidth(cardLine);
    const rightPadLen = Math.max(0, totalWidth - leftPad - cardW);
    return `${bg}${" ".repeat(leftPad)}${RESET}${cardLine}${bg}${" ".repeat(rightPadLen)}${RESET}`;
  }

  private _displayStages(run: RunSnapshot): StageSnapshot[] {
    return this.cachedLayout.length > 0
      ? this.cachedLayout.map((layoutNode) => layoutNode.stage)
      : [...run.stages];
  }

  private _counts(stages: readonly StageSnapshot[]): {
    pending: number;
    running: number;
    awaiting_input: number;
    paused: number;
    blocked: number;
    completed: number;
    failed: number;
    skipped: number;
  } {
    const c = {
      pending: 0,
      running: 0,
      awaiting_input: 0,
      paused: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
    };
    for (const s of stages) c[s.status]++;
    return c;
  }

  // -------------------------------------------------------------------------
  // Input handling
  // -------------------------------------------------------------------------

  /** Returns true if consumed. */
  handleInput(data: string): boolean {
    if (this.switcherOpen) {
      return this._handleSwitcherInput(data);
    }
    // Stage-local HIL is represented by graph nodes and remains graph-first;
    // only the legacy run-level prompt card sets `promptState`. Keep that
    // fallback answerable, but let a narrow set of non-text graph controls
    // through first so the workflow overlay can still be detached or scrolled
    // instead of feeling modal while a prompt is visible. Printable keys such
    // as "/" belong to the prompt card while legacy run-level text/editor
    // prompts own input.
    if (this.promptState) {
      if (this._isNonTextGraphControlBeforePrompt(data)) {
        return this._handleGraphInput(data);
      }
      return this._handlePromptInput(data);
    }
    return this._handleGraphInput(data);
  }

  private _promptKeybindings(): KeybindingsLike | undefined {
    return isKeybindingsLike(this.piKeybindings) ? this.piKeybindings : undefined;
  }

  private _isNonTextGraphControlBeforePrompt(data: string): boolean {
    return (
      this._mouseWheelDeltaRows(data) !== 0 ||
      matchesKey(data, Key.ctrl("d"))
    );
  }

  private _handlePromptInput(data: string): boolean {
    const state = this.promptState;
    if (!state) return false;
    const action = handlePromptCardInput(data, state, this._promptKeybindings());
    if (action.kind === "noop") return true;
    const runId = this.runId;
    if (!runId) return true;
    const response =
      action.kind === "cancel" ? defaultResponseFor(state.prompt) : action.response;
    this._resolvePrompt(runId, state.prompt.id, response);
    return true;
  }

  private _resolvePrompt(runId: string, promptId: string, response: unknown): void {
    // Clear local state immediately so the card disappears even if the
    // host doesn't re-emit a store snapshot between resolve and render.
    this.promptState = null;
    if (this.onPromptResolve) {
      this.onPromptResolve(runId, promptId, response);
      return;
    }
    // Fallback path used by callers that wire GraphView directly without
    // injecting onPromptResolve. Best-effort — if the store rejects (stale
    // id) we already cleared local state, so we don't try to re-arm.
    this.store.resolvePendingPrompt(runId, promptId, response);
  }

  private _handleGraphInput(data: string): boolean {
    const stageCount = this.cachedLayout.length;
    const wheelDeltaRows = this._mouseWheelDeltaRows(data);
    if (wheelDeltaRows !== 0) {
      this._scrollGraphBy(wheelDeltaRows);
      return true;
    }

    // Vertical-graph navigation: up/down step between depth levels
    // (col), left/right step between siblings at the same depth (row).
    // j/k preserved as a flat-order fallback for muscle memory.
    if (matchesKey(data, Key.down))
      return this._moveByDepth(+1);
    if (matchesKey(data, Key.up))
      return this._moveByDepth(-1);
    if (matchesKey(data, Key.right))
      return this._moveBySibling(+1);
    if (matchesKey(data, Key.left))
      return this._moveBySibling(-1);
    if (matchesKey(data, "j")) {
      this._setFocusedIndex(Math.min(this.focusedIndex + 1, stageCount - 1));
      return true;
    }
    if (matchesKey(data, "k")) {
      this._setFocusedIndex(Math.max(this.focusedIndex - 1, 0));
      return true;
    }
    if (matchesKey(data, "g")) {
      const now = Date.now();
      if (this._lastGTime != null && now - this._lastGTime < 500) {
        this._setFocusedIndex(0);
        this._lastGTime = null;
      } else {
        this._lastGTime = now;
      }
      return true;
    }
    if (matchesKey(data, "/")) {
      this.switcherOpen = true;
      this.switcherState = { query: "", selectedIndex: 0 };
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      // Enter attaches the popup interior to the focused stage. The
      // attach shell swaps in the stage-chat view without remounting
      // the overlay; without a callback, fall back to the legacy
      // expand/collapse toggle so non-attach hosts still work.
      if (this._attachFocusedStage()) return true;
      this.detailsExpanded = !this.detailsExpanded;
      return true;
    }
    // `ctrl+d` detaches the whole popup (host hides the overlay). This
    // is the graph-mode counterpart of the in-chat back affordance.
    if (matchesKey(data, Key.ctrl("d"))) {
      if (this.onDetach) {
        this.onDetach();
      } else if (this.onHide) {
        this.onHide();
      }
      return true;
    }
    // `q` kills the active run (no confirm). `h` hides the pane via
    // the overlay's setHidden() flag (not unmount); Escape/Ctrl+C closes.
    if (matchesKey(data, "q")) {
      const run = this._getCurrentRun();
      const targetRunId = this._focusedStageTarget()?.runId ?? run?.id;
      const targetRun = targetRunId !== undefined
        ? this.currentSnapshot?.runs.find((candidate) => candidate.id === targetRunId)
        : undefined;
      if (targetRun && targetRun.endedAt === undefined && this.onKill) {
        this.onKill(targetRun.id);
      }
      this.onClose?.();
      return true;
    }
    if (matchesKey(data, "h") && this.onHide) {
      this.onHide();
      return true;
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onClose?.();
      return true;
    }
    return false;
  }

  private _handleSwitcherInput(data: string): boolean {
    const stages = this.cachedLayout.map((layoutNode) => layoutNode.stage);

    if (matchesKey(data, Key.escape)) {
      this.switcherOpen = false;
      return true;
    }
    if (matchesKey(data, Key.enter)) {
      const filtered = filterStages(stages, this.switcherState.query);
      const selected = filtered[this.switcherState.selectedIndex];
      if (selected) {
        const idx = this.cachedLayout.findIndex(
          (n) => n.stage.id === selected.id,
        );
        if (idx !== -1) {
          this._setFocusedIndex(idx);
          // Selecting from the `/` switcher should complete the same
          // action as pressing Enter on a graph node: jump straight
          // into that stage's chat when the attach shell is present.
          this.switcherOpen = false;
          if (this._attachFocusedStage()) return true;
        }
      }
      this.switcherOpen = false;
      return true;
    }
    if (matchesKey(data, Key.down)) {
      const filtered = filterStages(stages, this.switcherState.query);
      this.switcherState = {
        ...this.switcherState,
        selectedIndex: Math.min(
          this.switcherState.selectedIndex + 1,
          filtered.length - 1,
        ),
      };
      return true;
    }
    if (matchesKey(data, Key.up)) {
      this.switcherState = {
        ...this.switcherState,
        selectedIndex: Math.max(this.switcherState.selectedIndex - 1, 0),
      };
      return true;
    }
    if (matchesKey(data, Key.backspace)) {
      this.switcherState = {
        query: this.switcherState.query.slice(0, -1),
        selectedIndex: 0,
      };
      return true;
    }
    if (data.length === 1 && data >= " ") {
      this.switcherState = {
        query: this.switcherState.query + data,
        selectedIndex: 0,
      };
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this._intervalId != null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    if (this._unsubscribe) {
      this._unsubscribe();
      this._unsubscribe = null;
    }
  }

  invalidate(): void {
    this._rebuildLayout();
  }

  /**
   * Move focus to the nearest node `step` depth-levels away (↑/↓).
   * Picks the sibling with the closest `row` to the current node so
   * navigation feels spatially continuous in the vertical layout.
   */
  private _moveByDepth(step: number): boolean {
    const cur = this.cachedLayout[this.focusedIndex];
    if (!cur) return true;
    const targetCol = cur.col + step;
    const candidates = this.cachedLayout
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.col === targetCol);
    if (candidates.length === 0) return true;
    let best = candidates[0]!;
    let bestDist = Math.abs(best.n.row - cur.row);
    for (const c of candidates) {
      const d = Math.abs(c.n.row - cur.row);
      if (d < bestDist) {
        best = c;
        bestDist = d;
      }
    }
    this._setFocusedIndex(best.i);
    return true;
  }

  /**
   * Move focus to the next sibling at the same depth (←/→). Clamps
   * at the band edges — no wrap, so the user always knows when they
   * hit a boundary.
   */
  private _moveBySibling(step: number): boolean {
    const cur = this.cachedLayout[this.focusedIndex];
    if (!cur) return true;
    const siblings = this.cachedLayout
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.col === cur.col)
      .sort((a, b) => a.n.row - b.n.row);
    const pos = siblings.findIndex(({ i }) => i === this.focusedIndex);
    if (pos === -1) return true;
    const next = siblings[pos + step];
    if (!next) return true;
    this._setFocusedIndex(next.i);
    return true;
  }

  private _attachFocusedStage(): boolean {
    if (!this.onStageAttach) return false;
    const node = this.cachedLayout[this.focusedIndex];
    const run = this._getCurrentRun();
    if (!node || !run) return false;
    const target = expandedStageTarget(this.expandedGraph, node.stage.id) ?? {
      runId: run.id,
      stageId: node.stage.id,
    };
    this.onStageAttach(target.runId, target.stageId);
    return true;
  }

  private _focusedStageTarget(): { runId: string; stageId: string } | undefined {
    const node = this.cachedLayout[this.focusedIndex];
    if (!node) return undefined;
    const target = expandedStageTarget(this.expandedGraph, node.stage.id);
    return target ? { runId: target.runId, stageId: target.stageId } : undefined;
  }

  private _setFocusedIndex(index: number): void {
    const max = Math.max(0, this.cachedLayout.length - 1);
    const next = Math.max(0, Math.min(index, max));
    if (next === this.focusedIndex) return;
    this.focusedIndex = next;
    this.pendingEnsureFocusedVisible = true;
  }

  private _scrollGraphBy(deltaRows: number): void {
    this.pendingEnsureFocusedVisible = false;
    this.graphScrollOffset = Math.max(0, this.graphScrollOffset + deltaRows);
  }

  private _mouseWheelDeltaRows(data: string): number {
    const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
    if (sgr) {
      return this._wheelDeltaForButtonCode(Number.parseInt(sgr[1]!, 10));
    }
    if (data.startsWith("\x1b[M") && data.length >= 6) {
      return this._wheelDeltaForButtonCode(data.charCodeAt(3) - 32);
    }
    return 0;
  }

  private _wheelDeltaForButtonCode(code: number): number {
    if ((code & 64) === 0) return 0;
    const direction = code & 3;
    if (direction === 0) return -GRAPH_SCROLL_STEP_ROWS;
    if (direction === 1) return GRAPH_SCROLL_STEP_ROWS;
    return 0;
  }

  // ---- test seams ----
  get _focusedIndex(): number {
    return this.focusedIndex;
  }
  get _switcherOpen(): boolean {
    return this.switcherOpen;
  }
  get _switcherState(): SwitcherState {
    return this.switcherState;
  }
  get _graphScrollOffset(): number {
    return this.graphScrollOffset;
  }
}
