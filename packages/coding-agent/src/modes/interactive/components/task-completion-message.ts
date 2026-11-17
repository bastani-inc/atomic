import { stripVTControlCharacters } from "node:util";
import { type Component, truncateToWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { TaskCompletionNotice, TaskNoticeLine } from "../../../core/tasks/completion.js";
import { theme } from "../theme/theme.js";
import { keyHintIfBound } from "./keybinding-hints.js";
import { NoticeLine, type NoticeLineSpec } from "./notice-line.ts";

const NOTICE_LINE_STATUSES = new Set(["success", "failure", "stopped", "warning", "paused"]);

function noticeLineFrom(value: unknown): TaskNoticeLine | undefined {
	if (!value || typeof value !== "object") return undefined;
	const line = value as Partial<Record<keyof TaskNoticeLine, unknown>>;
	if (typeof line.status !== "string" || !NOTICE_LINE_STATUSES.has(line.status)) return undefined;
	if (typeof line.label !== "string" || typeof line.outcome !== "string") return undefined;
	return {
		status: line.status as TaskNoticeLine["status"],
		label: line.label,
		outcome: line.outcome,
		...(typeof line.subject === "string" ? { subject: line.subject } : {}),
		...(typeof line.elapsedMs === "number" && Number.isFinite(line.elapsedMs) ? { elapsedMs: line.elapsedMs } : {}),
	};
}

export function completionNoticeFromDetails(details: unknown): TaskCompletionNotice | undefined {
	if (!details || typeof details !== "object" || !("notification" in details)) return undefined;
	const notice = details.notification;
	if (!notice || typeof notice !== "object") return undefined;
	if (
		!("title" in notice) ||
		typeof notice.title !== "string" ||
		!("preview" in notice) ||
		typeof notice.preview !== "string" ||
		!("taskId" in notice) ||
		typeof notice.taskId !== "string" ||
		!("status" in notice)
	)
		return undefined;
	if (notice.status !== "completed" && notice.status !== "failed" && notice.status !== "cancelled") return undefined;
	const line = "line" in notice ? noticeLineFrom(notice.line) : undefined;
	return {
		title: notice.title,
		preview: notice.preview,
		taskId: notice.taskId,
		...("taskKind" in notice && (notice.taskKind === "agent" || notice.taskKind === "command")
			? { taskKind: notice.taskKind }
			: {}),
		status: notice.status,
		...("model" in notice && typeof notice.model === "string" ? { model: notice.model } : {}),
		...("thinking" in notice && typeof notice.thinking === "string" ? { thinking: notice.thinking } : {}),
		...(line === undefined ? {} : { line }),
	};
}

/** How long a task ran: `12s`, `3m 2s`, `1h 31m`. */
export function noticeDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function isAgentNotice(notice: TaskCompletionNotice): boolean {
	return (
		notice.taskKind === "agent" ||
		(notice.taskKind === undefined &&
			(notice.model !== undefined || notice.thinking !== undefined || notice.title.startsWith("Subagent ")))
	);
}

/** The notice-line spec of a notice; one saved by an earlier version shows its title. */
export function taskNoticeLineSpec(notice: TaskCompletionNotice): NoticeLineSpec {
	const line = notice.line;
	if (line !== undefined)
		return {
			status: line.status,
			label: line.label,
			...(line.subject === undefined ? {} : { subject: line.subject }),
			outcome: line.outcome,
			...(line.elapsedMs === undefined ? {} : { meta: [noticeDuration(line.elapsedMs)] }),
		};
	return {
		status: notice.status === "completed" ? "success" : notice.status === "failed" ? "failure" : "stopped",
		label: notice.title.split("\n")[0] ?? "",
		outcome: "",
	};
}

/** Text a task reported, made safe for the terminal: no controls, tabs as spaces. */
function cleanPreview(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
}

/**
 * Finished-task notices in the transcript, each one notice line. A shell's line expands to the tail of its output; an
 * agent's line is followed by the first line of its result, and expands to the rest. Notices joined in one message
 * show one line each. The same component renders them in the main chat, a workflow stage's chat and a subagent's view.
 */
export class TaskCompletionMessage implements Component {
	private readonly notices: readonly TaskCompletionNotice[];
	private readonly expanded: boolean;
	constructor(notices: TaskCompletionNotice | readonly TaskCompletionNotice[], expanded: boolean) {
		this.notices = Array.isArray(notices) ? notices : [notices as TaskCompletionNotice];
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		return this.notices.flatMap((notice, index) => [
			...(index === 0 ? [] : [""]),
			...this.renderNotice(notice, width),
		]);
	}
	private renderNotice(notice: TaskCompletionNotice, width: number): string[] {
		const preview = cleanPreview(notice.preview).trimEnd();
		const agent = isAgentNotice(notice);
		const spec = taskNoticeLineSpec(notice);
		if (!agent) {
			// A shell's line expands to the last lines of its output.
			const tail = preview.split("\n").slice(-20).join("\n");
			return new NoticeLine({ ...spec, ...(tail ? { detail: tail } : {}) }, this.expanded).render(width);
		}
		const [line] = new NoticeLine(spec).render(width);
		if (!preview) return line === undefined ? [] : [line];
		const result = wrapTextWithAnsi(preview, Math.max(1, width - 5));
		const shown = this.expanded ? result : result.slice(0, 1);
		const hint = !this.expanded && result.length > 1 ? keyHintIfBound("app.tools.expand", "for the full result") : "";
		return [
			...(line === undefined ? [] : [line]),
			...shown.map((text, index) =>
				truncateToWidth(theme.fg("muted", `${index === 0 ? "  ⎿  " : "     "}${text}`), width, "…"),
			),
			...(hint ? [truncateToWidth(`     ${theme.fg("dim", "(")}${hint}${theme.fg("dim", ")")}`, width, "…")] : []),
		];
	}
}
