import { type ChatMessageEntry, NoticeLine, type NoticeLineSpec } from "@bastani/atomic";
import type { Component } from "@bastani/atomic-tui";
import type { StageNotice } from "../shared/store-types.js";
import type { NoticeEntry, TranscriptDebugEntry, TranscriptEntry } from "./stage-chat-view-types.js";

export function noticeSummary(n: StageNotice): string {
	if (n.kind === "decision" && n.meta !== undefined) return `~ ${n.meta}`;
	if (n.kind === "undelivered") return `~ not delivered, the stage finished first: ${JSON.stringify(n.to)}`;
	const base = `~ ${n.kind} → ${n.to}`;
	return n.from ? `${base} (was ${n.from})` : base;
}

export function stageNoticeCountsAsMessage(entry: NoticeEntry): boolean {
	switch (entry.kind) {
		case "model":
		case "thinking":
		case "compaction":
		case "tree":
		case "abort":
		case "mcp":
		case "cleanup":
		case "decision":
		case "undelivered":
			return false;
	}
}

/** How a stage chat shows its notices: expanded with its other blocks (ctrl+o), at the chat's output pad. */
export interface StageNoticeRenderSettings {
	readonly expanded?: boolean;
	readonly outputPad?: number;
}

/** A stage notice in the shared notice anatomy, read from `settings` on every render so ctrl+o and the pad apply. */
export function noticeRow(
	entry: NoticeEntry,
	settings: () => StageNoticeRenderSettings | undefined = () => undefined,
): Component {
	const spec = stageNoticeLine(entry);
	return {
		render(width: number): string[] {
			const current = settings();
			return new NoticeLine(
				{
					...spec,
					countHiddenDetail: true,
					...(current?.outputPad === undefined ? {} : { outputPad: current.outputPad }),
				},
				current?.expanded === true,
			).render(width);
		},
		invalidate() {
			/* notice entries are immutable */
		},
	};
}

export function transcriptDebugEntries(entry: TranscriptEntry): TranscriptDebugEntry[] {
	if (isChatMessageEntry(entry) && entry.kind === "assistant") {
		const entries: TranscriptDebugEntry[] = [];
		const thinking = extractThinkingText(entry.message.content);
		const text = extractMessageText(entry.message.content);
		if (thinking) {
			entries.push({
				role: "thinking",
				text: thinking,
				toolCallId: "",
				state: "",
				output: "",
			});
		}
		if (text || entries.length === 0) {
			entries.push({ ...entry, text, toolCallId: "", state: "", output: "" });
		}
		return entries;
	}
	return [
		{
			...entry,
			role: entry.role,
			text: transcriptDebugText(entry),
			toolCallId: transcriptDebugToolCallId(entry),
			state: transcriptDebugToolState(entry),
			output: transcriptDebugToolOutput(entry),
		},
	];
}

function transcriptDebugText(entry: TranscriptEntry): string {
	if ("text" in entry && typeof entry.text === "string") return entry.text;
	if (isChatMessageEntry(entry)) {
		switch (entry.kind) {
			case "assistant":
				return extractMessageText(entry.message.content);
			case "tool":
				return entry.result
					? extractToolResultText(entry.result)
					: `${entry.toolName} ${typeof entry.args === "string" ? entry.args : JSON.stringify(entry.args ?? {})}`;
			case "bashExecution":
				return entry.message.output || entry.message.command;
			case "user":
			case "system":
				return entry.text;
			case "custom":
				return extractMessageText(entry.message.content);
			case "branchSummary":
				return entry.message.summary;
		}
	}
	return "";
}

function transcriptDebugToolCallId(entry: TranscriptEntry): string {
	if (isChatMessageEntry(entry) && entry.kind === "tool") return entry.toolCallId;
	if ("toolCallId" in entry && typeof entry.toolCallId === "string") {
		return entry.toolCallId;
	}
	return "";
}

function transcriptDebugToolState(entry: TranscriptEntry): string {
	if (isChatMessageEntry(entry) && entry.kind === "tool") {
		if (entry.result?.isError) return "error";
		return entry.isPartial === false ? "success" : "pending";
	}
	if ("state" in entry && typeof entry.state === "string") return entry.state;
	return "";
}

function transcriptDebugToolOutput(entry: TranscriptEntry): string {
	if (isChatMessageEntry(entry) && entry.kind === "tool") {
		return entry.result ? extractToolResultText(entry.result) : "";
	}
	if ("output" in entry && typeof entry.output === "string") return entry.output;
	return "";
}

function isChatMessageEntry(entry: TranscriptEntry): entry is ChatMessageEntry {
	return "kind" in entry && entry.role !== "notice";
}

function extractThinkingText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item == null || typeof item !== "object") continue;
		const thinking = (item as { type?: unknown; thinking?: unknown }).thinking;
		if ((item as { type?: unknown }).type === "thinking" && typeof thinking === "string") {
			parts.push(thinking);
		}
	}
	return parts.join("\n\n");
}

function extractMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const item of content) {
		if (item == null) continue;
		if (typeof item === "string") {
			parts.push(item);
			continue;
		}
		const obj = item as { type?: unknown; text?: unknown };
		if (typeof obj.text === "string") parts.push(obj.text);
	}
	return parts.join("");
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") return result;
	if (result == null || typeof result !== "object") return "";
	const content = (result as { content?: unknown }).content;
	return extractMessageText(content);
}

/** Facts after the outcome: what it was before, and any note the notice carries. */
function changeMeta(entry: NoticeEntry): string[] {
	return [entry.from === undefined ? "" : `was ${entry.from}`, entry.meta ?? ""].filter(Boolean);
}

function oneLineText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

/** Each stage notice as one notice line, with what expanding it (ctrl+o) shows under it. */
export function stageNoticeLine(entry: NoticeEntry): NoticeLineSpec {
	switch (entry.kind) {
		case "model":
			return {
				status: "info",
				label: "Model changed to",
				subject: entry.value,
				outcome: "",
				meta: changeMeta(entry),
			};
		case "thinking":
			return {
				status: "info",
				label: "Thinking level changed to",
				subject: entry.value,
				outcome: "",
				meta: changeMeta(entry),
			};
		case "compaction":
			return {
				status: "success",
				label: "Context",
				outcome: entry.value === "compacted" ? "compacted" : `compacted (${entry.value})`,
				meta: entry.meta === undefined ? [] : [entry.meta],
			};
		case "tree":
			return {
				status: "info",
				label: "Branch changed to",
				subject: entry.value,
				outcome: "",
				meta: changeMeta(entry),
			};
		case "abort":
			return { status: "stopped", label: "Stage", outcome: entry.value, meta: changeMeta(entry) };
		case "cleanup":
			return {
				status: "warning",
				label: "Task",
				outcome: "finished; its process cleanup is still being confirmed",
				meta: [entry.value],
				...(entry.meta === undefined ? {} : { detail: entry.meta.split("; ").join("\n") }),
			};
		case "decision": {
			const status = entry.value === "advanced" ? "success" : entry.value === "stayed" ? "info" : "warning";
			return {
				status,
				label: entry.meta ?? "Decision model judged the stage's readiness",
				outcome: "",
				meta: [entry.meta === undefined ? entry.value : "", entry.from ?? ""].filter(Boolean),
			};
		}
		case "undelivered":
			return {
				status: "warning",
				label: "Stage",
				outcome: "finished before this message was delivered",
				detail: [`message ${oneLineText(entry.value)}`, "Send it to another stage if it still matters."].join("\n"),
			};
		default:
			return { status: "info", label: entry.kind, outcome: entry.value, meta: changeMeta(entry) };
	}
}
