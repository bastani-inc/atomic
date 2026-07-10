/**
 * Orchestration for the inline workflow input form (Option C: sticky chat
 * card + custom editor).
 *
 *   `registerInlineFormRenderer(pi)`   — call once at extension init time
 *                                       to wire `pi.registerMessageRenderer`
 *                                       for our customType. Idempotent.
 *
 *   `openInlineInputsForm(pi, ctx, …)` — drive a single form. Mutates the
 *                                       chat by emitting a custom message,
 *                                       mounts our editor as inline custom UI,
 *                                       awaits user input, then resolves with
 *                                       the coerced values (or cancel).
 *
 * The card stays in chat scrollback forever (frozen view after exit).
 *
 * cross-ref:
 *  - src/tui/inline-form-store.ts  (state map)
 *  - src/tui/inline-form-card.ts   (renderer used by message renderer)
 *  - src/tui/inline-form-editor.ts (custom EditorComponent)
 */

import type {
  ExtensionAPI,
  PiCommandContext,
} from "../extension/index.js";
import type { PiEditorComponent } from "../extension/wiring.js";
import type { WorkflowInputEntry } from "../extension/render-result.js";
import type { WorkflowInputValues } from "../shared/types.js";
import type { GraphTheme } from "./graph-theme.js";
import { renderInlineCard } from "./inline-form-card.js";
import { InlineFormEditor } from "./inline-form-editor.js";
import {
  createForm,
  finalizeForm,
  getForm,
} from "./inline-form-store.js";
import { coerceValues } from "./inputs-picker.js";

const CUSTOM_TYPE = "workflows:input-form";

interface FormMessageDetails {
  formId: string;
}

/**
 * Public result type — matches the popup-version contract so callers don't
 * care which surface was used.
 */
export type InlineFormResult =
  | { kind: "run"; values: WorkflowInputValues }
  | { kind: "cancel" }
  | { kind: "unsupported" };

export interface OpenInlineFormOpts {
  workflowName: string;
  fields: readonly WorkflowInputEntry[];
  prefilled?: WorkflowInputValues;
  theme: GraphTheme;
}

// ---------------------------------------------------------------------------
// Message renderer registration
// ---------------------------------------------------------------------------

const rendererRegisteredHosts = new WeakSet<object>();

/**
 * Renderer return shape (subset of pi-tui's `Component`). Defined locally so
 * the project doesn't need to import from `@earendil-works/pi-tui` (which is
 * a peer dep of pi-coding-agent that we don't link directly).
 */
interface CardComponent {
  render(width: number): string[];
  invalidate?(): void;
}

type RawRenderer = (payload: unknown) => CardComponent | null | undefined;

/**
 * Wire the message renderer once per live ExtensionAPI host. pi creates a new
 * extension host on `/new`, `/resume`, `/fork`, and `/reload`, while jiti may
 * keep this module cached. A process-global boolean would skip registration in
 * the replacement session and leave emitted workflow form messages without a
 * renderer.
 *
 * Theme is captured at registration. If pi's active theme changes later the
 * renderer continues with the original; acceptable since these cards are
 * mostly historical artefacts.
 */
export function registerInlineFormRenderer(pi: ExtensionAPI, theme: GraphTheme): void {
  if (rendererRegisteredHosts.has(pi)) return;
  const register = pi.registerMessageRenderer;
  if (typeof register !== "function") return;

  const renderer: RawRenderer = (raw) => {
    const message = raw as {
      content?: string;
      details?: { formId?: string };
    };
    const formId = message.details?.formId;
    if (!formId) return undefined;
    const state = getForm(formId);
    if (!state) {
      // No backing state — the session was resumed/replaced (the store is
      // cleared on session_start) or the map was evicted. Return null so the
      // host renders nothing: the input widget must not reappear in chat after
      // /resume rather than showing a stale or "snapshot lost" placeholder.
      return null;
    }
    return {
      // The card is fully reactive: read fresh state on every render call,
      // not just at construction time. pi's host re-runs render() whenever
      // `tui.requestRender()` fires — that's our editor's mutation signal.
      render: (width: number) =>
        renderInlineCard({
          width,
          state: getForm(formId) ?? state,
          theme,
        }),
      invalidate: () => {
        /* nothing cached; renders are pure of state */
      },
    };
  };

  // Call through `pi` so pi's class-backed ExtensionAPI keeps its `this` binding.
  register.call(pi, CUSTOM_TYPE, renderer);
  rendererRegisteredHosts.add(pi);
}

// ---------------------------------------------------------------------------
// Open / drive a form
// ---------------------------------------------------------------------------

