// @ts-check
/**
 * The run's lifecycle guarantees, independent of Azure: steps run in order and scenarios start only after every step
 * (including the security gate) succeeded; teardown runs whenever anything was provisioned, unless the caller keeps
 * the topology; a teardown failure is attached to the primary failure and never replaces it; cancellation stays a
 * cancellation.
 */
import { attachCleanupFailure, isCancellation } from "./errors.mjs";

/**
 * @typedef {{ name: string, run: () => Promise<void> }} LifecycleStep
 * @typedef {{ ok: boolean, error?: unknown }} TeardownOutcome
 * @typedef {{ completed: string[], scenariosStarted: boolean, error: unknown, cancelled: boolean,
 *   teardown: TeardownOutcome | undefined, teardownSkipped: "kept" | "nothing-provisioned" | undefined }} LifecycleOutcome
 */

/**
 * @param {{ steps: readonly LifecycleStep[], scenarios: () => Promise<void>, teardown: () => Promise<TeardownOutcome>,
 *   provisioned: () => boolean, keep: boolean, signal?: AbortSignal }} input
 * @returns {Promise<LifecycleOutcome>}
 */
export async function runLifecycle({ steps, scenarios, teardown, provisioned, keep, signal }) {
	/** @type {LifecycleOutcome} */
	const outcome = {
		completed: [],
		scenariosStarted: false,
		error: undefined,
		cancelled: false,
		teardown: undefined,
		teardownSkipped: undefined,
	};
	try {
		for (const step of steps) {
			if (signal?.aborted) throw signal.reason;
			await step.run();
			outcome.completed.push(step.name);
		}
		if (signal?.aborted) throw signal.reason;
		outcome.scenariosStarted = true;
		await scenarios();
	} catch (error) {
		outcome.error = error;
		outcome.cancelled = isCancellation(error, signal);
	}
	if (keep) {
		outcome.teardownSkipped = "kept";
		return outcome;
	}
	if (!provisioned()) {
		outcome.teardownSkipped = "nothing-provisioned";
		return outcome;
	}
	try {
		outcome.teardown = await teardown();
		if (!outcome.teardown.ok && outcome.error !== undefined)
			attachCleanupFailure(outcome.error, outcome.teardown.error);
	} catch (error) {
		outcome.teardown = { ok: false, error };
		if (outcome.error !== undefined) attachCleanupFailure(outcome.error, error);
	}
	return outcome;
}
