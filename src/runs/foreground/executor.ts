/**
 * Main DAG executor: run(def, inputs, opts) → RunResult
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type {
  WorkflowDefinition,
  WorkflowRunContext,
  WorkflowUIContext,
  WorkflowUIAdapter,
  WorkflowInputSchema,
  StageContext,
  StageOptions,
  WorkflowTaskContextInput,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
  WorkflowArtifact,
  WorkflowMaxOutput,
  WorkflowChainOptions,
  WorkflowParallelOptions,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowChainStep,
  WorkflowMcpPort,
  WorkflowPersistencePort,
  WorkflowRuntimeConfig,
} from "../../shared/types.js";
import type { InternalStageContext, StageAdapters } from "./stage-runner.js";
import type { RunStatus, StageNotice, StageSnapshot, RunSnapshot, WorkflowOverlayAdapter } from "../../shared/store-types.js";
import type { StageControlHandle, StageControlRegistry, AgentSessionEventListener } from "./stage-control-registry.js";
import type { Store } from "../../shared/store.js";
import type { CancellationRegistry } from "../background/cancellation-registry.js";
import { createStageContext } from "./stage-runner.js";
import { GraphFrontierTracker } from "../shared/graph-inference.js";
import { stageControlRegistry as defaultStageControlRegistry } from "./stage-control-registry.js";
import { createRunLimiter } from "../shared/concurrency.js";
import {
  cleanupWorktrees,
  createWorktrees,
  diffWorktrees,
  findWorktreeTaskCwdConflict,
  formatWorktreeDiffSummary,
  formatWorktreeTaskCwdConflict,
  type WorktreeSetup,
} from "../shared/worktree.js";
import { store as defaultStore } from "../../shared/store.js";
import {
  appendRunStart,
  appendStageStart,
  appendStageEnd,
  appendRunEnd,
} from "../../shared/persistence-session-entries.js";

export interface ResolvedInputs extends Record<string, unknown> {}

export interface RunOpts {
  adapters?: StageAdapters;
  /** HIL adapter injected by the pi runtime or test harness. */
  ui?: WorkflowUIAdapter;
  /** Store override (for testing; defaults to singleton store) */
  store?: Store;
  /** Persistence port for writing session entries (run.start, stage.start, etc.). */
  persistence?: WorkflowPersistencePort;
  /** MCP scope-gating port; forwards per-stage allow/deny to the MCP adapter. */
  mcp?: WorkflowMcpPort;
  /** Cancellation registry; the executor registers an ActiveRunController per run. */
  cancellation?: CancellationRegistry;
  /** Overlay adapter for displaying run progress in the UI layer. */
  overlay?: WorkflowOverlayAdapter;
  /** AbortSignal that requests cancellation from the caller side. */
  signal?: AbortSignal;
  /**
   * Resolved runtime configuration. Injected by the composition root after
   * merging file config with defaults. Downstream tasks (maxDepth, concurrency,
   * status writer) consume this; values are threaded here but not yet acted on.
   */
  config?: WorkflowRuntimeConfig;
  /**
   * Current nesting depth of this workflow run. Starts at 0 for top-level runs.
   * Callers that spawn nested runs must increment this by 1 before passing to
   * run()/runDetached() so the maxDepth guard can reject runs that exceed the
   * configured limit.
   */
  depth?: number;
  /**
   * Live stage-control registry. The executor registers a handle per
   * stage so attached panes can lazily prompt/steer/pause/resume the
   * underlying Pi session without going through the JSON snapshot.
   * Defaults to the process-wide singleton registered alongside the
   * default store.
   */
  stageControlRegistry?: StageControlRegistry;
  /**
   * Pre-allocated runId. When provided, the executor uses this ID instead of
   * generating a new UUID. The detached runner uses this seam to preallocate
   * the runId before starting the background promise.
   */
  runId?: string;
  onRunStart?: (snapshot: RunSnapshot) => void;
  onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  onStageEnd?: (runId: string, snapshot: StageSnapshot) => void;
  onRunEnd?: (runId: string, status: RunStatus, result?: Record<string, unknown>, error?: string) => void;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: Record<string, unknown>;
  readonly error?: string;
  readonly stages: StageSnapshot[];
}

// ---------------------------------------------------------------------------
// Input resolution / validation
// ---------------------------------------------------------------------------

