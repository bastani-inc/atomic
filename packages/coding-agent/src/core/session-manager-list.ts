import type { Message, TextContent } from "@bastani/pi-ai/compat";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { existsSync, type Stats } from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { basename, join } from "path";
import { getSessionsDir } from "../config.js";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { classifiedWorkflowMetadata } from "./session-manager-classification.ts";
import { getLatestSessionSummary } from "./session-manager-entries.ts";
import { getDefaultSessionDir, getDefaultSessionDirPath } from "./session-manager-paths.ts";
import {
	isInternalHeader,
	parseStoredSessionEntries,
	readSessionHeader,
	sessionCwdMatches,
	upgradeStoredSessionEntries,
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
import { validateSessionFileEntries } from "./session-manager-validation.ts";

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

	const headerTime = typeof header.createdAt === "string" ? new Date(header.createdAt).getTime() : NaN;
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
const LIST_FILE_BATCH_SIZE = 10;

async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	map: (item: T, index: number) => Promise<R>,
	signal?: AbortSignal,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(items.length, limit) }, async () => {
			while (next < items.length) {
				signal?.throwIfAborted();
				const index = next++;
				results[index] = await map(items[index]!, index);
			}
		}),
	);
	return results;
}

interface SessionFileCandidate {
	path: string;
	stats?: Stats;
}
function sortSessionInfos(sessions: SessionInfo[]): SessionInfo[] {
	return sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

async function parseSessionEntriesCooperatively(content: string, signal?: AbortSignal): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");
	let startedAt = Date.now();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index]!;
		if (line.trim()) {
			entries.push(...parseStoredSessionEntries(line));
		}
		if ((index + 1) % PARSE_YIELD_EVERY_LINES === 0) {
			signal?.throwIfAborted();
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
	files: readonly SessionFileCandidate[],
	includeInternal: boolean,
	onFileDone: (info: SessionInfo | null, index: number) => void,
	signal?: AbortSignal,
): Promise<(SessionInfo | null)[]> {
	return mapWithConcurrency(
		files,
		LIST_FILE_BATCH_SIZE,
		async (file, index) => {
			// Hidden sessions never enter partial results or the expensive transcript parser.
			const info =
				!includeInternal && isInternalHeader(readSessionHeader(file.path))
					? null
					: await buildSessionInfo(file.path, signal, file.stats);
			signal?.throwIfAborted();
			onFileDone(info, index);
			return info;
		},
		signal,
	);
}

async function buildSessionInfo(
	filePath: string,
	signal?: AbortSignal,
	fileStats?: Stats,
): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, { encoding: "utf8", signal });
		const entries = upgradeStoredSessionEntries(
			content.length > COOPERATIVE_PARSE_CONTENT_BYTES
				? await parseSessionEntriesCooperatively(content, signal)
				: parseStoredSessionEntries(content),
			filePath,
		);

		const header = validateSessionFileEntries(entries, filePath);

		const stats = fileStats ?? (await stat(filePath));
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;
		let hasName = false;

		for (const entry of entries) {
			// Extract session name state (use latest, including explicit clears:
			// a latest empty name means cleared, no session_info entry means never named)
			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
				hasName = true;
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
		const parentSessionPath = (header as SessionHeader).parentSessionId;
		const workflow = classifiedWorkflowMetadata(header as SessionHeader);
		const internal = workflow ? true : undefined;

		const modified = getSessionModifiedDate(entries, header as SessionHeader, stats.mtime);

		const summary = getLatestSessionSummary(entries);

		return {
			path: filePath,
			id: (header as SessionHeader).id,
			cwd,
			name,
			...(hasName ? { hasName: true } : {}),
			parentSessionPath,
			...(internal ? { internal } : {}),
			...(workflow ? { workflow } : {}),
			created: new Date((header as SessionHeader).createdAt),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			summary: summary?.summary,
			summarizedThroughId: summary?.summarizedThroughId,
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		signal?.throwIfAborted();
		return null;
	}
}

