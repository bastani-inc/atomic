import { deriveInputFields } from "../shared/schema-introspection.js";
import type { WorkflowSerializableValue } from "../shared/types.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { WorkflowToolResult } from "./render-result.js";
import type { WorkflowToolArgs } from "./public-types.js";

function stringifyWorkflowToolResult(result: WorkflowToolResult): string {
  return JSON.stringify(result, null, 2);
}

function compactWorkflowToolMessage(
  result: Extract<WorkflowToolResult, {
    action: "send" | "pause" | "reload" | "interrupt" | "quit" | "resume";
  }>,
): string {
  if (result.action === "reload") {
    return `${result.action}: ${result.status} — ${result.message}`;
  }
  const target = [
    result.runId,
    result.action === "send" ? result.stageId : undefined,
  ].filter((part): part is string => part !== undefined && part.length > 0)
    .join("/");
  return `${result.action}:${target ? ` ${target}` : ""} ${result.status} — ${result.message}`;
}

function renderTranscriptToolContent(
  result: Extract<WorkflowToolResult, { action: "transcript" }>,
): string {
  const lines = [
    "action: transcript",
    `runId: ${result.runId}`,
    `stageId: ${result.stageId}`,
    `source: ${result.source}`,
    `truncated: ${result.truncated}`,
  ];
  if (result.sessionId) lines.push(`sessionId: ${result.sessionId}`);
  if (result.sessionFile) lines.push(`sessionFile: ${result.sessionFile}`);
  if (result.sessionFile) lines.push(`sessionFileJson: ${JSON.stringify(result.sessionFile)}`);
  if (result.transcriptPath) lines.push(`transcriptPath: ${result.transcriptPath}`);
  if (result.transcriptPath) lines.push(`transcriptPathJson: ${JSON.stringify(result.transcriptPath)}`);
  if (result.entryCount !== undefined) lines.push(`availableEntries: ${result.entryCount}`);
  if (result.entryLimit !== undefined) lines.push(`entryLimit: ${result.entryLimit}`);
  if (result.lazyReadPrompt) lines.push(`lazyReadPrompt: ${result.lazyReadPrompt}`);
  if (result.fallbackNote) lines.push(`fallbackNote: ${result.fallbackNote}`);
  if (result.entries.length === 0) {
    lines.push(result.inlineMode === "path_only" || result.lazyReadPrompt ? "entries: not inlined" : "entries: none");
    return lines.join("\n");
  }
  lines.push("entries:");
  result.entries.forEach((entry, index) => {
    const metadata = [
      `[${index + 1}]`,
      `role=${entry.role}`,
      entry.toolName ? `tool=${entry.toolName}` : undefined,
      entry.timestamp !== undefined ? `timestamp=${entry.timestamp}` : undefined,
    ].filter((part): part is string => part !== undefined);
    lines.push(metadata.join(" "));
    if (entry.text !== undefined) lines.push(entry.text);
    if (entry.output !== undefined) {
      lines.push("tool output:");
      lines.push(entry.output);
    }
    if (entry.text === undefined && entry.output === undefined) lines.push("(no body)");
  });
  return lines.join("\n");
}

function renderStagesToolContent(
  result: Extract<WorkflowToolResult, { action: "stages" }>,
): string {
  const lines = ["action: stages", `runId: ${result.runId}`, `filter: ${result.filter}`];
  if (result.error) lines.push(`error: ${result.error}`);
  if (result.stages.length === 0) {
    lines.push("stages: none");
    return lines.join("\n");
  }
  lines.push("stages:");
  result.stages.forEach((stage, index) => {
    lines.push(`[${index + 1}] ${stage.name} (${stage.id}) ${stage.status}`);
    if (stage.sessionId) lines.push(`sessionId: ${stage.sessionId}`);
    if (stage.sessionFile) lines.push(`sessionFile: ${stage.sessionFile}`);
    if (stage.sessionFile) lines.push(`sessionFileJson: ${JSON.stringify(stage.sessionFile)}`);
    if (stage.transcriptPath) lines.push(`transcriptPath: ${stage.transcriptPath}`);
    if (stage.transcriptPath) lines.push(`transcriptPathJson: ${JSON.stringify(stage.transcriptPath)}`);
    if (stage.error) lines.push(`error: ${stage.error}`);
    if (stage.skippedReason) lines.push(`skippedReason: ${stage.skippedReason}`);
    if (stage.awaitingInputSince !== undefined) lines.push(`awaitingInputSince: ${stage.awaitingInputSince}`);
    if (stage.pendingPrompt !== undefined) {
      lines.push("pendingPrompt:");
      lines.push(JSON.stringify(stage.pendingPrompt, null, 2));
    }
    if (stage.inputRequest !== undefined) {
      lines.push("inputRequest:");
      lines.push(JSON.stringify(stage.inputRequest, null, 2));
    }
    if (stage.promptFootprint !== undefined) {
      lines.push("promptFootprint:");
      lines.push(JSON.stringify(stage.promptFootprint, null, 2));
    }
  });
  return lines.join("\n");
}

function renderStageToolContent(
  result: Extract<WorkflowToolResult, { action: "stage" }>,
): string {
  const lines = ["action: stage", `runId: ${result.runId}`];
  if (result.error || result.stage === undefined) {
    lines.push(`error: ${result.error ?? "stage not found"}`);
    return lines.join("\n");
  }
  lines.push("stage:");
  lines.push(JSON.stringify(result.stage, null, 2));
  if (result.stage.sessionFile) {
    lines.push(`transcriptPath: ${result.stage.sessionFile}`);
    lines.push(`transcriptPathJson: ${JSON.stringify(result.stage.sessionFile)}`);
  }
  return lines.join("\n");
}

export function renderWorkflowToolContent(
  result: WorkflowToolResult,
  args: WorkflowToolArgs,
): string {
  if (args.format === "json") return stringifyWorkflowToolResult(result);
  switch (result.action) {
    case "transcript":
      return renderTranscriptToolContent(result);
    case "stages":
      return renderStagesToolContent(result);
    case "stage":
      return renderStageToolContent(result);
    case "send":
    case "pause":
    case "reload":
    case "interrupt":
    case "quit":
    case "resume":
      return compactWorkflowToolMessage(result);
    case "list":
    case "status":
    case "statusDetail":
    case "inputs":
    case "get":
    case "run":
      return stringifyWorkflowToolResult(result);
  }
}

export function workflowGetResult(
  runtime: ExtensionRuntime,
  args: WorkflowToolArgs,
): WorkflowToolResult {
  const workflow = args.workflow ?? "";
  const def = runtime.registry.get(workflow);
  if (!def) return { action: "get", workflow, error: `Workflow not found: "${workflow}"` };
  const inputs = deriveInputFields(def.inputs);
  return {
    action: "get",
    workflow: def.normalizedName,
    details: {
      mode: "inspection",
      action: "get",
      status: "completed",
      output: {
        workflow: def.normalizedName,
        name: def.name,
        description: def.description,
        inputs: inputs as unknown as WorkflowSerializableValue[],
      },
      progress: { completed: 0, total: 0 },
    },
  };
}
