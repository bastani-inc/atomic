/**
 * Chat-scroll message renderer for the workflow chat surfaces.
 *
 * Why this exists:
 *   The simpler `print(rendered_string)` path runs our output through pi's
 *   `notify` → `showStatus` → `Text(paddingX=1)` pipeline, which wraps
 *   every line at `chatWidth - 2`. Our band + card chrome computes line
 *   widths to *exactly* `chatWidth`, so the trailing badge then folds onto
 *   a second visual row. Sizing to `cols - 2` as a workaround is a magic
 *   number that papers over the wrong abstraction.
 *
 *   `registerMessageRenderer` is the canonical Component path documented
 *   in pi/docs/extensions.md and pi/docs/tui.md: a customRenderer that
 *   returns a `{ render(width): string[] }` Component receives the *real*
 *   chat content width and bypasses the default Text wrapping entirely
 *   (custom-message.js detaches the default Box when a customRenderer
 *   returns truthy). Same pattern used by {@link registerInlineFormRenderer}
 *   for the workflow input card.
 *
 * Visual contract: see ui/mockups.html §1 (dispatch), §2 (status list),
 * §3 (workflow list); per-run drill-down is the run-detail surface.
 *
 * cross-ref:
 *  - src/tui/inline-form-overlay.ts (same pattern, different surface)
 *  - pi/dist/modes/interactive/components/custom-message.js — customRenderer hook
 */

import type { ExtensionAPI } from "../extension/index.js";
import type { RunDetail } from "../runs/background/status.js";
import type { RunSnapshot } from "../shared/store-types.js";
import type { WorkflowInputValues } from "../shared/types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { WorkflowListEntry } from "./workflow-list.js";
import { renderDispatchConfirm } from "./dispatch-confirm.js";
import { renderRunDetail } from "./run-detail.js";
import { renderStatusList } from "./status-list.js";
import { renderWorkflowList } from "./workflow-list.js";

/** Custom message type wired to {@link registerChatSurfaceRenderer}. */
export const CHAT_SURFACE_CUSTOM_TYPE = "workflows:chat-surface";

// ---------------------------------------------------------------------------
// Payload types — one per chat surface, discriminated on `kind`
// ---------------------------------------------------------------------------

/**
 * Dispatch confirm after `/workflow <name> …`. Renders a single tagged
 * card carrying the runId, workflow name, inputs, and a `● running`
 * badge, plus one `/workflow connect <id>` hint row. See
 * `src/tui/dispatch-confirm.ts` for the visual contract and the legacy
 * 7-row layout this replaced.
 */
export interface DispatchPayload {
  kind: "dispatch";
  workflowName: string;
  runId: string;
  inputs: Readonly<WorkflowInputValues>;
}

/**
 * Status list after `/workflow status`. The snapshot is captured (and
 * `--all`-filtered) at emit time — scrollback entries don't live-update
 * (the orchestrator widget owns live state). The wall-clock used for the
 * `elapsed` / `running` labels is likewise frozen once per chat entry; see
 * {@link makeComponent}.
 */
export interface StatusPayload {
  kind: "status";
  runs: readonly RunSnapshot[];
}

/** Workflow catalogue after `/workflow list`. */
export interface ListPayload {
  kind: "list";
  entries: readonly WorkflowListEntry[];
}

/** Per-run drill-down after `/workflow status <id>`. */
export interface DetailPayload {
  kind: "detail";
  detail: RunDetail;
}

export type ChatSurfacePayload =
  | DispatchPayload
  | StatusPayload
  | ListPayload
  | DetailPayload;

// ---------------------------------------------------------------------------
// Renderer registration
// ---------------------------------------------------------------------------

/**
 * Subset of pi-tui's `Component` we depend on. Defined locally so the
 * project doesn't import from `@earendil-works/pi-tui` directly — it's a
 * peer dep of pi-coding-agent we link transitively.
 */
interface CardComponent {
  render(width: number): string[];
  invalidate?(): void;
}

type RawRenderer = (payload: unknown) => string | CardComponent | undefined;

const rendererRegisteredHosts = new WeakSet<object>();

/**
 * Wire the chat-surface message renderer once per live ExtensionAPI host. pi
 * creates a new extension host on `/new`, `/resume`, `/fork`, and `/reload`,
 * while jiti may keep this module cached. A process-global boolean would skip
 * registration in the replacement session and leave emitted workflow chat cards
 * without a renderer. Theme is captured at registration; later theme changes
 * don't retro-style historical entries (acceptable — these are scrollback
 * snapshots, not live UI).
 */
export function registerChatSurfaceRenderer(
  pi: ExtensionAPI,
  theme: GraphTheme,
): void {
  if (rendererRegisteredHosts.has(pi)) return;
  const register = pi.registerMessageRenderer;
  if (typeof register !== "function") return;

  const renderer: RawRenderer = (raw) => {
    const message = raw as { details?: ChatSurfacePayload };
    const payload = message.details;
    if (!payload) return undefined;
    return makeComponent(payload, theme);
  };

  // `.call(pi, …)` preserves `this` for pi's class-backed ExtensionAPI.
  register.call(pi, CHAT_SURFACE_CUSTOM_TYPE, renderer);
  rendererRegisteredHosts.add(pi);
}

/**
 * Emit a chat-surface message. The renderer (registered once at startup)
 * is invoked by pi on every chat re-render with the real chat content
 * width — there's no need for the caller to thread `process.stdout.columns`.
 */
export interface RenderChatSurfacePlainTextOptions {
  readonly width?: number;
  readonly now?: number;
  readonly theme?: GraphTheme;
}

/**
 * Render the full printable fallback stored in pi's custom-message `content`.
 * The interactive TUI still uses `details` + the registered renderer; this
 * string is for print mode, transcripts, and any host that cannot mount the
 * custom component.
 */
