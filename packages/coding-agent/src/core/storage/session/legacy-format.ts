import type { CompactionEntry, SessionEntry, SessionHeader, SessionMessageEntry } from "../../session-manager-types.ts";
import { generateId } from "../../session-manager-validation.ts";
import { SessionFormatVersionError, type SessionJsonValue } from "./errors.js";
import { SESSION_FORMAT_VERSION } from "./types.js";

export interface StoredSessionHeader {
	readonly type?: SessionJsonValue;
	readonly version?: SessionJsonValue;
	readonly id?: SessionJsonValue;
	readonly timestamp?: SessionJsonValue;
	readonly createdAt?: SessionJsonValue;
	readonly cwd?: SessionJsonValue;
	readonly parentSession?: SessionJsonValue;
	readonly internal?: SessionJsonValue;
	readonly workflow?: SessionHeader["workflow"] | SessionJsonValue;
}

type LegacyCompactionEntry = CompactionEntry & { firstKeptEntryIndex?: number };

type LegacyVersion = 1 | 2 | 3 | typeof SESSION_FORMAT_VERSION;

function isEarlyFormat4Header(stored: StoredSessionHeader): boolean {
	return (
		stored.version === SESSION_FORMAT_VERSION &&
		typeof stored.createdAt !== "string" &&
		typeof stored.timestamp === "string"
	);
}

export function isCurrentSessionHeader(stored: StoredSessionHeader): boolean {
	return stored.version === SESSION_FORMAT_VERSION && !isEarlyFormat4Header(stored);
}

function legacyVersion(stored: StoredSessionHeader, path: string): LegacyVersion {
	const version = stored.version === undefined ? 1 : stored.version;
	if (version === 1 || version === 2 || version === 3) return version;
	if (isEarlyFormat4Header(stored)) return SESSION_FORMAT_VERSION;
	throw new SessionFormatVersionError(path, stored.version);
}

export function upgradeLegacySessionHeader(stored: StoredSessionHeader, path: string): SessionHeader {
	legacyVersion(stored, path);
	return migrateV3ToV4(stored, path);
}

export function upgradeLegacySessionEntries(
	stored: StoredSessionHeader,
	entries: readonly SessionEntry[],
	path: string,
): { header: SessionHeader; entries: SessionEntry[] } {
	const version = legacyVersion(stored, path);
	const header = migrateV3ToV4(stored, path);
	let upgraded: SessionEntry[] = [...entries];
	if (version < 2) upgraded = migrateV1ToV2(upgraded, stored, path);
	if (version < 3) upgraded = migrateV2ToV3(upgraded);
	return { header, entries: upgraded };
}

function migrateV1ToV2(entries: readonly SessionEntry[], stored: StoredSessionHeader, path: string): SessionEntry[] {
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

function migrateV2ToV3(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.map(renameHookMessage);
}

function migrateV3ToV4(stored: StoredSessionHeader, path: string): SessionHeader {
	if (
		stored.type !== "session" ||
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

const LEGACY_SESSION_FILE_NAME =
	/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\.jsonl$/;

function legacyParentSessionId(parentSession: string): string {
	const name = parentSession.split(/[\\/]/).at(-1) ?? parentSession;
	if (name === parentSession) return parentSession;
	return LEGACY_SESSION_FILE_NAME.exec(name)?.[1] ?? parentSession;
}

function renameHookMessage(entry: SessionEntry): SessionEntry {
	if (entry?.type !== "message" || (entry.message as { role?: string } | null | undefined)?.role !== "hookMessage")
		return entry;
	return { ...entry, message: { ...entry.message, role: "custom" } as SessionMessageEntry["message"] };
}
