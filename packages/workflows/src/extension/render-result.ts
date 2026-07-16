/**
 * Render the workflow tool result for chat / LLM-tool surfaces.
 *
 * Workflow surfaces delegate to the canonical rounded renderers in `src/tui/`.
 * Compact status/error/control responses are wrapped in the same rounded
 * notice panel vocabulary so tool output stays visually consistent.
 *
 * cross-ref:
 *  - src/tui/status-list.ts  band-header status list
 *  - src/tui/run-detail.ts   per-run detail block
 *  - pi-subagents src/extension/index.ts renderResult slot
 */

import type { PendingPrompt, RunSnapshot, StageInputRequest, StageSnapshot, StageStatus } from "../shared/store-types.js";
import type { WorkflowDetails } from "../shared/types.js";
import type { RunDetail } from "../runs/background/status.js";
import { renderInputsSchema } from "../shared/render-inputs-schema.js";
import { renderStatusList } from "../tui/status-list.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";
import { renderRunDetail } from "../tui/run-detail.js";
import { renderWorkflowList } from "../tui/workflow-list.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { renderDispatchConfirm } from "../tui/dispatch-confirm.js";
import type { WorkflowInputValues, WorkflowOutputValues } from "../shared/types.js";
import { renderRoundedBox } from "../tui/chat-surface.js";
import { truncateToWidth } from "../tui/text-helpers.js";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// Result variants
// ---------------------------------------------------------------------------

/* WorkflowRunEntry — removed. The status surface now consumes the
 * canonical `RunSnapshot` shape directly; the intermediate `runs` projection
 * is gone. */

export interface WorkflowInputEntry {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  /**
   * Allowed values when `type` is `"select"` — surfaces in the picker as a
   * radio row and in the pretty inputs listing as a `values:` line.
   */
  choices?: readonly string[];
  /** Optional hint shown when the field is empty in the interactive picker. */
  placeholder?: string;
}

/**
 * One entry per registered workflow, sourced from the live registry.
 * Carries the metadata the catalogue surface needs.
 */
export interface WorkflowListItem {
  name: string;
  description: string;
  inputs: ReadonlyArray<{ name: string; required?: boolean }>;
}
type ListResult = {
  action: "list";
  items: WorkflowListItem[];
};
type StatusResult = {
  action: "status";
  /** Live snapshots from the in-process store. */
  snapshots: RunSnapshot[];
};
type StatusDetailResult =
  | {
      action: "statusDetail";
      runId: string;
      detail: RunDetail;
    }
  | {
      action: "statusDetail";
      runId: string;
      error: string;
    };
type InputsResult = { action: "inputs"; name: string; inputs: WorkflowInputEntry[]; error?: string };
type GetResult = {
  action: "get";
  workflow: string;
  details?: WorkflowDetails;
  error?: string;
};
type RunResult = {
  action: "run";
  name?: string;
  runId: string;
  status: string;
  result?: WorkflowOutputValues;
  details?: WorkflowDetails;
  error?: string;
  exited?: boolean;
  exitReason?: string;
  stages?: StageSnapshot[];
  /**
   * Free-form message carried by the result. Carries the "started in
   * background" copy emitted by `runDetached()`; foreground-completion
   * results don't set this since `error`/`stages` cover them.
   */
  message?: string;
};
type StageListItem = {
  id: string;
  name: string;
  status: StageStatus;
  sessionId?: string;
  sessionFile?: string;
  transcriptPath?: string;
  error?: string;
  skippedReason?: string;
  awaitingInputSince?: number;
  pendingPrompt?: PendingPrompt;
  inputRequest?: StageInputRequest;
  promptFootprint?: PendingPrompt;
};
type StageListResult = { action: "stages"; runId: string; filter: string; stages: StageListItem[]; error?: string };
type StageDetailItem = StageSnapshot & { transcriptPath?: string };
type StageDetailResult = { action: "stage"; runId: string; stage?: StageDetailItem; error?: string };
type TranscriptEntry = { role: string; text?: string; toolName?: string; output?: string; timestamp?: number };
type TranscriptInlineMode = "path_only" | "preview" | "fallback_preview";
type TranscriptResult = {
  action: "transcript";
  runId: string;
  stageId: string;
  source: "live" | "snapshot" | "error";
  entries: TranscriptEntry[];
  truncated: boolean;
  entryCount?: number;
  entryLimit?: number;
  sessionId?: string;
  sessionFile?: string;
  transcriptPath?: string;
  lazyReadPrompt?: string;
  fallbackNote?: string;
  inlineMode?: TranscriptInlineMode;
};
type SendResult = { action: "send"; runId: string; stageId: string; delivery: string; status: "ok" | "noop"; message: string };
type PauseResult = { action: "pause"; runId: string; status: string; message: string };
type ReloadResult = WorkflowReloadReport & { action: "reload"; status: "ok" | "noop"; message: string };
type InterruptResult = { action: "interrupt"; runId: string; status: string; message: string };
type KillResult = { action: "kill"; runId: string; status: string; message: string };
type ResumeResult = { action: "resume"; runId: string; status: string; message: string };

