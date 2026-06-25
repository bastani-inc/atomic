import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	statSync,
	writeFileSync,
} from "fs";
import { join } from "path";
import { StringDecoder } from "string_decoder";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager-types.ts";

const SESSION_READ_BUFFER_SIZE = 1024 * 1024;
/**
 * Dedicated small read chunk for header-only reads. Session headers are small
 * (typically a few KB), so reading in 64KB chunks avoids allocating/transferring
 * the full 1MiB transcript buffer just to inspect the first line during listing
 * and resume-history prefiltering.
 */
const HEADER_READ_BUFFER_SIZE = 64 * 1024;

function parseSessionEntryLine(line: string): FileEntry | null {
	if (!line.trim()) return null;
	try {
		return JSON.parse(line) as FileEntry;
	} catch {
		return null;
	}
}

/** Exported for testing */
export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const entries: FileEntry[] = [];
	const fd = openSync(resolvedFilePath, "r");
	try {
		const decoder = new StringDecoder("utf8");
		const buffer = Buffer.allocUnsafe(SESSION_READ_BUFFER_SIZE);
		let pending = "";

		while (true) {
			const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
			if (bytesRead === 0) break;

			pending += decoder.write(buffer.subarray(0, bytesRead));
			let lineStart = 0;
			let newlineIndex = pending.indexOf("\n", lineStart);
			while (newlineIndex !== -1) {
				const entry = parseSessionEntryLine(pending.slice(lineStart, newlineIndex));
				if (entry) entries.push(entry);
				lineStart = newlineIndex + 1;
				newlineIndex = pending.indexOf("\n", lineStart);
			}
			pending = pending.slice(lineStart);
		}

		pending += decoder.end();
		const finalEntry = parseSessionEntryLine(pending);
		if (finalEntry) entries.push(finalEntry);
	} finally {
		closeSync(fd);
	}

	// Validate session header
	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || !("id" in header) || typeof header.id !== "string") {
		return [];
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
			const header = JSON.parse(firstLine) as Record<string, unknown>;
			if (header.type !== "session" || typeof header.id !== "string") {
				return null;
			}
			return header as unknown as SessionHeader;
		} finally {
			closeSync(fd);
		}
	} catch {
		return null;
	}
}

/** Returns true when a session header marks the session as internal (e.g. a workflow stage session). */
export function isInternalHeader(header: SessionHeader | null | undefined): boolean {
	return header?.internal === true;
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
			.map((path) => ({ path, header: readSessionHeader(path) }))
			.filter(
				(file): file is { path: string; header: SessionHeader } =>
					file.header !== null &&
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)) &&
					(includeInternal || !isInternalHeader(file.header)),
			)
			.map(({ path }) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

export function serializeSessionEntries(entries: FileEntry[]): string {
	return `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export function writeSessionEntries(filePath: string, entries: FileEntry[]): void {
	writeFileSync(filePath, serializeSessionEntries(entries));
}

export function appendSessionEntry(filePath: string, entry: FileEntry): void {
	appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
}

export function appendSessionEntries(filePath: string, entries: FileEntry[]): void {
	for (const entry of entries) {
		appendSessionEntry(filePath, entry);
	}
}

export function hasAssistantMessage(entries: FileEntry[]): boolean {
	return entries.some((entry): entry is SessionEntry => entry.type === "message" && entry.message.role === "assistant");
}

export function ensureDirectory(dir: string): void {
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
	}
}
