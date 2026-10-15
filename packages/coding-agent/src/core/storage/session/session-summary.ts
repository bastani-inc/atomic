import type { AssistantMessage, TextContent, UserMessage } from "@bastani/pi-ai/compat";
import type { SessionEntry } from "../../session-manager-types.ts";
import type { SessionRecordHeader, SessionSnapshot, SessionSummary } from "./types.js";

/** Metadata stays bounded by the first message and latest metadata, not the transcript. */
export interface SessionSummaryState {
	readonly messageCount: number;
	readonly firstMessage: string;
	readonly name?: string;
	readonly hasName: boolean;
	readonly summary?: string;
	readonly summarizedThroughId?: string;
	readonly latestMessageTime: number | null;
}

export interface SessionSummaryText {
	readonly index: number;
	readonly text: string;
}

/** Applies only this batch; texts contain only contributions from these entries. */
export function applySessionSummaryEntries(
	previous: SessionSummaryState | undefined,
	entries: readonly SessionEntry[],
): { state: SessionSummaryState; texts: readonly SessionSummaryText[] } {
	let messageCount = previous?.messageCount ?? 0;
	let firstMessage = previous?.firstMessage ?? "";
	let name = previous?.name;
	let hasName = previous?.hasName ?? false;
	let summary = previous?.summary;
	let summarizedThroughId = previous?.summarizedThroughId;
	let latestMessageTime = previous?.latestMessageTime ?? null;
	const texts: SessionSummaryText[] = [];

	for (const [index, entry] of entries.entries()) {
		if (entry.type === "session_info") {
			hasName = true;
			name = entry.name;
		} else if (entry.type === "session_summary") {
			summary = entry.summary;
			summarizedThroughId = entry.summarizedThroughId;
		} else if (entry.type === "message") {
			messageCount++;
			const message = entry.message;
			if (message.role !== "user" && message.role !== "assistant") continue;
			const time = message.timestamp;
			if (Number.isFinite(time) && (latestMessageTime === null || time > latestMessageTime)) {
				latestMessageTime = time;
			}
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter(
								(
									block: Exclude<(UserMessage | AssistantMessage)["content"], string>[number],
								): block is TextContent => block.type === "text",
							)
							.map((block: TextContent) => block.text)
							.join(" ");
			if (text) {
				texts.push({ index, text });
				if (!firstMessage && message.role === "user") firstMessage = text;
			}
		}
	}

	return {
		state: {
			messageCount,
			firstMessage,
			...(name !== undefined ? { name } : {}),
			hasName,
			...(summary !== undefined ? { summary } : {}),
			...(summarizedThroughId !== undefined ? { summarizedThroughId } : {}),
			latestMessageTime,
		},
		texts,
	};
}

export function materializeSessionSummaryMetadata(
	header: SessionRecordHeader,
	state: SessionSummaryState,
): Omit<SessionSummary, "searchText"> {
	return {
		id: header.id,
		cwd: header.cwd,
		...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
		internal: header.internal === true,
		...(header.workflow !== undefined ? { workflow: header.workflow } : {}),
		...(state.name !== undefined ? { name: state.name } : {}),
		hasName: state.hasName,
		createdAt: header.createdAt,
		modifiedAt: state.latestMessageTime === null ? header.createdAt : new Date(state.latestMessageTime).toISOString(),
		messageCount: state.messageCount,
		firstMessage: state.firstMessage || "(no messages)",
		...(state.summary !== undefined ? { summary: state.summary } : {}),
		...(state.summarizedThroughId !== undefined ? { summarizedThroughId: state.summarizedThroughId } : {}),
	};
}

export function summarizeSession({ header, entries }: SessionSnapshot): SessionSummary {
	const { state, texts } = applySessionSummaryEntries(undefined, entries);
	return {
		...materializeSessionSummaryMetadata(header, state),
		searchText: texts.map(({ text }) => text).join(" "),
	};
}
