// @ts-check
/**
 * The run's lifecycle guarantees, independent of Azure: steps run in order and scenarios start only after every step
 * (including the security gate) succeeded; teardown runs whenever anything was provisioned, unless the caller keeps
 * the topology, and a kept topology is still torn down when a step marked `teardownOnFailure` (the security gate)
 * failed; a teardown failure is attached to the primary failure and never replaces it; cancellation stays a
 * cancellation.
 */
import { attachCleanupFailure, isCancellation } from "./errors.mjs";

/**
 * @typedef {{ name: string, run: () => Promise<void>, teardownOnFailure?: boolean }} LifecycleStep
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
	let mustTearDown = false;
	try {
		for (const step of steps) {
			if (signal?.aborted) throw signal.reason;
			mustTearDown = step.teardownOnFailure === true;
			await step.run();
			mustTearDown = false;
			outcome.completed.push(step.name);
		}
		if (signal?.aborted) throw signal.reason;
		outcome.scenariosStarted = true;
		await scenarios();
	} catch (error) {
		outcome.error = error;
		outcome.cancelled = isCancellation(error, signal);
	}
	if (keep && !mustTearDown) {
		outcome.teardownSkipped = "kept";
		return outcome;
	}
	if (!provisioned()) {
		outcome.teardownSkipped = "nothing-provisioned";
		return outcome;
	}
	try {
		outcome.teardown = await teardown();
		if (!outcome.teardown.ok) attachCleanupFailure(outcome.error, outcome.teardown.error);
	} catch (error) {
		outcome.teardown = { ok: false, error };
		attachCleanupFailure(outcome.error, error);
	}
	return outcome;
}
