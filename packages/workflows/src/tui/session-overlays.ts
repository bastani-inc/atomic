/**
 * Mount adapters for the session picker and kill-confirmation overlays.
 *
 * Both overlays use Pi / pi's real `ctx.ui.custom(factory, options)`
 * primitive. There is no legacy object-shaped fallback — when the host
 * doesn't expose `pi.ui.custom` the picker resolves with `close` and the
 * kill-confirm falls back to `pi.ui.confirm` (or `false` when even that
 * is absent, since the action is destructive).
 *
 * Mount mode
 * ----------
 * The session picker uses `{ overlay: false }` — pi's interactive
 * `ExtensionUiController.custom` REPLACES the editor component with the
 * mounted picker (`editorContainer.clear(); addChild(picker)`), so the
 * picker renders **inline** in the chat layout at the editor's natural
 * position. This is what gives us the target spacing in
 * `ui/workflows/Screenshot 2026-05-13 at 1.11.49 AM.png`: the picker
 * sits just below the submitted `/workflow …` command at the picker's
 * natural ~9-row height, with no host `Working…` / widget / status bar
 * chrome wedged between command and picker (those rows are owned by
 * the editor area we just replaced).
 *
 * The kill-confirm intentionally stays on `{ overlay: true }` — it is a
 * destructive modal and reads better as a centered popup over the
 * editor, not as an inline replacement.
 *
 * cross-ref:
 *  - src/tui/session-picker.ts (state machine + render)
 *  - src/tui/overlay-adapter.ts (overlay:true full-screen graph mount)
 *  - src/extension/wiring.ts (PiCustomOverlayFunction / PiOverlayOptions)
 *  - pi docs/tui.md  Mount points and return contracts
 */

import type {
  PiCustomComponent,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
  PiOverlayOptions,
} from "../extension/wiring.js";
import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";
import {
  createSessionPickerState,
  handleSessionPickerInput,
  renderSessionPicker,
  selectRunsForPicker,
} from "./session-picker.js";
import {
  createKillConfirmState,
  handleKillConfirmInput,
  renderKillConfirm,
  renderWorkflowQuitConfirm,
} from "./session-confirm.js";
import type { RunSnapshot } from "../shared/store-types.js";

/**
 * Aspirational confirm-modal geometry. Current pi interactive
 * `custom()` does not forward `overlayOptions` to pi-tui's overlay
 * layout (it always uses `{ anchor: "bottom-center", width: "100%",
 * maxHeight: "100%", margin: 0 }`); the value is retained for future
 * hosts that honour the option bag and for the test seam.
 */
const CONFIRM_OVERLAY: PiOverlayOptions = {
  anchor: "center",
  width: "60%",
};

export interface UiSurface {
  custom?: PiCustomOverlayFunction;
}

export type SessionPickerIntent = "connect" | "kill" | "pause" | "resume";

export type SessionPickerResult =
  | { kind: "connect"; runId: string }
  | { kind: "kill"; runId: string }
  | { kind: "pause"; runId: string }
  | { kind: "resume"; runId: string }
  | { kind: "close" };

/**
 * Mount the session picker.
 *
 * `intent` (default `"connect"`) determines what Enter does on a row:
 *   - `connect`: resolve with `{ kind: "connect", runId }`.
 *   - `kill`: resolve with `{ kind: "kill", runId }` (caller still
 *     owns the destructive confirm — `x` on a row preserves the
 *     legacy fast-kill path).
 *   - `pause`: resolve with `{ kind: "pause", runId }`.
 *   - `resume`: resolve with `{ kind: "resume", runId }`.
 */
export function openSessionPicker(
  ui: UiSurface,
  store: Store,
  theme: GraphTheme,
  intent: SessionPickerIntent = "connect",
): Promise<SessionPickerResult> {
  function toResult(action: { kind: "connect" | "kill"; runId: string }): SessionPickerResult {
    if (action.kind === "kill") return { kind: "kill", runId: action.runId };
    // Enter action arrives as `connect` from the picker; remap based on
    // caller intent so a pause/resume picker doesn't open the graph.
    if (intent === "pause") return { kind: "pause", runId: action.runId };
    if (intent === "resume") return { kind: "resume", runId: action.runId };
    if (intent === "kill") return { kind: "kill", runId: action.runId };
    return { kind: "connect", runId: action.runId };
  }
  return new Promise<SessionPickerResult>((resolve) => {
    const custom = ui.custom;
    if (typeof custom !== "function") {
      // No custom-overlay surface — caller should fall back to a textual
      // path (e.g. resolve immediately as "close" so the slash command
      // can print a hint to use a runId argument).
      resolve({ kind: "close" });
      return;
    }

    const state = createSessionPickerState();
    let settled = false;
    let unsubscribe: (() => void) | null = null;

    const factory = (
      tui: PiCustomOverlayFactoryTui,
      _theme: unknown,
      _keys: unknown,
      done: (r: undefined) => void,
    ): PiCustomComponent => {
      const finish = (result: SessionPickerResult): void => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        unsubscribe = null;
        done(undefined);
        resolve(result);
      };
      // Re-render on store changes so newly-started runs appear and
      // status icons refresh without the user having to press a key.
      unsubscribe = store.subscribe(() => tui.requestRender?.());
      return {
        render: (width: number) => {
          const rows = selectRunsForPicker(store.runs(), state.query, state.includeAll);
          return renderSessionPicker({ width, theme, rows, state });
        },
        handleInput: (data: string) => {
          const rows = selectRunsForPicker(store.runs(), state.query, state.includeAll);
          const action = handleSessionPickerInput(data, state, rows);
          if (action.kind === "noop") {
            tui.requestRender?.();
            return;
          }
          if (action.kind === "close") finish({ kind: "close" });
          else if (action.kind === "connect") finish(toResult(action));
          else finish(toResult(action));
        },
        invalidate: () => tui.requestRender?.(),
        dispose: () => {
          unsubscribe?.();
          unsubscribe = null;
          if (!settled) {
            settled = true;
            resolve({ kind: "close" });
          }
        },
      };
    };

    // overlay: false — picker replaces the editor in-place (see header
    // comment). The host owns geometry/focus; no overlayOptions are
    // forwarded by interactive pi today.
    void custom(factory, { overlay: false });
  });
}

