import { Buffer } from "node:buffer";
import { sessionEntryToContextMessages } from "../session-manager-history.ts";
import type { Failure, Result } from "./contracts.js";
import { type TaskLease, type TaskTranscriptSource, taskTranscriptSource } from "./supervisor.js";

export type TaskTranscriptItem = {
	id: string;
	kind:
		| "prompt"
		| "assistant"
		| "thinking"
		| "tool-call"
		| "tool-result"
		| "response"
		| "compaction"
		| "branch-summary"
		| "shell"
		| "custom-message";
	source: { sessionId: string; entryId: string; contentIndex?: number };
	toolCallId?: string;
};
export type TaskTranscriptPage = {
	items: Array<TaskTranscriptItem>;
	nextCursor?: string;
	omittedEarlier: boolean;
};
export type TranscriptError = "UnknownTask" | "ScopeMismatch" | "TranscriptUnavailable";
const PAGE_ITEMS = 100;

/**
 * References existing session entries; never copies message text into task history. A finished task's history is read
 * from its session store (#5186).
 */
export async function readTaskTranscript(
	task: TaskLease,
	cursor?: string,
): Promise<Result<TaskTranscriptPage, Failure<TranscriptError>>> {
	const bound = taskTranscriptSource(task);
	if (!bound.ok) return bound;
	const { session, taskId } = bound.value;
	if (!session.loadHistory) return readTaskTranscriptSnapshot(task, cursor);
	const history = await session.loadHistory();
	if (history.unavailable !== undefined)
		return { ok: false, error: { code: "TranscriptUnavailable", message: history.unavailable } };
	return taskTranscriptPage(taskId, session.getSessionId(), history.entries, cursor);
}

/** Synchronous history read lets an in-process viewer subscribe without an await gap. */
export function readTaskTranscriptSnapshot(
	task: TaskLease,
	cursor?: string,
): Result<TaskTranscriptPage, Failure<TranscriptError>> {
	const bound = taskTranscriptSource(task);
	if (!bound.ok) return bound;
	const { session, taskId } = bound.value;
	return taskTranscriptPage(taskId, session.getSessionId(), session.getEntries(), cursor);
}

/** The page of `entries`, the history of task `taskId`'s session `sessionId`, that ends before `cursor`. */
export function taskTranscriptPage(
	taskId: string,
	sessionId: string,
	entries: ReturnType<TaskTranscriptSource["getEntries"]>,
	cursor?: string,
): Result<TaskTranscriptPage, Failure<TranscriptError>> {
	return taskTranscriptPageWithCuts(taskId, sessionId, entries, cursor);
}

/** A task view also needs the source rows crossing the two boundaries of the same indexed page. */
export function taskTranscriptPageWithCuts(
	taskId: string,
	sessionId: string,
	entries: ReturnType<TaskTranscriptSource["getEntries"]>,
	cursor: string | undefined,
	onSplitEntries?: (fromEarlier: string | undefined, intoLater: string | undefined) => void,
	window?: { offset?: number; forward?: boolean; located(start: number, end: number, total: number): void },
): Result<TaskTranscriptPage, Failure<TranscriptError>> {
	const scope = `${taskId}\n${sessionId}\n`;
	let before: string | undefined;
	if (cursor !== undefined) {
		const decoded = Buffer.from(cursor, "base64url").toString("utf8");
		if (!decoded.startsWith(scope)) {
			return {
				ok: false,
				error: { code: "ScopeMismatch", message: "Transcript cursor belongs to another task or session" },
			};
		}
		before = decoded.slice(scope.length);
	}
	const items: TaskTranscriptItem[] = [];
	const seen = new Set<string>();
	const add = (item: TaskTranscriptItem) => {
		if (seen.has(item.id)) return;
		seen.add(item.id);
		items.push(item);
	};
	for (const entry of entries) {
		const source = { sessionId, entryId: entry.id };
		if (entry.type === "compaction" || entry.type === "branch_summary") {
			if (sessionEntryToContextMessages(entry).length > 0)
				add({ id: entry.id, kind: entry.type === "compaction" ? "compaction" : "branch-summary", source });
			continue;
		}
		if (entry.type === "custom_message") {
			if (entry.display) add({ id: entry.id, kind: "custom-message", source });
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "user") {
			add({ id: entry.id, kind: "prompt", source });
		} else if (message.role === "toolResult") {
			add({ id: entry.id, kind: "tool-result", source, toolCallId: message.toolCallId });
		} else if (message.role === "bashExecution") {
			add({ id: entry.id, kind: "shell", source });
		} else if (message.role === "custom" && message.display) {
			add({ id: entry.id, kind: "custom-message", source });
		} else if (message.role === "branchSummary") {
			add({ id: entry.id, kind: "branch-summary", source });
		} else if (message.role === "assistant") {
			let hasContent = false;
			for (const [contentIndex, block] of message.content.entries()) {
				const identity = { id: `${entry.id}:${contentIndex}`, source: { ...source, contentIndex } };
				if (block.type === "toolCall") {
					add({ ...identity, kind: "tool-call", toolCallId: block.id });
				} else if (block.type === "text") {
					add({ ...identity, kind: message.stopReason === "stop" ? "response" : "assistant" });
				} else if (block.type === "thinking") {
					add({ ...identity, kind: "thinking" });
				} else continue;
				hasContent = true;
			}
			// The terminal notice is visible even if no content block could be displayed.
			if (
				!hasContent &&
				(message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length")
			)
				add({ id: entry.id, kind: "assistant", source });
		}
	}
	if (items.length === 0) {
		return { ok: false, error: { code: "TranscriptUnavailable", message: "Transcript unavailable" } };
	}
	const found = before === undefined ? items.length : items.findIndex((item) => item.id === before);
	const bound = window?.offset ?? (found < 0 ? items.length : found);
	const end = window?.forward ? Math.min(items.length, bound + PAGE_ITEMS) : Math.min(items.length, bound);
	const start = window?.forward ? bound : Math.max(0, end - PAGE_ITEMS);
	window?.located(start, end, items.length);
	const page = items.slice(start, end);
	// Use the existing index: ignored content blocks are not page boundaries.
	if (onSplitEntries && (start > 0 || end < items.length) && page.length > 0) {
		const first = page[0]!.source.entryId;
		const last = page[page.length - 1]!.source.entryId;
		onSplitEntries(
			items[start - 1]?.source.entryId === first ? first : undefined,
			items[end]?.source.entryId === last ? last : undefined,
		);
	}
	return {
		ok: true,
		value: {
			items: page,
			omittedEarlier: start > 0,
			...(start > 0 ? { nextCursor: Buffer.from(`${scope}${page[0].id}`).toString("base64url") } : {}),
		},
	};
}
