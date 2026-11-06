import assert from "node:assert/strict";
import { test } from "vitest";
import type { StaleWorkLeaseReason } from "../../packages/workflows/src/shared/worker-pool-errors.js";
import {
	type AttemptView,
	assertAttemptCurrent,
	assertRouteOwned,
	type RouteAttempt,
} from "../../packages/workflows/src/workers/attempt-view.js";
import { publicationRejected, staleWorkLease } from "../helpers/pool-errors.js";

const work = { id: "work", generation: 3, worker: "worker-a", epoch: 2 };
const current: AttemptView = { generation: 3, worker: "worker-a", epoch: 2, fenced: false };

test("the root holds an attempt current only while its view matches it exactly (#4327)", () => {
	assertAttemptCurrent("root", current, work);
	const refused = (reason: StaleWorkLeaseReason) =>
		staleWorkLease({ root: "root", workId: "work", generation: 3, reason });
	const cases: readonly (readonly [AttemptView | undefined, StaleWorkLeaseReason])[] = [
		[undefined, "missing"],
		[{ ...current, fenced: true }, "fenced"],
		[{ ...current, fenced: true, generation: 4 }, "fenced"],
		[{ ...current, generation: 4 }, "generation-mismatch"],
		[{ ...current, generation: 4, worker: "worker-b" }, "generation-mismatch"],
		[{ ...current, worker: "worker-b" }, "worker-mismatch"],
		[{ ...current, worker: "worker-b", epoch: 3 }, "worker-mismatch"],
		[{ ...current, epoch: 3 }, "epoch-mismatch"],
	];
	for (const [view, reason] of cases)
		assert.throws(() => assertAttemptCurrent("root", view, work), refused(reason), `${JSON.stringify(view)}`);
});

test("the coordinator routes a run only for the current, unfenced attempt that published it (#4327)", () => {
	const owner: RouteAttempt = { generation: 3, runs: new Set(["run"]), fenced: false };
	assertRouteOwned("root", owner, work, "run");
	const stale = (reason: StaleWorkLeaseReason) =>
		staleWorkLease({ root: "root", workId: "work", generation: 3, reason });
	assert.throws(() => assertRouteOwned("root", undefined, work, "run"), stale("missing"));
	assert.throws(
		() => assertRouteOwned("root", { ...owner, generation: 2, fenced: true }, work, "run"),
		stale("generation-mismatch"),
	);
	assert.throws(
		() => assertRouteOwned("root", { ...owner, fenced: true, runs: new Set() }, work, "run"),
		stale("fenced"),
	);
	assert.throws(
		() => assertRouteOwned("root", owner, work, "other-run"),
		publicationRejected({
			root: "root",
			workId: "work",
			generation: 3,
			reason: "outside-subtree",
			runId: "other-run",
		}),
	);
});