export function resolveInputs(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  provided: Record<string, unknown>,
): ResolvedInputs {
  const resolved: Record<string, unknown> = { ...provided };

  for (const [key, schemaDef] of Object.entries(schema)) {
    if (resolved[key] === undefined && "default" in schemaDef && schemaDef.default !== undefined) {
      resolved[key] = schemaDef.default;
    }
  }

  for (const [key, schemaDef] of Object.entries(schema)) {
    if (schemaDef.required === true && resolved[key] === undefined) {
      throw new TypeError(`pi-workflows: required input "${key}" not provided`);
    }
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// HIL unavailable fallback — rejects with precise per-primitive error
// ---------------------------------------------------------------------------

function makeUnavailableUIContext(): WorkflowUIContext {
  const msg = (primitive: string): string =>
    `pi-workflows: HIL ctx.ui.${primitive} is unavailable because pi runtime did not provide a UI adapter`;
  return {
    input: () => Promise.reject(new Error(msg("input"))),
    confirm: () => Promise.reject(new Error(msg("confirm"))),
    select: () => Promise.reject(new Error(msg("select"))),
    editor: () => Promise.reject(new Error(msg("editor"))),
  };
}

type AskUserQuestionToolEvent =
  | { phase: "start"; callId: string }
  | { phase: "end"; callId: string; nameMatched: boolean };

function stringField(value: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function isAskUserQuestionToolName(name: string | undefined): boolean {
  if (name === undefined) return false;
  return name.toLowerCase().replace(/[^a-z0-9]/g, "") === "askuserquestion";
}

function askUserQuestionToolEvent(event: unknown): AskUserQuestionToolEvent | undefined {
  if (event === null || typeof event !== "object") return undefined;
  const record = event as Record<string, unknown>;
  const type = typeof record["type"] === "string" ? record["type"] : "";
  const toolName = stringField(record, ["toolName", "tool_name", "name"]);
  const callId = stringField(record, ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id"]) ?? "__ask_user_question__";

  if (type === "tool_execution_start" && isAskUserQuestionToolName(toolName)) {
    return { phase: "start", callId };
  }
  if (type === "tool_execution_end" || type === "tool_execution_error" || type === "tool_result") {
    return { phase: "end", callId, nameMatched: isAskUserQuestionToolName(toolName) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// raceAbort — races a promise against an AbortSignal
// ---------------------------------------------------------------------------

function normalizeTaskContexts(
  previous: WorkflowTaskOptions["previous"],
): Array<{ readonly name?: string; readonly text: string }> {
  if (previous === undefined) return [];
  const items = Array.isArray(previous) ? previous : [previous];
  return items
    .map((item: WorkflowTaskContextInput) => {
      if (typeof item === "string") return { text: item };
      return item.name ? { name: item.name, text: item.text } : { text: item.text };
    })
    .filter((item) => item.text.trim().length > 0);
}

function renderTaskContext(contexts: readonly { readonly name?: string; readonly text: string }[]): string {
  if (contexts.length === 0) return "";
  if (contexts.length === 1 && contexts[0]?.name === undefined) return contexts[0]!.text;
  return contexts
    .map((context, index) => {
      const label = context.name ?? `context-${index + 1}`;
      return `--- ${label} ---\n${context.text}`;
    })
    .join("\n\n");
}

function applyTaskContext(prompt: string, previous: WorkflowTaskOptions["previous"]): string {
  const contexts = normalizeTaskContexts(previous);
  if (contexts.length === 0) return prompt;

  const lastPrevious = contexts[contexts.length - 1]?.text ?? "";
  const rendered = renderTaskContext(contexts);
  let next = prompt.replace(/\{previous\}/g, lastPrevious);

  if (next !== prompt) return next;
  next += `\n\n---\nContext:\n${rendered}`;
  return next;
}

function taskPrompt(options: WorkflowTaskOptions): string {
  const prompt = options.prompt ?? options.task;
  if (prompt === undefined) {
    throw new Error("pi-workflows: ctx.task requires options.prompt or options.task");
  }
  return prompt;
}

function taskPrevious(options: WorkflowTaskOptions): WorkflowTaskOptions["previous"] {
  return options.previous;
}

function taskStageOptions(options: WorkflowTaskOptions): StageOptions {
  const {
    prompt: _prompt,
    task: _task,
    previous: _previous,
    output: _output,
    outputMode: _outputMode,
    reads: _reads,
    progress: _progress,
    worktree: _worktree,
    maxOutput: _maxOutput,
    artifacts: _artifacts,
    ...stageOptions
  } = options;
  return stageOptions;
}

function taskOptionsFromStep(step: WorkflowTaskStep, prompt: string, previous?: WorkflowTaskOptions["previous"]): WorkflowTaskOptions {
  const {
    name: _name,
    prompt: _prompt,
    task: _task,
    previous: _previous,
    output: _output,
    outputMode: _outputMode,
    reads: _reads,
    progress: _progress,
    worktree: _worktree,
    ...stageOptions
  } = step;
  return previous === undefined
    ? { ...stageOptions, prompt }
    : { ...stageOptions, prompt, previous };
}

function replaceTaskPlaceholder(prompt: string, task: string): string {
  return prompt.replace(/\{task\}/g, task);
}

function chainStepPrompt(step: WorkflowTaskStep, index: number): string {
  return step.prompt ?? step.task ?? (index === 0 ? "{task}" : "{previous}");
}

function parallelFallbackTask(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): string {
  if (options?.task !== undefined) return options.task;
  for (const step of steps) {
    const task = step.prompt ?? step.task;
    if (task !== undefined) return task;
  }
  return "";
}

function directTaskPrompt(item: WorkflowDirectTaskItem): string | undefined {
  return item.prompt ?? item.task;
}

const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024;
const DEFAULT_MAX_OUTPUT_LINES = 5000;

function normalizeMaxOutput(maxOutput: WorkflowMaxOutput | undefined): Required<WorkflowMaxOutput> {
  return {
    bytes: maxOutput?.bytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    lines: maxOutput?.lines ?? DEFAULT_MAX_OUTPUT_LINES,
  };
}

function truncateByLines(text: string, maxLines: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return { text: "", truncated: text.length > 0 };
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return { text, truncated: false };
  return {
    text: lines.slice(0, maxLines).join("\n"),
    truncated: true,
  };
}

function truncateByBytes(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return { text: "", truncated: text.length > 0 };
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return { text, truncated: false };

  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  return { text: text.slice(0, low), truncated: true };
}

function truncateTaskOutput(text: string, maxOutput: WorkflowMaxOutput | undefined): string {
  const limits = normalizeMaxOutput(maxOutput);
  const byLines = truncateByLines(text, limits.lines);
  const byBytes = truncateByBytes(byLines.text, limits.bytes);
  if (!byLines.truncated && !byBytes.truncated) return text;
  return `${byBytes.text}\n\n[workflow output truncated; limits: ${limits.bytes} bytes, ${limits.lines} lines]`;
}

function directTaskWithDefaults(
  item: WorkflowDirectTaskItem,
  options: WorkflowDirectOptions,
): WorkflowDirectTaskItem {
  return {
    ...item,
    ...(item.context === undefined && options.context !== undefined ? { context: options.context } : {}),
    ...(item.forkFromSessionFile === undefined && options.forkFromSessionFile !== undefined ? { forkFromSessionFile: options.forkFromSessionFile } : {}),
    ...(item.cwd === undefined && options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(item.output === undefined && options.output !== undefined ? { output: options.output } : {}),
    ...(item.outputMode === undefined && options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(item.maxOutput === undefined && options.maxOutput !== undefined ? { maxOutput: options.maxOutput } : {}),
    ...(item.artifacts === undefined && options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(item.sessionDir === undefined && options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
  };
}

function directTaskToStep(
  item: WorkflowDirectTaskItem,
  fallbackPrompt?: string,
  previous?: WorkflowTaskOptions["previous"],
): WorkflowTaskStep {
  const {
    count: _count,
    output: _output,
    outputMode: _outputMode,
    reads: _reads,
    progress: _progress,
    worktree: _worktree,
    prompt,
    task,
    previous: itemPrevious,
    ...stageOptions
  } = item;
  return {
    ...stageOptions,
    prompt: prompt ?? task ?? fallbackPrompt,
    previous: previous ?? itemPrevious,
  };
}

function expandedParallelTasks(tasks: readonly WorkflowDirectTaskItem[]): WorkflowDirectTaskItem[] {
  const expanded: WorkflowDirectTaskItem[] = [];
  for (const task of tasks) {
    const count = task.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`pi-workflows: direct task "${task.name}" count must be a positive integer`);
    }
    for (let index = 0; index < count; index += 1) {
      expanded.push(count === 1 ? task : {
        ...task,
        name: `${task.name}-${index + 1}`,
        count: undefined,
        output: namespaceRepeatedOutput(task.output, index),
      });
    }
  }
  return expanded;
}

function namespaceRepeatedOutput(output: WorkflowDirectTaskItem["output"], index: number): WorkflowDirectTaskItem["output"] {
  if (typeof output !== "string") return output;
  const ext = extname(output);
  const base = basename(output, ext);
  return join(dirname(output), `${base}-${index + 1}${ext}`);
}

interface PreparedDirectWorktrees {
  readonly tasks: WorkflowDirectTaskItem[];
  readonly setup?: WorktreeSetup;
  readonly agents: string[];
  readonly diffsDir?: string;
}

function directRunId(runOptions: RunOpts): string {
  return runOptions.runId ?? crypto.randomUUID();
}

function hasDirectWorktreeIsolation(tasks: readonly WorkflowDirectTaskItem[], options: WorkflowDirectOptions): boolean {
  return options.worktree === true || tasks.some((task) => task.worktree === true);
}

function resolveSharedDirectWorktreeCwd(tasks: readonly WorkflowDirectTaskItem[]): string {
  const explicitCwd = tasks.find((task) => typeof task.cwd === "string")?.cwd;
  if (explicitCwd === undefined) return process.cwd();
  return isAbsolute(explicitCwd) ? explicitCwd : resolve(process.cwd(), explicitCwd);
}

function normalizeDirectTaskCwd(cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined;
  return isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd);
}

function directWorktreeDiffsDir(options: WorkflowDirectOptions, setup: WorktreeSetup, runId: string, scope: string): string {
  const baseDir = options.chainDir ?? join(setup.cwd, ".pi", "workflows");
  return join(baseDir, "worktree-diffs", runId, scope);
}

function prepareDirectWorktrees(
  tasks: readonly WorkflowDirectTaskItem[],
  options: WorkflowDirectOptions,
  runId: string,
  scope: string,
): PreparedDirectWorktrees {
  if (!hasDirectWorktreeIsolation(tasks, options)) {
    return {
      tasks: [...tasks],
      agents: tasks.map((task) => task.name),
    };
  }

  const sharedCwd = resolveSharedDirectWorktreeCwd(tasks);
  const conflict = findWorktreeTaskCwdConflict(
    tasks.map((task) => ({ agent: task.name, cwd: normalizeDirectTaskCwd(task.cwd) })),
    sharedCwd,
  );
  if (conflict !== undefined) {
    throw new Error(formatWorktreeTaskCwdConflict(conflict, sharedCwd));
  }

  const agents = tasks.map((task) => task.name);
  const setup = createWorktrees(sharedCwd, runId, tasks.length, { agents });
  return {
    tasks: tasks.map((task, index) => ({
      ...task,
      cwd: setup.worktrees[index]!.agentCwd,
    })),
    setup,
    agents,
    diffsDir: directWorktreeDiffsDir(options, setup, runId, scope),
  };
}

function collectWorktreeDiffs(prepared: PreparedDirectWorktrees, enabled = true): {
  artifacts: WorkflowArtifact[];
  summary?: string;
} {
  if (!enabled || prepared.setup === undefined || prepared.diffsDir === undefined) {
    return { artifacts: [] };
  }

  const diffs = diffWorktrees(prepared.setup, prepared.agents, prepared.diffsDir);
  const artifacts = diffs.map((diff) => ({
    kind: "diff" as const,
    path: diff.patchPath,
    taskName: diff.agent,
    branch: diff.branch,
    diffStat: diff.diffStat,
    filesChanged: diff.filesChanged,
    insertions: diff.insertions,
    deletions: diff.deletions,
  }));
  const summary = formatWorktreeDiffSummary(diffs);
  return {
    artifacts,
    ...(summary.length > 0 ? { summary } : {}),
  };
}

function isRunOpts(value: WorkflowDirectOptions | RunOpts | undefined): value is RunOpts {
  if (value === undefined) return false;
  return (
    "adapters" in value ||
    "ui" in value ||
    "store" in value ||
    "persistence" in value ||
    "mcp" in value ||
    "cancellation" in value ||
    "overlay" in value ||
    "signal" in value ||
    "config" in value ||
    "depth" in value ||
    "stageControlRegistry" in value ||
    "runId" in value ||
    "onRunStart" in value ||
    "onStageStart" in value ||
    "onStageEnd" in value ||
    "onRunEnd" in value
  );
}

async function writeDirectOutput(
  item: Pick<WorkflowDirectTaskItem, "output" | "outputMode">,
  result: WorkflowTaskResult,
): Promise<{ result: WorkflowTaskResult; artifact?: WorkflowArtifact }> {
  if (typeof item.output !== "string") return { result };

  await mkdir(dirname(item.output), { recursive: true });
  await writeFile(item.output, result.text, "utf8");

  const visibleResult =
    item.outputMode === "file-only"
      ? { ...result, text: "" }
      : result;

  return {
    result: visibleResult,
    artifact: {
      kind: "output",
      path: item.output,
      taskName: result.name,
    },
  };
}

function workflowDetailsFromRun(
  mode: WorkflowDetails["mode"],
  runResult: RunResult,
  results: readonly WorkflowTaskResult[],
  options: WorkflowDirectOptions = {},
): WorkflowDetails {
  const sessionArtifacts = options.artifacts === false ? [] : results.flatMap((result) =>
    result.sessionFile === undefined
      ? []
      : [{ kind: "session" as const, path: result.sessionFile, taskName: result.name }],
  );
  const outputArtifacts = Array.isArray(runResult.result?.["artifacts"])
    ? runResult.result["artifacts"] as WorkflowArtifact[]
    : [];
  const artifacts = [...outputArtifacts, ...sessionArtifacts];
  return {
    mode,
    action: "run",
    runId: runResult.runId,
    status: runResult.status === "killed" ? "killed" : runResult.status === "failed" ? "failed" : "completed",
    ...(options.context !== undefined ? { context: options.context } : {}),
    results: [...results],
    output: runResult.result,
    progress: { completed: results.length, total: results.length },
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(runResult.error !== undefined ? { error: runResult.error } : {}),
  };
}

function defineDirectWorkflow(
  name: string,
  runFn: WorkflowDefinition["run"],
): WorkflowDefinition {
  return Object.freeze({
    __piWorkflow: true,
    name,
    normalizedName: name,
    description: "Direct workflow execution",
    inputs: Object.freeze({}),
    run: runFn,
  });
}

/**
 * SDK helper for direct single-task execution. It synthesizes an ephemeral
 * workflow and reuses the normal executor so store snapshots, cancellation,
 * persistence, and stage session behavior stay on the same runtime path.
 */
export function runTask(
  task: WorkflowDirectTaskItem,
  runOptions?: RunOpts,
): Promise<WorkflowDetails>;
export function runTask(
  task: WorkflowDirectTaskItem,
  options?: WorkflowDirectOptions,
  runOptions?: RunOpts,
): Promise<WorkflowDetails>;
export async function runTask(
  task: WorkflowDirectTaskItem,
  optionsOrRunOptions: WorkflowDirectOptions | RunOpts = {},
  maybeRunOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const options = isRunOpts(optionsOrRunOptions) ? {} : optionsOrRunOptions;
  const runOptions = isRunOpts(optionsOrRunOptions) ? optionsOrRunOptions : maybeRunOptions;
  const runId = directRunId(runOptions);
  const prepared = prepareDirectWorktrees([directTaskWithDefaults(task, options)], options, runId, "single");
  const preparedTask = prepared.tasks[0]!;
  const direct = defineDirectWorkflow("direct-task", async (ctx) => {
    try {
      const rawResult = await ctx.task(preparedTask.name, directTaskToStep(preparedTask));
      const { result, artifact } = await writeDirectOutput(preparedTask, rawResult);
      const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
      return {
        results: [result],
        text: result.text,
        artifacts: [
          ...worktreeDiffs.artifacts,
          ...(artifact === undefined ? [] : [artifact]),
        ],
        ...(worktreeDiffs.summary === undefined ? {} : { worktreeSummary: worktreeDiffs.summary }),
      };
    } finally {
      if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
    }
  });
  const runResult = await run(direct, {}, { ...runOptions, runId });
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("single", runResult, results, options);
}

/** SDK helper for direct top-level parallel task execution. */
export async function runParallel(
  tasks: readonly WorkflowDirectTaskItem[],
  options: WorkflowDirectOptions = {},
  runOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const expanded = expandedParallelTasks(tasks.map((task) => directTaskWithDefaults(task, options)));
  const runId = directRunId(runOptions);
  const prepared = prepareDirectWorktrees(expanded, options, runId, "parallel");
  const direct = defineDirectWorkflow("direct-parallel", async (ctx) => {
    try {
      const steps = prepared.tasks.map((task) => directTaskToStep(task));
      const rawResults = await ctx.parallel(steps, { task: options.task });
      const persisted = await Promise.all(
        rawResults.map((result, index) => writeDirectOutput(prepared.tasks[index]!, result)),
      );
      const results = persisted.map((item) => item.result);
      const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
      const artifacts = [
        ...worktreeDiffs.artifacts,
        ...persisted.flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
      ];
      return {
        results,
        count: results.length,
        artifacts,
        ...(worktreeDiffs.summary === undefined ? {} : { worktreeSummary: worktreeDiffs.summary }),
      };
    } finally {
      if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
    }
  });
  const runResult = await run(direct, {}, { ...runOptions, runId });
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("parallel", runResult, results, options);
}

async function runDirectChainStep(
  ctx: WorkflowRunContext,
  step: WorkflowChainStep,
  index: number,
  rootTask: string,
  prior: WorkflowTaskResult | readonly WorkflowTaskResult[] | undefined,
  options: WorkflowDirectOptions,
  runId: string,
): Promise<{ results: WorkflowTaskResult[]; artifacts: WorkflowArtifact[] }> {
  if ("parallel" in step) {
    const expanded = expandedParallelTasks(step.parallel.map((item) => directTaskWithDefaults(item, options)));
    const stepOptions = { ...options, worktree: options.worktree === true || step.worktree === true };
    const prepared = prepareDirectWorktrees(expanded, stepOptions, `${runId}-s${index}`, `step-${index}`);
    try {
      const steps = prepared.tasks.map((item) =>
        directTaskToStep(item, directTaskPrompt(item) ?? "{previous}", item.previous ?? prior),
      );
      const rawResults = await ctx.parallel(steps, { task: rootTask });
      const persisted = await Promise.all(
        rawResults.map((result, taskIndex) => writeDirectOutput(prepared.tasks[taskIndex]!, result)),
      );
      const worktreeDiffs = collectWorktreeDiffs(prepared, stepOptions.artifacts !== false);
      return {
        results: persisted.map((item) => item.result),
        artifacts: [
          ...worktreeDiffs.artifacts,
          ...persisted.flatMap((item) => item.artifact === undefined ? [] : [item.artifact]),
        ],
      };
    } finally {
      if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
    }
  }

  const prompt = directTaskPrompt(step) ?? (index === 0 ? "{task}" : "{previous}");
  const prepared = prepareDirectWorktrees([directTaskWithDefaults(step, options)], options, `${runId}-s${index}`, `step-${index}`);
  const preparedStep = prepared.tasks[0]!;
  try {
    const rawResult = await ctx.task(
      preparedStep.name,
      directTaskToStep(preparedStep, replaceTaskPlaceholder(prompt, rootTask), preparedStep.previous ?? prior),
    );
    const { result, artifact } = await writeDirectOutput(preparedStep, rawResult);
    const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
    return {
      results: [result],
      artifacts: [
        ...worktreeDiffs.artifacts,
        ...(artifact === undefined ? [] : [artifact]),
      ],
    };
  } finally {
    if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
  }
}

/** SDK helper for direct sequential/parallel chain execution. */
export async function runChain(
  chain: readonly WorkflowChainStep[],
  options: WorkflowDirectOptions = {},
  runOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const runId = directRunId(runOptions);
  const direct = defineDirectWorkflow("direct-chain", async (ctx) => {
    const results: WorkflowTaskResult[] = [];
    const artifacts: WorkflowArtifact[] = [];
    let prior: WorkflowTaskResult | readonly WorkflowTaskResult[] | undefined;
    for (let index = 0; index < chain.length; index += 1) {
      const step = await runDirectChainStep(ctx, chain[index]!, index, options.task ?? "", prior, options, runId);
      results.push(...step.results);
      artifacts.push(...step.artifacts);
      prior = step.results.length === 1 ? step.results[0] : step.results;
    }
    return { results, count: results.length, artifacts };
  });
  const runResult = await run(direct, {}, { ...runOptions, runId });
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("chain", runResult, results, options);
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("workflow killed", "AbortError"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason ?? new DOMException("workflow killed", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (val) => { signal.removeEventListener("abort", onAbort); resolve(val); },
      (err: unknown) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
  });
}

function appendRunEndWhenRecorded(
  persistence: WorkflowPersistencePort | undefined,
  recorded: boolean,
  payload: {
    readonly runId: string;
    readonly status: RunStatus;
    readonly result?: Record<string, unknown>;
    readonly ts: number;
  },
): void {
  if (!persistence || !recorded) return;
  appendRunEnd(persistence, payload);
}

// ---------------------------------------------------------------------------
// Shared killed finalizer — used for catch-abort and post-body abort check
// ---------------------------------------------------------------------------

function finalizeKilled(
  runId: string,
  runSnapshot: RunSnapshot,
  activeStore: Store,
  persistence: WorkflowPersistencePort | undefined,
  onRunEnd: RunOpts["onRunEnd"],
): RunResult {
  const recorded = activeStore.recordRunEnd(runId, "killed", undefined, "workflow killed");
  onRunEnd?.(runId, "killed", undefined, "workflow killed");
  appendRunEndWhenRecorded(persistence, recorded, {
    runId,
    status: "killed",
    ts: Date.now(),
  });
  return {
    runId,
    status: "killed",
    error: "workflow killed",
    stages: [...runSnapshot.stages],
  };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

export async function run(
  def: WorkflowDefinition,
  inputs: Record<string, unknown>,
  opts: RunOpts = {},
): Promise<RunResult> {
  const activeStore = opts.store ?? defaultStore;
  const adapters = opts.adapters ?? {};

  // 0. maxDepth guard — reject before any store/persistence side effects.
  const depth = opts.depth ?? 0;
  const maxDepth = opts.config?.maxDepth ?? 4;
  if (depth >= maxDepth) {
    const max = maxDepth;
    return {
      runId: opts.runId ?? crypto.randomUUID(),
      status: "failed",
      error: `pi-workflows: maxDepth exceeded (max ${max})`,
      stages: [],
    };
  }

  // 1. Resolve + validate inputs
  const resolvedInputs = resolveInputs(def.inputs, inputs);

  // 2. Generate runId (or use pre-allocated seam from caller)
  const runId = opts.runId ?? crypto.randomUUID();

  // 2a. Create own AbortController; forward caller signal if provided
  const ownController = new AbortController();
  const callerSignal = opts.signal;
  if (callerSignal) {
    if (callerSignal.aborted) {
      ownController.abort(callerSignal.reason);
    } else {
      callerSignal.addEventListener("abort", () => { ownController.abort(callerSignal.reason); }, { once: true });
    }
  }

  // 3. Create RunSnapshot + register
  const runSnapshot: RunSnapshot = {
    id: runId,
    name: def.name,
    inputs: Object.freeze(resolvedInputs),
    status: "running",
    stages: [],
    startedAt: Date.now(),
  };

  activeStore.recordRunStart(runSnapshot);
  // When the caller already has a controller registered (the detached runner
  // pre-registers before calling run() so abort() can hit the run during
  // executor setup), avoid overwriting it. Two registrations for the same
  // runId means `cancellation.abort(runId)` only hits one controller, and
  // listeners on the other never fire — which is exactly the leak that
  // wedges HIL waiters in background runs.
  if (!opts.signal) {
    opts.cancellation?.register(runId, ownController);
  }
  opts.onRunStart?.(runSnapshot);

  // Persistence: append run.start entry
  if (opts.persistence) {
    appendRunStart(opts.persistence, {
      runId,
      name: def.name,
      inputs: resolvedInputs,
      ts: runSnapshot.startedAt,
    });
  }

  // 4. Create GraphFrontierTracker and per-run ConcurrencyLimiter
  const tracker = new GraphFrontierTracker();
  const limiter = createRunLimiter(opts.config?.defaultConcurrency);
  interface ReleaseBarrier {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason?: unknown) => void;
  }
  const releaseBarriers = new Map<string, ReleaseBarrier>();

  const makeReleaseBarrier = (): ReleaseBarrier => {
    const resolver = Promise.withResolvers<void>();
    return { promise: resolver.promise, resolve: resolver.resolve, reject: resolver.reject };
  };

  const isTerminalStage = (stage: StageSnapshot): boolean =>
    stage.status === "completed" || stage.status === "failed";

  const stageById = (stageId: string): StageSnapshot | undefined =>
    runSnapshot.stages.find((stage) => stage.id === stageId);

  const hasAncestor = (stage: StageSnapshot, ancestorId: string): boolean => {
    const queue = [...stage.parentIds];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      if (next === ancestorId) return true;
      seen.add(next);
      queue.push(...tracker.getParents(next));
    }
    return false;
  };

  const descendantsOf = (stageId: string): StageSnapshot[] =>
    runSnapshot.stages.filter((stage) => stage.id !== stageId && hasAncestor(stage, stageId));

  const blockingAncestorFor = (stage: StageSnapshot): string | undefined => {
    const queue = [...stage.parentIds];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const next = queue.shift();
      if (next === undefined || seen.has(next)) continue;
      seen.add(next);
      const ancestor = stageById(next);
      if (ancestor?.status === "paused" || ancestor?.status === "blocked") return next;
      queue.push(...tracker.getParents(next));
    }
    return undefined;
  };

  const ensureReleaseBarrier = (stageId: string): ReleaseBarrier => {
    let barrier = releaseBarriers.get(stageId);
    if (!barrier) {
      barrier = makeReleaseBarrier();
      releaseBarriers.set(stageId, barrier);
    }
    return barrier;
  };

  const blockStageUntilCascadeRelease = (stage: StageSnapshot, blockedBy: string): void => {
    ensureReleaseBarrier(stage.id);
    activeStore.recordStageBlocked(runId, stage.id, blockedBy);
  };

  const releaseStageBarrier = (stageId: string): void => {
    const barrier = releaseBarriers.get(stageId);
    if (!barrier) return;
    releaseBarriers.delete(stageId);
    barrier.resolve();
  };

  const cascadePauseFrom = async (pausedStageId: string): Promise<void> => {
    for (const descendant of descendantsOf(pausedStageId)) {
      if (isTerminalStage(descendant) || descendant.status === "paused" || descendant.status === "blocked") continue;
      if (descendant.status === "running") {
        const descendantHandle = (opts.stageControlRegistry ?? defaultStageControlRegistry).get(runId, descendant.id);
        if (descendantHandle && descendantHandle.status === "running") {
          await descendantHandle.pause();
        }
        continue;
      }
      blockStageUntilCascadeRelease(descendant, pausedStageId);
    }
  };

  const cascadeResumeFrom = (resumedStageId: string): void => {
    for (const descendant of descendantsOf(resumedStageId)) {
      if (isTerminalStage(descendant) || descendant.status !== "blocked") continue;
      if (blockingAncestorFor(descendant) !== undefined) continue;
      if (activeStore.recordStageUnblocked(runId, descendant.id)) {
        releaseStageBarrier(descendant.id);
      }
    }
  };

  const rejectReleaseBarriers = (reason: unknown): void => {
    for (const [stageId, barrier] of releaseBarriers) {
      releaseBarriers.delete(stageId);
      activeStore.recordStageUnblocked(runId, stageId);
      barrier.reject(reason);
    }
  };

  ownController.signal.addEventListener(
    "abort",
    () => rejectReleaseBarriers(ownController.signal.reason ?? new Error("pi-workflows: run aborted")),
    { once: true },
  );

  // 5. Build WorkflowRunContext
  const ctx: WorkflowRunContext = {
    inputs: resolvedInputs,
    ui: opts.ui ?? makeUnavailableUIContext(),

    stage(name: string, options?: StageOptions) {
      // a. Generate stageId
      const stageId = crypto.randomUUID();

      // b. tracker.onSpawn → parentIds
      const parentIds = tracker.onSpawn(stageId, name);

      // c. Create StageSnapshot as "pending"
      const stageSnapshot: StageSnapshot = {
        id: stageId,
        name,
        status: "pending",
        parentIds: Object.freeze(parentIds),
        toolEvents: [],
        // Store mcp scope options on snapshot when provided
        ...(options?.mcp !== undefined
          ? { mcpScope: { allow: options.mcp.allow ?? null, deny: options.mcp.deny ?? null } }
          : {}),
        // Mark attachable up-front: the live stage handle is registered
        // below before the first onStageStart fires, so consumers that
        // hook onStageStart see `attachable: true` for the pending stage.
        attachable: true,
      };

      // d. Create inner AgentSession-like StageContext (raw, without lifecycle wrapping).
      //    Must come before the registry registration because the handle
      //    delegates to it for every operation.
      const innerCtx: InternalStageContext = createStageContext({
        stageId,
        stageName: name,
        adapters,
        runId,
        signal: ownController.signal,
        stageOptions: options,
      });
      const activeAskUserQuestionCalls = new Set<string>();
      const unsubscribeAskUserQuestionWatcher = innerCtx.subscribe((event) => {
        const toolEvent = askUserQuestionToolEvent(event);
        if (!toolEvent) return;
        if (toolEvent.phase === "start") {
          activeAskUserQuestionCalls.add(toolEvent.callId);
          activeStore.recordStageAwaitingInput(runId, stageId, true);
          return;
        }

        if (toolEvent.nameMatched || activeAskUserQuestionCalls.has(toolEvent.callId)) {
          activeAskUserQuestionCalls.delete(toolEvent.callId);
          if (activeAskUserQuestionCalls.size === 0) {
            activeStore.recordStageAwaitingInput(runId, stageId, false);
          }
        }
      });
      const disposeInnerContext = async (): Promise<void> => {
        unsubscribeAskUserQuestionWatcher();
        activeAskUserQuestionCalls.clear();
        activeStore.recordStageAwaitingInput(runId, stageId, false);
        await innerCtx.__dispose();
      };

      // e. Register a live stage-control handle so attached panes can
      //    prompt/steer/pause/resume the underlying Pi session lazily.
      //    Pending stages are attachable from the moment they are spawned;
      //    the chat surface only realises the SDK session when the user
      //    types or the workflow body invokes a tracked call.
      const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
      const handle: StageControlHandle = {
        runId,
        stageId,
        stageName: name,
        get status() {
          return stageSnapshot.status;
        },
        get sessionId() {
          return innerCtx.__sessionMeta().sessionId;
        },
        get sessionFile() {
          return innerCtx.__sessionMeta().sessionFile;
        },
        get isStreaming() {
          return innerCtx.isStreaming;
        },
        get messages() {
          return innerCtx.messages;
        },
        async ensureAttached() {
          await innerCtx.__ensureSession();
          const meta = innerCtx.__sessionMeta();
          if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
            activeStore.recordStageSession(runId, stageId, meta);
          }
        },
        async prompt(text: string) {
          await innerCtx.prompt(text);
          const meta = innerCtx.__sessionMeta();
          if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
            activeStore.recordStageSession(runId, stageId, meta);
          }
        },
        async steer(text: string) {
          await innerCtx.steer(text);
        },
        async followUp(text: string) {
          await innerCtx.followUp(text);
        },
        async pause() {
          const changed = activeStore.recordStagePaused(runId, stageId);
          if (changed) await cascadePauseFrom(stageId);
          await innerCtx.__requestPause();
        },
        async resume(message?: string) {
          const changed = activeStore.recordStageResumed(runId, stageId);
          if (changed) cascadeResumeFrom(stageId);
          await innerCtx.__resume(message);
        },
        subscribe(listener: AgentSessionEventListener) {
          return innerCtx.subscribe(listener);
        },
      };
      const unregisterStageHandle = stageRegistry.register(handle);

      // f. Record stage start in store (as pending), call onStageStart.
      activeStore.recordStageStart(runId, stageSnapshot);
      opts.onStageStart?.(runId, stageSnapshot);
      const blockedBy = blockingAncestorFor(stageSnapshot);
      if (blockedBy !== undefined) {
        blockStageUntilCascadeRelease(stageSnapshot, blockedBy);
      }


      const runTrackedStageCall = async (call: () => Promise<string>): Promise<string> => {
        const barrier = releaseBarriers.get(stageId);
        if (barrier) {
          try {
            await barrier.promise;
          } catch (err) {
            activeStore.recordStageAttachable(runId, stageId, false);
            unregisterStageHandle();
            await disposeInnerContext();
            throw err;
          }
        }

        // Block here until a concurrency slot is available for this run.
        await limiter.acquire();

        stageSnapshot.status = "running";
        stageSnapshot.startedAt = Date.now();
        activeStore.recordStageStart(runId, stageSnapshot);

        // Persistence: append stage.start entry
        if (opts.persistence) {
          appendStageStart(opts.persistence, {
            runId,
            stageId,
            name,
            parentIds: stageSnapshot.parentIds,
            ts: stageSnapshot.startedAt,
          });
        }

        const mcpAllow = options?.mcp?.allow ?? null;
        const mcpDeny = options?.mcp?.deny ?? null;
        const hasMcpScope = mcpAllow !== null || mcpDeny !== null;

        if (opts.mcp && hasMcpScope) {
          opts.mcp.setScope(stageId, mcpAllow, mcpDeny);
        }

        try {
          const abortSession = (): void => {
            void innerCtx.abort().catch(() => {});
          };
          if (ownController.signal.aborted) abortSession();
          else ownController.signal.addEventListener("abort", abortSession, { once: true });
          let result = "";
          try {
            result = await raceAbort(call(), ownController.signal);
          } finally {
            ownController.signal.removeEventListener("abort", abortSession);
          }
          // Capture SDK session metadata into the snapshot so the
          // attached chat surface can reopen the persisted session
          // via SessionManager.open(sessionFile) post-mortem.
          {
            const meta = innerCtx.__sessionMeta();
            if (meta.sessionId !== undefined || meta.sessionFile !== undefined) {
              activeStore.recordStageSession(runId, stageId, meta);
            }
          }
          stageSnapshot.status = "completed";
          const assistantText = innerCtx.__getLastAssistantText();
          if (assistantText !== undefined) {
            stageSnapshot.result = assistantText;
          }
          return result;
        } catch (err) {
          stageSnapshot.status = "failed";
          stageSnapshot.error = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          stageSnapshot.endedAt = Date.now();
          stageSnapshot.durationMs =
            stageSnapshot.startedAt !== undefined
              ? stageSnapshot.endedAt - stageSnapshot.startedAt
              : undefined;

          if (opts.mcp && hasMcpScope) {
            opts.mcp.clearScope(stageId);
          }

          activeStore.recordStageEnd(runId, stageSnapshot);
          opts.onStageEnd?.(runId, stageSnapshot);

          // Persistence: append stage.end entry
          if (opts.persistence) {
            appendStageEnd(opts.persistence, {
              runId,
              stageId,
              status: stageSnapshot.status,
              durationMs: stageSnapshot.durationMs,
            });
          }

          tracker.onSettle(stageId);
          activeStore.recordStageAttachable(runId, stageId, false);
          unregisterStageHandle();
          try {
            await disposeInnerContext();
          } finally {
            limiter.release();
          }
        }
      };

      const noticeValue = (value: unknown): string => {
        if (typeof value === "string") return value;
        if (value === undefined || value === null) return "";
        if (typeof value === "object") {
          const candidate = value as { id?: unknown; name?: unknown; label?: unknown };
          if (typeof candidate.id === "string") return candidate.id;
          if (typeof candidate.name === "string") return candidate.name;
          if (typeof candidate.label === "string") return candidate.label;
        }
        return String(value);
      };

      const recordStageNotice = (notice: Omit<StageNotice, "id" | "ts">): void => {
        activeStore.recordStageNotice(runId, stageId, {
          id: crypto.randomUUID(),
          ts: Date.now(),
          ...notice,
        });
      };

      const compactionMeta = (result: unknown): string | undefined => {
        if (result === undefined || result === null || typeof result !== "object") return undefined;
        const compaction = result as { tokensBefore?: unknown; tokensAfter?: unknown; tokensKept?: unknown };
        const before = typeof compaction.tokensBefore === "number" ? compaction.tokensBefore : undefined;
        const keptRaw = compaction.tokensKept ?? compaction.tokensAfter;
        const kept = typeof keptRaw === "number" ? keptRaw : undefined;
        if (before === undefined || kept === undefined) return undefined;
        return `${(before / 1000).toFixed(1)}k → ${(kept / 1000).toFixed(1)}k`;
      };

      const stageContext: StageContext = {
        name: innerCtx.name,
        prompt: (text, promptOptions) => runTrackedStageCall(() => innerCtx.prompt(text, promptOptions)),
        complete: (text, completeOptions) => runTrackedStageCall(() => innerCtx.complete(text, completeOptions)),
        subagent: (subagentOptions) => runTrackedStageCall(() => innerCtx.subagent(subagentOptions)),
        steer: (text) => innerCtx.steer(text),
        followUp: (text) => innerCtx.followUp(text),
        subscribe: (listener) => innerCtx.subscribe(listener),
        get sessionFile() { return innerCtx.sessionFile; },
        get sessionId() { return innerCtx.sessionId; },
        setModel: async (model) => {
          await innerCtx.__ensureSession();
          recordStageNotice({ kind: "model", from: noticeValue(innerCtx.model), to: noticeValue(model) });
          await innerCtx.setModel(model);
        },
        setThinkingLevel: (level) => {
          recordStageNotice({ kind: "thinking", from: noticeValue(innerCtx.thinkingLevel), to: noticeValue(level) });
          innerCtx.setThinkingLevel(level);
        },
        cycleModel: async () => {
          const from = noticeValue(innerCtx.model);
          const result = await innerCtx.cycleModel();
          recordStageNotice({ kind: "model", from, to: noticeValue(innerCtx.model) });
          return result;
        },
        cycleThinkingLevel: () => {
          const from = noticeValue(innerCtx.thinkingLevel);
          const result = innerCtx.cycleThinkingLevel();
          recordStageNotice({ kind: "thinking", from, to: noticeValue(innerCtx.thinkingLevel) });
          return result;
        },
        get agent() { return innerCtx.agent; },
        get model() { return innerCtx.model; },
        get thinkingLevel() { return innerCtx.thinkingLevel; },
        get messages() { return innerCtx.messages; },
        get isStreaming() { return innerCtx.isStreaming; },
        navigateTree: async (targetId, treeOptions) => {
          recordStageNotice({ kind: "tree", to: targetId });
          return innerCtx.navigateTree(targetId, treeOptions);
        },
        compact: async (customInstructions) => {
          const result = await innerCtx.compact(customInstructions);
          recordStageNotice({ kind: "compaction", to: "summarized", meta: compactionMeta(result) });
          return result;
        },
        abortCompaction: () => innerCtx.abortCompaction(),
        abort: async () => {
          recordStageNotice({ kind: "abort", to: "interrupted" });
          await innerCtx.abort();
        },
      };
      return stageContext;
    },

    async task(name: string, options: WorkflowTaskOptions): Promise<WorkflowTaskResult> {
      const stage = ctx.stage(name, taskStageOptions(options));
      const rawText = await stage.prompt(applyTaskContext(taskPrompt(options), taskPrevious(options)));
      const text = truncateTaskOutput(rawText, options.maxOutput);
      const sessionId = (() => {
        try {
          return stage.sessionId;
        } catch {
          return undefined;
        }
      })();
      return {
        name,
        stageName: name,
        text,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
      };
    },

    async chain(steps: readonly WorkflowTaskStep[], options: WorkflowChainOptions = {}): Promise<WorkflowTaskResult[]> {
      const results: WorkflowTaskResult[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        const explicitPrevious = taskPrevious(step);
        const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
        const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
        results.push(await ctx.task(step.name, taskOptionsFromStep(step, prompt, previous)));
      }
      return results;
    },

    async parallel(steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> {
      const fallback = parallelFallbackTask(steps, options);
      return Promise.all(
        steps.map((step) => {
          const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback);
          return ctx.task(step.name, taskOptionsFromStep(step, prompt, taskPrevious(step)));
        }),
      );
    },
  };

  // 6. Call def.run(ctx)
  try {
    const result = await def.run(ctx);

    // Post-body abort check: if signal was aborted at any point before we record
    // completion, the run must be finalized as "killed", never "completed".
    if (ownController.signal.aborted) {
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const recorded = activeStore.recordRunEnd(runId, "completed", result);
    opts.onRunEnd?.(runId, "completed", result);

    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "completed",
      result,
      ts: Date.now(),
    });

    return {
      runId,
      status: "completed",
      result,
      stages: [...runSnapshot.stages],
    };
  } catch (err) {
    if (ownController.signal.aborted) {
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const errorMessage = err instanceof Error ? err.message : String(err);

    const recorded = activeStore.recordRunEnd(runId, "failed", undefined, errorMessage);
    opts.onRunEnd?.(runId, "failed", undefined, errorMessage);

    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "failed",
      ts: Date.now(),
    });

    return {
      runId,
      status: "failed",
      error: errorMessage,
      stages: [...runSnapshot.stages],
    };
  } finally {
    opts.cancellation?.unregister(runId);
  }
}
