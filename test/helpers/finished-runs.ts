import type { Store } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

const COUNTED_FIELDS = [
	"id",
	"endedAt",
	"stages",
	"parentRunId",
	"rootRunId",
	"status",
	"pendingStageMessages",
] as const;

/**
 * Fills the store with finished runs that count every read of their fields, as a long-lived host holds them.
 * Record the run under test after these, as a real host does: a root recorded first hides an unconverted scan.
 */
export function holdFinishedRuns(store: Store, count: number): { reads: number } {
	const counter = { reads: 0 };
	for (let index = 0; index < count; index++) {
		const finished: RunSnapshot = {
			id: `finished-${index}`,
			name: `finished-${index}`,
			inputs: {},
			status: "completed",
			stages: [],
			toolNodes: [],
			startedAt: 0,
			endedAt: 1,
		};
		for (const field of COUNTED_FIELDS) {
			const value = finished[field];
			Object.defineProperty(finished, field, {
				enumerable: true,
				get: () => {
					counter.reads++;
					return value;
				},
			});
		}
		store.recordRunStart(finished);
	}
	counter.reads = 0;
	return counter;
}

/**
 * A store whose `runs()` list counts every access other than `length`, which catches identity scans that never
 * read a run's fields. Every other store method answers from the real store.
 */
export function countRunListScans(store: Store): { store: Store; scans: { reads: number } } {
	const scans = { reads: 0 };
	const counted = new Proxy(store.runs(), {
		get(target, key, receiver) {
			if (key !== "length") scans.reads++;
			return Reflect.get(target, key, receiver);
		},
	});
	return { store: Object.assign(Object.create(store) as Store, { runs: () => counted }), scans };
}
