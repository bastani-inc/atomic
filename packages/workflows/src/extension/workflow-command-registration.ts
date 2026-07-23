import { inspectRun } from "../runs/background/status.js";
import { renderInputsSchema } from "../shared/render-inputs-schema.js";
import { schemaIsRequired } from "../shared/schema-introspection.js";
import { store } from "../shared/store.js";
import type { WorkflowExecutionPolicy } from "../shared/types.js";
import { emitChatSurface } from "../tui/chat-surface-message.js";
import { openInlineInputsForm } from "../tui/inline-form-overlay.js";
import { openHostInputsForm } from "../tui/host-input-form.js";
import { openInputsPicker } from "../tui/inputs-overlay.js";
import { deriveGraphTheme } from "../tui/graph-theme.js";
import { selectRunsForPicker } from "../tui/session-picker.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import type { ExtensionRuntime } from "./runtime.js";
import type { WorkflowInputEntry, WorkflowToolResult } from "./render-result.js";
import type { ExtensionAPI, PiCommandContext, PiArgumentCompletionResult } from "./public-types.js";
import { workflowArgumentCompletions, workflowArgumentCompletionsNeedWorkflowResources } from "./workflow-command-completions.js";
import {
  createWorkflowCommandReporter,
  emitWorkflowCommandOutput,
  formatAvailableWorkflowNames,
  parseWorkflowArgs,
  registerWorkflowCommand,
  tokenizeWorkflowArgs,
  type WorkflowCommandHandler,
  type WorkflowCommandOutputDetails,
} from "./workflow-command-utils.js";
import {
  emitTerminalRunDetailSurface,
  formatWorkflowReloadReport,
  formatWorkflowResourceLoadWarning,
} from "./workflow-command-surfaces.js";
import { handleRunControlCommand, type WorkflowRunControlDeps } from "./workflow-run-control-command.js";
import { workflowPolicyFromContext } from "./workflow-policy.js";
import {
  reloadFailureMessage,
  resolveRunIdPrefix,
  overlaySurfaceFromContext,
} from "./workflow-targets.js";
import { normalizeWorkflowReloadReport, type WorkflowReloadReport } from "./workflow-reload-report.js";

export interface WorkflowSlashCommandDeps {
  runtimeProxy: ExtensionRuntime;
  runtimeForContext: (ctx?: PiCommandContext) => ExtensionRuntime;
  overlay: GraphOverlayPort;
  reloadWorkflowResources: () => Promise<WorkflowReloadReport | void> | void;
  ensureWorkflowResourcesLoaded: () => Promise<void> | void;
  runWithLifecycleSuppressedForPolicy: <T>(
    policy: WorkflowExecutionPolicy,
    fn: () => Promise<T>,
  ) => Promise<T>;
  runControl: WorkflowRunControlDeps;
}

export function registerWorkflowSlashCommand(
  pi: ExtensionAPI,
  workflowCommands: Map<string, WorkflowCommandHandler>,
  deps: WorkflowSlashCommandDeps,
): void {
  registerWorkflowCommand(
    pi,
    "workflow",
    {
      description: "Run or inspect Atomic workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status|connect|attach|interrupt|quit|pause|resume|inputs|reload] [args]",
      handler: (args, ctx) => workflowSlashHandler(args, ctx, pi, deps),
      getArgumentCompletions: (partial: string): PiArgumentCompletionResult | Promise<PiArgumentCompletionResult> => {
        const buildCompletions = (): PiArgumentCompletionResult => workflowArgumentCompletions(partial, deps.runtimeProxy);
        if (!workflowArgumentCompletionsNeedWorkflowResources(partial)) return buildCompletions();
        return Promise.resolve(deps.ensureWorkflowResourcesLoaded()).then(buildCompletions).catch(buildCompletions);
      },
    },
    workflowCommands,
  );
  registerWorkflowCommand(
    pi,
    "workflows",
    {
      description: "List retained workflow runs or open one by id. Usage: /workflows [run-id]",
      handler: (args, ctx) => {
        const target = args.trim();
        return workflowSlashHandler(target.length === 0 ? "resume" : `resume ${target}`, ctx, pi, deps);
      },
    },
    workflowCommands,
  );
}

