/**
 * WorkflowGraphOverlayAdapter — mounts the orchestrator as a full-screen
 * overlay via Pi / pi's real `ctx.ui.custom(factory, options)`
 * primitive. The overlay fills the terminal (`width: "100%"`,
 * `maxHeight: "100%"`, `margin: 0`) and pi-tui's `setHidden` flag is used
 * for cheap show/hide toggles — every remount commits the previous overlay
 * frame into chat scrollback, so the adapter holds onto the OverlayHandle
 * and flips visibility instead of unmounting.
 *
 * cross-ref:
 *   - src/tui/graph-view.ts
 *   - src/tui/workflow-attach-pane.ts
 *   - src/extension/wiring.ts  PiCustomOverlayOptions, PiOverlayHandle
 *   - @earendil-works/pi-tui dist/tui.d.ts  OverlayOptions, OverlayHandle
 *   - @bastani/atomic docs/tui.md (overlay primitives)
 */

import type { Store } from "../shared/store.js";
import type { StoreSnapshot } from "../shared/store-types.js";
import type { ChatMessageRenderOptions, ReadonlyFooterDataProvider } from "@bastani/atomic";
import { WorkflowAttachPane } from "./workflow-attach-pane.js";
import { deriveGraphThemeFromPiTheme } from "./graph-theme.js";
import { killRun as defaultKillRun } from "../runs/background/status.js";
import { cancellationRegistry } from "../runs/background/cancellation-registry.js";
import { stageControlRegistry as defaultStageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageControlRegistry } from "../runs/foreground/stage-control-registry.js";
import type { StageUiBroker } from "../shared/stage-ui-broker.js";
import type {
  PiCustomComponent,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiCustomOverlayOptions,
  PiEditorFactory,
  PiKeybindings,
  PiOverlayHandle,
  PiOverlayOptions,
  PiTheme,
} from "../extension/wiring.js";

export type OverlayChatRenderSettings = Partial<Omit<ChatMessageRenderOptions, "ui" | "cwd">>;

export interface OverlayUISurface {
  custom?: PiCustomOverlayFunction;
  getEditorComponent?: () => PiEditorFactory | undefined;
  getChatRenderSettings?: () => OverlayChatRenderSettings | undefined;
  getFooterDataProvider?: () => ReadonlyFooterDataProvider;
}

export interface OverlayPiSurface {
  ui?: OverlayUISurface;
}

/**
 * Port exposed to the extension factory.
 * `open(runId)`  — bring the pane to front (creating it if needed).
 * `toggle(runId)`— show if hidden, hide if visible, create if absent.
 * `close()`      — permanently dismiss.
 *
 * Optional `stageId` (on `open`) opens directly on the stage-chat
 * surface for that node — used by `/workflow attach <runId> <stageId>`
 * and the picker overlay's connect-to-stage flow.
 */
export interface GraphOverlayPort {
  open(runId: string | null, surface?: OverlayPiSurface, stageId?: string): void;
  toggle(runId: string | null, surface?: OverlayPiSurface): void;
  close(): void;
}

/**
 * Aspirational full-screen overlay geometry. In a future host that
 * forwards `overlayOptions` to pi-tui's `resolveOverlayLayout`,
 * `width`/`maxHeight` would expand against terminal dimensions so the
 * popup fills the entire frame, with `margin: 0` removing the breathing
 * room a centered popup needs.
 *
 * Current pi interactive `ExtensionUiController.custom` ignores
 * this object: it always mounts overlays with `{ anchor:
 * "bottom-center", width: "100%", maxHeight: "100%", margin: 0 }`. The
 * value is retained for `onHandle`-based toggle support and forward
 * compatibility — see `PiCustomOverlayOptions` for the host-compat
 * note.
 *
 * Note: percent geometry is necessary but not sufficient for a true
 * full-screen overlay — pi-tui positions the popup based on the
 * rendered overlay line count, so the mounted component must also
 * emit `terminal.rows` lines per frame. That row count is threaded
 * through `WorkflowAttachPane.getViewportRows` below.
 */
const FULLSCREEN_OVERLAY_OPTIONS: PiOverlayOptions = {
  anchor: "center",
  width: "100%",
  maxHeight: "100%",
  margin: 0,
};

const MOUSE_SCROLL_TRACKING_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_SCROLL_TRACKING_OFF = "\x1b[?1006l\x1b[?1000l";

function setMouseScrollTracking(enabled: boolean): void {
  if (!process.stdout.isTTY) return;
  process.stdout.write(enabled ? MOUSE_SCROLL_TRACKING_ON : MOUSE_SCROLL_TRACKING_OFF);
}

