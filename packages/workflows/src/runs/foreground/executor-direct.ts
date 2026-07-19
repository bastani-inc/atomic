import type {
  WorkflowArtifact,
  WorkflowChainStep,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
  WorkflowParallelOptions,
  WorkflowRunContext,
  WorkflowTaskOptions,
  WorkflowTaskResult,
} from "../../shared/types.js";
import type { RunOpts } from "./executor-types.js";
import { run } from "./executor-run.js";
import {
  cleanupPreparedWorktrees,
  createGitWorktreeSetupCache,
  collectWorktreeDiffs,
  defineDirectWorkflow,
  directModelRequestsFromChain,
  directRunId,
  expandedParallelTasks,
  failedDirectDetails,
  isRunOpts,
  prepareDirectWorktrees,
  validateDirectModels,
  workflowDetailsFromRun,
  type GitWorktreeSetupCache,
} from "./executor-direct-helpers.js";
import { writeDirectOutput } from "./executor-direct-output.js";
import {
  directTaskPrompt,
  directTaskToStep,
  directTaskWithDefaults,
  replaceTaskPlaceholder,
} from "./executor-task-prompts.js";
import { validateWorkflowModels } from "../shared/model-fallback.js";

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
  const workflowInvocationCwd = runOptions.cwd ?? process.cwd();
  const prepared = prepareDirectWorktrees([taskWithDefaults], options, runId, "single", workflowInvocationCwd);
  const preparedTask = prepared.tasks[0]!;
  const gitWorktreeSetupCache = createGitWorktreeSetupCache();
  const direct = defineDirectWorkflow("direct-task", async (ctx) => {
    const rawResult = await ctx.task(preparedTask.name, directTaskToStep(preparedTask));
    const { result, artifact } = await writeDirectOutput(
      preparedTask, rawResult, workflowInvocationCwd, prepared.outputIsolations?.[0], gitWorktreeSetupCache,
    );
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
  });
  let runResult;
  try {
    runResult = await run(direct, {}, { ...runOptions, runId, gitWorktreeSetupCache });
  } finally {
    try {
      gitWorktreeSetupCache.dispose();
    } finally {
      cleanupPreparedWorktrees(prepared);
    }
  }
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("single", runResult, results, options, validationWarnings);
}

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
  const workflowInvocationCwd = runOptions.cwd ?? process.cwd();
  const prepared = prepareDirectWorktrees(expanded, options, runId, "parallel", workflowInvocationCwd);
  const gitWorktreeSetupCache = createGitWorktreeSetupCache();
  const direct = defineDirectWorkflow("direct-parallel", async (ctx) => {
    const steps = prepared.tasks.map((task) => directTaskToStep(task));
    const rawResults = await ctx.parallel(steps, {
      task: options.task,
      concurrency: options.concurrency,
      failFast: options.failFast,
    });
    const persisted = await Promise.all(
      rawResults.map((result, index) => writeDirectOutput(
        prepared.tasks[index]!, result, workflowInvocationCwd, prepared.outputIsolations?.[index], gitWorktreeSetupCache,
      )),
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
  });
  let runResult;
  try {
    runResult = await run(direct, {}, { ...runOptions, runId, gitWorktreeSetupCache });
  } finally {
    try {
      gitWorktreeSetupCache.dispose();
    } finally {
      cleanupPreparedWorktrees(prepared);
    }
  }
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
  workflowInvocationCwd: string,
  gitWorktreeSetupCache: GitWorktreeSetupCache,
): Promise<{ results: WorkflowTaskResult[]; artifacts: WorkflowArtifact[] }> {
  if ("parallel" in step) {
    const stepOptions = {
      ...options,
      worktree: options.worktree === true || step.worktree === true,
      ...(step.gitWorktreeDir !== undefined ? { gitWorktreeDir: step.gitWorktreeDir } : {}),
      ...(step.baseBranch !== undefined ? { baseBranch: step.baseBranch } : {}),
      ...(step.group !== undefined ? { group: step.group } : {}),
    };
    const expanded = expandedParallelTasks(step.parallel.map((item) => directTaskWithDefaults(item, stepOptions)));
    const prepared = prepareDirectWorktrees(
      expanded, stepOptions, `${runId}-s${index}`, `step-${index}`, workflowInvocationCwd,
    );
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
          writeDirectOutput(
            { ...prepared.tasks[taskIndex]!, chainDir: options.chainDir }, result, workflowInvocationCwd,
            prepared.outputIsolations?.[taskIndex], gitWorktreeSetupCache,
          ),
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
      cleanupPreparedWorktrees(prepared);
    }
  }

  const prompt = directTaskPrompt(step) ?? (index === 0 ? "{task}" : "{previous}");
  const prepared = prepareDirectWorktrees(
    [directTaskWithDefaults(step, options)], options, `${runId}-s${index}`, `step-${index}`, workflowInvocationCwd,
  );
  const preparedStep = prepared.tasks[0]!;
  try {
    const rawResult = await ctx.task(
      preparedStep.name,
      {
        ...directTaskToStep(preparedStep, replaceTaskPlaceholder(prompt, rootTask), preparedStep.previous ?? prior),
        ...(typeof options.chainDir === "string" ? { chainDir: options.chainDir } : {}),
      } as WorkflowTaskOptions,
    );
    const { result, artifact } = await writeDirectOutput(
      { ...preparedStep, chainDir: options.chainDir }, rawResult, workflowInvocationCwd,
      prepared.outputIsolations?.[0], gitWorktreeSetupCache,
    );
    const worktreeDiffs = collectWorktreeDiffs(prepared, options.artifacts !== false);
    return {
      results: [result],
      artifacts: [
        ...worktreeDiffs.artifacts,
        ...(artifact === undefined ? [] : [artifact]),
      ],
    };
  } finally {
    cleanupPreparedWorktrees(prepared);
  }
}

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
  const workflowInvocationCwd = runOptions.cwd ?? process.cwd();
  const gitWorktreeSetupCache = createGitWorktreeSetupCache();
  const direct = defineDirectWorkflow("direct-chain", async (ctx) => {
    const results: WorkflowTaskResult[] = [];
    const artifacts: WorkflowArtifact[] = [];
    let prior: WorkflowTaskResult | readonly WorkflowTaskResult[] | undefined;
    for (let index = 0; index < chain.length; index += 1) {
      const step = await runDirectChainStep(
        ctx,
        chain[index]!,
        index,
        options.task ?? "",
        prior,
        options,
        runId,
        workflowInvocationCwd,
        gitWorktreeSetupCache,
      );
      results.push(...step.results);
      artifacts.push(...step.artifacts);
      prior = step.results.length === 1 ? step.results[0] : step.results;
    }
    return { results, count: results.length, artifacts };
  });
  let runResult;
  try {
    runResult = await run(direct, {}, { ...runOptions, runId, gitWorktreeSetupCache });
  } finally {
    gitWorktreeSetupCache.dispose();
  }
  const results = (runResult.result?.["results"] ?? []) as WorkflowTaskResult[];
  return workflowDetailsFromRun("chain", runResult, results, options, validationWarnings);
}
