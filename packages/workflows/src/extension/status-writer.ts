import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { prepareInspectionStoreSnapshot, readInspectionStoreSnapshot } from "../shared/inspection-store-snapshot.js";
import type { Store } from "../shared/store.js";
import type { WorkflowRuntimeConfig } from "../shared/types.js";
import { StatusSnapshotSerializer } from "./status-snapshot-serializer.js";

const DEFAULT_STATUS_SUBPATH = join(CONFIG_DIR_NAME, "workflows", "status.json");
const STATUS_WRITE_INTERVAL_MS = 250;
const STATUS_WRITE_RETRY_DELAYS_MS = [STATUS_WRITE_INTERVAL_MS, 1_000, 4_000, 16_000];
const PERSISTENT_HOLD_MS = STATUS_WRITE_RETRY_DELAYS_MS.reduce((sum, delayMs) => sum + delayMs, 0);
const STATUS_FLUSH_HOLD_BUDGET_MS = 1_000;
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

const retryableRenameFailures = new WeakSet<object>();

function isRetryableRenameError(err: unknown): boolean {
	if (err === null || typeof err !== "object" || !("code" in err)) return false;
	return typeof err.code === "string" && RETRYABLE_RENAME_CODES.has(err.code);
}

function isTransientRenameHold(err: unknown): boolean {
	return err !== null && typeof err === "object" && retryableRenameFailures.has(err);
}

async function isExistingDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

function markRetryableRenameFailure(err: unknown): void {
	if (err !== null && typeof err === "object") {
		retryableRenameFailures.add(err);
	}
}

async function renameStatusFile(tmpPath: string, targetPath: string): Promise<void> {
	let targetIsDirectory: boolean | undefined;
	for (let attempt = 0; ; attempt++) {
		try {
			await rename(tmpPath, targetPath);
			return;
		} catch (err: unknown) {
			if (!isRetryableRenameError(err)) {
				throw err;
			}
			targetIsDirectory ??= await isExistingDirectory(targetPath);
			if (targetIsDirectory) {
				throw err;
			}
			const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
			if (delayMs === undefined) {
				markRetryableRenameFailure(err);
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
	let lastHoldError: unknown = null;
	let holdStartedAt: number | null = null;
	let active = true;
	let writing = false;
	let initialWrite = true;
	let pending = initialWrite;
	let changeSeq = 0;
	let unchangedFailures = 0;
	let activeFlushCount = 0;
	let recordingOwnNotice = false;
	let cancelDrainSleep: (() => void) | null = null;
	let cancelFlushSleep: (() => void) | null = null;
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

	function sleepFlush(delayMs: number): Promise<void> {
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				cancelFlushSleep = null;
				resolve();
			}, delayMs);
			cancelFlushSleep = () => {
				clearTimeout(timer);
				cancelFlushSleep = null;
				resolve();
			};
		});
	}

	function recordPersistentHoldError(err: unknown): void {
		holdStartedAt = null;
		lastHoldError = null;
		recordingOwnNotice = true;
		try {
			recordWriteError(err);
		} finally {
			recordingOwnNotice = false;
		}
	}

	function handleWriteFailure(err: unknown, seqBefore: number): void {
		pending = true;
		if (!isTransientRenameHold(err)) {
			holdStartedAt = null;
			lastHoldError = null;
			recordWriteError(err);
			unchangedFailures = changeSeq === seqBefore ? unchangedFailures + 1 : 0;
			return;
		}
		lastHoldError = err;
		holdStartedAt ??= Date.now();
		if (activeFlushCount > 0) {
			unchangedFailures =
				changeSeq === seqBefore ? Math.min(unchangedFailures + 1, STATUS_WRITE_RETRY_DELAYS_MS.length) : 0;
			return;
		}
		unchangedFailures = changeSeq === seqBefore ? unchangedFailures + 1 : 0;
		if (unchangedFailures > STATUS_WRITE_RETRY_DELAYS_MS.length || Date.now() - holdStartedAt >= PERSISTENT_HOLD_MS) {
			recordPersistentHoldError(err);
		}
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
			lastHoldError = null;
			holdStartedAt = null;
			unchangedFailures = 0;
			return true;
		} catch (err: unknown) {
			if (active) {
				handleWriteFailure(err, seqBefore);
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
				if (inFlightWrite !== null) {
					await inFlightWrite;
				} else {
					await runWriteOnce();
				}
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
		if (recordingOwnNotice) return;
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
			activeFlushCount++;
			const deadline = Date.now() + STATUS_FLUSH_HOLD_BUDGET_MS;
			let failedAttempts = 0;
			try {
				while (active && (pending || inFlightWrite !== null)) {
					const seqBefore = changeSeq;
					let ok: boolean;
					if (inFlightWrite !== null) {
						ok = await inFlightWrite;
					} else {
						cancelDrainSleep?.();
						initialWrite = false;
						ok = await runWriteOnce();
					}
					if (ok) {
						failedAttempts = 0;
						continue;
					}
					failedAttempts++;
					if (lastHoldError !== null) {
						const remainingMs = deadline - Date.now();
						if (remainingMs <= 0) {
							recordPersistentHoldError(lastHoldError);
							break;
						}
						await sleepFlush(Math.min(STATUS_WRITE_INTERVAL_MS, remainingMs));
						continue;
					}
					if (failedAttempts >= 2 || changeSeq === seqBefore) {
						break;
					}
				}
			} finally {
				activeFlushCount--;
				if (canScheduleDrain()) {
					void ensureDrain();
				}
			}
		},
		unsubscribe() {
			active = false;
			pending = false;
			holdStartedAt = null;
			lastHoldError = null;
			cancelDrainSleep?.();
			cancelFlushSleep?.();
			unsubscribeStore();
			serializer.close();
		},
	};
}
