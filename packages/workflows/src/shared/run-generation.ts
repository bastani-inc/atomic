import type { RunSnapshot } from "./store-types.js";

/** The generation a pause publishes, whether local suspension or its durable acknowledgement comes first. */
export function generationAtPause(run: RunSnapshot): number {
	return (run.runGeneration ?? 0) + (run.status === "paused" || run.blockedAt !== undefined ? 0 : 1);
}
