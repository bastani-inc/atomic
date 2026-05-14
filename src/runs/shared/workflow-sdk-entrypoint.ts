/**
 * Non-interactive workflow SDK entrypoint.
 *
 * This is the scriptable harness for exercising direct workflow execution
 * through the same StageAdapters used by the pi extension. By default it
 * creates stages with pi's in-process SDK session factory; tests can inject a
 * deterministic factory without changing the workflow runtime path.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { run, type RunOpts } from "../foreground/executor.js";
import { buildRuntimeAdapters, type RuntimeAdapterBuildOptions, type RuntimeWiringSurface } from "../../extension/wiring.js";
import { discoverWorkflows } from "../../extension/discovery.js";
import { createStore } from "../../shared/store.js";
import { renderInputsSchema } from "../../shared/render-inputs-schema.js";
import { validateInputs, type ValidationError } from "./validate-inputs.js";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { StageSessionRuntime } from "../foreground/stage-runner.js";
import type {
  WorkflowDetails,
  WorkflowDetailsStatus,
  WorkflowInputSchema,
} from "../../shared/types.js";

export interface WorkflowSdkEntrypointSpec {
  mode: "workflow";
  workflow: string;
  inputs?: Record<string, unknown>;
}

export type WorkflowSdkFlagParseResult =
  | { handled: false }
  | { handled: true; spec: WorkflowSdkEntrypointSpec; stubAgent: boolean }
  | { handled: true; error: string };

export type WorkflowSdkEntrypointResult =
  | { handled: false }
  | { handled: true; status: "completed"; details: WorkflowDetails }
  | { handled: true; status: "failed"; error: string };

export interface WorkflowSdkEntrypointOptions {
  argv?: readonly string[];
  cwd?: string;
  homeDir?: string;
  pi?: RuntimeWiringSurface;
  adapterOptions?: RuntimeAdapterBuildOptions;
  runOptions?: Omit<RunOpts, "adapters" | "store">;
}

function readFlagValue(argv: readonly string[], index: number, name: string): { value?: string; nextIndex: number } {
  const arg = argv[index]!;
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) {
    return { value: arg.slice(prefix.length), nextIndex: index };
  }
  if (arg === name) {
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      return { value: next, nextIndex: index + 1 };
    }
  }
  return { nextIndex: index };
}

function parseJsonObject(raw: string, source: string): Record<string, unknown> | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Error(`${source}: invalid JSON - ${message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Error(`${source}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function readWorkflowInputsFile(path: string, source: string): Record<string, unknown> | Error {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Error(`${source}: ${message}`);
  }
  return parseJsonObject(raw, source);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseWorkflowInputScalar(raw: string, source: string): unknown | Error {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(trimmed)) {
    return Number(trimmed);
  }
  if (/^[{\["]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Error(`${source}: invalid JSON value - ${message}`);
    }
  }
  return raw;
}

function parseWorkflowInputArgs(args: readonly string[]): Record<string, unknown> | Error {
  if (args.length === 0) return {};

  if (args.length === 1) {
    const only = args[0]!;
    const trimmed = only.trim();
    if (trimmed.startsWith("@")) {
      return readWorkflowInputsFile(trimmed.slice(1), "@inputs");
    }
    if (trimmed.startsWith("{")) {
      return parseJsonObject(trimmed, "workflow input JSON");
    }
    if (!only.includes("=")) {
      return readWorkflowInputsFile(only, "workflow inputs file");
    }
  }

  const inputs: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf("=");
    if (eq <= 0) {
      return new Error(`workflow input argument "${arg}" must be key=value`);
    }
    const key = arg.slice(0, eq).trim();
    if (key.length === 0) {
      return new Error(`workflow input argument "${arg}" has an empty key`);
    }
    const parsed = parseWorkflowInputScalar(arg.slice(eq + 1), `workflow input ${key}`);
    if (parsed instanceof Error) return parsed;
    inputs[key] = parsed;
  }
  return inputs;
}

export function parseWorkflowSdkFlags(argv: readonly string[]): WorkflowSdkFlagParseResult {
  let workflowName: string | undefined;
  let workflowInputsFile: { path: string; flag: "--inputs" } | undefined;
  const workflowInputArgs: string[] = [];
  let stubAgent = false;

  for (let index = 0; index < argv.length; index += 1) {
    const workflow = readFlagValue(argv, index, "--workflow");
    if (workflow.value !== undefined) {
      workflowName = workflow.value;
      index = workflow.nextIndex;
      continue;
    }

    const inputsFile = readFlagValue(argv, index, "--inputs");
    if (inputsFile.value !== undefined) {
      workflowInputsFile = { path: inputsFile.value, flag: "--inputs" };
      index = inputsFile.nextIndex;
      continue;
    }

    if (argv[index] === "--workflow-stub-agent") {
      stubAgent = true;
      continue;
    }

    if (workflowName !== undefined && !argv[index]!.startsWith("--")) {
      workflowInputArgs.push(argv[index]!);
    }
  }

  if (workflowName === undefined) return { handled: false };

  if (workflowName.trim().length === 0) {
    return { handled: true, error: "--workflow: expected a non-empty workflow name" };
  }
  const inputSources = [
    workflowInputsFile !== undefined,
    workflowInputArgs.length > 0,
  ].filter(Boolean).length;
  if (inputSources > 1) {
    return {
      handled: true,
      error: "--inputs and positional workflow inputs are mutually exclusive",
    };
  }

  let inputs: Record<string, unknown> | Error = {};
  if (workflowInputsFile !== undefined) {
    inputs = readWorkflowInputsFile(workflowInputsFile.path, workflowInputsFile.flag);
  } else if (workflowInputArgs.length > 0) {
    inputs = parseWorkflowInputArgs(workflowInputArgs);
  }
  if (inputs instanceof Error) return { handled: true, error: inputs.message };

  return {
    handled: true,
    spec: {
      mode: "workflow",
      workflow: workflowName,
      inputs,
    },
    stubAgent,
  };
}

function runOptionsWithAdapters(
  opts: WorkflowSdkEntrypointOptions,
  stubAgent: boolean,
): RunOpts {
  const adapterOptions = stubAgent
    ? {
        ...opts.adapterOptions,
        createAgentSession: opts.adapterOptions?.createAgentSession ?? createStubAgentSession,
      }
    : opts.adapterOptions;

  return {
    ...opts.runOptions,
    adapters: buildRuntimeAdapters(opts.pi ?? {}, adapterOptions),
    store: createStore(),
  };
}

async function createStubAgentSession(
  _options?: CreateAgentSessionOptions,
): Promise<{ session: StageSessionRuntime }> {
  let lastAssistantText: string | undefined;
  const session: StageSessionRuntime = {
    async prompt(text: string): Promise<string> {
      lastAssistantText = `stub:sdk:${text}`;
      return lastAssistantText;
    },
    async steer(_text: string): Promise<void> {},
    async followUp(_text: string): Promise<void> {},
    subscribe(): () => void {
      return () => {};
    },
    sessionFile: undefined,
    sessionId: `workflow-sdk-stub-${crypto.randomUUID()}`,
    async setModel(_model): Promise<void> {},
    setThinkingLevel(_level): void {},
    async cycleModel() {
      return undefined;
    },
    cycleThinkingLevel() {
      return undefined;
    },
    agent: Object.create(null) as StageSessionRuntime["agent"],
    model: undefined,
    thinkingLevel: "off",
    messages: [] as StageSessionRuntime["messages"],
    isStreaming: false as StageSessionRuntime["isStreaming"],
    async navigateTree(): ReturnType<StageSessionRuntime["navigateTree"]> {
      return { cancelled: true };
    },
    async compact(): ReturnType<StageSessionRuntime["compact"]> {
      return { summary: "", firstKeptEntryId: "", tokensBefore: 0 };
    },
    abortCompaction(): void {},
    async abort(): Promise<void> {},
    dispose(): void {},
    getLastAssistantText(): string | undefined {
      return lastAssistantText;
    },
  };
  return { session };
}

async function runNamedWorkflow(
  spec: WorkflowSdkEntrypointSpec,
  opts: WorkflowSdkEntrypointOptions,
  runOptions: RunOpts,
): Promise<WorkflowDetails> {
  const discovery = await discoverWorkflows({
    cwd: opts.cwd ?? process.cwd(),
    homeDir: opts.homeDir ?? homedir(),
  });
  const def = discovery.registry.get(spec.workflow);
  if (def === undefined) {
    const available = discovery.registry.names();
    throw new Error(`Workflow not found: "${spec.workflow}". Available: ${available.length > 0 ? available.join(", ") : "(none)"}`);
  }
  const inputs = spec.inputs ?? {};
  const errors = validateInputs(def.inputs, inputs);
  if (errors.length > 0) {
    throw new Error(formatWorkflowSdkValidationFailure(def.name, def.inputs, errors));
  }
  const result = await run(def, inputs, runOptions);
  return {
    action: "run",
    mode: "named",
    runId: result.runId,
    status: toWorkflowDetailsStatus(result.status),
    output: result.result,
    error: result.error,
    progress: {
      completed: result.stages.filter((stage) => stage.status === "completed").length,
      total: result.stages.length,
    },
  };
}

function formatWorkflowSdkValidationFailure(
  workflowName: string,
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  errors: ValidationError[],
): string {
  const entries = Object.entries(schema).map(([name, def]) => ({
    name,
    type: def.type,
    description: def.description,
    required: def.required,
    default: "default" in def ? def.default : undefined,
  }));
  const lines = errors.map((error) => `  - ${error.key}: ${error.reason}`);
  return `Invalid inputs for "${workflowName}":\n${lines.join("\n")}\n\n${renderInputsSchema(workflowName, entries)}`;
}

function toWorkflowDetailsStatus(status: string): WorkflowDetailsStatus {
  switch (status) {
    case "completed":
    case "failed":
    case "killed":
      return status;
    case "running":
    case "pending":
      return "running";
    default:
      return "failed";
  }
}

export async function runWorkflowSdkSpec(
  spec: WorkflowSdkEntrypointSpec,
  opts: WorkflowSdkEntrypointOptions = {},
  stubAgent = false,
): Promise<WorkflowDetails> {
  const runOptions = runOptionsWithAdapters(opts, stubAgent);
  return runNamedWorkflow(spec, opts, runOptions);
}

export async function runWorkflowSdkEntrypoint(
  opts: WorkflowSdkEntrypointOptions = {},
): Promise<WorkflowSdkEntrypointResult> {
  const parsed = parseWorkflowSdkFlags(opts.argv ?? process.argv.slice(2));
  if (!parsed.handled) return { handled: false };
  if ("error" in parsed) return { handled: true, status: "failed", error: parsed.error };

  try {
    const details = await runWorkflowSdkSpec(parsed.spec, opts, parsed.stubAgent);
    return { handled: true, status: "completed", details };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { handled: true, status: "failed", error: message };
  }
}
