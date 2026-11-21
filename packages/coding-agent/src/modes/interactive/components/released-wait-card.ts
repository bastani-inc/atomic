import { type Component, truncateToWidth } from "@bastani/atomic-tui";
import { completionTitleText, taskNoticeLine } from "../../../core/tasks/completion.js";
import type { TaskRecord } from "../../../core/tasks/contracts.js";
import { theme } from "../theme/theme.js";
import { wrapNotes } from "./note-rows.ts";
import { NoticeLine, type NoticeLineSpec } from "./notice-line.ts";
import { taskNoticeLineSpec } from "./task-completion-message.js";

/**
 * The line the main chat's notice of a subagent's release shows: its name, what it waits on and how long it ran. Undefined
 * for a task that is not a subagent released while it waits.
 */
export function releasedWaitLine(task: TaskRecord): NoticeLineSpec | undefined {
	if (task.kind !== "agent" || task.execution.kind !== "settled") return undefined;
	const line = taskNoticeLine({ result: task.execution.result, taskKind: task.kind }, task);
	if (line.status !== "waiting") return undefined;
	return taskNoticeLineSpec({
		title: `Subagent ${completionTitleText(task.agentName ?? "agent")}`,
		preview: "",
		status: "cancelled",
		taskId: task.ref.taskId,
		taskKind: "agent",
		...(task.agentName === undefined ? {} : { agentName: task.agentName }),
		line,
	});
}

/** Where the main chat's notice of a subagent shows the subagent's result under its line. */
const DETAIL_CONNECTOR = "   ⎿  ";
const DETAIL_INDENT = "      ";

/** Muted, or as it is without colour: its key hints stay clickable either way. */
function muted(text: string): string {
	return process.env.NO_COLOR === undefined ? theme.fg("muted", text) : text;
}

/**
 * A subagent released while it waits, after the transcript of its own chat: the main chat's notice line of that release,
 * then what wakes it and where its shells are, where the main chat's notice shows the subagent's result. Everything it
 * says is shown, so it has nothing to expand.
 */
export class ReleasedWaitCard implements Component {
	private readonly line: NoticeLineSpec;
	/** Unstyled ` · `-separated parts, which may hold clickable key hints; a part stays whole on a row where it fits. */
	private readonly detail: string;

	constructor(line: NoticeLineSpec, detail: string) {
		this.line = line;
		this.detail = detail;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1) return [];
		const [line] = new NoticeLine(this.line).render(width);
		// The detail scrolls with the transcript, so all of it is shown; too narrow for the connector, it goes without.
		const indent = width > DETAIL_INDENT.length ? DETAIL_INDENT.length : 0;
		const rows = wrapNotes(this.detail, width - indent, Number.POSITIVE_INFINITY);
		return [
			...(line === undefined ? [] : [line]),
			...rows.map((row, index) => {
				const prefix = indent === 0 ? "" : index === 0 ? DETAIL_CONNECTOR : DETAIL_INDENT;
				return truncateToWidth(muted(`${prefix}${row}`), width, "…");
			}),
		];
	}
}