export function renderChatSurfacePlainText(
  payload: ChatSurfacePayload,
  options: RenderChatSurfacePlainTextOptions = {},
): string {
  const themed = options.theme === undefined ? {} : { theme: options.theme };
  const width = options.width;
  const now = options.now ?? Date.now();

  switch (payload.kind) {
    case "dispatch": {
      const rendered = renderDispatchConfirm({
        workflowName: payload.workflowName,
        runId: payload.runId,
        inputs: payload.inputs,
        width,
        ...themed,
      });
      return [
        rendered,
        `run id: ${payload.runId}`,
        `inputs: ${formatPlainRecord(payload.inputs)}`,
      ].join("\n");
    }
    case "status": {
      const rendered = renderStatusList(payload.runs, { width, now, ...themed });
      if (payload.runs.length === 0) return rendered;
      return [
        rendered,
        "",
        ...payload.runs.map(
          (run) => `run id: ${run.id} · workflow: ${run.name} · status: ${run.status}`,
        ),
      ].join("\n");
    }
    case "list": {
      const rendered = renderWorkflowList(payload.entries, { width, ...themed });
      if (payload.entries.length === 0) return rendered;
      return [
        rendered,
        "",
        ...payload.entries.map(formatWorkflowEntryPlain),
      ].join("\n");
    }
    case "detail": {
      const rendered = renderRunDetail(payload.detail, { width, now, ...themed });
      const lines = [
        rendered,
        `run id: ${payload.detail.runId}`,
        `inputs: ${formatPlainRecord(payload.detail.inputs)}`,
      ];
      if (payload.detail.result !== undefined) {
        lines.push(`result: ${formatPlainValue(payload.detail.result)}`);
      }
      if (payload.detail.error !== undefined) {
        lines.push(`error: ${payload.detail.error}`);
      }
      return lines.join("\n");
    }
  }
}

export function emitChatSurface(
  pi: ExtensionAPI,
  payload: ChatSurfacePayload,
  options: { readonly content?: string } = {},
): void {
  const send = pi.sendMessage;
  if (typeof send !== "function") return;
  // The renderer consumes `details`, but print/json/transcript surfaces read
  // the stored `content`. Default to a complete printable rendering so
  // headless `/workflow list|status|status <id>` is useful without a TUI.
  const content = options.content ?? renderChatSurfacePlainText(payload);
  (send as unknown as (msg: {
    customType: string;
    content: string;
    display: boolean;
    details: ChatSurfacePayload;
  }) => void).call(pi, {
    customType: CHAT_SURFACE_CUSTOM_TYPE,
    content,
    display: true,
    details: payload,
  });
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function formatWorkflowEntryPlain(entry: WorkflowListEntry): string {
  const required = entry.inputs
    .filter((input) => input.required === true)
    .map((input) => input.name);
  const optional = entry.inputs
    .filter((input) => input.required !== true)
    .map((input) => input.name);
  const inputs = [
    required.length > 0 ? `required inputs: ${required.join(", ")}` : undefined,
    optional.length > 0 ? `optional inputs: ${optional.join(", ")}` : undefined,
  ].filter((part): part is string => part !== undefined);
  const inputSummary = inputs.length > 0 ? inputs.join(" · ") : "inputs: (none)";
  return `workflow: ${entry.name} · description: ${entry.description} · ${inputSummary}`;
}

function formatPlainRecord(record: Readonly<WorkflowInputValues>): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "(none)";
  return entries.map(([key, value]) => `${key}=${formatPlainValue(value)}`).join(", ");
}

function formatPlainValue(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function makeComponent(
  payload: ChatSurfacePayload,
  theme: GraphTheme,
): CardComponent {
  // Capture wall-clock ONCE, when the chat entry's component is created. The
  // render() lambda below re-runs on every TUI frame: pi-tui's Container.render
  // fans out to every child on each doRender, and the workflow/subagent live
  // widgets call requestRender() ~12x/sec while runs are active. Without a
  // frozen `now`, renderStatusList / renderRunDetail fall through to Date.now()
  // on each frame, ticking the `elapsed` / `running` labels. Once the entry has
  // scrolled above the viewport fold, that off-screen change pushes pi-tui's
  // doRender() into the full-redraw branch (CSI 2J + CSI H + CSI 3J), which
  // reads as a whole-screen flicker on terminals without synchronized-output
  // support (notably mosh). Freezing here is also semantically right: these are
  // point-in-time scrollback snapshots — the orchestrator widget owns live
  // state. requestRender() never invalidates, so makeComponent runs once per
  // entry; this mirrors the tool-result renderResult slot fix in
  // src/extension/index.ts (capture `now` once, reuse it across renders).
  const capturedNow = Date.now();
  return {
    render(width: number): string[] {
      // pi passes the real chat content width; thread it down to every
      // primitive so band fillers and card gaps land exactly on the
      // right-edge cell. No `process.stdout.columns` heuristic needed.
      return renderPayload(payload, theme, width, capturedNow).split("\n");
    },
    invalidate() {
      /* renders are pure of stored state; nothing to drop. */
    },
  };
}

function renderPayload(
  payload: ChatSurfacePayload,
  theme: GraphTheme,
  width: number,
  now: number,
): string {
  switch (payload.kind) {
    case "dispatch":
      return renderDispatchConfirm({
        workflowName: payload.workflowName,
        runId: payload.runId,
        inputs: payload.inputs,
        theme,
        width,
      });
    case "status":
      return renderStatusList(payload.runs, { theme, width, now });
    case "list":
      return renderWorkflowList(payload.entries, { theme, width });
    case "detail":
      return renderRunDetail(payload.detail, { theme, width, now });
  }
}
