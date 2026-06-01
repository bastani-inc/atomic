/**
 * Status file writer — subscribes to store updates and emits an atomic
 * status JSON file for CI polling.
 *
 * Behaviour:
 * - Only active when config.statusFile === true.
 * - Default path: <projectRoot>/.atomic/workflows/status.json
 * - Atomic write via temp-file + rename (no torn reads by CI consumers).
 * - Flushes on every store update; guaranteed to flush on run terminal states
 *   (completed | failed | killed).
 * - Write errors surfaced as level:"warning" WorkflowNotice via store;
 *   duplicate errors are deduplicated so one notice per distinct error message.
 *
 * cross-ref: src/shared/types.ts WorkflowRuntimeConfig
 *            src/store.ts Store
 *            src/store-types.ts StoreSnapshot
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import type { Store } from "../shared/store.js";
import type { StoreSnapshot } from "../shared/store-types.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STATUS_SUBPATH = join(CONFIG_DIR_NAME, "workflows", "status.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StatusWriterOpts {
  /**
   * Project root used to resolve the default status file path.
   * Defaults to process.cwd() when absent.
   */
  projectRoot?: string;
}

export interface StatusWriter {
  /** Wait until all currently queued status writes have reached disk. */
  flush(): Promise<void>;
  /** Stop receiving store updates and cancel any pending flush. */
  unsubscribe(): void;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the effective status file path.
 *
 * Priority:
 * 1. config.statusFilePath (explicit override)
 * 2. <projectRoot>/.atomic/workflows/status.json  (default)
 */
export function resolveStatusFilePath(
  config: Pick<WorkflowRuntimeConfig, "statusFilePath">,
  opts: StatusWriterOpts = {},
): string {
  if (config.statusFilePath) return config.statusFilePath;
  const root = opts.projectRoot ?? process.cwd();
  return join(root, DEFAULT_STATUS_SUBPATH);
}

// ---------------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------------

/**
 * Write `content` to `path` atomically using a sibling temp file + rename.
 * Creates parent directories as needed.
 */
export async function atomicWriteJson(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, path);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a status writer that flushes StoreSnapshot to a JSON file on every
 * store update.
 *
 * Returns a no-op writer when config.statusFile is false.
 *
 * @example
 * ```ts
 * const writer = createStatusWriter(store, runtimeConfig, { projectRoot: process.cwd() });
 * // ... later on shutdown:
 * writer.unsubscribe();
 * ```
 */
export function createStatusWriter(
  store: Store,
  config: WorkflowRuntimeConfig,
  opts: StatusWriterOpts = {},
): StatusWriter {
  if (!config.statusFile) {
    return { async flush() {}, unsubscribe() {} };
  }

  const filePath = resolveStatusFilePath(config, opts);

  // Track last error message to deduplicate warning notices and avoid
  // re-entrant infinite loops when writes keep failing.
  let lastErrorMessage: string | null = null;

  let active = true;
  let writing = false;
  let pendingContent: string | null = null;
  let drainPromise: Promise<void> | null = null;

  function recordWriteError(err: unknown): void {
    const msg = err instanceof Error ? err.message : String(err);
    // Deduplicate: only record one notice per distinct error message.
    if (msg === lastErrorMessage) return;
    lastErrorMessage = msg;
    store.recordNotice({
      id: `status-writer-error-${Date.now()}`,
      level: "warning",
      message: `atomic-workflows: status file write failed (${filePath}): ${msg}`,
      createdAt: Date.now(),
    });
  }

  async function drainWrites(): Promise<void> {
    if (writing) return;
    writing = true;
    try {
      while (active && pendingContent !== null) {
        const content = pendingContent;
        pendingContent = null;
        try {
          await atomicWriteJson(filePath, content);
          // Clear error dedup on successful write.
          lastErrorMessage = null;
        } catch (err: unknown) {
          recordWriteError(err);
        }
      }
    } finally {
      writing = false;
    }
  }

  function ensureDrain(): Promise<void> {
    drainPromise ??= drainWrites().finally(() => {
      drainPromise = null;
      if (active && pendingContent !== null) void ensureDrain();
    });
    return drainPromise;
  }

  const unsubscribeStore = store.subscribe((snap: StoreSnapshot) => {
    pendingContent = JSON.stringify(snap, null, 2);
    void ensureDrain();
  });

  return {
    async flush() {
      while (active && (pendingContent !== null || drainPromise !== null)) {
        await ensureDrain();
      }
    },
    unsubscribe() {
      active = false;
      pendingContent = null;
      unsubscribeStore();
    },
  };
}
