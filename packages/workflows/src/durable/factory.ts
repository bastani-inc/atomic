/** DBOS-first durable backend factory with a non-durable last-resort fallback. */

import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";
import {
  DbosNotReadyError,
  getReadyDbosBackend,
  getReadyDbosBackendSync,
} from "./dbos-lifecycle.js";

let injectedBackend: DurableWorkflowBackend | undefined;
let initializedBackend: DurableWorkflowBackend | undefined;
let initializing: Promise<DurableWorkflowBackend> | undefined;

/** Return the injected test backend or the process-wide initialized backend. */
export function getDurableBackend(): DurableWorkflowBackend {
  const backend = injectedBackend ?? initializedBackend ?? getReadyDbosBackendSync();
  if (backend === undefined) throw new DbosNotReadyError();
  return backend;
}

/** Internal injection seam. Production initialization uses DBOS. */
export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
  injectedBackend = backend;
  if (backend === undefined) {
    initializedBackend = undefined;
    initializing = undefined;
  }
}

/** Create an isolated current-interface backend for tests only. */
export function createInMemoryTestBackend(): InMemoryDurableBackend {
  return new InMemoryDurableBackend();
}

/**
 * Configure, register, launch, and install the DBOS backend.
 *
 * When no durable backend can be provisioned (no `DBOS_SYSTEM_DATABASE_URL`,
 * embedded Postgres unavailable — e.g. running as root without an
 * unprivileged account — and no Docker), workflows degrade to a process-local
 * in-memory backend with a loud warning instead of refusing to run at all.
 * Non-durable runs execute normally but do not survive the process:
 * `/workflow resume` after exit has nothing to restore.
 */
export async function initializeDurableBackend(): Promise<DurableWorkflowBackend> {
  if (injectedBackend !== undefined) return injectedBackend;
  if (initializedBackend !== undefined) return initializedBackend;
  initializing ??= getReadyDbosBackend()
    .catch((error: unknown) => degradeToNonDurableBackend(error))
    .then((backend) => {
      initializedBackend = backend;
      return backend;
    });
  return await initializing;
}

function degradeToNonDurableBackend(error: unknown): DurableWorkflowBackend {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(
    "atomic-workflows: durable backend unavailable — continuing NON-DURABLY with an in-memory backend. "
    + "Workflow runs will execute, but their state will not survive this process and `/workflow resume` "
    + `after exit will not work. Restore durability by fixing Postgres provisioning: ${detail}`,
  );
  return new InMemoryDurableBackend();
}
