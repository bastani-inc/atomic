import { Type } from "@sinclair/typebox";
import { renderCall } from "./render-call.js";
import { renderResult } from "./render-result.js";
import type { WorkflowToolResult, RenderResultOpts } from "./render-result.js";
import {
  renderRunBanner,
  renderStageChip,
  renderStageProgress,
  renderStageResult,
  renderRunSummary,
} from "./renderers.js";
import { store } from "../store.js";
import { restoreOnSessionStart } from "../persistence/restore.js";
import type { SessionManager } from "../persistence/restore.js";
import { installCompactionHook } from "../persistence/compaction-policy.js";
import { statusRuns, killRun, killAllRuns, resumeRun } from "../runs/detach/status.js";
import { registerIntercomParentSession } from "../integrations/intercom/intercom-bridge.js";
import { subscribeIntercomControl } from "../integrations/intercom/result-intercom.js";
import { installStoreWidget, installToolExecutionHooks } from "../tui/store-widget-installer.js";
import type { WidgetFactory } from "../tui/store-widget-installer.js";
import { createExtensionRuntime } from "./runtime.js";
import type { ExtensionRuntime } from "./runtime.js";
import { discoverBundledWorkflows, discoverBundledWorkflowsSync } from "./discovery.js";
import { buildDoctorReport } from "./doctor.js";
import type { DoctorSiblingStatus } from "./doctor.js";

// ---------------------------------------------------------------------------
// Minimal ExtensionAPI structural types
// No `any`; all optional fields use explicit union with undefined.
// cross-ref: pi-subagents src/extension/index.ts (pi's actual API shape)
// ---------------------------------------------------------------------------

/** Theme object passed to renderCall/renderResult slots (opaque — not consumed in stubs). */
export type PiTheme = Record<string, string>;

/** Context object passed to renderCall/renderResult slots. */
export interface PiRenderContext {
  state?: {
    runId?: string;
    stages?: unknown[];
  };
  invalidate?: () => void;
}

/** Options bag passed to renderResult. */
export interface PiRenderResultOpts extends RenderResultOpts {
  isPartial?: boolean;
}

/** Tool call args wrapper passed to renderCall. */
export interface PiToolCallArgs<T> {
  args: T;
}

/** Tool result wrapper passed to renderResult. */
export interface PiToolResultArgs<T> {
  result: T;
}

/** Completion for a slash-command argument. */
export interface PiArgumentCompletion {
  label: string;
  description?: string;
}

/** Slash command registration options (pi.registerCommand / pi.registerSlashCommand). */
export interface PiSlashCommandOpts {
  name: string;
  description: string;
  execute: (args: string, ctx: PiCommandContext) => Promise<void> | void;
  getArgumentCompletions?: (partial: string) => PiArgumentCompletion[] | Promise<PiArgumentCompletion[]>;
}

/** Context provided to slash command execute handlers. */
export interface PiCommandContext {
  reply?: (message: string) => void;
  print?: (message: string) => void;
}

/** Flag registration options. */
export interface PiFlagOpts {
  name: string;
  description: string;
  type?: "string" | "boolean";
}

/** Tool registration options. */
export interface PiToolOpts<TArgs, TResult> {
  name: string;
  label?: string;
  description: string;
  parameters: unknown; // TypeBox TSchema — pi consumes it opaquely
  execute: (args: TArgs, ctx: PiExecuteContext) => Promise<TResult>;
  renderCall?: (call: PiToolCallArgs<TArgs>, theme: PiTheme, context: PiRenderContext) => string;
  renderResult?: (result: PiToolResultArgs<TResult>, opts: PiRenderResultOpts, theme: PiTheme, context: PiRenderContext) => string;
}

/** Execution context provided to tool execute handlers. */
export interface PiExecuteContext {
  sessionId?: string;
  [key: string]: unknown;
}

/**
 * Minimal structural ExtensionAPI.
 * All registration methods are optional so the extension degrades gracefully
 * when running against older pi runtimes that lack certain features.
 */
