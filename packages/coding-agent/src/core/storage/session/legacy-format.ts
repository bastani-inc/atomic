import type { CompactionEntry, SessionEntry, SessionHeader, SessionMessageEntry } from "../../session-manager-types.ts";
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

export function legacyVersion(stored: StoredSessionHeader, path: string): LegacyVersion {
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

function v1EntryId(seq: number): string {
	return seq.toString(16).padStart(8, "0");
}

export function upgradeLegacySessionEntry(
	stored: StoredSessionHeader,
	entry: SessionEntry,
	seq: number,
	path: string,
): SessionEntry {
	const version = legacyVersion(stored, path);
	let upgraded = entry;
	if (version < 2) {
		const id = v1EntryId(seq);
		const parentId = seq > 1 ? v1EntryId(seq - 1) : null;
		const withIds: SessionEntry = { ...upgraded, id, parentId };
		if (withIds.type === "compaction") {
			const { firstKeptEntryIndex, ...compaction } = withIds as LegacyCompactionEntry;
			if (typeof firstKeptEntryIndex === "number") {
				if (!Number.isInteger(firstKeptEntryIndex) || firstKeptEntryIndex < 0 || firstKeptEntryIndex > seq)
					throw new SessionFormatVersionError(path, stored.version);
				const firstKeptEntryId =
					firstKeptEntryIndex >= 1 && firstKeptEntryIndex < seq ? v1EntryId(firstKeptEntryIndex) : null;
				upgraded = { ...compaction, firstKeptEntryId };
			} else {
				upgraded = withIds;
			}
		} else {
			upgraded = withIds;
		}
	}
	if (version < 3) upgraded = renameHookMessage(upgraded);
	return upgraded;
}

function migrateV1ToV2(entries: readonly SessionEntry[], stored: StoredSessionHeader, path: string): SessionEntry[] {
	return entries.map((entry, position) =>
		upgradeLegacySessionEntry({ ...stored, version: 1 }, entry, position + 1, path),
	);
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
