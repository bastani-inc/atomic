import { join } from "path";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import {
	createLabelEntry,
	createSessionFilePath,
	createSessionHeader,
} from "./session-manager-entries.ts";
import { getDefaultSessionDir } from "./session-manager-paths.ts";
import {
	appendSessionEntry,
	ensureDirectory,
	hasAssistantMessage,
	loadEntriesFromFile,
	writeSessionEntries,
} from "./session-manager-storage.ts";
import type { FileEntry, LabelEntry, NewSessionOptions, SessionEntry, SessionHeader } from "./session-manager-types.ts";
import { assertValidSessionId, createSessionId, generateId } from "./session-manager-validation.ts";

export function createBackupSnapshot(
	sessionFile: string | undefined,
	entries: FileEntry[],
	label = "compact",
): string | undefined {
	if (!sessionFile) return undefined;
	const safeLabel = label.replace(/[^a-z0-9_-]/gi, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "backup";
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const backupPath = `${sessionFile}.${timestamp}.${safeLabel}.bak`;
	writeSessionEntries(backupPath, entries);
	return backupPath;
}

export interface BranchedSessionStateInput {
	leafId: string;
	persist: boolean;
	sessionDir: string;
	cwd: string;
	previousSessionFile: string | undefined;
	path: SessionEntry[];
	labelsById: ReadonlyMap<string, string>;
	labelTimestampsById: ReadonlyMap<string, string>;
}

export interface BranchedSessionState {
	sessionId: string;
	sessionFile: string | undefined;
	fileEntries: FileEntry[];
	shouldRewriteFile: boolean;
	flushed?: boolean;
}

function collectLabelsForPath(
	pathEntryIds: ReadonlySet<string>,
	labelsById: ReadonlyMap<string, string>,
	labelTimestampsById: ReadonlyMap<string, string>,
): Array<{ targetId: string; label: string; timestamp: string }> {
	const labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }> = [];
	for (const [targetId, label] of labelsById) {
		if (pathEntryIds.has(targetId)) {
			labelsToWrite.push({ targetId, label, timestamp: labelTimestampsById.get(targetId)! });
		}
	}
	return labelsToWrite;
}

function buildPersistedLabelEntries(
	pathEntryIds: Set<string>,
	lastEntryId: string | null,
	labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>,
): LabelEntry[] {
	let parentId = lastEntryId;
	const labelEntries: LabelEntry[] = [];
	for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
		const labelEntry = createLabelEntry(targetId, label, new Set(pathEntryIds), parentId, labelTimestamp);
		pathEntryIds.add(labelEntry.id);
		labelEntries.push(labelEntry);
		parentId = labelEntry.id;
	}
	return labelEntries;
}

function buildInMemoryLabelEntries(
	pathEntryIds: Set<string>,
	lastEntryId: string | null,
	labelsToWrite: Array<{ targetId: string; label: string; timestamp: string }>,
): LabelEntry[] {
	const labelEntries: LabelEntry[] = [];
	let parentId = lastEntryId;
	for (const { targetId, label, timestamp: labelTimestamp } of labelsToWrite) {
		const labelEntry: LabelEntry = {
			type: "label",
			id: generateId(new Set([...pathEntryIds, ...labelEntries.map((e) => e.id)])),
			parentId,
			timestamp: labelTimestamp,
			targetId,
			label,
		};
		labelEntries.push(labelEntry);
		parentId = labelEntry.id;
	}
	return labelEntries;
}

export function createBranchedSessionState(input: BranchedSessionStateInput): BranchedSessionState {
	if (input.path.length === 0) {
		throw new Error(`Entry ${input.leafId} not found`);
	}

	// Filter out LabelEntry from path - we'll recreate them from the resolved map
	const pathWithoutLabels = input.path.filter((entry) => entry.type !== "label");
	const newSessionId = createSessionId();
	const timestamp = new Date().toISOString();
	const newSessionFile = createSessionFilePath(input.sessionDir, timestamp, newSessionId);
	const header: SessionHeader = createSessionHeader(
		newSessionId,
		input.cwd,
		timestamp,
		input.persist ? input.previousSessionFile : undefined,
	);

	// Collect labels for entries in the path
	const pathEntryIds = new Set(pathWithoutLabels.map((entry) => entry.id));
	const labelsToWrite = collectLabelsForPath(pathEntryIds, input.labelsById, input.labelTimestampsById);
	const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
	const labelEntries = input.persist
		? buildPersistedLabelEntries(pathEntryIds, lastEntryId, labelsToWrite)
		: buildInMemoryLabelEntries(pathEntryIds, lastEntryId, labelsToWrite);
	const fileEntries: FileEntry[] = [header, ...pathWithoutLabels, ...labelEntries];

	if (!input.persist) {
		return { sessionId: newSessionId, sessionFile: undefined, fileEntries, shouldRewriteFile: false };
	}

	const shouldRewriteFile = hasAssistantMessage(fileEntries);
	return {
		sessionId: newSessionId,
		sessionFile: newSessionFile,
		fileEntries,
		shouldRewriteFile,
		flushed: shouldRewriteFile,
	};
}

export interface ForkedSessionFile {
	cwd: string;
	sessionDir: string;
	sessionFile: string;
}

export function forkSessionFromFile(
	sourcePath: string,
	targetCwd: string,
	sessionDir?: string,
	options?: NewSessionOptions,
): ForkedSessionFile {
	const resolvedSourcePath = resolvePath(sourcePath);
	const resolvedTargetCwd = resolvePath(targetCwd);
	const sourceEntries = loadEntriesFromFile(resolvedSourcePath);
	if (sourceEntries.length === 0) {
		throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
	}

	const sourceHeader = sourceEntries.find((entry) => entry.type === "session") as SessionHeader | undefined;
	if (!sourceHeader) {
		throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
	}

	const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
	ensureDirectory(dir);

	// Create new session file with new ID but forked content
	if (options?.id !== undefined) {
		assertValidSessionId(options.id);
	}
	const newSessionId = options?.id ?? createSessionId();
	const timestamp = new Date().toISOString();
	const newSessionFile = join(dir, `${timestamp.replace(/[:.]/g, "-")}_${newSessionId}.jsonl`);

	// Write new header pointing to source as parent, with updated cwd
	const newHeader: SessionHeader = createSessionHeader(newSessionId, resolvedTargetCwd, timestamp, resolvedSourcePath);
	appendSessionEntry(newSessionFile, newHeader);

	// Copy all non-header entries from source
	for (const entry of sourceEntries) {
		if (entry.type !== "session") {
			appendSessionEntry(newSessionFile, entry);
		}
	}

	return { cwd: resolvedTargetCwd, sessionDir: dir, sessionFile: newSessionFile };
}
