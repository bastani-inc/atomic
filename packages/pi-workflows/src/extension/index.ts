import { Type } from "@sinclair/typebox";
import { renderCall } from "./render-call.js";
import { renderResult } from "./render-result.js";
import type { WorkflowToolResult, WorkflowInputEntry, RenderResultOpts } from "./render-result.js";
import {
  renderRunBanner,
  renderStageChip,
  renderStageProgress,
  renderStageResult,
  renderRunSummary,
} from "./renderers.js";
import type {
  RunEndPayload,
  RunStartPayload,
  StageEndPayload,
  StageProgressPayload,
  StageStartPayload,
} from "./renderers.js";
import { store } from "../store.js";
import { restoreOnSessionStart } from "../persistence/restore.js";
import type { SessionManager } from "../persistence/restore.js";
import { installCompactionHook } from "../persistence/compaction-policy.js";
import { statusRuns, killRun, killAllRuns, resumeRun } from "../runs/detach/status.js";
import { cancellationRegistry } from "../runs/detach/cancellation-registry.js";
import { registerIntercomParentSession } from "../integrations/intercom/intercom-bridge.js";
import { subscribeIntercomControl } from "../integrations/intercom/result-intercom.js";
import { installStoreWidget, installToolExecutionHooks } from "../tui/store-widget-installer.js";
import type { WidgetFactory } from "../tui/store-widget-installer.js";
import { buildGraphOverlayAdapter } from "../tui/overlay-adapter.js";
import type { GraphOverlayPort } from "../tui/overlay-adapter.js";
import { createExtensionRuntime } from "./runtime.js";
import type { ExtensionRuntime } from "./runtime.js";
import {
  discoverWorkflows,
  discoverBundledWorkflows,
  discoverBundledWorkflowsSync,
} from "./discovery.js";
import type { DiscoveryResult } from "./discovery.js";
import { buildDoctorReport } from "./doctor.js";
import type { DoctorSiblingStatus } from "./doctor.js";
import { registerWorkflowCliFlags, runWorkflowFromCliFlags } from "../cli-flags.js";
import { loadWorkflowConfig, toDiscoveryConfig, WORKFLOW_CONFIG_DEFAULTS } from "./config-loader.js";
import type { ConfigLoadResult } from "./config-loader.js";
import type { WorkflowPersistencePort } from "../shared/types.js";
import { buildRuntimeAdapters } from "./wiring.js";
import { buildUIAdapter } from "./wiring.js";
import type { PiUISurface, PiCustomOverlayOpts, PiCustomOverlayHandle } from "./wiring.js";

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
export interface PiRenderResultOpts extends RenderResultOpts {}

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
  registerMessageRenderer?: (event: string, renderer: (payload: unknown) => string) => void;
  registerFlag?: (opts: PiFlagOpts) => void;
  /**
   * Register a keyboard shortcut.
   * Present on pi >= 1.x; absent on older runtimes.
   */
  registerShortcut?: (key: string, opts: { description: string; handler: () => void | Promise<void> }) => void;
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
  /**
   * Execute a shell command and return stdout/stderr/exit code.
   * Present on the real pi ExtensionAPI (pi >= 1.x).
   * Used by buildRuntimeAdapters to spawn `pi --mode json` for stage execution.
   * Supports abort via optional opts.signal (AbortSignal) and opts.timeout.
   */
  exec?: (command: string, args: string[], opts?: { signal?: AbortSignal; timeout?: number }) => Promise<{
    stdout: string;
    stderr: string;
    code: number;
    killed: boolean;
  }>;
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
    /**
     * Spawn a custom TUI component (overlay or inline).
     * When overlay: true, the panel floats over existing content.
     * Returns a handle with close() to dismiss, or undefined when unsupported.
     */
    custom?: (opts: PiCustomOverlayOpts) => PiCustomOverlayHandle | undefined;
  } & PiUISurface;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Workflow tool argument shape
