import { isProxy } from "node:util/types";
import { asyncScope } from "../../async-scope.ts";
import type { SessionSnapshot, SessionStore } from "./types.js";

type Load = SessionStore["load"];
interface Capture {
	store: SessionStore;
	load: Load;
	snapshot?: SessionSnapshot;
	version?: string;
}
const nativeLoads = new WeakSet<Load>();
const archiveRead = asyncScope<{ capture?: Capture }>();

export function registerArchiveLoad(load: Load): Load {
	nativeLoads.add(load);
	return load;
}

/** Only this invocation's native load can certify the exact snapshot it returns. */
export function noteSnapshotGeneration(
	store: SessionStore,
	snapshot: SessionSnapshot,
	load: Load,
	row: object,
	key: "epoch" | "revision",
): SessionSnapshot {
	const capture = archiveRead.getStore()?.capture;
	if (capture?.store === store && capture.load === load && !isProxy(row)) {
		const version: unknown = Object.getOwnPropertyDescriptor(row, key)?.value;
		if (typeof version === "string" && version) {
			capture.snapshot = snapshot;
			capture.version = version;
		}
	}
	return snapshot;
}

/** Public snapshots keep their exact shape. Unknown loaders, including another SDK copy, provide no witness. */
export async function loadArchiveSnapshot(
	store: SessionStore,
	sessionId: string,
): Promise<{ snapshot: SessionSnapshot; generation?: string }> {
	const load = store.load;
	const read = () => Reflect.apply(load, store, [sessionId]);
	if (isProxy(store) || !nativeLoads.has(load)) return { snapshot: await read() };
	const capture: Capture = { store, load };
	const scope: { capture?: Capture } = { capture };
	try {
		const snapshot = await archiveRead.run(scope, read);
		return { snapshot, generation: capture.snapshot === snapshot ? capture.version : undefined };
	} finally {
		// A driver's asynchronous work can outlive the read. It must not pin the returned session or the store.
		delete scope.capture;
	}
}
