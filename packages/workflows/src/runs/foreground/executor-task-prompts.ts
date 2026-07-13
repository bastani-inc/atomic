import { isAbsolute, resolve } from "node:path";
import type {
  StageOptions,
  StagePromptOptions,
  WorkflowTaskContextInput,
  WorkflowTaskOptions,
  WorkflowTaskStep,
  WorkflowChainOptions,
  WorkflowParallelOptions,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowMaxOutput,
} from "../../shared/types.js";

export function normalizeTaskContexts(
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

export function renderTaskContext(contexts: readonly { readonly name?: string; readonly text: string }[]): string {
  if (contexts.length === 0) return "";
  if (contexts.length === 1 && contexts[0]?.name === undefined) return contexts[0]!.text;
  return contexts
    .map((context, index) => {
      const label = context.name ?? `context-${index + 1}`;
      return `--- ${label} ---\n${context.text}`;
    })
    .join("\n\n");
}

export function applyTaskContext(prompt: string, previous: WorkflowTaskOptions["previous"]): string {
  const contexts = normalizeTaskContexts(previous);
  if (contexts.length === 0) return prompt;

  const lastPrevious = contexts[contexts.length - 1]?.text ?? "";
  const rendered = renderTaskContext(contexts);
  let next = prompt.replace(/\{previous\}/g, lastPrevious);

  if (next !== prompt) return next;
  next += `\n\n---\nContext:\n${rendered}`;
  return next;
}

export function taskPrompt(options: WorkflowTaskOptions): string {
  const prompt = options.prompt ?? options.task;
  if (prompt === undefined) {
    throw new Error("atomic-workflows: ctx.task requires options.prompt or options.task");
  }
  return prompt;
}

export function taskPrevious(options: WorkflowTaskOptions): WorkflowTaskOptions["previous"] {
  return options.previous;
}

export type WorkflowTaskExecutionOptions = WorkflowTaskOptions & { chainDir?: string };

export function resolveWorkflowPath(filePath: string, baseDir: string | undefined): string {
  if (isAbsolute(filePath)) return filePath;
  return resolve(baseDir ?? process.cwd(), filePath);
}

export function taskBaseDir(options: Pick<WorkflowTaskExecutionOptions, "chainDir" | "cwd">): string | undefined {
  if (typeof options.chainDir === "string" && options.chainDir.trim().length > 0) {
    return resolveWorkflowPath(options.chainDir, process.cwd());
  }
  if (typeof options.cwd === "string" && options.cwd.length > 0) {
    return resolveWorkflowPath(options.cwd, process.cwd());
  }
  return undefined;
}

export function taskReadInstruction(options: WorkflowTaskExecutionOptions): string {
  if (options.reads === false || options.reads === undefined || options.reads.length === 0) return "";
  const baseDir = taskBaseDir(options);
  const files = options.reads.map((file) => resolveWorkflowPath(file, baseDir));
  return `[Read from: ${files.join(", ")}]\n\n`;
}

export function taskPromptOptions(options: WorkflowTaskExecutionOptions): StagePromptOptions | undefined {
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

export function taskStageOptions(options: WorkflowTaskExecutionOptions): StageOptions {
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

export function taskOptionsFromStep(step: WorkflowTaskStep, prompt: string, previous?: WorkflowTaskOptions["previous"]): WorkflowTaskOptions {
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

export function replaceTaskPlaceholder(prompt: string, task: string): string {
  return prompt.replace(/\{task\}/g, task);
}

export function chainStepPrompt(step: WorkflowTaskStep, index: number): string {
  return step.prompt ?? step.task ?? (index === 0 ? "{task}" : "{previous}");
}

export function parallelFallbackTask(steps: readonly WorkflowTaskStep[], options?: WorkflowParallelOptions): string {
  if (options?.task !== undefined) return options.task;
  for (const step of steps) {
    const task = step.prompt ?? step.task;
    if (task !== undefined) return task;
  }
  return "";
}

export function directTaskPrompt(item: WorkflowDirectTaskItem): string | undefined {
  return item.prompt ?? item.task;
}

export function normalizeMaxOutput(maxOutput: WorkflowMaxOutput | undefined): Required<WorkflowMaxOutput> {
  return {
    bytes: maxOutput?.bytes ?? 200 * 1024,
    lines: maxOutput?.lines ?? 5000,
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

export function structuredTaskOutputText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    throw new Error(`atomic-workflows: structured task output is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function truncateTaskOutput(text: string, maxOutput: WorkflowMaxOutput | undefined): string {
  const limits = normalizeMaxOutput(maxOutput);
  const byLines = truncateByLines(text, limits.lines);
  const byBytes = truncateByBytes(byLines.text, limits.bytes);
  if (!byLines.truncated && !byBytes.truncated) return text;
  return `${byBytes.text}\n\n[workflow output truncated; limits: ${limits.bytes} bytes, ${limits.lines} lines]`;
}

export function withoutUndefinedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

export function sharedTaskDefaultsFromOptions(
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

export function taskWithSharedDefaults(
  taskOptions: WorkflowTaskOptions,
  options: WorkflowChainOptions | WorkflowParallelOptions,
): WorkflowTaskExecutionOptions {
  return {
    ...sharedTaskDefaultsFromOptions(options),
    ...withoutUndefinedProperties(taskOptions),
  } as WorkflowTaskExecutionOptions;
}

export function directTaskWithDefaults(
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

export function directTaskToStep(
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
