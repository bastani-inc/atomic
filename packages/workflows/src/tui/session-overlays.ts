/**
 * Mount adapter for the workflow session picker.
 *
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
} from "../extension/wiring.js";
import type { Store } from "../shared/store.js";
import type { GraphTheme } from "./graph-theme.js";
import {
  createSessionPickerState,
  handleSessionPickerInput,
  renderSessionPicker,
  selectRunsForPicker,
} from "./session-picker.js";


export interface UiSurface {
  custom?: PiCustomOverlayFunction;
}

export type SessionPickerIntent = "connect" | "pause" | "resume";

export type SessionPickerResult =
  | { kind: "connect"; runId: string }
  | { kind: "pause"; runId: string }
  | { kind: "resume"; runId: string }
  | { kind: "close" };

/**
 * Mount the session picker.
 *
 * `intent` (default `"connect"`) determines what Enter does on a row:
 *   - `connect`: resolve with `{ kind: "connect", runId }`.
 *   - `pause`: resolve with `{ kind: "pause", runId }`.
 *   - `resume`: resolve with `{ kind: "resume", runId }`.
 */
export function openSessionPicker(
  ui: UiSurface,
  store: Store,
  theme: GraphTheme,
  intent: SessionPickerIntent = "connect",
): Promise<SessionPickerResult> {
  function toResult(action: { kind: "connect"; runId: string }): SessionPickerResult {
    // Enter action arrives as `connect` from the picker; remap based on
    // caller intent so a pause/resume picker doesn't open the graph.
    if (intent === "pause") return { kind: "pause", runId: action.runId };
    if (intent === "resume") return { kind: "resume", runId: action.runId };
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
