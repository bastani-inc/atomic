import { Buffer } from "node:buffer";
import { sessionEntryToContextMessages } from "../session-manager-history.ts";
import type { Failure, Result } from "./contracts.js";
import { type TaskLease, taskTranscriptSource } from "./supervisor.js";

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

/** References existing session entries; never copies message text into task history. */
export async function readTaskTranscript(
	task: TaskLease,
	cursor?: string,
): Promise<Result<TaskTranscriptPage, Failure<TranscriptError>>> {
	return readTaskTranscriptSnapshot(task, cursor);
}

/** Synchronous history read lets an in-process viewer subscribe without an await gap. */
export function readTaskTranscriptSnapshot(
	task: TaskLease,
	cursor?: string,
): Result<TaskTranscriptPage, Failure<TranscriptError>> {
	const bound = taskTranscriptSource(task);
	if (!bound.ok) return bound;
	const { session, taskId } = bound.value;
	const sessionId = session.getSessionId();
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
	for (const entry of session.getEntries()) {
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
		} else if (message.role === "assistant") {
			for (const [contentIndex, block] of message.content.entries()) {
				const identity = { id: `${entry.id}:${contentIndex}`, source: { ...source, contentIndex } };
				if (block.type === "toolCall") {
					add({ ...identity, kind: "tool-call", toolCallId: block.id });
				} else if (block.type === "text") {
					add({ ...identity, kind: message.stopReason === "stop" ? "response" : "assistant" });
				} else if (block.type === "thinking") {
					add({ ...identity, kind: "thinking" });
				}
			}
		}
	}
	if (items.length === 0) {
		return { ok: false, error: { code: "TranscriptUnavailable", message: "Transcript unavailable" } };
	}
	const found = before === undefined ? items.length : items.findIndex((item) => item.id === before);
	const end = found < 0 ? items.length : found;
	const start = Math.max(0, end - PAGE_ITEMS);
	const page = items.slice(start, end);
	return {
		ok: true,
		value: {
			items: page,
			omittedEarlier: start > 0,
			...(start > 0 ? { nextCursor: Buffer.from(`${scope}${page[0].id}`).toString("base64url") } : {}),
		},
	};
}
