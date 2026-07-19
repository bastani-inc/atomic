import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, isCodexFastModeCandidateModelId } from "@bastani/atomic";
import { Type } from "typebox";
import type {
  StageOptions,
  WorkflowArtifact,
  WorkflowChainStep,
  WorkflowDefinition,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowOutputSchema,
  WorkflowTaskResult,
  WorkflowTaskStep,
} from "../../shared/types.js";
import { stampWorkflowDefinition } from "../../authoring/workflow.js";
import { buildModelCandidatesFromCatalog, validateWorkflowModels, workflowModelId } from "../shared/model-fallback.js";
import {
  cleanupWorktrees,
  createWorktrees,
  diffWorktrees,
  findWorktreeTaskCwdConflict,
  setupGitWorktreeCached,
  formatWorktreeDiffSummary,
  formatWorktreeTaskCwdConflict,
  type GitWorktreeSetupCache,
  type GitWorktreeSetupResult,
  type WorktreeSetup,
} from "../shared/worktree.js";
import { resolveWorktreeStageCwd } from "../shared/worktree-cwd.js";
import type { RunOpts, RunResult } from "./executor-types.js";
import { isWorkflowExitStatus } from "./executor-abort.js";
import { directTaskWithDefaults, withoutUndefinedProperties } from "./executor-task-prompts.js";
export { createGitWorktreeSetupCache, createGitWorktreeSetupCacheOwner } from "../shared/worktree.js";
export type { GitWorktreeSetupCache } from "../shared/worktree.js";

