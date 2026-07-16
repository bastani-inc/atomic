import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDurableWorkflowResumable } from "./resume-eligibility.js";
import type { FileDurableRecord } from "./file-state.js";
import type { ResumableWorkflowEntry } from "./types.js";
import { withDurableFileLock, withDurableFileLockAsync } from "./file-lock.js";

const CATALOG_SCHEMA_VERSION = 1;
const CATALOG_DIR_NAME = ".catalog";
const CATALOG_FILE_NAME = "workflow-catalog.sqlite";
const REBUILD_MARKER_NAME = "rebuild-required";

export interface DurableWorkflowCatalogEntries {
  readonly resumable: readonly ResumableWorkflowEntry[];
  readonly completed: readonly ResumableWorkflowEntry[];
  readonly completedAll?: readonly ResumableWorkflowEntry[];
}

export interface FileCatalogSource {
  readonly record: FileDurableRecord;
  readonly stateFile: string;
  readonly stateMtimeMs: number;
  readonly stateSize: number;
  readonly completedOpenable: boolean;
}

interface CatalogSqlRow {
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

interface MetaSqlRow { value: string }
interface CountSqlRow { count: number }

type CatalogInsertParams = [
  string, string, string, number, number, number, number,
  string | null, string | null, number | null,
  string | null, string | null, string | null, string | null,
  number, string, number, number,
];

type PendingMutation = FileCatalogSource | null;

export class FileDurableCatalog {
  readonly databasePath: string;
  private readonly catalogDir: string;
  private readonly rebuildMarker: string;
  private readonly rebuildLockPath: string;
  private readonly publishLockPath: string;
  private database: Database | undefined;
  private rebuilding = false;
  private rebuildPromise: Promise<DurableWorkflowCatalogEntries> | undefined;
  private catalogInvalid = false;
  private readonly pendingMutations = new Map<string, PendingMutation>();

  constructor(private readonly durableDir: string) {
    this.catalogDir = join(durableDir, CATALOG_DIR_NAME);
    this.databasePath = join(this.catalogDir, CATALOG_FILE_NAME);
    this.rebuildMarker = join(this.catalogDir, REBUILD_MARKER_NAME);
    this.rebuildLockPath = join(this.catalogDir, "catalog-rebuild");
    this.publishLockPath = join(this.catalogDir, "catalog-publish");
  }

  async prepare(scan: () => Promise<readonly FileCatalogSource[]>): Promise<DurableWorkflowCatalogEntries> {
    try {
      if (this.isFresh()) return this.readEntries();
    } catch {
      this.closeDatabase();
      this.catalogInvalid = true;
    }
    if (this.rebuildPromise !== undefined) return this.rebuildPromise;
    const rebuilding = this.rebuildAsync(scan);
    this.rebuildPromise = rebuilding;
    void rebuilding.finally(() => {
      if (this.rebuildPromise === rebuilding) this.rebuildPromise = undefined;
    });
    return rebuilding;
  }

  list(scan: () => readonly FileCatalogSource[]): DurableWorkflowCatalogEntries {
    try {
      if (this.isFresh()) return this.readEntries();
    } catch {
      this.closeDatabase();
      this.catalogInvalid = true;
    }
    return withDurableFileLock(this.rebuildLockPath, () => {
      try {
        if (this.isFresh()) return this.readEntries();
      } catch {
        this.closeDatabase();
        this.catalogInvalid = true;
      }
      this.rebuilding = true;
      try { return this.scanAndPublishSync(scan); }
      finally { this.rebuilding = false; }
    });
  }

  markDirty(workflowId: string): void {
    if (this.rebuilding) {
      this.pendingMutations.set(workflowId, null);
      return;
    }
    this.coordinatedWrite((database) => {
      database.query<never, [string]>("INSERT OR REPLACE INTO dirty_runs (workflow_id) VALUES (?)").run(workflowId);
    });
  }

  sync(source: FileCatalogSource): void {
    const workflowId = source.record.handle.workflowId;
    if (this.rebuilding) {
      this.pendingMutations.set(workflowId, source);
      return;
    }
    this.coordinatedWrite((database) => {
      const update = database.transaction(() => {
        this.upsert(database, source);
        database.query<never, [string]>("DELETE FROM dirty_runs WHERE workflow_id = ?").run(workflowId);
      });
      update();
    });
  }