export type WorkflowToolResult =
  | ListResult
  | StatusResult
  | StatusDetailResult
  | InputsResult
  | GetResult
  | RunResult
  | StageListResult
  | StageDetailResult
  | TranscriptResult
  | SendResult
  | PauseResult
  | ReloadResult
  | InterruptResult
  | KillResult
  | ResumeResult;

export interface RenderResultOpts {
  isPartial?: boolean;
  /**
   * Host-provided render width in terminal cells. Tool renderers pass the
   * component width here so workflow tool output uses the same sizing path as
   * `/workflow` slash-command chat surfaces.
   */
  width?: number;
  /** Original workflow inputs from the tool call, used to render the same
   * dispatch confirmation card as `/workflow <name> ...` for background runs. */
  runInputs?: Readonly<WorkflowInputValues>;
  /**
   * Suppress ANSI colour output (CLI flag paths / non-TTY consumers).
   * When false/undefined the canonical Catppuccin chrome is rendered.
   */
  plain?: boolean;
  /**
   * Stable wall-clock used for elapsed-time labels in scrollback. Capture
   * once when the chat entry is created so subsequent host re-renders do
   * not silently tick `elapsed` / `running` durations — every off-viewport
   * tick forces pi-tui's full-redraw path (CSI 2J + CSI H + CSI 3J) and
   * is visible as whole-screen flicker under terminal emulators that do
   * not implement synchronized output (e.g. mosh).
   */
  now?: number;
}

/**
 * Returns a human-readable string describing the tool result. Multi-line
 * rich blocks for `status` / `statusDetail`; compact one-liners for the
 * remaining variants.
 *
 * Note: type assertions inside each `case` arm are required because the
 * fallback default below (`{ action: string }`) prevents TypeScript from
 * narrowing the union via `switch (result.action)`.
 */
function fitLine(line: string, width?: number): string {
  if (width === undefined || width <= 0) return line;
  return truncateToWidth(line, width, "…");
}

function noticeBodyLines(message: string, width?: number): string[] {
  return message.split(/\r?\n/).flatMap((line) => {
    if (line.length === 0 || width === undefined || width <= 0) return [line];
    return wrapTextWithAnsi(line, width);
  }).map((line) => ` ${line} `);
}

function renderNotice(
  title: string,
  message: string,
  opts: RenderResultOpts | undefined,
  themed: boolean,
): string {
  const theme = themed ? deriveGraphTheme({}) : undefined;
  const width = opts?.width;
  const contentWidth = width && width > 0 ? Math.max(1, width - 4) : undefined;
  return renderRoundedBox({
    title,
    bodyLines: noticeBodyLines(message, contentWidth),
    theme,
    width,
  });
}

const TRANSCRIPT_NOTICE_ENTRY_LIMIT = 5;
const TRANSCRIPT_NOTICE_CHAR_LIMIT = 240;

