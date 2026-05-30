/**
 * Programmatic workflow runner.
 *
 * This helper executes named workflows and direct workflow task definitions
 * from an explicit object that mirrors the workflow tool surface.
 */

import { homedir } from "node:os";
import { run, runChain, runParallel, runTask, type RunOpts as ExecutorRunOptions } from "../foreground/executor.js";
import { buildRuntimeAdapters, type RuntimeAdapterBuildOptions, type RuntimeWiringSurface } from "../../extension/wiring.js";
import { discoverWorkflows } from "../../extension/discovery.js";
import { formatWorkflowImportDiagnostics, validateWorkflowImportGraph } from "../../workflows/import-resolver.js";
import { createStore } from "../../shared/store.js";
import { renderInputsSchema } from "../../shared/render-inputs-schema.js";
import { validateInputs, type ValidationError } from "./validate-inputs.js";
import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type { StageSessionRuntime } from "../foreground/stage-runner.js";
import type {
  StageOptions,
  WorkflowChainStep,
  WorkflowDetails,
  WorkflowDetailsStatus,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowInputSchema,
  WorkflowMaxOutput,
  WorkflowOutputMode,
} from "../../shared/types.js";

export interface WorkflowDefinition extends StageOptions {
  mode?: "workflow" | "named" | "single" | "parallel" | "chain";
  workflow?: string;
  inputs?: Record<string, unknown>;
  /** Direct single-task mode, or root task text for direct chain/parallel execution. */
  task?: WorkflowDirectTaskItem | string;
  /** Direct top-level parallel mode. */
  tasks?: readonly WorkflowDirectTaskItem[];
  /** Direct sequential/parallel chain mode. */
  chain?: readonly WorkflowChainStep[];
  chainName?: string;
  concurrency?: number;
  failFast?: boolean;
  /** Chain-only shared artifact directory for relative reads, outputs, and worktree diffs. */
  chainDir?: string;
  reads?: readonly string[] | false;
  output?: string | false;
  outputMode?: WorkflowOutputMode;
  worktree?: boolean;
  gitWorktreeDir?: string;
  baseBranch?: string;
  maxOutput?: WorkflowMaxOutput;
  artifacts?: boolean;
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

function runOptionsWithAdapters(
  options: WorkflowOptions,
  definition?: WorkflowDefinition,
): ExecutorRunOptions {
  const adapterOptions = options.stubAgent === true
    ? {
        ...options.adapterOptions,
        createAgentSession: options.adapterOptions?.createAgentSession ?? createStubAgentSession,
      }
    : options.adapterOptions;

  const argConcurrency =
    typeof definition?.concurrency === "number" && Number.isFinite(definition.concurrency)
      ? Math.max(1, Math.floor(definition.concurrency))
      : undefined;
  const config = argConcurrency === undefined
    ? options.runOptions?.config
    : {
        maxDepth: options.runOptions?.config?.maxDepth ?? 4,
        defaultConcurrency: argConcurrency,
        persistRuns: options.runOptions?.config?.persistRuns ?? true,
        statusFile: options.runOptions?.config?.statusFile ?? false,
        ...(options.runOptions?.config?.statusFilePath !== undefined
          ? { statusFilePath: options.runOptions.config.statusFilePath }
          : {}),
        resumeInFlight: options.runOptions?.config?.resumeInFlight ?? ("ask" as const),
      };

  return {
    ...options.runOptions,
    cwd: options.cwd ?? options.runOptions?.cwd,
    ...(config !== undefined ? { config } : {}),
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

function withoutUndefinedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

function directOptions(definition: WorkflowDefinition): WorkflowDirectOptions {
  const {
    mode: _mode,
    workflow: _workflow,
    inputs: _inputs,
    task,
    tasks: _tasks,
    chain: _chain,
    chainName,
    concurrency,
    failFast,
    chainDir,
    reads,
    output,
    outputMode,
    worktree,
    gitWorktreeDir,
    baseBranch,
    maxOutput,
    artifacts,
    ...stageOptions
  } = definition;

  return {
    ...withoutUndefinedProperties(stageOptions),
    ...(typeof task === "string" ? { task } : {}),
    ...(typeof chainName === "string" ? { chainName } : {}),
    ...(typeof concurrency === "number" ? { concurrency } : {}),
    ...(typeof failFast === "boolean" ? { failFast } : {}),
    ...(typeof chainDir === "string" ? { chainDir } : {}),
    ...(reads !== undefined ? { reads } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(outputMode !== undefined ? { outputMode } : {}),
    ...(typeof worktree === "boolean" ? { worktree } : {}),
    ...(typeof gitWorktreeDir === "string" ? { gitWorktreeDir } : {}),
    ...(typeof baseBranch === "string" ? { baseBranch } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(typeof artifacts === "boolean" ? { artifacts } : {}),
  };
}

function hasDirectExecutionMode(definition: WorkflowDefinition): boolean {
  return (
    definition.mode === "single" ||
    definition.mode === "parallel" ||
    definition.mode === "chain" ||
    (definition.task !== undefined && typeof definition.task === "object") ||
    Array.isArray(definition.tasks) ||
    Array.isArray(definition.chain)
  );
}

async function runNamedWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowOptions,
  runOptions: ExecutorRunOptions,
): Promise<WorkflowDetails> {
  const workflowName = definition.workflow;
  if (typeof workflowName !== "string" || workflowName.length === 0) {
    throw new Error('Workflow definition must include "workflow" for named workflow execution.');
  }
  const discovery = await discoverWorkflows({
    cwd: options.cwd ?? process.cwd(),
    homeDir: options.homeDir ?? homedir(),
  });
  const workflow = discovery.registry.get(workflowName);
  if (workflow === undefined) {
    const available = discovery.registry.names();
    throw new Error(`Workflow not found: "${workflowName}". Available: ${available.length > 0 ? available.join(", ") : "(none)"}`);
  }
  const inputs = definition.inputs ?? {};
  const errors = validateInputs(workflow.inputs, inputs);
  if (errors.length > 0) {
    throw new Error(formatWorkflowValidationFailure(workflow.name, workflow.inputs, errors));
  }
  const importDiagnostics = validateWorkflowImportGraph({
    registry: discovery.registry,
    cwd: options.cwd ?? process.cwd(),
    sources: discovery.sources,
    roots: [workflow],
  });
  if (importDiagnostics.length > 0) {
    throw new Error(`Invalid workflow imports for "${workflow.name}":\n${formatWorkflowImportDiagnostics(importDiagnostics)}`);
  }
  const result = await run(workflow, inputs, {
    ...runOptions,
    registry: discovery.registry,
    workflowSources: discovery.sources,
  });
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

async function runDirectWorkflow(
  definition: WorkflowDefinition,
  runOptions: ExecutorRunOptions,
): Promise<WorkflowDetails> {
  const options = directOptions(definition);

  if (Array.isArray(definition.chain) || definition.mode === "chain") {
    if (!Array.isArray(definition.chain)) {
      throw new Error('Direct chain workflow definitions must include "chain".');
    }
    return runChain(definition.chain, options, runOptions);
  }

  if (Array.isArray(definition.tasks) || definition.mode === "parallel") {
    if (!Array.isArray(definition.tasks)) {
      throw new Error('Direct parallel workflow definitions must include "tasks".');
    }
    return runParallel(definition.tasks, options, runOptions);
  }

  if (typeof definition.task === "object") {
    return runTask(definition.task, options, runOptions);
  }

  if (typeof definition.task === "string" && definition.mode === "single") {
    return runTask({ name: "task", task: definition.task }, options, runOptions);
  }

  throw new Error('Direct workflow definitions must include "task", "tasks", or "chain".');
}

export async function runWorkflow(
  definition: WorkflowDefinition,
  options: WorkflowOptions = {},
): Promise<WorkflowDetails> {
  const runOptions = runOptionsWithAdapters(options, definition);
  return hasDirectExecutionMode(definition)
    ? runDirectWorkflow(definition, runOptions)
    : runNamedWorkflow(definition, options, runOptions);
}