/**
 * Mount the kill-confirmation overlay. Resolves with `true` when the user
 * confirms, `false` otherwise. When `pi.ui.custom` is unavailable, falls
 * back to `pi.ui.confirm` if present, else returns `false` (safe default
 * for a destructive action).
 */
export interface ConfirmUiSurface extends UiSurface {
  confirm?: (title: string, message: string) => Promise<boolean>;
}

function observeCustomMount(
  mount: () => unknown,
  factoryInvoked: () => boolean,
  settleHostFailure: () => void,
): void {
  let result: unknown;
  try {
    result = mount();
  } catch {
    settleHostFailure();
    return;
  }

  Promise.resolve(result).then(
    () => {
      if (!factoryInvoked()) settleHostFailure();
    },
    () => settleHostFailure(),
  );
}

export function openKillConfirm(
  ui: ConfirmUiSurface,
  run: RunSnapshot,
  theme: GraphTheme,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const custom = ui.custom;
    if (typeof custom !== "function") {
      // Fall back to plain confirm dialog when available.
      if (typeof ui.confirm === "function") {
        ui.confirm(
          "Kill workflow run?",
          `Abort ${run.name} (${run.id.slice(0, 8)})? Active stage work will be discarded.`,
        ).then(resolve, () => resolve(false));
        return;
      }
      resolve(false);
      return;
    }

    const state = createKillConfirmState();
    let settled = false;
    let factoryInvoked = false;

    const settle = (result: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const factory = (
      tui: PiCustomOverlayFactoryTui,
      _theme: unknown,
      _keys: unknown,
      done: (r: undefined) => void,
    ): PiCustomComponent => {
      factoryInvoked = true;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        done(undefined);
        resolve(result);
      };
      return {
        render: (width: number) => renderKillConfirm({ width, theme, run, state }),
        handleInput: (data: string) => {
          const action = handleKillConfirmInput(data, state);
          if (action.kind === "noop") {
            tui.requestRender?.();
            return;
          }
          finish(action.kind === "confirm");
        },
        invalidate: () => tui.requestRender?.(),
        dispose: () => settle(false),
      };
    };

    observeCustomMount(
      () => custom(factory, { overlay: true, overlayOptions: CONFIRM_OVERLAY }),
      () => factoryInvoked,
      () => settle(false),
    );
  });
}

/**
 * Mount a safe default-cancel quit confirmation for active workflows.
 * Returns `undefined` when custom UI is unavailable so callers can fail open
 * for headless/automation paths instead of relying on a generic yes-default
 * confirm implementation.
 */
export function openWorkflowQuitConfirm(
  ui: UiSurface,
  runs: RunSnapshot[],
  theme: GraphTheme,
): Promise<boolean | undefined> {
  return new Promise<boolean | undefined>((resolve) => {
    const custom = ui.custom;
    if (typeof custom !== "function") {
      resolve(undefined);
      return;
    }

    const state = createKillConfirmState();
    let settled = false;
    let factoryInvoked = false;

    const settle = (result: boolean | undefined): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const factory = (
      tui: PiCustomOverlayFactoryTui,
      _theme: unknown,
      _keys: unknown,
      done: (r: undefined) => void,
    ): PiCustomComponent => {
      factoryInvoked = true;
      const finish = (result: boolean): void => {
        if (settled) return;
        settled = true;
        done(undefined);
        resolve(result);
      };
      return {
        render: (width: number) => renderWorkflowQuitConfirm({ width, theme, runs, state }),
        handleInput: (data: string) => {
          const action = handleKillConfirmInput(data, state);
          if (action.kind === "noop") {
            tui.requestRender?.();
            return;
          }
          finish(action.kind === "confirm");
        },
        invalidate: () => tui.requestRender?.(),
        dispose: () => settle(false),
      };
    };

    observeCustomMount(
      () => custom(factory, { overlay: true, overlayOptions: CONFIRM_OVERLAY }),
      () => factoryInvoked,
      () => settle(undefined),
    );
  });
}
