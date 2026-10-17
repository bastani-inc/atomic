import type { CompactionEntry, SessionEntry, SessionHeader, SessionMessageEntry } from "../../session-manager-types.ts";
import { generateId } from "../../session-manager-validation.ts";
import { SessionFormatVersionError, type SessionJsonValue } from "./errors.js";
import { SESSION_FORMAT_VERSION } from "./types.js";

export interface StoredSessionHeader {
	readonly type?: SessionJsonValue;
	readonly version?: SessionJsonValue;
	readonly id?: SessionJsonValue;
	readonly timestamp?: SessionJsonValue;
	readonly cwd?: SessionJsonValue;
	readonly parentSession?: SessionJsonValue;
	readonly internal?: SessionJsonValue;
	readonly workflow?: SessionHeader["workflow"] | SessionJsonValue;
}

type LegacyCompactionEntry = CompactionEntry & { firstKeptEntryIndex?: number };

export function upgradeLegacySessionHeader(stored: StoredSessionHeader, path: string): SessionHeader {
	const version = stored.version === undefined ? 1 : stored.version;
	if (
		stored.type !== "session" ||
		(version !== 1 && version !== 2 && version !== 3) ||
		typeof stored.id !== "string" ||
		typeof stored.cwd !== "string" ||
		typeof stored.timestamp !== "string" ||
		(stored.parentSession !== undefined && typeof stored.parentSession !== "string")
	)
		throw new SessionFormatVersionError(path, stored.version);
	return {
		type: "session",
		version: SESSION_FORMAT_VERSION,
		id: stored.id,
		createdAt: stored.timestamp,
		cwd: stored.cwd,
		...(stored.parentSession === undefined ? {} : { parentSessionId: legacyParentSessionId(stored.parentSession) }),
		...(stored.internal === undefined ? {} : { internal: stored.internal as true }),
		...(stored.workflow === undefined ? {} : { workflow: stored.workflow as SessionHeader["workflow"] }),
	};
}

export function upgradeLegacySessionEntries(
	stored: StoredSessionHeader,
	entries: readonly SessionEntry[],
	path: string,
): { header: SessionHeader; entries: SessionEntry[] } {
	const header = upgradeLegacySessionHeader(stored, path);
	const treeEntries =
		stored.version === undefined || stored.version === 1 ? addTreeIds(entries, stored, path) : entries;
	return { header, entries: stored.version === 3 ? [...treeEntries] : treeEntries.map(renameHookMessage) };
}

const LEGACY_SESSION_FILE_NAME =
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\.jsonl$/;

function legacyParentSessionId(parentSession: string): string {
	const name = parentSession.split(/[\\/]/).at(-1) ?? parentSession;
	if (name === parentSession) return parentSession;
	return LEGACY_SESSION_FILE_NAME.exec(name)?.[1] ?? parentSession;
}

function addTreeIds(entries: readonly SessionEntry[], stored: StoredSessionHeader, path: string): SessionEntry[] {
	const ids = new Set<string>();
	let parentId: string | null = null;
	const upgraded = entries.map((entry) => {
		const id = generateId(ids);
		ids.add(id);
		const next: SessionEntry = { ...entry, id, parentId };
		parentId = id;
		return next;
	});
	return upgraded.map((entry, position) => {
		if (entry.type !== "compaction") return entry;
		const { firstKeptEntryIndex, ...compaction } = entry as LegacyCompactionEntry;
		if (typeof firstKeptEntryIndex !== "number") return entry;
		if (!Number.isInteger(firstKeptEntryIndex) || firstKeptEntryIndex < 0 || firstKeptEntryIndex > position + 1)
			throw new SessionFormatVersionError(path, stored.version);
		const kept =
			firstKeptEntryIndex >= 1 && firstKeptEntryIndex <= position ? upgraded[firstKeptEntryIndex - 1] : undefined;
		return { ...compaction, firstKeptEntryId: kept?.id ?? null };
	});
}

function renameHookMessage(entry: SessionEntry): SessionEntry {
	if (entry?.type !== "message" || (entry.message as { role?: string } | null | undefined)?.role !== "hookMessage")
		return entry;
	return { ...entry, message: { ...entry.message, role: "custom" } as SessionMessageEntry["message"] };
}
