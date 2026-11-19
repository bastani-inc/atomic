import { isProxy } from "node:util/types";
import type { SessionStore } from "@bastani/atomic";
import type { StageOptions, WorkflowParallelOptions, WorkflowTaskStep } from "../../shared/types.js";

/** A call-local prefix per source. Reopened file stores share a key; unrelated in-memory stores never do. */
export class ParallelForks {
	private readonly sources = new Map<SessionStore | string, Map<string, number | Promise<number | undefined>>>();

	private source(store: SessionStore) {
		const key = store.forkSourceKey ?? store;
		let sessions = this.sources.get(key);
		if (sessions === undefined) {
			sessions = new Map();
			this.sources.set(key, sessions);
		}
		return sessions;
	}

	capture(store: SessionStore, id: string): void {
		if (!store.readForkLength) return;
		const sessions = this.source(store);
		if (!sessions.has(id))
			sessions.set(
				id,
				store.readForkLength(id).catch(() => undefined),
			);
	}

	/** If the store wasn't known until live admission, use the snapshot the first child actually copies. */
	readonly length = async (store: SessionStore, id: string, copied: number): Promise<number> => {
		const sessions = this.source(store);
		const held = sessions.get(id);
		if (typeof held === "number") return held;
		if (held !== undefined) {
			const length = await held;
			if (length !== undefined) return length;
			const settled = sessions.get(id);
			if (typeof settled === "number") return settled;
		}
		sessions.set(id, copied);
		return copied;
	};
}

type SourceField =
	| "context"
	| "forkFromSessionId"
	| "forkFromEntryId"
	| "sessionStore"
	| "sessionManager"
	| "sessionDir";
const computed = Symbol("computed");
function plain<T extends object, K extends keyof T>(
	object: T | undefined,
	field: K,
): T[K] | typeof computed | undefined {
	const property = object && Object.getOwnPropertyDescriptor(object, field);
	return !property?.enumerable ? undefined : "value" in property ? property.value : computed;
}

/** Start reads only for already supplied, unambiguous sources. Never run author getters or resolve a store here. */
export function suppliedForkCapture(
	points: ParallelForks,
	defaults: WorkflowParallelOptions | undefined,
	input: Partial<StageOptions>,
	runStore: SessionStore | undefined,
	mayReplay: ReadonlySet<string>,
): (step: WorkflowTaskStep) => void {
	let sharedVisited = false;
	return (step) => {
		if (!step || typeof step !== "object" || isProxy(step)) return;
		const shared =
			!Object.hasOwn(step, "context") &&
			!Object.hasOwn(step, "forkFromSessionId") &&
			!Object.hasOwn(step, "forkFromEntryId") &&
			!Object.hasOwn(step, "sessionStore") &&
			!Object.hasOwn(step, "sessionManager") &&
			!Object.hasOwn(step, "sessionDir");
		if (shared && sharedVisited) return;
		if (mayReplay.size > 0) {
			const name = plain(step, "name");
			if (typeof name !== "string" || mayReplay.has(name)) return;
		}
		if (shared) sharedVisited = true;
		const get = <K extends SourceField>(k: K) =>
			plain<StageOptions, K>(step, k) ?? plain<StageOptions, K>(defaults, k) ?? input[k];
		if (get("context") !== "fork" || get("forkFromEntryId") !== undefined) return;
		const id = get("forkFromSessionId");
		if (typeof id !== "string") return;
		const supplied = get("sessionStore");
		const manager = get("sessionManager");
		if (supplied === computed || manager === computed) return;
		try {
			const store =
				supplied ?? manager?.getSessionStore() ?? (get("sessionDir") === undefined ? runStore : undefined);
			if (store) points.capture(store, id);
		} catch {
			// An unavailable caller-supplied handle must fail at the ordinary live open, not ahead of admission.
		}
	};
}

/** A blocked parallel cannot run the ordinary step scan yet. Do not evaluate array accessors before admission. */
export function captureBeforeReplay(steps: readonly WorkflowTaskStep[], visit: (step: WorkflowTaskStep) => void): void {
	for (let slot = 0; slot < steps.length; ++slot) {
		const property = Object.getOwnPropertyDescriptor(steps, slot);
		if (property && "value" in property) visit(property.value);
	}
}
