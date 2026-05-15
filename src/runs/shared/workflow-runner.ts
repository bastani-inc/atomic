/**
 * Programmatic workflow runner.
 *
 * This helper executes a named workflow from an explicit definition object.
 */

import { homedir } from "node:os";
import { run, type RunOpts as ExecutorRunOptions } from "../foreground/executor.js";
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

export interface WorkflowDefinition {
  mode: "workflow";
  workflow: string;
  inputs?: Record<string, unknown>;
}

export type WorkflowRunOptions = Omit<ExecutorRunOptions, "adapters" | "store">;

export interface WorkflowOptions {
  cwd?: string;
  homeDir?: string;
  pi?: RuntimeWiringSurface;
  adapterOptions?: RuntimeAdapterBuildOptions;
  runOptions?: WorkflowRunOptions;
  /** Use a deterministic in-memory agent session when no adapter is supplied. */
  stubAgent?: boolean;
}

function runOptionsWithAdapters(options: WorkflowOptions): ExecutorRunOptions {
  const adapterOptions = options.stubAgent === true
    ? {
        ...options.adapterOptions,
        createAgentSession: options.adapterOptions?.createAgentSession ?? createStubAgentSession,
      }
    : options.adapterOptions;

  return {
    ...options.runOptions,
    adapters: buildRuntimeAdapters(options.pi ?? {}, adapterOptions),
    store: createStore(),
  };
}

async function createStubAgentSession(
  _options?: CreateAgentSessionOptions,
): Promise<{ session: StageSessionRuntime }> {
  let lastAssistantText: string | undefined;
  const session: StageSessionRuntime = {
    async prompt(text: string): Promise<string> {
      lastAssistantText = `stub:workflow:${text}`;
      return lastAssistantText;
    },
    async steer(_text: string): Promise<void> {},
    async followUp(_text: string): Promise<void> {},
    subscribe(): () => void {
      return () => {};
    },
    sessionFile: undefined,
    sessionId: `workflow-stub-${crypto.randomUUID()}`,
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
  definition: WorkflowDefinition,
  options: WorkflowOptions,
  runOptions: ExecutorRunOptions,
): Promise<WorkflowDetails> {
  const discovery = await discoverWorkflows({
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir ?? homedir(),
  });
  const workflow = discovery.registry.get(definition.workflow);
  if (workflow === undefined) {
    const available = discovery.registry.names();
    throw new Error(`Workflow not found: "${definition.workflow}". Available: ${available.length > 0 ? available.join(", ") : "(none)"}`);
  }
  const inputs = definition.inputs ?? {};
  const errors = validateInputs(workflow.inputs, inputs);
  if (errors.length > 0) {
    throw new Error(formatWorkflowValidationFailure(workflow.name, workflow.inputs, errors));
  }
  const result = await run(workflow, inputs, runOptions);
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

function formatWorkflowValidationFailure(
  workflowName: string,
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  errors: ValidationError[],
): string {
  const entries = Object.entries(schema).map(([name, definition]) => ({
    name,
    type: definition.type,
    description: definition.description,
    required: definition.required,
    default: "default" in definition ? definition.default : undefined,
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

export async function runWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowOptions = {},
): Promise<WorkflowDetails> {
  const runOptions = runOptionsWithAdapters(options);
  return runNamedWorkflow(definition, options, runOptions);
}
