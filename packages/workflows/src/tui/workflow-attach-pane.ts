/**
 * WorkflowAttachPane — outer in-place attach shell.
 *
 * Wraps a single `pi.ui.custom` overlay popup whose interior swaps
 * between the orchestrator `GraphView` and a stage-scoped
 * `StageChatView`. Pressing Enter on a graph node attaches the popup
 * to that node's chat; Ctrl+D in chat mode swaps back to graph mode
 * with the same node still focused (see ui/attach-mockup.html), including
 * paused stage chats.
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
import type { Component, EditorComponent, EditorTheme, TUI } from "@earendil-works/pi-tui";
import type { ChatMessageRenderOptions, ReadonlyFooterDataProvider } from "@bastani/atomic";
import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";
import { GraphView } from "./graph-view.js";
import {
  StageChatView,
  type StageChatDetachMetadata,
  type StageChatDetachReason,
} from "./stage-chat-view.js";
import { Key, matchesKey } from "./text-helpers.js";
import type {
  StageControlHandle,
  StageControlRegistry,
} from "../runs/foreground/stage-control-registry.js";
import type { StageUiBroker } from "../shared/stage-ui-broker.js";
import type { StageSnapshot, StoreSnapshot } from "../shared/store-types.js";
import { expandWorkflowGraph } from "../shared/expanded-workflow-graph.js";
import { WORKFLOW_STATUS_KEY } from "./workflow-status.js";
import type { AttachUiStatusSurface, WorkflowAttachPaneMode, WorkflowAttachPaneOpts } from "./workflow-attach-pane-types.js";
export type { AttachUiStatusSurface, WorkflowAttachPaneMode, WorkflowAttachPaneOpts } from "./workflow-attach-pane-types.js";

const ENTER_TRANSITION_QUARANTINE_MS = 200;
export class WorkflowAttachPane implements Component {
  private store: Store;
  private theme: GraphTheme;
  private runId: string | null;
  private registry: StageControlRegistry | undefined;
  private stageUiBroker: StageUiBroker | undefined;
  private uiStatus: AttachUiStatusSurface | undefined;
  private onClose: () => void;
  private onHide?: () => void;
  private onQuit?: (runId: string) => void;
  private onPromptResolve?: (runId: string, promptId: string, response: unknown) => void;
  private getViewportRows?: () => number | undefined;
  private hostRequestRender?: () => void;
  private hostRequestFocus?: () => void;
  private setMouseScrollTracking?: (enabled: boolean) => void;
  private piTui?: TUI;
  private piTheme?: unknown;
  private piKeybindings?: unknown;
  private piEditorFactory?: (tui: TUI, theme: EditorTheme, keybindings: unknown) => EditorComponent;
  private getChatRenderSettings?: () => Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">> | undefined;
  private footerData?: ReadonlyFooterDataProvider;
  private now: () => number;
  private mode: WorkflowAttachPaneMode = "graph";
  private visible = true;
  private graphView: GraphView;
  private chatView: StageChatView | null = null;
  private unsubscribeStore: (() => void) | null = null;
  /** Run id for the currently attached stage chat; graph mode keeps `runId` as the root graph run. */
  private attachedRunId: string | null = null;
  /** Stage id the user most recently attached to (used to seed focus). */
  private lastAttachedStageId: string | null = null;
  /** Time-boxed guard for Enter leaking into graph mode during connect/detach transitions. */
  private graphEnterQuarantineUntil = 0;
  private stagePromptEnterQuarantineUntil = 0;
  private lastGraphAwaitingInputKey: string | null = null;
  private lastStageAwaitingInputKey: string | null = null;
  constructor(opts: WorkflowAttachPaneOpts) {
    this.store = opts.store;
    this.theme = opts.graphTheme;
    this.runId = opts.runId;
    this.registry = opts.stageControlRegistry;
    this.stageUiBroker = opts.stageUiBroker;
    this.uiStatus = opts.uiStatus;
    this.onClose = opts.onClose;
    this.onHide = opts.onHide;
    this.onQuit = opts.onQuit;
    this.onPromptResolve = opts.onPromptResolve;
    this.getViewportRows = opts.getViewportRows;
    this.hostRequestRender = opts.requestRender;
    this.hostRequestFocus = opts.requestFocus;
    this.setMouseScrollTracking = opts.setMouseScrollTracking;
    this.piTui = opts.piTui;
    this.piTheme = opts.piTheme;
    this.piKeybindings = opts.piKeybindings;
    this.piEditorFactory = opts.piEditorFactory;
    this.getChatRenderSettings = opts.getChatRenderSettings;
    this.footerData = opts.footerData;
    this.now = opts.now ?? Date.now;
    this.unsubscribeStore = this.store.subscribe((snapshot) => this._handleStoreUpdate(snapshot));
    this.graphView = this._buildGraphView();
    if (opts.initialAttachStageId !== undefined && this.runId) {
      const target = this._resolveGraphStageTarget(this.runId, opts.initialAttachStageId);
      this._attachToStage(target.runId, target.stageId);
    } else {
      this._syncAwaitingInputKeys(this.store.snapshot());
      this._armGraphEnterQuarantineIfRunNeedsInput();
      this._setBaseStatus();
      this._syncMouseScrollTracking();
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
      onQuit: this.onQuit,
      onPromptResolve: this.onPromptResolve,
      onStageAttach: (runId, stageId) => this._attachToStage(runId, stageId, {
        suppressInitialPromptSubmit: true,
      }),
      onDetach: () => {
        if (this.onHide) this.onHide();
      },
      initialFocusedStageId,
      getViewportRows: this.getViewportRows,
      piKeybindings: this.piKeybindings,
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
  private _attachToStage(
    runId: string,
    stageId: string,
    options: { suppressInitialPromptSubmit?: boolean } = { suppressInitialPromptSubmit: true },
  ): void {
    this.graphEnterQuarantineUntil = 0;
    const snapshot = this.store.snapshot();
    const graphRunId = this._resolveRunId();
    this.lastGraphAwaitingInputKey = graphRunId ? this._runAwaitingInputKey(snapshot, graphRunId) : null;
    this.lastStageAwaitingInputKey = this._stageAwaitingInputKey(snapshot, runId, stageId);
    this.stagePromptEnterQuarantineUntil =
      options.suppressInitialPromptSubmit === true && this.lastStageAwaitingInputKey !== null
        ? this.now() + ENTER_TRANSITION_QUARANTINE_MS
        : 0;
    this.attachedRunId = runId;
    this.lastAttachedStageId = stageId;
    const handle: StageControlHandle | undefined = this.registry?.get(runId, stageId);
    this.chatView?.dispose();
    let chatView!: StageChatView;
    chatView = new StageChatView({
      store: this.store,
      graphTheme: this.theme,
      runId,
      stageId,
      workflowName: this._workflowName(runId),
      handle,
      onDetach: (reason, metadata) => this._detachFromStage(reason, metadata),
      onClose: this.onClose,
      requestRender: this.hostRequestRender,
      requestFocus: this.hostRequestFocus,
      piTui: this.piTui,
      piTheme: this.piTheme,
      piKeybindings: this.piKeybindings,
      piEditorFactory: this.piEditorFactory,
      getChatRenderSettings: this.getChatRenderSettings,
      footerData: this.footerData,
      getViewportRows: this.getViewportRows,
      stageUiBroker: this.stageUiBroker,
      canSubmitPrompt: (candidateRunId, candidateStageId) => (
        this.visible &&
        this.mode === "stage-chat" &&
        this.chatView === chatView &&
        this.attachedRunId === candidateRunId &&
        this.lastAttachedStageId === candidateStageId &&
        this._isStageMarkedAttached(candidateRunId, candidateStageId)
      ),
    });
    this.chatView = chatView;
    this.mode = "stage-chat";
    this.store.recordStageAttached(runId, stageId, this.visible);
    this._setAttachedStatus(runId, stageId);
    this._syncMouseScrollTracking();
  }
  private _detachFromStage(
    reason: StageChatDetachReason = "user",
    metadata: StageChatDetachMetadata = {},
  ): void {
    if (this.chatView && this.attachedRunId && this.lastAttachedStageId) {
      this.store.recordStageAttached(this.attachedRunId, this.lastAttachedStageId, false);
    }
    this.chatView?.dispose();
    this.chatView = null;
    this.attachedRunId = null;
    this.graphView.dispose();
    this.graphView = this._buildGraphView(this.lastAttachedStageId ?? undefined);
    this.mode = "graph";
    this.stagePromptEnterQuarantineUntil = 0;
    this.lastStageAwaitingInputKey = null;
    this.lastGraphAwaitingInputKey = this.runId ? this._runAwaitingInputKey(this.store.snapshot(), this.runId) : null;
    this.graphEnterQuarantineUntil =
      reason === "prompt-resolved" && metadata.suppressNextGraphSubmit === true
        ? this.now() + ENTER_TRANSITION_QUARANTINE_MS
        : 0;
    this._setBaseStatus();
    this._syncMouseScrollTracking();
  }
  retarget(runId: string | null, stageId?: string): void {
    if (this.chatView && this.attachedRunId && this.lastAttachedStageId) {
      this.store.recordStageAttached(this.attachedRunId, this.lastAttachedStageId, false);
    }
    this.chatView?.dispose();
    this.chatView = null;
    this.graphView.dispose();
    this.runId = runId;
    this.attachedRunId = null;
    this.lastAttachedStageId = null;
    this.mode = "graph";
    this.graphEnterQuarantineUntil = 0;
    this.stagePromptEnterQuarantineUntil = 0;
    this.graphView = this._buildGraphView();
    this._syncAwaitingInputKeys(this.store.snapshot());
    if (stageId !== undefined && runId) {
      const target = this._resolveGraphStageTarget(runId, stageId);
      this._attachToStage(target.runId, target.stageId);
      return;
    }
    this._armGraphEnterQuarantineIfRunNeedsInput();
    this._setBaseStatus();
    this._syncMouseScrollTracking();
  }
  private _resolveGraphStageTarget(rootRunId: string, stageId: string): { runId: string; stageId: string } {
    const graph = expandWorkflowGraph(this.store.snapshot(), rootRunId);
    const match = graph.stages.find((stage) =>
      stage.id === stageId || stage.workflowGraphTarget.stageId === stageId,
    );
    if (match === undefined) return { runId: rootRunId, stageId };
    return {
      runId: match.workflowGraphTarget.runId,
      stageId: match.workflowGraphTarget.stageId,
    };
  }
  private _handleStoreUpdate(snapshot: StoreSnapshot): void {
    if (!this.visible) {
      this._syncAwaitingInputKeys(snapshot);
      return;
    }
    const runId = this._resolveRunId();
    if (!runId) {
      this.lastGraphAwaitingInputKey = null;
      this.lastStageAwaitingInputKey = null;
      return;
    }
    if (this.mode === "graph") {
      const key = this._runAwaitingInputKey(snapshot, runId);
      if (key !== null && key !== this.lastGraphAwaitingInputKey) {
        this.graphEnterQuarantineUntil = this.now() + ENTER_TRANSITION_QUARANTINE_MS;
      }
      this.lastGraphAwaitingInputKey = key;
      this.lastStageAwaitingInputKey = null;
      return;
    }
    if (this.mode === "stage-chat" && this.attachedRunId && this.lastAttachedStageId) {
      const key = this._stageAwaitingInputKey(snapshot, this.attachedRunId, this.lastAttachedStageId);
      if (key !== null && key !== this.lastStageAwaitingInputKey) {
        this.stagePromptEnterQuarantineUntil = this.now() + ENTER_TRANSITION_QUARANTINE_MS;
      }
      this.lastStageAwaitingInputKey = key;
      this.lastGraphAwaitingInputKey = this._runAwaitingInputKey(snapshot, runId);
    }
  }
  private _syncAwaitingInputKeys(snapshot: StoreSnapshot): void {
    const runId = this._resolveRunId();
    this.lastGraphAwaitingInputKey = runId ? this._runAwaitingInputKey(snapshot, runId) : null;
    this.lastStageAwaitingInputKey = this.attachedRunId && this.lastAttachedStageId
      ? this._stageAwaitingInputKey(snapshot, this.attachedRunId, this.lastAttachedStageId)
      : null;
  }
  private _setBaseStatus(): void {
    const runId = this._resolveRunId();
    const name = runId ? `${WORKFLOW_STATUS_KEY}/${this._workflowName(runId)}` : WORKFLOW_STATUS_KEY;
    this.uiStatus?.setStatus?.(WORKFLOW_STATUS_KEY, name);
  }
  private _setAttachedStatus(runId: string, stageId: string): void {
    const value = `${WORKFLOW_STATUS_KEY}/${this._workflowName(runId)}/${this._stageName(runId, stageId)}`;
    this.uiStatus?.setStatus?.(WORKFLOW_STATUS_KEY, value);
  }
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (this.mode === "stage-chat" && this.attachedRunId && this.lastAttachedStageId) {
      this.store.recordStageAttached(this.attachedRunId, this.lastAttachedStageId, visible);
      if (visible) this._setAttachedStatus(this.attachedRunId, this.lastAttachedStageId);
      else this.uiStatus?.setStatus?.(WORKFLOW_STATUS_KEY, undefined);
      return;
    }
    if (visible) this._setBaseStatus();
    else this.uiStatus?.setStatus?.(WORKFLOW_STATUS_KEY, undefined);
  }
  private _syncMouseScrollTracking(): void {
    this.setMouseScrollTracking?.(this.wantsMouseScrollTracking());
  }
  wantsMouseScrollTracking(): boolean {
    if (this.mode === "stage-chat" && this.chatView) {
      return this.chatView.wantsMouseScrollTracking();
    }
    return this.mode === "graph";
  }
  wantsFocusForAwaitingInput(snapshot: StoreSnapshot): boolean {
    if (!this.visible) return false;
    const runId = this._resolveRunId();
    if (!runId) return false;
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) return false;
    if (this.mode === "graph") {
      return this._runAwaitingInputKey(snapshot, runId) !== null;
    }
    if (this.mode !== "stage-chat" || !this.attachedRunId || !this.lastAttachedStageId) return false;
    const attachedRun = snapshot.runs.find((candidate) => candidate.id === this.attachedRunId);
    const stage = attachedRun?.stages.find((candidate) => candidate.id === this.lastAttachedStageId);
    return stage?.attached === true && this._stageSnapshotNeedsInput(stage);
  }
  render(width: number): string[] {
    if (this.mode === "stage-chat" && this.chatView) {
      return this.chatView.render(width);
    }
    return this.graphView.render(width);
  }
  handleInput(data: string): boolean | void {
    if (!this.visible) return false;
    if (this.mode === "stage-chat" && this.chatView) {
      if (this._shouldQuarantineStagePromptEnter(data)) return true;
      const beforeMouseTracking = this.chatView.wantsMouseScrollTracking();
      const handled = this.chatView.handleInput(data);
      const afterMouseTracking = this.chatView?.wantsMouseScrollTracking();
      if (afterMouseTracking !== undefined && afterMouseTracking !== beforeMouseTracking) this._syncMouseScrollTracking();
      return handled;
    }
    if (this._shouldQuarantineGraphEnter(data)) return true;
    return this.graphView.handleInput(data);
  }
  private _shouldQuarantineStagePromptEnter(data: string): boolean {
    if (this.stagePromptEnterQuarantineUntil <= 0) return false;
    if (!matchesKey(data, Key.enter)) {
      this.stagePromptEnterQuarantineUntil = 0;
      return false;
    }
    if (!this.attachedRunId || !this.lastAttachedStageId) {
      this.stagePromptEnterQuarantineUntil = 0;
      return false;
    }
    if (!this._stageNeedsInput(this.attachedRunId, this.lastAttachedStageId)) {
      this.stagePromptEnterQuarantineUntil = 0;
      return false;
    }
    const now = this.now();
    if (now <= this.stagePromptEnterQuarantineUntil) {
      this.stagePromptEnterQuarantineUntil = now + ENTER_TRANSITION_QUARANTINE_MS;
      return true;
    }
    this.stagePromptEnterQuarantineUntil = 0;
    return false;
  }
  private _shouldQuarantineGraphEnter(data: string): boolean {
    if (this.graphEnterQuarantineUntil <= 0) return false;
    if (!matchesKey(data, Key.enter)) {
      this.graphEnterQuarantineUntil = 0;
      return false;
    }
    const now = this.now();
    if (now <= this.graphEnterQuarantineUntil) {
      this.graphEnterQuarantineUntil = now + ENTER_TRANSITION_QUARANTINE_MS;
      return true;
    }
    this.graphEnterQuarantineUntil = 0;
    return false;
  }
  private _armGraphEnterQuarantineIfRunNeedsInput(): void {
    const runId = this._resolveRunId();
    this.graphEnterQuarantineUntil = runId && this._runNeedsInput(runId)
      ? this.now() + ENTER_TRANSITION_QUARANTINE_MS
      : 0;
  }
  private _runNeedsInput(runId: string): boolean {
    return this._runAwaitingInputKey(this.store.snapshot(), runId) !== null;
  }
  private _runAwaitingInputKey(snapshot: StoreSnapshot, runId: string): string | null {
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    if (!run) return null;
    const keys: Array<{ key: string; createdAt: number }> = [];
    if (run.pendingPrompt) {
      keys.push({ key: `run-prompt:${run.pendingPrompt.id}`, createdAt: run.pendingPrompt.createdAt });
    }
    const graph = expandWorkflowGraph(snapshot, runId);
    for (const stage of graph.stages) {
      const key = this._stageAwaitingInputKeyFromSnapshot(stage);
      if (key) keys.push(key);
    }
    if (keys.length === 0) return null;
    keys.sort((a, b) => b.createdAt - a.createdAt);
    return keys[0]!.key;
  }
  private _stageNeedsInput(runId: string, stageId: string): boolean {
    return this._stageAwaitingInputKey(this.store.snapshot(), runId, stageId) !== null;
  }
  private _stageAwaitingInputKey(snapshot: StoreSnapshot, runId: string, stageId: string): string | null {
    const run = snapshot.runs.find((candidate) => candidate.id === runId);
    const stage = run?.stages.find((candidate) => candidate.id === stageId);
    return stage ? this._stageAwaitingInputKeyFromSnapshot(stage)?.key ?? null : null;
  }
  private _stageAwaitingInputKeyFromSnapshot(stage: StageSnapshot): { key: string; createdAt: number } | null {
    if (stage.pendingPrompt) {
      return { key: `stage-prompt:${stage.id}:${stage.pendingPrompt.id}`, createdAt: stage.pendingPrompt.createdAt };
    }
    if (stage.inputRequest) {
      return { key: `stage-input:${stage.id}:${stage.inputRequest.id}`, createdAt: stage.inputRequest.createdAt };
    }
    if (stage.status === "awaiting_input") {
      return {
        key: `stage-awaiting:${stage.id}:${stage.awaitingInputSince ?? "active"}`,
        createdAt: stage.awaitingInputSince ?? stage.startedAt ?? 0,
      };
    }
    return null;
  }
  private _isStageMarkedAttached(runId: string, stageId: string): boolean {
    return this._stageSnapshot(runId, stageId)?.attached === true;
  }
  private _stageSnapshot(runId: string, stageId: string): StageSnapshot | undefined {
    const run = this.store.snapshot().runs.find((candidate) => candidate.id === runId);
    return run?.stages.find((candidate) => candidate.id === stageId);
  }
  private _stageSnapshotNeedsInput(stage: Pick<StageSnapshot, "pendingPrompt" | "inputRequest" | "status">): boolean {
    return (
      stage.pendingPrompt !== undefined ||
      stage.inputRequest !== undefined ||
      stage.status === "awaiting_input"
    );
  }
  invalidate(): void {
    if (this.mode === "stage-chat" && this.chatView) this.chatView.invalidate();
    else this.graphView.invalidate();
  }
  dispose(): void {
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    if (this.chatView && this.attachedRunId && this.lastAttachedStageId) {
      this.store.recordStageAttached(this.attachedRunId, this.lastAttachedStageId, false);
    }
    this.chatView?.dispose();
    this.chatView = null;
    this.graphView.dispose();
    this.setMouseScrollTracking?.(false);
    this.uiStatus?.setStatus?.(WORKFLOW_STATUS_KEY, undefined);
  }
  get _mode(): WorkflowAttachPaneMode {
    return this.mode;
  }
  get _lastAttachedStageId(): string | null {
    return this.lastAttachedStageId;
  }
  get _hasChatView(): boolean {
    return this.chatView !== null;
  }
  get _runId(): string | null {
    return this.runId;
  }
}
