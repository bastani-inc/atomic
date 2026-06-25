import { expandedStageTarget } from "../shared/expanded-workflow-graph.js";
import {
  GRAPH_SCROLL_STEP_ROWS,
} from "./graph-view-constants.js";
import { GraphViewRenderer } from "./graph-view-render.js";
import { isKeybindingsLike, type KeybindingsLike } from "./keybindings-adapter.js";
import {
  defaultResponseFor,
  handlePromptCardInput,
} from "./prompt-card.js";
import { filterStages, type SwitcherState } from "./switcher.js";
import { Key, matchesKey } from "./text-helpers.js";

/** Keyboard, mouse, switcher, prompt, and focus navigation handling. */
export abstract class GraphViewInputController extends GraphViewRenderer {
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
    // `q` requests kill confirmation for a live run. The host closes
    // only after confirmation; when there is no live target, restore the
    // legacy close/fall-through behavior instead of swallowing the key.
    // `h` hides the pane via the overlay's setHidden() flag (not unmount);
    // Escape/Ctrl+C closes.
    if (matchesKey(data, "q")) {
      const run = this._getCurrentRun();
      const targetRunId = this._focusedStageTarget()?.runId ?? run?.id;
      const targetRun = targetRunId !== undefined
        ? this.currentSnapshot?.runs.find((candidate) => candidate.id === targetRunId)
        : undefined;
      if (targetRun && targetRun.endedAt === undefined && this.onKill) {
        this.onKill(targetRun.id);
        return true;
      }
      if (this.onClose) {
        this.onClose();
        return true;
      }
      return false;
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
