/**
 * Mount adapter for the interactive argument picker. Reads like clack:
 * a single overlay mounts the picker via the real Pi `ctx.ui.custom(factory, options)`
 * primitive; user submit resolves the parent promise with the coerced
 * typed values. Escape resolves with `cancel` so the calling slash
 * command can short-circuit. When `pi.ui.custom` is unavailable the
 * promise resolves with `cancel` so the slash command can fall back to
 * the "missing required input" text path.
 *
 * The adapter handles the cursor-blink timer in addition to the standard
 * `pi.ui.custom` factory plumbing: a 530ms half-period interval (the
 * Neovim default rate, matching atomic's design TUI) drives a `cursorOn`
 * flag that's threaded into each render so single-line text fields show a
 * blinking caret instead of a static block.
 *
 * Mount mode
 * ----------
 * Uses the same bottom-pinned primitive as `ask_user_question`: mount with
 * `{ overlay: false }`. Atomic's interactive host treats non-overlay
 * `ctx.ui.custom()` as blocking user input, suppresses its global `Working…`
 * loader while the component is mounted, and replaces the editor with the
 * mounted picker (`editorContainer.clear(); addChild(component)`). That puts
 * the focused picker in the bottom editor slot instead of a floating overlay,
 * keeping host chrome from being wedged between the `/workflow …` command and
 * the picker. This avoids the prior bottom-anchored overlay regression captured
 * in `ui/workflows/Screenshot 2026-05-13 at 1.09.32 AM.png` without overlay
 * anchor/padding tricks — the host owns geometry and Working-state suppression.
 *
 * cross-ref:
 *   - src/tui/inputs-picker.ts (pure state + render)
 *   - src/tui/session-overlays.ts (sibling picker; same mount mode)
 *   - src/extension/wiring.ts (PiCustomOverlayFunction / PiOverlayOptions)
 *   - pi docs/tui.md  Mount points and return contracts
 */

import type {
  PiCustomComponent,
  PiCustomOverlayFactoryTui,
  PiCustomOverlayFunction,
} from "../extension/wiring.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { GraphTheme } from "./graph-theme.js";
import type { WorkflowInputValues } from "../shared/types.js";
import {
  coerceValues,
  createInputsPickerState,
  handleInputsPickerInput,
  renderInputsPicker,
} from "./inputs-picker.js";

export interface InputsUiSurface {
  custom?: PiCustomOverlayFunction;
}

export type InputsPickerResult =
  | { kind: "run"; values: WorkflowInputValues }
  | { kind: "cancel" };

export interface OpenInputsPickerOpts {
  workflowName: string;
  fields: WorkflowInputEntry[];
  /** Prefilled values (e.g. from `key=value` slash args). The form
   *  seeds these into the form so the user doesn't re-type what they typed. */
  prefilled?: WorkflowInputValues;
  theme: GraphTheme;
}

/**
 * Mount the inputs picker. Resolves with the coerced typed value map on
 * confirm, or `cancel` on esc / no UI surface.
 *
 * Behaviour matrix:
 *   - `pi.ui.custom` present: mounted in the editor slot, settled by `done()`
 *   - no `pi.ui.custom` at all: resolves `cancel` immediately so the slash
 *                               command can fall back to the "missing
 *                               required input" text path
 */
export function openInputsPicker(
  ui: InputsUiSurface,
  opts: OpenInputsPickerOpts,
): Promise<InputsPickerResult> {
  return new Promise<InputsPickerResult>((resolve) => {
    const { workflowName, fields, prefilled, theme } = opts;
    if (fields.length === 0) {
      // No inputs to collect — treat as immediate run with whatever the
      // caller already prefilled (likely empty).
      resolve({ kind: "run", values: coerceValues(fields, {}) });
      return;
    }

    const custom = ui.custom;
    if (typeof custom !== "function") {
      resolve({ kind: "cancel" });
      return;
    }

    const state = createInputsPickerState(fields, prefilled);
    let settled = false;
    let cursorOn = true;
    let cursorTimer: ReturnType<typeof setInterval> | null = null;

    const settleWithoutDone = (result: InputsPickerResult): void => {
      if (settled) return;
      settled = true;
      if (cursorTimer) clearInterval(cursorTimer);
      cursorTimer = null;
      resolve(result);
    };

    const factory = (
      tui: PiCustomOverlayFactoryTui,
      _theme: unknown,
      keys: unknown,
      done: (r: undefined) => void,
    ): PiCustomComponent => {
      // Start the blink as soon as the overlay mounts. We tear it down
      // on dispose to avoid leaking timers across overlay lifecycles.
      cursorTimer = setInterval(() => {
        cursorOn = !cursorOn;
        tui.requestRender?.();
      }, 530);

      const finish = (result: InputsPickerResult): void => {
        if (settled) return;
        settled = true;
        if (cursorTimer) clearInterval(cursorTimer);
        cursorTimer = null;
        try {
          done(undefined);
        } finally {
          resolve(result);
        }
      };

      return {
        render: (width: number) =>
          renderInputsPicker({
            width,
            theme,
            workflowName,
            fields,
            state,
            cursorOn,
          }),
        handleInput: (data: string) => {
          // Pi's `KeybindingsManager` is the third factory arg — the
          // picker uses it so user-configured text-editing actions
          // (delete word, line jump, etc.) work the same in the
          // fallback overlay as in the inline form. Pass it through
          // structurally; the picker guards the shape itself.
          const kb = keys as Parameters<typeof handleInputsPickerInput>[3];
          const action = handleInputsPickerInput(data, state, fields, kb);
          if (action.kind === "noop") {
            tui.requestRender?.();
            return;
          }
          finish(action);
        },
        invalidate: () => tui.requestRender?.(),
        dispose: () => {
          settleWithoutDone({ kind: "cancel" });
        },
      };
    };

    // overlay: false — picker replaces the editor in-place (see header
    // comment). The host owns geometry/focus; no overlayOptions are
    // forwarded by interactive pi today.
    try {
      void Promise.resolve(custom(factory, { overlay: false })).catch(() => {
        settleWithoutDone({ kind: "cancel" });
      });
    } catch {
      settleWithoutDone({ kind: "cancel" });
    }
  });
}
