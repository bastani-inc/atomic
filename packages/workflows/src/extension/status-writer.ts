import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { prepareInspectionStoreSnapshot, readInspectionStoreSnapshot } from "../shared/inspection-store-snapshot.js";
import type { Store } from "../shared/store.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";
import { StatusSnapshotSerializer } from "./status-snapshot-serializer.js";

const DEFAULT_STATUS_SUBPATH = join(CONFIG_DIR_NAME, "workflows", "status.json");
const STATUS_WRITE_INTERVAL_MS = 250;

export interface StatusWriterOpts {
	projectRoot?: string;
}

export interface StatusWriter {
	flush(): Promise<void>;
	unsubscribe(): void;
}

export function resolveStatusFilePath(
	config: Pick<WorkflowRuntimeConfig, "statusFilePath">,
	opts: StatusWriterOpts = {},
): string {
	if (config.statusFilePath) return config.statusFilePath;
	const root = opts.projectRoot ?? process.cwd();
	return join(root, DEFAULT_STATUS_SUBPATH);
}

export async function atomicWriteJson(path: string, content: string | Iterable<string>): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true });
	const tmpPath = `${path}.tmp`;
	await writeFile(tmpPath, content, "utf8");
	await rename(tmpPath, path);
}

export function createStatusWriter(
	store: Store,
	config: WorkflowRuntimeConfig,
	opts: StatusWriterOpts = {},
): StatusWriter {
	if (!config.statusFile) {
		return { async flush() {}, unsubscribe() {} };
	}

	const filePath = resolveStatusFilePath(config, opts);
	let lastErrorMessage: string | null = null;
	let active = true;
	let writing = false;
	let initialWrite = (store.runs?.().length ?? 0) > 0 || (store.notices?.().length ?? 0) > 0;
	let pending = initialWrite;
	let drainPromise: Promise<void> | null = null;
	let inFlightWrite: Promise<void> | null = null;
	const serializer = new StatusSnapshotSerializer();

	function recordWriteError(err: unknown): void {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg === lastErrorMessage) return;
		lastErrorMessage = msg;
		store.recordNotice({
			id: `status-writer-error-${Date.now()}`,
			level: "warning",
			message: `atomic-workflows: status file write failed (${filePath}): ${msg}`,
			createdAt: Date.now(),
		});
	}

	async function writeOnce(): Promise<void> {
		pending = false;
		try {
			await mkdir(dirname(filePath), { recursive: true });
			if (!active) return;
			await prepareInspectionStoreSnapshot(store);
			if (!active) return;
			const content = await serializer.serialize(readInspectionStoreSnapshot(store));
			if (!active) return;
			await atomicWriteJson(filePath, content);
			lastErrorMessage = null;
		} catch (err: unknown) {
			if (active) recordWriteError(err);
		}
	}

	function runWriteOnce(): Promise<void> {
		inFlightWrite ??= writeOnce().finally(() => {
			inFlightWrite = null;
		});
		return inFlightWrite;
	}

	async function drainWrites(): Promise<void> {
		if (writing) return;
		writing = true;
		try {
			while (active && pending) {
				if (!initialWrite) {
					await new Promise<void>((resolve) => setTimeout(resolve, STATUS_WRITE_INTERVAL_MS));
				}
				initialWrite = false;
				if (inFlightWrite !== null) await inFlightWrite;
				if (!active || !pending) break;
				await runWriteOnce();
			}
		} finally {
			writing = false;
		}
	}

	function ensureDrain(): Promise<void> {
		drainPromise ??= drainWrites().finally(() => {
			drainPromise = null;
			if (active && pending) void ensureDrain();
		});
		return drainPromise;
	}

	const unsubscribeStore = store.subscribeInvalidation(() => {
		pending = true;
		void ensureDrain();
	});

	if (pending) {
		void ensureDrain();
	}

	return {
		async flush() {
			while (active && (pending || inFlightWrite !== null)) {
				if (inFlightWrite !== null) {
					await inFlightWrite;
				} else if (pending) {
					initialWrite = false;
					await runWriteOnce();
				}
			}
		},
		unsubscribe() {
			active = false;
			pending = false;
			unsubscribeStore();
			serializer.close();
		},
	};
}