  remove(workflowId: string): void {
    if (this.rebuilding) {
      this.pendingMutations.set(workflowId, null);
      return;
    }
    this.coordinatedWrite((database) => {
      const update = database.transaction(() => {
        database.query<never, [string]>("DELETE FROM runs WHERE workflow_id = ?").run(workflowId);
        database.query<never, [string]>("DELETE FROM dirty_runs WHERE workflow_id = ?").run(workflowId);
      });
      update();
    });
  }

  reset(): void {
    this.closeDatabase();
    rmSync(this.catalogDir, { recursive: true, force: true });
    this.pendingMutations.clear();
    this.catalogInvalid = false;
  }

  private async rebuildAsync(
    scan: () => Promise<readonly FileCatalogSource[]>,
  ): Promise<DurableWorkflowCatalogEntries> {
    return withDurableFileLockAsync(this.rebuildLockPath, async () => {
      try {
        if (this.isFresh()) return this.readEntries();
      } catch {
        this.closeDatabase();
        this.catalogInvalid = true;
      }
      this.rebuilding = true;
      try {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const directoryBefore = await withDurableFileLockAsync(this.publishLockPath, () => {
            rmSync(this.rebuildMarker, { force: true });
            return this.directorySignature();
          });
          const sources = await scan();
          const published = await withDurableFileLockAsync(this.publishLockPath, () => {
            const directoryAfter = this.directorySignature();
            const unstable = directoryBefore !== directoryAfter || existsSync(this.rebuildMarker);
            if (unstable && attempt === 0) return undefined;
            return this.publishRebuild(sources, !unstable, directoryAfter);
          });
          if (published !== undefined) return published;
        }
        return withDurableFileLockAsync(this.publishLockPath, () =>
          this.publishRebuild([], false, this.directorySignature()));
      } finally {
        this.rebuilding = false;
      }
    });
  }

