/**
 * `atomic workflow` command — built directly on the SDK's primitives.
 *
 * Produces a Commander `Command` with the same UX as the previous
 * `createWorkflowCli`-driven implementation:
 *   - `-n/--name <name>` selects the workflow
 *   - `-a/--agent <agent>` selects the agent backend
 *   - `-d/--detach` runs in the background
 *   - one `--<input>` flag per declared input across the registry (with
 *     reserved-name and type-conflict checks via `buildInputUnion`)
 *   - `[prompt...]` positional for free-form workflows
 *   - interactive picker when `-a` is given without `-n` in a TTY
 *
 * The exported Command is mounted as a subcommand of the root atomic
 * program (see `src/cli.ts`), which then attaches `list`, `inputs`,
 * `status`, and `session` siblings on top of it.
 */

import { randomBytes } from "node:crypto";
import { constants as osConstants } from "node:os";
import { Command, Option } from "@commander-js/extra-typings";
import {
  type AgentType,
  type ExternalWorkflow,
  type WorkflowDefinition,
  type WorkflowInput,
  getInputSchema,
  listWorkflows,
} from "@bastani/atomic-sdk";
import {
  getAgentKeys,
  isValidAgent,
} from "@bastani/atomic-sdk/services/config/definitions";
import { buildInputUnion, toCamelCase } from "@bastani/atomic-sdk/worker-shared";
import { createBuiltinRegistry } from "../builtin-registry.ts";
import { WorkflowPickerPanel } from "@bastani/atomic-sdk/workflows/components";
import type { BrokenWorkflow } from "../custom-workflows.ts";

// ─── Signal exit-code table ───────────────────────────────────────────────────

/** Numeric IDs for signals atomic propagates as `128 + N` exit codes. Built from os.constants at module load for portability across platforms and future signals. */
const SIGNAL_NAME_TO_NUMBER: Record<string, number> = Object.fromEntries(
  Object.entries(osConstants.signals).map(([name, num]) => [name, num as number]),
);

/** Exit code used when a signal name is not present in os.constants.signals. */
const UNKNOWN_SIGNAL_EXIT = 129;

// ─── Module-level mutable state (late-bound active registry) ─────────────────

let activeRegistry: ReturnType<typeof createBuiltinRegistry> = createBuiltinRegistry();
let activeBroken: ReadonlyMap<string, BrokenWorkflow> = new Map();
let activeBrokenList: readonly BrokenWorkflow[] = [];

export function getActiveRegistry(): ReturnType<typeof createBuiltinRegistry> {
  return activeRegistry;
}

export function getActiveBroken(): ReadonlyMap<string, BrokenWorkflow> {
  return activeBroken;
}

export function getActiveBrokenList(): readonly BrokenWorkflow[] {
  return activeBrokenList;
}

/**
 * If `(agent, name)` matches a broken entry in the active index, write the
 * standard 4-line diagnostic to stderr and `process.exit(2)`. No-op otherwise.
 *
 * Centralises the format used by `workflow` and `workflow inputs`.
 */
export function blockIfBroken(name: string, agent: AgentType): void {
  const broken = activeBroken.get(`${agent}/${name}`);
  if (!broken) return;
  process.stderr.write(
    `[atomic/workflows] cannot run "${name}" for agent "${agent}": this workflow failed to load.\n` +
    `  reason · ${broken.reason}\n` +
    `  source · ${broken.source}\n` +
    `  fix    · ${broken.fix}\n`,
  );
  process.exit(2);
}

/** Long flags that `resyncDynamicOptions` must preserve when stripping. */
const RESERVED_LONG_FLAGS = new Set([
  "--name",
  "--agent",
  "--detach",
  "--help",
  "--version",
]);

/** Render a Commander description for a workflow input. */
function inputOptionDescription(input: WorkflowInput): string {
  if (input.description) return input.description;
  if (input.type === "enum") {
    return `one of: ${(input.values ?? []).join(", ")}`;
  }
  return input.type;
}

/**
 * Add one `--<input> <value>` option to `cmd` per entry in the merged input
 * union of `registry`. Used both during initial command construction and on
 * every `rebuildWorkflowCommand`-driven resync.
 */
