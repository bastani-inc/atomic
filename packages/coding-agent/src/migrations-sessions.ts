import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "./config.js";
import {
	isDefaultSessionStorage,
	resolveSessionStore,
	type SessionStorageOptions,
	selectSessionStorage,
} from "./core/session-storage.js";
import {
	SessionConflictError,
	SessionExistsError,
	SessionFormatVersionError,
	SessionIdMismatchError,
	SessionInvalidTextError,
	SessionInvalidTimestampError,
} from "./core/storage/session/errors.js";
import { JsonlSessionStore } from "./core/storage/session/jsonl-session-store.js";
import type { SessionStore } from "./core/storage/session/types.js";

const MARKER_VERSION = 1;
const MARKER_SUFFIX = ".legacy-session-import.json";

interface ImportMarker {
	readonly version: number;
	readonly completedAt: string;
}

function isRejectedSession(error: Error): boolean {
	return (
		error instanceof SessionExistsError ||
		error instanceof SessionConflictError ||
		error instanceof SessionFormatVersionError ||
		error instanceof SessionIdMismatchError ||
		error instanceof SessionInvalidTextError ||
		error instanceof SessionInvalidTimestampError
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
	try {
		if (!existsSync(legacyDirectory)) return;
		const selection = selectSessionStorage(cwd, storage);
		if (!isDefaultSessionStorage(selection) || !("kind" in selection) || selection.kind !== "sqlite") return;
		const markerPath = `${selection.path}${MARKER_SUFFIX}`;
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
				if (!(error instanceof Error) || !isRejectedSession(error)) throw error;
			}
		}
		writeCompletionMarker(markerPath);
	} catch {
	} finally {
		await source?.close().catch(() => {});
		await target?.close().catch(() => {});
	}
}