export interface BuildGraphOverlayAdapterOpts {
  /**
   * Live stage-control registry threaded through to the attach shell.
   * Defaults to the singleton registry registered alongside the store.
   */
  stageControlRegistry?: StageControlRegistry;
  /** Broker used to route stage-local custom UI into attached stage chats. */
  stageUiBroker?: StageUiBroker;
  /**
   * Kill hook used by graph-mode `q`. The extension factory supplies this so
   * persistence can record a terminal event while retaining the run for
   * inspection.
   */
  onKillRun?: (runId: string) => void;
  /** Optional clock injection for deterministic attach-pane transition tests. */
  now?: () => number;
}

export function buildGraphOverlayAdapter(
  pi: OverlayPiSurface,
  store: Store,
  buildOpts: BuildGraphOverlayAdapterOpts = {},
): GraphOverlayPort {
  const registry = buildOpts.stageControlRegistry ?? defaultStageControlRegistry;
  const stageUiBroker = buildOpts.stageUiBroker;
  const killRun = buildOpts.onKillRun ?? ((id: string): void => {
    defaultKillRun(id, { store, cancellation: cancellationRegistry });
  });
  let currentView: WorkflowAttachPane | null = null;
  // pi-tui returns an OverlayHandle via `options.onHandle`. We hold onto
  // it so toggle() can flip `setHidden` rather than remounting the
  // overlay — every remount commits the previous overlay frame into
  // the chat scrollback, producing visible duplicates.
  let currentHandle: PiOverlayHandle | null = null;
  let mounted = false;
  let finishMounted: (() => void) | null = null;

  function close(): void {
    setMouseScrollTracking(false);
    currentHandle?.hide();
    finishMounted?.();
    currentView?.dispose();
    currentHandle = null;
    finishMounted = null;
    currentView = null;
    mounted = false;
  }

  /**
   * Non-destructive close path used by graph-mode `Ctrl+D` / `h`. Goes
   * through Pi/pi public primitives in priority order:
   *   1. `OverlayHandle.setHidden(true)` when the host exposed an
   *      overlay handle via `options.onHandle`. Keeps the overlay
   *      mounted so a subsequent `open()` can flip it back without
   *      remounting (state and animations survive).
   *   2. The factory `done(undefined)` callback when the host didn't
   *      expose an OverlayHandle. Per pi docs, this disposes the
   *      component, hides the overlay if present, restores focus to
   *      the editor, and resolves the custom() promise.
   *
   * Critically: this never touches `killRun`, `cancellationRegistry`,
   * or any run-cancellation surface — the backing workflow keeps
   * running and can be re-attached.
   */
  function hideMounted(): void {
    setMouseScrollTracking(false);
    if (currentHandle) {
      currentView?.setVisible(false);
      currentHandle.setHidden(true);
      currentHandle.unfocus();
      return;
    }
    if (finishMounted) {
      finishMounted();
      return;
    }
  }

  function refocusVisibleOverlayForAwaitingInput(snapshot: StoreSnapshot): void {
    if (currentHandle === null) return;
    if (currentHandle.isHidden()) return;
    if (currentHandle.isFocused()) return;
    if (currentView?.wantsFocusForAwaitingInput(snapshot) !== true) return;
    currentHandle.focus();
  }

  function makeComponent(
    view: WorkflowAttachPane,
    tui: PiCustomOverlayFactoryTui,
  ): PiCustomComponent {
    const onStoreUpdate = (snapshot: StoreSnapshot): void => {
      view.invalidate();
      refocusVisibleOverlayForAwaitingInput(snapshot);
      tui.requestRender?.();
    };
    const unsubscribe = store.subscribe(onStoreUpdate);
    return {
      render: (width: number) => view.render(width),
      handleInput: (data: string) => {
        const consumed = view.handleInput(data);
        if (consumed) tui.requestRender?.();
      },
      invalidate: () => tui.requestRender?.(),
      dispose: () => {
        setMouseScrollTracking(false);
        unsubscribe();
        view.dispose();
      },
    };
  }

  function open(
    runId: string | null,
    surface?: OverlayPiSurface,
    stageId?: string,
  ): void {
    // Already mounted but hidden — flip visibility without remounting.
    if (mounted && currentHandle?.isHidden()) {
      currentView?.retarget(runId, stageId);
      currentView?.setVisible(true);
      setMouseScrollTracking(currentView?.wantsMouseScrollTracking() ?? true);
      currentHandle.setHidden(false);
      currentHandle.focus();
      return;
    }
    if (mounted) {
      currentView?.retarget(runId, stageId);
      setMouseScrollTracking(currentView?.wantsMouseScrollTracking() ?? true);
      // Restore keyboard focus to the visible overlay after retargeting.
      // pi-tui dispatches key events only to the focused component, so a
      // mounted-but-visible overlay that is retargeted (e.g. to a stage-scoped
      // HIL prompt / readiness gate) would otherwise appear frozen — arrows,
      // Enter, Ctrl+D and `q` all dead — if focus stayed on an underlying or
      // previously-focused pane (issue #1120).
      currentHandle?.focus();
      return;
    }

    const ui = surface?.ui ?? pi.ui;
    const custom = ui?.custom;
    if (typeof custom !== "function") return;
    const uiStatus = ui as { setStatus?: (key: string, value: string | undefined) => void } | undefined;

    let settled = false;
    const factory = (
      tui: PiCustomOverlayFactoryTui,
      theme: PiTheme,
      keybindings: PiKeybindings,
      done: (result: undefined) => void,
    ): PiCustomComponent => {
      const finish = (): void => {
        if (settled) return;
        settled = true;
        setMouseScrollTracking(false);
        currentView?.dispose();
        currentView = null;
        currentHandle = null;
        finishMounted = null;
        mounted = false;
        done(undefined);
      };
      const view = new WorkflowAttachPane({
        store,
        graphTheme: deriveGraphThemeFromPiTheme(theme),
        runId,
        stageControlRegistry: registry,
        stageUiBroker,
        uiStatus,
        onClose: finish,
        onHide: hideMounted,
        onKill: killRun,
        initialAttachStageId: stageId,
        piTui: tui,
        piTheme: theme,
        piKeybindings: keybindings,
        piEditorFactory: ui?.getEditorComponent?.(),
        getChatRenderSettings: ui?.getChatRenderSettings,
        footerData: ui?.getFooterDataProvider?.(),
        // Pi-tui owns terminal dimensions; thread its row count down
        // so the overlay frame fills the actual viewport rather than
        // a hard-coded 32-row rectangle. Returning `undefined` keeps
        // the existing fallback for hosts that don't expose
        // `tui.terminal`.
        getViewportRows: () => tui.terminal?.rows,
        // Drive the graph-view animation tick. Short-circuit when the
        // overlay is hidden so a `setHidden(true)`-ed overlay does
        // not waste CPU on render passes the user can't see. The
        // pane's own `mode === "graph"` gate covers the chat-view
        // case (see workflow-attach-pane.ts).
        requestRender: () => {
          if (currentHandle?.isHidden() === true) return;
          tui.requestRender?.();
        },
        // Re-assert overlay keyboard focus on demand. The attached stage chat
        // calls this when it shows a broker custom UI (e.g. the readiness gate)
        // so the gate receives input even if focus drifted off the overlay
        // while the agent's turn was streaming (#1120).
        requestFocus: () => {
          if (currentHandle?.isHidden() === true) return;
          // Idempotent: only grab focus if the overlay does not already own it.
          // A redundant focus() while already focused re-runs pi-tui's focus
          // transition mid-stream and stalls the agent's continuation (#1120,
          // the "ac" freeze). Skipping the no-op case lets callers ask for focus
          // freely — e.g. when showing a mid-turn ask_user_question — without a
          // fragile "only when not streaming" guard at every call site.
          if (currentHandle?.isFocused() === true) return;
          currentHandle?.focus();
        },
        setMouseScrollTracking,
        now: buildOpts.now,
      } as ConstructorParameters<typeof WorkflowAttachPane>[0] & {
        piTui?: PiCustomOverlayFactoryTui;
        piTheme?: PiTheme;
        piKeybindings?: PiKeybindings;
      });
      currentView = view;
      finishMounted = finish;
      mounted = true;
      setMouseScrollTracking(view.wantsMouseScrollTracking());
      return makeComponent(view, tui);
    };

    const options: PiCustomOverlayOptions = {
      overlay: true,
      overlayOptions: FULLSCREEN_OVERLAY_OPTIONS,
      onHandle: (handle) => {
        currentHandle = handle;
      },
    };
    void custom(factory, options);
  }

  function toggle(runId: string | null, surface?: OverlayPiSurface): void {
    // Hide without unmounting if we have a handle (no remount means
    // no scroll-pollution).
    if (mounted && currentHandle) {
      const nowHidden = !currentHandle.isHidden();
      currentView?.setVisible(!nowHidden);
      setMouseScrollTracking(
        nowHidden ? false : currentView?.wantsMouseScrollTracking() ?? true,
      );
      currentHandle.setHidden(nowHidden);
      if (!nowHidden) currentHandle.focus();
      return;
    }
    if (mounted) {
      hideMounted();
      return;
    }
    open(runId, surface);
  }

  return { open, toggle, close };
}