/**
 * Open an inline form. Returns a Promise that resolves with the user's
 * coerced values on submit, `{kind:"cancel"}` on esc, or
 * `{kind:"unsupported"}` when the host cannot mount inline custom UI. The
 * unsupported result lets callers fall back to another picker surface instead
 * of surfacing a host custom UI exception to the user.
 *
 * Requirements:
 *   - `pi.sendMessage` is available to add the sticky form card
 *   - `ctx.ui.custom` is available to mount the focused inline editor surface
 *
 * Atomic suppresses the global Working loader for the non-overlay custom UI
 * mount while the form is waiting on user input; this overlay intentionally
 * leaves that global state to the host/runtime layer.
 */
export async function openInlineInputsForm(
  pi: ExtensionAPI,
  ctx: PiCommandContext,
  opts: OpenInlineFormOpts,
): Promise<InlineFormResult> {
  const ui = ctx.ui;
  const custom = ui?.custom;
  const sendMessage = pi.sendMessage;
  if (typeof custom !== "function" || typeof sendMessage !== "function") {
    return { kind: "unsupported" };
  }
  if (opts.fields.length === 0) {
    // Defensive — caller should already have gated on fields.length > 0.
    return { kind: "run", values: coerceValues(opts.fields, {}) };
  }

  // ── Seed state ────────────────────────────────────────────────────────
  const formId = makeFormId();
  const prefilled = opts.prefilled ?? {};
  const rawText: Record<string, string> = {};
  for (const f of opts.fields) {
    if (prefilled[f.name] !== undefined) {
      rawText[f.name] = String(prefilled[f.name]);
    } else if (f.default !== undefined) {
      rawText[f.name] = String(f.default);
    } else if (f.type === "select" && f.choices && f.choices.length > 0) {
      rawText[f.name] = f.choices[0]!;
    } else if (f.type === "boolean") {
      rawText[f.name] = "false";
    } else {
      rawText[f.name] = "";
    }
  }
  // Focus first invalid field if any.
  const firstInvalid = opts.fields.findIndex(
    (f) => f.required && (rawText[f.name] ?? "").trim() === "",
  );
  const focusedIdx = firstInvalid >= 0 ? firstInvalid : 0;
  const state = createForm({
    formId,
    workflowName: opts.workflowName,
    fields: opts.fields,
    rawText,
    focusedIdx,
    submitChoiceIdx: 0,
    caret: (rawText[opts.fields[focusedIdx]!.name] ?? "").length,
    status: "editing",
  });

  try {
    (sendMessage as unknown as (
      msg: {
        customType: string;
        content?: string;
        display?: boolean;
        details?: FormMessageDetails;
      },
      options?: { excludeFromContext?: boolean },
    ) => void).call(pi, {
      customType: CUSTOM_TYPE,
      content: opts.workflowName,
      display: true,
      details: { formId },
    }, {
      // The input form is a transient UI surface, not conversation. Keep it
      // out of LLM context so spawning the picker and exiting without
      // running the workflow never leaks the form into the model.
      excludeFromContext: true,
    });
  } catch {
    finalizeForm(formId, "cancel");
    return { kind: "unsupported" };
  }

  let settled = false;
  let activeEditor: PiEditorComponent | undefined;
  const finalizeIfNeeded = (result: InlineFormResult): InlineFormResult => {
    if (!settled) {
      settled = true;
      finalizeForm(formId, result.kind === "run" ? "submit" : "cancel");
    }
    return result;
  };
  const factory = (
    tui: { requestRender?: () => void },
    _editorTheme: unknown,
    kb: unknown,
    done: (result: InlineFormResult) => void,
  ): PiEditorComponent => {
    activeEditor = new InlineFormEditor(tui, {
      formId,
      theme: opts.theme,
      // Pi injects its `KeybindingsManager` as the third factory arg; the
      // editor uses it to route text-editing actions (delete word, line
      // jump, etc.) through the user's resolved keybindings. Older hosts
      // and tests pass a non-keybindings shape — the editor's
      // `isKeybindingsLike` guard handles that gracefully.
      keybindings: kb as ConstructorParameters<typeof InlineFormEditor>[1]["keybindings"],
      onExit: (outcome) => {
        const result: InlineFormResult = outcome === "submit"
          ? { kind: "run", values: coerceValues(opts.fields, state.rawText) }
          : { kind: "cancel" };
        done(finalizeIfNeeded(result));
      },
    });
    return activeEditor;
  };

  try {
    const result = await Promise.resolve(custom.call(ui, factory, { overlay: false }));
    if (result !== undefined) return finalizeIfNeeded(result as InlineFormResult);
  } catch {
    // If the host rejects mounting the inline custom UI, freeze the card as a
    // cancelled artefact and let the caller fall back to another picker surface.
  }
  activeEditor?.dispose?.();
  return finalizeIfNeeded({ kind: "unsupported" });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFormId(): string {
  // Short, monotonic-enough — no need for cryptographic uniqueness, just
  // enough separation between concurrent forms in scrollback.
  return `wf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