function transcriptEntriesNoticeText(entries: readonly TranscriptEntry[]): string {
  if (entries.length === 0) return "no transcript entries";
  const shown = entries.slice(0, TRANSCRIPT_NOTICE_ENTRY_LIMIT);
  const text = shown
    .map((entry) => `${entry.role}: ${entry.text ?? entry.output ?? entry.toolName ?? "(no body)"}`)
    .join(" | ");
  const entrySuffix = entries.length > shown.length
    ? ` … (+${entries.length - shown.length} more)`
    : "";
  return fitLine(`${text}${entrySuffix}`, TRANSCRIPT_NOTICE_CHAR_LIMIT);
}

function transcriptNoticeText(result: TranscriptResult): string {
  if ((result.inlineMode === "path_only" || result.lazyReadPrompt !== undefined) && result.entries.length === 0) {
    const path = result.transcriptPath ?? result.sessionFile ?? "transcript file";
    const count = result.entryCount === undefined
      ? ""
      : ` (${result.entryCount} ${result.entryCount === 1 ? "entry" : "entries"})`;
    return fitLine(`not inlined; read ${path}${count}`, TRANSCRIPT_NOTICE_CHAR_LIMIT);
  }
  const entriesText = transcriptEntriesNoticeText(result.entries);
  if (result.inlineMode === "fallback_preview" || result.fallbackNote !== undefined) {
    return fitLine(`no session file; preview: ${entriesText}`, TRANSCRIPT_NOTICE_CHAR_LIMIT);
  }
  return entriesText;
}

