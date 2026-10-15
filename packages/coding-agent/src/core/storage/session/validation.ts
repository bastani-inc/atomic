import type { SessionEntry } from "../../session-manager-types.ts";
import {
	SessionInvalidTextError,
	SessionInvalidTimestampError,
	type SessionTextField,
	type SessionTimestampField,
} from "./errors.js";
import type { SessionRecordHeader } from "./types.js";

const isoInstant = /^(\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

function validateSessionTimestamp(field: SessionTimestampField, value: string | number): void {
	if (typeof value === "string" && !isoInstant.test(value)) {
		throw new SessionInvalidTimestampError(field, value, "unparseable");
	}
	const time = typeof value === "number" ? value : Date.parse(value);
	if (typeof value === "string" && !Number.isFinite(time)) {
		const yearLength = value.startsWith("+") || value.startsWith("-") ? 7 : 4;
		const reason =
			value.startsWith("-000000-") || !Number.isFinite(Date.parse(`2000${value.slice(yearLength)}`))
				? "unparseable"
				: "out-of-range";
		throw new SessionInvalidTimestampError(field, value, reason);
	}
	if (!Number.isFinite(time) || Math.abs(time) > 8.64e15) {
		throw new SessionInvalidTimestampError(field, value, "out-of-range");
	}
}

export function validateSessionText(field: SessionTextField, value: string): void {
	if (value.includes("\u0000")) throw new SessionInvalidTextError(field, "nul-character");
	if (!value.isWellFormed()) throw new SessionInvalidTextError(field, "ill-formed-unicode");
}

export function validateSessionHeader(header: SessionRecordHeader): void {
	validateSessionText("header.id", header.id);
	validateSessionText("header.cwd", header.cwd);
	if (header.parentSessionId !== undefined) validateSessionText("header.parentSessionId", header.parentSessionId);
	validateSessionTimestamp("header.createdAt", header.createdAt);
}

export function validateSessionEntries(entries: readonly SessionEntry[]): void {
	for (const entry of entries) {
		validateSessionText("entry.id", entry.id);
		if (entry.parentId !== null) validateSessionText("entry.parentId", entry.parentId);
		if (entry.type === "session_summary") validateSessionText("summarizedThroughId", entry.summarizedThroughId);
		validateSessionTimestamp("entry.timestamp", entry.timestamp);
		if (entry.type === "message") validateSessionTimestamp("entry.message.timestamp", entry.message.timestamp);
		if (entry.type === "compaction" && entry.systemMessage !== undefined) {
			validateSessionTimestamp("entry.systemMessage.timestamp", entry.systemMessage.timestamp);
		}
	}
}
