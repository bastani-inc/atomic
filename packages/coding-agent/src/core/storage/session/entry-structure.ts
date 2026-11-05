import type { SessionEntry, SessionMessageEntry, WorktreeRestoreHostWarning } from "../../session-manager-types.ts";
import { SessionFormatVersionError } from "./errors.js";
import { SESSION_FORMAT_VERSION } from "./types.js";

/** Validate the tree envelope and required payload fields before consuming persisted entries. */
export function validateSessionEntryStructure(entries: readonly SessionEntry[], path: string): void {
	for (const entry of entries) {
		if (
			!entry ||
			typeof entry !== "object" ||
			typeof entry.id !== "string" ||
			(entry.parentId !== null && typeof entry.parentId !== "string") ||
			typeof entry.timestamp !== "string" ||
			!validPayload(entry)
		)
			throw new SessionFormatVersionError(path, SESSION_FORMAT_VERSION);
	}
}

function validPayload(entry: SessionEntry): boolean {
	switch (entry.type) {
		case "message":
			return validMessage(entry.message);
		case "thinking_level_change":
			return typeof entry.thinkingLevel === "string";
		case "model_change":
			return typeof entry.provider === "string" && typeof entry.modelId === "string";
		case "usage":
			return (
				typeof entry.kind === "string" &&
				typeof entry.provider === "string" &&
				typeof entry.model === "string" &&
				entry.usage !== null &&
				typeof entry.usage === "object"
			);
		case "compaction":
			return (
				typeof entry.summary === "string" &&
				(entry.firstKeptEntryId === null || typeof entry.firstKeptEntryId === "string") &&
				(entry.coveredThroughEntryId === undefined || typeof entry.coveredThroughEntryId === "string") &&
				typeof entry.tokensBefore === "number"
			);
		case "context_compaction":
			return (
				entry.promptVersion === 1 &&
				Array.isArray(entry.deletedTargets) &&
				Array.isArray(entry.protectedEntryIds) &&
				entry.stats !== null &&
				typeof entry.stats === "object"
			);
		case "branch_summary":
			return typeof entry.fromId === "string" && typeof entry.summary === "string";
		case "custom":
			return typeof entry.customType === "string";
		case "custom_message":
			return (
				typeof entry.customType === "string" &&
				(typeof entry.content === "string" || Array.isArray(entry.content)) &&
				typeof entry.display === "boolean"
			);
		case "context_edit":
			return (
				typeof entry.targetId === "string" &&
				(entry.replacement === null ||
					(typeof entry.replacement === "object" &&
						(typeof entry.replacement.content === "string" || Array.isArray(entry.replacement.content))))
			);
		case "label":
			return typeof entry.targetId === "string" && (entry.label === undefined || typeof entry.label === "string");
		case "session_info":
			return entry.name === undefined || typeof entry.name === "string";
		case "session_summary":
			return typeof entry.summary === "string" && typeof entry.summarizedThroughId === "string";
		case "worktree_snapshot":
			return (
				typeof entry.root === "string" &&
				typeof entry.snapshotId === "string" &&
				(entry.snapshot === undefined ||
					(entry.snapshot !== null &&
						typeof entry.snapshot === "object" &&
						entry.snapshot.id === entry.snapshotId &&
						typeof entry.snapshot.tree === "string" &&
						Array.isArray(entry.snapshot.chain))) &&
				(entry.restore === undefined ||
					(entry.restore !== null &&
						typeof entry.restore === "object" &&
						typeof entry.restore.from === "string" &&
						entry.restore.to === entry.root &&
						entry.restore.snapshotId === entry.snapshotId)) &&
				(entry.restoreWarnings === undefined ||
					(entry.restore !== undefined &&
						Array.isArray(entry.restoreWarnings) &&
						entry.restoreWarnings.every(validRestoreHostWarning))) &&
				(entry.blobs === undefined ||
					(entry.blobs !== null &&
						typeof entry.blobs === "object" &&
						!Array.isArray(entry.blobs) &&
						Object.values(entry.blobs).every((value) => typeof value === "string")))
			);
		default:
			return false;
	}
}

const LEFTOVER_KINDS = new Set<string>(["worktree", "record", "records-directory"]);

function validRestoreHostWarning(warning: WorktreeRestoreHostWarning | null): boolean {
	if (warning?.code === "lfs-objects-unavailable") {
		return Array.isArray(warning.paths) && warning.paths.every((path) => typeof path === "string");
	}
	return (
		warning?.code === "stale-restore-retained" && typeof warning.path === "string" && LEFTOVER_KINDS.has(warning.kind)
	);
}

function validMessage(message: SessionMessageEntry["message"]): boolean {
	if (!message || typeof message !== "object" || typeof message.timestamp !== "number") return false;
	switch (message.role) {
		case "system":
		case "user":
		case "assistant":
		case "toolResult":
		case "custom":
			return typeof message.content === "string" || Array.isArray(message.content);
		case "bashExecution":
			return (
				typeof message.command === "string" &&
				typeof message.output === "string" &&
				typeof message.cancelled === "boolean" &&
				typeof message.truncated === "boolean"
			);
		case "branchSummary":
			return typeof message.summary === "string" && (message.fromId === null || typeof message.fromId === "string");
		default:
			return false;
	}
}
