/**
 * Durable backend factory.
 *
 * Resolves which backend to use based on configuration:
 * - Explicit override (for testing)
 * - DBOS/Postgres when `DBOS_SYSTEM_DATABASE_URL` is set and durability is not opted out
 * - File-backed fallback (default; zero infrastructure)
 *
 * cross-ref: issue #1498
 */

import type { DurableWorkflowBackend } from "./backend.js";
import { InMemoryDurableBackend } from "./backend.js";
import { FileDurableBackend, WorkflowFileDurableBackend, defaultDurableStateDir, durableStateFileFor } from "./file-backend.js";
import { createDbosDurableBackend } from "./dbos-backend.js";

let globalBackend: DurableWorkflowBackend | undefined;
let dbosInit: Promise<DurableWorkflowBackend | undefined> | undefined;

const DURABLE_OPT_OUT_ENV = "ATOMIC_WORKFLOW_DURABLE";

/**
 * Get the singleton durable backend. Creates one lazily on first call.
 * - If a backend was explicitly set via {@link setDurableBackend}, returns it.
 * - If `DBOS_SYSTEM_DATABASE_URL` is configured and durability was not opted
 *   out, the extension runtime upgrades to a DBOS-backed backend on launch.
 * - Otherwise returns the zero-infrastructure per-workflow file backend rooted
 *   under `~/.atomic/workflow-durable`, so cross-session resume is available by
 *   default without an opt-in environment variable. Set
 *   `ATOMIC_WORKFLOW_DURABLE=0` (or `false`/`off`/`memory`) to fail closed to
 *   process-local in-memory durability for sensitive environments.
 */
export function getDurableBackend(): DurableWorkflowBackend {
  if (globalBackend) return globalBackend;
  if (isDurabilityOptedOut()) {
    globalBackend = createInMemoryBackend();
    return globalBackend;
  }
  // Always enable cross-session durability by default. DBOS initialization is
  // async because the SDK is optional; the file backend is the durable baseline
  // and remains the safe fallback if DBOS is unavailable.
  globalBackend = createDefaultFileBackend();
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

/** Initialize and install the DBOS backend when DBOS_SYSTEM_DATABASE_URL is set. */
export async function initializeDbosDurableBackendFromEnv(): Promise<DurableWorkflowBackend | undefined> {
  if (isDurabilityOptedOut()) return undefined;
  const dbosUrl = process.env.DBOS_SYSTEM_DATABASE_URL;
  if (dbosUrl === undefined || dbosUrl.length === 0) return undefined;
  dbosInit ??= createDbosDurableBackend({ systemDatabaseUrl: dbosUrl }).then((backend) => {
    setDurableBackend(backend);
    return backend;
  });
  return dbosInit;
}

/**
 * Create the default durable backend. If no user home directory can be resolved,
 * fail closed to the process-local in-memory backend instead of writing to /tmp.
 */
export function createDefaultFileBackend(): DurableWorkflowBackend {
  const dir = defaultDurableStateDir();
  if (dir === undefined) return createInMemoryBackend();
  return new WorkflowFileDurableBackend(dir);
}

/**
 * Create a file-backed backend for a specific workflow id.
 * Each workflow gets its own state file for fast load/save.
 */
export function createWorkflowFileBackend(workflowId: string): DurableWorkflowBackend {
  const dir = defaultDurableStateDir();
  if (dir === undefined) return createInMemoryBackend();
  return new FileDurableBackend(durableStateFileFor(dir, workflowId), workflowId);
}

function isDurabilityOptedOut(): boolean {
  const value = process.env[DURABLE_OPT_OUT_ENV]?.toLowerCase();
  return value === "0" || value === "false" || value === "off" || value === "memory" || value === "in-memory";
}
