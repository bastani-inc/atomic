/**
 * Debug-gated phase-timing emitter for the durable workflow catalog.
 *
 * Silent unless `ATOMIC_WORKFLOW_DEBUG === "1"`. When the flag is unset the only
 * cost on the picker hot path is a single environment read, so the timed
 * variants below fall straight through to the wrapped call without touching
 * `performance.now()` or allocating a detail string. Phases mirror the
 * contract's enumerated discovery / open+freshness / dirty-repair /
 * background-reconcile / sql-query / selected-hydration stages (contract §7).
 */
import { performance } from "node:perf_hooks";

export type CatalogPhase =
  | "resource-discovery"
  | "index-open"
  | "freshness"
  | "dirty-repair"
  | "background-reconcile"
  | "sql-query"
  | "selected-hydration";

/** Whether catalog phase diagnostics are enabled for this process. */
export function catalogDebugEnabled(): boolean {
  return process.env.ATOMIC_WORKFLOW_DEBUG === "1";
}

/** Emit a single quiet phase-timing line; no-op unless debug is enabled. */
export function emitCatalogPhase(phase: CatalogPhase, elapsedMs: number, detail?: string): void {
  if (!catalogDebugEnabled()) return;
  const rounded = Math.round(elapsedMs * 1000) / 1000;
  console.warn(`[workflows.catalog] ${phase} ${rounded}ms${detail !== undefined ? ` ${detail}` : ""}`);
}

/**
 * Time a synchronous phase. When diagnostics are disabled this is exactly
 * `fn()` with no extra work; the `detail` builder is invoked only when a line
 * will actually be emitted.
 */
export function timeCatalogPhase<T>(
  phase: CatalogPhase,
  fn: () => T,
  detail?: (result: T) => string,
): T {
  if (!catalogDebugEnabled()) return fn();
  const start = performance.now();
  const result = fn();
  emitCatalogPhase(phase, performance.now() - start, detail?.(result));
  return result;
}

/** Async counterpart to {@link timeCatalogPhase}. */
export async function timeCatalogPhaseAsync<T>(
  phase: CatalogPhase,
  fn: () => Promise<T>,
  detail?: (result: T) => string,
): Promise<T> {
  if (!catalogDebugEnabled()) return fn();
  const start = performance.now();
  const result = await fn();
  emitCatalogPhase(phase, performance.now() - start, detail?.(result));
  return result;
}
