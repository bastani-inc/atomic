import type { SessionEntry } from "@bastani/atomic";
import { SessionInvalidTextError, type SessionTextField } from "./errors.js";
import type { SessionRecordHeader } from "./types.js";

export function validateSessionText(field: SessionTextField, value: string): void {
	if (value.includes("\u0000")) throw new SessionInvalidTextError(field, "nul-character");
	if (!value.isWellFormed()) throw new SessionInvalidTextError(field, "ill-formed-unicode");
}

export function validateSessionHeader(header: SessionRecordHeader): void {
	validateSessionText("header.id", header.id);
	validateSessionText("header.cwd", header.cwd);
	if (header.parentSessionId !== undefined) validateSessionText("header.parentSessionId", header.parentSessionId);
}

export function validateSessionEntries(entries: readonly SessionEntry[]): void {
	for (const entry of entries) {
		validateSessionText("entry.id", entry.id);
		if (entry.parentId !== null) validateSessionText("entry.parentId", entry.parentId);
		if (entry.type === "session_summary") validateSessionText("summarizedThroughId", entry.summarizedThroughId);
	}
}
