/**
 * Render the workflow tool result for chat / LLM-tool surfaces.
 *
 * Rich background-workflow surfaces (status list, per-run detail) delegate
 * to the canonical Catppuccin renderers in `src/tui/`. Compact one-liners
 * (list/run/interrupt/resume) stay inline here.
 *
 * cross-ref:
 *  - src/tui/status-list.ts  band-header status list
 *  - src/tui/run-detail.ts   per-run detail block
 *  - pi-subagents src/extension/index.ts renderResult slot
 */

import type { RunSnapshot, StageSnapshot } from "../shared/store-types.js";
import type { WorkflowDetails } from "../shared/types.js";
import type { RunDetail } from "../runs/background/status.js";
import { renderInputsSchema } from "../shared/render-inputs-schema.js";
import { renderStatusList } from "../tui/status-list.js";
import { renderRunDetail } from "../tui/run-detail.js";
import { renderWorkflowList } from "../tui/workflow-list.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { renderDispatchConfirm } from "../tui/dispatch-confirm.js";
import { truncateToWidth } from "../tui/text-helpers.js";

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
  result?: Record<string, unknown>;
  details?: WorkflowDetails;
  error?: string;
  stages?: StageSnapshot[];
  /**
   * Free-form message carried by the result. Carries the "started in
   * background" copy emitted by `runDetached()`; foreground-completion
   * results don't set this since `error`/`stages` cover them.
   */
  message?: string;
};
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
  runInputs?: Readonly<Record<string, unknown>>;
  /**
   * Suppress ANSI colour output (CLI flag paths / non-TTY consumers).
   * When false/undefined the canonical Catppuccin chrome is rendered.
   */
  plain?: boolean;
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

export function renderResult(result: WorkflowToolResult, opts?: RenderResultOpts): string {
  const partial = opts?.isPartial === true;
  const themed = opts?.plain !== true;

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
      });
    }

    case "statusDetail": {
      if ("error" in result) {
        const r = result as Extract<StatusDetailResult, { error: string }>;
        return fitLine(`workflow status id=${r.runId}: ${r.error}`, opts?.width);
      }
      const r = result as Extract<StatusDetailResult, { detail: RunDetail }>;
      return renderRunDetail(r.detail, {
        theme: themed ? deriveGraphTheme({}) : undefined,
        width: opts?.width,
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
      if (r.error) return fitLine(`workflow get (${r.workflow}): ${r.error}`, opts?.width);
      const output = r.details?.output;
      const description = typeof output?.["description"] === "string" ? ` — ${output["description"]}` : "";
      return fitLine(
        `workflow get (${r.workflow}): ${r.details?.status ?? "completed"}${description}`,
        opts?.width,
      );
    }

    case "run": {
      const r = result as RunResult;
      if (partial) return fitLine(`workflow run ${r.runId}: ${r.status} (in progress…)`, opts?.width);
      if (r.status === "failed" && !r.runId) {
        // Not-found path — render the error verbatim, no fake runId banner.
        const label = r.name ? ` (${r.name})` : "";
        return fitLine(`workflow run${label}: ${r.error ?? "workflow not found"}`, opts?.width);
      }
      if (r.error) {
        const label = r.name ? ` (${r.name})` : "";
        return fitLine(`workflow run ${r.runId}${label}: ${r.status} — ${r.error}`, opts?.width);
      }
      if (r.details) {
        const label = r.name ? ` (${r.name})` : "";
        return fitLine(`workflow run ${r.runId}${label}: ${r.details.mode} ${r.details.status}`, opts?.width);
      }
      if (r.status === "completed" || r.status === "killed") {
        const label = r.name ? ` (${r.name})` : "";
        return fitLine(`workflow run ${r.runId}${label}: ${r.status}`, opts?.width);
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
      return fitLine(
        `workflow run ${r.runId}${label}: started in background — ${r.message ?? r.status}`,
        opts?.width,
      );
    }

    case "interrupt": {
      const r = result as InterruptResult;
      return fitLine(`workflow interrupt ${r.runId}: ${r.message}`, opts?.width);
    }

    case "kill": {
      const r = result as KillResult;
      return fitLine(`workflow kill ${r.runId}: ${r.message}`, opts?.width);
    }

    case "resume": {
      const r = result as ResumeResult;
      return fitLine(`workflow resume ${r.runId}: ${r.message}`, opts?.width);
    }

    default: {
      // Runtime guard — handles values coerced from external sources.
      const fallback = result as { action: string; message?: string };
      return fitLine(`workflow: ${fallback.message ?? JSON.stringify(result)}`, opts?.width);
    }
  }
}
