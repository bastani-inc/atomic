import { AsyncLocalStorage } from "node:async_hooks";
import {
	type ForkBoundary,
	type ForkReadRequest,
	type ForkWriteObserver,
	type ForkWriter,
	setSessionForkObserver,
} from "./fork-observer.js";
import type { SessionSnapshot, SessionStore, SessionWriteOptions } from "./types.js";

type Position = ForkBoundary & { backend: WeakRef<SessionStore>; next: string; revision: string };
const watched = new WeakMap<SessionStore, Map<string, Set<SessionForkCut>>>();
const writes = new WeakMap<SessionWriteOptions, ForkWriteObserver>();
const uncertainWrites = new WeakMap<SessionWriteOptions, () => void>();
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
	writer: ForkWriter,
): void {
	const cuts = watched.get(store)?.get(id);
	if (cuts) {
		for (const cut of cuts) if (opened < cut.time && cut.time <= submitted) cut.started();
		const resident = new WeakRef(writer);
		writes.set(options, (backend, before, after, revision = after, verifyContents) => {
			for (const cut of cuts)
				if (opened < cut.time && cut.time <= submitted)
					cut.appended(
						backend,
						options.expectSeq,
						firstLaterId,
						before,
						after,
						revision,
						verifyContents ? resident : undefined,
					);
		});
	}
}
const reading = new AsyncLocalStorage<ForkReadRequest>();
const observer = {
	write: (options: SessionWriteOptions) => writes.get(options),
	defer: (options: SessionWriteOptions, publish: () => void) => uncertainWrites.set(options, publish),
	read(id: string) {
		const request = reading.getStore();
		return request?.cut.deref()?.id === id ? request : undefined;
	},
};

/** @internal A replay barrier's view of one explicitly supplied session. */
export type SessionForkView = Pick<SessionForkCut, "admit" | "load" | "close">;
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
		if (active++ === 0) setSessionForkObserver(observer);
	}
	/** No append raced the replay barrier: leave the whole live group on its ordinary path. */
	admit(): SessionForkView | undefined {
		if (this.pending) return this;
		this.close();
		return undefined;
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
		writer?: WeakRef<ForkWriter>,
	): void {
		const held = this.position;
		if (!held) this.position = { length, firstLaterId, backend: new WeakRef(backend), next: after, revision, writer };
		else if (held.backend.deref() === backend && held.next === before) {
			held.next = after;
			held.revision = revision;
		} else this.changed = true;
	}
	/** @internal */
	boundary(backend: SessionStore, revision: string): ForkBoundary | undefined {
		const held = this.position;
		return !this.changed && held?.backend.deref() === backend && held.revision === revision
			? { length: held.length, firstLaterId: held.firstLaterId, writer: held.writer }
			: undefined;
	}
	load(store: SessionStore, id: string): Promise<SessionSnapshot> {
		if (!this.pending || this.changed || this.source?.deref() !== store || this.id !== id) return store.load(id);
		const request: ForkReadRequest = { cut: new WeakRef(this), snapshots: new WeakMap() };
		return reading.run(request, async () => {
			const snapshot = await store.load(id);
			const point = request.snapshots.get(snapshot);
			return point &&
				(point.writer === undefined ||
					point.writer.deref()?.matchesForkSnapshot(store, snapshot, this.time) === true) &&
				snapshot.entries[point.length]?.id === point.firstLaterId
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
		if (--active === 0) setSessionForkObserver(undefined);
	}
}
