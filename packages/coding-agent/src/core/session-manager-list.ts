import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, TextContent } from "@earendil-works/pi-ai";
import { existsSync } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";
import { getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { parseSessionEntries } from "./session-manager-migrations.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath } from "./session-manager-paths.ts";
import {
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
	SessionWorkflowMetadata,
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

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries = parseSessionEntries(content);

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
		const internal = (header as SessionHeader).internal === true ? true : undefined;
		const workflowHeader = (header as SessionHeader).workflow as SessionWorkflowMetadata | undefined;
		const workflow =
			workflowHeader && typeof workflowHeader.runId === "string" ? workflowHeader : undefined;

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
		const results = await Promise.all(
			files.map(async (file) => {
				const info = await buildSessionInfo(file);
				loaded++;
				onProgress?.(progressOffset + loaded, total);
				return info;
			}),
		);
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

		const results = await Promise.all(
			allFiles.map(async (file) => {
				const info = await buildSessionInfo(file);
				loaded++;
				progress?.(loaded, totalFiles);
				return info;
			}),
		);

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
