import { test } from "bun:test";
import assert from "node:assert/strict";
import { renderResult, type WorkflowToolResult } from "../../packages/workflows/src/extension/render-result.js";
import { formatWorkflowReloadReport } from "../../packages/workflows/src/extension/workflow-command-surfaces.js";
import type { WorkflowReloadReport } from "../../packages/workflows/src/extension/workflow-reload-report.js";

test("reload result rendering wraps multiline diagnostics without losing actionable details", () => {
  const report: WorkflowReloadReport = {
    outcome: "applied",
    generation: 2,
    workflowCount: 8,
    coalescedRequests: 1,
    diagnostics: [{
      phase: "discovery",
      level: "error",
      code: "IMPORT_FAILED",
      source: "/a/very/long/workflow/source/path/that/would/otherwise/consume/the/notice/width.ts",
      message: "module exploded while importing the newly added workflow",
    }],
  };
  const result: WorkflowToolResult = {
    action: "reload",
    status: "ok",
    message: formatWorkflowReloadReport(report),
    ...report,
  };

  const rendered = renderResult(result, { width: 80, plain: true });
  assert.match(rendered, /Reloaded workflow resources/);
  assert.match(rendered, /IMPORT_FAILED/);
  assert.match(rendered, /module exploded while importing/);
});
