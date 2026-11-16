import { stripVTControlCharacters } from "node:util";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import { type ThemeColor, theme } from "../theme/theme.js";

/** How the subject of a notice ended or stands. A started subject reads as `success`. */
export type NoticeStatus = "success" | "failure" | "stopped" | "warning" | "paused";

/**
 * One notice line: what finished, how it ended, and a few dim facts. Background commands, subagents, workflow runs
 * and stopped tasks all report through it, in the main chat, a workflow stage's chat and a subagent's view alike.
 */
export interface NoticeLineSpec {
	readonly status: NoticeStatus;
	/** What it is: `Background command`, `Agent`, `Workflow`, `Task`. */
	readonly label: string;
	/** Its name, quoted after the label; shortened first when the line is too narrow. */
	readonly subject?: string;
	/** How it ended: `completed (exit code 0)`, `finished`, `failed (exit code 1)`, `was stopped by the user`. */
	readonly outcome: string;
	/** Dim facts after the outcome, joined with ` · `: a duration, a stage, a token count. */
	readonly meta?: readonly string[];
	/** What expanding the line (ctrl+o) shows under it, one or more lines. */
	readonly detail?: string;
}

/** The marker and colour of each status, so a status reads without colour too. */
const STATUS_MARKERS: Readonly<Record<NoticeStatus, { readonly glyph: string; readonly color: ThemeColor }>> = {
	success: { glyph: "●", color: "success" },
	failure: { glyph: "✗", color: "error" },
	stopped: { glyph: "◼", color: "muted" },
	warning: { glyph: "!", color: "warning" },
	paused: { glyph: "⏸", color: "muted" },
};

const DETAIL_FIRST_PREFIX = "  ⎿  ";
const DETAIL_PREFIX = "     ";

/** One line of display text: no terminal controls, no line breaks. */
function oneLine(value: string): string {
	return stripVTControlCharacters(value)
		.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
		.replace(/ {2,}/g, " ")
		.trim();
}

function quoted(subject: string | undefined): string {
	return subject === undefined || subject === "" ? "" : ` "${subject}"`;
}

function metaText(meta: readonly string[] | undefined): string {
	const facts = (meta ?? []).map(oneLine).filter(Boolean);
	return facts.length === 0 ? "" : ` · ${facts.join(" · ")}`;
}

/** The notice as plain text, one line, as a screen reader or a log reads it. */
export function noticeLineText(spec: NoticeLineSpec): string {
	const subject = spec.subject === undefined ? undefined : oneLine(spec.subject);
	return `${STATUS_MARKERS[spec.status].glyph} ${oneLine(spec.label)}${quoted(subject)} ${oneLine(spec.outcome)}${metaText(spec.meta)}`;
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
		const marker = STATUS_MARKERS[this.spec.status];
		const subject = fittedSubject(this.spec, width);
		const head = `${marker.glyph} ${oneLine(this.spec.label)}${quoted(subject)} ${oneLine(this.spec.outcome)}`;
		const meta = metaText(this.spec.meta);
		const line = `${theme.fg(marker.color, marker.glyph)}${head.slice(marker.glyph.length)}${meta ? theme.fg("dim", meta) : ""}`;
		const lines = [truncateToWidth(line, width, "…")];
		const detail = this.spec.detail === undefined ? "" : stripVTControlCharacters(this.spec.detail).trimEnd();
		if (!this.expanded || detail === "") return lines;
		const detailWidth = Math.max(1, width - DETAIL_PREFIX.length);
		const wrapped = detail
			.split("\n")
			.flatMap((text) =>
				wrapTextWithAnsi(text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").trimEnd(), detailWidth),
			);
		for (const [index, text] of wrapped.entries()) {
			const prefix = index === 0 ? DETAIL_FIRST_PREFIX : DETAIL_PREFIX;
			lines.push(truncateToWidth(theme.fg("muted", `${prefix}${text}`), width, "…"));
		}
		return lines;
	}
}
