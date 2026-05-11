/**
 * Overlay-capable GraphView component.
 * cross-ref: spec §5.4.3, v0.x packages/atomic-sdk/src/components/session-graph-panel.tsx
 */
import type { Store } from "../store.js";
import type { StoreSnapshot, RunSnapshot } from "../store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { SwitcherState } from "./switcher.js";
import type { LayoutNode } from "./layout.js";
import { computeLayout, NODE_W, NODE_H } from "./layout.js";
import { renderHeader } from "./header.js";
import { renderNodeCard } from "./node-card.js";
import { renderSwitcher, filterStages } from "./switcher.js";
import { renderToasts, createToastManager } from "./toast.js";
import { RESET } from "./color-utils.js";

export type GraphViewMode = "overlay" | "widget";

export interface GraphViewOpts {
  mode: GraphViewMode;
  runId: string | null;
  store: Store;
  graphTheme: GraphTheme;
  onClose?: () => void;
}

export class GraphView {
  private mode: GraphViewMode;
  private runId: string | null;
  private store: Store;
  private graphTheme: GraphTheme;
  private onClose?: () => void;

  private focusedIndex = 0;
  private switcherOpen = false;
  private switcherState: SwitcherState = { query: "", selectedIndex: 0 };
  private toastManager = createToastManager();
  private pulsePhase = 0;
  private cachedLayout: LayoutNode[] = [];
  private currentSnapshot: StoreSnapshot | null = null;

  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _lastGTime: number | null = null;
  private _unsubscribe: (() => void) | null = null;

  constructor(opts: GraphViewOpts) {
    this.mode = opts.mode;
    this.runId = opts.runId;
    this.store = opts.store;
    this.graphTheme = opts.graphTheme;
    this.onClose = opts.onClose;

    // Subscribe to store updates
    this._unsubscribe = this.store.subscribe((snap) => {
      this.currentSnapshot = snap;
      this._rebuildLayout();
    });

    // Initialize with current snapshot
    this.currentSnapshot = this.store.snapshot();
    this._rebuildLayout();

    // Pulse animation tick (60ms interval)
    if (this.mode === "overlay") {
      this._intervalId = setInterval(() => {
        this.pulsePhase = (this.pulsePhase + 1 / 16) % 1;
        this.toastManager.tick(Date.now());
      }, 60);
    }
  }

  private _rebuildLayout(): void {
    const run = this._getCurrentRun();
    if (!run) {
      this.cachedLayout = [];
      return;
    }
    this.cachedLayout = computeLayout(run.stages);
  }

  private _getCurrentRun(): RunSnapshot | null {
    if (!this.currentSnapshot) return null;
    const runId = this.runId ?? this.store.activeRunId();
    if (!runId) return null;
    return (
      this.currentSnapshot.runs.find((r) => r.id === runId) ?? null
    );
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
    if (!run) return ["[no active workflow]"];

    const hLines = renderHeader(run, { width, theme: this.graphTheme });
    const total = run.stages.length;
    const done = run.stages.filter((s) => s.status === "completed").length;
    const failed = run.stages.filter((s) => s.status === "failed").length;
    const running = run.stages.filter((s) => s.status === "running").length;
    const progress = `  ${running > 0 ? `◉${running} ` : ""}✓${done}/${total}${failed > 0 ? ` ✗${failed}` : ""}`;

    return [...hLines, progress];
  }

  private _renderOverlay(width: number): string[] {
    const lines: string[] = [];
    const run = this._getCurrentRun();

    if (!run) {
      lines.push("[No active workflow run]");
      return lines;
    }

    // Header
    const headerLines = renderHeader(run, { width, theme: this.graphTheme });
    lines.push(...headerLines);

    // Graph area
    const graphLines = this._renderGraph(width);
    lines.push(...graphLines);

    // Switcher overlay
    if (this.switcherOpen) {
      const switcherWidth = Math.min(50, width - 4);
      const switcherLines = renderSwitcher(
        run.stages,
        this.switcherState,
        { width: switcherWidth, theme: this.graphTheme },
      );
      // Insert switcher lines after header (overlay)
      const insertAt = headerLines.length;
      for (let i = 0; i < switcherLines.length; i++) {
        const lineIdx = insertAt + i;
        if (lineIdx < lines.length) {
          // Overlay: just replace
          lines[lineIdx] = switcherLines[i]!;
        } else {
          lines.push(switcherLines[i]!);
        }
      }
    }

    // Toasts (top-right)
    const toastLines = renderToasts(this.toastManager.active(), { theme: this.graphTheme });
    if (toastLines.length > 0) {
      // Overlay toasts into top-right corner
      for (let i = 0; i < toastLines.length && i < lines.length; i++) {
        lines[i] = (lines[i] ?? "") + " " + toastLines[i];
      }
    }

    // Footer hint
    const hint = `${RESET}  j/k navigate  / search  q close`;
    lines.push(hint);

    return lines;
  }

