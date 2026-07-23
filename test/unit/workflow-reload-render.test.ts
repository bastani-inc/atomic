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

test("explicit reload reports and renders every diagnostic beyond the former display cap", () => {
  const diagnostics: WorkflowReloadReport["diagnostics"] = Array.from({ length: 9 }, (_, index) => ({
    phase: "discovery" as const,
    level: "error" as const,
    code: "IMPORT_FAILED" as const,
    source: `/workflows/malformed-${index + 1}.ts`,
    message: `malformed workflow ${index + 1}`,
  }));
  const report: WorkflowReloadReport = {
    outcome: "applied",
    generation: 3,
    workflowCount: 7,
    coalescedRequests: 1,
    diagnostics,
  };
  const message = formatWorkflowReloadReport(report);
  const result: WorkflowToolResult = { action: "reload", status: "ok", message, ...report };
  const rendered = renderResult(result, { width: 80, plain: true });

  assert.match(message, /malformed-9\.ts: malformed workflow 9/);
  assert.doesNotMatch(message, /… 1 more/);
  assert.match(rendered, /malformed-9\.ts: malformed workflow 9/);
});
