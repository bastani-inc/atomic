import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { ContextEditEntry, SessionEntry } from "../../session-manager-types.ts";
import { historyChunks, historyPages } from "./history-pages.js";
import type { SessionHistoryItem, SessionResume, SessionStore } from "./types.js";

/** A stop without text is an answer too: it prevents copying text from an earlier turn. */
export interface AssistantAnswer {
	readonly text?: string;
}

function contentText(content: unknown): string | undefined {
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.map((block) => (block?.type === "text" ? block.text : "")).join("")
				: "";
	return text.trim() || undefined;
}

function answer(content: unknown, stop: boolean): AssistantAnswer | undefined {
	const text = contentText(content);
	return text ? { text } : stop ? {} : undefined;
}

export function lastAssistantAnswer(messages: readonly AgentMessage[]): AssistantAnswer | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]!;
		if (message.role === "assistant") {
			const found = answer(message.content, message.stopReason === "stop");
			if (found) return found;
		}
	}
	return undefined;
}

/** Raw saved entries stay raw. Only the last edit on this branch changes a candidate's answer. */
export function lastBranchAnswer(
	entries: readonly SessionEntry[],
	include: (entry: SessionEntry) => boolean,
): AssistantAnswer | undefined {
	const edits = new Map<string, ContextEditEntry>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i]!;
		if (entry.type === "context_edit" && !edits.has(entry.targetId)) edits.set(entry.targetId, entry);
		if (!include(entry) || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const edit = edits.get(entry.id);
		if (edit?.replacement === null) continue;
		const found = answer(
			edit ? edit.replacement!.content : entry.message.content,
			entry.message.stopReason === "stop",
		);
		if (found) return found;
	}
	return undefined;
}

/** Recover just the answer before the resident branch. Walk the original parent links, not append order or
 * the manager's shortened links. Positions, not replacement payloads, survive page boundaries. */
export async function savedWindowAnswer(
	store: SessionStore,
	resume: SessionResume,
): Promise<AssistantAnswer | undefined> {
	const first = resume.branch[0];
	if (!first || !resume.compaction || !first.entry.parentId || first.seq === 1) return;
	if (
		!resume.omitted.assistantMessages &&
		!resume.state.some(
			({ entry, onBranch }) => onBranch && entry.type === "message" && entry.message.role === "assistant",
		)
	)
		return;
	const edits = new Map<string, number>();
	for (const { entry, seq } of resume.branch) if (entry.type === "context_edit") edits.set(entry.targetId, seq);
	const id = resume.header.id;
	const pages = (fromSeq: number, toSeq: number) =>
		historyPages(store, id, resume.epoch, resume.lastSeq, { fromSeq, toSeq, direction: "backward" });
	const chunks = (item: Exclude<SessionHistoryItem, { entry: SessionEntry }>) =>
		historyChunks(store, id, resume.epoch, item, {});
	const replacement = async (seq: number) => {
		for await (const { items } of pages(seq, seq)) {
			const item = items[0]!;
			if (!("entry" in item))
				return (await import("./chunked-resume-projection.js")).chunkedAnswerContent(chunks(item), true);
			if (item.entry.type === "context_edit")
				return item.entry.replacement === null ? null : contentText(item.entry.replacement.content);
		}
	};
	let parent: string | null = first.entry.parentId;
	for await (const { items } of pages(1, first.seq - 1)) {
		for (let i = items.length - 1; i >= 0; i--) {
			const item = items[i]!;
			let entry: {
				id: string;
				parentId: string | null;
				type: string;
				targetId?: string;
				role?: string;
				stop?: boolean;
			};
			if ("entry" in item) {
				const raw = item.entry;
				entry = {
					id: raw.id,
					parentId: raw.parentId,
					type: raw.type,
					targetId: raw.type === "context_edit" ? raw.targetId : undefined,
					role: raw.type === "message" ? raw.message.role : undefined,
					stop: raw.type === "message" && raw.message.role === "assistant" && raw.message.stopReason === "stop",
				};
			} else entry = await (await import("./chunked-resume-projection.js")).chunkedAnswerHeader(chunks(item));
			if (entry.id !== parent) continue;
			parent = entry.parentId;
			if (entry.targetId !== undefined && !edits.has(entry.targetId)) edits.set(entry.targetId, item.seq);
			if (entry.type === "message" && entry.role === "assistant") {
				const edited = edits.get(entry.id);
				const text =
					edited !== undefined
						? await replacement(edited)
						: "entry" in item
							? contentText(
									item.entry.type === "message" &&
										item.entry.message.role === "assistant" &&
										item.entry.message.content,
								)
							: await (await import("./chunked-resume-projection.js")).chunkedAnswerContent(chunks(item), false);
				if (text !== null && (text || entry.stop)) return text ? { text } : {};
			}
			if (parent === null) return;
		}
	}
}