// ---------------------------------------------------------------------------

export interface WorkflowToolArgs {
  name?: string;
  inputs?: Record<string, unknown>;
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
    const runId = args.name ?? "";

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
        if (runId === "--all") {
          const results = killAllRuns({ cancellation: cancellationRegistry });
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
        const result = killRun(runId, { cancellation: cancellationRegistry });
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
          runId,
          status: "noop",
          message: result.reason === "not_found"
            ? `Run not found: ${runId}`
            : `Run already ended: ${runId}`,
        };
      }

      case "resume": {
        const result = resumeRun(runId);
        if (result.ok) {
          return {
            action: "resume",
            runId: result.runId,
            status: "ok",
            message: `Run ${result.runId} (${result.snapshot.name}) \u2014 status: ${result.snapshot.status}`,
          };
        }
        return {
          action: "resume",
          runId,
          status: "noop",
          message: result.reason === "not_found"
            ? `Run not found: ${runId}`
            : `Run ${runId} is still active \u2014 no resume needed.`,
        };
      }

      default: {
        // Exhaustive — all action variants handled above.
        const _exhaustive: never = action;
        throw new Error(`Workflow extension: unknown action "${_exhaustive}"`);
      }
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

/** Register a /workflow:<name> shortcut slash command for a single workflow. */
function registerWorkflowAlias(
  pi: ExtensionAPI,
  workflowName: string,
  runtimeProxy: ExtensionRuntime,
): void {
  tryRegisterSlashCommand(pi, {
    name: `workflow:${workflowName}`,
    description: `Run workflow: ${workflowName}`,
    execute: async (args: string, ctx: PiCommandContext) => {
      const print = ctx.reply ?? ctx.print ?? ((_msg: string) => undefined);
      const rawParts = args.trim().split(/\s+/);
      const tokens = rawParts[0] === "" ? [] : rawParts;
      const inputs = parseWorkflowArgs(tokens);
      const result = await runtimeProxy.dispatch({
        name: workflowName,
        inputs,
        action: "run",
      });
      if (result.action === "run" && "runId" in result) {
        const r = result as Extract<WorkflowToolResult, { action: "run"; runId: string }>;
        if (r.status === "failed") {
          print(`Workflow "${workflowName}" failed: ${r.error ?? "unknown error"}`);
        } else {
          print(`Workflow "${workflowName}" completed (runId: ${r.runId})`);
        }
      }
    },
    getArgumentCompletions: async (_partial: string): Promise<PiArgumentCompletion[]> => {
      return [];
    },
  });
}

/**
 * Admin subcommands handled before workflow name resolution.
 * Any first token NOT in this set is treated as a workflow name.
 */
const ADMIN_SUBCOMMANDS = new Set(["list", "status", "kill", "resume", "inputs"]);

/**
 * Parse remaining args tokens as key=value pairs.
 * Tokens matching `key=value` are split on the first `=`.
 * Tokens that are standalone valid JSON objects/arrays are merged in.
 * All other tokens are ignored (non-kv positional args not supported).
 */
export function parseWorkflowArgs(tokens: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const token of tokens) {
    // Try JSON object/array merge
    if ((token.startsWith("{") && token.endsWith("}")) || (token.startsWith("[") && token.endsWith("]"))) {
      try {
        const parsed = JSON.parse(token) as unknown;
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          Object.assign(result, parsed as Record<string, unknown>);
        }
        continue;
      } catch {
        // not valid JSON — fall through to kv parse
      }
    }
    // key=value
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx);
      const raw = token.slice(eqIdx + 1);
      // Try to parse value as JSON for typed values (numbers, booleans, objects)
      let value: unknown = raw;
      try {
        value = JSON.parse(raw) as unknown;
      } catch {
        // keep as string
      }
      result[key] = value;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Persistence port builder
// ---------------------------------------------------------------------------

