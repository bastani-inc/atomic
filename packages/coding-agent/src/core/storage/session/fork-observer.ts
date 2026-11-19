import type { SessionSnapshot, SessionStore, SessionWriteOptions } from "./types.js";

export interface ForkWriter {
	matchesForkSnapshot(store: SessionStore, snapshot: SessionSnapshot, launch: number): boolean;
}
export type ForkBoundary = { length: number; firstLaterId: string; writer?: WeakRef<ForkWriter> };
export type ForkWriteObserver = (
	backend: SessionStore,
	before: string,
	after: string,
	revision?: string,
	verifyContents?: true,
) => void;
export interface ForkReadRequest {
	cut: WeakRef<{ id: string; boundary(backend: SessionStore, revision: string): ForkBoundary | undefined }>;
	snapshots: WeakMap<SessionSnapshot, ForkBoundary>;
}
interface ForkObserver {
	write(options: SessionWriteOptions): ForkWriteObserver | undefined;
	defer(options: SessionWriteOptions, publish: () => void): void;
	read(id: string): ForkReadRequest | undefined;
}
let observer: ForkObserver | undefined;
/** A workflow host can observe an existing write or read. The storage adapters themselves need no host runtime. */
export function setSessionForkObserver(next: ForkObserver | undefined): void {
	observer = next;
}
export const sessionForkWrite = (options: SessionWriteOptions) => observer?.write(options);
export const deferForkWrite = (options: SessionWriteOptions, publish: () => void) => observer?.defer(options, publish);
export const sessionForkRead = (id: string) => observer?.read(id);
/** Match at the point where the store observes the revision, not at delivery of an asynchronous result. */
export function forkSnapshotWitness(request: ForkReadRequest, backend: SessionStore, revision: string) {
	const point = request.cut.deref()?.boundary(backend, revision);
	return point && ((snapshot: SessionSnapshot) => request.snapshots.set(snapshot, point));
}
