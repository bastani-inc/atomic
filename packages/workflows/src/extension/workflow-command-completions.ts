import { schemaChoices, schemaDescription, schemaFieldKind } from "../shared/schema-introspection.js";
import { store } from "../shared/store.js";
import { topLevelWorkflowRuns } from "../shared/run-visibility.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { PiArgumentCompletion, PiArgumentCompletionResult } from "./public-types.js";

function completeToken(
  argumentText: string,
  candidates: PiArgumentCompletion[],
): PiArgumentCompletionResult {
  const tokenStart = /\s$/.test(argumentText)
    ? argumentText.length
    : Math.max(argumentText.lastIndexOf(" "), argumentText.lastIndexOf("\t")) + 1;
  const head = argumentText.slice(0, tokenStart);
  const token = argumentText.slice(tokenStart);
  const normalizedToken = token.trimEnd();
  const filtered = candidates
    .filter((candidate) => candidate.value.startsWith(token) && candidate.value.trimEnd() !== normalizedToken)
    .map((candidate) => ({ ...candidate, value: `${head}${candidate.value}` }));
  return filtered.length > 0 ? filtered : null;
}

function adminCompletions(): PiArgumentCompletion[] {
  return [
    { value: "connect ", label: "connect", description: "Attach to a run (picker if no id)" },
    { value: "attach ", label: "attach", description: "Open the in-place attach pane on a node" },
    { value: "list ", label: "list", description: "List registered workflows" },
    { value: "status ", label: "status", description: "List current-session active and retained terminal runs" },
    { value: "interrupt ", label: "interrupt", description: "Interrupt a run" },
    { value: "kill ", label: "kill", description: "Kill and retain a run for inspection" },
    { value: "pause ", label: "pause", description: "Pause a run or stage" },
    { value: "resume ", label: "resume", description: "Re-open overlay for a run" },
    { value: "inputs ", label: "inputs", description: "Show a workflow's input schema" },
    { value: "reload ", label: "reload", description: "Reload workflow resources" },
  ];
}

function workflowNameItems(runtime: ExtensionRuntime): PiArgumentCompletion[] {
  return runtime.registry.names().map((name) => ({
    value: `${name} `,
    label: name,
    description: `Run workflow: ${name}`,
  }));
}

function runIdItems(): PiArgumentCompletion[] {
  return topLevelWorkflowRuns(store.runs()).map((run) => ({
    value: `${run.id} `,
    label: run.id.slice(0, 8),
    description: `${run.name} — ${run.status}`,
  }));
}

export function workflowArgumentCompletionsNeedWorkflowResources(partial: string): boolean {
  const parts = partial.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0] ?? "";
  if (!partial.includes(" ")) return true;
  if (!subcommand || subcommand === "inputs") return true;
  if (["status", "connect", "resume", "attach", "pause", "interrupt", "kill", "reload"].includes(subcommand)) {
    return false;
  }
  return true;
}

export function workflowArgumentCompletions(
  partial: string,
  runtime: ExtensionRuntime,
): PiArgumentCompletionResult {
  const parts = partial.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0] ?? "";
  const workflows = () => workflowNameItems(runtime);
  if (!partial.includes(" ")) {
    return completeToken(partial, [...adminCompletions(), ...workflows()]);
  }
  if (subcommand === "inputs") return completeToken(partial, workflows());
  if (["status", "connect", "resume", "attach", "pause"].includes(subcommand)) {
    return completeToken(partial, runIdItems());
  }
  if (subcommand === "interrupt" || subcommand === "kill") {
    const verb = subcommand === "kill" ? "Kill and retain" : "Interrupt";
    return completeToken(partial, [
      { value: "--all ", label: "--all", description: `${verb} all in-flight runs` },
      { value: "--yes ", label: "--yes", description: "Skip confirmation" },
      { value: "-y ", label: "-y", description: "Skip confirmation" },
      ...runIdItems(),
    ]);
  }
  if (!subcommand) return completeToken(partial, [...adminCompletions(), ...workflows()]);

  const workflow = runtime.registry.get(subcommand);
  if (!workflow) return null;
  const tokenStart = /\s$/.test(partial)
    ? partial.length
    : Math.max(partial.lastIndexOf(" "), partial.lastIndexOf("\t")) + 1;
  const token = partial.slice(tokenStart);
  const equalsIndex = token.indexOf("=");
  if (equalsIndex > 0) {
    const inputName = token.slice(0, equalsIndex);
    const schema = workflow.inputs[inputName];
    const schemaChoiceValues = schema === undefined ? undefined : schemaChoices(schema);
    const schemaKind = schema === undefined ? undefined : schemaFieldKind(schema);
    if (schemaChoiceValues !== undefined) {
      return completeToken(
        partial,
        schemaChoiceValues.map((choice) => ({ value: `${inputName}=${choice} `, label: choice, description: inputName })),
      );
    }
    if (schemaKind === "boolean") {
      return completeToken(partial, [
        { value: `${inputName}=true `, label: "true", description: inputName },
        { value: `${inputName}=false `, label: "false", description: inputName },
      ]);
    }
    return null;
  }
  const inputCompletions: PiArgumentCompletion[] = Object.entries(workflow.inputs)
    .map(([name, schema]) => ({ value: `${name}=`, label: name, description: schemaDescription(schema) }));
  return completeToken(partial, [
    { value: "--no-picker ", label: "--no-picker", description: "Skip interactive input picker" },
    { value: "--help ", label: "--help", description: "Show this workflow's input schema" },
    ...inputCompletions,
  ]);
}
