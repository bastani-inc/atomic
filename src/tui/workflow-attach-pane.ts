/**
 * WorkflowAttachPane — outer in-place attach shell.
 *
 * Wraps a single `pi.ui.custom` overlay popup whose interior swaps
 * between the orchestrator `GraphView` and a stage-scoped
 * `StageChatView`. Pressing Enter on a graph node attaches the popup
 * to that node's chat; Ctrl+D in chat mode swaps back to graph mode
 * with the same node still focused (see ui/attach-mockup.html).
 *
 * The shell never remounts the overlay — it only flips a `mode`
 * field and re-renders, so the popup stays in pi-tui's overlay layer
 * across attach/detach cycles. This matches the mockup contract
 * (`only the popup interior swapped — outer chrome is unchanged`).
 *
 * cross-ref:
 *  - src/tui/overlay-adapter.ts (host mount glue)
 *  - src/tui/graph-view.ts (graph mode Component)
 *  - src/tui/stage-chat-view.ts (chat mode Component)
 *  - src/runs/foreground/stage-control-registry.ts (live handles)
 */

import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";
import { GraphView } from "./graph-view.js";
import { StageChatView } from "./stage-chat-view.js";
import type {
  StageControlHandle,
  StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";

/**
 * Surface used to write Pi's footer/status tag while the attach pane is
 * mounted. Passing `undefined` clears the slot — required on dispose so
 * the `pi-workflows/<workflow>[/<stage>]` tag does NOT linger in every
 * subsequent chat message after the overlay is closed.
 * cross-ref: @earendil-works/pi-coding-agent docs/extensions.md
 * §Widgets, Status, and Footer (`ctx.ui.setStatus`).
 */
export interface AttachUiStatusSurface {
  setStatus?: (key: string, value: string | undefined) => void;
}

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
   * Optional UI status surface. When present, attaching/detaching
   * updates the `pi-workflows` status tag with `<workflow>/<stage>`.
   */
  uiStatus?: AttachUiStatusSurface;
  /** Called when the user closes (Escape in graph mode). */
  onClose: () => void;
  /** Called when the user requests the host to hide the popup. */
  onHide?: () => void;
  /** Called when the user kills the active run (q in graph mode). */
  onKill?: (runId: string) => void;
  /** Called when the user resolves a HIL prompt via the graph view. */
  onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  /**
   * Optional override: pre-select chat mode for a stage on construction.
   * Used by `/workflow attach <runId> <stageId>` so the popup opens
   * directly on the node's chat.
   */
  initialAttachStageId?: string;
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
}

export type WorkflowAttachPaneMode = "graph" | "stage-chat";

interface Component {
  render(width: number): string[];
  handleInput?(data: string): boolean | void;
  invalidate?(): void;
  dispose?(): void;
}

const STATUS_KEY = "pi-workflows";

export class WorkflowAttachPane implements Component {
  private store: Store;
  private theme: GraphTheme;
  private runId: string | null;
  private registry: StageControlRegistry | undefined;
  private uiStatus: AttachUiStatusSurface | undefined;
  private onClose: () => void;
  private onHide?: () => void;
  private onKill?: (runId: string) => void;
  private onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  private getViewportRows?: () => number | undefined;
  private hostRequestRender?: () => void;

  private mode: WorkflowAttachPaneMode = "graph";
  private graphView: GraphView;
  private chatView: StageChatView | null = null;
  /** Stage id the user most recently attached to (used to seed focus). */
  private lastAttachedStageId: string | null = null;

  constructor(opts: WorkflowAttachPaneOpts) {
    this.store = opts.store;
    this.theme = opts.graphTheme;
    this.runId = opts.runId;
    this.registry = opts.stageControlRegistry;
    this.uiStatus = opts.uiStatus;
    this.onClose = opts.onClose;
    this.onHide = opts.onHide;
    this.onKill = opts.onKill;
    this.onPromptResolve = opts.onPromptResolve;
    this.getViewportRows = opts.getViewportRows;
    this.hostRequestRender = opts.requestRender;

    this.graphView = this._buildGraphView();

    if (opts.initialAttachStageId !== undefined && this.runId) {
      this._attachToStage(this.runId, opts.initialAttachStageId);
    } else {
      this._setBaseStatus();
    }
  }

