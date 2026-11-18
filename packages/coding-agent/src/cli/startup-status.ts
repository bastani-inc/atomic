import { writeSync } from "node:fs";
import { APP_NAME } from "../config.js";
import { colorEnvironment } from "../modes/interactive/theme/color-utils.ts";

/** The line an interactive start shows until its first screen is drawn (#5546). */
const STARTUP_STATUS_TEXT = `Starting ${APP_NAME}…`;

/** The terminal stream the status line is drawn on. */
export interface StartupStatusOutput {
	readonly isTTY?: boolean;
	readonly columns?: number;
	readonly fd?: number;
	write(text: string): unknown;
}

const ERASE_LINE = "\r\x1b[2K";
const DIM = "\x1b[2m";
const NORMAL_INTENSITY = "\x1b[22m";

/**
 * `text` as the status line draws it: cut to fit one row of `columns` without wrapping, dim unless color is off
 * (NO_COLOR, FORCE_COLOR=0). Empty when the terminal is too narrow to show anything.
 */
function formatStartupStatus(text: string, columns: number | undefined, colorOff: boolean): string {
	// The last column is left free: a character written there wraps the cursor on some terminals.
	const width = Math.max(0, (columns && columns > 0 ? columns : 80) - 1);
	const characters = Array.from(text);
	if (width === 0) return "";
	const fitted = characters.length <= width ? text : `${characters.slice(0, width - 1).join("")}…`;
	return colorOff ? fitted : `${DIM}${fitted}${NORMAL_INTENSITY}`;
}

interface ShownStatus {
	readonly output: StartupStatusOutput;
	readonly line: string;
	/** Startup dialogs that took the terminal; the line comes back when the last one closes. */
	suspended: number;
	drawn: boolean;
}

let shown: ShownStatus | undefined;

function eraseOnExit(): void {
	const status = shown;
	if (!status?.drawn) return;
	status.drawn = false;
	try {
		if (status.output.fd !== undefined) writeSync(status.output.fd, ERASE_LINE);
		else status.output.write(ERASE_LINE);
	} catch {
		// The terminal is gone; there is nothing left to tidy.
	}
}

function write(status: ShownStatus, text: string): void {
	try {
		status.output.write(text);
	} catch {
		// A status line is a courtesy: a terminal that cannot be written to never stops startup.
	}
}

/**
 * Show a one-line status while startup work runs before anything else is drawn, so the terminal is never blank.
 * The line stays until {@link clearStartupStatus}; a startup dialog hides it while it is open
 * ({@link suspendStartupStatus}). Nothing is drawn when the output is not a terminal.
 */
export function showStartupStatus(output: StartupStatusOutput = process.stdout): void {
	if (shown !== undefined || output.isTTY !== true) return;
	const line = formatStartupStatus(STARTUP_STATUS_TEXT, output.columns, colorEnvironment().off);
	if (line.length === 0) return;
	shown = { output, line, suspended: 0, drawn: false };
	process.once("exit", eraseOnExit);
	write(shown, `\r${line}\x1b[K`);
	shown.drawn = true;
}

/** Erase the status line for good; the first screen or a startup error takes its place. */
export function clearStartupStatus(): void {
	const status = shown;
	if (status === undefined) return;
	shown = undefined;
	process.removeListener("exit", eraseOnExit);
	if (status.drawn) write(status, ERASE_LINE);
}

/** Hide the status line while a startup dialog uses the terminal. */
export function suspendStartupStatus(): void {
	const status = shown;
	if (status === undefined) return;
	status.suspended++;
	if (!status.drawn) return;
	status.drawn = false;
	write(status, ERASE_LINE);
}

/** Show the status line again once the startup dialog that hid it closed, unless startup cleared it meanwhile. */
export function resumeStartupStatus(): void {
	const status = shown;
	if (status === undefined || status.suspended === 0) return;
	status.suspended--;
	if (status.suspended > 0 || status.drawn) return;
	write(status, `\r${status.line}\x1b[K`);
	status.drawn = true;
}
