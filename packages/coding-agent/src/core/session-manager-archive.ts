import { createLabelEntry, createSessionHeader } from "./session-manager-entries.ts";
import { SessionEntryError } from "./session-manager-errors.js";
import type {
	FileEntry,
	LabelEntry,
	SessionEntry,
	SessionHeader,
	SessionWorkflowMetadata,
} from "./session-manager-types.ts";
import { createSessionId } from "./session-manager-validation.ts";

export interface BranchedSessionStateInput {
	leafId: string;
	cwd: string;
	parentSessionId: string;
	workflow?: SessionWorkflowMetadata;
	path: SessionEntry[];
	labelsById: ReadonlyMap<string, string>;
	labelTimestampsById: ReadonlyMap<string, string>;
}

export interface BranchedSessionState {
	sessionId: string;
	fileEntries: FileEntry[];
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

function buildLabelEntries(
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

export function createBranchedSessionState(input: BranchedSessionStateInput): BranchedSessionState {
	if (input.path.length === 0) {
		throw new SessionEntryError(input.leafId, "missing");
	}

	// Filter labels out, re-chain the retained path, and translate compaction boundaries
	// that pointed at a removed label to the first retained entry after it.
	const pathWithoutLabels: SessionEntry[] = [];
	const replacementByLabelId = new Map<string, string>();
	const pendingLabelIds: string[] = [];
	let pathParentId: string | null = null;
	for (const entry of input.path) {
		if (entry.type === "label") {
			pendingLabelIds.push(entry.id);
			continue;
		}
		for (const labelId of pendingLabelIds) replacementByLabelId.set(labelId, entry.id);
		pendingLabelIds.length = 0;
		pathWithoutLabels.push(
			entry.type === "compaction"
				? {
						...entry,
						parentId: pathParentId,
						firstKeptEntryId:
							entry.firstKeptEntryId === null
								? null
								: (replacementByLabelId.get(entry.firstKeptEntryId) ?? entry.firstKeptEntryId),
					}
				: { ...entry, parentId: pathParentId },
		);
		pathParentId = entry.id;
	}
	const newSessionId = createSessionId();
	const timestamp = new Date().toISOString();
	const header: SessionHeader = createSessionHeader(
		newSessionId,
		input.cwd,
		timestamp,
		input.parentSessionId,
		input.workflow !== undefined,
		input.workflow,
	);

	// Collect labels for entries in the path
	const pathEntryIds = new Set(pathWithoutLabels.map((entry) => entry.id));
	const labelsToWrite = collectLabelsForPath(pathEntryIds, input.labelsById, input.labelTimestampsById);
	const lastEntryId = pathWithoutLabels[pathWithoutLabels.length - 1]?.id || null;
	const labelEntries = buildLabelEntries(pathEntryIds, lastEntryId, labelsToWrite);
	return { sessionId: newSessionId, fileEntries: [header, ...pathWithoutLabels, ...labelEntries] };
}
