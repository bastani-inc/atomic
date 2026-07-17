import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FileDurableRecord } from "./file-state.js";
import type { ResumableWorkflowEntry } from "./types.js";
import { withDurableFileLock, withDurableFileLockAsync } from "./file-lock.js";
import { readCatalogEntries, upsertCatalogRow } from "./catalog-rows.js";
import { ReconcileCoalescer } from "./catalog-reconcile.js";
import { timeCatalogPhase, timeCatalogPhaseAsync } from "./catalog-diagnostics.js";

// Schema 2 decouples freshness from the durable-directory mtime: a normal
// self-write no longer registers as drift (mtime dropped from the sync gate).
// A v1 catalog fails the schema check and cold-rebuilds once.
const CATALOG_SCHEMA_VERSION = 2;
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

interface CountSqlRow { count: number }
interface MetaSqlRow { value: string }
interface DirtyIdSqlRow { workflow_id: string }

/** Enumerate all authoritative durable sources (cold rebuild / reconcile). */
type AsyncScan = () => Promise<readonly FileCatalogSource[]>;
/** Synchronous variant for the rare cold rebuild inside {@link FileDurableCatalog.list}. */
type SyncScan = () => readonly FileCatalogSource[];
/** Repair only the journaled dirty ids from authoritative state (O(dirty)). */
type RepairDirty = (ids: readonly string[]) => void;

const NO_REPAIR: RepairDirty = () => { /* default when no repair callback is supplied */ };

type PendingMutation = FileCatalogSource | null;