  private _renderGraph(_width: number): string[] {
    const run = this._getCurrentRun();
    if (!run || this.cachedLayout.length === 0) {
      return ["  (no stages)"];
    }

    const outputLines: string[] = [];

    for (let ni = 0; ni < this.cachedLayout.length; ni++) {
      const node = this.cachedLayout[ni]!;
      const focused = ni === this.focusedIndex;
      const cardLines = renderNodeCard(node.stage, {
        width: NODE_W,
        height: NODE_H,
        focused,
        pulsePhase: this.pulsePhase,
        theme: this.graphTheme,
      });

      const startY = node.y + 1;
      for (let li = 0; li < cardLines.length; li++) {
        const lineIdx = startY + li;
        while (outputLines.length <= lineIdx) {
          outputLines.push("");
        }
        const existingLine = outputLines[lineIdx] ?? "";
        outputLines[lineIdx] = existingLine.padEnd(node.x, " ") + cardLines[li];
      }
    }

    return outputLines;
  }

  /** Handle keyboard input. Returns true if consumed. */
  handleInput(data: string): boolean {
    if (this.switcherOpen) {
      return this._handleSwitcherInput(data);
    }
    return this._handleGraphInput(data);
  }

  private _handleGraphInput(data: string): boolean {
    const stageCount = this.cachedLayout.length;

    if (data === "j" || data === "\x1b[B") {
      // Arrow down
      this.focusedIndex = Math.min(this.focusedIndex + 1, stageCount - 1);
      return true;
    }

    if (data === "k" || data === "\x1b[A") {
      // Arrow up
      this.focusedIndex = Math.max(this.focusedIndex - 1, 0);
      return true;
    }

    if (data === "g") {
      const now = Date.now();
      if (this._lastGTime != null && now - this._lastGTime < 500) {
        // gg - go to first
        this.focusedIndex = 0;
        this._lastGTime = null;
      } else {
        this._lastGTime = now;
      }
      return true;
    }

    if (data === "/") {
      this.switcherOpen = true;
      this.switcherState = { query: "", selectedIndex: 0 };
      return true;
    }

    if (data === "\r" || data === "\n") {
      // Enter - action on focused stage (no-op for now)
      return true;
    }

    if (data === "q" || data === "\x1b") {
      // q or Escape
      this.onClose?.();
      return true;
    }

    return false;
  }

  private _handleSwitcherInput(data: string): boolean {
    const run = this._getCurrentRun();
    const stages = run?.stages ?? [];

    if (data === "\x1b") {
      // Escape closes switcher
      this.switcherOpen = false;
      return true;
    }

    if (data === "\r" || data === "\n") {
      // Enter - jump to selected stage
      const filtered = filterStages(stages, this.switcherState.query);
      const selected = filtered[this.switcherState.selectedIndex];
      if (selected) {
        const idx = this.cachedLayout.findIndex((n) => n.stage.id === selected.id);
        if (idx !== -1) this.focusedIndex = idx;
      }
      this.switcherOpen = false;
      return true;
    }

    if (data === "\x1b[B") {
      // Arrow down
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

    if (data === "\x1b[A") {
      // Arrow up
      this.switcherState = {
        ...this.switcherState,
        selectedIndex: Math.max(this.switcherState.selectedIndex - 1, 0),
      };
      return true;
    }

    if (data === "\x7f" || data === "\b") {
      // Backspace
      this.switcherState = {
        query: this.switcherState.query.slice(0, -1),
        selectedIndex: 0,
      };
      return true;
    }

    // Regular character input
    if (data.length === 1 && data >= " ") {
      this.switcherState = {
        query: this.switcherState.query + data,
        selectedIndex: 0,
      };
      return true;
    }

    return false;
  }

  /** Dispose resources (clear interval). */
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

  // Expose internal state for testing
  get _focusedIndex(): number {
    return this.focusedIndex;
  }

  get _switcherOpen(): boolean {
    return this.switcherOpen;
  }

  get _switcherState(): SwitcherState {
    return this.switcherState;
  }
}
