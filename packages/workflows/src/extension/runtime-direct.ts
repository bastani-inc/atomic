import type {
  WorkflowChainStep,
  WorkflowDetails,
  WorkflowDirectOptions,
  WorkflowDirectTaskItem,
} from "../shared/types.js";
import { normalizeAutoGroupSentinel } from "../shared/intercom-group.js";
import type { WorkflowToolArgs } from "./index.js";

export function withoutUndefinedProperties<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => field !== undefined),
  ) as Partial<T>;
}

export function directOptions(args: WorkflowToolArgs): WorkflowDirectOptions {
  const {
    workflow: _workflow,
    inputs: _inputs,
    action: _action,
    runId: _runId,
    task,
    tasks: _tasks,
    chain: _chain,
    chainName,
    concurrency,
    failFast,
    async: _async,
    intercom: _intercom,
    group,
    output,
    outputMode,
    reads,
    chainDir,
    maxOutput,
    artifacts,
    worktree,
    gitWorktreeDir,
    baseBranch,
    ...stageOptions
  } = args;

  return {
    ...withoutUndefinedProperties(stageOptions),
    ...(group !== undefined ? { group: normalizeAutoGroupSentinel(group) } : {}),
    ...(typeof task === "string" ? { task } : {}),
    ...(typeof chainName === "string" ? { chainName } : {}),
    ...(typeof concurrency === "number" ? { concurrency } : {}),
    ...(typeof failFast === "boolean" ? { failFast } : {}),
    ...(typeof chainDir === "string" ? { chainDir } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(outputMode !== undefined ? { outputMode } : {}),
    ...(reads !== undefined ? { reads } : {}),
    ...(maxOutput !== undefined ? { maxOutput } : {}),
    ...(typeof artifacts === "boolean" ? { artifacts } : {}),
    ...(typeof worktree === "boolean" ? { worktree } : {}),
    ...(typeof gitWorktreeDir === "string" ? { gitWorktreeDir } : {}),
    ...(typeof baseBranch === "string" ? { baseBranch } : {}),
  };
}

export function directMode(args: WorkflowToolArgs): WorkflowDetails["mode"] {
  if (Array.isArray(args.chain)) return "chain";
  if (Array.isArray(args.tasks)) return "parallel";
  return "single";
}

export function directModelRequests(args: WorkflowToolArgs): Array<{ readonly model?: WorkflowDirectTaskItem["model"]; readonly fallbackModels?: readonly string[] }> {
  const options = directOptions(args);
  const withFallbackDefault = (item: WorkflowDirectTaskItem) => ({
    model: item.model ?? options.model,
    fallbackModels: item.fallbackModels ?? options.fallbackModels,
  });
  if (args.task !== undefined && typeof args.task === "object") return [withFallbackDefault(args.task)];
  if (Array.isArray(args.tasks)) return args.tasks.map(withFallbackDefault);
  if (Array.isArray(args.chain)) {
    return args.chain.flatMap((step) =>
      "parallel" in step
        ? step.parallel.map(withFallbackDefault)
        : [withFallbackDefault(step)],
    );
  }
  return [];
}

export function directProgressTotal(args: WorkflowToolArgs): number {
  const countTask = (task: WorkflowDirectTaskItem): number => task.count ?? 1;
  const countChainStep = (step: WorkflowChainStep): number =>
    "parallel" in step
      ? step.parallel.reduce((total, task) => total + countTask(task), 0)
      : 1;
  if (Array.isArray(args.chain)) {
    return args.chain.reduce((total, step) => total + countChainStep(step), 0);
  }
  if (Array.isArray(args.tasks)) {
    return args.tasks.reduce((total, task) => total + countTask(task), 0);
  }
  return 1;
}
