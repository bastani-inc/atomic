/** DBOS-only durable backend factory and internal test injection seam. */

import { InMemoryDurableBackend, type DurableWorkflowBackend } from "./backend.js";
import {
  DbosNotReadyError,
  getReadyDbosBackend,
  getReadyDbosBackendSync,
} from "./dbos-lifecycle.js";

let injectedBackend: DurableWorkflowBackend | undefined;
let initializedBackend: DurableWorkflowBackend | undefined;

/** Return the injected test backend or the process-wide ready DBOS backend. */
export function getDurableBackend(): DurableWorkflowBackend {
  const backend = injectedBackend ?? initializedBackend ?? getReadyDbosBackendSync();
  if (backend === undefined) throw new DbosNotReadyError();
  return backend;
}

/** Internal injection seam. Production initialization uses DBOS. */
export function setDurableBackend(backend: DurableWorkflowBackend | undefined): void {
  injectedBackend = backend;
  if (backend === undefined) initializedBackend = undefined;
}

/** Create an isolated current-interface backend for tests only. */
export function createInMemoryTestBackend(): InMemoryDurableBackend {
  return new InMemoryDurableBackend();
}

/** Configure, register, launch, and install the mandatory DBOS backend. */
export async function initializeDurableBackend(): Promise<DurableWorkflowBackend> {
  if (injectedBackend !== undefined) return injectedBackend;
  initializedBackend ??= await getReadyDbosBackend();
  return initializedBackend;
}
