import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { prepareInspectionStoreSnapshot, readInspectionStoreSnapshot } from "../shared/inspection-store-snapshot.js";
import type { Store } from "../shared/store.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";
import { StatusSnapshotSerializer } from "./status-snapshot-serializer.js";

const DEFAULT_STATUS_SUBPATH = join(CONFIG_DIR_NAME, "workflows", "status.json");
const STATUS_WRITE_INTERVAL_MS = 250;
const STATUS_WRITE_RETRY_DELAYS_MS = [STATUS_WRITE_INTERVAL_MS, 1_000, 4_000, 16_000];
const RENAME_RETRY_DELAYS_MS = [5, 10, 20, 40, 80];
const RETRYABLE_RENAME_CODES: ReadonlySet<string> = new Set(["EPERM", "EACCES", "EBUSY"]);
const STATUS_WRITE_QUEUE_KEY = Symbol.for("atomic-workflows/status-write-queue@1");

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

const processState = globalThis as typeof globalThis & {
	[STATUS_WRITE_QUEUE_KEY]?: Map<string, Promise<void>>;
};
processState[STATUS_WRITE_QUEUE_KEY] ??= new Map<string, Promise<void>>();
const pathWrites = processState[STATUS_WRITE_QUEUE_KEY];

function isRetryableRenameError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	return typeof err.code === "string" && RETRYABLE_RENAME_CODES.has(err.code);
}

async function renameStatusFile(tmpPath: string, targetPath: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmpPath, targetPath);
			return;
		} catch (err: unknown) {
			const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
			if (delayMs === undefined || !isRetryableRenameError(err)) {
				throw err;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
		}
	}
}

export function atomicWriteJson(path: string, content: string | Iterable<string>): Promise<void> {
	const targetPath = resolve(path);
	const previous = pathWrites.get(targetPath) ?? Promise.resolve();
	const current = previous.then(async () => {
		await mkdir(dirname(targetPath), { recursive: true });
		const tmpPath = `${targetPath}.tmp`;
		try {
			await writeFile(tmpPath, content, "utf8");
			await renameStatusFile(tmpPath, targetPath);
		} catch (err) {
			await unlink(tmpPath).catch(() => {});
			throw err;
		}
	});
	const settled = current.then(
		() => {},
		() => {},
	);
	pathWrites.set(targetPath, settled);
	void settled.then(() => {
		if (pathWrites.get(targetPath) === settled) {
			pathWrites.delete(targetPath);
		}
	});
	return current;
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
	let initialWrite = true;
	let pending = initialWrite;
	let changeSeq = 0;
	let unchangedFailures = 0;
	let cancelDrainSleep: (() => void) | null = null;
	let drainPromise: Promise<void> | null = null;
	let inFlightWrite: Promise<boolean> | null = null;
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

	function sleepDrain(delayMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				cancelDrainSleep = null;
				resolve();
			}, delayMs);
			cancelDrainSleep = () => {
				clearTimeout(timer);
				cancelDrainSleep = null;
				resolve();
			};
		});
	}

	async function writeOnce(): Promise<boolean> {
		const seqBefore = changeSeq;
		pending = false;
		try {
			await mkdir(dirname(filePath), { recursive: true });
			if (!active) return false;
			await prepareInspectionStoreSnapshot(store);
			if (!active) return false;
			pending = false;
			const content = await serializer.serialize(readInspectionStoreSnapshot(store));
			if (!active) return false;
			await atomicWriteJson(filePath, content);
			lastErrorMessage = null;
			unchangedFailures = 0;
			return true;
		} catch (err: unknown) {
			if (active) {
				pending = true;
				recordWriteError(err);
				unchangedFailures = changeSeq === seqBefore ? unchangedFailures + 1 : 0;
			}
			return false;
		}
	}

	function runWriteOnce(): Promise<boolean> {
		inFlightWrite ??= writeOnce().finally(() => {
			inFlightWrite = null;
		});
		return inFlightWrite;
	}

	function canScheduleDrain(): boolean {
		return active && pending && unchangedFailures <= STATUS_WRITE_RETRY_DELAYS_MS.length;
	}

	async function drainWrites(): Promise<void> {
		if (writing) return;
		writing = true;
		try {
			while (active && pending) {
				if (!initialWrite) {
					const delayMs =
						unchangedFailures === 0
							? STATUS_WRITE_INTERVAL_MS
							: STATUS_WRITE_RETRY_DELAYS_MS[unchangedFailures - 1];
					if (delayMs === undefined) break;
					const failuresBeforeSleep = unchangedFailures;
					await sleepDrain(delayMs);
					if (!active || !pending) break;
					if (failuresBeforeSleep > 0 && unchangedFailures === 0) {
						continue;
					}
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
		if (!canScheduleDrain()) return Promise.resolve();
		drainPromise ??= drainWrites().finally(() => {
			drainPromise = null;
			if (canScheduleDrain()) void ensureDrain();
		});
		return drainPromise;
	}

	const unsubscribeStore = store.subscribeInvalidation(() => {
		changeSeq++;
		const hadBackoff = unchangedFailures > 0;
		unchangedFailures = 0;
		pending = true;
		if (hadBackoff) {
			cancelDrainSleep?.();
		}
		void ensureDrain();
	});

	if (pending) {
		void ensureDrain();
	}

	return {
		async flush() {
			let failedAttempts = 0;
			while (active && (pending || inFlightWrite !== null)) {
				const seqBefore = changeSeq;
				let ok: boolean;
				if (inFlightWrite !== null) {
					ok = await inFlightWrite;
				} else {
					initialWrite = false;
					ok = await runWriteOnce();
				}
				failedAttempts = ok ? 0 : failedAttempts + 1;
				if (!ok && (failedAttempts >= 2 || changeSeq === seqBefore)) {
					break;
				}
			}
			if (canScheduleDrain()) {
				void ensureDrain();
			}
		},
		unsubscribe() {
			active = false;
			pending = false;
			cancelDrainSleep?.();
			unsubscribeStore();
			serializer.close();
		},
	};
}
