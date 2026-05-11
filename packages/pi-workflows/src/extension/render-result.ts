/**
 * Render the workflow tool result as a compact string/object for display in chat.
 * Honors isPartial for streaming live progress.
 * cross-ref: pi-subagents src/extension/index.ts renderResult slot
 */

import type { StageSnapshot } from "../store-types.js";

export interface WorkflowRunEntry {
  runId: string;
  name: string;
  status: string;
}

export interface WorkflowInputEntry {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  default?: unknown;
}

// Type aliases for the discriminated union members to reduce inline noise.
type ListResult = { action: "list"; workflows: string[] };
type StatusResult = { action: "status"; runs: WorkflowRunEntry[] };
type InputsResult = { action: "inputs"; name: string; inputs: WorkflowInputEntry[]; error?: string };
type RunResult = {
  action: "run";
  name?: string;
  runId: string;
  status: string;
  result?: Record<string, unknown>;
  error?: string;
  stages?: StageSnapshot[];
  /** @deprecated legacy compat — prefer error/stages */
  message?: string;
};
type KillResult = { action: "kill"; runId: string; status: string; message: string };
type ResumeResult = { action: "resume"; runId: string; status: string; message: string };
type FallbackResult = { action: string; message: string };

export type WorkflowToolResult =
  | ListResult
  | StatusResult
  | InputsResult
  | RunResult
  | KillResult
  | ResumeResult
  | FallbackResult;

export interface RenderResultOpts {
  isPartial?: boolean;
}

/**
 * Returns a compact human-readable string describing the tool result.
 * Used in the renderResult slot of the workflow tool registration.
 *
 * Note: type assertions are required because the catch-all FallbackResult
 * (`{ action: string }`) prevents TypeScript from narrowing the union via
 * switch/case on `result.action`.
 */
export function renderResult(result: WorkflowToolResult, opts?: RenderResultOpts): string {
  const partial = opts?.isPartial === true;

  switch (result.action) {
    case "list": {
      const r = result as ListResult;
      if (r.workflows.length === 0) return "workflow list: (none registered)";
      return `workflow list: ${r.workflows.join(", ")}`;
    }

    case "status": {
      const r = result as StatusResult;
      if (r.runs.length === 0) return "workflow status: (no in-flight runs)";
      const lines = r.runs.map((run) => `  ${run.runId}  ${run.name}  ${run.status}`);
      return `workflow status:\n${lines.join("\n")}`;
    }

    case "inputs": {
      const r = result as InputsResult;
      if (r.inputs.length === 0) return `workflow inputs: "${r.name}" has no declared inputs`;
      const lines = r.inputs.map((i) => {
        const req = i.required ? " (required)" : "";
        const def = i.default !== undefined ? ` [default: ${String(i.default)}]` : "";
        return `  ${i.name}: ${i.type}${req}${def}${i.description ? " — " + i.description : ""}`;
      });
      return `workflow inputs for "${r.name}":\n${lines.join("\n")}`;
    }

    case "run": {
      const r = result as RunResult;
      if (partial) return `workflow run ${r.runId}: ${r.status} (in progress…)`;
      if (r.error) {
        const label = r.name ? ` (${r.name})` : "";
        return `workflow run ${r.runId}${label}: ${r.status} — ${r.error}`;
      }
      if (r.stages === undefined) {
        return `workflow run ${r.runId}: ${r.message ?? r.status}`;
      }
      const resultSummary = r.result ? ` result: ${JSON.stringify(r.result)}` : "";
      const label = r.name ? ` (${r.name})` : "";
      return `workflow run ${r.runId}${label}: ${r.status}, ${r.stages.length} stage(s)${resultSummary}`;
    }

    case "kill": {
      const r = result as KillResult;
      return `workflow kill ${r.runId}: ${r.message}`;
    }

    case "resume": {
      const r = result as ResumeResult;
      return `workflow resume ${r.runId}: ${r.message}`;
    }

    default:
      return `workflow: ${"message" in result ? result.message : JSON.stringify(result)}`;
  }
}
