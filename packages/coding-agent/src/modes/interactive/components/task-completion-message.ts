import { stripVTControlCharacters } from "node:util";
import { Box, type Component, truncateToWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import type { TaskCompletionNotice } from "../../../core/tasks/completion.js";
import { theme } from "../theme/theme.js";
import { keyHintIfBound } from "./keybinding-hints.js";
import { taskModelText } from "./task-row.js";

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
	return {
		title: notice.title,
		preview: notice.preview,
		taskId: notice.taskId,
		status: notice.status,
		...("model" in notice && typeof notice.model === "string" ? { model: notice.model } : {}),
		...("thinking" in notice && typeof notice.thinking === "string" ? { thinking: notice.thinking } : {}),
	};
}

/** Same persisted completion message in main and workflow chats; no model reply required. */
export class TaskCompletionMessage implements Component {
	private readonly notice: TaskCompletionNotice;
	private readonly expanded: boolean;
	constructor(notice: TaskCompletionNotice, expanded: boolean) {
		this.notice = notice;
		this.expanded = expanded;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const card = new Box(width >= 3 ? 1 : 0, 1, (line) => theme.bg("customMessageBg", line));
		card.addChild({
			invalidate() {},
			render: (innerWidth) => this.renderContent(innerWidth),
		});
		return card.render(width);
	}
	private renderContent(width: number): string[] {
		const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
		const color =
			this.notice.status === "completed" ? "success" : this.notice.status === "failed" ? "error" : "warning";
		const icon = this.notice.status === "completed" ? "✓" : "✗";
		const preview = wrapTextWithAnsi(clean(this.notice.preview), Math.max(1, width - 2));
		// A subagent's notice shows its result's headline; a shell's shows the last lines it wrote. Expanding shows more.
		const agent = this.notice.model !== undefined || this.notice.thinking !== undefined;
		const limit = this.expanded ? 20 : agent ? 1 : 3;
		const expand =
			!this.expanded && preview.length > limit
				? keyHintIfBound("app.tools.expand", agent ? "for the full result" : "Expand")
				: "";
		return [
			theme.fg(color, theme.bold(`${icon} ${clean(this.notice.title).replace(/\n/g, " ")}`)),
			...(this.notice.model !== undefined || this.notice.thinking !== undefined
				? wrapTextWithAnsi(
						theme.fg(
							"dim",
							taskModelText({ kind: "agent", model: this.notice.model, thinking: this.notice.thinking }),
						),
						Math.max(1, width),
					)
				: []),
			...(this.notice.preview
				? preview.slice(0, limit).map((line, index) => theme.fg("muted", `${index === 0 ? "⎿ " : "  "}${line}`))
				: []),
			theme.fg(
				"dim",
				`${expand ? `(${expand}) · ` : ""}/tasks to inspect${this.expanded ? ` · ${this.notice.taskId}` : ""}`,
			),
		].map((line) => truncateToWidth(line, Math.max(1, width)));
	}
}
