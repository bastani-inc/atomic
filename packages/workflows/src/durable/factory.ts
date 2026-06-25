/**
 * Durable backend factory.
 *
 * Resolves which backend to use based on configuration:
 * - Explicit override (for testing)
 * - DBOS/Postgres when `DBOS_SYSTEM_DATABASE_URL` is set
 * - File-backed fallback (default; zero infrastructure)
 *
 * cross-ref: issue #1498
 */

import type { DurableWorkflowBackend } from "./backend.js";
import { InMemoryDurableBackend } from "./backend.js";
import { FileDurableBackend, defaultDurableStateDir, durableStateFileFor } from "./file-backend.js";

let globalBackend: DurableWorkflowBackend | undefined;

/**
 * Get the singleton durable backend. Creates one lazily on first call.
 * - If a backend was explicitly set via {@link setDurableBackend}, returns it.
 * - If `DBOS_SYSTEM_DATABASE_URL` is set, the extension runtime upgrades to a
 *   DBOS-backed backend on launch.
 * - If `ATOMIC_WORKFLOW_DURABLE_DIR` is set, returns a file-backed backend for
 *   opt-in cross-process resume without Postgres.
 * - Otherwise returns an {@link InMemoryDurableBackend}. Cross-session resume
 *   is opt-in: a process-local backend avoids writing to the user's home
 *   directory on every run and keeps the session lifecycle log clean. Set
 *   `ATOMIC_WORKFLOW_DURABLE_DIR` or `DBOS_SYSTEM_DATABASE_URL` to enable
 *   cross-session durable resume.
 */
export function getDurableBackend(): DurableWorkflowBackend {
  if (globalBackend) return globalBackend;
  const durableDir = process.env.ATOMIC_WORKFLOW_DURABLE_DIR;
  const dbosUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
  if ((durableDir && durableDir.length > 0) || (dbosUrl && dbosUrl.length > 0)) {
    // Opt-in cross-session persistence (file or DBOS). The DBOS adapter is
    // upgraded by the extension runtime on launch when DBOS_SYSTEM_DATABASE_URL
    // is set; until then the file backend provides cross-process resume.
    globalBackend = createDefaultFileBackend();
  } else {
    // Default: process-local. No filesystem writes; no session-log pollution.
    globalBackend = new InMemoryDurableBackend();
  }
  return globalBackend;
}

/**
 * Explicitly set the durable backend. Used by tests and by the extension
 * runtime when it initializes DBOS.
 */
export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
  globalBackend = backend;
}

/**
 * Create a fresh in-memory backend (for tests).
 */
export function createInMemoryBackend(): InMemoryDurableBackend {
  return new InMemoryDurableBackend();
}

/**
 * Create a file-backed backend rooted at the default durable state dir.
 */
export function createDefaultFileBackend(): DurableWorkflowBackend {
  const dir = defaultDurableStateDir();
  // Use a shared file per workflow; the factory returns a backend that
  // will load the correct file on first access per workflow id.
  // For simplicity, we use a single shared file per backend instance.
  // The FileDurableBackend handles per-workflow files internally via
  // the workflowId in the file path.
  return new FileDurableBackend(`${dir}/state.json`);
}

/**
 * Create a file-backed backend for a specific workflow id.
 * Each workflow gets its own state file for fast load/save.
 */
export function createWorkflowFileBackend(workflowId: string): DurableWorkflowBackend {
  const dir = defaultDurableStateDir();
  return new FileDurableBackend(durableStateFileFor(dir, workflowId));
}
