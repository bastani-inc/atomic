import { type Component, Text, truncateToWidth, visibleWidth } from "@bastani/atomic-tui";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import { type ThemeColor, theme } from "../theme/theme.js";
import { TASK_MARKS } from "./task-marks.ts";
import { collapseToolBlockLines, ToolBlock } from "./tool-block.ts";

/**
 * How the subject of a notice ended or stands. A started subject reads as `success`; `waiting` is a subagent released
 * while it waits on a call, which wakes by itself when that call finishes; `heartbeat` marks a periodic check on work
 * that is still running. `agent-running` and `shell-running` mark a subagent and a background shell that keep running,
 * `input` a subagent that waits for an answer, `task-queued` one that waits for its turn to run, `task-stopping` one
 * being stopped, and `task-stopped` a subagent or background task that was stopped, with the marks the agent panel and
 * `/tasks` show them with. `running` is a tool call in progress, and `stopped` one that
 * was interrupted or not run.
 */
export type NoticeStatus =
	| "success"
	| "failure"
	| "stopped"
	| "warning"
	| "paused"
	| "waiting"
	| "running"
	| "agent-running"
	| "shell-running"
	| "input"
	| "task-queued"
	| "task-stopping"
	| "task-stopped"
	| "info"
	| "heartbeat";

/**
 * One notice line: what finished, how it ended, and a few dim facts. Background commands, subagents and stopped
 * tasks all report through it in the main chat and in a subagent's view.
 */
export interface NoticeLineSpec {
	readonly status: NoticeStatus;
	/** What it is: `Background command`, `Agent`, `Task`. */
	readonly label: string;
	/** Its name, quoted after the label; shortened first when the line is too narrow. */
	readonly subject?: string;
	/** How it ended: `completed (exit code 0)`, `finished`, `failed (exit code 1)`, `was stopped by the user`. */
	readonly outcome: string;
	/** Dim facts after the outcome, joined with ` · `: a duration, a stage, a token count. */
	readonly meta?: readonly string[];
	/** What expanding the line (ctrl+o) shows under it, one or more lines. */
	readonly detail?: string;
	/** Columns before the notice, from the outputPad setting; 1 when left out. */
	readonly outputPad?: number;
	/** While collapsed, count the hidden detail lines under the line with the expand key (`… +N lines (ctrl+o to expand)`). */
	readonly countHiddenDetail?: boolean;
}

/**
 * The marker and colour of each status, so a status reads without colour too. A task's states use its marks; `running`
 * is a tool call in progress, which a block draws as the working `∀`, and `stopped` one that was interrupted, which is
 * not an error.
 */
export const STATUS_MARKERS: Readonly<Record<NoticeStatus, { readonly glyph: string; readonly color: ThemeColor }>> = {
	success: TASK_MARKS.done,
	failure: TASK_MARKS.failed,
	stopped: { glyph: "◼", color: "muted" },
	warning: { glyph: "!", color: "warning" },
	paused: TASK_MARKS.paused,
	waiting: TASK_MARKS.waiting,
	running: { glyph: "∀", color: "accent" },
	"agent-running": TASK_MARKS.running,
	"shell-running": TASK_MARKS.shell,
	input: TASK_MARKS.input,
	"task-queued": TASK_MARKS.queued,
	"task-stopping": TASK_MARKS.stopping,
	"task-stopped": TASK_MARKS.stopped,
	info: { glyph: "›", color: "muted" },
	heartbeat: { glyph: "♥", color: "muted" },
};

/** A notice reports a task, so it shows a task's marks: running and stopped as the agent panel shows them. */
function noticeStatus(status: NoticeStatus): NoticeStatus {
	return status === "running" ? "agent-running" : status === "stopped" ? "task-stopped" : status;
}

export const DETAIL_FIRST_PREFIX = "  ⎿  ";
export const DETAIL_PREFIX = "     ";

/** One line of display text: no terminal controls, no line breaks. */
function oneLine(value: string): string {
	return terminalDisplayText(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function quoted(subject: string | undefined): string {
	return subject === undefined || subject === "" ? "" : ` "${subject}"`;
}

function outcomeText(outcome: string): string {
	const text = oneLine(outcome);
	return text === "" ? "" : ` ${text}`;
}

function metaText(meta: readonly string[] | undefined): string {
	const facts = (meta ?? []).map(oneLine).filter(Boolean);
	return facts.length === 0 ? "" : ` · ${facts.join(" · ")}`;
}

/** The notice as plain text, one line, as a screen reader or a log reads it. */
export function noticeLineText(spec: NoticeLineSpec): string {
	const subject = spec.subject === undefined ? undefined : oneLine(spec.subject);
	return `${STATUS_MARKERS[noticeStatus(spec.status)].glyph} ${oneLine(spec.label)}${quoted(subject)}${outcomeText(spec.outcome)}${metaText(spec.meta)}`;
}

/** The subject shortened so the whole line fits `width`, or undefined when even one character of it does not. */
function fittedSubject(spec: NoticeLineSpec, width: number): string | undefined {
	const subject = spec.subject === undefined ? undefined : oneLine(spec.subject);
	if (subject === undefined || subject === "") return subject;
	const full = noticeLineText(spec);
	if (visibleWidth(full) <= width) return subject;
	const room = visibleWidth(subject) - (visibleWidth(full) - width);
	return room >= 2 ? truncateToWidth(subject, room, "…") : undefined;
}

/** A notice in the transcript: exactly one line collapsed; expanded, the line and its detail under it. */
export class NoticeLine implements Component {
	private readonly spec: NoticeLineSpec;
	private expanded: boolean;

	constructor(spec: NoticeLineSpec, expanded = false) {
		this.spec = spec;
		this.expanded = expanded;
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width < 1) return [];
		const pad = Math.max(0, Math.min(Math.floor(this.spec.outputPad ?? 1), Math.floor(width) - 1));
		const subject = fittedSubject(this.spec, Math.max(1, width - pad));
		const title = `${oneLine(this.spec.label)}${quoted(subject)}${outcomeText(this.spec.outcome)}`;
		const detail =
			this.spec.detail === undefined ? "" : terminalDisplayText(this.spec.detail).replaceAll("\t", "    ").trimEnd();
		const safeDetail = detail.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ");
		return new ToolBlock({
			status: noticeStatus(this.spec.status),
			title: new Text(title, 0, 0),
			meta: this.spec.meta?.map(oneLine).filter(Boolean),
			details:
				safeDetail === ""
					? undefined
					: this.expanded
						? new Text(theme.fg("muted", safeDetail), 0, 0)
						: this.spec.countHiddenDetail
							? new Text(collapseToolBlockLines(safeDetail.split("\n"), 0, false).join("\n"), 0, 0)
							: undefined,
			outputPad: this.spec.outputPad,
		}).render(width);
	}
}
