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

import { Command } from "@commander-js/extra-typings";
import {
  type AgentType,
  type ExternalWorkflow,
  type WorkflowDefinition,
  type WorkflowInput,
  getInputSchema,
  listWorkflows,
  runWorkflow,
} from "@bastani/atomic-sdk";
import {
  getAgentKeys,
  isValidAgent,
} from "@bastani/atomic-sdk/services/config/definitions";
import { buildInputUnion, toCamelCase } from "@bastani/atomic-sdk/worker-shared";
import { createBuiltinRegistry } from "../builtin-registry.ts";
import { WorkflowPickerPanel } from "@bastani/atomic-sdk/workflows/components";

/** Resolve a workflow against the builtin registry, throwing with a usable hint. */
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

/** Run a resolved workflow with merged inputs. */
async function dispatch(
  workflow: WorkflowDefinition | ExternalWorkflow,
  cliInputs: Record<string, string>,
  detach: boolean,
): Promise<void> {
  if ("kind" in workflow && workflow.kind === "external") {
    // External workflows are dispatched via subprocess (_atomic-run).
    // Full dispatch implementation is in §5.6 (separate task).
    throw new Error(
      `[atomic/workflow] External workflow dispatch not yet implemented for "${workflow.name}".`,
    );
  }
  // The SDK's `runWorkflow` auto-defaults `pathToAtomicExecutable` to
  // `process.execPath` in compiled-binary hosts, so atomic's compiled
  // CLI self-dispatches `_orchestrator-entry` through its own binary
  // (handled by atomic's hidden Commander command, which falls back to
  // the builtin registry when the SDK's source-path dispatcher can't
  // resolve). In dev mode (`bun packages/atomic/src/cli.ts …`) the
  // auto-default returns undefined and the SDK's host-bun branch fires.
  await runWorkflow({
    workflow,
    inputs: cliInputs,
    detach,
  });
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
  const panel = await WorkflowPickerPanel.create({ agent, registry });
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
 */
export function buildWorkflowCommand(
  registry: ReturnType<typeof createBuiltinRegistry> = createBuiltinRegistry(),
): Command {
  const all = listWorkflows(registry);
  const allNames = [...new Set(all.map((w) => w.name))];
  // buildInputUnion enforces the reserved-name and type-conflict checks
  // the SDK previously ran inside createWorkflowCli.
  const unionInputs: Map<string, WorkflowInput> = buildInputUnion(all);

  const cmd = new Command("workflow");

  // Subcommands declare their own `-a`; without enablePositionalOptions
  // the parent would greedily bind the flag.
  cmd.enablePositionalOptions();

  cmd.option("-n, --name <name>", "Workflow name", (v) => {
    if (allNames.length > 0 && !allNames.includes(v)) {
      throw new Error(
        `[atomic/workflow] Unknown workflow name "${v}". ` +
          `Available: ${allNames.join(", ")}.`,
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

  for (const [, input] of unionInputs) {
    const desc =
      input.description ??
      (input.type === "enum"
        ? `one of: ${(input.values ?? []).join(", ")}`
        : input.type);
    cmd.option(`--${input.name} <value>`, desc);
  }

  cmd.option("-d, --detach", "Run workflow in background (detach from tmux)");

  cmd.argument("[prompt...]", "Free-form prompt (joined, stored as inputs.prompt)");

  cmd.allowUnknownOption(false);
  cmd.allowExcessArguments(true);

  cmd.action(async function (this: Command) {
    const options = this.opts() as Record<string, string | boolean | undefined>;
    const promptTokens: string[] = this.args;

    const name = options["name"] as string | undefined;
    const agent = options["agent"] as AgentType | undefined;
    const detach = options["detach"] === true;

    const cliInputs: Record<string, string> = {};
    for (const [inputName] of unionInputs) {
      const camelKey = toCamelCase(inputName);
      const v = options[camelKey];
      if (typeof v === "string" && v !== "") {
        cliInputs[inputName] = v;
      }
    }

    // Free-form workflows: collapse the trailing positional args into
    // `inputs.prompt` so workflow authors can keep reading
    // `ctx.inputs.prompt` regardless of declared schema.
    const promptStr = promptTokens.join(" ");
    if (promptStr !== "" && name && agent) {
      const def = registry.resolve(name, agent);
      if (def && getInputSchema(def).length === 0) {
        cliInputs["prompt"] = promptStr;
      }
    }

    if (!name && agent && process.stdout.isTTY) {
      await runPicker(registry, agent, detach);
      return;
    }

    if (name === undefined || agent === undefined) {
      // help() exits the process; the explicit `return` keeps narrowing
      // happy for the lines below.
      cmd.help();
      return;
    }

    const workflow = resolveWorkflow(registry, name, agent);
    await dispatch(workflow, cliInputs, detach);
  });

  return cmd;
}

export const workflowCommand = buildWorkflowCommand();
