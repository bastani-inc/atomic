/**
 * `atomic workflow inputs <name> -a <agent>` — print a workflow's
 * declared input schema so an orchestrating agent can build a valid
 * `atomic workflow -n <name> -a <agent> --<field>=<value>` invocation
 * without having to read the workflow source.
 *
 * Output formats:
 *   --format json   (default) — machine-parseable JSON
 *   --format text             — human-friendly text table
 *
 * Free-form workflows (no declared inputs) report a single synthetic
 * `prompt` field so callers can treat both shapes uniformly.
 */

import { COLORS, createPainter } from "@bastani/atomic-sdk/theme/colors";
import {
  getAgentKeys,
  isValidAgent,
} from "@bastani/atomic-sdk/services/config/definitions";
import { blockIfBroken, getActiveRegistry } from "./workflow.ts";
import type {
  WorkflowInput,
  WorkflowDefinition,
  ExternalWorkflow,
  AgentType,
} from "@bastani/atomic-sdk";
import { getDescription, getInputSchema } from "@bastani/atomic-sdk";

export type WorkflowInputsFormat = "json" | "text";

export interface WorkflowInputsResult {
  workflow: string;
  agent: string;
  description: string;
  freeform: boolean;
  inputs: WorkflowInput[];
}

/**
 * Build the JSON payload returned to the agent. Free-form workflows
 * synthesise a single optional `prompt` field so consumers don't have
 * to special-case them — the same call shape works for both kinds.
 */
export function buildInputsPayload(
  workflowName: string,
  agent: string,
  description: string,
  inputs: readonly WorkflowInput[],
): WorkflowInputsResult {
  const freeform = inputs.length === 0;
  const declared: WorkflowInput[] = freeform
    ? [
        {
          name: "prompt",
          type: "text",
          required: false,
          description:
            "Free-form prompt — pass as a positional arg to `atomic workflow -n <name> -a <agent> \"<prompt>\"`.",
        },
      ]
    : inputs.map((i) => ({ ...i }));
  return {
    workflow: workflowName,
    agent,
    description,
    freeform,
    inputs: declared,
  };
}

/** Render the payload as a human-friendly text block. */
export function renderInputsText(payload: WorkflowInputsResult): string {
  const paint = createPainter();
  const lines: string[] = [];
  lines.push("");
  lines.push(
    "  " +
      paint("text", payload.workflow, { bold: true }) +
      paint("dim", " (") +
      paint("accent", payload.agent) +
      paint("dim", ")"),
  );
  if (payload.description) {
    lines.push("  " + paint("dim", payload.description));
  }
  lines.push("");
  if (payload.freeform) {
    lines.push("  " + paint("dim", "free-form workflow — single positional prompt"));
    lines.push("");
    lines.push(
      "  " +
        paint("dim", "run: ") +
        paint(
          "accent",
          `atomic workflow -n ${payload.workflow} -a ${payload.agent} "<prompt>"`,
        ),
    );
    lines.push("");
    return lines.join("\n") + "\n";
  }

  for (const field of payload.inputs) {
    const requiredLabel = field.required ? paint("warning", " (required)") : "";
    const typeLabel = paint("dim", ` [${field.type}]`);
    lines.push(
      "  " +
        paint("accent", `--${field.name}`) +
        typeLabel +
        requiredLabel,
    );
    if (field.description) {
      lines.push("      " + paint("text", field.description));
    }
    if (field.type === "enum" && field.values && field.values.length > 0) {
      lines.push(
        "      " +
          paint("dim", "values: ") +
          paint("text", field.values.join(", ")),
      );
    }
    if (field.default !== undefined) {
      lines.push(
        "      " +
          paint("dim", "default: ") +
          paint("text", String(field.default)),
      );
    }
    if (field.placeholder) {
      lines.push(
        "      " +
          paint("dim", "placeholder: ") +
          paint("text", field.placeholder),
      );
    }
  }

  lines.push("");
  const flagExample = payload.inputs
    .map((i) => `--${i.name}=<${i.type}>`)
    .join(" ");
  lines.push(
    "  " +
      paint("dim", "run: ") +
      paint(
        "accent",
        `atomic workflow -n ${payload.workflow} -a ${payload.agent} ${flagExample}`,
      ),
  );
  lines.push("");
  return lines.join("\n") + "\n";
}

