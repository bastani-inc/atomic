/**
 * Main DAG executor: run(def, inputs, opts) → RunResult
 */

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, createAskUserQuestionToolDefinition, isCodexFastModeCandidateModelId } from "@bastani/atomic";
import { stageUiBroker } from "../../shared/stage-ui-broker.js";
import { isBrandedWorkflowDefinition, stampWorkflowDefinition } from "../../workflows/define-workflow.js";
import { buildStagePromptAdapter } from "../../shared/stage-prompt.js";
import type {
  WorkflowDefinition,
  WorkflowRunContext,
  WorkflowUIContext,
  WorkflowUIAdapter,
  WorkflowInputSchema,
  StageContext,
  StageOptions,
  StagePromptOptions,
  WorkflowTaskContextInput,
  WorkflowTaskOptions,
  WorkflowTaskResult,
  WorkflowTaskStep,
  WorkflowArtifact,
  WorkflowMaxOutput,
  WorkflowOutputMode,
  WorkflowChainOptions,
  WorkflowParallelOptions,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowChainStep,
  WorkflowMcpPort,
  WorkflowPersistencePort,
  WorkflowRuntimeConfig,
  WorkflowModelCatalogPort,
  WorkflowExecutionMode,
  WorkflowRunChildOptions,
  WorkflowChildResult,
  WorkflowOutputSchema,
  WorkflowOutputValues,
  WorkflowInputValues,
  WorkflowSerializableValue,
} from "../../shared/types.js";
import type { InternalStageContext, StageAdapters } from "./stage-runner.js";
import type * as AuthoringContract from "../../shared/authoring-contract.js";
import type {
  RunStatus,
  StageNotice,
  StageSnapshot,
  RunSnapshot,
  WorkflowOverlayAdapter,
  WorkflowFailureKind,
  PendingPrompt,
  PromptKind,
  WorkflowChildReplaySnapshot,
  WorkflowChildRunRef,
} from "../../shared/store-types.js";
import type { StageControlHandle, StageControlRegistry, AgentSessionEventListener } from "./stage-control-registry.js";
import type { Store } from "../../shared/store.js";
import type { WorkflowRegistry } from "../../workflows/registry.js";
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
  setupGitWorktree,
  formatWorktreeDiffSummary,
  formatWorktreeTaskCwdConflict,
  type WorktreeSetup,
} from "../shared/worktree.js";
import { store as defaultStore } from "../../shared/store.js";
import { elapsedStageMs } from "../../shared/timing.js";
import {
  appendRunStart,
  appendStageStart,
  appendStageEnd,
  appendRunEnd,
} from "../../shared/persistence-session-entries.js";
import { buildModelCandidatesFromCatalog, validateWorkflowModels, workflowModelId } from "../shared/model-fallback.js";
import { validateInputs, type ValidationError } from "../shared/validate-inputs.js";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { schemaFieldKind, schemaChoices, schemaIsRequired } from "../../shared/schema-introspection.js";
import type { WorkflowFailure } from "../../shared/workflow-failures.js";
import { classifyWorkflowFailure } from "../../shared/workflow-failures.js";
import { selectPromptCallsiteFrame } from "../shared/prompt-callsite.js";
import {
  assertWorkflowSerializableObject,
  workflowSerializableValidationError,
  workflowSerializableTypeName,
} from "../../shared/serializable.js";

export interface ResolvedInputs extends WorkflowInputValues {}

export interface RunContinuationOpts {
  readonly source: RunSnapshot;
  readonly resumeFromStageId: string;
}

export interface RunOpts extends Omit<AuthoringContract.RunOpts, "adapters" | "store" | "cancellation" | "overlay" | "registry" | "stageControlRegistry" | "continuation" | "onRunStart" | "onStageStart" | "onStageEnd" | "onRunEnd"> {
  adapters?: StageAdapters;
  /** Invocation working directory exposed to workflow definitions as ctx.cwd. */
  cwd?: string;
  /** HIL adapter injected by the pi runtime or test harness. */
  ui?: WorkflowUIAdapter;
  /** Runtime execution mode. Controls child session policy metadata. */
  executionMode?: WorkflowExecutionMode;
  /** Internal detached-run mode: surface ctx.ui.* as node-local workflow prompt stages. */
  usePromptNodesForUi?: boolean;
  /**
   * Readiness-gate confirmation seam (#1099). When an ask_user_question tool
   * call is observed during a stage, the executor calls this after the model
   * turn ends to ask whether to advance. Returning false keeps execution in the
   * stage (the executor steers the stage to continue and re-gates after the
   * next turn); true advances. When omitted, runs with usePromptNodesForUi
   * render the gate through the stage UI broker, and other runs proceed without
   * gating (tests/headless).
   */
  confirmStageReadiness?: (request: {
    readonly runId: string;
    readonly stageId: string;
    readonly stageName: string;
    readonly signal: AbortSignal;
  }) => Promise<boolean>;
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
   * Internal background-runner seam. When true, the executor records the run
   * synchronously, then yields to the next event-loop turn before invoking user
   * workflow code so detached dispatch cannot be blocked by pre-await work.
   */
  deferWorkflowStart?: boolean;
  /**
   * Resolved runtime configuration. Injected by the composition root after
   * merging file config with defaults. Downstream tasks (maxDepth, concurrency,
   * status writer) consume this; values are threaded here but not yet acted on.
   */
  config?: WorkflowRuntimeConfig;
  /** Optional model catalog used for fallback validation/resolution. */
  models?: WorkflowModelCatalogPort;
  /** Registry metadata forwarded to workflow runs launched from discovery/tooling. */
  registry?: WorkflowRegistry;
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
  /** Internal: originating chat session file stamped onto workflow stage sessions. */
  workflowOriginSessionFile?: string;
  /** Replay completed stages from a failed source run, then resume at this stage. */
  continuation?: RunContinuationOpts;
  /** Internal parent linkage for nested ctx.workflow(...) runs. */
  parentRun?: {
    readonly runId: string;
    readonly stageId: string;
    readonly rootRunId: string;
  };
  onRunStart?: (snapshot: RunSnapshot) => void;
  onStageStart?: (runId: string, snapshot: StageSnapshot) => void;
  onStageEnd?: (runId: string, snapshot: StageSnapshot) => void;
  onRunEnd?: (runId: string, status: RunStatus, result?: WorkflowOutputValues, error?: string) => void;
}

export interface RunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly result?: WorkflowOutputValues;
  readonly error?: string;
  readonly stages: StageSnapshot[];
}

// ---------------------------------------------------------------------------
// Input resolution / validation
// ---------------------------------------------------------------------------

export function resolveInputs(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  provided: Readonly<Record<string, unknown>>,
): ResolvedInputs {
  const resolved: Record<string, WorkflowSerializableValue> = {};
  for (const [key, value] of Object.entries(provided)) {
    if (value !== undefined) resolved[key] = value as WorkflowSerializableValue;
  }

  // Apply declared TypeBox defaults (top-level and nested) for absent keys.
  const withDefaults = Value.Default(
    Type.Object(schema as Record<string, TSchema>, { additionalProperties: true }),
    resolved,
  ) as Record<string, WorkflowSerializableValue>;
  for (const [key, value] of Object.entries(withDefaults)) {
    if (value !== undefined) resolved[key] = value;
  }

  for (const [key, schemaDef] of Object.entries(schema)) {
    if (schemaIsRequired(schemaDef) && resolved[key] === undefined) {
      throw new TypeError(`atomic-workflows: required input "${key}" not provided`);
    }
  }

  return resolved;
}

function resolveInputConcurrency(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  resolvedInputs: ResolvedInputs,
): number | undefined {
  const concurrencySchema = schema["max_concurrency"];
  if (concurrencySchema === undefined || schemaFieldKind(concurrencySchema) !== "number") {
    return undefined;
  }

  const value = resolvedInputs["max_concurrency"];
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;

  return Math.floor(value);
}

function resolveInputRuntimeDefaults(
  def: Pick<WorkflowDefinition, "inputBindings">,
  resolvedInputs: ResolvedInputs,
): Partial<StageOptions> {
  const defaults: Partial<StageOptions> = {};
  const worktree = def.inputBindings?.worktree;
  if (worktree !== undefined) {
    const gitWorktreeDir = resolvedInputs[worktree.gitWorktreeDir];
    if (typeof gitWorktreeDir === "string" && gitWorktreeDir.trim().length > 0) {
      defaults.gitWorktreeDir = gitWorktreeDir;
      const baseBranch = worktree.baseBranch === undefined ? undefined : resolvedInputs[worktree.baseBranch];
      if (typeof baseBranch === "string") defaults.baseBranch = baseBranch;
    }
  }
  return defaults;
}

// ---------------------------------------------------------------------------
// HIL unavailable fallback — rejects with precise per-primitive error
// ---------------------------------------------------------------------------

interface PromptDescriptor {
  readonly kind: PromptKind;
  readonly message: string;
  readonly choices?: readonly string[];
  readonly initial?: string;
}

function fallbackForPromptDescriptor(descriptor: PromptDescriptor): unknown {
  switch (descriptor.kind) {
    case "input":
    case "editor":
      return descriptor.initial ?? "";
    case "confirm":
      return false;
    case "select":
      return descriptor.choices?.[0] ?? "";
  }
}

function makePrompt(descriptor: PromptDescriptor): PendingPrompt {
  return {
    id: `hil-${crypto.randomUUID()}`,
    kind: descriptor.kind,
    message: descriptor.message,
    ...(descriptor.choices !== undefined ? { choices: descriptor.choices } : {}),
    ...(descriptor.initial !== undefined ? { initial: descriptor.initial } : {}),
    createdAt: Date.now(),
  };
}

function stableHash(value: unknown): string {
  // 128 bits is plenty for replay-key identity while keeping graph labels compact.
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
}

function promptDescriptorHash(descriptor: PromptDescriptor): string {
  return stableHash({
    kind: descriptor.kind,
    message: descriptor.message,
    choices: descriptor.choices ?? [],
    // Include input/editor initial text because it is visible prompt context;
    // changing it should not replay a stale answer from the same callsite.
    initial: descriptor.initial ?? null,
  });
}

function promptReplayKey(descriptor: PromptDescriptor): string {
  return `prompt:${descriptor.kind}:${promptDescriptorHash(descriptor)}:${promptCallsiteHash()}`;
}

function promptCallsiteHash(): string {
  // Capturing an Error stack is intentional here: HIL prompts are an
  // interactive slow path, and the author callsite is part of the replay key.
  const frame = selectPromptCallsiteFrame(new Error().stack ?? "") ?? "unknown";
  return stableHash(frame);
}

function hilAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("atomic-workflows: HIL aborted");
}

function makeUnavailableUIContext(): WorkflowUIContext {
  const msg = (primitive: string): string =>
    `atomic-workflows: HIL ctx.ui.${primitive} is unavailable because Atomic runtime did not provide a UI adapter`;
  return {
    input: () => Promise.reject(new Error(msg("input"))),
    confirm: () => Promise.reject(new Error(msg("confirm"))),
    select: () => Promise.reject(new Error(msg("select"))),
    editor: () => Promise.reject(new Error(msg("editor"))),
  };
}

