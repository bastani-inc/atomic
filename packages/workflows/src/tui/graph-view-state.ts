import type { ReadonlyFooterDataProvider } from "@bastani/atomic";
import type { Store } from "../shared/store.js";
import type {
  PendingPrompt,
  RunSnapshot,
  StageSnapshot,
  StoreSnapshot,
} from "../shared/store-types.js";
import {
  expandedStageTarget,
  expandWorkflowGraph,
  type ExpandedWorkflowGraph,
  type ExpandedWorkflowStage,
  type ExpandedWorkflowStageTarget,
} from "../shared/expanded-workflow-graph.js";
import type { GraphTheme } from "./graph-theme.js";
import type { LayoutNode } from "./layout.js";
import { computeLayout } from "./layout.js";
import {
  createPromptCardState,
  type PromptCardState,
} from "./prompt-card.js";
import { createToastManager } from "./toast.js";
import type { SwitcherState } from "./switcher.js";
import { ANIMATION_TICK_MS } from "./graph-view-constants.js";
import type { GraphViewMode, GraphViewOpts } from "./graph-view-types.js";

export interface GraphStageCounts {
  pending: number;
  running: number;
  awaiting_input: number;
  paused: number;
  blocked: number;
  completed: number;
  failed: number;
  skipped: number;
}

interface GraphNodeHitRect {
  index: number;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface GraphViewportGeometry {
  leftMargin: number;
  viewportWidth: number;
}

/** Expansion, focus, prompt, and store-backed layout state for GraphView. */
export abstract class GraphViewState {
  protected mode: GraphViewMode;
  protected runId: string | null;
  protected store: Store;
  protected graphTheme: GraphTheme;
  protected onClose?: () => void;
  protected onHide?: () => void;
  protected onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  protected onStageAttach?: (runId: string, stageId: string) => void;
  protected onDetach?: () => void;
  protected initialFocusedStageId?: string;
  protected getViewportRows?: () => number | undefined;
  protected requestRender?: () => void;
  protected piKeybindings?: unknown;
  protected footerData?: ReadonlyFooterDataProvider;

  /** Active HIL prompt state, set when `_rebuildLayout` sees a new prompt id. */
  protected promptState: PromptCardState | null = null;

  protected focusedIndex = 0;
  protected switcherOpen = false;
  protected switcherState: SwitcherState = { query: "", selectedIndex: 0 };
  protected toastManager = createToastManager();
  protected detailsExpanded = true;
  protected cachedLayout: LayoutNode[] = [];
  protected expandedGraph: ExpandedWorkflowGraph = { stages: [], renderStages: [], tools: [], nodes: [], targets: new Map() };
  protected currentSnapshot: StoreSnapshot | null = null;
  protected graphScrollOffset = 0;
  protected graphScrollColOffset = 0;
  protected graphNodeHitRects: GraphNodeHitRect[] = [];
  protected lastGraphViewport: GraphViewportGeometry | null = null;
  protected lastOverlayFrameWidth = 80;
  protected pendingEnsureFocusedVisible = true;
  protected lastAutoFocusedAwaitingInputKey: string | null = null;

  protected _intervalId: ReturnType<typeof setInterval> | null = null;
  protected _lastGTime: number | null = null;
  protected _unsubscribe: (() => void) | null = null;

  constructor(opts: GraphViewOpts) {
    this.mode = opts.mode;
    this.runId = opts.runId;
    this.store = opts.store;
    this.graphTheme = opts.graphTheme;
    this.onClose = opts.onClose;
    this.onHide = opts.onHide;
    this.onPromptResolve = opts.onPromptResolve;
    this.onStageAttach = opts.onStageAttach;
    this.onDetach = opts.onDetach;
    this.initialFocusedStageId = opts.initialFocusedStageId;
    this.getViewportRows = opts.getViewportRows;
    this.requestRender = opts.requestRender;
    this.piKeybindings = opts.piKeybindings;
    this.footerData = opts.footerData;

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

  protected _rebuildLayout(): void {
    const run = this._getCurrentRun();
    if (!run) {
      this.cachedLayout = [];
      this.expandedGraph = { stages: [], renderStages: [], tools: [], nodes: [], targets: new Map() };
      this.focusedIndex = 0;
      this.graphScrollOffset = 0;
      this.graphScrollColOffset = 0;
      this.graphNodeHitRects = [];
      this.lastGraphViewport = null;
      this.pendingEnsureFocusedVisible = true;
      this.promptState = null;
      return;
    }

    const previousFocusedStageId = this.cachedLayout[this.focusedIndex]?.stage.id;
    const graphStages = this._graphStages(run);
    const nextLayout = computeLayout(graphStages, { orientation: "vertical" });
    this.cachedLayout = nextLayout;
    this.graphNodeHitRects = [];
    this.lastGraphViewport = null;

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

  protected _awaitingInputFocusTarget(): { index: number; key: string } | null {
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

  protected _awaitingInputKey(stage: StageSnapshot): { key: string; createdAt: number } | null {
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

  protected _graphStages(run: RunSnapshot): ExpandedWorkflowStage[] {
    this.expandedGraph = this.currentSnapshot
      ? expandWorkflowGraph(this.currentSnapshot, run.id)
      : { stages: [], renderStages: [], tools: [], nodes: [], targets: new Map() };
    const stages = [...this.expandedGraph.renderStages];
    const hasStagePrompt = stages.some((stage) =>
      stage.pendingPrompt !== undefined ||
      (stage.status === "awaiting_input" && stage.promptFootprint?.kind === "custom")
    );
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
  protected _syncPromptState(prompt: PendingPrompt | undefined): void {
    if (!prompt) {
      this.promptState = null;
      return;
    }
    if (!this.promptState || this.promptState.prompt.id !== prompt.id) {
      this.promptState = createPromptCardState(prompt);
    }
  }

  /** Stage-only control target shared by hints and activation. */
  protected _stageChatTarget(
    stage: StageSnapshot | undefined,
  ): ExpandedWorkflowStageTarget | undefined {
    if (!stage || stage.nodeKind === "tool" || stage.attachable === false) return undefined;
    return expandedStageTarget(this.expandedGraph, stage.id);
  }

  protected _focusedStageChatTarget(): ExpandedWorkflowStageTarget | undefined {
    return this._stageChatTarget(this.cachedLayout[this.focusedIndex]?.stage);
  }

  protected _getCurrentRun(): RunSnapshot | null {
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

  protected _displayStages(run: RunSnapshot): StageSnapshot[] {
    return this.cachedLayout.length > 0
      ? this.cachedLayout.map((layoutNode) => layoutNode.stage)
      : [...run.stages];
  }

  protected _counts(stages: readonly StageSnapshot[]): GraphStageCounts {
    const c: GraphStageCounts = {
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
}
