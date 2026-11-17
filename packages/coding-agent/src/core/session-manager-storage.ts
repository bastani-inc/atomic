import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, statSync } from "fs";
import { open } from "fs/promises";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { createSessionCwdMatcher, normalizePath, resolvePath } from "../utils/paths.ts";
import { isClassifiedWorkflowSession } from "./session-manager-classification.ts";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager-types.ts";
import { validateSessionFileEntries } from "./session-manager-validation.ts";

import { StorageUnavailableError } from "./storage/session/errors.js";
import {
	isCurrentSessionHeader,
	type StoredSessionHeader,
	upgradeLegacySessionEntries,
} from "./storage/session/legacy-format.js";

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
/**
 * Dedicated small read chunk for header-only reads. Session headers are small
 * (typically a few KB), so reading in 64KB chunks avoids allocating/transferring
 * the full 1MiB transcript buffer just to inspect the first line during listing
 * and resume-history prefiltering.
 */
const HEADER_READ_BUFFER_SIZE = 64 * 1024;

function parseSessionEntryLine(line: string, path: string, validateHeader = true): FileEntry | undefined {
	if (!line.trim()) return undefined;
	let entry: FileEntry;
	try {
		entry = JSON.parse(line) as FileEntry;
	} catch (cause) {
		throw new StorageUnavailableError({ adapter: "jsonl", location: path }, cause as Error);
	}
	if (validateHeader && entry?.type === "session") {
		validateSessionFileEntries([entry], path);
	}
	return entry;
}

export function parseStoredSessionEntries(content: string): FileEntry[] {
	const entries: FileEntry[] = [];
	for (const line of content.trim().split("\n")) {
		const entry = parseSessionEntryLine(line, "session content", false);
		if (entry !== undefined) entries.push(entry);
	}
	return entries;
}

export function upgradeStoredSessionEntries(entries: FileEntry[], path: string): FileEntry[] {
	const header = entries[0];
	if (header?.type !== "session" || isCurrentSessionHeader(header as StoredSessionHeader)) return entries;
	const upgraded = upgradeLegacySessionEntries(
		header as StoredSessionHeader,
		entries.slice(1) as SessionEntry[],
		path,
	);
	return [upgraded.header, ...upgraded.entries];
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

/**
 * The first line of a file, fed chunk by chunk. The full first line is read rather than a fixed 512-byte window so
 * very long headers (e.g. internal workflow headers carrying stage metadata) are not truncated and dropped from
 * listing/resume filtering. Callers read with a small dedicated header buffer instead of the 1MiB transcript buffer
 * so prefiltering internal sessions during listing stays cheap, in chunks until the first newline (or EOF) so headers
 * larger than one chunk are handled correctly.
 */
class SessionHeaderLine {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	private foundNewline = false;

	/** Takes the next chunk, empty at EOF; true once the first line is complete. */
	push(chunk: Buffer): boolean {
		if (chunk.length === 0) return true;
		this.pending += this.decoder.write(chunk);
		const newlineIndex = this.pending.indexOf("\n");
		if (newlineIndex === -1) return false;
		this.pending = this.pending.slice(0, newlineIndex);
		this.foundNewline = true;
		return true;
	}

	header(filePath: string): SessionHeader | null {
		// Only flush the decoder when we hit EOF without a newline. Once a
		// newline was found, any remaining decoder bytes belong to data after
		// the header line; flushing them would corrupt the parsed header.
		if (!this.foundNewline) {
			this.pending += this.decoder.end();
		}
		const firstLine = this.pending.split("\n")[0];
		if (!firstLine) return null;
		const header = JSON.parse(firstLine) as SessionHeader;
		return validateSessionFileEntries(upgradeStoredSessionEntries([header], filePath), filePath);
	}
}

export function readSessionHeader(filePath: string): SessionHeader | null {
	try {
		const fd = openSync(filePath, "r");
		try {
			const line = new SessionHeaderLine();
			const buffer = Buffer.allocUnsafe(HEADER_READ_BUFFER_SIZE);
			while (!line.push(buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, null)))) {}
			return line.header(filePath);
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** {@link readSessionHeader} without blocking the event loop. */
export async function readSessionHeaderAsync(filePath: string): Promise<SessionHeader | null> {
	try {
		const file = await open(filePath, "r");
		try {
			const line = new SessionHeaderLine();
			const buffer = Buffer.allocUnsafe(HEADER_READ_BUFFER_SIZE);
			while (!line.push(buffer.subarray(0, (await file.read(buffer, 0, buffer.length, null)).bytesRead))) {}
			return line.header(filePath);
		} finally {
			await file.close();
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

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string, includeInternal = false): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	const matchesCwd = cwd ? createSessionCwdMatcher(resolvePath(cwd)) : undefined;
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.map((path) => ({ path, mtime: statSync(path).mtimeMs }))
			.sort((a, b) => b.mtime - a.mtime);

		for (const { path } of files) {
			try {
				const header = readSessionHeader(path);
				const headerCwd = header ? getSessionHeaderCwd(header) : undefined;
				if (
					!header ||
					(matchesCwd && (!headerCwd || !matchesCwd(resolvePath(headerCwd)))) ||
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