type AskUserQuestionToolEvent =
  | { phase: "start"; callId?: string; args?: unknown }
  | { phase: "end"; callId?: string; nameMatched: boolean };

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
  const callId = stringField(record, ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "id"]);

  if (type === "tool_execution_start" && isAskUserQuestionToolName(toolName)) {
    return { phase: "start", callId, args: record["args"] };
  }
  if (type === "tool_execution_end" || type === "tool_execution_error" || type === "tool_result") {
    return { phase: "end", callId, nameMatched: isAskUserQuestionToolName(toolName) };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Readiness gate (#1099)
// ---------------------------------------------------------------------------
// A stage's agent turn returns control to the user when it ends. If that turn
// issued no ask_user_question call, the stage completes and the workflow
// advances automatically. If the turn DID ask the user something, a
// deterministic readiness gate (the structured ask_user_question UI, rendered
// inline in the attached stage chat via the broker) is shown when the turn
// ends. Choosing "I'm ready to move on…" advances; anything else (the
// keep-exploring option, a typed answer, "Chat about this", or cancelling)
// returns control to the user, who keeps working in the normal stage composer.
// The same per-turn check re-applies after each subsequent user-driven turn.

export const READINESS_GATE_ADVANCE_LABEL = "I'm ready to move on to the next workflow stage.";

const READINESS_GATE_ADVANCE_NORMALIZED = READINESS_GATE_ADVANCE_LABEL.trim().toLowerCase();

export const READINESS_GATE_QUESTION_PARAMS = {
  questions: [
    {
      question: "Any additional points to explore before moving on?",
      header: "Continue?",
      options: [
        {
          label: READINESS_GATE_ADVANCE_LABEL,
          description: "Complete this stage and advance the workflow.",
        },
        {
          label: "I have more to explore or ask about.",
          description: "Stay in this stage and keep working in the chat composer.",
        },
      ],
    },
  ],
};

/**
 * Decide whether a brokered readiness-gate result selected the "advance"
 * option. Tolerant of case/whitespace and of the advance label arriving via a
 * multi-select `selected[]` entry, so a structured answer that canonicalized to
 * the advance option still completes the stage. Anything else (the explore
 * option, a typed answer, a cancelled/empty result) means "stay".
 */
export function readinessResultMeansAdvance(result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const details = (result as {
    details?: {
      answers?: ReadonlyArray<{ answer?: unknown; selected?: ReadonlyArray<unknown> }>;
      cancelled?: boolean;
    };
  }).details;
  if (details === undefined || details.cancelled === true) return false;
  const first = details.answers?.[0];
  if (first === undefined) return false;
  const candidates: unknown[] = [first.answer];
  if (Array.isArray(first.selected)) candidates.push(...first.selected);
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      candidate.trim().toLowerCase() === READINESS_GATE_ADVANCE_NORMALIZED,
  );
}

let cachedReadinessGateTool: ReturnType<typeof createAskUserQuestionToolDefinition> | undefined;
function readinessGateTool(): ReturnType<typeof createAskUserQuestionToolDefinition> {
  return (cachedReadinessGateTool ??= createAskUserQuestionToolDefinition());
}

/**
 * Render the readiness gate inline in the attached stage chat by invoking the
 * ask_user_question tool with a pre-filled body, routing its custom UI through
 * the stage UI broker for (runId, stageId). Returns "advance" only when the
 * user chooses the move-on option; the keep-exploring option, "Chat about
 * this", a typed answer, or cancellation all mean "stay". If no stage chat host
 * is attached the broker request stays pending (the stage shows awaiting_input)
 * exactly like the tool itself.
 */
export async function askReadinessViaStageBroker(
  runId: string,
  stageId: string,
  signal: AbortSignal,
): Promise<"advance" | "stay"> {
  const execute = readinessGateTool().execute;
  if (execute === undefined) return "advance";
  const gateContext = {
    hasUI: true,
    ui: {
      custom: (factory: unknown, options?: unknown): Promise<unknown> =>
        stageUiBroker.requestCustomUi(
          runId,
          stageId,
          factory as Parameters<typeof stageUiBroker.requestCustomUi>[2],
          options as Parameters<typeof stageUiBroker.requestCustomUi>[3],
          signal,
        ),
    },
  };
  // Expose a headless-answer adapter for the gate so it can be answered
  // programmatically (e.g. `workflow send`) without a TUI host. The gate
  // question params are known statically here.
  const gatePromptId = `readiness-gate-${stageId}-${crypto.randomUUID()}`;
  const gateAdapter = buildStagePromptAdapter(
    gatePromptId,
    "readiness_gate",
    READINESS_GATE_QUESTION_PARAMS,
    Date.now(),
  );
  if (gateAdapter) stageUiBroker.provideStagePrompt(runId, stageId, gateAdapter);
  try {
    const result = await execute(
      gatePromptId,
      READINESS_GATE_QUESTION_PARAMS as Parameters<typeof execute>[1],
      signal,
      undefined,
      gateContext as unknown as Parameters<typeof execute>[4],
    );
    return readinessResultMeansAdvance(result) ? "advance" : "stay";
  } finally {
    stageUiBroker.clearStagePrompt(runId, stageId);
  }
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
    throw new Error("atomic-workflows: ctx.task requires options.prompt or options.task");
  }
  return prompt;
}

function taskPrevious(options: WorkflowTaskOptions): WorkflowTaskOptions["previous"] {
  return options.previous;
}

type WorkflowTaskExecutionOptions = WorkflowTaskOptions & { chainDir?: string };

function resolveWorkflowPath(filePath: string, baseDir: string | undefined): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(baseDir ?? process.cwd(), filePath);
}

function taskBaseDir(options: Pick<WorkflowTaskExecutionOptions, "chainDir" | "cwd">): string | undefined {
  if (typeof options.chainDir === "string" && options.chainDir.length > 0) {
    return resolveWorkflowPath(options.chainDir, process.cwd());
  }
  if (typeof options.cwd === "string" && options.cwd.length > 0) {
    return resolveWorkflowPath(options.cwd, process.cwd());
  }
  return undefined;
}

function taskReadInstruction(options: WorkflowTaskExecutionOptions): string {
  if (options.reads === false || options.reads === undefined || options.reads.length === 0) return "";
  const baseDir = taskBaseDir(options);
  const files = options.reads.map((file) => resolveWorkflowPath(file, baseDir));
  return `[Read from: ${files.join(", ")}]\n\n`;
}

function taskPromptOptions(options: WorkflowTaskExecutionOptions): StagePromptOptions | undefined {
  const baseDir = taskBaseDir(options);
  const promptOptions: StagePromptOptions = {
    ...(options.output !== undefined ? { output: options.output } : {}),
    ...(options.outputMode !== undefined ? { outputMode: options.outputMode } : {}),
    ...(baseDir !== undefined ? { cwd: baseDir } : options.cwd !== undefined ? { cwd: options.cwd } : {}),
    ...(options.maxOutput !== undefined ? { maxOutput: options.maxOutput } : {}),
    ...(options.artifacts !== undefined ? { artifacts: options.artifacts } : {}),
    ...(options.sessionDir !== undefined ? { sessionDir: options.sessionDir } : {}),
  };
  return Object.keys(promptOptions).length === 0 ? undefined : promptOptions;
}

