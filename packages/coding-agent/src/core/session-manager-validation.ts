import { uuidv7 } from "@bastani/pi-ai";
import { randomUUID } from "crypto";
import {
	CURRENT_SESSION_VERSION,
	type FileEntry,
	type SessionEntry,
	type SessionHeader,
} from "./session-manager-types.ts";
import { validateSessionEntryStructure } from "./storage/session/entry-structure.js";
import { SessionFormatVersionError } from "./storage/session/errors.js";

/** Reject unsupported or incomplete trees before indexing or rewriting their header. */
export function validateSessionFileEntries(entries: readonly FileEntry[], path: string): SessionHeader {
	const header = entries[0];
	if (header?.type !== "session") throw new SessionFormatVersionError(path, undefined);
	if (
		header.version !== CURRENT_SESSION_VERSION ||
		typeof header.id !== "string" ||
		typeof header.cwd !== "string" ||
		typeof header.timestamp !== "string"
	)
		throw new SessionFormatVersionError(path, header.version);
	validateSessionEntryStructure(entries.slice(1) as SessionEntry[], path);
	return header;
}

export function createSessionId(): string {
	return uuidv7();
}

export function assertValidSessionId(id: string): void {
	if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(id)) {
		throw new Error(
			"Session id must be non-empty, contain only alphanumeric characters, '-', '_', and '.', and start and end with an alphanumeric character",
		);
	}
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	// Fallback to full UUID if somehow we have collisions
	return randomUUID();
}
