/**
 * cli-flags — parse --workflow / --workflow-inputs / --inputs
 * argv flags, validate against the declared schema, and dispatch the run.
 *
 * Entry points:
 *   registerWorkflowCliFlags(pi)   — register flag metadata with ExtensionAPI
 *   runWorkflowFromCliFlags(opts)  — parse argv, validate, dispatch, return result
 *
 * Design note on the flag surface:
 *   Pi's `pi.registerFlag(name, ...)` only accepts a literal flag name (see
 *   pi-coding-agent/dist/core/extensions/types.d.ts). It does NOT support
 *   placeholders, wildcards, or repeated registrations. Concrete flags that
 *   don't match a registered literal are rejected by pi's CLI parser with
 *   "Unknown option: --<name>" before the extension factory ever runs.
 *
 *   Earlier iterations of this module registered "workflow-input-<key>" with
 *   a placeholder, expecting pi to expand it. Pi treats the literal string as
 *   the flag name, so concrete invocations like `--workflow-input-prompt=...`
 *   never resolved and every headless run failed at startup.
 *
 *   The current surface uses two literal flags:
 *     --workflow-inputs=<json>       — inline JSON object of inputs
 *     --inputs=<path>  — path to a JSON file of inputs
 *   These are mutually exclusive. Parsed inputs are validated against the
 *   workflow's declared input schema before the run is dispatched.
 *
 * cross-ref: src/extension/index.ts (§5.13 flag registration)
 *            src/extension/runtime.ts (ExtensionRuntime.dispatch)
 *            src/runs/shared/validate-inputs.ts (schema validator)
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "../../extension/index.js";
import type { ExtensionRuntime } from "../../extension/runtime.js";
import type { WorkflowToolResult } from "../../extension/render-result.js";
import { renderInputsSchema } from "../../shared/render-inputs-schema.js";
import { validateInputs, type ValidationError } from "./validate-inputs.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Parsed values extracted from argv for workflow execution. */
export interface WorkflowFlagValues {
  /** Workflow name from --workflow or --workflow=<name>. */
  workflow: string;
  /** Inputs parsed from --workflow-inputs=<json>. Empty when flag absent. */
  inputs: Record<string, unknown>;
  /** Path captured from --inputs; resolved (read+parsed) in runWorkflowFromCliFlags. */
  inputsFile?: string;
  /** True when --workflow-help was supplied alongside --workflow. */
  help?: boolean;
  /** Set when one of the input flags couldn't be parsed or both were given. */
  error?: string;
}

export interface WorkflowCliAdapterOptions {
  /** ExtensionRuntime used to dispatch. */
  runtime: ExtensionRuntime;
  /**
   * Raw argv to parse.  Falls back to `process.argv.slice(2)` when omitted.
   * Pass an explicit array in tests to avoid touching the real process.
   */
  argv?: string[];
}

/** Result returned by runWorkflowFromCliFlags. */
export type WorkflowCliResult =
  | { handled: false }
  | {
      handled: true;
      status: "completed" | "failed";
      result?: WorkflowToolResult;
      /** Error diagnostic (validation failure, parse error, dispatch failure). */
      error?: string;
      /** Informational text (e.g. --workflow-help schema output). */
      message?: string;
    };

// ---------------------------------------------------------------------------
// Flag registration
// ---------------------------------------------------------------------------

/**
 * Register --workflow, --workflow-inputs, and --inputs flag
 * metadata with the pi ExtensionAPI. All names are literal — pi rejects
 * placeholder/dynamic flag names at parse time.
 *
 * Safe to call when pi.registerFlag is absent (degrades silently).
 */
export function registerWorkflowCliFlags(pi: ExtensionAPI): void {
  if (typeof pi.registerFlag !== "function") return;

  pi.registerFlag("workflow", {
    description: "Run the named workflow headlessly (e.g. pi -p --workflow=<name>).",
    type: "string",
  });

  pi.registerFlag("workflow-inputs", {
    description:
      'JSON object of workflow inputs (e.g. --workflow-inputs=\'{"prompt":"...","count":3}\'). Repeating the flag overwrites previous values. Mutually exclusive with --inputs.',
    type: "string",
  });

  pi.registerFlag("inputs", {
    description:
      "Path to a JSON file containing the workflow inputs object. Mutually exclusive with --workflow-inputs.",
    type: "string",
  });

  pi.registerFlag("workflow-help", {
    description: "Print the named workflow's input schema and exit without dispatching.",
    type: "boolean",
  });
}