export function resolveParentSessionPaths(sessions: SessionInfo[]): SessionInfo[] {
	const paths = new Map(sessions.map((session) => [session.id, session.path]));
	return sessions.map(({ parentSessionPath: parentId, ...session }) => {
		const parentSessionPath = parentId === undefined ? undefined : paths.get(parentId);
		return { ...session, ...(parentSessionPath === undefined ? {} : { parentSessionPath }) };
	});
}

export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	includeInternal = false,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(dir)) return [];
	try {
		const files = (await readdir(dir))
			.filter((file) => file.endsWith(".jsonl"))
			.sort((a, b) => b.localeCompare(a))
			.map((file) => ({ path: join(dir, file) }));
		const partial: SessionInfo[] = [];
		let loaded = 0;
		const results = await mapSessionFilesCooperatively(
			files,
			includeInternal,
			(info) => {
				loaded++;
				if (info && (includeInternal || !info.internal)) partial.push(info);
				onProgress?.(
					loaded,
					files.length,
					loaded === 1 || loaded % 10 === 0 || loaded === files.length
						? sortSessionInfos(resolveParentSessionPaths(partial))
						: undefined,
				);
			},
			signal,
		);
		return resolveParentSessionPaths(
			results.filter((info): info is SessionInfo => info !== null && (includeInternal || !info.internal)),
		);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

export async function listProjectSessions(
	cwd: string,
	sessionDir?: string,
	onProgress?: SessionListProgress,
	includeInternal = false,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
	const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
	const resolvedCwd = resolvePath(cwd);
	const include = (session: SessionInfo) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd);
	const progress: SessionListProgress | undefined = onProgress
		? (loaded, total, partial) => onProgress(loaded, total, partial?.filter(include))
		: undefined;
	return sortSessionInfos((await listSessionsFromDir(dir, progress, includeInternal, signal)).filter(include));
}

export async function listAllSessions(
	sessionDirOrOnProgress?: string | SessionListProgress,
	onProgress?: SessionListProgress,
	includeInternal = false,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	const customSessionDir =
		typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
	const progress = typeof sessionDirOrOnProgress === "function" ? sessionDirOrOnProgress : onProgress;
	if (customSessionDir) {
		const sessions = await listSessionsFromDir(customSessionDir, progress, includeInternal, signal);
		sessions.sort((a, b) => b.modified.getTime() - a.modified.getTime());
		return sessions;
	}

	const sessionsDir = getSessionsDir();

	try {
		if (!existsSync(sessionsDir)) {
			return [];
		}
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		const dirs = entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => join(sessionsDir, entry.name));

		const dirFiles = await mapWithConcurrency(
			dirs,
			64,
			async (dir) => {
				try {
					return (await readdir(dir)).filter((file) => file.endsWith(".jsonl")).map((file) => join(dir, file));
				} catch {
					return [];
				}
			},
			signal,
		);
		const candidates = await mapWithConcurrency(
			dirFiles.flat(),
			64,
			async (path): Promise<SessionFileCandidate> => {
				try {
					return { path, stats: await stat(path) };
				} catch {
					return { path };
				}
			},
			signal,
		);
		candidates.sort(
			(a, b) =>
				(b.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) - (a.stats?.mtimeMs ?? Number.NEGATIVE_INFINITY) ||
				basename(b.path).localeCompare(basename(a.path)),
		);
		let loaded = 0;
		let firstCandidateLoaded = false;
		const partial: SessionInfo[] = [];
		const results = await mapSessionFilesCooperatively(
			candidates,
			includeInternal,
			(info, index) => {
				loaded++;
				if (index === 0) firstCandidateLoaded = true;
				if (info && (includeInternal || !info.internal)) partial.push(info);
				progress?.(
					loaded,
					candidates.length,
					firstCandidateLoaded && (index === 0 || loaded % 100 === 0 || loaded === candidates.length)
						? sortSessionInfos(resolveParentSessionPaths(partial))
						: undefined,
				);
			},
			signal,
		);
		return sortSessionInfos(
			resolveParentSessionPaths(
				results.filter((info): info is SessionInfo => info !== null && (includeInternal || !info.internal)),
			),
		);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}
