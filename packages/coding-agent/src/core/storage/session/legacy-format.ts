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
		...(stored.parentSession === undefined ? {} : { parentSessionId: stored.parentSession }),
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
	const treeEntries = stored.version === undefined || stored.version === 1 ? addTreeIds(entries) : entries;
	return { header, entries: stored.version === 3 ? [...treeEntries] : treeEntries.map(renameHookMessage) };
}

function addTreeIds(entries: readonly SessionEntry[]): SessionEntry[] {
	const ids = new Set<string>();
	let parentId: string | null = null;
	const upgraded = entries.map((entry) => {
		const id = generateId(ids);
		ids.add(id);
		const next: SessionEntry = { ...entry, id, parentId };
		parentId = id;
		return next;
	});
	return upgraded.map((entry) => {
		if (entry.type !== "compaction") return entry;
		const { firstKeptEntryIndex, ...compaction } = entry as LegacyCompactionEntry;
		if (typeof firstKeptEntryIndex !== "number") return entry;
		const kept = firstKeptEntryIndex >= 1 ? upgraded[firstKeptEntryIndex - 1] : undefined;
		return { ...compaction, firstKeptEntryId: kept?.id ?? null };
	});
}

function renameHookMessage(entry: SessionEntry): SessionEntry {
	if (entry?.type !== "message" || (entry.message as { role?: string } | null | undefined)?.role !== "hookMessage")
		return entry;
	return { ...entry, message: { ...entry.message, role: "custom" } as SessionMessageEntry["message"] };
}
