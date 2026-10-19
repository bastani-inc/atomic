import type { Store } from "../shared/store.js";

/**
 * Orders resume admission against the journal writes that queue messages for an
 * interrupted (dormant) run before it resumes (#3760).
 *
 * A dormant write must neither land after a resumed run seeded its pending
 * messages (the run would overwrite it) nor change the journal between resume's
 * catalog read and its claim (the claim would fail as stale). So admission waits
 * out in-flight writes and holds new ones until it settles, and reports which runs
 * a dormant write changed since the previous admission so it can refresh them.
 */
interface DormantRunGate {
	admissions: number;
	readonly writes: Set<Promise<unknown>>;
	readonly waiters: Set<() => void>;
	readonly written: Set<string>;
}

const gates = new WeakMap<Store, DormantRunGate>();

function gateFor(store: Store): DormantRunGate {
	let gate = gates.get(store);
	if (gate === undefined) {
		gate = { admissions: 0, writes: new Set(), waiters: new Set(), written: new Set() };
		gates.set(store, gate);
	}
	return gate;
}

/** Run one resume admission; `dormantWrites` names runs a dormant write changed since the last admission. */
export async function withWorkflowResumeAdmission<T>(
	store: Store,
	admit: (dormantWrites: ReadonlySet<string>) => Promise<T>,
): Promise<T> {
	const gate = gateFor(store);
	gate.admissions += 1;
	try {
		while (gate.writes.size > 0) await Promise.allSettled([...gate.writes]);
		const written = new Set(gate.written);
		gate.written.clear();
		return await admit(written);
	} finally {
		gate.admissions -= 1;
		if (gate.admissions === 0) for (const wake of [...gate.waiters]) wake();
	}
}

/** Run one dormant journal write for `runId` once no resume admission is in progress. */
export async function withDormantRunWrite<T>(store: Store, runId: string, write: () => Promise<T>): Promise<T> {
	const gate = gateFor(store);
	while (gate.admissions > 0) {
		await new Promise<void>((resolve) => {
			const wake = (): void => {
				gate.waiters.delete(wake);
				resolve();
			};
			gate.waiters.add(wake);
		});
	}
	gate.written.add(runId);
	const pending = write();
	gate.writes.add(pending);
	try {
		return await pending;
	} finally {
		gate.writes.delete(pending);
	}
}