export interface ExtensionAPI {
  registerTool?: <TArgs, TResult>(opts: PiToolOpts<TArgs, TResult>) => void;
  /** Canonical name (pi >= 1.x). */
  registerCommand?: (opts: PiSlashCommandOpts) => void;
  /** Alias used by some earlier pi builds. */
  registerSlashCommand?: (opts: PiSlashCommandOpts) => void;
  registerMessageRenderer?: (event: string, renderer: (payload: Record<string, unknown>) => string) => void;
  registerFlag?: (opts: PiFlagOpts) => void;
  /**
   * Sets the session name exposed to child processes via pi-intercom.
   * Present only when pi-intercom is installed.
   */
  setSessionName?: (name: string) => void;
  /**
   * pi events bus — used by sibling integrations (pi-subagents, pi-mcp-adapter,
   * pi-intercom) to communicate via named events.
   */
  events?: {
    emit?: (event: string, payload: Record<string, unknown>) => void;
    on?: (event: string, handler: (payload: unknown) => void) => void;
  };
  /** Opaque pi-subagents surface — presence indicates pi-subagents is installed. */
  subagents?: unknown;
  // -------------------------------------------------------------------------
  // Persistence API (§5.6)
  // -------------------------------------------------------------------------
  /** Appends a typed entry to the session transcript. Returns the entry ID. */
  appendEntry?: (type: string, payload: Record<string, unknown>) => string | undefined;
  /** Labels an entry for /tree bookmark filtering. */
  setLabel?: (entryId: string, label: string) => void;
  /** Appends a synthetic system/assistant message entry. */
  appendCustomMessageEntry?: (content: string, meta?: Record<string, unknown>) => string | undefined;
  // -------------------------------------------------------------------------
  // Lifecycle events (§5.6, §8.1 Phase D)
  // -------------------------------------------------------------------------
  /** Register a listener for a pi lifecycle event (e.g. session_start, session_before_compact). */
  on?: (event: string, handler: () => void | Promise<void>) => void;
  // -------------------------------------------------------------------------
  // Session manager (§5.6 restore)
  // -------------------------------------------------------------------------
  sessionManager?: SessionManager;
  ui?: {
    setWidget?: (key: string, factory: WidgetFactory | undefined, opts?: { placement?: string }) => void;
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workflow tool argument shape
// ---------------------------------------------------------------------------

export interface WorkflowToolArgs {
  name: string;
  inputs: Record<string, unknown>;
  action?: "run" | "list" | "status" | "kill" | "resume" | "inputs";
}

// ---------------------------------------------------------------------------
// Tool parameter schema (TypeBox)
// ---------------------------------------------------------------------------

const workflowParameters = Type.Object({
  name: Type.String({ description: "Workflow ID (use {action:'list'} to enumerate)" }),
  inputs: Type.Record(Type.String(), Type.Unknown(), { default: {} }),
  action: Type.Optional(
    Type.Union([
      Type.Literal("run"),
      Type.Literal("list"),
      Type.Literal("status"),
      Type.Literal("kill"),
      Type.Literal("resume"),
      Type.Literal("inputs"),
    ]),
  ),
});

// ---------------------------------------------------------------------------
// Tool execute — dispatch with real registry for list/inputs/run (Phase E)
//                + real status/kill/resume (Phase D)
// ---------------------------------------------------------------------------

function makeExecuteWorkflowTool(runtime: ExtensionRuntime) {
  return async function executeWorkflowTool(
    args: WorkflowToolArgs,
    _ctx: PiExecuteContext,
  ): Promise<WorkflowToolResult> {
    const action = args.action ?? "run";

    switch (action) {
      case "list":
      case "inputs":
      case "run":
        // Delegate to registry-backed dispatcher.
        // Real errors propagate — no broad catch.
        return runtime.dispatch(args);

      case "status": {
        const runs = statusRuns({ all: false });
        return {
          action: "status",
          runs: runs.map((r) => ({ runId: r.runId, name: r.name, status: r.status })),
        };
      }

      case "kill": {
        // Support "kill --all" via name sentinel
        if (args.name === "--all") {
          const results = killAllRuns();
          const killed = results.filter((r) => r.ok).length;
          return {
            action: "kill",
            runId: "--all",
            status: killed > 0 ? "killed" : "noop",
            message: killed > 0
              ? `Killed ${killed} run(s).`
              : "No in-flight runs to kill.",
          };
        }
        const result = killRun(args.name);
        if (result.ok) {
          return {
            action: "kill",
            runId: result.runId,
            status: "killed",
            message: `Run ${result.runId} killed (was ${result.previousStatus}).`,
          };
        }
        return {
          action: "kill",
          runId: args.name,
          status: "noop",
          message: result.reason === "not_found"
            ? `Run not found: ${args.name}`
            : `Run already ended: ${args.name}`,
        };
      }

      case "resume": {
        const result = resumeRun(args.name);
        if (result.ok) {
          return {
            action: "resume",
            runId: result.runId,
            status: "ok",
            message: `Run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}`,
          };
        }
        return {
          action: "resume",
          runId: args.name,
          status: "noop",
          message: result.reason === "not_found"
            ? `Run not found: ${args.name}`
            : `Run ${args.name} is still active — no resume needed.`,
        };
      }

      default:
        return { action, message: `Unknown action: ${action}` };
    }
  };
}

// ---------------------------------------------------------------------------
// Slash command helpers
// ---------------------------------------------------------------------------

/** Try both canonical and alias registration method names. */
function tryRegisterSlashCommand(pi: ExtensionAPI, opts: PiSlashCommandOpts): void {
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand(opts);
  } else if (typeof pi.registerSlashCommand === "function") {
    pi.registerSlashCommand(opts);
  }
  // Neither present — silently skip (degraded runtime).
}

// ---------------------------------------------------------------------------
// Factory — the default export consumed by the pi runtime
// ---------------------------------------------------------------------------

const factory = (pi: ExtensionAPI): void => {
  // -------------------------------------------------------------------------
  // 0. Create ExtensionRuntime (registry + dispatcher)
  // -------------------------------------------------------------------------
  const discovery = discoverBundledWorkflowsSync();
  const runtime = createExtensionRuntime({ registry: discovery.registry });
  const executeWorkflowTool = makeExecuteWorkflowTool(runtime);

  // -------------------------------------------------------------------------
  // 1. Register the `workflow` tool
  // -------------------------------------------------------------------------
  if (typeof pi.registerTool === "function") {
    pi.registerTool<WorkflowToolArgs, WorkflowToolResult>({
      name: "workflow",
      label: "workflow",
      description: "Run a defined multi-stage workflow by name.",
      parameters: workflowParameters,
      execute: executeWorkflowTool,
      renderCall: ({ args }, _theme, _context) => renderCall(args),
      renderResult: ({ result }, opts, _theme, _context) => renderResult(result, opts),
    });
  }

  // -------------------------------------------------------------------------
  // 2. Register /workflow slash command
  // -------------------------------------------------------------------------
  tryRegisterSlashCommand(pi, {
    name: "workflow",
    description:
      "Run or inspect pi workflows. Usage: /workflow [list|status|kill|resume|inputs] [name] [args]",
    execute: async (args: string, ctx: PiCommandContext) => {
      const print = ctx.reply ?? ctx.print ?? ((_msg: string) => undefined);
      const parts = args.trim().split(/\s+/);
      const subcommand = parts[0] ?? "";

      if (!subcommand || subcommand === "list") {
        const names = runtime.registry.names();
        if (names.length === 0) {
          print("Registered workflows: (none)");
        } else {
          print(`Registered workflows: ${names.join(", ")}`);
        }
        return;
      }

      if (subcommand === "status") {
        const runs = statusRuns({ all: false });
        if (runs.length === 0) {
          print("In-flight runs: (none)");
        } else {
          const lines = runs.map(
            (r) =>
              `  ${r.runId.slice(0, 8)}  ${r.name}  ${r.status}  stages:${r.stageCount}`,
          );
          print(`In-flight runs:\n${lines.join("\n")}`);
        }
        return;
      }

      if (subcommand === "kill") {
        const target = parts[1] ?? "";
        if (!target) {
          print("Usage: /workflow kill <runId> | --all");
          return;
        }
        if (target === "--all") {
          const results = killAllRuns();
          const killed = results.filter((r) => r.ok).length;
          print(killed > 0 ? `Killed ${killed} run(s).` : "No in-flight runs to kill.");
        } else {
          const result = killRun(target);
          if (result.ok) {
            print(`Run ${result.runId} killed (was ${result.previousStatus}).`);
          } else {
            print(
              result.reason === "not_found"
                ? `Run not found: ${target}`
                : `Run already ended: ${target}`,
            );
          }
        }
        return;
      }

      if (subcommand === "resume") {
        const target = parts[1] ?? "";
        if (!target) {
          print("Usage: /workflow resume <runId>");
          return;
        }
        const result = resumeRun(target);
        if (result.ok) {
          print(
            `Run ${result.runId} (${result.snapshot.name}) — status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`,
          );
        } else {
          print(
            result.reason === "not_found"
              ? `Run not found: ${target}`
              : `Run ${target} is still active — no resume needed.`,
          );
        }
        return;
      }

      print(`/workflow ${args.trim()} — unknown subcommand. Try: list, status, kill, resume, inputs`);
    },
    getArgumentCompletions: async (partial: string): Promise<PiArgumentCompletion[]> => {
      const subcommands: PiArgumentCompletion[] = [
        { label: "list", description: "List registered workflows" },
        { label: "status", description: "List in-flight runs" },
        { label: "kill", description: "Abort a run" },
        { label: "resume", description: "Re-open overlay for a run" },
        { label: "inputs", description: "Show a workflow's input schema" },
      ];
      return partial
        ? subcommands.filter((c) => c.label.startsWith(partial))
        : subcommands;
    },
  });

  // -------------------------------------------------------------------------
  // 3. Register /workflows-doctor slash command
  // -------------------------------------------------------------------------
  tryRegisterSlashCommand(pi, {
    name: "workflows-doctor",
    description:
      "Diagnostics: loaded workflows, sibling availability, config validation.",
    execute: async (_args: string, ctx: PiCommandContext) => {
      const print = ctx.reply ?? ctx.print ?? ((_msg: string) => undefined);
      const discovery = await discoverBundledWorkflows();
      const siblings: DoctorSiblingStatus = {
        subagents: pi.subagents !== undefined,
        // pi-mcp-adapter exposes itself as pi["mcpAdapter"] (structural check)
        mcpAdapter: (pi as Record<string, unknown>)["mcpAdapter"] !== undefined,
        // pi-intercom registers setSessionName on the ExtensionAPI when present
        intercom: typeof pi.setSessionName === "function",
      };
      print(buildDoctorReport(discovery, siblings));
    },
  });

  // -------------------------------------------------------------------------
  // 4. Register message renderers for lifecycle events (§5.6)
  // -------------------------------------------------------------------------
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(
      "workflow.run.start",
      (payload) => renderRunBanner(payload as unknown as Parameters<typeof renderRunBanner>[0]),
    );
    pi.registerMessageRenderer(
      "workflow.stage.start",
      (payload) => renderStageChip(payload as unknown as Parameters<typeof renderStageChip>[0]),
    );
    pi.registerMessageRenderer(
      "workflow.stage.progress",
      (payload) => renderStageProgress(payload as unknown as Parameters<typeof renderStageProgress>[0]),
    );
    pi.registerMessageRenderer(
      "workflow.stage.end",
      (payload) => renderStageResult(payload as unknown as Parameters<typeof renderStageResult>[0]),
    );
    pi.registerMessageRenderer(
      "workflow.run.end",
      (payload) => renderRunSummary(payload as unknown as Parameters<typeof renderRunSummary>[0]),
    );
  }

