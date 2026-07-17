import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai/compat";
import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { getSessionsDir } from "../config.ts";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { classifiedWorkflowMetadata } from "./session-manager-classification.ts";
import { parseSessionEntries } from "./session-manager-migrations.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath } from "./session-manager-paths.ts";
import {
	isInternalHeader,
	readSessionHeader,
	sessionCwdMatches,
} from "./session-manager-storage.ts";
import type {
	FileEntry,
	SessionEntryBase,
	SessionHeader,
	SessionInfo,
	SessionInfoEntry,
	SessionListProgress,
	SessionMessageEntry,
} from "./session-manager-types.ts";

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getLastActivityTime(entries: FileEntry[]): number | undefined {
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const message = (entry as SessionMessageEntry).message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const msgTimestamp = (message as { timestamp?: number }).timestamp;
		if (typeof msgTimestamp === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
			continue;
		}

		const entryTimestamp = (entry as SessionEntryBase).timestamp;
		if (typeof entryTimestamp === "string") {
			const t = new Date(entryTimestamp).getTime();
			if (!Number.isNaN(t)) {
				lastActivityTime = Math.max(lastActivityTime ?? 0, t);
			}
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
	const lastActivityTime = getLastActivityTime(entries);
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

// A single very large transcript is parsed in bounded cooperative chunks so the
// synchronous JSON.parse-per-line loop yields to terminal input, timers, and
// render work instead of freezing the host. Smaller files stay on the cheaper
// fully-synchronous fast path.
const COOPERATIVE_PARSE_CONTENT_BYTES = 512 * 1024;
const PARSE_YIELD_EVERY_LINES = 2000;

// Directory listings walk files in bounded batches, yielding between batches so
// large session folders cannot starve the event loop during a scan.
const LIST_FILE_BATCH_SIZE = 24;

async function parseSessionEntriesCooperatively(content: string): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");
	let startedAt = Date.now();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.trim()) {
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				// Skip malformed lines, matching parseSessionEntries.
			}
		}
		if ((index + 1) % PARSE_YIELD_EVERY_LINES === 0) {
			await yieldToEventLoopIfSlow(startedAt);
			startedAt = Date.now();
		}
	}
	return entries;
}

/**
 * Parse + summarize session files in bounded batches, yielding between batches
 * so a large directory scan never blocks the TUI event loop. Progress is
 * reported per file via onFileDone, matching the previous eager Promise.all.
 */
async function mapSessionFilesCooperatively(
	files: readonly string[],
	includeInternal: boolean,
	onFileDone: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = [];
	for (let offset = 0; offset < files.length; offset += LIST_FILE_BATCH_SIZE) {
		const batch = files.slice(offset, offset + LIST_FILE_BATCH_SIZE);
		const startedAt = Date.now();
		const batchResults = await Promise.all(
			batch.map(async (file) => {
				// Prefilter via the header so hidden/internal sessions are skipped
				// before the expensive full-transcript parse in buildSessionInfo.
				if (!includeInternal && isInternalHeader(readSessionHeader(file))) {
					onFileDone();
					return null;
				}
				const info = await buildSessionInfo(file);
				onFileDone();
				return info;
			}),
		);
		for (const info of batchResults) results.push(info);
		await yieldToEventLoopIfSlow(startedAt);
	}
	return results;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries = content.length > COOPERATIVE_PARSE_CONTENT_BYTES
			? await parseSessionEntriesCooperatively(content)
			: parseSessionEntries(content);

		if (entries.length === 0) return null;
		const header = entries[0];
		if (header.type !== "session") return null;

		const stats = await stat(filePath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;

		for (const entry of entries) {
			// Extract session name (use latest, including explicit clears)
			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		const cwd = typeof (header as SessionHeader).cwd === "string" ? (header as SessionHeader).cwd : "";
		const parentSessionPath = (header as SessionHeader).parentSession;
		const workflow = classifiedWorkflowMetadata(header as SessionHeader);
		const internal = workflow ? true : undefined;

		const modified = getSessionModifiedDate(entries, header as SessionHeader, stats.mtime);

		return {
			path: filePath,
			id: (header as SessionHeader).id,
			cwd,
			name,
			parentSessionPath,
			...(internal ? { internal } : {}),
			...(workflow ? { workflow } : {}),
			created: new Date((header as SessionHeader).timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
	includeInternal = false,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await mapSessionFilesCooperatively(files, includeInternal, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info && (includeInternal || !info.internal)) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}

export async function listProjectSessions(
	cwd: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
	includeInternal = false,
): Promise<SessionInfo[]> {
	const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
	const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
	const resolvedCwd = resolvePath(cwd);
	const sessions = (await listSessionsFromDir(dir, onProgress, 0, undefined, includeInternal)).filter(
		(session) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd),
	);
	sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
	return sessions;
}

export async function listAllSessions(
	sessionDirOrOnProgress?: string | SessionListProgress,
	onProgress?: SessionListProgress,
	includeInternal = false,
): Promise<SessionInfo[]> {
	const customSessionDir =
		typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
	const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
	if (customSessionDir) {
		const sessions = await listSessionsFromDir(customSessionDir, progress, 0, undefined, includeInternal);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	const sessionsDir = getSessionsDir();

	try {
		if (!existsSync(sessionsDir)) {
			return [];
		}
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(sessionsDir, e.name));

		// Count total files first for accurate progress
		let totalFiles = 0;
		const dirFiles: string[][] = [];
		for (const dir of dirs) {
			try {
				const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl"));
				dirFiles.push(files.map((f) => join(dir, f)));
				totalFiles += files.length;
			} catch {
				dirFiles.push([]);
			}
		}

		// Process all files with progress tracking
		let loaded = 0;
		const sessions: SessionInfo[] = [];
		const allFiles = dirFiles.flat();

		const results = await mapSessionFilesCooperatively(allFiles, includeInternal, () => {
			loaded++;
			progress?.(loaded, totalFiles);
		});

		for (const info of results) {
			if (info && (includeInternal || !info.internal)) {
				sessions.push(info);
			}
		}

		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	} catch {
		return [];
	}
}
