/**
 * Daemon workflow registry.
 *
 * Reads ~/.atomic/settings.json and (cwd-relative) .atomic/settings.json,
 * merges workflow registrations, dynamically imports each registered Mode 1
 * workflow file, and caches WorkflowDefinition objects with metadata.
 *
 * Replaces _emit-workflow-meta subprocess spawning for daemon-mode workflow
 * discovery. §4.3 / §5.7 of the 2026-05-09 UI server RFC.
 */

import { existsSync } from "node:fs";
import type { AgentType, WorkflowDefinition } from "../types.ts";
import {
  readAtomicConfigSplit,
  getGlobalSettingsPath,
  getLocalSettingsPath,
} from "../services/config/atomic-config.ts";

// ─── Public types ─────────────────────────────────────────────────────────────

/**
 * Slim descriptor returned by `workflow/list` — enough for the UI to render
 * a picker row without sending the full WorkflowDefinition over the wire.
 */
export interface WorkflowDescriptor {
  /** Unique workflow name (the alias used to start the workflow). */
  name: string;
  /** Optional human-readable display name. */
  displayName?: string;
  /** Absolute path to the source file. */
  source: string;
  /** Agent this workflow targets. */
  agent: AgentType;
  /** Declared input schema — workflow-specific, intentionally untyped here. */
  inputs?: unknown;
}

/**
 * A workflow registration that failed to import or produced no usable
 * definition. Surfaced by `load()` and `refresh()`.
 */
export interface BrokenEntry {
  /** Absolute path (or command string) of the failed source. */
  source: string;
  /** Human-readable failure reason. */
  error: string;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface CacheEntry {
  definition: WorkflowDefinition;
  descriptor: WorkflowDescriptor;
  /** Resolved absolute path used as the cache key. */
  source: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Runtime guard — checks the compiled workflow brand. */
function isWorkflowDefinition(value: unknown): value is WorkflowDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __brand?: unknown }).__brand === "WorkflowDefinition"
  );
}

/**
 * Extract WorkflowDefinition(s) from a dynamically-imported module.
 *
 * Resolution order (mirrors orchestrator-entry.ts):
 *   1. `mod.default` — traditional export-default pattern.
 *   2. Named exports — any WorkflowDefinition branded object.
 *   3. `getCompiledWorkflows()` side-effect registry — for modules that call
 *      compile() but don't re-export the result.
 *
 * Returns all definitions found (a single file may compile multiple agents).
 */
function extractDefinitions(mod: unknown): WorkflowDefinition[] {
  if (!mod || typeof mod !== "object") return [];

  const record = mod as Record<string, unknown> & {
    getCompiledWorkflows?: () => readonly WorkflowDefinition[];
  };
  const found: WorkflowDefinition[] = [];

  if (isWorkflowDefinition(record.default)) {
    found.push(record.default);
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "default") continue;
    if (isWorkflowDefinition(value) && !found.includes(value)) {
      found.push(value);
    }
  }

  if (found.length === 0 && typeof record.getCompiledWorkflows === "function") {
    for (const wf of record.getCompiledWorkflows()) {
      if (!found.includes(wf)) found.push(wf);
    }
  }

  return found;
}

/**
 * Dynamically import a single source file and return all WorkflowDefinitions
 * found inside it, or a BrokenEntry on failure.
 */
