import type { EvictWhenWaiting } from "./authoring-contract-stage.js";
import { RunEvictionConfigError } from "./run-eviction-errors.js";
import { MAX_RELEASE_WHEN_WAITING_AFTER_MS } from "./stage-wait.js";

/** How long a run's stages only wait on detached tool calls before the run is evicted, unless configured otherwise. */
export const DEFAULT_EVICT_WHEN_WAITING_AFTER_MS = 60_000;

/** A resolved eviction policy: evict once the run has only waited for `afterMs`. */
export interface RunEvictionPolicy {
	readonly afterMs: number;
}

function describe(value: unknown): string {
	return typeof value === "string" ? JSON.stringify(value) : String(value);
}

/**
 * Validate `evictWhenWaiting` where it enters the SDK, before anything is opened or written. Returns the policy, or
 * `undefined` when the run stays resident.
 */
export function parseEvictWhenWaiting(value: EvictWhenWaiting | undefined): RunEvictionPolicy | undefined {
	if (value === undefined || value === false) return undefined;
	if (value === true) return { afterMs: DEFAULT_EVICT_WHEN_WAITING_AFTER_MS };
	if (typeof value !== "object" || value === null)
		throw new RunEvictionConfigError({
			source: "sdk",
			field: "evictWhenWaiting",
			value: describe(value),
			reason: "value",
		});
	const afterMs = (value as { readonly afterMs?: number | string }).afterMs;
	if (typeof afterMs !== "number" || !(afterMs >= 0 && afterMs <= MAX_RELEASE_WHEN_WAITING_AFTER_MS))
		throw new RunEvictionConfigError({
			source: "sdk",
			field: "evictWhenWaiting.afterMs",
			value: describe(afterMs),
			reason: "value",
		});
	return { afterMs };
}
