import { AsyncLocalStorage } from "node:async_hooks";
import type { SessionSnapshot, SessionStore, SessionWriteOptions } from "./types.js";

type Boundary = { length: number; firstLaterId: string };
type Position = Boundary & { backend: WeakRef<SessionStore>; next: string; revision: string };
const watched = new WeakMap<SessionStore, Map<string, Set<SessionForkCut>>>();
type ReportWrite = (backend: SessionStore, before: string, after: string, revision?: string) => void;
const writes = new WeakMap<SessionWriteOptions, ReportWrite>();
const uncertainWrites = new WeakMap<SessionWriteOptions, () => void>();
export const deferForkWrite = (options: SessionWriteOptions, publish: () => void) =>
	uncertainWrites.set(options, publish);
export const confirmRecoveredForkWrite = (options: SessionWriteOptions) => uncertainWrites.get(options)?.();
export function retireForkWrite(options: SessionWriteOptions): void {
	writes.delete(options);
	uncertainWrites.delete(options);
}
let clock = 0;
let active = 0;

/** A manager's binding and its queued mutations each belong to the cuts that existed at that time. */
export const sessionForkClock = () => clock;
export const watchedForkClock = (store: SessionStore, id: string) =>
	active && watched.get(store)?.has(id) ? clock : 0;

/** Associate a manager's append intent with the exact write, without adding fields to store options. */
export function markSessionForkAppend(
	opened: number,
	submitted: number,
	store: SessionStore,
	id: string,
	options: SessionWriteOptions,
	firstLaterId: string,
): void {
	const cuts = watched.get(store)?.get(id);
	if (cuts) {
		for (const cut of cuts) if (opened < cut.time && cut.time <= submitted) cut.started();
		writes.set(options, (backend, before, after, revision = after) => {
			for (const cut of cuts)
				if (opened < cut.time && cut.time <= submitted)
					cut.appended(backend, options.expectSeq, firstLaterId, before, after, revision);
		});
	}
}
export const sessionForkWrite = (options: SessionWriteOptions) => (active ? writes.get(options) : undefined);

interface ReadRequest {
	cut: WeakRef<SessionForkCut>;
	snapshots: WeakMap<SessionSnapshot, Boundary>;
}
const reading = new AsyncLocalStorage<ReadRequest>();
/** Take the boundary where the backend reads this revision, not later when an adapter delivers the result. */
export function sessionForkRead(id: string) {
	const request = active ? reading.getStore() : undefined;
	return request?.cut.deref()?.id === id ? request : undefined;
}
export function forkSnapshotWitness(request: ReadRequest, backend: SessionStore, revision: string) {
	const point = request.cut.deref()?.boundary(backend, revision);
	return point && ((snapshot: SessionSnapshot) => request.snapshots.set(snapshot, point));
}

/** @internal A replay barrier's view of one explicitly supplied session. */
export type SessionForkView = Pick<SessionForkCut, "load" | "close">;
export function watchSessionFork(store: SessionStore, id: string): SessionForkView {
	return new SessionForkCut(store, id);
}

/** A copy-on-write position for one explicitly supplied source. Registering it reads neither steps nor storage. */
export class SessionForkCut {
	readonly time = ++clock;
	private position?: Position;
	private pending = false;
	private changed = false;
	private source?: WeakRef<SessionStore>;
	readonly id: string;
	constructor(store: SessionStore, id: string) {
		this.id = id;
		this.source = new WeakRef(store);
		let sessions = watched.get(store);
		if (!sessions) {
			sessions = new Map();
			watched.set(store, sessions);
		}
		let cuts = sessions.get(id);
		if (!cuts) {
			cuts = new Set();
			sessions.set(id, cuts);
		}
		cuts.add(this);
		active++;
	}
	/** @internal Only a resident manager submitting an append can activate this cut. */
	started(): void {
		this.pending = true;
	}
	/** @internal The backing store knows both positions and its revision from the ordinary write. */
	appended(
		backend: SessionStore,
		length: number,
		firstLaterId: string,
		before: string,
		after: string,
		revision: string,
	): void {
		const held = this.position;
		if (!held) this.position = { length, firstLaterId, backend: new WeakRef(backend), next: after, revision };
		else if (held.backend.deref() === backend && held.next === before) {
			held.next = after;
			held.revision = revision;
		} else this.changed = true;
	}
	/** @internal */
	boundary(backend: SessionStore, revision: string): Boundary | undefined {
		const held = this.position;
		return !this.changed && held?.backend.deref() === backend && held.revision === revision
			? { length: held.length, firstLaterId: held.firstLaterId }
			: undefined;
	}
	load(store: SessionStore, id: string): Promise<SessionSnapshot> {
		if (!this.pending || this.changed || this.source?.deref() !== store || this.id !== id) return store.load(id);
		const request: ReadRequest = { cut: new WeakRef(this), snapshots: new WeakMap() };
		return reading.run(request, async () => {
			const snapshot = await store.load(id);
			const point = request.snapshots.get(snapshot);
			return point && snapshot.entries[point.length]?.id === point.firstLaterId
				? { ...snapshot, entries: snapshot.entries.slice(0, point.length), lastSeq: point.length }
				: snapshot;
		});
	}
	close(): void {
		if (!this.source) return;
		const store = this.source.deref();
		if (store) {
			const sessions = watched.get(store)!;
			const cuts = sessions.get(this.id)!;
			cuts.delete(this);
			if (cuts.size === 0) sessions.delete(this.id);
			if (sessions.size === 0) watched.delete(store);
		}
		this.source = undefined;
		this.position = undefined;
		active--;
	}
}