export interface WorkflowInputsOptions {
  name: string;
  agent: string;
  format?: WorkflowInputsFormat;
  cwd?: string;
}

/**
 * A resolved workflow entry — enough information for the inputs command
 * to load and render the workflow's declared schema.
 */
export interface ResolvedWorkflowEntry {
  name: string;
  agent: AgentType;
}

/**
 * Result of loading a workflow definition — either success with the
 * definition or a failure with a stage label and message.
 */
export type WorkflowLoadResult =
  | { ok: true; value: { definition: WorkflowDefinition | ExternalWorkflow } }
  | { ok: false; stage: string; error: unknown; message: string };

/**
 * Deps for `workflowInputsCommand`. Injected so tests can drive every
 * branch (unknown agent / missing workflow / load failure / success)
 * without touching the real registry or filesystem.
 */
export interface WorkflowInputsDeps {
  findWorkflow: (name: string, agent: AgentType, cwd?: string) => Promise<ResolvedWorkflowEntry | null>;
  loadWorkflow: (entry: ResolvedWorkflowEntry) => Promise<WorkflowLoadResult>;
}

function registryFindWorkflow(name: string, agent: AgentType): Promise<ResolvedWorkflowEntry | null> {
  const registry = getActiveRegistry();
  const wf = registry.resolve(name, agent);
  if (!wf) return Promise.resolve(null);
  return Promise.resolve({ name: wf.name, agent: wf.agent });
}

function registryLoadWorkflow(entry: ResolvedWorkflowEntry): Promise<WorkflowLoadResult> {
  const registry = getActiveRegistry();
  const wf = registry.resolve(entry.name, entry.agent);
  if (!wf) {
    return Promise.resolve({
      ok: false,
      stage: "resolve",
      error: new Error(`Workflow not found: ${entry.agent}/${entry.name}`),
      message: `Workflow not found: ${entry.agent}/${entry.name}`,
    });
  }
  return Promise.resolve({ ok: true, value: { definition: wf } });
}

const defaultDeps: WorkflowInputsDeps = {
  findWorkflow: registryFindWorkflow,
  loadWorkflow: registryLoadWorkflow,
};

/**
 * Resolve the workflow, then either print its input schema (success)
 * or print an error and return a non-zero exit code. The json branch
 * also writes errors as JSON so an agent can parse a single envelope
 * regardless of outcome.
 */
export async function workflowInputsCommand(
  options: WorkflowInputsOptions,
  deps: WorkflowInputsDeps = defaultDeps,
): Promise<number> {
  const format: WorkflowInputsFormat = options.format ?? "json";

  if (!isValidAgent(options.agent)) {
    return reportError(
      format,
      `Unknown agent '${options.agent}'. Valid agents: ${getAgentKeys().join(", ")}`,
    );
  }
  const agent = options.agent;

  blockIfBroken(options.name, agent);

  const discovered = await deps.findWorkflow(options.name, agent, options.cwd);
  if (!discovered) {
    return reportError(
      format,
      `Workflow '${options.name}' not found for agent '${agent}'.`,
    );
  }

  const loaded = await deps.loadWorkflow(discovered);
  if (!loaded.ok) {
    return reportError(format, loaded.message);
  }
  const def = loaded.value.definition;

  const payload = buildInputsPayload(
    def.name,
    agent,
    getDescription(def),
    getInputSchema(def),
  );

  if (format === "json") {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(renderInputsText(payload));
  }
  return 0;
}

function reportError(format: WorkflowInputsFormat, message: string): number {
  if (format === "json") {
    process.stdout.write(JSON.stringify({ error: message }, null, 2) + "\n");
  } else {
    process.stderr.write(`${COLORS.red}Error: ${message}${COLORS.reset}\n`);
  }
  return 1;
}