async function workflowSlashHandler(
  args: string,
  ctx: PiCommandContext,
  pi: ExtensionAPI,
  deps: WorkflowSlashCommandDeps,
): Promise<void> {
  const policy = workflowPolicyFromContext(ctx);
  const reporter = createWorkflowCommandReporter(ctx, policy, pi);
  const print = (msg: string): void => reporter.info(msg);
  const fail = (msg: string): void => reporter.error(msg);
  const withImplicitYesFlag = (tokens: string[]): string[] =>
    tokens.some((t) => t === "--yes" || t === "-y") ? tokens : [...tokens, "-y"];
  const ensureWorkflowResourcesVisible = async (): Promise<void> => {
    try {
      await deps.ensureWorkflowResourcesLoaded();
    } catch (error) {
      ctx.ui?.notify(formatWorkflowResourceLoadWarning(error), "warning");
    }
  };
  const showWorkflowInputs = async (
    workflowName: string,
    command: WorkflowCommandOutputDetails["command"] = "inputs",
  ): Promise<void> => {
    await ensureWorkflowResourcesVisible();
    const result = await deps.runtimeForContext(ctx).dispatch({ workflow: workflowName, inputs: {}, action: "inputs" }, { policy });
    if (result.action !== "inputs" || !("inputs" in result)) return;
    const inputResult = result as Extract<WorkflowToolResult, { action: "inputs" }>;
    if (inputResult.error) {
      fail(`${inputResult.error}\nAvailable: ${formatAvailableWorkflowNames(deps.runtimeProxy.registry.names())}`);
      return;
    }
    const schemaText = renderInputsSchema(workflowName, inputResult.inputs, { theme: deriveGraphTheme({}) });
    if (policy.mode === "non_interactive") emitWorkflowCommandOutput(pi, schemaText, { command, workflowName });
    else print(schemaText);
  };

  const parts = tokenizeWorkflowArgs(args);
  const subcommand = parts[0] ?? "";
  if (["connect", "attach", "pause", "resume"].includes(subcommand)) {
    await handleRunControlCommand(subcommand as "connect" | "attach" | "pause" | "resume", parts.slice(1), ctx, reporter, deps.runControl);
    return;
  }
  if (!subcommand || subcommand === "list") {
    await ensureWorkflowResourcesVisible();
    const items = deps.runtimeProxy.registry.all().map((def) => ({
      name: def.normalizedName,
      description: def.description,
      inputs: Object.entries(def.inputs).map(([iname, schema]) => ({
        name: iname,
        required: schemaIsRequired(schema),
      })),
    }));
    emitChatSurface(pi, { kind: "list", entries: items });
    return;
  }
  if (subcommand === "status") {
    const target = parts[1];
    if (target && !target.startsWith("--")) {
      const resolved = resolveRunIdPrefix(target);
      if (resolved.kind === "not_found") return fail(`Run not found: ${target}`);
      if (resolved.kind === "ambiguous") {
        return fail(`Ambiguous run prefix "${target}" matches: ${resolved.matches.map((id) => id.slice(0, 12)).join(", ")}`);
      }
      const inspected = inspectRun(resolved.runId);
      if (!inspected.ok) return fail(`Run not found: ${target}`);
      emitChatSurface(pi, { kind: "detail", detail: inspected.detail });
      return;
    }
    const rows = selectRunsForPicker(store.runs(), "", true, Date.now());
    emitChatSurface(pi, { kind: "status", runs: rows.map((r) => r.run) });
    return;
  }
  if (subcommand === "reload") {
    try {
      const report = normalizeWorkflowReloadReport(await deps.reloadWorkflowResources());
      const message = formatWorkflowReloadReport(report);
      if (report.outcome === "applied") print(message);
      else fail(message);
    } catch (error) {
      fail(reloadFailureMessage(error));
    }
    return;
  }
  if (subcommand === "interrupt") {
    await handleRunControlCommand(subcommand, withImplicitYesFlag(parts.slice(1)), ctx, reporter, deps.runControl);
    return;
  }
  if (subcommand === "quit") {
    await handleRunControlCommand(subcommand, parts.slice(1), ctx, reporter, deps.runControl);
    return;
  }
  if (subcommand === "inputs") {
    const workflowName = parts[1] ?? "";
    if (!workflowName) return fail("Usage: /workflow inputs <name>");
    await showWorkflowInputs(workflowName);
    return;
  }

  const workflowName = subcommand;
  const inputTokens = parts.slice(1);
  if (inputTokens.includes("--help")) {
    await showWorkflowInputs(workflowName, "help");
    return;
  }
  const inputs = parseWorkflowArgs(inputTokens);
  const wantsPickerSkip = inputTokens.includes("--no-picker");
  let mergedInputs = inputs;
  let pickerWasShown = false;
  const canOpenPicker = policy.allowInputPicker && !wantsPickerSkip && (
    typeof ctx.ui?.hostInputForm === "function" ||
    typeof ctx.ui?.setEditorComponent === "function" ||
    typeof ctx.ui?.custom === "function"
  );
  if (canOpenPicker) {
    await ensureWorkflowResourcesVisible();
    const schemaResult = await deps.runtimeForContext(ctx).dispatch({ workflow: workflowName, inputs: {}, action: "inputs" }, { policy });
    const schema = schemaResult.action === "inputs" && "inputs" in schemaResult
      ? (schemaResult as Extract<WorkflowToolResult, { action: "inputs" }>)
      : undefined;
    const fields = schema?.inputs ?? [];
    const missingRequired = fields.some((f: WorkflowInputEntry) =>
      f.required === true && (inputs[f.name] === undefined || (typeof inputs[f.name] === "string" && (inputs[f.name] as string).trim() === "")),
    );
    if (fields.length > 0 && (inputTokens.length === 0 || missingRequired)) {
      pickerWasShown = true;
      const pickerTheme = deriveGraphTheme({});
      let pickerResult = typeof ctx.ui?.hostInputForm === "function"
        ? await openHostInputsForm(ctx.ui, { workflowName, fields, prefilled: inputs })
        : { kind: "unsupported" as const };
      if (pickerResult.kind === "unsupported" && typeof ctx.ui?.setEditorComponent === "function") {
        pickerResult = await openInlineInputsForm(pi, ctx, { workflowName, fields, prefilled: inputs, theme: pickerTheme });
      }
      if (pickerResult.kind === "unsupported" && typeof ctx.ui?.custom === "function") {
        pickerResult = await openInputsPicker(ctx.ui, { workflowName, fields, prefilled: inputs, theme: pickerTheme });
      }
      if (pickerResult.kind === "cancel") return;
      if (pickerResult.kind === "run") mergedInputs = pickerResult.values;
    }
  }

  await ensureWorkflowResourcesVisible();
  const result = await deps.runWithLifecycleSuppressedForPolicy(policy, () =>
    deps.runtimeForContext(ctx).dispatch({ workflow: workflowName, inputs: mergedInputs, action: "run" }, { policy }),
  );
  if (result.action !== "run" || !("runId" in result)) return;
  const runResult = result as Extract<WorkflowToolResult, { action: "run"; runId: string }>;
  if (runResult.status === "failed" && runResult.runId === "") {
    if (runResult.error?.toLowerCase().includes("not found")) {
      fail(`Workflow not found: ${workflowName}\nAvailable: ${formatAvailableWorkflowNames(deps.runtimeProxy.registry.names())}`);
    } else {
      fail(`Workflow "${workflowName}" failed: ${runResult.error ?? "unknown error"}`);
    }
    return;
  }
  if (runResult.status === "failed") {
    fail(`Workflow "${workflowName}" failed: ${runResult.error ?? "unknown error"}`);
    return;
  }
  if (policy.mode === "non_interactive") {
    emitTerminalRunDetailSurface(pi, workflowName, mergedInputs, runResult);
    return;
  }
  emitChatSurface(pi, { kind: "dispatch", workflowName, runId: runResult.runId, inputs: mergedInputs });
  if (
    (pickerWasShown && typeof ctx.ui?.custom === "function") ||
    deps.runtimeProxy.registry.get(workflowName)?.autoAttach === true
  ) {
    deps.overlay.open(runResult.runId, overlaySurfaceFromContext(ctx));
  }
}
