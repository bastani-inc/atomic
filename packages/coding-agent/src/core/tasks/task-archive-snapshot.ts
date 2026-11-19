import { isProxy } from "node:util/types";
import { asyncScope } from "../async-scope.ts";
import { observeArchiveLoad, type SnapshotObserver } from "../storage/session/snapshot-generation.ts";
import type { SessionSnapshot, SessionStore } from "../storage/session/types.js";
import { captureChatSnapshot } from "./task-chat-records.js";

interface Capture {
	store: SessionStore;
	load: SessionStore["load"];
	snapshot?: SessionSnapshot;
	version?: string;
}
const archiveRead = asyncScope<{ capture?: Capture }>();

/** Only this invocation's native load can certify the exact snapshot it returns. */
const captureGeneration: SnapshotObserver = (store, snapshot, load, row, key) => {
	const capture = archiveRead.getStore()?.capture;
	if (capture?.store === store && capture.load === load && !isProxy(row)) {
		const version: unknown = Object.getOwnPropertyDescriptor(row, key)?.value;
		if (typeof version === "string" && version) {
			capture.snapshot = snapshot;
			capture.version = version;
		}
	}
};

/** Public snapshots keep their exact shape. Unknown loaders, including another SDK copy, provide no witness. */
export async function loadArchiveSnapshot(
	store: SessionStore,
	sessionId: string,
): Promise<{ snapshot: SessionSnapshot; generation?: string }> {
	const load = store.load;
	const read = () => Reflect.apply(load, store, [sessionId]);
	if (isProxy(store)) return { snapshot: await read() };
	if (!observeArchiveLoad(load, captureGeneration)) {
		// A wrapper such as the default store's legacy adapter certifies no generation. Its chat records still
		// belong to the snapshot it actually returned, never to a live session of the task.
		const snapshot = await read();
		captureChatSnapshot(store, snapshot);
		return { snapshot };
	}
	const capture: Capture = { store, load };
	const scope: { capture?: Capture } = { capture };
	try {
		const snapshot = await archiveRead.run(scope, read);
		captureChatSnapshot(store, snapshot);
		return { snapshot, generation: capture.snapshot === snapshot ? capture.version : undefined };
	} finally {
		// A driver's asynchronous work can outlive the read. It must not pin the returned session or the store.
		delete scope.capture;
	}
}
