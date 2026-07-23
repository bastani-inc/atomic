import { inspectRun, type RunDetail } from "../runs/background/status.js";
import type { WorkflowInputValues } from "../shared/types.js";
import { emitChatSurface } from "../tui/chat-surface-message.js";
import { renderRunDetail } from "../tui/run-detail.js";
import type { ConfigLoadResult } from "./config-loader.js";
import type { DiscoveryResult } from "./discovery.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { ExtensionAPI } from "./public-types.js";
import { isRunStatus } from "./workflow-targets.js";
import type { WorkflowReloadReport } from "./workflow-reload-report.js";

function fallbackRunDetailFromResult(
  workflowName: string,
  inputs: Readonly<WorkflowInputValues>,
  result: Extract<WorkflowToolResult, { action: "run"; runId: string }>,
): RunDetail {
  const now = Date.now();
  const stages = result.stages?.map((stage) => structuredClone(stage)) ?? [];
  return {
    runId: result.runId,
    name: result.name ?? workflowName,
    status: isRunStatus(result.status) ? result.status : "failed",
    mode: stages.length > 1 ? "chain" : "single",
    startedAt: now,
    endedAt: now,
    durationMs: 0,
    inputs,
    stages,
    result: result.result,
    error: result.error,
    exited: result.exited,
    exitReason: result.exitReason,
  };
}

export function emitTerminalRunDetailSurface(
  pi: ExtensionAPI,
  workflowName: string,
  inputs: Readonly<WorkflowInputValues>,
  result: Extract<WorkflowToolResult, { action: "run"; runId: string }>,
): void {
  const inspected = inspectRun(result.runId);
  const detail = inspected.ok
    ? inspected.detail
    : fallbackRunDetailFromResult(workflowName, inputs, result);
  emitChatSurface(pi, { kind: "detail", detail }, { content: renderRunDetail(detail, { width: 100 }) });
}


export function formatWorkflowResourceLoadWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Workflow discovery diagnostics: workflow resources could not be fully refreshed.",
    `- [error DISCOVERY_FAILED] workflow discovery: ${message}`,
    "Using the currently loaded workflow registry; run `/workflow reload` after fixing the issue.",
  ].join("\n");
}

export function formatWorkflowReloadReport(report: WorkflowReloadReport, reason?: string): string {
  const reasonSuffix = reason?.trim() ? ` (${reason.trim()})` : "";
  const legacySuccess = report.generation === 0 && report.workflowCount === 0 && report.diagnostics.length === 0;
  const headline = report.outcome === "applied"
    ? legacySuccess
      ? `Reloaded workflow resources${reasonSuffix}.`
      : `Reloaded workflow resources${reasonSuffix}. ${report.workflowCount} workflow(s), generation ${report.generation}.`
    : report.outcome === "failed"
      ? `Workflow resources could not be refreshed; the current registry was retained: ${report.error}`
      : "Workflow reload was superseded by a newer session; no stale resources were applied.";
  if (report.diagnostics.length === 0) return headline;

  const lines = report.diagnostics.map((diagnostic) =>
    `- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? `workflow ${diagnostic.phase}`}: ${diagnostic.message}`
  );
  return [
    headline,
    `Workflow discovery diagnostics (${report.diagnostics.length}): some resources were skipped or need attention.`,
    ...lines,
  ].join("\n");
}
export function formatStartupDiagnostics(
  configResult: ConfigLoadResult | null,
  discoveryResult: DiscoveryResult | null,
): string | null {
  const lines: string[] = [];
  for (const diagnostic of configResult?.diagnostics ?? []) {
    lines.push(`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? "workflow config"}: ${diagnostic.message}`);
  }
  for (const diagnostic of discoveryResult?.errors ?? []) {
    lines.push(`- [${diagnostic.level} ${diagnostic.code}] ${diagnostic.source ?? "workflow discovery"}: ${diagnostic.message}`);
  }
  if (lines.length === 0) return null;
  const maxVisible = 8;
  const visible = lines.slice(0, maxVisible);
  const remaining = lines.length - visible.length;
  return [
    `Workflow discovery diagnostics (${lines.length}): some workflow resources were skipped or need attention.`,
    ...visible,
    ...(remaining > 0 ? [`- … ${remaining} more`] : []),
  ].join("\n");
}

const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

export function deAdvertiseAskUserQuestionWhenHeadless(
  pi: ExtensionAPI,
  hasUI: boolean | undefined,
): void {
  if (hasUI !== false) return;
  if (typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
  const activeTools = pi.getActiveTools();
  if (!activeTools.includes(ASK_USER_QUESTION_TOOL_NAME)) return;
  pi.setActiveTools(activeTools.filter((toolName) => toolName !== ASK_USER_QUESTION_TOOL_NAME));
}
