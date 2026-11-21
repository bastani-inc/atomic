import { visibleWidth, wrapTextWithAnsi } from "@bastani/atomic-tui";

/** The most rows a transcript's notes take, so the transcript itself keeps its room. */
const MAX_NOTE_ROWS = 6;

/**
 * A transcript's notes on as many rows as they need, up to `maxRows` ({@link MAX_NOTE_ROWS} unless given): each ` · `
 * part stays whole on a row where it fits, so what a released subagent waits on, that it wakes by itself, and where
 * its shell is all stay readable at narrow widths.
 */
export function wrapNotes(notes: string, width: number, maxRows = MAX_NOTE_ROWS): string[] {
	if (!notes) return [];
	const room = Math.max(1, width);
	if (visibleWidth(notes) <= room) return [notes];
	const rows: string[] = [];
	let row = "";
	for (const part of notes.split(" · ")) {
		const joined = row ? `${row} · ${part}` : part;
		if (visibleWidth(joined) <= room) {
			row = joined;
			continue;
		}
		if (row) rows.push(row);
		const wrapped = wrapTextWithAnsi(part, room);
		row = wrapped.pop() ?? "";
		rows.push(...wrapped);
	}
	if (row) rows.push(row);
	return rows.slice(0, maxRows);
}