export function directModelRequestsFromChain(
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

export async function validateDirectModels(
  tasks: readonly WorkflowDirectTaskItem[],
  runOptions: RunOpts,
): Promise<readonly string[]> {
  return validateWorkflowModels({
    requests: tasks.map((task) => ({ model: task.model, fallbackModels: task.fallbackModels })),
    catalog: runOptions.models,
  });
}

export function positiveConcurrency(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
  return Math.floor(value);
}

export async function mapParallelSteps<T>(
  steps: readonly WorkflowTaskStep[],
  concurrency: number | undefined,
  failFast: boolean | undefined,
  mapper: (step: WorkflowTaskStep) => Promise<T>,
  onFirstFailure?: (error: unknown) => void | Promise<void>,
  control?: {
    readonly beforeDequeue?: () => void;
    readonly beforeMap?: () => void;
    readonly isControlSignal?: (error: unknown) => boolean;
  },
): Promise<T[]> {
  const limit = positiveConcurrency(concurrency) ?? steps.length;
  const failFastEnabled = failFast !== false;
  const results = new Array<T>(steps.length);
  const failures: Array<{ readonly index: number; readonly error: unknown }> = [];
  let nextIndex = 0;
  let firstFailure: unknown;
  let controlSignal: unknown;
  let rejectFirstFailure: (reason: unknown) => void = () => {};
  const firstFailurePromise = new Promise<never>((_, reject) => {
    rejectFirstFailure = reject;
  });

  const isControlSignal = (error: unknown): boolean => control?.isControlSignal?.(error) === true;
  const selectControlSignal = (error: unknown): void => {
    if (controlSignal !== undefined) return;
    controlSignal = error;
    if (failFastEnabled) rejectFirstFailure(error);
  };
  const recordFailure = async (index: number, error: unknown): Promise<void> => {
    failures.push({ index, error });
    if (firstFailure === undefined) {
      firstFailure = error;
      await onFirstFailure?.(error);
      if (failFastEnabled) rejectFirstFailure(error);
    }
  };

  async function worker(): Promise<void> {
    while (true) {
      if (controlSignal !== undefined) return;
      if (failFastEnabled && firstFailure !== undefined) return;
      try {
        control?.beforeDequeue?.();
      } catch (err) {
        if (isControlSignal(err)) {
          selectControlSignal(err);
          return;
        }
        await recordFailure(nextIndex, err);
        return;
      }
      if (controlSignal !== undefined) return;
      const index = nextIndex;
      nextIndex += 1;
      const step = steps[index];
      if (step === undefined) return;
      try {
        control?.beforeMap?.();
        results[index] = await mapper(step);
      } catch (err) {
        if (isControlSignal(err)) {
          selectControlSignal(err);
          return;
        }
        await recordFailure(index, err);
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

  if (controlSignal !== undefined) throw controlSignal;

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `atomic-workflows: ${failures.length} parallel ${failures.length === 1 ? "step" : "steps"} failed`,
    );
  }

  return results;
}

export function expandedParallelTasks(tasks: readonly WorkflowDirectTaskItem[]): WorkflowDirectTaskItem[] {
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

export interface DirectOutputIsolation {
  readonly baseDir: string;
  readonly trustedRoot: string;
}

export interface PreparedDirectWorktrees {
  readonly tasks: WorkflowDirectTaskItem[];
  readonly setup?: WorktreeSetup;
  readonly agents: string[];
  readonly diffsDir?: string;
  readonly outputIsolations?: readonly DirectOutputIsolation[];
}

export function directRunId(runOptions: RunOpts): string {
  return runOptions.runId ?? crypto.randomUUID();
}

function hasDirectWorktreeIsolation(tasks: readonly WorkflowDirectTaskItem[], options: WorkflowDirectOptions): boolean {
  return options.worktree === true || tasks.some((task) => task.worktree === true);
}

function resolveSharedDirectWorktreeCwd(
  tasks: readonly WorkflowDirectTaskItem[],
  workflowInvocationCwd: string,
): string {
  const explicitCwd = tasks.find((task) => typeof task.cwd === "string")?.cwd;
  if (explicitCwd === undefined) return workflowInvocationCwd;
  return isAbsolute(explicitCwd) ? explicitCwd : resolve(workflowInvocationCwd, explicitCwd);
}

function normalizeDirectTaskCwd(cwd: string | undefined, workflowInvocationCwd: string): string | undefined {
  if (cwd === undefined) return undefined;
  return isAbsolute(cwd) ? cwd : resolve(workflowInvocationCwd, cwd);
}

export function stageOptionsWithInputDefaults<T extends StageOptions>(options: T | undefined, inputDefaults: Partial<StageOptions>): T | undefined {
  const defaults = withoutUndefinedProperties(inputDefaults);
  if (Object.keys(defaults).length === 0) return options;
  return { ...defaults, ...withoutUndefinedProperties(options ?? {}) } as T;
}

export function stageOptionsWithGitWorktree<T extends StageOptions>(options: T | undefined, workflowInvocationCwd: string, cache?: GitWorktreeSetupCache): T | undefined {
  if (options === undefined) return undefined;
  if (typeof options.gitWorktreeDir !== "string") return options;
  if (options.gitWorktreeDir.trim().length === 0) {
    throw new Error("atomic-workflows: gitWorktreeDir cannot be empty; provide a reusable worktree path or omit gitWorktreeDir for a non-worktree run.");
  }
  const setup = setupGitWorktreeCached({
    gitWorktreeDir: options.gitWorktreeDir,
    baseBranch: options.baseBranch,
    cwd: workflowInvocationCwd,
  }, cache);
  const explicitCwd = resolveWorktreeStageCwd(options.cwd, setup);
  return { ...options, gitWorktreeDir: undefined, baseBranch: undefined, cwd: explicitCwd ?? setup.cwd };
}

export function setupWorkflowInputGitWorktree(inputDefaults: Partial<StageOptions>, workflowInvocationCwd: string, cache?: GitWorktreeSetupCache): GitWorktreeSetupResult | undefined {
  if (typeof inputDefaults.gitWorktreeDir !== "string" || inputDefaults.gitWorktreeDir.trim().length === 0) {
    return undefined;
  }
  return setupGitWorktreeCached({
    gitWorktreeDir: inputDefaults.gitWorktreeDir,
    baseBranch: inputDefaults.baseBranch,
    cwd: workflowInvocationCwd,
  }, cache);
}

export function workflowCwdWithInputWorktree(inputDefaults: Partial<StageOptions>, workflowInvocationCwd: string, cache?: GitWorktreeSetupCache): string {
  return setupWorkflowInputGitWorktree(inputDefaults, workflowInvocationCwd, cache)?.cwd ?? workflowInvocationCwd;
}

export function workflowInvocationMetadata(inputDefaults: Partial<StageOptions>, workflowInvocationCwd: string, cache?: GitWorktreeSetupCache): {
  readonly invocationCwd: string;
  readonly workflowCwd?: string;
  readonly repositoryRoot?: string;
  readonly gitWorktreeRoot?: string;
} {
  const setup = setupWorkflowInputGitWorktree(inputDefaults, workflowInvocationCwd, cache);
  return {
    invocationCwd: workflowInvocationCwd,
    ...(setup !== undefined ? { workflowCwd: setup.cwd, repositoryRoot: setup.repositoryRoot, gitWorktreeRoot: setup.worktreeRoot } : {}),
  };
}

function nonBlankChainDir(chainDir: string | undefined): string | undefined {
  return typeof chainDir === "string" && chainDir.trim().length > 0 ? chainDir : undefined;
}

function directWorktreeArtifactBase(options: WorkflowDirectOptions, setup: WorktreeSetup): string {
  return nonBlankChainDir(options.chainDir) ?? join(setup.cwd, CONFIG_DIR_NAME, "workflows");
}

function directWorktreeDiffsDir(options: WorkflowDirectOptions, setup: WorktreeSetup, runId: string, scope: string): string {
  return join(directWorktreeArtifactBase(options, setup), "worktree-diffs", runId, scope);
}

function directWorktreeOutputsRoot(): string {
  return join(tmpdir(), `${APP_NAME}-workflow-outputs`);
}

function directWorktreeOutputsDir(runId: string, scope: string, index: number): string {
  return join(directWorktreeOutputsRoot(), runId, scope, String(index));
}

export function prepareDirectWorktrees(
  tasks: readonly WorkflowDirectTaskItem[],
  options: WorkflowDirectOptions,
  runId: string,
  scope: string,
  workflowInvocationCwd: string = process.cwd(),
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

  const sharedCwd = resolveSharedDirectWorktreeCwd(tasks, workflowInvocationCwd);
  const conflict = findWorktreeTaskCwdConflict(
    tasks.map((task) => ({ agent: task.name, cwd: normalizeDirectTaskCwd(task.cwd, workflowInvocationCwd) })),
    sharedCwd,
  );
  if (conflict !== undefined) throw new Error(formatWorktreeTaskCwdConflict(conflict, sharedCwd));

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
    outputIsolations: tasks.map((_, index) => ({
      baseDir: directWorktreeOutputsDir(runId, scope, index),
      trustedRoot: directWorktreeOutputsRoot(),
    })),
  };
}

export function collectWorktreeDiffs(prepared: PreparedDirectWorktrees, enabled = true): {
  artifacts: WorkflowArtifact[];
  summary?: string;
} {
  if (!enabled || prepared.setup === undefined || prepared.diffsDir === undefined) return { artifacts: [] };

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

export function cleanupPreparedWorktrees(prepared: PreparedDirectWorktrees): void {
  if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
}

export function isRunOpts(value: WorkflowDirectOptions | RunOpts | undefined): value is RunOpts {
  if (value === undefined) return false;
  return (
    "adapters" in value || "ui" in value || "store" in value || "persistence" in value ||
    "mcp" in value || "cancellation" in value || "overlay" in value || "signal" in value ||
    "config" in value || "depth" in value || "stageControlRegistry" in value || "runId" in value ||
    "gitWorktreeSetupCache" in value || "onRunStart" in value || "onStageStart" in value ||
    "onStageEnd" in value || "onRunEnd" in value || "models" in value
  );
}



export function workflowDetailsFromRun(
  mode: WorkflowDetails["mode"],
  runResult: RunResult,
  results: readonly WorkflowTaskResult[],
  options: WorkflowDirectOptions = {},
  warnings: readonly string[] = [],
): WorkflowDetails {
  const sessionArtifacts = options.artifacts === false ? [] : results.flatMap((result) =>
    result.sessionFile === undefined ? [] : [{ kind: "session" as const, path: result.sessionFile, taskName: result.name }],
  );
  const outputArtifacts = Array.isArray(runResult.result?.["artifacts"])
    ? runResult.result["artifacts"] as WorkflowArtifact[]
    : [];
  const artifacts = [...outputArtifacts, ...sessionArtifacts];
  const allWarnings = [...warnings, ...results.flatMap((result) => result.warnings ?? [])];
  return {
    mode,
    action: "run",
    runId: runResult.runId,
    status: isWorkflowExitStatus(runResult.status) ? runResult.status : runResult.status === "failed" ? "failed" : runResult.status === "killed" ? "killed" : "running",
    ...(options.context !== undefined ? { context: options.context } : {}),
    results: [...results],
    output: runResult.result,
    progress: { completed: results.length, total: results.length },
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {}),
    ...(runResult.error !== undefined ? { error: runResult.error } : {}),
    ...(runResult.exited !== undefined ? { exited: runResult.exited } : {}),
    ...(runResult.exitReason !== undefined ? { exitReason: runResult.exitReason } : {}),
  };
}

const DIRECT_WORKFLOW_OUTPUTS: Readonly<Record<string, WorkflowOutputSchema>> = Object.freeze({
  results: Type.Optional(Type.Unknown()),
  text: Type.Optional(Type.Unknown()),
  count: Type.Optional(Type.Unknown()),
  artifacts: Type.Optional(Type.Unknown()),
  worktreeSummary: Type.Optional(Type.Unknown()),
});

export function defineDirectWorkflow(name: string, runFn: WorkflowDefinition["run"]): WorkflowDefinition {
  const definition = {
    __piWorkflow: true,
    name,
    normalizedName: name,
    description: "Direct workflow execution",
    inputs: Object.freeze({}),
    outputs: DIRECT_WORKFLOW_OUTPUTS,
    run: runFn,
  } as WorkflowDefinition;
  stampWorkflowDefinition(definition);
  return Object.freeze(definition);
}

export async function hasExplicitFastModeCandidate(input: {
  readonly model?: StageOptions["model"];
  readonly fallbackModels?: readonly string[];
  readonly models?: RunOpts["models"];
}): Promise<boolean> {
  const rawCandidate = isCodexFastModeCandidate(input.model)
    || (Array.isArray(input.fallbackModels) && input.fallbackModels.some((candidate) => isCodexFastModeCandidate(candidate)));
  if (rawCandidate) return true;
  try {
    const candidates = await buildModelCandidatesFromCatalog({
      primaryModel: input.model,
      fallbackModels: input.fallbackModels,
      catalog: input.models,
    });
    return candidates.some((candidate) => isCodexFastModeCandidate(candidate.id));
  } catch {
    return false;
  }
}

function isCodexFastModeCandidate(model: StageOptions["model"] | string | undefined): boolean {
  return isCodexFastModeCandidateModelId(workflowModelId(model));
}