// ---------------------------------------------------------------------------
// argv parsing
// ---------------------------------------------------------------------------

/**
 * Parse the value of a single --workflow-inputs occurrence. Returns the parsed
 * object on success or an Error describing the failure. Non-object JSON values
 * (arrays, scalars) are rejected — workflow inputs are always a keyed bag.
 */
function parseInputsJson(raw: string, flagName: string): Record<string, unknown> | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`${flagName}: invalid JSON — ${msg}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Error(`${flagName}: expected a JSON object of input key/value pairs`);
  }
  return parsed as Record<string, unknown>;
}

/**
 * Parse workflow flag values from a raw argv array.
 *
 * Supports:
 *   --workflow=<name>                    --workflow <name>
 *   --workflow-inputs=<json-object>      --workflow-inputs <json-object>
 *   --inputs=<path>        --inputs <path>
 *
 * Returns null when --workflow is absent.  --workflow-inputs and
 * --inputs are mutually exclusive: supplying both sets `error`.
 * Repeating --workflow-inputs replaces any prior value (last wins).
 * Malformed JSON populates `error` but still returns a non-null result so the
 * caller can surface diagnostics.
 */
export function parseWorkflowFlags(argv: string[]): WorkflowFlagValues | null {
  let workflow: string | null = null;
  let inputs: Record<string, unknown> = {};
  let inputsFile: string | undefined;
  let inputsFlagSeen = false;
  let help = false;
  let error: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (arg.startsWith("--workflow=")) {
      workflow = arg.slice("--workflow=".length);
      continue;
    }

    if (arg === "--workflow") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        workflow = next;
        i++;
      }
      continue;
    }

    if (arg === "--workflow-help") {
      help = true;
      continue;
    }

    if (arg.startsWith("--inputs=")) {
      inputsFile = arg.slice("--inputs=".length);
      continue;
    }

    if (arg === "--inputs") {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        inputsFile = next;
        i++;
      }
      continue;
    }

    if (arg.startsWith("--workflow-inputs=")) {
      const raw = arg.slice("--workflow-inputs=".length);
      inputsFlagSeen = true;
      const parsed = parseInputsJson(raw, "--workflow-inputs");
      if (parsed instanceof Error) {
        error = parsed.message;
        inputs = {};
      } else {
        inputs = parsed;
        error = undefined;
      }
      continue;
    }

    if (arg === "--workflow-inputs") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        inputsFlagSeen = true;
        continue;
      }
      inputsFlagSeen = true;
      const parsed = parseInputsJson(next, "--workflow-inputs");
      i++;
      if (parsed instanceof Error) {
        error = parsed.message;
        inputs = {};
      } else {
        inputs = parsed;
        error = undefined;
      }
      continue;
    }
  }

  if (workflow === null) return null;

  if (inputsFile !== undefined && inputsFlagSeen) {
    return {
      workflow,
      inputs: {},
      error: "--workflow-inputs and --inputs are mutually exclusive",
    };
  }

  const out: WorkflowFlagValues = { workflow, inputs };
  if (inputsFile !== undefined) out.inputsFile = inputsFile;
  if (help) out.help = true;
  if (error !== undefined) out.error = error;
  return out;
}

// ---------------------------------------------------------------------------
// File loader
// ---------------------------------------------------------------------------

function loadInputsFile(path: string): Record<string, unknown> | Error {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Error(`--inputs: ${msg}`);
  }
  return parseInputsJson(raw, "--inputs");
}

// ---------------------------------------------------------------------------
// Schema-validation error rendering
// ---------------------------------------------------------------------------

function formatValidationFailure(
  workflowName: string,
  schema: Parameters<typeof renderInputsSchema>[1] extends infer _ ? Record<string, import("../../shared/types.js").WorkflowInputSchema> : never,
  errors: ValidationError[],
  sourceFlag: "--workflow-inputs" | "--inputs",
): string {
  // renderInputsSchema needs WorkflowInputEntry[]; rebuild from the raw schema
  // so the user sees the same shape they'd see from `/workflow inputs <name>`.
  const entries = Object.entries(schema).map(([name, def]) => ({
    name,
    type: def.type,
    description: def.description,
    required: def.required,
    default: "default" in def ? def.default : undefined,
  }));
  const schemaText = renderInputsSchema(workflowName, entries);
  const lines = errors.map((e) => `  - ${e.key}: ${e.reason}`);
  return `Invalid ${sourceFlag} for "${workflowName}":\n${lines.join("\n")}\n\n${schemaText}`;
}

// ---------------------------------------------------------------------------
// Runtime dispatch
// ---------------------------------------------------------------------------

/**
 * Parse argv flags, validate inputs against the workflow's declared schema,
 * and dispatch via the provided runtime.
 *
 * Returns `{ handled: false }` when --workflow is absent.
 * Returns `{ handled: true, status, result?, error? }` otherwise.
 *
 * Fail-fast (status:"failed", no dispatch) when:
 *   - --workflow-inputs JSON is malformed
 *   - --inputs path is missing/unreadable or contains bad JSON
 *   - both input flags were supplied
 *   - declared input schema rejects the parsed payload
 */
export async function runWorkflowFromCliFlags(
  opts: WorkflowCliAdapterOptions,
): Promise<WorkflowCliResult> {
  const argv = opts.argv ?? process.argv.slice(2);
  const parsed = parseWorkflowFlags(argv);

  if (parsed === null) {
    return { handled: false };
  }

  if (parsed.error !== undefined) {
    return { handled: true, status: "failed", error: parsed.error };
  }

  // --workflow-help: print schema and return without dispatching.
  if (parsed.help) {
    const def = opts.runtime.registry.get(parsed.workflow);
    if (def === undefined) {
      const available = opts.runtime.registry.names();
      return {
        handled: true,
        status: "failed",
        error: `Workflow not found: "${parsed.workflow}"\nAvailable: ${available.length > 0 ? available.join(", ") : "(none)"}`,
      };
    }
    const entries = Object.entries(def.inputs).map(([name, d]) => ({
      name,
      type: d.type,
      description: d.description,
      required: d.required,
      default: "default" in d ? d.default : undefined,
    }));
    return {
      handled: true,
      status: "completed",
      message: renderInputsSchema(def.name, entries),
    };
  }

  let inputs = parsed.inputs;
  let sourceFlag: "--workflow-inputs" | "--inputs" = "--workflow-inputs";
  if (parsed.inputsFile !== undefined) {
    const loaded = loadInputsFile(parsed.inputsFile);
    if (loaded instanceof Error) {
      return { handled: true, status: "failed", error: loaded.message };
    }
    inputs = loaded;
    sourceFlag = "--inputs";
  }

  // Validate against declared schema when the workflow is registered. When
  // it isn't, defer to dispatch so the user gets the canonical not-found
  // diagnostic from the runtime rather than a misleading validation error.
  const def = opts.runtime.registry.get(parsed.workflow);
  if (def !== undefined) {
    const errors = validateInputs(def.inputs, inputs);
    if (errors.length > 0) {
      return {
        handled: true,
        status: "failed",
        error: formatValidationFailure(def.name, def.inputs, errors, sourceFlag),
      };
    }
  }

  try {
    const result = await opts.runtime.dispatch({
      action: "run",
      workflow: parsed.workflow,
      inputs,
    });

    if (result.action === "run") {
      const r = result as Extract<WorkflowToolResult, { action: "run" }>;
      const status = r.status === "failed" ? "failed" : "completed";
      return { handled: true, status, result, error: r.error };
    }

    return { handled: true, status: "completed", result };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { handled: true, status: "failed", error: message };
  }
}
