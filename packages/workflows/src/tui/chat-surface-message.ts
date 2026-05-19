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
import type { RunSnapshot, RunStatus } from "../shared/store-types.js";
import type { GraphTheme } from "./graph-theme.js";
import type { WorkflowListEntry } from "./workflow-list.js";
import { renderDispatchConfirm } from "./dispatch-confirm.js";
import { renderRunDetail } from "./run-detail.js";
import { renderStatusList } from "./status-list.js";
import { renderWorkflowList } from "./workflow-list.js";
import { renderWorkflowKilledNotice } from "./session-confirm.js";

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
  inputs: Readonly<Record<string, unknown>>;
}

/**
 * Status list after `/workflow status`. The snapshot is captured (and
 * `--all`-filtered) at emit time — scrollback entries don't live-update
 * (the orchestrator widget owns live state).
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

/** Inline notice after a workflow run is destructively killed and removed. */
export interface KilledPayload {
  kind: "killed";
  run: RunSnapshot;
  previousStatus: RunStatus;
  wasInFlight: boolean;
}

export type ChatSurfacePayload =
  | DispatchPayload
  | StatusPayload
  | ListPayload
  | DetailPayload
  | KilledPayload;

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

  // The project's local `ExtensionAPI` types `registerMessageRenderer` as
  // returning a plain string. pi's runtime also accepts a Component (see
  // docs/extensions.md §Custom UI). Cast through `unknown` so the call
  // typechecks against both shapes. `.call(pi, …)` preserves `this` for
  // pi's class-backed ExtensionAPI.
  (register as unknown as (event: string, r: RawRenderer) => void).call(
    pi,
    CHAT_SURFACE_CUSTOM_TYPE,
    renderer,
  );
  rendererRegisteredHosts.add(pi);
}

/**
 * Emit a chat-surface message. The renderer (registered once at startup)
 * is invoked by pi on every chat re-render with the real chat content
 * width — there's no need for the caller to thread `process.stdout.columns`.
 */
export function emitChatSurface(
  pi: ExtensionAPI,
  payload: ChatSurfacePayload,
): void {
  const send = pi.sendMessage;
  if (typeof send !== "function") return;
  // `content` is unused by our renderer but pi's message store may surface
  // it in non-display contexts (e.g. transcript export); pick a short
  // descriptor per kind so it remains greppable.
  const content = describePayload(payload);
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

function describePayload(payload: ChatSurfacePayload): string {
  switch (payload.kind) {
    case "dispatch": return `dispatched ${payload.workflowName} · ${payload.runId.slice(0, 8)}`;
    case "status":   return `status · ${payload.runs.length} run${payload.runs.length === 1 ? "" : "s"}`;
    case "list":     return `workflows · ${payload.entries.length} registered`;
    case "detail":   return `run detail · ${payload.detail.runId.slice(0, 8)}`;
    case "killed":   return `workflow killed · ${payload.run.id.slice(0, 8)}`;
  }
}

function makeComponent(
  payload: ChatSurfacePayload,
  theme: GraphTheme,
): CardComponent {
  return {
    render(width: number): string[] {
      // pi passes the real chat content width; thread it down to every
      // primitive so band fillers and card gaps land exactly on the
      // right-edge cell. No `process.stdout.columns` heuristic needed.
      return renderPayload(payload, theme, width).split("\n");
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
      return renderStatusList(payload.runs, { theme, width });
    case "list":
      return renderWorkflowList(payload.entries, { theme, width });
    case "detail":
      return renderRunDetail(payload.detail, { theme, width });
    case "killed":
      return renderWorkflowKilledNotice({
        width,
        theme,
        run: payload.run,
        previousStatus: payload.previousStatus,
        wasInFlight: payload.wasInFlight,
      }).join("\n");
  }
}
