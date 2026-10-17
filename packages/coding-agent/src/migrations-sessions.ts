import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "./config.js";
import {
	isDefaultSessionStorage,
	resolveSessionStore,
	type SessionStorageOptions,
	selectSessionStorage,
} from "./core/session-storage.js";
import {
	StorageUnavailableError as SharedStorageUnavailableError,
	StoreClosedError as SharedStoreClosedError,
	StorageError,
	StorageInvalidTextError,
	StoragePayloadTooLargeError,
} from "./core/storage/errors.js";
import { StorageUnavailableError, StoreClosedError } from "./core/storage/session/errors.js";
import { JsonlSessionStore } from "./core/storage/session/jsonl-session-store.js";
import type { SessionStore } from "./core/storage/session/types.js";

const MARKER_VERSION = 1;
const MARKER_SUFFIX = ".legacy-session-import.json";
const IMPORT_LOCK_OPTIONS = {
	realpath: false,
	retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10000, randomize: true },
	stale: 30000,
} as const;

interface ImportMarker {
	readonly version: number;
	readonly completedAt: string;
}

/**
 * A failure of the target store itself, which stops the import so the next startup retries.
 * Anything else rejects only the session being copied, so one damaged transcript cannot
 * block every later one.
 */
function isStoreFailure(error: unknown): boolean {
	return (
		error instanceof StorageUnavailableError ||
		error instanceof StoreClosedError ||
		error instanceof SharedStorageUnavailableError ||
		error instanceof SharedStoreClosedError ||
		(error instanceof StorageError &&
			!(error instanceof StorageInvalidTextError) &&
			!(error instanceof StoragePayloadTooLargeError))
	);
}

function hasCompletionMarker(markerPath: string): boolean {
	try {
		const marker: Partial<ImportMarker> = JSON.parse(readFileSync(markerPath, "utf8"));
		return marker.version === MARKER_VERSION;
	} catch {
		return false;
	}
}

function writeCompletionMarker(markerPath: string): void {
	const temporaryPath = `${markerPath}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(markerPath), { recursive: true });
		const marker: ImportMarker = { version: MARKER_VERSION, completedAt: new Date().toISOString() };
		writeFileSync(temporaryPath, `${JSON.stringify(marker)}\n`);
		renameSync(temporaryPath, markerPath);
	} catch {
		rmSync(temporaryPath, { force: true });
	}
}

export async function migrateLegacySessionsToDefaultStore(
	cwd: string,
	options: SessionStorageOptions = {},
): Promise<void> {
	const agentDir = options.agentDir ?? getAgentDir();
	const legacyDirectory = join(agentDir, "sessions");
	const storage = { ...options, agentDir };
	let source: JsonlSessionStore | undefined;
	let target: SessionStore | undefined;
	let release: (() => Promise<void>) | undefined;
	try {
		if (!existsSync(legacyDirectory)) return;
		const selection = selectSessionStorage(cwd, storage);
		if (!isDefaultSessionStorage(selection) || !("kind" in selection) || selection.kind !== "sqlite") return;
		const markerPath = `${selection.path}${MARKER_SUFFIX}`;
		if (hasCompletionMarker(markerPath)) return;
		mkdirSync(dirname(markerPath), { recursive: true });
		release = await lockfile.lock(markerPath, IMPORT_LOCK_OPTIONS);
		if (hasCompletionMarker(markerPath)) return;
		source = await JsonlSessionStore.open(legacyDirectory, { scanExisting: false });
		for await (const file of source.scanFiles()) {
			target ??= await resolveSessionStore(cwd, storage);
			if (await target.readHeader(file.header.id)) continue;
			const snapshot = await file.read().catch(() => undefined);
			if (snapshot === undefined) continue;
			try {
				await target.create(snapshot.header, snapshot.entries);
			} catch (error) {
				if (isStoreFailure(error)) throw error;
			}
		}
		writeCompletionMarker(markerPath);
	} catch {
	} finally {
		await source?.close().catch(() => {});
		await target?.close().catch(() => {});
		await release?.().catch(() => {});
	}
}
