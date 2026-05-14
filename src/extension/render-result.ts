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
import type { DoctorPayload } from "./doctor.js";
import type { RunDetail } from "../runs/background/status.js";
import { renderInputsSchema } from "../shared/render-inputs-schema.js";
import { renderStatusList } from "../tui/status-list.js";
import { renderRunDetail } from "../tui/run-detail.js";
import { renderWorkflowList } from "../tui/workflow-list.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";

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
type DoctorResult = {
  action: "doctor";
  details: WorkflowDetails;
  payload?: DoctorPayload;
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
type ResumeResult = { action: "resume"; runId: string; status: string; message: string };

export type WorkflowToolResult =
  | ListResult
  | StatusResult
  | StatusDetailResult
  | InputsResult
  | GetResult
  | DoctorResult
  | RunResult
  | InterruptResult
  | ResumeResult;

export interface RenderResultOpts {
  isPartial?: boolean;
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
export function renderResult(result: WorkflowToolResult, opts?: RenderResultOpts): string {
  const partial = opts?.isPartial === true;
  const themed = opts?.plain !== true;

  switch (result.action) {
    case "list": {
      const r = result as ListResult;
      return renderWorkflowList(r.items, {
        theme: themed ? deriveGraphTheme({}) : undefined,
      });
    }

    case "status": {
      const r = result as StatusResult;
      return renderStatusList(r.snapshots, {
        theme: themed ? deriveGraphTheme({}) : undefined,
      });
    }

    case "statusDetail": {
      if ("error" in result) {
        const r = result as Extract<StatusDetailResult, { error: string }>;
        return `workflow status id=${r.runId}: ${r.error}`;
      }
      const r = result as Extract<StatusDetailResult, { detail: RunDetail }>;
      return renderRunDetail(r.detail, {
        theme: themed ? deriveGraphTheme({}) : undefined,
      });
    }

    case "inputs": {
      const r = result as InputsResult;
      return renderInputsSchema(r.name, r.inputs);
    }

    case "get": {
      const r = result as GetResult;
      if (r.error) return `workflow get (${r.workflow}): ${r.error}`;
      const output = r.details?.output;
      const description = typeof output?.["description"] === "string" ? ` — ${output["description"]}` : "";
      return `workflow get (${r.workflow}): ${r.details?.status ?? "completed"}${description}`;
    }

    case "doctor": {
      const r = result as DoctorResult;
      const subtitle = typeof r.details.output?.["subtitle"] === "string" ? r.details.output["subtitle"] : "atomic-workflows";
      return `workflow doctor: ${subtitle}`;
    }

    case "run": {
      const r = result as RunResult;
      if (partial) return `workflow run ${r.runId}: ${r.status} (in progress…)`;
      if (r.status === "failed" && !r.runId) {
        // Not-found path — render the error verbatim, no fake runId banner.
        const label = r.name ? ` (${r.name})` : "";
        return `workflow run${label}: ${r.error ?? "workflow not found"}`;
      }
      if (r.error) {
        const label = r.name ? ` (${r.name})` : "";
        return `workflow run ${r.runId}${label}: ${r.status} — ${r.error}`;
      }
      if (r.details) {
        const label = r.name ? ` (${r.name})` : "";
        return `workflow run ${r.runId}${label}: ${r.details.mode} ${r.details.status}`;
      }
      if (r.status === "completed" || r.status === "killed") {
        const label = r.name ? ` (${r.name})` : "";
        return `workflow run ${r.runId}${label}: ${r.status}`;
      }
      // Background dispatch — `runDetached()` returns status "running" and
      // a message; the workflow surfaces progress via store / overlay.
      const label = r.name ? ` (${r.name})` : "";
      return `workflow run ${r.runId}${label}: started in background — ${r.message ?? r.status}`;
    }

    case "interrupt": {
      const r = result as InterruptResult;
      return `workflow interrupt ${r.runId}: ${r.message}`;
    }

    case "resume": {
      const r = result as ResumeResult;
      return `workflow resume ${r.runId}: ${r.message}`;
    }

    default: {
      // Runtime guard — handles values coerced from external sources.
      const fallback = result as { action: string; message?: string };
      return `workflow: ${fallback.message ?? JSON.stringify(result)}`;
    }
  }
}