function applyDynamicOptions(
  cmd: Command,
  registry: ReturnType<typeof createBuiltinRegistry>,
): void {
  for (const [, input] of buildInputUnion(listWorkflows(registry))) {
    cmd.option(`--${input.name} <value>`, inputOptionDescription(input));
  }
}

/**
 * Commander internals exposed for dynamic-option resync. The `options` array
 * is mutable at runtime (the Command constructor assigns `this.options = []`)
 * but typed readonly; `removeAllListeners` is inherited from EventEmitter but
 * not re-declared on the public class.
 */
type CommandInternals = {
  options: Command["options"];
  removeAllListeners(event: string): void;
};

/**
 * Strip all dynamic `--<input>` options from `cmd` and re-add them based
 * on the merged union of inputs across all workflows in `registry`.
 *
 * Reserved flags (-n, -a, -d, --name, --agent, --detach) and Commander
 * internals are left untouched. Each `cmd.option()` call also registers an
 * `option:<long>` EventEmitter listener; we drop those before re-adding to
 * prevent `MaxListenersExceededWarning` on repeated resyncs.
 */
function resyncDynamicOptions(
  cmd: Command,
  registry: ReturnType<typeof createBuiltinRegistry>,
): void {
  const internals = cmd as unknown as CommandInternals;
  for (const opt of cmd.options) {
    if (opt.long && !RESERVED_LONG_FLAGS.has(opt.long)) {
      // Commander emits `option:<long>` without the `--` prefix.
      internals.removeAllListeners(`option:${opt.long.slice(2)}`);
    }
  }
  internals.options = cmd.options.filter((o) => RESERVED_LONG_FLAGS.has(o.long ?? ""));
  applyDynamicOptions(cmd, registry);
}

/**
 * Rebuild the singleton workflow command against a merged registry.
 *
 * Called by cli.ts after custom workflows are loaded. All subsequent
 * `parseAsync` calls dispatch against the merged set.
 */