async function importSource(
  sourcePath: string,
): Promise<{ definitions: WorkflowDefinition[]; broken: BrokenEntry | null }> {
  let mod: unknown;
  try {
    mod = await import(sourcePath);
  } catch (err) {
    return {
      definitions: [],
      broken: {
        source: sourcePath,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const definitions = extractDefinitions(mod);

  if (definitions.length === 0) {
    const record = mod as Record<string, unknown>;
    const hasDefault = "default" in record;
    const reason = hasDefault
      ? `missing compile() — default export is not a WorkflowDefinition`
      : `no default export`;
    return {
      definitions: [],
      broken: { source: sourcePath, error: reason },
    };
  }

  return { definitions, broken: null };
}

/** Build a WorkflowDescriptor from a WorkflowDefinition + resolved source path. */
function toDescriptor(def: WorkflowDefinition, source: string): WorkflowDescriptor {
  return {
    name: def.name,
    displayName: def.description || undefined,
    source,
    agent: def.agent,
    inputs: def.inputs.length > 0 ? def.inputs : undefined,
  };
}

// ─── WorkflowRegistry ─────────────────────────────────────────────────────────

/**
 * Daemon-side workflow registry.
 *
 * On `load()` / `refresh()`:
 *   - Reads global (~/.atomic/settings.json) and local (.atomic/settings.json).
 *   - Merges workflow registrations (local > global precedence for same alias).
 *   - Dynamically imports each registered source file.
 *   - Caches WorkflowDefinition + WorkflowDescriptor pairs in memory.
 *
 * All read operations (`list`, `get`, `getDescriptor`, `getBySource`) are O(N)
 * over the in-memory cache — no subprocess spawn, no disk I/O after load.
 */
export class WorkflowRegistry {
  /** Keyed by workflow name (the alias / `def.name`). */
  private readonly byName = new Map<string, CacheEntry>();
  /** Keyed by resolved source path. */
  private readonly bySource = new Map<string, CacheEntry[]>();

  private loaded = false;

  /** Shared in-flight Promises so concurrent callers don't race; nulled on settle. */
  private loadInFlight: Promise<{ count: number; broken: BrokenEntry[] }> | null = null;
  private refreshInFlight: Promise<{ count: number; broken: BrokenEntry[] }> | null = null;

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Read settings files and import all registered workflow sources.
   * Idempotent — calling `load()` a second time is a no-op (use `refresh()`
   * for hot-reload). Concurrent callers share one in-flight Promise; if a
   * `refresh()` is in-flight, `load()` adopts its result rather than racing
   * a parallel import pass.
   */
  async load(): Promise<{ count: number; broken: BrokenEntry[] }> {
    if (this.loaded) return { count: this.byName.size, broken: [] };
    if (this.refreshInFlight) return this.refreshInFlight;
    if (this.loadInFlight) return this.loadInFlight;

    this.loadInFlight = this._importAll()
      .then((r) => { this.loaded = true; return r; })
      .finally(() => { this.loadInFlight = null; });
    return this.loadInFlight;
  }

  /** Return all cached workflow descriptors. */
  list(): WorkflowDescriptor[] {
    const seen = new Set<WorkflowDefinition>();
    const result: WorkflowDescriptor[] = [];
    for (const entry of this.byName.values()) {
      if (!seen.has(entry.definition)) {
        seen.add(entry.definition);
        result.push(entry.descriptor);
      }
    }
    return result;
  }

  /** Look up a WorkflowDefinition by workflow name (alias). Returns null when not found. */
  get(name: string): WorkflowDefinition | null {
    return this.byName.get(name)?.definition ?? null;
  }

  /** Look up a WorkflowDescriptor by workflow name. Returns null when not found. */
  getDescriptor(name: string): WorkflowDescriptor | null {
    return this.byName.get(name)?.descriptor ?? null;
  }

  /**
   * Look up a WorkflowDefinition by source path.
   * When a source exports multiple definitions, returns the first one.
   * Use `list()` + filter by source for multi-definition sources.
   */
  getBySource(source: string): WorkflowDefinition | null {
    const entries = this.bySource.get(source);
    return entries?.[0]?.definition ?? null;
  }

  /**
   * Re-import all registered source files from scratch.
   * Clears the existing cache before re-importing so stale entries don't persist.
   *
   * Queue semantics (RFC §9): if a `load()` is in-flight, refresh() waits for
   * it to settle before clearing caches and starting its own import pass.
   * Concurrent `refresh()` callers share one in-flight Promise.
   */
  async refresh(): Promise<{ count: number; broken: BrokenEntry[] }> {
    if (this.refreshInFlight) return this.refreshInFlight;

    // Wait for any in-flight load to complete before we clear caches.
    const predecessor = this.loadInFlight ?? Promise.resolve();

    this.refreshInFlight = predecessor
      .catch(() => { /* ignore load errors — we're refreshing regardless */ })
      .then(() => {
        this.byName.clear();
        this.bySource.clear();
        this.loaded = false;
        return this._importAll();
      })
      .then((r) => { this.loaded = true; return r; })
      .finally(() => { this.refreshInFlight = null; });

    return this.refreshInFlight;
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  /**
   * Read settings, collect unique source paths, import each, populate cache.
   */
  private async _importAll(): Promise<{ count: number; broken: BrokenEntry[] }> {
    const sources = await this._collectSources();
    if (sources.length === 0) {
      return { count: 0, broken: [] };
    }

    const broken: BrokenEntry[] = [];
    let count = 0;

    await Promise.all(
      sources.map(async (sourcePath) => {
        const result = await importSource(sourcePath);

        if (result.broken) {
          broken.push(result.broken);
          return;
        }

        for (const def of result.definitions) {
          const entry: CacheEntry = {
            definition: def,
            descriptor: toDescriptor(def, sourcePath),
            source: sourcePath,
          };

          // Last-write wins on name collision (local > global handled via source ordering).
          this.byName.set(def.name, entry);

          const existing = this.bySource.get(sourcePath) ?? [];
          existing.push(entry);
          this.bySource.set(sourcePath, existing);

          count++;
        }
      }),
    );

    return { count, broken };
  }

  /**
   * Read global and local settings.json, merge workflow registrations, return
   * deduplicated list of absolute source paths to import.
   *
   * Precedence: local > global — same alias key in local replaces global entry.
   * Missing settings files are treated as empty (not an error).
   *
   * Mode 2 (external subprocess) entries are skipped; the daemon registry
   * only imports Mode 1 (direct import) workflow files.
   */
  private async _collectSources(): Promise<string[]> {
    let split: Awaited<ReturnType<typeof readAtomicConfigSplit>>;
    try {
      split = await readAtomicConfigSplit(process.cwd());
    } catch {
      return [];
    }

    // Merge alias → source path. Global first, local overrides on collision.
    const merged: Record<string, string> = {};
    for (const cfg of [split.global, split.local]) {
      for (const [alias, entry] of Object.entries(cfg?.workflows ?? {})) {
        if (isMode1Source(entry.command)) merged[alias] = entry.command;
      }
    }

    // Deduplicate source paths (multiple aliases may point to same file).
    return [...new Set(Object.values(merged))];
  }
}

/**
 * Determine whether a workflow `command` string is a Mode 1 source — a
 * TypeScript/JavaScript file path that the daemon can import() directly —
 * as opposed to a Mode 2 external binary command (e.g. `bunx my-tool`) that
 * requires the _emit-workflow-meta subprocess protocol.
 *
 * Resolution order (RFC §5.5):
 *   1. Filesystem check: if the path resolves to an actual file on disk,
 *      it is Mode 1 (handles Windows absolute paths like `C:\workflows\my-wf`
 *      and extensionless scripts that already exist).
 *   2. Extension check: recognise .ts/.tsx/.js/.mjs/.cjs suffixes for
 *      tilde-paths, glob inputs that haven't expanded yet, and pre-bundled
 *      paths that don't yet exist on disk in the current cwd.
 *
 * Mode 2 commands (`bunx my-tool`, `node dist/runner`, etc.) return `false`.
 */
export function isMode1Source(command: string): boolean {
  try {
    if (existsSync(command)) return true;
  } catch {
    // existsSync rarely throws; fall through to the extension check.
  }
  return /\.(ts|tsx|js|mjs|cjs)$/.test(command);
}

// ─── Convenience path exports (re-export for callers that want them) ──────────

export { getGlobalSettingsPath, getLocalSettingsPath };
