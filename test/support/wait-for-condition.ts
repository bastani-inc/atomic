import { performance } from "node:perf_hooks";

const DEFAULT_TIMEOUT_MS = 2_000;
const POLL_INTERVAL_MS = 5;

export async function waitForCondition(label: string, predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + DEFAULT_TIMEOUT_MS;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}
