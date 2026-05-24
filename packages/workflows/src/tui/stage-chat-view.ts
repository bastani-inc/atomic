/**
 * StageChatView — attached workflow-stage chat surface.
 *
 * The overlay keeps workflow-specific chrome for stage metadata / controls, but
 * the chat body now delegates to packages/coding-agent's exported interactive
 * components instead of maintaining parallel workflow message widgets:
 *  - user rows use `UserMessageComponent`
 *  - assistant/thinking rows use `AssistantMessageComponent`
 *  - tool rows use `ToolExecutionComponent` and built-in tool renderers
 *  - input reuses the host's custom editor factory when one is installed,
 *    otherwise `CustomEditor`; tests/headless fall back to the historical
 *    one-line editor
 *  - workflow notices remain lightweight workflow-specific rows because they
 *    are not coding-agent chat messages
 *
 * Behaviour:
 *  - **Idle** stage (empty transcript, not streaming, not settled): welcome
 *    panel describing the attached stage. Enter sends `handle.prompt(text)`.
 *  - **Running** stage with a live stream: Enter queues a Pi-style steering
 *    message (interrupt mid-turn) without adding a premature transcript row.
 *    Ctrl+F queues a follow-up the same way.
 *  - **Escape** mirrors the main coding-agent chat interrupt path for active
 *    live stages: it requests a controlled pause/abort while keeping the
 *    composer active. While paused, Enter calls `handle.resume(text)`.
 *  - **Ctrl+D** detaches (back to graph), or closes the popup while paused;
 *    **Escape** closes the popup when idle.
 *  - **Blocked** stage: keystrokes absorbed; BLOCKED banner names the
 *    upstream awaiter.
 *  - **Settled** stage with a live handle remains a normal chat session:
 *    Enter sends `handle.prompt(text)` and Escape interrupts any active
 *    post-stage response without mutating workflow dependencies.
 *
 * cross-ref:
 *  - ui/stage-chat-mockup.html (canonical visual)
 *  - DESIGN.md §5 (Components — pill / box / banner vocabulary)
 *  - src/runs/foreground/stage-control-registry.ts (StageControlHandle)
 *  - src/shared/store-types.ts (StageSnapshot.notices, StageNotice)
 *  - https://pi.dev/docs/latest/tui (canonical Pi-tui component contract)
 *  - node_modules/@earendil-works/pi-tui/src/components/{box,text,spacer}.ts
 */

import {
  ChatSessionHost,
  type ChatSessionHostStyle,
  type AgentSession,
  type ChatMessageEntry,
  type ChatMessageRenderOptions,
  type ReadonlyFooterDataProvider,
} from "@bastani/atomic";
import { Box, Text } from "@earendil-works/pi-tui";
import type {
  Component,
  EditorComponent,
  EditorTheme,
  Focusable,
  TUI,
} from "@earendil-works/pi-tui";
import type { Store } from "../shared/store.js";
import {
  mountStageCustomUi,
  stageUiBroker,
  type MountedStageCustomUi,
  type StageCustomUiRequest,
  type StageUiBroker,
} from "../shared/stage-ui-broker.js";
import type { StageNotice, StageSnapshot } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { StageControlHandle } from "../runs/foreground/stage-control-registry.js";
import { BOLD, RESET, hexBg, hexToAnsi, lerpColor } from "./color-utils.js";
import { matchesKey, visibleWidth } from "./text-helpers.js";
import {
  fitStageChatFrame,
  planStageChatFrame,
  resolveStageChatViewportRows,
} from "./stage-chat-layout.js";

// ---------------------------------------------------------------------------
// Options & types
// ---------------------------------------------------------------------------

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
  /** Called when the user presses Ctrl+D outside a paused stage (back to graph). */
  onDetach: () => void;
  /** Called when the user presses Escape (close the whole popup). */
  onClose: () => void;
  /** Request a host TUI repaint after SDK events mutate local chat state. */
  requestRender?: () => void;
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
}

/**
 * Transcript model. Every variant carries a flat `.text` summary so consumers
 * that read `_transcript` (tests, future serialisers) can recover the
 * canonical user-visible string without knowing about the Pi-box payload.
 */
interface NoticeEntry {
  readonly role: "notice";
  readonly text: string;
  readonly noticeId: string;
  readonly kind: StageNotice["kind"];
  readonly value: string;
  readonly from?: string;
  readonly meta?: string;
}
type TranscriptEntry = NoticeEntry | ChatMessageEntry;
type AgentSnapshotMessage = AgentSession["messages"][number];

