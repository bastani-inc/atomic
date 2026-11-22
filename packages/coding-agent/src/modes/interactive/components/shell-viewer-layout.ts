/**
 * Pure geometry and state helpers for the `/tasks` shell viewer.
 *
 * Every visual band of the shell viewer — title, subtitle, metadata, section heading,
 * rounded output box, retention/scroll note, warning/stop notice, hint line and `?`
 * help overlay — shares one left gutter so content aligns cleanly from 24 columns up.
 */

export const SHELL_VIEWER_MIN_FRAMED_WIDTH = 24;
export const SHELL_VIEWER_GUTTER = 2;

export type ShellOutputLoadState = "loading" | "empty" | "output" | "error";

export interface ShellViewerBoxGeometry {
	readonly gutter: number;
	readonly lead: string;
	readonly contentWidth: number;
	readonly framed: boolean;
	readonly boxWidth: number;
	readonly innerWidth: number;
}

export interface ShellScrollWindow {
	readonly firstRow: number;
	readonly rows: number;
	readonly totalRows: number;
}

export interface ShellScrollRange {
	readonly firstLine: number;
	readonly lastLine: number;
	readonly totalLines: number;
	readonly overflowing: boolean;
}

export type ShellStopConfirmStep = "ignore" | "arm" | "confirm" | "acknowledge";

export function shellViewerGutter(width: number): number {
	return width >= SHELL_VIEWER_MIN_FRAMED_WIDTH ? SHELL_VIEWER_GUTTER : 0;
}

export function shellViewerBoxGeometry(width: number): ShellViewerBoxGeometry {
	const safeWidth = Math.max(1, Math.floor(width));
	const gutter = shellViewerGutter(safeWidth);
	const lead = " ".repeat(gutter);
	const framed = safeWidth >= SHELL_VIEWER_MIN_FRAMED_WIDTH;
	const boxWidth = framed ? safeWidth - gutter * 2 : safeWidth;
	const contentWidth = boxWidth;
	const innerWidth = framed ? Math.max(1, boxWidth - 4) : contentWidth;
	return { gutter, lead, contentWidth, framed, boxWidth, innerWidth };
}

export function shellBoxOuterHeight(contentRows: number, maxRoom: number): number {
	const safeRoom = Math.max(0, Math.floor(maxRoom));
	if (safeRoom < 3) return safeRoom;
	const maxInner = safeRoom - 2;
	const needed = Math.max(1, Math.floor(contentRows));
	return Math.min(needed, maxInner) + 2;
}

export function shellScrollRange(window: ShellScrollWindow | undefined): ShellScrollRange | undefined {
	if (window === undefined || window.totalRows <= 0 || window.rows <= 0) return undefined;
	const first = Math.max(0, Math.min(window.firstRow, window.totalRows - 1));
	const last = Math.min(window.totalRows, first + window.rows);
	const overflowing = window.totalRows > window.rows;
	return {
		firstLine: first + 1,
		lastLine: Math.max(first + 1, last),
		totalLines: window.totalRows,
		overflowing,
	};
}

export function formatShellViewerNote(baseNote: string, range: ShellScrollRange | undefined): string {
	const parts: string[] = [];
	if (baseNote) parts.push(baseNote);
	if (range?.overflowing) parts.push(`lines ${range.firstLine}–${range.lastLine} of ${range.totalLines}`);
	return parts.join(" · ");
}

export function stepShellStopConfirm(
	isRunning: boolean,
	wasArmed: boolean,
	hadFinishedNotice = false,
): ShellStopConfirmStep {
	if (!isRunning) return hadFinishedNotice ? "acknowledge" : "ignore";
	return wasArmed ? "confirm" : "arm";
}
