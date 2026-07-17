/**
 * SQL row <-> {@link ResumableWorkflowEntry} mapping for the durable workflow
 * catalog. Extracted from `file-catalog.ts` so the catalog module stays within
 * the repository file-length gate; contains no freshness, locking, or reconcile
 * logic — only the row schema projection and query materialization.
 */
import type { Database } from "bun:sqlite";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import type { ResumableWorkflowEntry } from "./types.js";
import type { DurableWorkflowCatalogEntries, FileCatalogSource } from "./file-catalog.js";

export interface CatalogSqlRow {
  workflow_id: string;
  name: string;
  status: ResumableWorkflowEntry["status"];
  completed_checkpoints: number;
  pending_prompts: number;
  created_at: number;
  updated_at: number;
  label: string | null;
  root_workflow_id: string | null;
  resumable: number | null;
  invocation_cwd: string | null;
  workflow_cwd: string | null;
  repository_root: string | null;
  git_worktree_root: string | null;
  completed_openable: number;
  state_file: string;
  state_mtime_ms: number;
  state_size: number;
}

type CatalogInsertParams = [
  string, string, string, number, number, number, number,
  string | null, string | null, number | null,
  string | null, string | null, string | null, string | null,
  number, string, number, number,
];

const READ_ENTRIES_SQL = `
  SELECT workflow_id, name, status, completed_checkpoints, pending_prompts,
    created_at, updated_at, label, root_workflow_id, resumable,
    invocation_cwd, workflow_cwd, repository_root, git_worktree_root,
    completed_openable, state_file, state_mtime_ms, state_size
  FROM runs ORDER BY updated_at DESC, workflow_id ASC
`;

/** Materialize the resumable / completed / completed-all catalog listings. */
export function readCatalogEntries(database: Database): DurableWorkflowCatalogEntries {
  const rows = database.query<CatalogSqlRow, []>(READ_ENTRIES_SQL).all();
  const entries = rows.map(entryFromSqlRow);
  const completedAll = rows.flatMap((row, index) =>
    row.status === "completed" && row.completed_checkpoints > 0
      && (row.root_workflow_id === null || row.root_workflow_id === row.workflow_id)
      ? [entries[index]!] : []);
  const openableCompletedIds = new Set(
    rows.filter((row) => row.completed_openable === 1).map((row) => row.workflow_id),
  );
  return {
    resumable: entries.filter(isDurableWorkflowResumable),
    completed: completedAll.filter((entry) => openableCompletedIds.has(entry.workflowId)),
    completedAll,
  };
}

/** Insert or update one catalog row from an authoritative durable state source. */
export function upsertCatalogRow(database: Database, source: FileCatalogSource): void {
  const handle = source.record.handle;
  database.query<never, CatalogInsertParams>(`
    INSERT INTO runs (
      workflow_id, name, status, completed_checkpoints, pending_prompts,
      created_at, updated_at, label, root_workflow_id, resumable,
      invocation_cwd, workflow_cwd, repository_root, git_worktree_root,
      completed_openable, state_file, state_mtime_ms, state_size
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workflow_id) DO UPDATE SET
      name=excluded.name, status=excluded.status,
      completed_checkpoints=excluded.completed_checkpoints,
      pending_prompts=excluded.pending_prompts, created_at=excluded.created_at,
      updated_at=excluded.updated_at, label=excluded.label,
      root_workflow_id=excluded.root_workflow_id, resumable=excluded.resumable,
      invocation_cwd=excluded.invocation_cwd, workflow_cwd=excluded.workflow_cwd,
      repository_root=excluded.repository_root, git_worktree_root=excluded.git_worktree_root,
      completed_openable=excluded.completed_openable, state_file=excluded.state_file,
      state_mtime_ms=excluded.state_mtime_ms, state_size=excluded.state_size
  `).run(
    handle.workflowId, handle.name, handle.status, handle.completedCheckpoints,
    handle.pendingPrompts, handle.createdAt, handle.updatedAt,
    handle.label ?? null, handle.rootWorkflowId ?? null,
    handle.resumable === undefined ? null : handle.resumable ? 1 : 0,
    handle.invocationCwd ?? null, handle.workflowCwd ?? null,
    handle.repositoryRoot ?? null, handle.gitWorktreeRoot ?? null,
    source.completedOpenable ? 1 : 0, source.stateFile,
    source.stateMtimeMs, source.stateSize,
  );
}

function entryFromSqlRow(row: CatalogSqlRow): ResumableWorkflowEntry {
  return {
    workflowId: row.workflow_id,
    name: row.name,
    status: row.status,
    completedCheckpoints: row.completed_checkpoints,
    pendingPrompts: row.pending_prompts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.label !== null ? { label: row.label } : {}),
    ...(row.root_workflow_id !== null ? { rootWorkflowId: row.root_workflow_id } : {}),
    ...(row.resumable !== null ? { resumable: row.resumable === 1 } : {}),
    ...(row.invocation_cwd !== null ? { invocationCwd: row.invocation_cwd } : {}),
    ...(row.workflow_cwd !== null ? { workflowCwd: row.workflow_cwd } : {}),
    ...(row.repository_root !== null ? { repositoryRoot: row.repository_root } : {}),
    ...(row.git_worktree_root !== null ? { gitWorktreeRoot: row.git_worktree_root } : {}),
  };
}