// ---------------------------------------------------------------------------
// Frame budget
// ---------------------------------------------------------------------------

/**
 * Default line budget used when the host doesn't surface terminal dimensions
 * (direct unit renders, lightweight test mocks). The mounted overlay
 * overrides this by passing `getViewportRows()`.
 */
const VIEW_LINE_COUNT = 32;

/** Header strip — `  STAGE  wf / stage   <meta>   ● status` without a leading marker glyph. */
const HEADER_ROWS = 1;
/** Single dim rule between header and body. */
const SEP_ROWS = 1;
const ITALIC = "\x1b[3m";
const FG_RESET = "\x1b[39m";
const WEIGHT_RESET = "\x1b[22m";
const ITALIC_RESET = "\x1b[23m";

// ---------------------------------------------------------------------------
// StageChatView
// ---------------------------------------------------------------------------

export class StageChatView implements Component, Focusable {
  focused = true;
  private store: Store;
  private theme: GraphTheme;
  private runId: string;
  private stageId: string;
  private workflowName: string;
  private handle: StageControlHandle | undefined;
  private onDetach: () => void;
  private onClose: () => void;
  private requestRender: (() => void) | undefined;
  private getViewportRows?: () => number | undefined;
  private piTui?: TUI;
  private piTheme?: unknown;
  private piKeybindings?: unknown;
  private chatHost: ChatSessionHost<NoticeEntry>;
  private stageUiBroker: StageUiBroker;
  private mountedCustomUi: MountedStageCustomUi | null = null;
  private getChatRenderSettings?: () =>
    | Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>
    | undefined;
  private footerData?: ReadonlyFooterDataProvider;

  /** True while a pending pause request is in flight (between ctrl+p and resolve). */
  private localPaused = false;
  /** De-dup set so the store subscription doesn't re-append known notices. */
  private seenNoticeIds = new Set<string>();

  private _unsubscribeStore: (() => void) | null = null;
  private _unsubscribeHandle: (() => void) | null = null;
  private _unregisterStageUiHost: (() => void) | null = null;