  private scanAndPublishSync(
    scan: () => readonly FileCatalogSource[],
  ): DurableWorkflowCatalogEntries {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const directoryBefore = withDurableFileLock(this.publishLockPath, () => {
        rmSync(this.rebuildMarker, { force: true });
        return this.directorySignature();
      });
      const sources = scan();
      const published = withDurableFileLock(this.publishLockPath, () => {
        const directoryAfter = this.directorySignature();
        const unstable = directoryBefore !== directoryAfter || existsSync(this.rebuildMarker);
        if (unstable && attempt === 0) return undefined;
        return this.publishRebuild(sources, !unstable, directoryAfter);
      });
      if (published !== undefined) return published;
    }
    return withDurableFileLock(this.publishLockPath, () =>
      this.publishRebuild([], false, this.directorySignature()));
  }

  private publishRebuild(
    sources: readonly FileCatalogSource[],
    complete: boolean,
    directorySignature: string,
  ): DurableWorkflowCatalogEntries {
    if (this.catalogInvalid) this.closeAndRemoveDatabase();
    try {
      return this.writeRebuild(this.openDatabase(), sources, complete, directorySignature);
    } catch {
      this.closeAndRemoveDatabase();
      return this.writeRebuild(this.openDatabase(), sources, complete, directorySignature);
    }
  }

  private writeRebuild(
    database: Database,
    sources: readonly FileCatalogSource[],
    complete: boolean,
    directorySignature: string,
  ): DurableWorkflowCatalogEntries {
    const rebuild = database.transaction(() => {
      database.run("DELETE FROM runs");
      database.run("DELETE FROM dirty_runs");
      for (const source of sources) this.upsert(database, source);
      for (const [workflowId, source] of this.pendingMutations) {
        if (source === null) {
          database.query<never, [string]>("DELETE FROM runs WHERE workflow_id = ?").run(workflowId);
        } else {
          this.upsert(database, source);
        }
      }
      this.setMeta(database, "schema_version", String(CATALOG_SCHEMA_VERSION));
      this.setMeta(database, "complete", complete ? "1" : "0");
      this.setMeta(database, "directory_mtime_ms", directorySignature);
    });
    rebuild();
    this.pendingMutations.clear();
    this.catalogInvalid = false;
    if (!complete) this.writeRebuildMarker();
    return this.readEntries();
  }

  private isFresh(): boolean {
    if (existsSync(this.rebuildMarker)) return false;
    const database = this.openDatabase();
    if (this.getMeta(database, "schema_version") !== String(CATALOG_SCHEMA_VERSION)) {
      this.catalogInvalid = true;
      return false;
    }
    if (this.getMeta(database, "complete") !== "1") return false;
    if (this.getMeta(database, "directory_mtime_ms") !== this.directorySignature()) return false;
    const dirty = database.query<CountSqlRow, []>("SELECT COUNT(*) AS count FROM dirty_runs").get();
    return dirty?.count === 0;
  }

  private readEntries(): DurableWorkflowCatalogEntries {
    const rows = this.openDatabase().query<CatalogSqlRow, []>(`
      SELECT workflow_id, name, status, completed_checkpoints, pending_prompts,
        created_at, updated_at, label, root_workflow_id, resumable,
        invocation_cwd, workflow_cwd, repository_root, git_worktree_root,
        completed_openable, state_file, state_mtime_ms, state_size
      FROM runs ORDER BY updated_at DESC, workflow_id ASC
    `).all();
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

  private upsert(database: Database, source: FileCatalogSource): void {
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

  private openDatabase(): Database {
    if (this.database !== undefined) return this.database;
    mkdirSync(this.catalogDir, { recursive: true, mode: 0o700 });
    const databaseExisted = existsSync(this.databasePath);
    const database = new Database(this.databasePath, { create: true, strict: true });
    try {
      database.run("PRAGMA journal_mode = WAL");
      database.run("PRAGMA busy_timeout = 5000");
      if (!databaseExisted) {
        database.run(`
          CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE dirty_runs (workflow_id TEXT PRIMARY KEY);
          CREATE TABLE runs (
            workflow_id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL,
            completed_checkpoints INTEGER NOT NULL, pending_prompts INTEGER NOT NULL,
            created_at REAL NOT NULL, updated_at REAL NOT NULL, label TEXT,
            root_workflow_id TEXT, resumable INTEGER, invocation_cwd TEXT,
            workflow_cwd TEXT, repository_root TEXT, git_worktree_root TEXT,
            completed_openable INTEGER NOT NULL, state_file TEXT NOT NULL,
            state_mtime_ms REAL NOT NULL, state_size INTEGER NOT NULL
          );
          CREATE INDEX runs_updated ON runs(updated_at DESC, workflow_id ASC);
        `);
        this.setMeta(database, "schema_version", String(CATALOG_SCHEMA_VERSION));
        this.setMeta(database, "complete", "0");
      }
      try {
        chmodSync(this.catalogDir, 0o700);
        chmodSync(this.databasePath, 0o600);
      } catch { /* chmod is best effort on unsupported platforms. */ }
      this.database = database;
      return database;
    } catch {
      database.close(false);
      throw new Error("Durable workflow catalog is corrupt or incompatible");
    }
  }

  private advisoryWrite(operation: (database: Database) => void): void {
    try {
      operation(this.openDatabase());
    } catch {
      this.closeDatabase();
      this.catalogInvalid = true;
      this.writeRebuildMarker();
    }
  }

  private coordinatedWrite(operation: (database: Database) => void): void {
    try {
      withDurableFileLock(this.publishLockPath, () => {
        if (this.noteConcurrentRebuild()) return;
        this.advisoryWrite(operation);
      });
    } catch {
      this.writeRebuildMarker();
    }
  }

  private noteConcurrentRebuild(): boolean {
    if (!existsSync(`${this.rebuildLockPath}.lock`)) return false;
    this.writeRebuildMarker();
    return true;
  }

  private writeRebuildMarker(): void {
    try {
      mkdirSync(this.catalogDir, { recursive: true, mode: 0o700 });
      writeFileSync(this.rebuildMarker, "1\n", { mode: 0o600 });
    } catch { /* The authoritative state remains the source of truth. */ }
  }

  private getMeta(database: Database, key: string): string | undefined {
    return database.query<MetaSqlRow, [string]>("SELECT value FROM metadata WHERE key = ?").get(key)?.value;
  }

  private setMeta(database: Database, key: string, value: string): void {
    database.query<never, [string, string]>(
      "INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).run(key, value);
  }

  private directorySignature(): string {
    try { return String(statSync(this.durableDir).mtimeMs); }
    catch { return "missing"; }
  }

  private closeDatabase(): void {
    this.database?.close(false);
    this.database = undefined;
  }

  private closeAndRemoveDatabase(): void {
    this.closeDatabase();
    rmSync(this.databasePath, { force: true });
    rmSync(`${this.databasePath}-wal`, { force: true });
    rmSync(`${this.databasePath}-shm`, { force: true });
  }
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