/**
 * Persistent SQLite/WAL advisory index over the authoritative per-run durable
 * state files. The DB is a derived cache and always self-heals from the state
 * files. Freshness is split (contract §3, spec D2): {@link serveState} gates the
 * synchronous picker read purely on index integrity (no directory-mtime term, so
 * a known write stays servable → ZERO scans), while {@link needsReconcile} is a
 * non-gating drift hint that only schedules an async background reconcile.
 */
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
  private readonly reconciler = new ReconcileCoalescer(() => this.runReconcile());
  private reconcileScan: AsyncScan | undefined;
  private repairDirtyFn: RepairDirty = NO_REPAIR;

  constructor(private readonly durableDir: string) {
    this.catalogDir = join(durableDir, CATALOG_DIR_NAME);
    this.databasePath = join(this.catalogDir, CATALOG_FILE_NAME);
    this.rebuildMarker = join(this.catalogDir, REBUILD_MARKER_NAME);
    this.rebuildLockPath = join(this.catalogDir, "catalog-rebuild");
    this.publishLockPath = join(this.catalogDir, "catalog-publish");
  }

  async prepare(scan: AsyncScan, repairDirty: RepairDirty = NO_REPAIR): Promise<DurableWorkflowCatalogEntries> {
    this.reconcileScan = scan;
    this.repairDirtyFn = repairDirty;
    try {
      const served = this.serveIfServable();
      if (served !== undefined) return served;
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

  list(
    scan: SyncScan,
    repairDirty: RepairDirty = NO_REPAIR,
    reconcileScan?: AsyncScan,
  ): DurableWorkflowCatalogEntries {
    if (reconcileScan !== undefined) this.reconcileScan = reconcileScan;
    this.repairDirtyFn = repairDirty;
    try {
      const served = this.serveIfServable();
      if (served !== undefined) return served;
    } catch {
      this.closeDatabase();
      this.catalogInvalid = true;
    }
    return withDurableFileLock(this.rebuildLockPath, () => {
      try {
        const served = this.serveIfServable();
        if (served !== undefined) return served;
      } catch {
        this.closeDatabase();
        this.catalogInvalid = true;
      }
      this.rebuilding = true;
      try { return this.scanAndPublishSync(scan); }
      finally { this.rebuilding = false; }
    });
  }

  /**
   * Await any scheduled background reconcile to drain, then force one final
   * reconcile so the catalog is guaranteed converged against the current
   * directory state. Test/strong-consistency seam only.
   */
  async whenReconciled(scan: AsyncScan, repairDirty: RepairDirty = NO_REPAIR): Promise<DurableWorkflowCatalogEntries> {
    this.reconcileScan = scan;
    this.repairDirtyFn = repairDirty;
    await this.reconciler.drain();
    return this.reconcileAsync(scan);
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
        upsertCatalogRow(database, source);
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

  /** Journaled dirty ids awaiting targeted repair (crash-safety, O(dirty)). */
  dirtyIds(): readonly string[] {
    return this.openDatabase()
      .query<DirtyIdSqlRow, []>("SELECT workflow_id FROM dirty_runs")
      .all().map((row) => row.workflow_id);
  }

  /** Monotone self-write watermark (coalescing / diagnostics; never a gate). */
  generation(): number {
    try {
      const value = Number(this.getMeta(this.openDatabase(), "generation") ?? "0");
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Serve indexed rows when servable, repairing journaled dirty ids in place
   * first (targeted, never a scan). Returns undefined when a cold rebuild is
   * required; schedules a background reconcile on drift (never a sync scan).
   */
  private serveIfServable(): DurableWorkflowCatalogEntries | undefined {
    const state = timeCatalogPhase("freshness", () => this.serveState(), (result) => result);
    if (state === "cold") return undefined;
    if (state === "dirty") {
      const ids = this.dirtyIds();
      timeCatalogPhase("dirty-repair", () => this.repairDirtyFn(ids), () => `ids:${ids.length}`);
      if (this.serveState() !== "servable") return undefined;
    }
    const entries = timeCatalogPhase(
      "sql-query",
      () => readCatalogEntries(this.openDatabase()),
      (result) => `resumable:${result.resumable.length} completed:${result.completed.length}`,
    );
    if (this.needsReconcile()) this.scheduleReconcile();
    return entries;
  }

  private scheduleReconcile(): void {
    this.reconciler.schedule();
  }

  private async runReconcile(): Promise<void> {
    const scan = this.reconcileScan;
    if (scan === undefined) return;
    await this.reconcileAsync(scan);
  }

  /**
   * Background out-of-band reconcile. Reuses the cold-rebuild lock nest, but
   * (unlike {@link rebuildAsync}) does not short out on a servable-but-drifted
   * catalog — it must scan to absorb external changes. When the signature
   * already matches, the scan is skipped (coalesced follow-ups → O(1) scans).
   */
  private async reconcileAsync(scan: AsyncScan): Promise<DurableWorkflowCatalogEntries> {
    return withDurableFileLockAsync(this.rebuildLockPath, async () => {
      try {
        if (!this.needsReconcile() && this.serveState() === "servable") {
          return timeCatalogPhase("sql-query", () => readCatalogEntries(this.openDatabase()));
        }
      } catch {
        this.closeDatabase();
        this.catalogInvalid = true;
      }
      this.rebuilding = true;
      try {
        return await timeCatalogPhaseAsync(
          "background-reconcile",
          () => this.runScanPublishAsync(scan),
          (result) => `resumable:${result.resumable.length}`,
        );
      } finally {
        this.rebuilding = false;
      }
    });
  }

  private async rebuildAsync(scan: AsyncScan): Promise<DurableWorkflowCatalogEntries> {
    return withDurableFileLockAsync(this.rebuildLockPath, async () => {
      try {
        const served = this.serveIfServable();
        if (served !== undefined) return served;
      } catch {
        this.closeDatabase();
        this.catalogInvalid = true;
      }
      this.rebuilding = true;
      try { return await this.runScanPublishAsync(scan); }
      finally { this.rebuilding = false; }
    });
  }

  private async runScanPublishAsync(scan: AsyncScan): Promise<DurableWorkflowCatalogEntries> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const directoryBefore = await withDurableFileLockAsync(this.publishLockPath, () => {
        rmSync(this.rebuildMarker, { force: true });
        return this.directorySignature();
      });
      const sources = await timeCatalogPhaseAsync("resource-discovery", scan, (result) => `files:${result.length}`);
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
  }

  private scanAndPublishSync(scan: SyncScan): DurableWorkflowCatalogEntries {
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
      for (const source of sources) upsertCatalogRow(database, source);
      for (const [workflowId, source] of this.pendingMutations) {
        if (source === null) {
          database.query<never, [string]>("DELETE FROM runs WHERE workflow_id = ?").run(workflowId);
        } else {
          upsertCatalogRow(database, source);
        }
      }
      this.setMeta(database, "schema_version", String(CATALOG_SCHEMA_VERSION));
      this.setMeta(database, "complete", complete ? "1" : "0");
      // D1: the reconciled directory signature is advanced ONLY here (full/
      // background reconcile), never by incremental sync/remove — otherwise a
      // self-write could bless an externally-interleaved deletion.
      this.setMeta(database, "reconciled_dir_signature", directorySignature);
      this.bumpGeneration(database);
    });
    rebuild();
    this.pendingMutations.clear();
    this.catalogInvalid = false;
    if (!complete) this.writeRebuildMarker();
    return readCatalogEntries(database);
  }

  /**
   * Synchronous integrity gate (contract §3). Purely index-local: no directory
   * signature term. `cold` → rebuild; `dirty` → targeted repair then serve;
   * `servable` → serve indexed rows immediately.
   */
  private serveState(): "cold" | "dirty" | "servable" {
    if (existsSync(this.rebuildMarker)) return "cold";
    const database = this.openDatabase();
    if (this.getMeta(database, "schema_version") !== String(CATALOG_SCHEMA_VERSION)) {
      this.catalogInvalid = true;
      return "cold";
    }
    if (this.getMeta(database, "complete") !== "1") return "cold";
    const dirty = database.query<CountSqlRow, []>("SELECT COUNT(*) AS count FROM dirty_runs").get();
    return (dirty?.count ?? 0) > 0 ? "dirty" : "servable";
  }

  /** Non-gating drift hint: only ever schedules a background reconcile. */
  private needsReconcile(): boolean {
    try {
      return this.getMeta(this.openDatabase(), "reconciled_dir_signature") !== this.directorySignature();
    } catch {
      return true;
    }
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
        this.setMeta(database, "generation", "0");
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
        // D3: every coordinated self-write advances the monotone generation in
        // the same publish-locked transaction as the row mutation.
        this.advisoryWrite((database) => {
          operation(database);
          this.bumpGeneration(database);
        });
      });
    } catch {
      this.writeRebuildMarker();
    }
  }

  private bumpGeneration(database: Database): void {
    const current = Number(this.getMeta(database, "generation") ?? "0");
    this.setMeta(database, "generation", String(Number.isFinite(current) ? current + 1 : 1));
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
