import { type Component, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";
import { theme } from "../theme/theme.js";
import { keyHintIfBound } from "./keybinding-hints.js";
import { slashCommandHint } from "./nav-keys.ts";
import { ToolBlock, ToolBlockRecords } from "./tool-block.ts";

/** One row of a heartbeat record: shortened to the width, or wrapped onto further rows when `wrap` is set. */
export type HeartbeatRow = string | { readonly text: string; readonly wrap: true };

/** A heartbeat in the transcript: what is still running, the rows under it, and where to inspect it. */
export interface HeartbeatBlockSpec {
	/** For example, `Task heartbeat`. */
	readonly title: string;
	/** What is still running, after the title as ` · <subject>`; shortened with `…` only once every fact is dropped. */
	readonly subject?: string;
	/** Dim facts after the title, joined with ` · `: what is still running and for how long. */
	readonly meta?: readonly string[];
	/** Each record is its connector row and its continuation rows, already styled. */
	readonly records: readonly (readonly HeartbeatRow[])[];
	/** Where to inspect it, such as `/tasks to inspect`; shown dim under the last record. */
	readonly hint: string;
	/** Whether expanding it (ctrl+o) shows more, so the hint names the key while it is collapsed. */
	readonly expandable: boolean;
	readonly expanded: boolean;
	readonly outputPad?: number;
}

class HeartbeatRecord implements Component {
	private readonly rows: readonly HeartbeatRow[];
	constructor(rows: readonly HeartbeatRow[]) {
		this.rows = rows;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.rows.flatMap((row) =>
			typeof row === "string" ? [truncateToWidth(row, width, "…")] : wrapTextWithAnsi(row.text, Math.max(1, width)),
		);
	}
}

/**
 * A heartbeat notice: the shared notice anatomy, with `♥` as its mark. One header row, a `⎿` connector row per record
 * with its continuation rows, and the inspect hint as the last continuation row.
 */
export class HeartbeatBlock implements Component {
	private readonly spec: HeartbeatBlockSpec;
	constructor(spec: HeartbeatBlockSpec) {
		this.spec = spec;
	}
	invalidate(): void {}
	render(width: number): string[] {
		const expand = this.spec.expandable && !this.spec.expanded ? keyHintIfBound("app.tools.expand", "to expand") : "";
		const inspect = this.spec.hint === undefined ? "" : slashCommandHint(this.spec.hint);
		const hint = theme.fg("dim", [inspect, expand].filter(Boolean).join(" · "));
		const records = this.spec.records.length === 0 ? [[hint]] : this.spec.records.map((rows) => [...rows]);
		if (this.spec.records.length > 0) records[records.length - 1]?.push(hint);
		// The title and subject stay whole while they can: facts are dropped from the right first, as a notice's are,
		// and only then is the subject shortened.
		const pad = Math.max(0, Math.min(Math.floor(this.spec.outputPad ?? 1), Math.floor(width) - 1));
		const subject = this.spec.subject;
		const subjectWidth = subject === undefined ? 0 : 3 + visibleWidth(subject);
		const room = Math.floor(width) - pad - 2 - visibleWidth(this.spec.title);
		const meta = [...(this.spec.meta ?? [])];
		while (meta.length > 0 && subjectWidth + meta.reduce((sum, part) => sum + 3 + visibleWidth(part), 0) > room)
			meta.pop();
		const shown = subject === undefined ? "" : room - 3 >= 2 ? ` · ${truncateToWidth(subject, room - 3, "…")}` : "";
		return new ToolBlock({
			status: "heartbeat",
			title: new Text(`${this.spec.title}${shown}`, 0, 0),
			meta,
			details: new ToolBlockRecords(records.map((rows) => new HeartbeatRecord(rows))),
			outputPad: this.spec.outputPad,
		}).render(width);
	}
}