export function renderResult(result: WorkflowToolResult, opts?: RenderResultOpts): string {
  const partial = opts?.isPartial === true;
  const themed = opts?.plain !== true;

  // Runtime guard. The tool-result renderer passes `result.details`, which can
  // be absent or not yet shaped during streaming/partial renders or on error
  // paths that return content without a structured payload. Dereferencing a
  // missing `action` here previously threw and crashed the TUI render loop, so
  // degrade gracefully instead.
  if (
    result === null ||
    typeof result !== "object" ||
    typeof (result as { action?: unknown }).action !== "string"
  ) {
    return partial ? "" : renderNotice("WORKFLOW", "no result", opts, themed);
  }

  switch (result.action) {
    case "list": {
      const r = result as ListResult;
      return renderWorkflowList(r.items, {
        theme: themed ? deriveGraphTheme({}) : undefined,
        width: opts?.width,
      });
    }

    case "status": {
      const r = result as StatusResult;
      return renderStatusList(r.snapshots, {
        theme: themed ? deriveGraphTheme({}) : undefined,
        width: opts?.width,
        now: opts?.now,
      });
    }

    case "statusDetail": {
      if ("error" in result) {
        const r = result as Extract<StatusDetailResult, { error: string }>;
        return renderNotice("WORKFLOW STATUS", `id=${r.runId}: ${r.error}`, opts, themed);
      }
      const r = result as Extract<StatusDetailResult, { detail: RunDetail }>;
      return renderRunDetail(r.detail, {
        theme: themed ? deriveGraphTheme({}) : undefined,
        width: opts?.width,
        now: opts?.now,
      });
    }

    case "inputs": {
      const r = result as InputsResult;
      return renderInputsSchema(r.name, r.inputs, {
        theme: themed ? deriveGraphTheme({}) : undefined,
        width: opts?.width,
      });
    }

    case "get": {
      const r = result as GetResult;
      if (r.error) return renderNotice("WORKFLOW GET", `${r.workflow}: ${r.error}`, opts, themed);
      const output = r.details?.output;
      const description = typeof output?.["description"] === "string" ? ` — ${output["description"]}` : "";
      return renderNotice(
        "WORKFLOW GET",
        `${r.workflow}: ${r.details?.status ?? "completed"}${description}`,
        opts,
        themed,
      );
    }

    case "run": {
      const r = result as RunResult;
      if (partial) return renderNotice("WORKFLOW RUN", `${r.runId}: ${r.status} (in progress…)`, opts, themed);
      if (r.status === "failed" && !r.runId) {
        // Not-found path — render the error verbatim, no fake runId banner.
        const label = r.name ? ` (${r.name})` : "";
        return renderNotice("WORKFLOW RUN", `${label || "workflow"}: ${r.error ?? "workflow not found"}`, opts, themed);
      }
      if (r.error) {
        const label = r.name ? ` (${r.name})` : "";
        return renderNotice("WORKFLOW RUN", `${r.runId}${label}: ${r.status} — ${r.error}`, opts, themed);
      }
      if (r.details) {
        const label = r.name ? ` (${r.name})` : "";
        return renderNotice("WORKFLOW RUN", `${r.runId}${label}: ${r.details.mode} ${r.details.status}`, opts, themed);
      }
      if (r.status === "completed" || r.status === "skipped" || r.status === "cancelled" || r.status === "blocked" || r.status === "killed") {
        const label = r.name ? ` (${r.name})` : "";
        return renderNotice("WORKFLOW RUN", `${r.runId}${label}: ${r.status}`, opts, themed);
      }
      // Background dispatch — reuse the same confirmation card rendered by
      // `/workflow <name> ...` when we have the workflow name and run id.
      if (r.name && r.runId) {
        return renderDispatchConfirm({
          workflowName: r.name,
          runId: r.runId,
          inputs: opts?.runInputs ?? {},
          theme: themed ? deriveGraphTheme({}) : undefined,
          width: opts?.width,
        });
      }
      const label = r.name ? ` (${r.name})` : "";
      return renderNotice(
        "WORKFLOW RUN",
        `${r.runId}${label}: started in background — ${r.message ?? r.status}`,
        opts,
        themed,
      );
    }

    case "stages": {
      const r = result as StageListResult;
      if (r.error) return renderNotice("WORKFLOW STAGES", `${r.runId || "(none)"}: ${r.error}`, opts, themed);
      const counts = r.stages.map((s) => `${s.name} (${s.id.slice(0, 12)}): ${s.status}${s.skippedReason ? ` — ${s.skippedReason}` : ""}`).join("; ");
      return renderNotice("WORKFLOW STAGES", `${r.runId}: ${r.filter} — ${counts || "no stages"}`, opts, themed);
    }

    case "stage": {
      const r = result as StageDetailResult;
      if (r.error || !r.stage) return renderNotice("WORKFLOW STAGE", `${r.runId}: ${r.error ?? "stage not found"}`, opts, themed);
      const extra = r.stage.error ? ` — ${r.stage.error}` : r.stage.result ? ` — ${r.stage.result}` : "";
      return renderNotice("WORKFLOW STAGE", `${r.runId}: ${r.stage.name} (${r.stage.id.slice(0, 12)}) ${r.stage.status}${extra}`, opts, themed);
    }

    case "transcript": {
      const r = result as TranscriptResult;
      const text = transcriptNoticeText(r);
      const suffix = r.truncated ? " (truncated)" : "";
      return renderNotice("WORKFLOW TRANSCRIPT", `${r.runId}/${r.stageId.slice(0, 12)} ${r.source}: ${text}${suffix}`, opts, themed);
    }

    case "send": {
      const r = result as SendResult;
      return renderNotice("WORKFLOW SEND", `${r.runId}/${r.stageId.slice(0, 12)} ${r.delivery}: ${r.message}`, opts, themed);
    }

    case "pause": {
      const r = result as PauseResult;
      return renderNotice("WORKFLOW PAUSE", `${r.runId}: ${r.message}`, opts, themed);
    }

    case "reload": {
      const r = result as ReloadResult;
      return renderNotice("WORKFLOW RELOAD", r.message, opts, themed);
    }

    case "interrupt": {
      const r = result as InterruptResult;
      return renderNotice("WORKFLOW INTERRUPT", `${r.runId}: ${r.message}`, opts, themed);
    }

    case "kill": {
      const r = result as KillResult;
      return renderNotice("WORKFLOW KILL", `${r.runId}: ${r.message}`, opts, themed);
    }

    case "resume": {
      const r = result as ResumeResult;
      return renderNotice("WORKFLOW RESUME", `${r.runId}: ${r.message}`, opts, themed);
    }

    default: {
      // Runtime guard — handles values coerced from external sources.
      const fallback = result as { action: string; message?: string };
      return renderNotice("WORKFLOW", fallback.message ?? JSON.stringify(result), opts, themed);
    }
  }
}