export function rebuildWorkflowCommand(
  registry: ReturnType<typeof createBuiltinRegistry>,
  brokenIndex: ReadonlyMap<string, BrokenWorkflow>,
  brokenList: readonly BrokenWorkflow[] = [],
): void {
  activeRegistry = registry;
  activeBroken = brokenIndex;
  activeBrokenList = brokenList;
  resyncDynamicOptions(workflowCommand, registry);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve a workflow against a registry, throwing with a usable hint. */
function resolveWorkflow(
  registry: ReturnType<typeof createBuiltinRegistry>,
  name: string,
  agent: AgentType,
): WorkflowDefinition | ExternalWorkflow {
  const def = registry.resolve(name, agent);
  if (def) return def;
  const sameName = listWorkflows(registry)
    .filter((w) => w.name === name)
    .map((w) => w.agent);
  const hint =
    sameName.length > 0
      ? `available agents for "${name}": ${sameName.join(", ")}`
      : `no workflow named "${name}" in registry`;
  throw new Error(
    `[atomic/workflow] no workflow named "${name}" for agent "${agent}"; ${hint}`,
  );
}

/**
 * Build the argv and env for an external workflow subprocess dispatch.
 * Extracted as a pure helper for testability.
 */
export function buildExternalDispatchArgv(
  w: ExternalWorkflow,
  cliInputs: Record<string, string>,
  detach: boolean,
  token: string,
): string[] {
  return [
    w.source.command,
    ...w.source.args,
    "_atomic-run",
    `--dispatch-token=${token}`,
    "--name", w.name,
    "--agent", w.agent,
    ...(detach ? ["--detach"] : []),
    ...Object.entries(cliInputs).flatMap(([k, v]) => [`--${k}`, v]),
  ];
}

/**
 * Build the environment for an external workflow subprocess dispatch.
 * Extracted as a pure helper for testability.
 */
export function buildExternalDispatchEnv(
  token: string,
): Record<string, string> {
  return {
    ...process.env as Record<string, string>,
    ATOMIC_HOST: "1",
    ATOMIC_DISPATCH_TOKEN: token,
  };
}

/** Dispatch an external workflow via subprocess. */
async function dispatchExternal(
  w: ExternalWorkflow,
  cliInputs: Record<string, string>,
  detach: boolean,
): Promise<void> {
  const token = randomBytes(16).toString("hex");
  const child = Bun.spawn(buildExternalDispatchArgv(w, cliInputs, detach, token), {
    cwd: process.cwd(),
    stdio: ["inherit", "inherit", "inherit"],
    env: buildExternalDispatchEnv(token),
  });
  const code = await child.exited;
  const signal = child.signalCode;

  if (signal) {
    process.stderr.write(
      `[atomic/workflows] "${w.name}": child terminated by signal ${signal}\n`,
    );
    const num = SIGNAL_NAME_TO_NUMBER[signal];
    process.exit(num !== undefined ? 128 + num : UNKNOWN_SIGNAL_EXIT);
  }
  if (typeof code !== "number") {
    process.stderr.write(
      `[atomic/workflows] "${w.name}": child exited without numeric code (got ${String(code)})\n`,
    );
    process.exit(1);
  }
  if (code !== 0) process.exit(code);
}

/** Run a resolved workflow with merged inputs. */
export async function dispatch(
  workflow: WorkflowDefinition | ExternalWorkflow,
  cliInputs: Record<string, string>,
  detach: boolean,
): Promise<void> {
  const { ensureStarted } = await import("@bastani/atomic-sdk/runtime/daemon");
  const { getSource, getName, getAgent } = await import("@bastani/atomic-sdk/primitives/metadata");

  const conn = await ensureStarted();

  const result = await conn.sendRequest("workflow/start", {
    source: getSource(workflow),
    workflowName: getName(workflow),
    agent: getAgent(workflow),
    inputs: cliInputs,
  }) as { runId: string; attachable: boolean };

  const { runId } = result;

  if (detach) {
    conn.dispose();
    process.stdout.write(`[atomic/workflow] run started: ${runId}\n`);
    return;
  }

  if (process.stdout.isTTY) {
    conn.dispose();
    const { PanelClient } = await import("@bastani/atomic-sdk/components/panel-client");
    await PanelClient.mount({ runId });
  } else {
    await new Promise<void>((resolve) => {
      conn.onNotification("run/ended", (params: unknown) => {
        if (
          params !== null &&
          typeof params === "object" &&
          "runId" in params &&
          (params as { runId: string }).runId === runId
        ) {
          resolve();
        }
      });
    });
    conn.dispose();
  }
}

/**
 * Drive the interactive picker. The picker reads its registry directly
 * (filtered by agent) and returns the chosen workflow + populated input
 * map; we then hand off to `runWorkflow`.
 */
async function runPicker(
  registry: ReturnType<typeof createBuiltinRegistry>,
  agent: AgentType,
  detach: boolean,
): Promise<void> {
  const panel = await WorkflowPickerPanel.create({ agent, registry, brokenIndex: getActiveBroken() });
  const result = await panel.waitForSelection();
  panel.destroy();
  if (!result) {
    process.stdout.write("No workflow selected.\n");
    return;
  }
  await dispatch(result.workflow, result.inputs, detach);
}

/**
 * Build the workflow command tree. Exported so third-party CLIs (and
 * tests) can reuse the dispatcher with their own registries.
 *
 * @param registry workflow registry to drive the dispatcher; defaults
 *   to the atomic CLI's builtin registry.
 * @param liveRegistry when `true` the action handler reads `activeRegistry`
 *   lazily at call time rather than closing over the initial `registry`
 *   snapshot.  Used by the module singleton so that `rebuildWorkflowCommand`
 *   can hot-swap the registry without rebuilding the Commander tree.
 */
export function buildWorkflowCommand(
  registry: ReturnType<typeof createBuiltinRegistry> = createBuiltinRegistry(),
  liveRegistry = false,
): Command {
  const cmd = new Command("workflow");

  // Subcommands declare their own `-a`; without enablePositionalOptions
  // the parent would greedily bind the flag.
  cmd.enablePositionalOptions();

  cmd.option("-n, --name <name>", "Workflow name", (v) => {
    // Read the LIVE registry on every parse so post-rebuild custom workflows
    // are accepted; fall back to the closure snapshot for non-singleton callers.
    const reg = liveRegistry ? activeRegistry : registry;
    const names = [...new Set(listWorkflows(reg).map((w) => w.name))];

    // Accept broken aliases here so the action handler can run blockIfBroken()
    // and emit the §5.7.3 structured exit-2 block instead of Commander's
    // generic "Unknown workflow name" error.
    const isBrokenAlias = [...activeBroken.keys()].some((k) => k.endsWith(`/${v}`));
    if (!isBrokenAlias && names.length > 0 && !names.includes(v)) {
      throw new Error(
        `[atomic/workflow] Unknown workflow name "${v}". Available: ${names.join(", ")}.`,
      );
    }
    return v;
  });

  cmd.option(
    "-a, --agent <agent>",
    "Agent (claude | opencode | copilot)",
    (v) => {
      if (!isValidAgent(v)) {
        throw new Error(
          `[atomic/workflow] Unknown agent "${v}". ` +
            `Valid agents: ${getAgentKeys().join(", ")}.`,
        );
      }
      return v;
    },
  );

  // Seed the Commander `--<input>` option declarations from the merged
  // input union. `buildInputUnion` enforces reserved-name and type-conflict
  // checks; the action handler recomputes the union from the live registry
  // on every call so post-rebuild custom inputs are still parsed.
  applyDynamicOptions(cmd, registry);

  cmd.option("-d, --detach", "Run workflow in background (detach from tmux)");

  cmd.addOption(
    new Option("--render-pane <runId>", "Internal: run ID to attach the panel client to (used by the CLI daemon path)")
      .hideHelp(),
  );

  cmd.argument("[prompt...]", "Free-form prompt (joined, stored as inputs.prompt)");

  cmd.allowUnknownOption(false);
  cmd.allowExcessArguments(true);

  cmd.action(async function (this: Command) {
    const options = this.opts() as Record<string, string | boolean | undefined>;
    const promptTokens: string[] = this.args;

    const name = options["name"] as string | undefined;
    const agent = options["agent"] as AgentType | undefined;
    const detach = options["detach"] === true;

    // Late-bind: the singleton uses activeRegistry so rebuildWorkflowCommand
    // hot-swaps take effect; custom-registry builds use the closure snapshot.
    const effectiveRegistry = liveRegistry ? activeRegistry : registry;

    // Hard-block broken workflows before attempting dispatch.
    if (name !== undefined && agent !== undefined) {
      blockIfBroken(name, agent);
    }

    // Recompute the input union from the live registry on every invocation
    // so custom-workflow-only inputs (added after `rebuildWorkflowCommand`)
    // are still extracted from `options` and forwarded to the dispatcher.
    const cliInputs: Record<string, string> = {};
    for (const inputName of buildInputUnion(listWorkflows(effectiveRegistry)).keys()) {
      const v = options[toCamelCase(inputName)];
      if (typeof v === "string" && v !== "") {
        cliInputs[inputName] = v;
      }
    }

    // Free-form workflows: collapse the trailing positional args into
    // `inputs.prompt` so workflow authors can keep reading
    // `ctx.inputs.prompt` regardless of declared schema.
    const promptStr = promptTokens.join(" ");
    if (promptStr !== "" && name && agent) {
      const def = effectiveRegistry.resolve(name, agent);
      if (def && getInputSchema(def).length === 0) {
        cliInputs["prompt"] = promptStr;
      }
    }

    if (!name && agent && process.stdout.isTTY) {
      await runPicker(effectiveRegistry, agent, detach);
      return;
    }

    if (name === undefined || agent === undefined) {
      // help() exits the process; the explicit `return` keeps narrowing
      // happy for the lines below.
      cmd.help();
      return;
    }

    const workflow = resolveWorkflow(effectiveRegistry, name, agent);

    if (process.env.ATOMIC_DEBUG === "1") {
      const keys = Object.keys(cliInputs).join(", ");
      process.stderr.write(
        `[atomic/workflow] dispatching ${name}/${agent} kind=${workflow.kind ?? "builtin"} inputs=[${keys}]\n`,
      );
    }

    await dispatch(workflow, cliInputs, detach);
  });

  return cmd;
}

export const workflowCommand = buildWorkflowCommand(createBuiltinRegistry(), true);