  private _buildGraphView(initialFocusedStageId?: string): GraphView {
    return new GraphView({
      mode: "overlay",
      runId: this.runId,
      store: this.store,
      graphTheme: this.theme,
      onClose: this.onClose,
      onHide: this.onHide,
      onKill: this.onKill,
      onPromptResolve: this.onPromptResolve,
      onStageAttach: (runId, stageId) => this._attachToStage(runId, stageId),
      onDetach: () => {
        if (this.onHide) this.onHide();
      },
      initialFocusedStageId,
      getViewportRows: this.getViewportRows,
      // Gate the host render tick on `graph` mode. While the chat view
      // is attached, the GraphView is hidden behind the chat — firing
      // pi-tui renders for a frame the user can't see is wasted work.
      requestRender: () => {
        if (this.mode !== "graph") return;
        this.hostRequestRender?.();
      },
    });
  }

  private _resolveRunId(): string | null {
    if (this.runId) return this.runId;
    const active = this.store.activeRunId();
    if (active) {
      this.runId = active;
      return active;
    }
    return null;
  }

  private _workflowName(runId: string): string {
    const snap = this.store.snapshot();
    const run = snap.runs.find((r) => r.id === runId);
    return run?.name ?? "workflow";
  }

  private _stageName(runId: string, stageId: string): string {
    const snap = this.store.snapshot();
    const run = snap.runs.find((r) => r.id === runId);
    return run?.stages.find((s) => s.id === stageId)?.name ?? "stage";
  }

  private _attachToStage(runId: string, stageId: string): void {
    this.runId = runId;
    this.lastAttachedStageId = stageId;
    const handle: StageControlHandle | undefined = this.registry?.get(runId, stageId);
    this.chatView?.dispose();
    this.chatView = new StageChatView({
      store: this.store,
      graphTheme: this.theme,
      runId,
      stageId,
      workflowName: this._workflowName(runId),
      handle,
      onDetach: () => this._detachFromStage(),
      onClose: this.onClose,
      requestRender: this.hostRequestRender,
      getViewportRows: this.getViewportRows,
    });
    this.store.recordStageAttached(runId, stageId, true);
    this.mode = "stage-chat";
    this._setAttachedStatus(runId, stageId);
  }

  private _detachFromStage(): void {
    if (this.chatView && this.runId && this.lastAttachedStageId) {
      this.store.recordStageAttached(this.runId, this.lastAttachedStageId, false);
    }
    this.chatView?.dispose();
    this.chatView = null;
    // Rebuild graph view so the focused stage matches the node we
    // were just attached to (mockup contract: cursor still on
    // `review-a` after Ctrl+D detach).
    this.graphView.dispose();
    this.graphView = this._buildGraphView(this.lastAttachedStageId ?? undefined);
    this.mode = "graph";
    this._setBaseStatus();
  }

  private _setBaseStatus(): void {
    const runId = this._resolveRunId();
    const name = runId ? `pi-workflows/${this._workflowName(runId)}` : "pi-workflows";
    this.uiStatus?.setStatus?.(STATUS_KEY, name);
  }

  private _setAttachedStatus(runId: string, stageId: string): void {
    const value = `pi-workflows/${this._workflowName(runId)}/${this._stageName(runId, stageId)}`;
    this.uiStatus?.setStatus?.(STATUS_KEY, value);
  }

  render(width: number): string[] {
    if (this.mode === "stage-chat" && this.chatView) {
      return this.chatView.render(width);
    }
    return this.graphView.render(width);
  }

  handleInput(data: string): boolean | void {
    if (this.mode === "stage-chat" && this.chatView) {
      return this.chatView.handleInput(data);
    }
    return this.graphView.handleInput(data);
  }

  invalidate(): void {
    if (this.mode === "stage-chat" && this.chatView) this.chatView.invalidate();
    else this.graphView.invalidate();
  }

  dispose(): void {
    this.chatView?.dispose();
    this.chatView = null;
    this.graphView.dispose();
    // Clear the pi-workflows status tag so it doesn't follow the user
    // back into chat. Without this, every subsequent message header
    // keeps rendering `pi-workflows/<workflow>` (or `…/<stage>`) until
    // the next attach replaces the slot.
    this.uiStatus?.setStatus?.(STATUS_KEY, undefined);
  }

  // ---- Test seams ----
  get _mode(): WorkflowAttachPaneMode {
    return this.mode;
  }
  get _lastAttachedStageId(): string | null {
    return this.lastAttachedStageId;
  }
  get _hasChatView(): boolean {
    return this.chatView !== null;
  }
}
