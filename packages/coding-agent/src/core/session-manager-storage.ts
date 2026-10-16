import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { isClassifiedWorkflowSession } from "./session-manager-classification.ts";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager-types.ts";
import { validateSessionFileEntries } from "./session-manager-validation.ts";

import { StorageUnavailableError } from "./storage/session/errors.js";

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
/**
 * Dedicated small read chunk for header-only reads. Session headers are small
 * (typically a few KB), so reading in 64KB chunks avoids allocating/transferring
 * the full 1MiB transcript buffer just to inspect the first line during listing
 * and resume-history prefiltering.
 */
const HEADER_READ_BUFFER_SIZE = 64 * 1024;

function parseSessionEntryLine(line: string, path: string): FileEntry | undefined {
	if (!line.trim()) return undefined;
	let entry: FileEntry;
	try {
		entry = JSON.parse(line) as FileEntry;
	} catch (cause) {
		throw new StorageUnavailableError({ adapter: "jsonl", location: path }, cause as Error);
	}
	if (entry?.type === "session") {
		validateSessionFileEntries([entry], path);
	}
	return entry;
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	let pending = "";
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex), resolvedFilePath);
				if (entry !== undefined) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending, resolvedFilePath);
		if (finalEntry !== undefined) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	if (entries.length === 0) return entries;
	validateSessionFileEntries(entries, resolvedFilePath);

	return entries;
}

export function parseSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.trim().split("\n")) {
		const entry = parseSessionEntryLine(line, "session content");
		if (entry !== undefined) entries.push(entry);
	}
	return entries;
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	try {
		const fd = openSync(filePath, "r");
		try {
			// Read the full first line rather than a fixed 512-byte window so very
			// long headers (e.g. internal workflow headers carrying stage metadata)
			// are not truncated and dropped from listing/resume filtering.
			const decoder = new StringDecoder("utf8");
			// Use a small dedicated header buffer instead of the 1MiB transcript
			// buffer so prefiltering internal sessions during listing stays cheap.
			// The loop still reads in chunks until the first newline (or EOF) so
			// headers larger than one chunk are handled correctly.
			const buffer = Buffer.allocUnsafe(HEADER_READ_BUFFER_SIZE);
			let pending = "";
			let foundNewline = false;
			while (true) {
				const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
				if (bytesRead === 0) break;
				pending += decoder.write(buffer.subarray(0, bytesRead));
				const newlineIndex = pending.indexOf("\n");
				if (newlineIndex !== -1) {
					pending = pending.slice(0, newlineIndex);
					foundNewline = true;
					break;
				}
			}
			// Only flush the decoder when we hit EOF without a newline. Once a
			// newline was found, any remaining decoder bytes belong to data after
			// the header line; flushing them would corrupt the parsed header.
			if (!foundNewline) {
				pending += decoder.end();
			}
			const firstLine = pending.split("\n")[0];
			if (!firstLine) return null;
			const header = JSON.parse(firstLine) as SessionHeader;
			return validateSessionFileEntries([header], filePath);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** Returns true only for workflow-owned sessions with a complete classification marker. */
export function isInternalHeader(header: SessionHeader | null | undefined): boolean {
	return isClassifiedWorkflowSession(header);
}

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

export function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string, includeInternal = false): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const resolvedCwd = cwd ? resolvePath(cwd) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			try {
				const header = readSessionHeader(path);
				if (
					!header ||
					(resolvedCwd && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) ||
					(!includeInternal && isInternalHeader(header))
				)
					continue;
				if (loadEntriesFromFile(path).length > 0) return path;
			} catch {
				// Unloadable sessions are not resume candidates.
			}
		}
		return null;
	} catch {
		return null;
	}
}

export function serializeSessionEntries(entries: FileEntry[]): string {
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * A new session file is created only once the session contains a user or assistant message.
 * Setup entries alone (model, thinking level) stay in memory, so opening and closing without
 * chatting leaves no file behind. Starting at the user message (not the first assistant reply)
 * keeps the prompt on disk if the first turn never completes.
 */
export function hasConversationMessage(entries: FileEntry[]): boolean {
	return entries.some(
		(entry): entry is SessionEntry =>
			entry.type === "message" && (entry.message.role === "user" || entry.message.role === "assistant"),
	);
}

export function ensureDirectory(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
