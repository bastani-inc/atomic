/**
 * Status file writer — subscribes to store updates and emits an atomic
 * status JSON file for CI polling.
 *
 * Behaviour:
 * - Only active when config.statusFile === true.
 * - Default path: <projectRoot>/.pi/workflows/status.json
 * - Atomic write via temp-file + rename (no torn reads by CI consumers).
 * - Flushes on every store update; guaranteed to flush on run terminal states
 *   (completed | failed | killed).
 * - Write errors surfaced as level:"warning" WorkflowNotice via store;
 *   duplicate errors are deduplicated so one notice per distinct error message.
 *
 * cross-ref: packages/pi-workflows/src/shared/types.ts WorkflowRuntimeConfig
 *            packages/pi-workflows/src/store.ts Store
 *            packages/pi-workflows/src/store-types.ts StoreSnapshot
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Store } from "../store.js";
import type { StoreSnapshot } from "../store-types.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_STATUS_SUBPATH = join(".pi", "workflows", "status.json");

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
 * 2. <projectRoot>/.pi/workflows/status.json  (default)
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
    return { unsubscribe() {} };
  }

  const filePath = resolveStatusFilePath(config, opts);

  // Track last error message to deduplicate warning notices and avoid
  // re-entrant infinite loops when writes keep failing.
  let lastErrorMessage: string | null = null;

  const unsubscribe = store.subscribe((snap: StoreSnapshot) => {
    void atomicWriteJson(filePath, JSON.stringify(snap, null, 2))
      .then(() => {
        // Clear error dedup on successful write.
        lastErrorMessage = null;
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Deduplicate: only record one notice per distinct error message.
        if (msg === lastErrorMessage) return;
        lastErrorMessage = msg;
        store.recordNotice({
          id: `status-writer-error-${Date.now()}`,
          level: "warning",
          message: `pi-workflows: status file write failed (${filePath}): ${msg}`,
          createdAt: Date.now(),
        });
      });
  });

  return { unsubscribe };
}
