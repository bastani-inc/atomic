import type { SessionSnapshot, SessionSummary } from "./types.js";

export function summarizeSession({ header, entries }: SessionSnapshot): SessionSummary {
	let messageCount = 0;
	let firstMessage = "";
	let name: string | undefined;
	let hasName = false;
	let summary: string | undefined;
	let summarizedThroughId: string | undefined;
	let modifiedAt = header.createdAt;
	let latestTime = Number.NEGATIVE_INFINITY;
	const texts: string[] = [];

	for (const entry of entries) {
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
			if (Number.isFinite(time) && time > latestTime) {
				latestTime = time;
				modifiedAt = new Date(time).toISOString();
			}
			const text =
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join(" ");
			if (text) {
				texts.push(text);
				if (!firstMessage && message.role === "user") firstMessage = text;
			}
		}
	}

	return {
		id: header.id,
		cwd: header.cwd,
		...(header.parentSessionId !== undefined ? { parentSessionId: header.parentSessionId } : {}),
		internal: header.internal === true,
		...(header.workflow !== undefined ? { workflow: header.workflow } : {}),
		...(name !== undefined ? { name } : {}),
		hasName,
		createdAt: header.createdAt,
		modifiedAt,
		messageCount,
		firstMessage: firstMessage || "(no messages)",
		...(summary !== undefined ? { summary } : {}),
		...(summarizedThroughId !== undefined ? { summarizedThroughId } : {}),
		searchText: texts.join(" "),
	};
}
