/**
 * Durable directory enumeration for the per-workflow file backend.
 *
 * Extracted from file-backend.ts so listing logic can use the stat-gated
 * parse cache (file-backend-cache.ts) without growing the backend past the
 * repository file-length gate. Enumeration remains a fallback path — startup
 * and mid-run flows resolve targeted ids and never call these helpers.
 */

import { readdirSync } from "node:fs";
import type { FileDurableRecord } from "./file-state.js";
import { readDurableFileStateCached } from "./file-backend-cache.js";
import { stateMatchesWorkflowId, workflowIdFromStateFile } from "./file-backend-state.js";

export function durableStateFiles(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith("workflow-") && entry.name.endsWith(".json"))
      .map((entry) => `${dir}/${entry.name}`);
  } catch { return []; }
}

export function durableLockDirs(dir: string): readonly string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("workflow-") && entry.name.endsWith(".json.lock"))
      .map((entry) => `${dir}/${entry.name}`);
  } catch { return []; }
}

export interface DurableRecordScanDeps {
  readonly dir: string;
  readonly suppressedIds: Set<string>;
  backendForFile(filePath: string, workflowId: string): { isWorkflowLoadable(workflowId: string): boolean };
}

/**
 * Read every workflow's records from the durable directory. Each file is
 * parsed at most once per generation thanks to the stat-gated cache; the
 * loadability re-check below is a cache hit rather than a second disk read.
 */
export function readDurableRecordsFromFile(
  deps: DurableRecordScanDeps,
  filePath: string,
): readonly FileDurableRecord[] {
  const workflowId = workflowIdFromStateFile(deps.dir, filePath);
  if (workflowId === undefined) return [];
  const result = readDurableFileStateCached(filePath);
  const embeddedIds = result.kind === "current"
    ? [...result.state.workflows.map((record) => record.handle.workflowId), ...result.state.deletedWorkflowIds]
    : result.kind === "legacy" ? result.workflowIds : [];
  const mismatched = embeddedIds.filter((id) => id !== workflowId);
  if (mismatched.length > 0) {
    deps.suppressedIds.add(workflowId);
    mismatched.forEach((id) => deps.suppressedIds.add(id));
    deps.backendForFile(filePath, workflowId).isWorkflowLoadable(workflowId);
    return [];
  }
  const backend = deps.backendForFile(filePath, workflowId);
  if (!backend.isWorkflowLoadable(workflowId)) {
    deps.suppressedIds.add(workflowId);
    return [];
  }
  deps.suppressedIds.delete(workflowId);
  const current = readDurableFileStateCached(filePath);
  if (current.kind !== "current" || !stateMatchesWorkflowId(current.state, workflowId)) return [];
  return current.state.workflows.filter((record) => !current.state.deletedWorkflowIds.includes(record.handle.workflowId));
}

export function readAllDurableRecords(deps: DurableRecordScanDeps): readonly FileDurableRecord[] {
  return durableStateFiles(deps.dir).flatMap((filePath) => readDurableRecordsFromFile(deps, filePath));
}
