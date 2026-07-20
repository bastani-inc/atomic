import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { APP_NAME, CONFIG_DIR_NAME, isCodexFastModeCandidateModelId } from "@bastani/atomic";
import type {
  StageOptions,
  WorkflowArtifact,
  WorkflowTaskOptions,
  WorkflowTaskStep,
} from "../../shared/types.js";
import { buildModelCandidatesFromCatalog, workflowModelId } from "../shared/model-fallback.js";
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
import type { RunOpts } from "./executor-types.js";
import { withoutUndefinedProperties } from "./executor-task-prompts.js";

export { createGitWorktreeSetupCache, createGitWorktreeSetupCacheOwner } from "../shared/worktree.js";
export type { GitWorktreeSetupCache } from "../shared/worktree.js";

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
      if (controlSignal !== undefined || (failFastEnabled && firstFailure !== undefined)) return;
      try {
        control?.beforeDequeue?.();
      } catch (error) {
        if (isControlSignal(error)) selectControlSignal(error);
        else await recordFailure(nextIndex, error);
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
      } catch (error) {
        if (isControlSignal(error)) {
          selectControlSignal(error);
          return;
        }
        await recordFailure(index, error);
        if (failFastEnabled) return;
      }
    }
  }

  const allWorkers = Promise.all(Array.from({ length: Math.min(limit, steps.length) }, () => worker()));
  if (!failFastEnabled) await allWorkers;
  else {
    try {
      await Promise.race([allWorkers, firstFailurePromise]);
    } catch (error) {
      void allWorkers.catch(() => {});
      throw error;
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
  if (typeof inputDefaults.gitWorktreeDir !== "string" || inputDefaults.gitWorktreeDir.trim().length === 0) return undefined;
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

export interface TaskOutputIsolation {
  readonly baseDir: string;
  readonly trustedRoot: string;
}

export interface PreparedTaskWorktrees {
  readonly tasks: WorkflowTaskStep[];
  readonly setup?: WorktreeSetup;
  readonly agents: string[];
  readonly diffsDir?: string;
  readonly outputIsolations?: readonly TaskOutputIsolation[];
}

function resolvedTaskCwd(cwd: string | undefined, workflowInvocationCwd: string): string | undefined {
  if (cwd === undefined) return undefined;
  return isAbsolute(cwd) ? cwd : resolve(workflowInvocationCwd, cwd);
}

function taskWorktreeOutputsRoot(): string {
  return join(tmpdir(), `${APP_NAME}-workflow-outputs`);
}

export function prepareTaskWorktrees(
  tasks: readonly WorkflowTaskStep[],
  options: WorkflowTaskOptions,
  runId: string,
  scope: string,
  workflowInvocationCwd: string = process.cwd(),
  symlinkDirectories?: readonly string[],
): PreparedTaskWorktrees {
  if (options.worktree !== true && !tasks.some((task) => task.worktree === true)) {
    return { tasks: [...tasks], agents: tasks.map((task) => task.name) };
  }
  if (typeof options.gitWorktreeDir === "string" || tasks.some((task) => typeof task.gitWorktreeDir === "string")) {
    throw new Error("atomic-workflows: worktree and gitWorktreeDir are mutually exclusive; use gitWorktreeDir for a reusable worktree or worktree:true for temporary isolated worktrees.");
  }
  const explicitCwd = tasks.find((task) => typeof task.cwd === "string")?.cwd;
  const sharedCwd = explicitCwd === undefined
    ? workflowInvocationCwd
    : isAbsolute(explicitCwd) ? explicitCwd : resolve(workflowInvocationCwd, explicitCwd);
  const conflict = findWorktreeTaskCwdConflict(
    tasks.map((task) => ({ agent: task.name, cwd: resolvedTaskCwd(task.cwd, workflowInvocationCwd) })),
    sharedCwd,
  );
  if (conflict !== undefined) throw new Error(formatWorktreeTaskCwdConflict(conflict, sharedCwd));

  const agents = tasks.map((task) => task.name);
  const setup = createWorktrees(sharedCwd, runId, tasks.length, {
    agents,
    baseBranch: options.baseBranch,
    symlinkDirectories,
  });
  const trustedRoot = taskWorktreeOutputsRoot();
  return {
    tasks: tasks.map((task, index) => ({ ...task, cwd: setup.worktrees[index]!.agentCwd })),
    setup,
    agents,
    diffsDir: join(setup.cwd, CONFIG_DIR_NAME, "workflows", "worktree-diffs", runId, scope),
    outputIsolations: tasks.map((_, index) => ({ baseDir: join(trustedRoot, runId, scope, String(index)), trustedRoot })),
  };
}

export function collectWorktreeDiffs(prepared: PreparedTaskWorktrees, enabled = true): {
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
  return { artifacts, ...(summary.length > 0 ? { summary } : {}) };
}

export function cleanupPreparedWorktrees(prepared: PreparedTaskWorktrees): void {
  if (prepared.setup !== undefined) cleanupWorktrees(prepared.setup);
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