  // -------------------------------------------------------------------------
  // 5. Register CLI flags (§5.13)
  // -------------------------------------------------------------------------
  if (typeof pi.registerFlag === "function") {
    pi.registerFlag({
      name: "workflow",
      description: "Run the named workflow headlessly (e.g. pi -p --workflow=<name>).",
      type: "string",
    });
    pi.registerFlag({
      name: "workflow-input-key",
      description:
        "Pass an input value to the workflow (repeat for multiple inputs, e.g. --workflow-input-<key>=<value>).",
      type: "string",
    });
  }

  // -------------------------------------------------------------------------
  // 6. Persistence: session_start restore + session_before_compact hook (§5.6, Phase D)
  // -------------------------------------------------------------------------
  if (typeof pi.on === "function") {
    pi.on("session_start", () => {
      if (pi.sessionManager) {
        restoreOnSessionStart(
          pi.sessionManager,
          { resumeInFlight: "ask", persistRuns: true },
          store,
          {
            onCrashed: (run) => {
              // Silently mark crashed; caller can query store.runs() for status
              // Phase E/F: surface crash notice in overlay when available.
              void run;
            },
            onResume: (run) => {
              void run;
            },
          },
        );
      }
    });

    installCompactionHook(pi, store);
  }

  installStoreWidget(pi, store);
  installToolExecutionHooks(pi, store);

  // -------------------------------------------------------------------------
  // 8. Register sibling integrations (Phase G — §5.8, §5.9, §5.10)
  // All registration calls are guarded; no throw when sibling is absent.
  // -------------------------------------------------------------------------

  // pi-intercom: name this session so detached child processes can contact_supervisor.
  registerIntercomParentSession(pi);

  // pi-intercom: route subagent:control-intercom events to overlay/store callbacks.
  // Callbacks are intentionally left as stubs here; the overlay/store (Phase E/F)
  // can re-subscribe with real handlers once implemented.
  subscribeIntercomControl(pi, {
    onNeedDecision: (_payload) => {
      // Phase E/F: surface ctx.ui.confirm in overlay when available.
    },
    onNotify: (_payload) => {
      // Phase E/F: surface non-blocking notice in workflow overlay.
    },
  });
};

export default factory;
