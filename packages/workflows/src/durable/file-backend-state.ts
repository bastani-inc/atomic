import { DURABLE_FORMAT_VERSION } from "./format-version.js";
import type { DurableWorkflowStatus } from "./types.js";
import type { FileDurableRecord, FileDurableState } from "./file-state.js";

export function workflowIdFromStateFile(dir: string, filePath: string): string | undefined {
  const prefix = `${dir}/workflow-`;
  if (!filePath.startsWith(prefix) || !filePath.endsWith(".json")) return undefined;
  try { return decodeURIComponent(filePath.slice(prefix.length, -".json".length)); }
  catch { return undefined; }
}

export function emptyState(deletedWorkflowIds: readonly string[] = []): FileDurableState {
  return { version: DURABLE_FORMAT_VERSION, workflows: [], deletedWorkflowIds };
}

export function currentState(
  records: readonly FileDurableRecord[],
  deleted: ReadonlySet<string>,
): FileDurableState {
  return { version: DURABLE_FORMAT_VERSION, workflows: records, deletedWorkflowIds: [...deleted] };
}

export function stateMatchesWorkflowId(state: FileDurableState, workflowId: string): boolean {
  return state.workflows.every((record) => record.handle.workflowId === workflowId)
    && state.deletedWorkflowIds.every((id) => id === workflowId);
}

export function isPrunableTerminalStatus(status: DurableWorkflowStatus, resumable?: boolean): boolean {
  return status === "cancelled"
    || ((status === "failed" || status === "blocked") && resumable === false);
}

export function defaultDurableStateDir(): string | undefined {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  return home === undefined || home.length === 0 ? undefined : `${home}/.atomic/workflow-durable`;
}

export function durableStateFileFor(dir: string, workflowId: string): string {
  return `${dir}/workflow-${encodeURIComponent(workflowId)}.json`;
}