function taskStageOptions(options: WorkflowTaskExecutionOptions): StageOptions {
  const {
    prompt: _prompt,
    task: _task,
    previous: _previous,
    chainDir: _chainDir,
    output: _output,
    outputMode: _outputMode,
    reads: _reads,
    worktree: _worktree,
    gitWorktreeDir: _gitWorktreeDir,
    baseBranch: _baseBranch,
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
    ...stepOptions
  } = step;
  return previous === undefined
    ? { ...stepOptions, prompt }
    : { ...stepOptions, prompt, previous };
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

function directModelRequestsFromChain(
  chain: readonly WorkflowChainStep[],
  options: WorkflowDirectOptions,
): Array<{ readonly model?: WorkflowDirectTaskItem["model"]; readonly fallbackModels?: readonly string[] }> {
  const requests: Array<{ readonly model?: WorkflowDirectTaskItem["model"]; readonly fallbackModels?: readonly string[] }> = [];
  for (const step of chain) {
    if ("parallel" in step) {
      requests.push(...step.parallel.map((item) => directTaskWithDefaults(item, options)));
    } else {
      requests.push(directTaskWithDefaults(step, options));
    }
  }
  return requests;
}

async function validateDirectModels(
  tasks: readonly WorkflowDirectTaskItem[],
  runOptions: RunOpts,
): Promise<readonly string[]> {
  return validateWorkflowModels({
    requests: tasks.map((task) => ({ model: task.model, fallbackModels: task.fallbackModels })),
    catalog: runOptions.models,
  });
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

function withoutUndefinedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

function sharedTaskDefaultsFromOptions(
  options: WorkflowChainOptions | WorkflowParallelOptions,
): Partial<WorkflowTaskExecutionOptions> {
  const {
    task: _task,
    concurrency: _concurrency,
    failFast: _failFast,
    ...taskDefaults
  } = options as WorkflowParallelOptions;
  return withoutUndefinedProperties(taskDefaults);
}

function taskWithSharedDefaults(
  taskOptions: WorkflowTaskOptions,
  options: WorkflowChainOptions | WorkflowParallelOptions,
): WorkflowTaskExecutionOptions {
  return {
    ...sharedTaskDefaultsFromOptions(options),
    ...withoutUndefinedProperties(taskOptions),
  } as WorkflowTaskExecutionOptions;
}

function directTaskWithDefaults(
  item: WorkflowDirectTaskItem,
  options: WorkflowDirectOptions,
): WorkflowDirectTaskItem {
  const {
    task: _task,
    chainName: _chainName,
    concurrency: _concurrency,
    failFast: _failFast,
    chainDir: _chainDir,
    reads,
    output,
    outputMode,
    worktree,
    gitWorktreeDir,
    baseBranch,
    maxOutput,
    artifacts,
    ...stageDefaults
  } = options;

  const taskWithStageDefaults = {
    ...withoutUndefinedProperties(stageDefaults),
    ...withoutUndefinedProperties(item),
    name: item.name,
  } as WorkflowDirectTaskItem;

  return {
    ...taskWithStageDefaults,
    ...(item.reads === undefined && reads !== undefined ? { reads } : {}),
    ...(item.output === undefined && output !== undefined ? { output } : {}),
    ...(item.outputMode === undefined && outputMode !== undefined ? { outputMode } : {}),
    ...(item.worktree === undefined && worktree !== undefined ? { worktree } : {}),
    ...(item.gitWorktreeDir === undefined && gitWorktreeDir !== undefined ? { gitWorktreeDir } : {}),
    ...(item.baseBranch === undefined && baseBranch !== undefined ? { baseBranch } : {}),
    ...(item.maxOutput === undefined && maxOutput !== undefined ? { maxOutput } : {}),
    ...(item.artifacts === undefined && artifacts !== undefined ? { artifacts } : {}),
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

function positiveConcurrency(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

async function mapParallelSteps<T>(
  steps: readonly WorkflowTaskStep[],
  concurrency: number | undefined,
  failFast: boolean | undefined,
  mapper: (step: WorkflowTaskStep) => Promise<T>,
  onFirstFailure?: (error: unknown) => void,
): Promise<T[]> {
  const limit = positiveConcurrency(concurrency) ?? steps.length;
  const failFastEnabled = failFast !== false;
  const results = new Array<T>(steps.length);
  const failures: Array<{ readonly index: number; readonly error: unknown }> = [];
  let nextIndex = 0;
  let firstFailure: unknown;
  let rejectFirstFailure: (reason: unknown) => void = () => {};
  const firstFailurePromise = new Promise<never>((_, reject) => {
    rejectFirstFailure = reject;
  });

  async function worker(): Promise<void> {
    while (true) {
      if (failFastEnabled && firstFailure !== undefined) return;
      const index = nextIndex;
      nextIndex += 1;
      const step = steps[index];
      if (step === undefined) return;
      try {
        results[index] = await mapper(step);
      } catch (err) {
        failures.push({ index, error: err });
        if (firstFailure === undefined) {
          firstFailure = err;
          onFirstFailure?.(err);
          if (failFastEnabled) rejectFirstFailure(err);
        }
        if (failFastEnabled) return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, steps.length) }, () => worker());
  const allWorkers = Promise.all(workers);

  if (!failFastEnabled) {
    await allWorkers;
  } else {
    try {
      await Promise.race([allWorkers, firstFailurePromise]);
    } catch (err) {
      void allWorkers.catch(() => {});
      throw err;
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `atomic-workflows: ${failures.length} parallel ${failures.length === 1 ? "step" : "steps"} failed`,
    );
  }

  return results;
}

function expandedParallelTasks(tasks: readonly WorkflowDirectTaskItem[]): WorkflowDirectTaskItem[] {
  const expanded: WorkflowDirectTaskItem[] = [];
  for (const task of tasks) {
    const count = task.count ?? 1;
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(`atomic-workflows: direct task "${task.name}" count must be a positive integer`);
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

function resolveWorktreeCwdOverride(cwd: string | undefined, worktreeCwd: string): string | undefined {
  if (cwd === undefined || cwd.length === 0) return undefined;
  return isAbsolute(cwd) ? cwd : resolve(worktreeCwd, cwd);
}

function stageOptionsWithInputDefaults<T extends StageOptions>(options: T | undefined, inputDefaults: Partial<StageOptions>): T | undefined {
  const defaults = withoutUndefinedProperties(inputDefaults);
  if (Object.keys(defaults).length === 0) return options;
  return { ...defaults, ...withoutUndefinedProperties(options ?? {}) } as T;
}

function stageOptionsWithGitWorktree<T extends StageOptions>(options: T | undefined, workflowInvocationCwd: string): T | undefined {
  if (options === undefined) return undefined;
  if (typeof options.gitWorktreeDir !== "string" || options.gitWorktreeDir.trim().length === 0) {
    return options;
  }
  const setup = setupGitWorktree({
    gitWorktreeDir: options.gitWorktreeDir,
    baseBranch: options.baseBranch,
    cwd: workflowInvocationCwd,
  });
  const explicitCwd = resolveWorktreeCwdOverride(options.cwd, setup.cwd);
  return { ...options, gitWorktreeDir: undefined, baseBranch: undefined, cwd: explicitCwd ?? setup.cwd };
}

function stageOptionsWithWorkflowMetadata(
  options: StageOptions | undefined,
  metadata: {
    readonly originSessionFile?: string;
    readonly runId: string;
    readonly workflowName: string;
    readonly stageId: string;
    readonly stageName: string;
  },
): StageOptions {
  return {
    ...(options ?? {}),
    ...(metadata.originSessionFile !== undefined ? { workflowOriginSessionFile: metadata.originSessionFile } : {}),
    workflowRunId: metadata.runId,
    workflowName: metadata.workflowName,
    workflowStageId: metadata.stageId,
    workflowStageName: metadata.stageName,
  };
}

function workflowCwdWithInputWorktree(inputDefaults: Partial<StageOptions>, workflowInvocationCwd: string): string {
  if (typeof inputDefaults.gitWorktreeDir !== "string" || inputDefaults.gitWorktreeDir.trim().length === 0) {
    return workflowInvocationCwd;
  }
  return setupGitWorktree({
    gitWorktreeDir: inputDefaults.gitWorktreeDir,
    baseBranch: inputDefaults.baseBranch,
    cwd: workflowInvocationCwd,
  }).cwd;
}

function directWorktreeDiffsDir(options: WorkflowDirectOptions, setup: WorktreeSetup, runId: string, scope: string): string {
  const baseDir = options.chainDir ?? join(setup.cwd, CONFIG_DIR_NAME, "workflows");
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

  if (typeof options.gitWorktreeDir === "string" || tasks.some((task) => typeof task.gitWorktreeDir === "string")) {
    throw new Error("atomic-workflows: worktree and gitWorktreeDir are mutually exclusive; use gitWorktreeDir for a reusable worktree or worktree:true for temporary isolated worktrees.");
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
    "workflowOriginSessionFile" in value ||
    "onRunStart" in value ||
    "onStageStart" in value ||
    "onStageEnd" in value ||
    "onRunEnd" in value ||
    "models" in value
  );
}

async function writeDirectOutput(
  item: { readonly chainDir?: string; readonly cwd?: string; readonly output?: string | false; readonly outputMode?: WorkflowOutputMode },
  result: WorkflowTaskResult,
): Promise<{ result: WorkflowTaskResult; artifact?: WorkflowArtifact }> {
  if (typeof item.output !== "string") return { result };

  const outputPath = resolveWorkflowPath(item.output, taskBaseDir(item));
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.text, "utf8");

  const visibleResult =
    item.outputMode === "file-only"
      ? { ...result, text: "" }
      : result;

  return {
    result: visibleResult,
    artifact: {
      kind: "output",
      path: outputPath,
      taskName: result.name,
    },
  };
}

function directFailureMessage(error: unknown): string {
  return classifyWorkflowFailure(error).userMessage;
}

function failedDirectDetails(
  mode: WorkflowDetails["mode"],
  runId: string,
  total: number,
  error: unknown,
  options: WorkflowDirectOptions = {},
): WorkflowDetails {
  return {
    mode,
    action: "run",
    runId,
    status: "failed",
    ...(options.context !== undefined ? { context: options.context } : {}),
    results: [],
    progress: { completed: 0, total },
    error: directFailureMessage(error),
  };
}

function workflowDetailsFromRun(
  mode: WorkflowDetails["mode"],
  runResult: RunResult,
  results: readonly WorkflowTaskResult[],
  options: WorkflowDirectOptions = {},
  warnings: readonly string[] = [],
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
  const resultWarnings = results.flatMap((result) => result.warnings ?? []);
  const allWarnings = [...warnings, ...resultWarnings];
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
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(runResult.error !== undefined ? { error: runResult.error } : {}),
  };
}

const EMPTY_WORKFLOW_GRAPH_ERROR_MESSAGE = "Workflow run completed without creating any workflow stages. Create at least one stage with ctx.stage(), ctx.task(), ctx.chain(), ctx.parallel(), or ctx.workflow().";

function assertWorkflowCreatedStage(runSnapshot: RunSnapshot): void {
  if (runSnapshot.stages.length > 0) return;
  throw new Error(EMPTY_WORKFLOW_GRAPH_ERROR_MESSAGE);
}

// Direct (task/parallel/chain) execution synthesizes ephemeral workflows that
// expose tool-parity outputs. They are declared explicitly like any other
// workflow so the fully-explicit output contract holds on the direct path too.
// `unknown` accepts any serializable value, and every key is optional because a
// given direct mode only returns the subset it produces (e.g. `count` for chain/
// parallel, `text` for single task, `worktreeSummary` only with worktrees).
const DIRECT_WORKFLOW_OUTPUTS: Readonly<Record<string, WorkflowOutputSchema>> = Object.freeze({
  results: Type.Optional(Type.Unknown()),
  text: Type.Optional(Type.Unknown()),
  count: Type.Optional(Type.Unknown()),
  artifacts: Type.Optional(Type.Unknown()),
  worktreeSummary: Type.Optional(Type.Unknown()),
});

function defineDirectWorkflow(
  name: string,
  runFn: WorkflowDefinition["run"],
): WorkflowDefinition {
  const definition = {
    __piWorkflow: true,
    name,
    normalizedName: name,
    description: "Direct workflow execution",
    inputs: Object.freeze({}),
    outputs: DIRECT_WORKFLOW_OUTPUTS,
    run: runFn,
  } as WorkflowDefinition;
  // Stamp before freezing so the WeakSet brand can be attached.
  stampWorkflowDefinition(definition);
  return Object.freeze(definition);
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
  const taskWithDefaults = directTaskWithDefaults(task, options);
  let validationWarnings: readonly string[] = [];
  try {
    validationWarnings = await validateDirectModels([taskWithDefaults], runOptions);
  } catch (err) {
    return failedDirectDetails("single", runId, 1, err, options);
  }
  const prepared = prepareDirectWorktrees([taskWithDefaults], options, runId, "single");
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
  return workflowDetailsFromRun("single", runResult, results, options, validationWarnings);
}

/** SDK helper for direct top-level parallel task execution. */
export async function runParallel(
  tasks: readonly WorkflowDirectTaskItem[],
  options: WorkflowDirectOptions = {},
  runOptions: RunOpts = {},
): Promise<WorkflowDetails> {
  const tasksWithDefaults = tasks.map((task) => directTaskWithDefaults(task, options));
  const expanded = expandedParallelTasks(tasksWithDefaults);
  const runId = directRunId(runOptions);
  let validationWarnings: readonly string[] = [];
  try {
    validationWarnings = await validateDirectModels(expanded, runOptions);
  } catch (err) {
    return failedDirectDetails("parallel", runId, expanded.length, err, options);
  }
  const prepared = prepareDirectWorktrees(expanded, options, runId, "parallel");
  const direct = defineDirectWorkflow("direct-parallel", async (ctx) => {
    try {
      const steps = prepared.tasks.map((task) => directTaskToStep(task));
      const rawResults = await ctx.parallel(steps, {
        task: options.task,
        concurrency: options.concurrency,
        failFast: options.failFast,
      });
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
  return workflowDetailsFromRun("parallel", runResult, results, options, validationWarnings);
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
    const stepOptions = {
      ...options,
      worktree: options.worktree === true || step.worktree === true,
      ...(step.gitWorktreeDir !== undefined ? { gitWorktreeDir: step.gitWorktreeDir } : {}),
      ...(step.baseBranch !== undefined ? { baseBranch: step.baseBranch } : {}),
    };
    const expanded = expandedParallelTasks(step.parallel.map((item) => directTaskWithDefaults(item, stepOptions)));
    const prepared = prepareDirectWorktrees(expanded, stepOptions, `${runId}-s${index}`, `step-${index}`);
    try {
      const steps = prepared.tasks.map((item) =>
        directTaskToStep(item, directTaskPrompt(item) ?? "{previous}", item.previous ?? prior),
      );
      const rawResults = await ctx.parallel(steps, {
        task: rootTask,
        concurrency: step.concurrency ?? options.concurrency,
        failFast: step.failFast ?? options.failFast,
        ...(typeof options.chainDir === "string" ? { chainDir: options.chainDir } : {}),
      } as WorkflowParallelOptions);
      const persisted = await Promise.all(
        rawResults.map((result, taskIndex) =>
          writeDirectOutput({ ...prepared.tasks[taskIndex]!, chainDir: options.chainDir }, result),
        ),
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
      {
        ...directTaskToStep(preparedStep, replaceTaskPlaceholder(prompt, rootTask), preparedStep.previous ?? prior),
        ...(typeof options.chainDir === "string" ? { chainDir: options.chainDir } : {}),
      } as WorkflowTaskOptions,
    );
    const { result, artifact } = await writeDirectOutput({ ...preparedStep, chainDir: options.chainDir }, rawResult);
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
  let validationWarnings: readonly string[] = [];
  try {
    validationWarnings = await validateWorkflowModels({
      requests: directModelRequestsFromChain(chain, options),
      catalog: runOptions.models,
    });
  } catch (err) {
    return failedDirectDetails("chain", runId, chain.length, err, options);
  }
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
  return workflowDetailsFromRun("chain", runResult, results, options, validationWarnings);
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
    readonly result?: WorkflowOutputValues;
    readonly error?: string;
    readonly failureKind?: WorkflowFailureKind;
    readonly failureMessage?: string;
    readonly failedStageId?: string;
    readonly resumable?: boolean;
    readonly ts: number;
  },
): void {
  if (!persistence || !recorded) return;
  appendRunEnd(persistence, payload);
}

interface RunFailureMetadata {
  readonly errorMessage: string;
  readonly failureKind: WorkflowFailureKind;
  readonly failureMessage: string;
  readonly failedStageId?: string;
  readonly resumable: boolean;
}

function applyFailureToStage(stage: StageSnapshot, failure: WorkflowFailure): void {
  stage.status = "failed";
  stage.error = failure.userMessage;
  stage.failureKind = failure.kind;
  stage.failureMessage = failure.message;
}

function runFailureMetadata(err: unknown, stages: readonly StageSnapshot[]): RunFailureMetadata {
  const classified = classifyWorkflowFailure(err);
  const failedStage = stages.find((stage) => stage.status === "failed");
  const failureKind = failedStage?.failureKind ?? classified.kind;

  return {
    errorMessage: classified.userMessage,
    failureKind,
    failureMessage: failedStage?.failureMessage ?? classified.message,
    ...(failedStage !== undefined ? { failedStageId: failedStage.id } : {}),
    resumable: classified.resumable,
  };
}

function stageReplayFields(stage: StageSnapshot): Partial<Pick<StageSnapshot, "replayKey" | "replayedFromStageId" | "replayed">> {
  return {
    ...(stage.replayKey !== undefined ? { replayKey: stage.replayKey } : {}),
    ...(stage.replayedFromStageId !== undefined ? { replayedFromStageId: stage.replayedFromStageId } : {}),
    ...(stage.replayed !== undefined ? { replayed: stage.replayed } : {}),
  };
}

type PromptAnswerReplaySafety = "allowed" | "unavailable" | "ambiguous";

function getPromptAnswerState(
  hasReplayAnswer: boolean,
  replaySourceId: string | undefined,
  answerReplay: PromptAnswerReplaySafety,
): StageSnapshot["promptAnswerState"] {
  if (replaySourceId === undefined) return undefined;
  if (hasReplayAnswer) return "available";
  if (answerReplay === "ambiguous") return "ambiguous";
  return "unavailable";
}

type ContinuationReplayDecision =
  | {
      readonly kind: "execute";
      readonly source?: StageSnapshot;
      readonly parentIds: readonly string[];
      readonly answerReplay: PromptAnswerReplaySafety;
    }
  | {
      readonly kind: "replay";
      readonly source: StageSnapshot;
      readonly parentIds: readonly string[];
      readonly answerReplay: PromptAnswerReplaySafety;
    };

interface ContinuationReplayInput {
  readonly displayName: string;
  readonly replayKey: string;
  readonly parentIds: readonly string[];
  readonly stageId: string;
  readonly kind: "stage" | "prompt" | "workflow";
}

interface ContinuationReplayIndex {
  decide(input: ContinuationReplayInput): ContinuationReplayDecision;
  markPromptAnswerReplayed(stageId: string): void;
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function sortedIdentity(values: readonly string[]): string {
  return [...values].sort().join("\u0000");
}

function createContinuationReplayIndex(continuation: RunContinuationOpts | undefined): ContinuationReplayIndex {
  if (continuation === undefined) {
    return {
      decide: (input) => ({
        kind: "execute",
        parentIds: input.parentIds,
        answerReplay: "unavailable",
      }),
      markPromptAnswerReplayed: () => {},
    };
  }
  const resumeStage = continuation.source.stages.find((stage) => stage.id === continuation.resumeFromStageId);
  if (resumeStage === undefined) {
    throw new Error(`atomic-workflows: insufficient_state: resume stage ${continuation.resumeFromStageId} was not found in source run ${continuation.source.id}`);
  }

  const stagesByReplayIdentity = new Map<string, StageSnapshot[]>();
  const promptDuplicateCounts = new Map<string, number>();
  for (const stage of continuation.source.stages) {
    const identity = stage.replayKey ?? stage.name;
    const stages = stagesByReplayIdentity.get(identity);
    if (stages === undefined) {
      stagesByReplayIdentity.set(identity, [stage]);
    } else {
      stages.push(stage);
    }
    const duplicateKey = `${identity}\u0001${sortedIdentity(stage.parentIds)}`;
    promptDuplicateCounts.set(duplicateKey, (promptDuplicateCounts.get(duplicateKey) ?? 0) + 1);
  }

  const consumedSourceStageIds = new Set<string>();
  const continuationStageIdBySourceStageId = new Map<string, string>();
  const replayablePromptContinuationStageIds = new Set<string>();

  const failTopology = (displayName: string, replayKey: string, reason: "mismatch" | "ambiguous"): never => {
    throw new Error(`atomic-workflows: insufficient_state: replay topology ${reason} for stage "${displayName}" (replayKey "${replayKey}") in source run ${continuation.source.id}`);
  };

  const translateSourceParents = (source: StageSnapshot): string[] | undefined => {
    const parentIds: string[] = [];
    for (const sourceParentId of source.parentIds) {
      const continuationParentId = continuationStageIdBySourceStageId.get(sourceParentId);
      if (continuationParentId === undefined) return undefined;
      parentIds.push(continuationParentId);
    }
    return parentIds;
  };

  const allSameParentSet = (candidates: readonly { readonly parentIds: readonly string[] }[]): boolean => {
    const first = candidates[0]?.parentIds;
    if (first === undefined) return false;
    return candidates.every((candidate) => sameStringSet(candidate.parentIds, first));
  };

  const hasOnlyReplayablePromptParentDrift = (
    sourceParentIds: readonly string[],
    provisionalParentIds: readonly string[],
  ): boolean => {
    const sourceParentSet = new Set(sourceParentIds);
    const provisionalParentSet = new Set(provisionalParentIds);
    const driftParentIds = [
      ...sourceParentIds.filter((parentId) => !provisionalParentSet.has(parentId)),
      ...provisionalParentIds.filter((parentId) => !sourceParentSet.has(parentId)),
    ];
    return driftParentIds.length > 0 && driftParentIds.every((parentId) => replayablePromptContinuationStageIds.has(parentId));
  };

  return {
    markPromptAnswerReplayed(stageId: string): void {
      replayablePromptContinuationStageIds.add(stageId);
    },

    decide(input: ContinuationReplayInput): ContinuationReplayDecision {
      const { displayName, replayKey, parentIds, stageId, kind } = input;
      let identity = replayKey;
      let candidates = stagesByReplayIdentity.get(replayKey)?.filter((stage) => !consumedSourceStageIds.has(stage.id)) ?? [];
      if (candidates.length === 0) {
        // Legacy snapshots created before replayKey existed can only be matched
        // by display name. Current stage and prompt nodes always carry replayKey.
        identity = displayName;
        candidates = stagesByReplayIdentity.get(displayName)?.filter((stage) => !consumedSourceStageIds.has(stage.id) && stage.replayKey === undefined) ?? [];
      }
      if (candidates.length === 0) {
        return { kind: "execute", parentIds, answerReplay: "unavailable" };
      }

      const mappedCandidates = candidates
        .map((source) => ({ source, parentIds: translateSourceParents(source) }))
        .filter((candidate): candidate is { readonly source: StageSnapshot; readonly parentIds: string[] } => candidate.parentIds !== undefined);

      if (mappedCandidates.length === 0) {
        failTopology(displayName, replayKey, "mismatch");
      }

      const provisionalMatches = mappedCandidates.filter((candidate) => sameStringSet(candidate.parentIds, parentIds));
      const hasPromptDriftMatch = kind === "prompt" &&
        allSameParentSet(mappedCandidates) &&
        hasOnlyReplayablePromptParentDrift(mappedCandidates[0]!.parentIds, parentIds);
      let matches: typeof mappedCandidates | undefined;
      if (provisionalMatches.length > 0) {
        matches = provisionalMatches;
      } else if (hasPromptDriftMatch) {
        matches = mappedCandidates;
      }
      if (matches === undefined) {
        return failTopology(displayName, replayKey, "mismatch");
      }
      if (matches.length > 1 && (kind !== "prompt" || !allSameParentSet(matches))) {
        failTopology(displayName, replayKey, "ambiguous");
      }

      const selected = matches[0]!;
      const duplicateKey = `${identity}\u0001${sortedIdentity(selected.source.parentIds)}`;
      const ambiguousPromptAnswer = kind === "prompt" && (promptDuplicateCounts.get(duplicateKey) ?? 0) > 1;
      const answerReplay: PromptAnswerReplaySafety = ambiguousPromptAnswer
        ? "ambiguous"
        : selected.source.status === "completed"
          ? "allowed"
          : "unavailable";
      consumedSourceStageIds.add(selected.source.id);
      continuationStageIdBySourceStageId.set(selected.source.id, stageId);
      if (selected.source.status === "completed" && answerReplay === "allowed") {
        return { kind: "replay", source: selected.source, parentIds: selected.parentIds, answerReplay };
      }
      return { kind: "execute", source: selected.source, parentIds: selected.parentIds, answerReplay };
    },
  };
}

interface ParallelFailFastStage {
  readonly skip: () => void;
}

interface ParallelFailFastScope {
  failed: boolean;
  firstFailure?: unknown;
  readonly activeStages: Map<string, ParallelFailFastStage>;
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
  const errorMessage = "workflow killed";
  const metadata = {
    failureKind: "cancelled" as const,
    failureMessage: errorMessage,
    resumable: false,
  };
  const recorded = activeStore.recordRunEnd(runId, "killed", undefined, errorMessage, metadata);
  onRunEnd?.(runId, "killed", undefined, errorMessage);
  appendRunEndWhenRecorded(persistence, recorded, {
    runId,
    status: "killed",
    error: errorMessage,
    ...metadata,
    ts: Date.now(),
  });
  return {
    runId,
    status: "killed",
    error: errorMessage,
    stages: [...runSnapshot.stages],
  };
}

// ---------------------------------------------------------------------------
// Main executor
// ---------------------------------------------------------------------------

function nextEventLoopTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function formatValidationErrors(errors: readonly ValidationError[]): string {
  return errors.map((error) => `  - ${error.key}: ${error.reason}`).join("\n");
}

export function resolveAndValidateInputs(
  schema: Readonly<Record<string, WorkflowInputSchema>>,
  provided: Readonly<Record<string, unknown>>,
  scope: string,
): ResolvedInputs {
  const resolved = resolveInputs(schema, provided);
  const errors = validateInputs(schema, resolved);
  if (errors.length > 0) {
    throw new TypeError(
      `atomic-workflows: invalid inputs for ${scope}:\n${formatValidationErrors(errors)}`,
    );
  }
  return resolved;
}

function hasOwnWorkflowOutput(record: WorkflowOutputValues | Readonly<Record<string, WorkflowOutputSchema>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

// Workflow outputs are fully explicit: a workflow exposes exactly the outputs it
// declares with `.output(...)`. There is no implicit `result` fallback, and a
// `.run()` return that contains a key the workflow did not declare is an error,
// so authors cannot silently leak undeclared values across a workflow boundary.
function assertWorkflowOutputsExplicit(
  scope: string,
  sourceOutput: WorkflowOutputValues,
  declarations: Readonly<Record<string, WorkflowOutputSchema>>,
  missingOutputSuffix = "",
): void {
  for (const key of Object.keys(sourceOutput)) {
    if (!hasOwnWorkflowOutput(declarations, key)) {
      throw new Error(
        `atomic-workflows: ${scope} returned undeclared output "${key}"; declare it with .output("${key}", Type....) or remove it from the .run() return`,
      );
    }
  }
  for (const [key, schema] of Object.entries(declarations)) {
    if (!(key in sourceOutput)) {
      if (schemaIsRequired(schema)) {
        throw new Error(
          `atomic-workflows: ${scope} missing output "${key}"${missingOutputSuffix}`,
        );
      }
      continue;
    }
    const value = sourceOutput[key];
    const kind = schemaFieldKind(schema);
    if (!Value.Check(schema, value)) {
      const choices = schemaChoices(schema);
      if (kind === "select" && choices !== undefined && typeof value === "string") {
        throw new Error(
          `atomic-workflows: ${scope} output "${key}" must be one of [${choices.join(", ")}], got ${JSON.stringify(value)}`,
        );
      }
      throw new Error(
        `atomic-workflows: ${scope} output "${key}" expected ${kind}, got ${workflowSerializableTypeName(value)}`,
      );
    }
    const serializableError = workflowSerializableValidationError(
      value,
      `${scope} output "${key}"`,
    );
    if (serializableError !== undefined) {
      throw new Error(`atomic-workflows: ${serializableError}`);
    }
  }
}

function normalizeWorkflowRunOutput(
  workflowName: string,
  rawOutput: unknown,
): WorkflowOutputValues | undefined {
  if (rawOutput === undefined) return undefined;
  // Drop top-level keys explicitly set to `undefined` so conditional outputs
  // (e.g. `{ note: cond ? value : undefined }`) satisfy the JSON-serializable
  // contract instead of failing validation; selectWorkflowOutputs strips the
  // same way at the child boundary, keeping both paths consistent.
  const normalized =
    rawOutput !== null && typeof rawOutput === "object" && !Array.isArray(rawOutput)
      ? Object.fromEntries(
          Object.entries(rawOutput as Record<string, unknown>).filter(([, v]) => v !== undefined),
        )
      : rawOutput;
  assertWorkflowSerializableObject(normalized, `workflow "${workflowName}" .run() return`);
  return normalized;
}

function assertWorkflowRunOutputs(
  workflowName: string,
  result: WorkflowOutputValues | undefined,
  declaredOutputs: Readonly<Record<string, WorkflowOutputSchema>> | undefined,
): void {
  assertWorkflowOutputsExplicit(
    `workflow "${workflowName}"`,
    result ?? {},
    declaredOutputs ?? {},
  );
}

function selectWorkflowOutputs(
  child: WorkflowDefinition,
  rawOutput: WorkflowOutputValues | undefined,
): WorkflowOutputValues {
  const declarations = child.outputs ?? {};
  const sourceOutput = rawOutput ?? {};
  // The child run already validated its return against these declared outputs
  // (assertWorkflowRunOutputs) before it could complete, so undeclared keys are
  // impossible here and a second assertWorkflowOutputsExplicit pass could never
  // fire. Just project the declared outputs the child returned. (An undeclared
  // key fails the child run itself; the parent surfaces that as a wrapped
  // "child workflow ... failed" error.)
  const selected: Record<string, WorkflowSerializableValue> = {};
  for (const key of Object.keys(declarations)) {
    const value = sourceOutput[key];
    if (value !== undefined) selected[key] = value;
  }

  return selected;
}

function cloneWorkflowChildValue<T>(value: T): T {
  return structuredClone(value);
}

function workflowChildSerializationMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  if (!isBrandedWorkflowDefinition(value)) return false;
  const record = value as Partial<WorkflowDefinition>;
  return record.__piWorkflow === true &&
    typeof record.name === "string" && record.name.trim().length > 0 &&
    typeof record.normalizedName === "string" && record.normalizedName.trim().length > 0 &&
    typeof record.run === "function" &&
    typeof record.inputs === "object" && record.inputs !== null;
}

function workflowDefinitionRequirementMessage(callSite: string, value: unknown): string {
  // isWorkflowDefinition already failed; this extra sentinel check narrows the
  // diagnostic for forged legacy literals versus unrelated values.
  if (value !== null && typeof value === "object" && (value as { __piWorkflow?: unknown }).__piWorkflow === true) {
    return `atomic-workflows: ${callSite} requires a compiled workflow definition produced by defineWorkflow(...).compile(); hand-rolled __piWorkflow objects are not supported`;
  }
  return `atomic-workflows: ${callSite} requires a compiled workflow definition`;
}

function cloneWorkflowChildReplaySnapshot(snapshot: WorkflowChildReplaySnapshot): WorkflowChildReplaySnapshot {
  return {
    alias: snapshot.alias,
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    status: snapshot.status,
    outputs: cloneWorkflowChildValue(snapshot.outputs),
  };
}

function workflowChildReplaySnapshot(
  alias: string,
  childResult: WorkflowChildResult,
): WorkflowChildReplaySnapshot {
  const outputs: Record<string, WorkflowSerializableValue> = {};
  for (const [key, value] of Object.entries(childResult.outputs)) {
    if (value === undefined) continue;
    try {
      outputs[key] = cloneWorkflowChildValue(value);
    } catch (err) {
      throw new Error(
        `atomic-workflows: child workflow "${alias}" (${childResult.workflow}) exposed output "${key}" is not serializable for continuation replay: ${workflowChildSerializationMessage(err)}`,
        { cause: err },
      );
    }
  }

  return {
    alias,
    workflow: childResult.workflow,
    runId: childResult.runId,
    status: childResult.status,
    outputs,
  };
}

export async function run<TInputs extends WorkflowInputValues>(
  def: WorkflowDefinition<TInputs>,
  inputs: Readonly<Record<string, unknown>>,
  opts: RunOpts = {},
): Promise<RunResult> {
  if (!isWorkflowDefinition(def)) {
    throw new Error(workflowDefinitionRequirementMessage("run(definition, inputs)", def));
  }

  const activeStore = opts.store ?? defaultStore;
  const adapters = opts.adapters ?? {};
  if (opts.usePromptNodesForUi === true && opts.ui !== undefined) {
    console.warn("atomic-workflows: usePromptNodesForUi ignores the provided RunOpts.ui adapter");
  }

  // 0. maxDepth guard — reject before any store/persistence side effects.
  const depth = opts.depth ?? 0;
  const maxDepth = opts.config?.maxDepth ?? 4;
  if (depth >= maxDepth) {
    const max = maxDepth;
    return {
      runId: opts.runId ?? crypto.randomUUID(),
      status: "failed",
      error: `atomic-workflows: maxDepth exceeded (max ${max})`,
      stages: [],
    };
  }

  // 1. Resolve + validate inputs
  const resolvedInputs = resolveAndValidateInputs(
    def.inputs,
    inputs,
    `workflow "${def.name}"`,
  );

  // 2. Generate runId (or use pre-allocated seam from caller)
  const runId = opts.runId ?? crypto.randomUUID();
  const replayIndex = createContinuationReplayIndex(opts.continuation);

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
    ...(opts.parentRun !== undefined ? {
      parentRunId: opts.parentRun.runId,
      parentStageId: opts.parentRun.stageId,
      rootRunId: opts.parentRun.rootRunId,
    } : {}),
    ...(opts.continuation !== undefined ? {
      resumedFromRunId: opts.continuation.source.id,
      resumeFromStageId: opts.continuation.resumeFromStageId,
    } : {}),
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
      ...(runSnapshot.parentRunId !== undefined ? { parentRunId: runSnapshot.parentRunId } : {}),
      ...(runSnapshot.parentStageId !== undefined ? { parentStageId: runSnapshot.parentStageId } : {}),
      ...(runSnapshot.rootRunId !== undefined ? { rootRunId: runSnapshot.rootRunId } : {}),
      ...(runSnapshot.resumedFromRunId !== undefined ? { resumedFromRunId: runSnapshot.resumedFromRunId } : {}),
      ...(runSnapshot.resumeFromStageId !== undefined ? { resumeFromStageId: runSnapshot.resumeFromStageId } : {}),
      ts: runSnapshot.startedAt,
    });
  }

  // 4. Create GraphFrontierTracker and per-run ConcurrencyLimiter
  const tracker = new GraphFrontierTracker();
  const inputConcurrency = resolveInputConcurrency(def.inputs, resolvedInputs);
  const inputRuntimeDefaults = resolveInputRuntimeDefaults(def, resolvedInputs);
  const workflowInvocationCwd = opts.cwd ?? process.cwd();
  let workflowCwd: string | undefined;
  const resolveWorkflowCwd = (): string => {
    workflowCwd ??= workflowCwdWithInputWorktree(inputRuntimeDefaults, workflowInvocationCwd);
    return workflowCwd;
  };
  const limiter = createRunLimiter(inputConcurrency ?? opts.config?.defaultConcurrency);
  interface ReleaseBarrier {
    readonly promise: Promise<void>;
    readonly resolve: () => void;
    readonly reject: (reason?: unknown) => void;
  }
  const releaseBarriers = new Map<string, ReleaseBarrier>();
  const cascadePauseOwners = new Map<string, Set<string>>();

  const makeReleaseBarrier = (): ReleaseBarrier => {
    const resolver = Promise.withResolvers<void>();
    // Abort rejects release barriers during kill/shutdown. Some barriers are
    // only state markers for a paused root/current stage and have no active
    // waiter, so mark expected cancellation as observed while preserving the
    // same promise for callers that do await it.
    void resolver.promise.catch(() => {});
    return { promise: resolver.promise, resolve: resolver.resolve, reject: resolver.reject };
  };

  const isTerminalStage = (stage: StageSnapshot): boolean =>
    stage.status === "completed" || stage.status === "failed" || stage.status === "skipped";

  const stageById = (stageId: string): StageSnapshot | undefined =>
    runSnapshot.stages.find((stage) => stage.id === stageId);

  const setStageParentIds = (stage: StageSnapshot, parentIds: readonly string[]): void => {
    // Keep tracker and snapshot parent arrays in sync when topology is refreshed;
    // consumers should not cache the old parentIds reference across updates.
    stage.parentIds = Object.freeze([...parentIds]);
  };

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

  const markCascadePaused = (stageId: string, ownerStageId: string): void => {
    let owners = cascadePauseOwners.get(stageId);
    if (!owners) {
      owners = new Set<string>();
      cascadePauseOwners.set(stageId, owners);
    }
    owners.add(ownerStageId);
  };

  const releaseCascadePauseOwner = (stageId: string, ownerStageId: string): boolean => {
    const owners = cascadePauseOwners.get(stageId);
    if (!owners) return false;
    const changed = owners.delete(ownerStageId);
    if (owners.size === 0) cascadePauseOwners.delete(stageId);
    return changed;
  };

  const releaseStageBarrier = (stageId: string): void => {
    const barrier = releaseBarriers.get(stageId);
    if (!barrier) return;
    releaseBarriers.delete(stageId);
    barrier.resolve();
  };

  const cascadePauseFrom = async (pausedStageId: string): Promise<void> => {
    const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
    for (const descendant of descendantsOf(pausedStageId)) {
      if (isTerminalStage(descendant) || descendant.status === "paused" || descendant.status === "blocked") continue;
      const descendantHandle = stageRegistry.get(runId, descendant.id);
      if (descendantHandle?.isStreaming || descendant.status === "running") {
        if (descendantHandle && (descendantHandle.status === "running" || descendantHandle.status === "pending")) {
          await descendantHandle.pause();
          markCascadePaused(descendant.id, pausedStageId);
        }
        continue;
      }
      blockStageUntilCascadeRelease(descendant, pausedStageId);
    }
  };

  const cascadeResumeFrom = async (resumedStageId: string): Promise<void> => {
    const stageRegistry = opts.stageControlRegistry ?? defaultStageControlRegistry;
    for (const descendant of descendantsOf(resumedStageId)) {
      if (isTerminalStage(descendant)) continue;
      if (descendant.status === "blocked") {
        if (blockingAncestorFor(descendant) !== undefined) continue;
        if (activeStore.recordStageUnblocked(runId, descendant.id)) {
          releaseStageBarrier(descendant.id);
        }
        continue;
      }
      if (descendant.status === "paused") {
        const ownedByResumedStage = releaseCascadePauseOwner(descendant.id, resumedStageId);
        if (!ownedByResumedStage) continue;
        if (cascadePauseOwners.has(descendant.id)) continue;
        if (blockingAncestorFor(descendant) !== undefined) continue;
        const descendantHandle = stageRegistry.get(runId, descendant.id);
        if (descendantHandle?.status === "paused") {
          await descendantHandle.resume();
        }
      }
    }
  };

  const rejectReleaseBarriers = (reason: unknown): void => {
    cascadePauseOwners.clear();
    for (const [stageId, barrier] of releaseBarriers) {
      releaseBarriers.delete(stageId);
      activeStore.recordStageUnblocked(runId, stageId);
      barrier.reject(reason);
    }
  };

  ownController.signal.addEventListener(
    "abort",
    () => rejectReleaseBarriers(ownController.signal.reason ?? new Error("atomic-workflows: run aborted")),
    { once: true },
  );

  interface WorkflowBoundaryStage {
    readonly id: string;
    readonly replayedChild?: WorkflowChildResult;
    finalizeReplay(): void;
    linkChildRun(ref: WorkflowChildRunRef): void;
    complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): void;
    fail(error: unknown): void;
  }

  const workflowChildResultFromReplay = (snapshot: WorkflowChildReplaySnapshot): WorkflowChildResult => ({
    workflow: snapshot.workflow,
    runId: snapshot.runId,
    status: snapshot.status,
    outputs: cloneWorkflowChildValue(snapshot.outputs),
  });

  const workflowBoundaryReplayCounts = new Map<string, number>();
  const nextWorkflowBoundaryReplayKey = (name: string): string => {
    const next = (workflowBoundaryReplayCounts.get(name) ?? 0) + 1;
    workflowBoundaryReplayCounts.set(name, next);
    return `workflow:${name}:${next}`;
  };

  const startWorkflowBoundaryStage = (name: string, replayKey: string): WorkflowBoundaryStage => {
    const stageId = crypto.randomUUID();
    const provisionalParentIds = tracker.onSpawn(stageId, name);
    const replayDecision = replayIndex.decide({
      displayName: name,
      replayKey,
      parentIds: provisionalParentIds,
      stageId,
      kind: "workflow",
    });
    const parentIds = replayDecision.parentIds;
    if (!sameStringSet(parentIds, provisionalParentIds)) {
      tracker.replaceParents(stageId, parentIds);
    }
    const replaySource = replayDecision.source;
    const replayChildSnapshot = replayDecision.kind === "replay" ? replayDecision.source.workflowChild : undefined;
    const replayedChild = replayChildSnapshot !== undefined
      ? workflowChildResultFromReplay(replayChildSnapshot)
      : undefined;
    const startedAt = Date.now();
    const stageSnapshot: StageSnapshot = {
      id: stageId,
      name,
      replayKey,
      status: replayedChild !== undefined ? "completed" : "running",
      parentIds: Object.freeze([...parentIds]),
      startedAt,
      toolEvents: [],
      attachable: false,
      ...(replaySource !== undefined ? {
        replayedFromStageId: replaySource.id,
        replayed: replayedChild !== undefined,
      } : {}),
      ...(replayedChild !== undefined && replayChildSnapshot !== undefined ? {
        endedAt: startedAt,
        durationMs: 0,
        ...(replayDecision.kind === "replay" && replayDecision.source.result !== undefined ? { result: replayDecision.source.result } : {}),
        workflowChild: cloneWorkflowChildReplaySnapshot(replayChildSnapshot),
      } : {}),
    };
    let finalized = false;

    const appendStageStartOnce = (): void => {
      if (!opts.persistence) return;
      appendStageStart(opts.persistence, {
        runId,
        stageId,
        name,
        parentIds: stageSnapshot.parentIds,
        ...stageReplayFields(stageSnapshot),
        ts: startedAt,
      });
    };

    const appendStageEndForSnapshot = (): void => {
      if (!opts.persistence) return;
      appendStageEnd(opts.persistence, {
        runId,
        stageId,
        status: stageSnapshot.status,
        durationMs: stageSnapshot.durationMs,
        ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
        ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
        ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
        ...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed" ? { summary: stageSnapshot.result } : {}),
        ...stageReplayFields(stageSnapshot),
        ...(stageSnapshot.workflowChild !== undefined ? { workflowChild: stageSnapshot.workflowChild } : {}),
      });
    };

    const finalize = (
      status: "completed" | "failed",
      summaryOrError: string,
      workflowChild?: WorkflowChildReplaySnapshot,
      failureError?: unknown,
    ): void => {
      if (finalized) return;
      finalized = true;
      stageSnapshot.status = status;
      if (status === "completed") {
        stageSnapshot.result = summaryOrError;
        if (workflowChild !== undefined) stageSnapshot.workflowChild = workflowChild;
      } else {
        const failure = classifyWorkflowFailure(failureError);
        stageSnapshot.error = failure.userMessage;
        stageSnapshot.failureKind = failure.kind;
        stageSnapshot.failureMessage = failure.message;
      }
      stageSnapshot.endedAt = Date.now();
      stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
      activeStore.recordStageEnd(runId, stageSnapshot);
      opts.onStageEnd?.(runId, stageSnapshot);
      appendStageEndForSnapshot();
      tracker.onSettle(stageId);
    };

    activeStore.recordStageStart(runId, stageSnapshot);
    opts.onStageStart?.(runId, stageSnapshot);
    appendStageStartOnce();

    const finalizeReplay = (): void => {
      if (replayedChild === undefined || finalized) return;
      finalized = true;
      activeStore.recordStageEnd(runId, stageSnapshot);
      opts.onStageEnd?.(runId, stageSnapshot);
      appendStageEndForSnapshot();
      tracker.onSettle(stageId);
    };

    const linkChildRun = (ref: WorkflowChildRunRef): void => {
      if (finalized) return;
      stageSnapshot.workflowChildRun = { ...ref };
      activeStore.recordStageWorkflowChildRun(runId, stageId, ref);
    };

    return {
      id: stageId,
      ...(replayedChild !== undefined ? { replayedChild } : {}),
      finalizeReplay,
      linkChildRun,
      complete(summary: string, workflowChild: WorkflowChildReplaySnapshot): void {
        finalize("completed", summary, workflowChild);
      },
      fail(error: unknown): void {
        finalize("failed", error instanceof Error ? error.message : String(error), undefined, error);
      },
    };
  };

  const buildPromptNodeUiAdapter = (): WorkflowUIAdapter => {
    const ask = async (descriptor: PromptDescriptor): Promise<unknown> => {
      if (ownController.signal.aborted) {
        return fallbackForPromptDescriptor(descriptor);
      }

      const prompt = makePrompt(descriptor);
      const stageId = crypto.randomUUID();
      const provisionalParentIds = tracker.onSpawn(stageId, descriptor.kind);
      const replayKey = promptReplayKey(descriptor);
      const replayDecision = replayIndex.decide({
        displayName: descriptor.kind,
        replayKey,
        parentIds: provisionalParentIds,
        stageId,
        kind: "prompt",
      });
      const parentIds = replayDecision.parentIds;
      if (!sameStringSet(parentIds, provisionalParentIds)) {
        tracker.replaceParents(stageId, parentIds);
      }
      const replaySource = replayDecision.source;
      const replayAnswer = replayDecision.kind === "replay"
        // Replay decisions are only produced when continuation is present.
        ? activeStore.getStagePromptAnswer(opts.continuation!.source.id, replayDecision.source.id)
        : undefined;
      const shouldReplay = replayAnswer !== undefined;
      if (shouldReplay) {
        replayIndex.markPromptAnswerReplayed(stageId);
      }
      const replaySourceId = replaySource?.id;
      const promptAnswerStatus = getPromptAnswerState(shouldReplay, replaySourceId, replayDecision.answerReplay);
      const stageSnapshot: StageSnapshot = {
        id: stageId,
        name: descriptor.kind,
        replayKey,
        status: shouldReplay ? "completed" : "running",
        parentIds: Object.freeze(parentIds),
        startedAt: prompt.createdAt,
        promptFootprint: { ...prompt },
        toolEvents: [],
        attachable: !shouldReplay,
        ...(shouldReplay ? {
          endedAt: prompt.createdAt,
          durationMs: 0,
          promptAnswerState: promptAnswerStatus,
          replayedFromStageId: replaySourceId,
          replayed: true,
        } : replaySourceId !== undefined ? {
          promptAnswerState: promptAnswerStatus,
          replayedFromStageId: replaySourceId,
          replayed: false,
        } : {}),
      };
      let finalized = false;
      const finalizePromptStage = (status: "completed" | "failed" | "skipped"): void => {
        if (finalized) return;
        finalized = true;
        stageSnapshot.status = status;
        stageSnapshot.endedAt = Date.now();
        stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);
        activeStore.recordStageAttachable(runId, stageId, false);
        activeStore.recordStageEnd(runId, stageSnapshot);
        opts.onStageEnd?.(runId, stageSnapshot);
        if (opts.persistence) {
          appendStageEnd(opts.persistence, {
            runId,
            stageId,
            status: stageSnapshot.status,
            durationMs: stageSnapshot.durationMs,
            ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
            ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
            ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
            ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
            ...stageReplayFields(stageSnapshot),
          });
        }
        tracker.onSettle(stageId);
      };

      activeStore.recordStageStart(runId, stageSnapshot);
      opts.onStageStart?.(runId, stageSnapshot);
      if (opts.persistence) {
        appendStageStart(opts.persistence, {
          runId,
          stageId,
          name: stageSnapshot.name,
          parentIds: stageSnapshot.parentIds,
          ...stageReplayFields(stageSnapshot),
          ts: prompt.createdAt,
        });
      }
      if (shouldReplay) {
        await Promise.resolve();
        finalizePromptStage("completed");
        return replayAnswer.value;
      }
      const accepted = activeStore.recordStagePendingPrompt(runId, stageId, prompt);
      if (!accepted) {
        stageSnapshot.skippedReason = "prompt-unavailable";
        finalizePromptStage("skipped");
        return fallbackForPromptDescriptor(descriptor);
      }

      const waiter = activeStore.awaitStagePendingPrompt(runId, stageId, prompt.id);
      try {
        const response = await new Promise<unknown>((resolve, reject) => {
          const onAbort = (): void => {
            activeStore.resolveStagePendingPrompt(
              runId,
              stageId,
              prompt.id,
              fallbackForPromptDescriptor(descriptor),
              { recordAnswer: false },
            );
            reject(hilAbortError(ownController.signal));
          };
          if (ownController.signal.aborted) {
            onAbort();
            return;
          }
          ownController.signal.addEventListener("abort", onAbort, { once: true });
          waiter.then(
            (value) => {
              ownController.signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (err: unknown) => {
              ownController.signal.removeEventListener("abort", onAbort);
              reject(err);
            },
          );
        });
        finalizePromptStage("completed");
        return response;
      } catch (err) {
        if (ownController.signal.aborted) {
          stageSnapshot.skippedReason = "run-aborted";
          finalizePromptStage("skipped");
        } else {
          applyFailureToStage(stageSnapshot, classifyWorkflowFailure(err));
          finalizePromptStage("failed");
        }
        throw err;
      }
    };

    return {
      async input(promptText: string): Promise<string> {
        const response = await ask({ kind: "input", message: promptText });
        return typeof response === "string" ? response : String(response ?? "");
      },
      async confirm(message: string): Promise<boolean> {
        const response = await ask({ kind: "confirm", message });
        return response === true;
      },
      async select<T extends string>(message: string, options: readonly T[]): Promise<T> {
        if (options.length === 0) {
          throw new Error("atomic-workflows: ctx.ui.select requires at least one option");
        }
        const response = await ask({ kind: "select", message, choices: options });
        if (typeof response === "string" && (options as readonly string[]).includes(response)) {
          return response as T;
        }
        return options[0]!;
      },
      async editor(initial?: string): Promise<string> {
        const response = await ask({
          kind: "editor",
          message: "Edit and save to continue.",
          initial,
        });
        return typeof response === "string" ? response : initial ?? "";
      },
    };
  };

  // 5. Build WorkflowRunContext
  const ctx: WorkflowRunContext<TInputs> = {
    inputs: resolvedInputs as TInputs,
    get cwd() { return resolveWorkflowCwd(); },
    // Prompt nodes and caller-provided UI adapters are mutually exclusive;
    // executor-owned prompt nodes intentionally take precedence when enabled.
    ui: opts.usePromptNodesForUi === true ? buildPromptNodeUiAdapter() : opts.ui ?? makeUnavailableUIContext(),

    stage(name: string, options?: StageOptions, stageFailFastScope?: ParallelFailFastScope) {
      const baseStageOptions = stageOptionsWithGitWorktree(stageOptionsWithInputDefaults(options, inputRuntimeDefaults), workflowInvocationCwd);
      // a. Generate stageId
      const stageId = crypto.randomUUID();
      options = stageOptionsWithWorkflowMetadata(baseStageOptions, {
        originSessionFile: opts.workflowOriginSessionFile,
        runId,
        workflowName: def.name,
        stageId,
        stageName: name,
      });

      // b. tracker.onSpawn → provisional parentIds
      const provisionalParentIds = tracker.onSpawn(stageId, name);

      // c. Create StageSnapshot as "pending"
      const replayKey = `stage:${name}`;
      const replayDecision = replayIndex.decide({
        displayName: name,
        replayKey,
        parentIds: provisionalParentIds,
        stageId,
        kind: "stage",
      });
      const parentIds = replayDecision.parentIds;
      if (!sameStringSet(parentIds, provisionalParentIds)) {
        tracker.replaceParents(stageId, parentIds);
      }
      const replaySource = replayDecision.kind === "replay" ? replayDecision.source : undefined;
      const shouldReplay = replaySource !== undefined;

      const stageSnapshot: StageSnapshot = {
        id: stageId,
        name,
        replayKey,
        status: shouldReplay ? "completed" : "pending",
        parentIds: Object.freeze(parentIds),
        toolEvents: [],
        ...(shouldReplay ? {
          startedAt: Date.now(),
          endedAt: Date.now(),
          durationMs: 0,
          ...(replaySource.result !== undefined ? { result: replaySource.result } : {}),
          replayedFromStageId: replaySource.id,
          replayed: true,
        } : {}),
        // Store mcp scope options on snapshot when provided
        ...(options?.mcp !== undefined
          ? { mcpScope: { allow: options.mcp.allow ?? null, deny: options.mcp.deny ?? null } }
          : {}),
        // Mark attachable up-front: the live stage handle is registered
        // below before the first onStageStart fires, so consumers that
        // hook onStageStart see `attachable: true` for the pending stage.
        attachable: !shouldReplay,
      };

      let stageStartEntryAppended = false;
      const appendStageStartOnce = (): void => {
        if (!opts.persistence || stageStartEntryAppended) return;
        stageStartEntryAppended = true;
        appendStageStart(opts.persistence, {
          runId,
          stageId,
          name,
          parentIds: stageSnapshot.parentIds,
          ...stageReplayFields(stageSnapshot),
          ts: stageSnapshot.startedAt ?? Date.now(),
        });
      };

      if (shouldReplay) {
        activeStore.recordStageStart(runId, stageSnapshot);
        opts.onStageStart?.(runId, stageSnapshot);
        appendStageStartOnce();
        let replayFinalized = false;
        const finalizeReplayStage = (): void => {
          if (replayFinalized) return;
          replayFinalized = true;
          activeStore.recordStageEnd(runId, stageSnapshot);
          opts.onStageEnd?.(runId, stageSnapshot);
          if (opts.persistence) {
            appendStageEnd(opts.persistence, {
              runId,
              stageId,
              status: "completed",
              durationMs: 0,
              ...(stageSnapshot.result !== undefined ? { summary: stageSnapshot.result } : {}),
              ...stageReplayFields(stageSnapshot),
            });
          }
          tracker.onSettle(stageId);
        };
        const replayResult = replaySource.result ?? "";
        const replayText = async (): Promise<string> => {
          await Promise.resolve();
          finalizeReplayStage();
          return replayResult;
        };
        const rejectReplayMutation = (action: string): never => {
          throw new Error(`atomic-workflows: replayed stage "${name}" cannot ${action}`);
        };
        const replayContext: InternalStageContext = {
          name,
          prompt: replayText,
          complete: replayText,
          steer: async () => rejectReplayMutation("steer"),
          followUp: async () => rejectReplayMutation("follow up"),
          subscribe: () => () => {},
          get sessionFile() { return replaySource.sessionFile; },
          get sessionId() { return replaySource.sessionId ?? ""; },
          setModel: async () => rejectReplayMutation("set model"),
          setThinkingLevel: () => rejectReplayMutation("set thinking level"),
          cycleModel: async () => rejectReplayMutation("cycle model"),
          cycleThinkingLevel: () => rejectReplayMutation("cycle thinking level"),
          get agent() { return undefined as never; },
          get model() { return replaySource.model as never; },
          get thinkingLevel() { return undefined as never; },
          get messages() { return [] as never; },
          get isStreaming() { return false; },
          navigateTree: async () => rejectReplayMutation("navigate conversation tree"),
          compact: async () => rejectReplayMutation("compact"),
          abortCompaction: () => rejectReplayMutation("abort compaction"),
          abort: async () => rejectReplayMutation("abort"),
          __dispose: async () => {},
          __getLastAssistantText: () => replayResult,
          getLastAssistantText: () => replayResult,
          __ensureSession: async () => {},
          __sessionMeta: () => ({
            sessionId: replaySource.sessionId,
            sessionFile: replaySource.sessionFile,
          }),
          __agentSession: () => undefined,
          __pendingMessageCount: () => 0,
          __modelFallbackMeta: () => ({
            ...(replaySource.model !== undefined ? { model: replaySource.model } : {}),
            ...(replaySource.fastMode === true ? { fastMode: replaySource.fastMode } : {}),
            ...(replaySource.attemptedModels !== undefined ? { attemptedModels: replaySource.attemptedModels } : {}),
            ...(replaySource.modelAttempts !== undefined ? { modelAttempts: replaySource.modelAttempts } : {}),
          }),
          __requestPause: async () => rejectReplayMutation("pause"),
          __resume: async () => rejectReplayMutation("resume"),
          __isPaused: () => false,
        };
        return replayContext;
      }

      // d. Create inner AgentSession-like StageContext (raw, without lifecycle wrapping).
      //    Must come before the registry registration because the handle
      //    delegates to it for every operation.
      const applyModelFallbackMeta = (meta: ReturnType<InternalStageContext["__modelFallbackMeta"]>): void => {
        if (meta.model !== undefined) stageSnapshot.model = meta.model;
        if (meta.fastMode !== undefined) {
          if (meta.fastMode) stageSnapshot.fastMode = true;
          else delete stageSnapshot.fastMode;
        }
        if (meta.attemptedModels !== undefined) stageSnapshot.attemptedModels = meta.attemptedModels;
        if (meta.modelAttempts !== undefined) stageSnapshot.modelAttempts = meta.modelAttempts;
      };

      const innerCtx: InternalStageContext = createStageContext({
        stageId,
        stageName: name,
        adapters,
        runId,
        signal: ownController.signal,
        stageOptions: options,
        models: opts.models,
        executionMode: opts.executionMode,
        onModelFallbackMetaChange(meta) {
          applyModelFallbackMeta(meta);
          if (stageSnapshot.status === "running") {
            activeStore.recordStageStart(runId, stageSnapshot);
          }
        },
      });
      const activeAskUserQuestionCalls = new Set<string>();
      let activeAskUserQuestionAnonymousCalls = 0;
      // Set whenever an ask_user_question tool call is observed during the
      // current model turn. Drives the deterministic readiness gate (#1099):
      // after a turn that asked the user a question ends, the workflow must
      // confirm readiness before completing/advancing the stage.
      let askUserQuestionObservedThisTurn = false;
      const hasActiveAskUserQuestion = (): boolean =>
        activeAskUserQuestionCalls.size > 0 || activeAskUserQuestionAnonymousCalls > 0;
      const unsubscribeAskUserQuestionWatcher = innerCtx.subscribe((event) => {
        const toolEvent = askUserQuestionToolEvent(event);
        if (!toolEvent) return;
        if (toolEvent.phase === "start") {
          askUserQuestionObservedThisTurn = true;
          if (toolEvent.callId !== undefined) activeAskUserQuestionCalls.add(toolEvent.callId);
          else activeAskUserQuestionAnonymousCalls += 1;
          // Expose a headless-answer adapter before marking the stage awaiting
          // input so the main-chat steering notice can include the actual
          // structured question instead of a promptless placeholder.
          const adapter = buildStagePromptAdapter(
            toolEvent.callId ?? `ask-user-question-${stageId}`,
            "ask_user_question",
            toolEvent.args,
            Date.now(),
          );
          if (adapter) stageUiBroker.provideStagePrompt(runId, stageId, adapter);
          activeStore.recordStageAwaitingInput(runId, stageId, true);
          return;
        }

        if (toolEvent.callId !== undefined && activeAskUserQuestionCalls.has(toolEvent.callId)) {
          activeAskUserQuestionCalls.delete(toolEvent.callId);
        } else if (toolEvent.callId === undefined && toolEvent.nameMatched) {
          activeAskUserQuestionAnonymousCalls = Math.max(0, activeAskUserQuestionAnonymousCalls - 1);
        } else {
          return;
        }

        if (!hasActiveAskUserQuestion()) {
          activeStore.recordStageAwaitingInput(runId, stageId, false);
          stageUiBroker.clearStagePrompt(runId, stageId);
        }
      });
      const disposeInnerContext = async (): Promise<void> => {
        unsubscribeAskUserQuestionWatcher();
        activeAskUserQuestionCalls.clear();
        activeAskUserQuestionAnonymousCalls = 0;
        activeStore.recordStageAwaitingInput(runId, stageId, false);
        stageUiBroker.clearStagePrompt(runId, stageId);
        await innerCtx.__dispose();
      };
      let unregisterStageHandle = (): void => {};
      let dropStageControlHandle = (): void => {};
      let liveHandleReleased = false;
      const releaseLiveHandle = async (): Promise<void> => {
        if (liveHandleReleased) return;
        liveHandleReleased = true;
        dropStageControlHandle();
        unregisterStageHandle();
        await disposeInnerContext();
      };
      const dropStageControlForCompletion = async (): Promise<void> => {
        // Completion removes the stage from workflow-level pause/resume and
        // dependency cascades, but must not turn the attached/reopenable chat
        // into a read-only archive. Keep the direct live handle registered for
        // post-completion follow-ups until the registry/store is explicitly
        // cleared by the host.
        dropStageControlHandle();
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
        get isDisposed() {
          return liveHandleReleased;
        },
        get messages() {
          return innerCtx.messages;
        },
        get agentSession() {
          return innerCtx.__agentSession();
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
          const statusBeforePause = stageSnapshot.status;
          const changed = activeStore.recordStagePaused(runId, stageId);
          if (changed) {
            ensureReleaseBarrier(stageId);
            await cascadePauseFrom(stageId);
          }
          if (statusBeforePause === "pending" || statusBeforePause === "running" || innerCtx.isStreaming) {
            await innerCtx.__requestPause();
          }
        },
        async resume(message?: string) {
          const changed = activeStore.recordStageResumed(runId, stageId);
          if (changed) {
            releaseStageBarrier(stageId);
            await cascadeResumeFrom(stageId);
          }
          await innerCtx.__resume(message);
        },
        subscribe(listener: AgentSessionEventListener) {
          return innerCtx.subscribe(listener);
        },
        async dispose() {
          await releaseLiveHandle();
        },
      };
      let stageFinalized = false;
      const finalizeStageSnapshot = (): boolean => {
        if (stageFinalized) return false;
        stageFinalized = true;
        stageSnapshot.endedAt = Date.now();
        stageSnapshot.durationMs = elapsedStageMs(stageSnapshot, stageSnapshot.endedAt);

        applyModelFallbackMeta(innerCtx.__modelFallbackMeta());

        activeStore.recordStageEnd(runId, stageSnapshot);
        stageUiBroker.cancelStagePrompt(
          runId,
          stageId,
          new Error(`atomic-workflows: stage ${stageId} completed with pending custom UI`),
        );
        opts.onStageEnd?.(runId, stageSnapshot);

        if (opts.persistence) {
          appendStageStartOnce();
          appendStageEnd(opts.persistence, {
            runId,
            stageId,
            status: stageSnapshot.status,
            durationMs: stageSnapshot.durationMs,
            ...(stageSnapshot.error !== undefined ? { error: stageSnapshot.error } : {}),
            ...(stageSnapshot.failureKind !== undefined ? { failureKind: stageSnapshot.failureKind } : {}),
            ...(stageSnapshot.failureMessage !== undefined ? { failureMessage: stageSnapshot.failureMessage } : {}),
            ...(stageSnapshot.skippedReason !== undefined ? { skippedReason: stageSnapshot.skippedReason } : {}),
            ...(stageSnapshot.result !== undefined && stageSnapshot.status === "completed" ? { summary: stageSnapshot.result } : {}),
            ...stageReplayFields(stageSnapshot),
          });
        }

        stageFailFastScope?.activeStages.delete(stageId);
        tracker.onSettle(stageId);
        return true;
      };
      let skippedForParallelFailFast = false;
      const markSkippedForParallelFailFast = (): void => {
        skippedForParallelFailFast = true;
        stageSnapshot.status = "skipped";
        stageSnapshot.skippedReason = "fail-fast";
      };
      const parallelFailFastError = (): unknown =>
        stageFailFastScope?.firstFailure ?? new Error("atomic-workflows: skipped after parallel fail-fast");
      const skipForParallelFailFast = (): void => {
        if (isTerminalStage(stageSnapshot)) return;
        markSkippedForParallelFailFast();
        finalizeStageSnapshot();
        void innerCtx.abort().catch(() => {});
        void dropStageControlForCompletion().catch(() => {});
      };
      stageFailFastScope?.activeStages.set(stageId, { skip: skipForParallelFailFast });

      let stageControlDropped = false;
      dropStageControlHandle = (): void => {
        if (stageControlDropped) return;
        stageControlDropped = true;
        activeStore.recordStageAttachable(runId, stageId, false);
        stageRegistry.detachControl(runId, stageId, handle);
      };
      unregisterStageHandle = stageRegistry.register(handle);

      // f. Record stage start in store (as pending), call onStageStart.
      activeStore.recordStageStart(runId, stageSnapshot);
      opts.onStageStart?.(runId, stageSnapshot);
      const blockedBy = blockingAncestorFor(stageSnapshot);
      if (blockedBy !== undefined) {
        blockStageUntilCascadeRelease(stageSnapshot, blockedBy);
      }


      const waitForStageRelease = async (): Promise<void> => {
        while (true) {
          const barrier = releaseBarriers.get(stageId);
          if (!barrier) return;
          try {
            await barrier.promise;
          } catch (err) {
            await releaseLiveHandle();
            throw err;
          }
        }
      };

      // Deterministic readiness gate (#1099). After a model turn that issued an
      // ask_user_question tool call ends, confirm with the user before the stage
      // completes/advances. "No" keeps execution in this stage (steer + re-gate
      // after the next turn); "Yes" resumes progression. The gate engages only
      // when a confirmation seam is available, so headless/test runs proceed.
      const readinessGateEnabled =
        opts.confirmStageReadiness !== undefined || opts.usePromptNodesForUi === true;
      const confirmReadiness = async (): Promise<"advance" | "stay"> => {
        try {
          if (opts.confirmStageReadiness !== undefined) {
            const ready = await opts.confirmStageReadiness({
              runId,
              stageId,
              stageName: name,
              signal: ownController.signal,
            });
            return ready ? "advance" : "stay";
          }
          return await askReadinessViaStageBroker(runId, stageId, ownController.signal);
        } catch {
          // A gate failure must not strand the workflow; proceed on error.
          return "advance";
        }
      };

      const runTrackedStageCall = async (call: () => Promise<string>, eagerSession = false): Promise<string> => {
        await waitForStageRelease();
        if (stageFinalized) {
          throw parallelFailFastError();
        }

        // Block here until a concurrency slot is available for this run.
        await limiter.acquire();

        try {
          await waitForStageRelease();
          if (stageFinalized) {
            throw parallelFailFastError();
          }
        } catch (err) {
          limiter.release();
          throw err;
        }

        if (opts.continuation === undefined && stageSnapshot.startedAt === undefined) {
          const actualParentIds = tracker.currentParents();
          if (!sameStringSet(actualParentIds, stageSnapshot.parentIds)) {
            tracker.replaceParents(stageId, actualParentIds);
            setStageParentIds(stageSnapshot, actualParentIds);
          }
        }
        stageSnapshot.status = "running";
        stageSnapshot.startedAt = Date.now();
        const hasExplicitFastModeCandidate = async (): Promise<boolean> => {
          const rawCandidate = isCodexFastModeCandidateModelId(workflowModelId(options?.model))
            || (Array.isArray(options?.fallbackModels) && options.fallbackModels.some((candidate) => isCodexFastModeCandidateModelId(workflowModelId(candidate))));
          if (rawCandidate) return true;
          try {
            const candidates = await buildModelCandidatesFromCatalog({
              primaryModel: options?.model,
              fallbackModels: options?.fallbackModels,
              catalog: opts.models,
            });
            return candidates.some((candidate) => isCodexFastModeCandidateModelId(candidate.id));
          } catch {
            return false;
          }
        };
        const hasNoExplicitModelConfig = options?.model === undefined && options?.fallbackModels === undefined;
        const promptAdapterHandlesInitialPrompt = adapters.prompt !== undefined;
        if (eagerSession && !promptAdapterHandlesInitialPrompt && (hasNoExplicitModelConfig || await hasExplicitFastModeCandidate())) {
          try {
            await innerCtx.__ensureSession();
          } catch (err) {
            if (!(err instanceof Error && err.message.includes("prompt adapter not configured"))) {
              throw err;
            }
          }
        }
        applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
        activeStore.recordStageStart(runId, stageSnapshot);

        // Persistence: append stage.start entry
        appendStageStartOnce();

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
            // Run the stage's initial agent turn.
            askUserQuestionObservedThisTurn = false;
            result = await raceAbort(call(), ownController.signal);

            // Per-turn readiness gate (#1099). When an agent turn ENDS (control
            // returns to the user): if the turn issued no ask_user_question
            // call, complete/advance automatically; if it DID, show the gate.
            // "advance" completes the stage; anything else hands control back to
            // the user, who keeps working in the normal stage composer — we wait
            // for their next turn to end (the session's agent_end event) and
            // re-apply the same check. No canned auto-steer, so the user is
            // never trapped re-gating and the stage never auto-drives a hidden
            // turn that could strand the stream.
            if (!ownController.signal.aborted && readinessGateEnabled) {
              let resolveNextTurnEnd: (() => void) | null = null;
              const unsubscribeTurnWatcher = innerCtx.subscribe((event) => {
                if ((event as { type?: unknown }).type === "agent_end" && resolveNextTurnEnd) {
                  const resolve = resolveNextTurnEnd;
                  resolveNextTurnEnd = null;
                  resolve();
                }
              });
              try {
                while (askUserQuestionObservedThisTurn) {
                  if ((await confirmReadiness()) === "advance") break;
                  if (ownController.signal.aborted) break;
                  // Stay: return control to the user and await their next
                  // composer-driven turn end before re-checking.
                  askUserQuestionObservedThisTurn = false;
                  await raceAbort(
                    new Promise<void>((resolve) => {
                      resolveNextTurnEnd = resolve;
                    }),
                    ownController.signal,
                  );
                  if (ownController.signal.aborted) break;
                  result = innerCtx.__getLastAssistantText() ?? result;
                }
              } finally {
                resolveNextTurnEnd = null;
                unsubscribeTurnWatcher();
              }
            }
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
            applyModelFallbackMeta(innerCtx.__modelFallbackMeta());
          }
          if (stageFailFastScope?.failed === true && stageFailFastScope.activeStages.has(stageId)) {
            markSkippedForParallelFailFast();
            throw parallelFailFastError();
          }
          if (stageFinalized) {
            throw parallelFailFastError();
          }
          stageSnapshot.status = "completed";
          const assistantText = innerCtx.__getLastAssistantText();
          if (assistantText !== undefined) {
            stageSnapshot.result = assistantText;
          }
          return result;
        } catch (err) {
          if (!ownController.signal.aborted && !skippedForParallelFailFast) {
            applyFailureToStage(stageSnapshot, classifyWorkflowFailure(err));
          }
          throw err;
        } finally {
          if (opts.mcp && hasMcpScope) {
            opts.mcp.clearScope(stageId);
          }

          finalizeStageSnapshot();
          // The stage has finished participating in workflow scheduling. Drop it
          // from run-level pause/resume and cascade-pause lookups immediately,
          // while retaining the direct chat handle so completed nodes can be
          // reopened and continued instead of becoming read-only archives.
          await dropStageControlForCompletion().catch(() => {});
          limiter.release();
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

      const stageContext: StageContext & Pick<InternalStageContext, "__modelFallbackMeta"> = {
        name: innerCtx.name,
        prompt: (text, promptOptions) => runTrackedStageCall(() => innerCtx.prompt(text, promptOptions), true),
        complete: (text, completeOptions) => runTrackedStageCall(() => innerCtx.complete(text, completeOptions)),
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
        __modelFallbackMeta: () => innerCtx.__modelFallbackMeta(),
      };
      return stageContext;
    },

    async task(name: string, options: WorkflowTaskOptions, stageFailFastScope?: ParallelFailFastScope): Promise<WorkflowTaskResult> {
      const runTaskOnce = async (taskOptions: WorkflowTaskOptions): Promise<WorkflowTaskResult> => {
        const resolvedTaskOptions = stageOptionsWithGitWorktree(stageOptionsWithInputDefaults(taskOptions, inputRuntimeDefaults), workflowInvocationCwd) ?? taskOptions;
        const stage = (ctx.stage as typeof ctx.stage & ((stageName: string, stageOptions?: StageOptions, scope?: ParallelFailFastScope) => StageContext))(
          name,
          taskStageOptions(resolvedTaskOptions),
          stageFailFastScope,
        );
        const rawText = await stage.prompt(
          applyTaskContext(`${taskReadInstruction(resolvedTaskOptions)}${taskPrompt(resolvedTaskOptions)}`, taskPrevious(resolvedTaskOptions)),
          taskPromptOptions(resolvedTaskOptions),
        );
        const text = truncateTaskOutput(rawText, resolvedTaskOptions.maxOutput);
        const sessionId = (() => {
          try {
            return stage.sessionId;
          } catch {
            return undefined;
          }
        })();
        const stageMeta = (stage as InternalStageContext).__modelFallbackMeta?.() ?? {};
        return {
          name,
          stageName: name,
          text,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(stage.sessionFile !== undefined ? { sessionFile: stage.sessionFile } : {}),
          ...(stageMeta.model !== undefined ? { model: stageMeta.model } : {}),
          ...(stageMeta.fastMode === true ? { fastMode: stageMeta.fastMode } : {}),
          ...(stageMeta.attemptedModels !== undefined ? { attemptedModels: stageMeta.attemptedModels } : {}),
          ...(stageMeta.modelAttempts !== undefined ? { modelAttempts: stageMeta.modelAttempts } : {}),
          ...(stageMeta.warnings !== undefined ? { warnings: stageMeta.warnings } : {}),
        };
      };

      if (options.worktree !== true) return runTaskOnce(options);

      const prepared = prepareDirectWorktrees(
        [{ ...options, name }],
        { ...options, worktree: true },
        `${runId}-${name}-${crypto.randomUUID()}`,
        name,
      );
      const preparedTask = prepared.tasks[0]!;
      try {
        const result = await runTaskOnce(preparedTask);
        const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
        return worktreeDiffs.artifacts.length === 0
          ? result
          : { ...result, artifacts: [...(result.artifacts ?? []), ...worktreeDiffs.artifacts] };
      } finally {
        if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
      }
    },

    async chain(steps: readonly WorkflowTaskStep[], options: WorkflowChainOptions = {}): Promise<WorkflowTaskResult[]> {
      const results: WorkflowTaskResult[] = [];
      for (let index = 0; index < steps.length; index += 1) {
        const step = steps[index]!;
        const explicitPrevious = taskPrevious(step);
        const previous = explicitPrevious ?? (index > 0 ? results[index - 1] : undefined);
        const prompt = replaceTaskPlaceholder(chainStepPrompt(step, index), options.task ?? "");
        results.push(await ctx.task(
          step.name,
          taskWithSharedDefaults(taskOptionsFromStep(step, prompt, previous), options),
        ));
      }
      return results;
    },

    async parallel(steps: readonly WorkflowTaskStep[], options: WorkflowParallelOptions = {}): Promise<WorkflowTaskResult[]> {
      const fallback = parallelFallbackTask(steps, options);
      const failFastScope: ParallelFailFastScope | undefined = options.failFast === false
        ? undefined
        : { failed: false, activeStages: new Map<string, ParallelFailFastStage>() };
      return mapParallelSteps(steps, options.concurrency, options.failFast, async (step) => {
        const prompt = replaceTaskPlaceholder(step.prompt ?? step.task ?? fallback, options.task ?? fallback);
        return await (ctx.task as typeof ctx.task & ((taskName: string, taskOptions: WorkflowTaskOptions, scope?: ParallelFailFastScope) => Promise<WorkflowTaskResult>))(
          step.name,
          taskWithSharedDefaults(taskOptionsFromStep(step, prompt, taskPrevious(step)), options),
          failFastScope,
        );
      }, (error) => {
        if (failFastScope === undefined) return;
        failFastScope.failed = true;
        failFastScope.firstFailure = error;
        for (const stage of failFastScope.activeStages.values()) {
          stage.skip();
        }
      });
    },

    async workflow<TChildInputs extends WorkflowInputValues, TChildOutputs extends WorkflowOutputValues>(
      child: WorkflowDefinition<TChildInputs, TChildOutputs>,
      options: WorkflowRunChildOptions<TChildInputs> = {},
    ): Promise<WorkflowChildResult<TChildOutputs>> {
      // The executor operates on type-erased definitions at runtime; the child's
      // declared output contract is validated dynamically by the child run and
      // selectWorkflowOutputs, so the typed result is reconstructed via casts.
      if (!isWorkflowDefinition(child)) {
        throw new Error(workflowDefinitionRequirementMessage("ctx.workflow(definition)", child));
      }
      const childName = child.normalizedName;
      const boundaryName = options.stageName ?? `workflow:${childName}`;
      const boundaryReplayKey = nextWorkflowBoundaryReplayKey(boundaryName);
      const boundary = startWorkflowBoundaryStage(boundaryName, boundaryReplayKey);
      if (boundary.replayedChild !== undefined) {
        // Continuation replay returns the persisted child boundary exactly as
        // written; input validation and output remapping are intentionally not
        // re-run against edited workflow code for a completed child boundary.
        // Defer settling by one microtask so concurrent replayed boundaries
        // spawned in the same turn see the same frontier as the source run.
        await Promise.resolve();
        boundary.finalizeReplay();
        return boundary.replayedChild as WorkflowChildResult<TChildOutputs>;
      }

      // Tracked so the finally can detach the parent-abort listener and release
      // the pre-registered child controller on every exit path — including the
      // maxDepth early return inside run(), which returns before run()'s own
      // cleanup. Without this, sequential ctx.workflow(...) calls accumulate one
      // parent-signal listener (and a leaked registry entry) per child.
      let childRunId: string | undefined;
      let detachParentAbort: (() => void) | undefined;
      try {
        const childInputs = resolveAndValidateInputs(
          child.inputs,
          options.inputs ?? {},
          `child workflow "${childName}" (${child.name})`,
        );

        childRunId = crypto.randomUUID();
        boundary.linkChildRun({
          alias: childName,
          workflow: child.normalizedName,
          runId: childRunId,
        });

        const childController = new AbortController();
        if (ownController.signal.aborted) {
          childController.abort(ownController.signal.reason);
        } else {
          const onParentAbort = () => childController.abort(ownController.signal.reason);
          ownController.signal.addEventListener("abort", onParentAbort, { once: true });
          detachParentAbort = () =>
            ownController.signal.removeEventListener("abort", onParentAbort);
        }
        // Pre-register the child controller under its own runId *before* run()
        // so a kill targeting the child runId works even before the nested run
        // would register itself. The nested run() sees opts.signal set and skips
        // its own cancellation.register (avoiding a double-register on the same
        // key) while still running its finally{} unregister(runId) cleanup, so
        // both branches must agree on this key.
        opts.cancellation?.register(childRunId, childController);

        const {
          runId: _parentRunId,
          continuation: _parentContinuation,
          deferWorkflowStart: _parentDeferWorkflowStart,
          parentRun: _parentRun,
          onRunStart: _parentOnRunStart,
          onRunEnd: _parentOnRunEnd,
          ...childBaseOpts
        } = opts;
        const childRun = await run(child, childInputs, {
          ...childBaseOpts,
          runId: childRunId,
          cwd: resolveWorkflowCwd(),
          depth: depth + 1,
          ...(opts.registry !== undefined ? { registry: opts.registry } : {}),
          parentRun: {
            runId,
            stageId: boundary.id,
            rootRunId: opts.parentRun?.rootRunId ?? runId,
          },
          signal: childController.signal,
          deferWorkflowStart: false,
        });

        if (childRun.status !== "completed") {
          const failedChildStage = childRun.stages.find((stage) => stage.failureKind !== undefined);
          throw new Error(
            `atomic-workflows: child workflow "${childName}" (${child.name}) failed with status ${childRun.status}${childRun.error !== undefined ? `: ${childRun.error}` : ""}`,
            {
              cause: {
                ...(failedChildStage?.failureKind !== undefined ? { code: failedChildStage.failureKind } : {}),
                ...(failedChildStage?.failureMessage !== undefined ? { message: failedChildStage.failureMessage } : {}),
              },
            },
          );
        }

        const outputs = selectWorkflowOutputs(child, childRun.result);
        const childResult: WorkflowChildResult<TChildOutputs> = {
          workflow: child.normalizedName,
          runId: childRun.runId,
          status: "completed",
          outputs: outputs as TChildOutputs,
        };
        const workflowChild = workflowChildReplaySnapshot(childName, childResult);
        const outputKeys = Object.keys(outputs);
        boundary.complete(
          `Workflow "${child.name}" completed (runId: ${childRun.runId}; outputs: ${outputKeys.length > 0 ? outputKeys.join(", ") : "(none)"})`,
          workflowChild,
        );
        return childResult;
      } catch (err) {
        boundary.fail(err);
        throw err;
      } finally {
        detachParentAbort?.();
        // Idempotent with run()'s own finally on the normal path; required on
        // the maxDepth early-return path where run() never reaches its cleanup.
        if (childRunId !== undefined) opts.cancellation?.unregister(childRunId);
      }
    },
  };

  // 6. Call def.run(ctx)
  try {
    if (opts.deferWorkflowStart === true) {
      await nextEventLoopTurn();
      if (ownController.signal.aborted) {
        return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
      }
    }

    const rawResult = await def.run(ctx);

    // Post-body abort check: if signal was aborted at any point before we record
    // completion, the run must be finalized as "killed", never "completed".
    if (ownController.signal.aborted) {
      return finalizeKilled(runId, runSnapshot, activeStore, opts.persistence, opts.onRunEnd);
    }

    const result = normalizeWorkflowRunOutput(def.name, rawResult);
    assertWorkflowRunOutputs(def.name, result, def.outputs);

    assertWorkflowCreatedStage(runSnapshot);

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

    const metadata = runFailureMetadata(err, runSnapshot.stages);
    const recorded = activeStore.recordRunEnd(runId, "failed", undefined, metadata.errorMessage, metadata);
    opts.onRunEnd?.(runId, "failed", undefined, metadata.errorMessage);

    appendRunEndWhenRecorded(opts.persistence, recorded, {
      runId,
      status: "failed",
      error: metadata.errorMessage,
      failureKind: metadata.failureKind,
      failureMessage: metadata.failureMessage,
      ...(metadata.failedStageId !== undefined ? { failedStageId: metadata.failedStageId } : {}),
      resumable: metadata.resumable,
      ts: Date.now(),
    });

    return {
      runId,
      status: "failed",
      error: metadata.errorMessage,
      stages: [...runSnapshot.stages],
    };
  } finally {
    opts.cancellation?.unregister(runId);
  }
}
