import { firstSubagentAttempt, latestSubagentAttempt } from "./completion.js";
import type { TaskId } from "./contracts.js";
import type { TaskTranscriptSource } from "./supervisor.js";
import type { TaskViewSource } from "./task-view-source.js";

type PromptEntry = ReturnType<TaskTranscriptSource["getEntries"]>[number];

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part: { type?: unknown; text?: unknown }) =>
			part?.type === "text" && typeof part.text === "string" ? [part.text] : [],
		)
		.join("");
}

/**
 * The user messages of `entries` after `inheritedThroughId`, oldest first, as typed (`rawText` when a skill or
 * template expanded it): what Up recalls for an agent. Entries a fork inherited end at `inheritedThroughId`; when it
 * is absent, or not among `entries`, they all count.
 */
export function ownDeliveredPrompts(entries: readonly PromptEntry[], inheritedThroughId?: string): string[] {
	const boundary = inheritedThroughId === undefined ? -1 : entries.findLastIndex((e) => e.id === inheritedThroughId);
	const prompts: string[] = [];
	for (const entry of entries.slice(boundary + 1)) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const raw = "rawText" in entry.message ? entry.message.rawText : undefined;
		const text = (typeof raw === "string" && raw.trim() ? raw : messageText(entry.message.content)).trim();
		if (text) prompts.push(text);
	}
	return prompts;
}

/**
 * The prompts of the subagent `taskId` is an attempt of, oldest first: the user messages delivered to its session,
 * which are its task, its resume messages and what was typed to it, never what a fork inherited from the main chat
 * while its launch attempt is listed. Read where the session lives: at once from a live session, else from its saved
 * history; none when it has no readable session or the read fails.
 */
export function readTaskPrompts(
	source: TaskViewSource,
	taskId: TaskId,
): readonly string[] | Promise<readonly string[]> {
	const live = latestSubagentAttempt(source.tasks, taskId)?.ref.taskId ?? taskId;
	// A resumed attempt is listed before its session is bound; until then its conversation is the earlier attempt's.
	const session = (source.followTaskTranscript(live) ?? source.followTaskTranscript(taskId))?.session;
	if (session === undefined) return [];
	const launch = firstSubagentAttempt(source.tasks, taskId);
	// A resume's own boundary is the conversation before it: only the launch attempt's marks what a fork inherited.
	const inheritedThroughId =
		launch === undefined || String(launch.launchOperationId ?? "").includes(":resume:")
			? undefined
			: source.followTaskTranscript(launch.ref.taskId)?.inheritedThroughId;
	const resident = session.getEntries();
	if (resident.length > 0) return ownDeliveredPrompts(resident, inheritedThroughId);
	const read = async (): Promise<readonly PromptEntry[]> => {
		if (session.loadHistory) return (await session.loadHistory()).entries;
		if (session.readHistory) {
			const entries: PromptEntry[] = [];
			for await (const { items } of session.readHistory())
				for (const item of items) if ("entry" in item) entries.push(item.entry);
			return entries;
		}
		return session.getFallbackEntries?.() ?? [];
	};
	return read().then(
		(entries) => ownDeliveredPrompts(entries, inheritedThroughId),
		() => [],
	);
}
