import type { AgentMessage } from "@bastani/atomic-agent-core";
import type { AgentSessionEvent } from "./agent-session-types.js";
import type { CustomMessage } from "./messages.ts";
import type { SessionEntry } from "./session-manager-types.ts";

/**
 * The `customType` of the `custom` entry that records a line Atomic itself wrote into a chat about how a turn ended:
 * a retry that failed or was cancelled, a compaction that failed or was cancelled, a continuation that could not start,
 * a checkout snapshot that could not be recorded. A `custom` entry is never part of model context, so the line is only
 * shown: live as a custom message of the same type, and from the entry when the chat is opened again.
 */
export const HOST_NOTICE_TYPE = "atomic.notice";

/** `error` and `warning` lines read `Error: …` and `Warning: …`; a `status` line is the text alone, dimmed. */
export type HostNoticeLevel = "error" | "warning" | "status";

export interface HostNotice {
	readonly level: HostNoticeLevel;
	readonly text: string;
}

/** The most UTF-8 bytes a notice keeps; a longer one, such as a provider's error page, is cut and ends with `…`. */
export const MAX_HOST_NOTICE_BYTES = 4096;

const ELLIPSIS = "…";
const encoder = new TextEncoder();
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** `text` cut at a whole character so it fits {@link MAX_HOST_NOTICE_BYTES} with its trailing `…`. */
export function boundHostNoticeText(text: string): string {
	if (text.length <= MAX_HOST_NOTICE_BYTES / 3 || encoder.encode(text).length <= MAX_HOST_NOTICE_BYTES) return text;
	const budget = MAX_HOST_NOTICE_BYTES - encoder.encode(ELLIPSIS).length;
	let bytes = 0;
	let end = 0;
	for (const { segment, index } of graphemes.segment(text)) {
		bytes += encoder.encode(segment).length;
		if (bytes > budget) break;
		end = index + segment.length;
	}
	return `${text.slice(0, end)}${ELLIPSIS}`;
}

/** Event reasons that mean nothing was there to snapshot; the session then behaves as it does without snapshots. */
const WORKSPACE_ABSENCE_CODES: ReadonlySet<string> = new Set(["not-installed", "not-a-repository", "unborn-head"]);

/**
 * The line a session event puts in its chat about how the turn ended, if any. `compactionReason` is the session's
 * compaction in progress when the event is emitted: an automatic compaction a manual one took over says nothing,
 * since the manual one reports the outcome.
 */
export function hostNoticeForEvent(
	event: AgentSessionEvent,
	compactionReason: string | undefined,
): HostNotice | undefined {
	switch (event.type) {
		case "auto_retry_end":
			if (event.success) return undefined;
			return {
				level: "error",
				text: `Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`,
			};
		case "agent_continue_error":
			// A message that could not be sent stays queued; its error is about that input, not the conversation.
			return event.queuedMessage === true ? undefined : { level: "error", text: event.errorMessage };
		case "compaction_end": {
			const takenOver =
				event.reason !== "manual" && (event.manualTakeoverPending === true || compactionReason === "manual");
			if (takenOver) return undefined;
			if (event.aborted)
				return event.reason === "manual"
					? { level: "error", text: "Compaction cancelled" }
					: { level: "status", text: "Auto-compaction cancelled" };
			return event.errorMessage ? { level: "error", text: event.errorMessage } : undefined;
		}
		case "worktree_snapshot_unavailable":
			return WORKSPACE_ABSENCE_CODES.has(event.reason.code ?? "")
				? undefined
				: { level: "warning", text: event.reason.message };
		default:
			return undefined;
	}
}

function isHostNoticeLevel(value: unknown): value is HostNoticeLevel {
	return value === "error" || value === "warning" || value === "status";
}

/** Whether a stored entry is meant to record a notice; {@link hostNoticeFromEntry} reads it. */
export function isHostNoticeEntry(entry: SessionEntry): boolean {
	return entry.type === "custom" && entry.customType === HOST_NOTICE_TYPE;
}

/** The notice a stored entry records, if it is one. */
export function hostNoticeFromEntry(entry: SessionEntry): HostNotice | undefined {
	if (!isHostNoticeEntry(entry) || entry.type !== "custom") return undefined;
	const data = entry.data as { level?: unknown; text?: unknown } | undefined;
	if (!isHostNoticeLevel(data?.level) || typeof data.text !== "string") return undefined;
	return { level: data.level, text: boundHostNoticeText(data.text) };
}

/** The display-only message a chat shows for `notice`; it is never sent to the model. */
export function hostNoticeMessage(notice: HostNotice, timestamp: number): CustomMessage<HostNotice> {
	const message: CustomMessage<HostNotice> & { excludeFromContext: true } = {
		role: "custom",
		customType: HOST_NOTICE_TYPE,
		content: notice.text,
		display: true,
		details: { level: notice.level, text: notice.text },
		timestamp,
		excludeFromContext: true,
	};
	return message;
}

/** The message a chat transcript shows for a stored notice entry, if `entry` is one. */
export function hostNoticeMessageFromEntry(entry: SessionEntry): CustomMessage<HostNotice> | undefined {
	const notice = hostNoticeFromEntry(entry);
	return notice === undefined ? undefined : hostNoticeMessage(notice, new Date(entry.timestamp).getTime());
}

/** The notice a chat message shows, if it is one. */
export function hostNoticeFromMessage(message: AgentMessage | CustomMessage): HostNotice | undefined {
	if (message.role !== "custom" || message.customType !== HOST_NOTICE_TYPE) return undefined;
	const details = message.details as { level?: unknown; text?: unknown } | undefined;
	if (!isHostNoticeLevel(details?.level) || typeof details.text !== "string") return undefined;
	return { level: details.level, text: details.text };
}
