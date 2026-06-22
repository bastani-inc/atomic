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
		const buffer = Buffer.alloc(512);
		const bytesRead = readSync(fd, buffer, 0, 512, 0);
		closeSync(fd);
		const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
		if (!firstLine) return null;
		const header = JSON.parse(firstLine) as Record<string, unknown>;
		if (header.type !== "session" || typeof header.id !== "string") {
			return null;
		}
		return header as unknown as SessionHeader;
	} catch {
		return null;
	}
}

export function getSessionHeaderCwd(header: SessionHeader): string | undefined {
	const cwd = (header as { cwd?: unknown }).cwd;
	return typeof cwd === "string" ? cwd : undefined;
}

export function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolvePath(cwd) === resolvedCwd;
}

/** Exported for testing */
export function findMostRecentSession(sessionDir: string, cwd?: string): string | null {
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
					(!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(file.header), resolvedCwd)),
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