  constructor(opts: StageChatViewOpts) {
    this.store = opts.store;
    this.theme = opts.graphTheme;
    this.runId = opts.runId;
    this.stageId = opts.stageId;
    this.workflowName = opts.workflowName;
    this.handle = opts.handle;
    this.onDetach = opts.onDetach;
    this.onClose = opts.onClose;
    this.requestRender = opts.requestRender;
    this.getViewportRows = opts.getViewportRows;
    this.piTui = opts.piTui;
    this.piTheme = opts.piTheme;
    this.piKeybindings = opts.piKeybindings;
    this.getChatRenderSettings = opts.getChatRenderSettings;
    this.footerData = opts.footerData;
    this.stageUiBroker = opts.stageUiBroker ?? stageUiBroker;
    this.chatHost = new ChatSessionHost<NoticeEntry>({
      style: this._chatHostStyle(),
      commands: {
        ensureAttached: async () => {
          await this._liveHandle()?.ensureAttached();
        },
        prompt: async (text) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.prompt(text);
        },
        steer: async (text) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.steer(text);
        },
        followUp: async (text) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.followUp(text);
        },
        interrupt: async () => {
          const handle = this._liveHandle();
          if (!handle) return;
          const status = this._currentStage()?.status ?? handle.status;
          if (status === "pending" || status === "running" || status === "awaiting_input") {
            await handle.pause();
            return;
          }
          await handle.agentSession?.abort();
        },
        resume: async (message) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          this.localPaused = true;
          await handle.resume(message);
          this.localPaused = false;
        },
        runBash: async (request) => {
          const handle = this._liveHandle();
          if (!handle) throw new Error("no live handle on this stage");
          await handle.ensureAttached();
          const agentSession = handle.agentSession;
          if (!agentSession) throw new Error("no live agent session on this stage");
          return agentSession.executeBash(request.command, request.onChunk, {
            excludeFromContext: request.excludeFromContext,
          });
        },
        abortBash: async () => {
          this._liveHandle()?.agentSession?.abortBash();
        },
        abortCompaction: async () => {
          this._liveHandle()?.agentSession?.abortCompaction();
        },
        handleSlashCommand: async (text) => this._handleSlashCommand(text),
      },
      isBashRunning: () => this._liveHandle()?.agentSession?.isBashRunning === true,
      requestRender: opts.requestRender,
      getAgentSession: () => this._liveHandle()?.agentSession,
      isStreaming: () => this._liveHandle()?.isStreaming === true,
      isPaused: () => this._isPaused(),
      isDisabled: () => this._isBlocked() || !this._liveHandle(),
      tui: opts.piTui,
      keybindings: opts.piKeybindings,
      editorFactory: opts.piEditorFactory,
      editorTheme: editorThemeFromGraphTheme(this.theme),
      getChatRenderSettings: opts.getChatRenderSettings,
      footerData: opts.footerData,
      renderExtraEntry: (entry) => this._noticeRow(entry),
    });
    this._unregisterStageUiHost = this.stageUiBroker.registerHost(this.runId, this.stageId, {
      showCustomUi: (request) => {
        void this._showCustomUi(request);
      },
      hideCustomUi: (request) => {
        this._hideMountedCustomUi(request);
      },
    });

    // Seed transcript from the live SDK session at attach time, plus any
    // stage notices the workflow body has already recorded.
    this._snapshotMessagesFromHandle();
    const initialStage = this._currentStage();
    this._snapshotMessagesFromSessionFile(initialStage);
    this._absorbStageNotices(initialStage);

    this._unsubscribeStore = this.store.subscribe(() => {
      const stage = this._currentStage();
      let changed = false;
      if (stage && stage.status === "paused" && !this.localPaused) {
        this.localPaused = true;
        changed = true;
      } else if (stage && stage.status === "running" && this.localPaused) {
        this.localPaused = false;
        changed = true;
      }
      // Pick up notices recorded after attach (workflow body calling
      // `stage.setModel`, `stage.compact`, …) so they thread through the
      // transcript without a special render path.
      changed = this._absorbStageNotices(stage) || changed;
      this.chatHost.syncAnimationTick();
      if (changed) this.requestRender?.();
    });

    if (this.handle) {
      this._unsubscribeHandle = this.handle.subscribe((event) => {
        this.chatHost.applyAgentEvent(event);
      });
    }
    this.chatHost.syncAnimationTick();
  }

  private _chatHostStyle(): ChatSessionHostStyle {
    return {
      dim: (text) => paint(text, this.theme.dim),
      text: (text) => paint(text, this.theme.text),
      textMuted: (text) => paint(text, this.theme.textMuted),
      accent: (text) => paint(text, this.theme.accent),
      accentBold: (text) => paint(text, this.theme.accent, { bold: true }),
      rule: (hex, text) => hexToAnsi(hex) + text + RESET,
      cursor: () => cursorBlock(),
      blank: (width) => this._blank(width),
      editorRuleColor: (disabled, agentSession, state) =>
        this._editorRuleColor(disabled, agentSession, state),
    };
  }

  private async _showCustomUi(request: StageCustomUiRequest): Promise<void> {
    this.mountedCustomUi?.component.dispose?.();
    this.mountedCustomUi = null;
    if (!this.piTui || this.piTheme === undefined || this.piKeybindings === undefined) {
      this.stageUiBroker.reject(
        request,
        new Error("pi-workflows: stage custom UI cannot mount without attached TUI host"),
      );
      return;
    }
    try {
      this.mountedCustomUi = await mountStageCustomUi(
        request,
        this.piTui,
        this.piTheme,
        this.piKeybindings,
        this.stageUiBroker,
        () => {
          if (this.mountedCustomUi?.request.id !== request.id) return;
          this.mountedCustomUi.component.dispose?.();
          this.mountedCustomUi = null;
          this.chatHost.focused = this.focused;
          this.chatHost.scrollToBottom();
          this.requestRender?.();
        },
      );
      this.requestRender?.();
    } catch (error) {
      this.stageUiBroker.reject(request, error);
    }
  }

  // -------------------------------------------------------------------------
  // Event ingestion
  // -------------------------------------------------------------------------

  private _snapshotMessagesFromHandle(): void {
    const handle = this._liveHandle();
    if (!handle) return;
    this.chatHost.appendMessages(handle.messages);
  }

  private _snapshotMessagesFromSessionFile(
    stage: StageSnapshot | undefined,
  ): void {
    this.chatHost.loadSessionFile(this._liveHandle()?.sessionFile ?? stage?.sessionFile);
  }

  private _absorbStageNotices(stage: StageSnapshot | undefined): boolean {
    const notices = stage?.notices;
    if (!notices) return false;
    let changed = false;
    for (const n of notices) {
      if (this.seenNoticeIds.has(n.id)) continue;
      this.seenNoticeIds.add(n.id);
      changed = true;
      this.chatHost.appendExtraEntry({
        role: "notice",
        noticeId: n.id,
        kind: n.kind,
        value: n.to,
        from: n.from,
        meta: n.meta,
        text: noticeSummary(n),
      });
    }
    return changed;
  }

  private _currentStage(): StageSnapshot | undefined {
    const snap = this.store.snapshot();
    const run = snap.runs.find((r) => r.id === this.runId);
    return run?.stages.find((s) => s.id === this.stageId);
  }

  // -------------------------------------------------------------------------
  // Frame sizing
  // -------------------------------------------------------------------------

  /**
   * Number of rows the chat surface paints per frame. The mounted overlay
   * passes `terminal.rows` through `getViewportRows`; direct unit renders
   * fall back to the constant `VIEW_LINE_COUNT` so the legacy 32-row frame
   * still applies to lightweight test mocks.
   */
  private _viewLineCount(): number {
    const reported = this.getViewportRows?.();
    if (typeof reported !== "number" || !Number.isFinite(reported)) {
      return VIEW_LINE_COUNT;
    }
    return resolveStageChatViewportRows(reported, VIEW_LINE_COUNT);
  }

  private _liveHandle(): StageControlHandle | undefined {
    return this.handle?.isDisposed === true ? undefined : this.handle;
  }

  private _isStreaming(): boolean {
    return this.chatHost.isStreaming();
  }

  private _isBlocked(): boolean {
    return this._currentStage()?.status === "blocked";
  }

  private _isPaused(
    stage: StageSnapshot | undefined = this._currentStage(),
  ): boolean {
    return this.localPaused || stage?.status === "paused";
  }

  private _isReadOnlyArchive(stage: StageSnapshot | undefined = this._currentStage()): boolean {
    if (this._liveHandle()) return false;
    if (!stage) return true;
    return stage.status === "completed" || stage.status === "failed" || Boolean(stage.sessionFile);
  }

  private async _handleSlashCommand(text: string): Promise<boolean> {
    const [command, ...rest] = text.trim().split(/\s+/);
    switch (command) {
      case "/compact": {
        const handle = this._liveHandle();
        if (!handle) return false;
        await handle.ensureAttached();
        if (!handle.agentSession) return false;
        await handle.agentSession.compact(rest.join(" ") || undefined);
        return true;
      }
      case "/quit":
      case "/exit":
        this.onClose();
        return true;
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Top-level render — composes header / body / usage / editor / footer
  // -------------------------------------------------------------------------

  render(width: number): string[] {
    const w = Math.max(40, width);
    const stage = this._currentStage();
    const blocked = this._isBlocked();

    this.chatHost.focused = this.focused;
    const headerLines = this._renderHeader(w, stage);
    const sepLines = [this._sepRule(w)];
    const customUiActive = this.mountedCustomUi !== null;
    const readOnlyArchive = this._isReadOnlyArchive(stage);
    const pendingLines = customUiActive || readOnlyArchive ? [] : this.chatHost.renderPendingMessages(w);
    const workingLines = customUiActive || readOnlyArchive ? [] : this.chatHost.renderWorkingStatus(w);
    const usageLines = customUiActive || readOnlyArchive ? [] : this.chatHost.renderUsage(w);
    const editorLines = customUiActive || readOnlyArchive ? [] : this.chatHost.renderEditor(w);
    const footerLines = customUiActive || readOnlyArchive ? [] : this.chatHost.renderFooter(w);

    const totalRows = this._viewLineCount();
    const plan = planStageChatFrame({
      viewportRows: totalRows,
      headerRows: HEADER_ROWS,
      separatorRows: SEP_ROWS,
      pendingRows: pendingLines.length,
      workingRows: workingLines.length,
      usageRows: usageLines.length,
      editorRows: editorLines.length,
      footerRows: footerLines.length,
    });
    const visiblePendingLines = pendingLines.slice(0, plan.pendingRows);
    const visibleWorkingLines = workingLines.slice(0, plan.workingRows);
    const visibleUsageLines = usageLines.slice(0, plan.usageRows);
    const visibleEditorLines = editorLines.slice(0, plan.editorRows);
    const visibleFooterLines = footerLines.slice(0, plan.footerRows);
    const bodyBudget = plan.bodyRows;
    if (blocked) this.chatHost.scrollToBottom();
    const bodyLines = customUiActive
      ? this._renderCustomUiBody(w, bodyBudget)
      : blocked
        ? this._renderBlockedBody(w, bodyBudget, stage)
        : readOnlyArchive
          ? this._renderReadOnlyArchiveBody(w, bodyBudget, stage)
          : this.chatHost.renderBody(w, bodyBudget);
    const lines = [
      ...headerLines,
      ...sepLines,
      ...bodyLines,
      ...visiblePendingLines,
      ...visibleWorkingLines,
      ...visibleUsageLines,
      ...visibleEditorLines,
      ...visibleFooterLines,
    ];
    return fitStageChatFrame(lines, totalRows, this._blank(w));
  }

  // -------------------------------------------------------------------------
  // Header
  // -------------------------------------------------------------------------

  private _renderHeader(
    width: number,
    stage: StageSnapshot | undefined,
  ): string[] {
    const t = this.theme;
    const stageName = stage?.name ?? "stage";

    // Left side: `  STAGE  <wf> / <stage>`
    const left =
      paint("   ", t.mauve, { bold: true }) +
      paint("STAGE", t.textMuted, { bold: true }) +
      "  " +
      paint(this.workflowName, t.textMuted) +
      paint(" / ", t.dim) +
      paint(stageName, t.text, { bold: true });

    // Right side: stable session metadata only. Avoid workflow-status chrome
    // in the embedded chat so the surface does not change colour when the
    // workflow stage settles.
    const meta = this._headerMeta(stage);
    const right = meta ? paint(meta, t.dim) + " " : "";

    const leftW =
      visibleWidth(this.workflowName) +
      visibleWidth(stageName) +
      visibleWidth("  STAGE   /  ") +
      1;
    const rightW = visibleWidth(meta) + (meta ? 1 : 0);
    const gap = Math.max(1, width - leftW - rightW);
    return [left + " ".repeat(gap) + right];
  }

  private _headerMeta(stage: StageSnapshot | undefined): string {
    const parts: string[] = [];
    const sid = this.handle?.sessionId ?? stage?.sessionId;
    if (sid) parts.push(`session ${shortenId(sid)}`);
    return parts.join(" · ");
  }

  private _sepRule(width: number): string {
    return hexToAnsi(this.theme.borderDim) + "─".repeat(width) + RESET;
  }

  // -------------------------------------------------------------------------
  // Body — welcome panel / banner + transcript / blocked
  // -------------------------------------------------------------------------

  private _renderReadOnlyArchiveBody(
    width: number,
    budget: number,
    stage: StageSnapshot | undefined,
  ): string[] {
    const t = this.theme;
    const calloutRows = 6;
    const transcriptBudget = Math.max(1, budget - calloutRows);
    const lines = this.chatHost.renderBody(width, transcriptBudget);
    const callout: string[] = [];
    callout.push(this._blank(width));
    callout.push(
      ...this._bannerLines(
        width,
        "info",
        "◌",
        "READ-ONLY SESSION",
        stage?.sessionFile ? "archived transcript" : "no live chat session",
      ),
    );
    callout.push(
      ...new Text(
        paint("This node is no longer attached to a live chat session.", t.textMuted),
        2,
        0,
      ).render(width),
    );
    callout.push(
      ...new Text(
        paint("esc", t.accent, { bold: true }) +
          paint(" close", t.textMuted) +
          paint("  ·  ", t.dim) +
          paint("ctrl+d", t.accent, { bold: true }) +
          paint(" return to graph", t.textMuted),
        2,
        0,
      ).render(width),
    );
    lines.push(...callout);
    while (lines.length < budget) lines.push(this._blank(width));
    if (lines.length > budget) lines.length = budget;
    return lines;
  }

  private _renderBlockedBody(
    width: number,
    budget: number,
    stage: StageSnapshot | undefined,
  ): string[] {
    const t = this.theme;
    const upstream = stage?.blockedByStageId ?? "upstream stage";
    const lines: string[] = [];
    // Yellow banner — uses the same chrome vocabulary as paused/completed.
    lines.push(
      ...this._bannerLines(
        width,
        "warning",
        "↑",
        "BLOCKED",
        `waiting on ${upstream}`,
      ),
    );
    lines.push(this._blank(width));
    lines.push(
      ...new Text(
        paint(
          "This stage is waiting for the upstream stage to resume.",
          t.textMuted,
        ),
        2,
        0,
      ).render(width),
    );
    lines.push(
      ...new Text(
        paint("ctrl+d", t.accent, { bold: true }) +
          paint(" return to graph", t.textMuted),
        2,
        0,
      ).render(width),
    );
    while (lines.length < budget) lines.push(this._blank(width));
    if (lines.length > budget) lines.length = budget;
    return lines;
  }

  private _renderCustomUiBody(width: number, budget: number): string[] {
    const component = this.mountedCustomUi?.component;
    if (component) setComponentFocused(component, this.focused);
    const lines = component ? component.render(width) : [];
    const framed = lines.slice(0, budget);
    while (framed.length < budget) framed.push(this._blank(width));
    return framed;
  }

  private _noticeRow(entry: NoticeEntry): Component {
    const t = this.theme;
    const fromPart = entry.from ? paint(` (was ${entry.from})`, t.dim) : "";
    const metaPart = entry.meta ? "  " + paint(entry.meta, t.dim) : "";
    const line =
      paint("~ ", t.borderDim) +
      paint(entry.kind, t.mauve, { bold: true }) +
      paint(" → ", t.borderDim) +
      paint(entry.value, t.text) +
      fromPart +
      metaPart;
    return new Text(line, 2, 0);
  }

  // -------------------------------------------------------------------------
  // Banners (paused / completed / failed / blocked)
  // -------------------------------------------------------------------------

  private _banner(
    kind: "warning" | "success" | "error" | "info",
    glyph: string,
    label: string,
    meta: string,
  ): Component {
    const t = this.theme;
    const fg =
      kind === "warning"
        ? t.warning
        : kind === "success"
          ? t.success
          : kind === "info"
            ? t.info
            : t.error;
    const bg = blendBg(t.bg, fg, 0.1);
    const head =
      paintOnFill(glyph, fg, { bold: true }) +
      "  " +
      paintOnFill(label, fg, { bold: true }) +
      "  " +
      paintOnFill(stripAnsi(meta), t.dim);
    const box = new Box(2, 0, bgFn(bg));
    box.addChild(new Text(head, 0, 0));
    return box;
  }

  /**
   * Banner rendered directly as string lines. Used by `_renderBlockedBody`
   * which builds its body out of raw rows rather than a Component[] stack.
   */
  private _bannerLines(
    width: number,
    kind: "warning" | "success" | "error" | "info",
    glyph: string,
    label: string,
    meta: string,
  ): string[] {
    return this._banner(kind, glyph, label, meta).render(width);
  }

  private _editorRuleColor(
    disabled: boolean,
    agentSession: AgentSession | undefined,
    state?: { isBashMode: boolean },
  ): string {
    if (disabled) return this.theme.borderDim;
    if (state?.isBashMode) return this.theme.warning;
    const level = agentSession?.state.thinkingLevel ?? "off";
    switch (level) {
      case "minimal":
        return this.theme.borderDim;
      case "low":
        return this.theme.info;
      case "medium":
        return this.theme.accent;
      case "high":
        return this.theme.mauve;
      case "xhigh":
        return this.theme.error;
      case "off":
      default:
        return this.theme.border;
    }
  }

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  private _blank(width: number): string {
    return " ".repeat(width);
  }

  wantsMouseScrollTracking(): boolean {
    return true;
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------

  handleInput(data: string): boolean {
    if (this.mountedCustomUi) {
      if (matchesKey(data, "ctrl+d")) {
        this._rejectMountedCustomUi("stage custom UI detached");
        if (this._isPaused()) this.onClose();
        else this.onDetach();
        return true;
      }
      if (matchesKey(data, "ctrl+c")) {
        this._rejectMountedCustomUi("stage custom UI closed");
        this.onClose();
        return true;
      }
      setComponentFocused(this.mountedCustomUi.component, this.focused);
      this.mountedCustomUi.component.handleInput?.(data);
      this.requestRender?.();
      return true;
    }
    if (this.chatHost.handleScrollInput(data)) {
      return true;
    }
    if (matchesKey(data, "ctrl+d")) {
      if (this.chatHost.hasInputText()) return this.chatHost.handleInput(data);
      if (this._isPaused()) this.onClose();
      else this.onDetach();
      return true;
    }
    if (matchesKey(data, "escape")) {
      if (
        this._isStreaming() ||
        this.chatHost.isBashRunning() ||
        this.chatHost.isEditingBashCommand()
      ) {
        return this.chatHost.handleInput(data);
      }
      this.onClose();
      return true;
    }
    if (matchesKey(data, "ctrl+c")) {
      this.onClose();
      return true;
    }
    const readOnlyArchive = this._isReadOnlyArchive();
    if (readOnlyArchive) return true;
    const blocked = this._isBlocked();
    if (matchesKey(data, "ctrl+f")) {
      if (blocked) return true;
      void this.chatHost.submit("followUp");
      return true;
    }
    if (blocked) return true;
    return this.chatHost.handleInput(data);
  }

  invalidate(): void {
    // Stateless render reads directly from snapshot + handle.
  }

  dispose(): void {
    this._unsubscribeStore?.();
    this._unsubscribeStore = null;
    this._unsubscribeHandle?.();
    this._unsubscribeHandle = null;
    this._rejectMountedCustomUi("stage chat view disposed");
    this._unregisterStageUiHost?.();
    this._unregisterStageUiHost = null;
    this.chatHost.dispose();
  }

  private _hideMountedCustomUi(request: StageCustomUiRequest): void {
    const mounted = this.mountedCustomUi;
    if (!mounted || mounted.request.id !== request.id) return;
    this.mountedCustomUi = null;
    mounted.component.dispose?.();
    this.chatHost.focused = this.focused;
    this.chatHost.scrollToBottom();
    this.requestRender?.();
  }

  private _rejectMountedCustomUi(message: string): void {
    const mounted = this.mountedCustomUi;
    if (!mounted) return;
    this.mountedCustomUi = null;
    this.stageUiBroker.reject(mounted.request, new Error(`pi-workflows: ${message}`));
    mounted.component.dispose?.();
  }

  // ---- Test seams ----
  get _inputBuffer(): string {
    return this.chatHost.inputText();
  }
  get _transcript(): ReadonlyArray<TranscriptDebugEntry> {
    return this.chatHost.entries().flatMap((entry) => transcriptDebugEntries(entry));
  }
  get _statusMessage(): string {
    return this.chatHost.statusText();
  }
  get _isLocalPaused(): boolean {
    return this.localPaused;
  }
  get _hasAnimationTick(): boolean {
    return this.chatHost.hasAnimationTick();
  }
  get _bodyScrollFromBottom(): number {
    return this.chatHost.bodyScrollFromBottom();
  }
  get _lastBodyMaxScroll(): number {
    return this.chatHost.bodyMaxScroll();
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

interface TranscriptDebugEntry {
  readonly role: string;
  readonly text: string;
  readonly toolCallId: string;
  readonly state: string;
  readonly output: string;
}

function transcriptDebugEntries(entry: TranscriptEntry): TranscriptDebugEntry[] {
  if (isChatMessageEntry(entry) && entry.kind === "assistant") {
    const entries: TranscriptDebugEntry[] = [];
    const thinking = extractThinkingText(entry.message.content);
    const text = extractMessageText(entry.message.content);
    if (thinking)
      entries.push({
        role: "thinking",
        text: thinking,
        toolCallId: "",
        state: "",
        output: "",
      });
    if (text || entries.length === 0)
      entries.push({ ...entry, text, toolCallId: "", state: "", output: "" });
    return entries;
  }
  return [
    {
      ...entry,
      role: entry.role,
      text: transcriptDebugText(entry),
      toolCallId: transcriptDebugToolCallId(entry),
      state: transcriptDebugToolState(entry),
      output: transcriptDebugToolOutput(entry),
    },
  ];
}

function transcriptDebugText(entry: TranscriptEntry): string {
  if ("text" in entry && typeof entry.text === "string") return entry.text;
  if (isChatMessageEntry(entry)) {
    switch (entry.kind) {
      case "assistant":
        return extractMessageText(entry.message.content);
      case "tool":
        return entry.result
          ? extractToolResultText(entry.result)
          : `${entry.toolName} ${typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args ?? {})}`;
      case "bashExecution":
        return entry.message.output || entry.message.command;
      case "user":
      case "system":
        return entry.text;
      case "custom":
        return extractMessageText(entry.message.content);
      case "branchSummary":
      case "compactionSummary":
        return entry.message.summary;
    }
  }
  return "";
}

function transcriptDebugToolCallId(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool")
    return entry.toolCallId;
  if ("toolCallId" in entry && typeof entry.toolCallId === "string")
    return entry.toolCallId;
  return "";
}

function transcriptDebugToolState(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool") {
    if (entry.result?.isError) return "error";
    return entry.isPartial === false ? "success" : "pending";
  }
  if ("state" in entry && typeof entry.state === "string") return entry.state;
  return "";
}

function transcriptDebugToolOutput(entry: TranscriptEntry): string {
  if (isChatMessageEntry(entry) && entry.kind === "tool")
    return entry.result ? extractToolResultText(entry.result) : "";
  if ("output" in entry && typeof entry.output === "string")
    return entry.output;
  return "";
}

function cursorBlock(): string {
  return "\x1b[7m \x1b[0m";
}

function setComponentFocused(component: Component, focused: boolean): void {
  const candidate = component as Component & Partial<Focusable>;
  if ("focused" in candidate) candidate.focused = focused;
}

function isChatMessageEntry(entry: TranscriptEntry): entry is ChatMessageEntry {
  return "kind" in entry && entry.role !== "notice";
}

function extractThinkingText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null || typeof item !== "object") continue;
    const thinking = (item as { type?: unknown; thinking?: unknown }).thinking;
    if (
      (item as { type?: unknown }).type === "thinking" &&
      typeof thinking === "string"
    )
      parts.push(thinking);
  }
  return parts.join("\n\n");
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (item == null) continue;
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const obj = item as { type?: unknown; text?: unknown };
    if (typeof obj.text === "string") parts.push(obj.text);
    else if (obj.type === "text" && typeof obj.text === "string")
      parts.push(obj.text);
  }
  return parts.join("");
}

function extractToolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result == null || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  return extractMessageText(content);
}

function noticeSummary(n: StageNotice): string {
  const base = `~ ${n.kind} → ${n.to}`;
  return n.from ? `${base} (was ${n.from})` : base;
}

function shortenId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function bgFn(hex: string): (text: string) => string {
  const open = hexBg(hex);
  return (text: string) => open + text + RESET;
}

function editorThemeFromGraphTheme(t: GraphTheme): EditorTheme {
  const selected = (text: string): string =>
    hexBg(t.backgroundPanel) + hexToAnsi(t.text) + text + RESET;
  const normal = (text: string): string => hexToAnsi(t.text) + text + RESET;
  return {
    borderColor: (text: string) => hexToAnsi(t.border) + text + RESET,
    selectList: {
      selectedPrefix: selected,
      selectedText: selected,
      description: (text: string) => hexToAnsi(t.dim) + text + RESET,
      scrollInfo: (text: string) => hexToAnsi(t.dim) + text + RESET,
      noMatch: (text: string) => hexToAnsi(t.warning) + text + RESET,
      normal,
    },
  } as EditorTheme;
}

interface PaintOpts {
  bold?: boolean;
  italic?: boolean;
  bg?: string;
}

function paint(text: string, fg: string, opts: PaintOpts = {}): string {
  if (!text) return "";
  let out = hexToAnsi(fg);
  if (opts.bold) out += BOLD;
  if (opts.italic) out += ITALIC;
  if (opts.bg) out = hexBg(opts.bg) + out;
  return out + text + RESET;
}

/**
 * Foreground styling for text that will be wrapped by a `Box` background.
 * A normal `RESET` would also clear the parent background, so close only the
 * inline foreground/weight/italic state and let `bgFn()` reset the row at end.
 */
function paintOnFill(text: string, fg: string, opts: PaintOpts = {}): string {
  if (!text) return "";
  let out = hexToAnsi(fg);
  if (opts.bold) out += BOLD;
  if (opts.italic) out += ITALIC;
  let close = FG_RESET;
  if (opts.bold) close += WEIGHT_RESET;
  if (opts.italic) close += ITALIC_RESET;
  return out + text + close;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

/**
 * Approximate a tinted background by mixing the base canvas with a saturated
 * hue at low alpha. Used for status pills and tool-bar tints. Returns a hex
 * colour the renderer can feed to `hexBg`.
 */
function blendBg(baseHex: string, tintHex: string, alpha: number): string {
  return lerpColor(baseHex, tintHex, Math.max(0, Math.min(1, alpha)));
}