/**
 * Build a WorkflowPersistencePort from the pi ExtensionAPI when persistence
 * is enabled. Returns undefined when:
 *   - persistRuns is false, OR
 *   - pi.appendEntry is absent (older pi runtime without persistence API).
 */
export function makePersistencePort(
  pi: ExtensionAPI,
  persistRuns: boolean,
): WorkflowPersistencePort | undefined {
  if (!persistRuns) return undefined;
  if (typeof pi.appendEntry !== "function") return undefined;

  const port: WorkflowPersistencePort = {
    appendEntry: (type, payload) => pi.appendEntry!(type, payload),
  };
  if (typeof pi.setLabel === "function") {
    port.setLabel = (entryId, label) => pi.setLabel!(entryId, label);
  }
  if (typeof pi.appendCustomMessageEntry === "function") {
    port.appendCustomMessageEntry = (content, meta) =>
      pi.appendCustomMessageEntry!(content, meta);
  }
  return port;
}

// ---------------------------------------------------------------------------
// Factory — the default export consumed by the pi runtime
// ---------------------------------------------------------------------------

function factory(pi: ExtensionAPI): void {
  // -------------------------------------------------------------------------
  // 0. Build StageAdapters and WorkflowUIAdapter from pi runtime surfaces.
  //    Both are passed into every createExtensionRuntime() call so that
  //    stage.prompt() / stage.complete() / stage.subagent() and HIL
  //    ui.input() / confirm() / select() / editor() work outside tests.
  // -------------------------------------------------------------------------
  const adapters = buildRuntimeAdapters(pi);
  const ui = buildUIAdapter(pi);

  // Build graph overlay adapter — wraps GraphView + pi.ui.custom.
  // noopOverlay returned when pi.ui?.custom is absent (degraded runtime).
  const overlay: GraphOverlayPort = buildGraphOverlayAdapter(pi, store);

  // -------------------------------------------------------------------------
  // 1. Create ExtensionRuntime — mutable ref seeded from sync bundled discovery,
  //    upgraded to unified async discovery once discoverWorkflows() resolves.
  //
  //    runtimeProxy delegates all calls to runtimeRef.current so every
  //    registration closure automatically uses the most-current registry without
  //    needing to be re-registered.
  // -------------------------------------------------------------------------
  const runtimeRef: { current: ExtensionRuntime } = {
    current: createExtensionRuntime({
      registry: discoverBundledWorkflowsSync().registry,
      adapters,
      ui,
      cancellation: cancellationRegistry,
      persistence: makePersistencePort(pi, WORKFLOW_CONFIG_DEFAULTS.persistRuns),
    }),
  };
  const discoveryRef: { current: DiscoveryResult | null } = { current: null };
  const configLoadRef: { current: ConfigLoadResult | null } = { current: null };

  /** Stable proxy — all registrations close over this; delegates to runtimeRef.current. */
  const runtimeProxy: ExtensionRuntime = {
    get registry() {
      return runtimeRef.current.registry;
    },
    dispatch(args) {
      return runtimeRef.current.dispatch(args);
    },
  };

  const executeWorkflowTool = makeExecuteWorkflowTool(runtimeProxy);

  // Start unified async discovery immediately.
  // On resolve: swap runtime ref and register /workflow:<name> aliases for any
  // workflows beyond the bundled set (project-local, user-global, settings paths).
  const bundledNames = new Set(runtimeRef.current.registry.names());

  // Load startup config before discovery so workflow paths and tunables are applied.
  const discoveryPromise = loadWorkflowConfig().then(async (configResult) => {
    configLoadRef.current = configResult;

    // Map config.workflows entries → DiscoveryConfig.projectWorkflows for
    // settings-based discovery (merged config — project wins over global).
    const discoveryConfig =
      configResult.config !== null ? toDiscoveryConfig(configResult.config) : undefined;

    const result = await discoverWorkflows({ config: discoveryConfig });
    discoveryRef.current = result;
    const resolvedPersistRuns = configResult.config?.persistRuns ?? WORKFLOW_CONFIG_DEFAULTS.persistRuns;
    runtimeRef.current = createExtensionRuntime({
      registry: result.registry,
      adapters,
      ui,
      cancellation: cancellationRegistry,
      persistence: makePersistencePort(pi, resolvedPersistRuns),
    });

    // Register /workflow:<name> aliases for workflows discovered beyond the
    // initial bundled set (project-local, user-global, settings).
    for (const workflowName of result.registry.names()) {
      if (bundledNames.has(workflowName)) continue;
      registerWorkflowAlias(pi, workflowName, runtimeProxy);
    }
  });

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
      "Run or inspect pi workflows. Usage: /workflow <name> [key=value…] | /workflow [list|status|kill|resume|inputs] [args]",
    execute: async (args: string, ctx: PiCommandContext) => {
      const print = ctx.reply ?? ctx.print ?? ((_msg: string) => undefined);
      const rawParts = args.trim().split(/\s+/);
      const parts = rawParts[0] === "" ? [] : rawParts;
      const subcommand = parts[0] ?? "";

      // -----------------------------------------------------------------------
      // list (default when no subcommand)
      // -----------------------------------------------------------------------
      if (!subcommand || subcommand === "list") {
        const names = runtimeProxy.registry.names();
        if (names.length === 0) {
          print("Registered workflows: (none)");
        } else {
          print(`Registered workflows: ${names.join(", ")}`);
        }
        return;
      }

      // -----------------------------------------------------------------------
      // status
      // -----------------------------------------------------------------------
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

      // -----------------------------------------------------------------------
      // kill
      // -----------------------------------------------------------------------
      if (subcommand === "kill") {
        const target = parts[1] ?? "";
        if (!target) {
          print("Usage: /workflow kill <runId> | --all");
          return;
        }
        if (target === "--all") {
          const results = killAllRuns({ cancellation: cancellationRegistry });
          const killed = results.filter((r) => r.ok).length;
          print(killed > 0 ? `Killed ${killed} run(s).` : "No in-flight runs to kill.");
        } else {
          const result = killRun(target, { cancellation: cancellationRegistry });
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

      // -----------------------------------------------------------------------
      // resume
      // -----------------------------------------------------------------------
      if (subcommand === "resume") {
        const target = parts[1] ?? "";
        if (!target) {
          print("Usage: /workflow resume <runId>");
          return;
        }
        const result = resumeRun(target);
        if (result.ok) {
          overlay.open(result.runId);
          print(
            `Run ${result.runId} (${result.snapshot.name}) \u2014 status: ${result.snapshot.status}, stages: ${result.snapshot.stages.length}`,
          );
        } else {
          print(
            result.reason === "not_found"
              ? `Run not found: ${target}`
              : `Run ${target} is still active \u2014 no resume needed.`,
          );
        }
        return;
      }

      // -----------------------------------------------------------------------
      // inputs — show a workflow's input schema
      // -----------------------------------------------------------------------
      if (subcommand === "inputs") {
        const workflowName = parts[1] ?? "";
        if (!workflowName) {
          print("Usage: /workflow inputs <name>");
          return;
        }
        const result = await runtimeProxy.dispatch({
          name: workflowName,
          inputs: {},
          action: "inputs",
        });
        if (result.action === "inputs" && "inputs" in result) {
          const r = result as Extract<WorkflowToolResult, { action: "inputs" }>;
          if (r.error) {
            const available = runtimeProxy.registry.names();
            print(
              `${r.error}\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`,
            );
          } else {
            const lines = r.inputs.map((inp: WorkflowInputEntry) => {
              const req = inp.required ? " (required)" : "";
              const def = inp.default !== undefined ? ` [default: ${JSON.stringify(inp.default)}]` : "";
              const desc = inp.description ? ` — ${inp.description}` : "";
              return `  ${inp.name}: ${inp.type}${req}${def}${desc}`;
            });
            print(
              lines.length > 0
                ? `Inputs for "${workflowName}":\n${lines.join("\n")}`
                : `Workflow "${workflowName}" has no declared inputs.`,
            );
          }
        }
        return;
      }

      // -----------------------------------------------------------------------
      // Workflow name dispatch — non-admin first token resolved as workflow name
      // -----------------------------------------------------------------------
      const workflowName = subcommand;
      if (!ADMIN_SUBCOMMANDS.has(workflowName)) {
        const inputTokens = parts.slice(1);
        const inputs = parseWorkflowArgs(inputTokens);
        const result = await runtimeProxy.dispatch({
          name: workflowName,
          inputs,
          action: "run",
        });
        if (result.action === "run" && "runId" in result) {
          const r = result as Extract<WorkflowToolResult, { action: "run"; runId: string }>;
          if (r.status === "failed" && r.runId === "") {
            // Not found — show available names
            const available = runtimeProxy.registry.names();
            print(
              `Workflow not found: ${workflowName}\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`,
            );
          } else if (r.status === "failed") {
            print(`Workflow "${workflowName}" failed: ${r.error ?? "unknown error"}`);
          } else {
            print(
              `Workflow "${workflowName}" completed (runId: ${r.runId})`,
            );
          }
        }
        return;
      }

      // Unreachable — all ADMIN_SUBCOMMANDS handled above, non-admin handled as workflow name.
      print(`/workflow ${args.trim()} — unknown subcommand. Try: list, status, kill, resume, inputs`);
    },
    getArgumentCompletions: async (partial: string): Promise<PiArgumentCompletion[]> => {
      const adminCompletions: PiArgumentCompletion[] = [
        { label: "list", description: "List registered workflows" },
        { label: "status", description: "List in-flight runs" },
        { label: "kill", description: "Abort a run" },
        { label: "resume", description: "Re-open overlay for a run" },
        { label: "inputs", description: "Show a workflow's input schema" },
      ];
      const workflowCompletions: PiArgumentCompletion[] = runtimeProxy.registry
        .names()
        .map((name) => ({ label: name, description: `Run workflow: ${name}` }));
      const all = [...adminCompletions, ...workflowCompletions];
      return partial ? all.filter((c) => c.label.startsWith(partial)) : all;
    },
  });

  // -------------------------------------------------------------------------
  // 2b. Register /workflow:<name> aliases for bundled workflows (sync).
  //     Additional aliases for project-local/user-global workflows are
  //     registered after async discovery resolves (see discoveryPromise above).
  // -------------------------------------------------------------------------
  for (const workflowName of runtimeRef.current.registry.names()) {
    registerWorkflowAlias(pi, workflowName, runtimeProxy);
  }

  // -------------------------------------------------------------------------
  // 3. Register /workflows-doctor slash command
  // -------------------------------------------------------------------------
  tryRegisterSlashCommand(pi, {
    name: "workflows-doctor",
    description:
      "Diagnostics: loaded workflows, sibling availability, config validation.",
    execute: async (_args: string, ctx: PiCommandContext) => {
      const print = ctx.reply ?? ctx.print ?? ((_msg: string) => undefined);
      // Use already-discovered unified registry when available; fall back to bundled-only.
      const discovery = discoveryRef.current ?? (await discoverBundledWorkflows());
      const siblings: DoctorSiblingStatus = {
        subagents: pi.subagents !== undefined,
        // pi-subagents callable when run() method present on surface
        subagentsCallable: typeof (pi.subagents as Record<string, unknown> | undefined)?.["run"] === "function",
        // pi-mcp-adapter exposes itself as pi["mcpAdapter"] (structural check)
        mcpAdapter: (pi as Record<string, unknown>)["mcpAdapter"] !== undefined,
        // mcp scope events: pi.events.emit present (used by setMcpScope to emit mcp.scope.set)
        mcpScopeEvents: typeof pi.events?.emit === "function",
        // pi-intercom registers setSessionName on the ExtensionAPI when present
        intercom: typeof pi.setSessionName === "function",
        // HIL adapter available when pi.ui is present
        hil: pi.ui !== undefined,
        // ui.custom overlay available
        uiCustom: typeof pi.ui?.custom === "function",
        // F2/shortcut registration available
        shortcut: typeof pi.registerShortcut === "function",
        // exec abortable when pi.exec accepts AbortSignal (runtime capability)
        execAbortable: typeof pi.exec === "function",
        // persistence appendEntry available
        persistenceAppendEntry: typeof pi.appendEntry === "function",
      };
      print(buildDoctorReport(discovery, siblings, configLoadRef.current));
    },
  });

  // -------------------------------------------------------------------------
  // 4. Register message renderers for lifecycle events (§5.6)
  // -------------------------------------------------------------------------
  if (typeof pi.registerMessageRenderer === "function") {
    pi.registerMessageRenderer(
      "workflow.run.start",
      (payload) => renderRunBanner(payload as RunStartPayload),
    );
    pi.registerMessageRenderer(
      "workflow.stage.start",
      (payload) => renderStageChip(payload as StageStartPayload),
    );
    pi.registerMessageRenderer(
      "workflow.stage.progress",
      (payload) => renderStageProgress(payload as StageProgressPayload),
    );
    pi.registerMessageRenderer(
      "workflow.stage.end",
      (payload) => renderStageResult(payload as StageEndPayload),
    );
    pi.registerMessageRenderer(
      "workflow.run.end",
      (payload) => renderRunSummary(payload as RunEndPayload),
    );
  }

  // -------------------------------------------------------------------------
  // 5. Register CLI flags (§5.13) + wire runWorkflowFromCliFlags
  //    registerWorkflowCliFlags replaces manual pi.registerFlag calls.
  //    runWorkflowFromCliFlags is dispatched on session_start (pi.on available)
  //    or after discovery resolves as a safe fallback.
  // -------------------------------------------------------------------------
  registerWorkflowCliFlags(pi);

  // -------------------------------------------------------------------------
  // 6. Persistence: session_start restore + session_before_compact hook (§5.6, Phase D)
  //    + runWorkflowFromCliFlags startup dispatch (§5.13)
  // -------------------------------------------------------------------------
  if (typeof pi.on === "function") {
    pi.on("session_start", async () => {
      // Ensure config+discovery are ready before restoring in-flight runs and
      // dispatching CLI workflow flags — tunables must be resolved first.
      await discoveryPromise;
      void runWorkflowFromCliFlags({ runtime: runtimeProxy });

      if (pi.sessionManager) {
        const cfg = configLoadRef.current?.config;
        restoreOnSessionStart(
          pi.sessionManager,
          {
            resumeInFlight: cfg?.resumeInFlight ?? "ask",
            persistRuns: cfg?.persistRuns ?? true,
          },
          store,
        );
      }
    });

    installCompactionHook(pi, store);
  } else {
    // Safe fallback when pi.on is unavailable: dispatch CLI flags after discovery.
    void discoveryPromise.then(() => {
      void runWorkflowFromCliFlags({ runtime: runtimeProxy });
    });
  }

  installStoreWidget(pi, store);
  installToolExecutionHooks(pi, store);

  // -------------------------------------------------------------------------
  // 7b. Register F2 keyboard shortcut — open graph overlay for active run.
  //     Falls back to noop when pi.registerShortcut is absent (degraded runtime).
  //     Existing API shape: (key, { description, handler }).
  // -------------------------------------------------------------------------
  if (typeof pi.registerShortcut === "function") {
    pi.registerShortcut("F2", {
      description: "Open workflow graph overlay for the active run",
      handler: () => {
        const activeRunId = store.activeRunId();
        overlay.open(activeRunId);
      },
    });
  }

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
}

export default factory;
