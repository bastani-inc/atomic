import { writeSync } from "node:fs";
import { visibleWidth } from "@bastani/atomic-tui";
import { APP_NAME } from "../config.js";
import { colorEnvironment } from "../modes/interactive/theme/color-utils.ts";

/** The product name as the interface writes it, as the startup header does. */
const PRODUCT_NAME = APP_NAME.length > 0 ? `${APP_NAME[0]!.toUpperCase()}${APP_NAME.slice(1)}` : "Atomic";

/** The line an interactive start shows until its first screen is drawn (#5546). */
const STARTUP_STATUS_TEXT = `Starting ${PRODUCT_NAME}…`;

type Write = (chunk: string | Uint8Array, ...rest: never[]) => unknown;

/** The terminal stream the status line is drawn on. */
export interface StartupStatusOutput {
	readonly isTTY?: boolean;
	readonly columns?: number;
	readonly fd?: number;
	write: Write;
	cork?(): void;
	uncork?(): void;
	on?(event: "resize", listener: () => void): unknown;
	off?(event: "resize", listener: () => void): unknown;
}

/** Console methods that write; some runtimes write them to the terminal directly, not through the streams. */
const CONSOLE_WRITERS = [
	"log",
	"info",
	"debug",
	"warn",
	"error",
	"trace",
	"dir",
	"dirxml",
	"table",
	"assert",
	"count",
	"timeLog",
	"timeEnd",
	"group",
	"groupCollapsed",
] as const;

/** Whatever else writes to the terminal the status line is on; the line steps aside for what they write. */
export interface StartupStatusNeighbors {
	/** Other streams, such as stderr; only those on a terminal are watched. */
	readonly streams: readonly { readonly isTTY?: boolean; write: Write }[];
	readonly console: Partial<Record<(typeof CONSOLE_WRITERS)[number], (...args: unknown[]) => unknown>>;
}

const SAVE_CURSOR = "\x1b7";
const RESTORE_CURSOR = "\x1b8";
const ERASE_ROW = "\x1b[2K";
const NEXT_ROW = "\x1b[1B";
const DIM = "\x1b[2m";
const NORMAL_INTENSITY = "\x1b[22m";
/**
 * Sequences that neither draw nor move the cursor: string sequences (OSC, DCS, APC, PM, SOS), CSI with private
 * parameters (modes, keyboard protocols, synchronized output), colors and terminal queries.
 */
const INERT_SEQUENCE = /\x1b(?:[\]P_^X][^\x07\x1b]*(?:\x07|\x1b\\)|\[[<=>?][0-?]*[ -/]*[@-~]|\[[0-9;:]*[ -/]*[mnctq])/g;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** `text` cut to `width` columns, ending in "…" when it was cut. */
function fitToWidth(text: string, width: number): string {
	if (visibleWidth(text) <= width) return text;
	if (width <= 0) return "";
	let fitted = "";
	let used = 0;
	for (const { segment } of graphemes.segment(text)) {
		const segmentWidth = visibleWidth(segment);
		if (used + segmentWidth > width - 1) break;
		fitted += segment;
		used += segmentWidth;
	}
	return `${fitted}…`;
}

/**
 * Back to the first column, then erase the row the cursor is on and the rows below it that a terminal narrower than
 * `drawnWidth` wrapped the line onto; the cursor stays at the start of the line's first row. The rows are erased one by
 * one: erasing to the end of the screen from its top-left cell clears the whole screen, which some terminals (tmux)
 * first scroll into their history, where the line would stay.
 */
function eraseSequence(drawnWidth: number, columns: number | undefined): string {
	const rows = Math.max(1, Math.ceil(drawnWidth / Math.max(1, columns ?? 80)));
	return `\r${SAVE_CURSOR}${ERASE_ROW}${`${NEXT_ROW}${ERASE_ROW}`.repeat(rows - 1)}${RESTORE_CURSOR}`;
}

/** Whether a write draws or moves the cursor, rather than only switching modes or asking the terminal something. */
function changesScreen(chunk: string | Uint8Array | undefined): boolean {
	if (typeof chunk !== "string") return true;
	return chunk.replace(INERT_SEQUENCE, "").length > 0;
}

/** Whether a write leaves the cursor at the start of a new row. A console call always ends its line. */
function endsLine(chunk: string | Uint8Array | undefined): boolean {
	if (chunk === undefined) return true;
	return typeof chunk === "string" ? chunk.endsWith("\n") : chunk[chunk.length - 1] === 0x0a;
}

function isEmpty(chunk: string | Uint8Array | undefined): boolean {
	return chunk !== undefined && chunk.length === 0;
}

interface ShownStatus {
	readonly output: StartupStatusOutput;
	/** Startup dialogs that took the terminal; the line comes back when the last one closes. */
	suspended: number;
	/** The line owns the row the cursor is at the start of; it shows nothing there when the terminal is too narrow. */
	drawn: boolean;
	/** Columns the text took when it was drawn, which a narrower terminal wraps onto more rows. */
	drawnWidth: number;
	/** Undoes the watch on the terminal's other writers and on its size. */
	unwatch: () => void;
	/** The output's own write, which the watch does not see. */
	write: (text: string) => void;
}

let shown: ShownStatus | undefined;
/** A watched write is running; what it writes in turn (Node's console writes to the streams) is part of it. */
let insideWatchedWrite = false;

function draw(status: ShownStatus): void {
	const columns = status.output.columns;
	// The last column is left free: a character written there wraps the cursor on some terminals.
	const text = fitToWidth(STARTUP_STATUS_TEXT, Math.max(0, (columns && columns > 0 ? columns : 80) - 1));
	const clear = eraseSequence(status.drawn ? status.drawnWidth : 0, columns);
	const styled = text.length === 0 || colorEnvironment().off ? text : `${DIM}${text}${NORMAL_INTENSITY}`;
	// The cursor goes back to the start of the line, so whatever is written next starts on a row the line no longer
	// shares, and a terminal that rewraps the line on resize keeps the cursor on its first row.
	status.write(text.length > 0 ? `${clear}${styled}\r` : clear);
	status.drawn = true;
	status.drawnWidth = visibleWidth(text);
}

function erase(status: ShownStatus): string {
	status.drawn = false;
	return eraseSequence(status.drawnWidth, status.output.columns);
}

/**
 * Around a write by anyone else: the line is erased right before a write that draws, so the two never share a row,
 * and drawn again on the next row once the write ended its line. While a startup dialog has the terminal, the line is
 * erased right before the dialog's first frame, so there is no blank screen between them (#5546).
 */
function aroundWrite<R>(status: ShownStatus, chunk: string | Uint8Array | undefined, forward: () => R): R {
	if (insideWatchedWrite || shown !== status || isEmpty(chunk)) return forward();
	insideWatchedWrite = true;
	try {
		if (status.drawn && changesScreen(chunk)) status.write(erase(status));
		const result = forward();
		if (status.suspended === 0 && !status.drawn && endsLine(chunk)) draw(status);
		return result;
	} finally {
		insideWatchedWrite = false;
	}
}

function watch(status: ShownStatus, neighbors: StartupStatusNeighbors): () => void {
	const undo: Array<() => void> = [];
	const replace = <T extends object>(target: T, key: keyof T, replacement: unknown) => {
		const original = target[key];
		(target as Record<keyof T, unknown>)[key] = replacement;
		undo.push(() => {
			// Something that wrapped the method after the status line keeps its wrapper; this one then only forwards.
			if (target[key] === replacement) (target as Record<keyof T, unknown>)[key] = original;
		});
	};
	for (const stream of [status.output, ...neighbors.streams.filter((stream) => stream.isTTY === true)]) {
		const original = stream.write;
		replace(stream, "write", function (this: unknown, chunk: string | Uint8Array, ...rest: never[]) {
			return aroundWrite(status, chunk, () => original.call(this, chunk, ...rest));
		});
	}
	for (const name of CONSOLE_WRITERS) {
		const original = neighbors.console[name];
		if (typeof original !== "function") continue;
		replace(neighbors.console, name, function (this: unknown, ...args: unknown[]) {
			return aroundWrite(status, undefined, () => original.apply(this, args));
		});
	}
	// A narrower terminal wraps the line onto more rows; it is drawn again to fit one row.
	const onResize = () => {
		if (shown === status && status.drawn && !insideWatchedWrite) draw(status);
	};
	status.output.on?.("resize", onResize);
	undo.push(() => status.output.off?.("resize", onResize));
	return () => {
		for (const step of undo.reverse()) step();
	};
}

function eraseOnExit(): void {
	const status = shown;
	if (!status?.drawn) return;
	const sequence = erase(status);
	try {
		if (status.output.fd !== undefined) writeSync(status.output.fd, sequence);
		else status.write(sequence);
	} catch {
		// The terminal is gone; there is nothing left to tidy.
	}
}

/** Stop showing the status line; whether it is still on the screen is up to the caller. */
function release(status: ShownStatus): void {
	shown = undefined;
	process.removeListener("exit", eraseOnExit);
	status.unwatch();
}

function defaultNeighbors(): StartupStatusNeighbors {
	return {
		streams: [process.stderr as unknown as StartupStatusNeighbors["streams"][number]],
		console: console as unknown as StartupStatusNeighbors["console"],
	};
}

/**
 * Show a one-line status while startup work runs before anything else is drawn, so the terminal is never blank.
 * The line stays until {@link replaceStartupStatus} or {@link clearStartupStatus}; a startup dialog takes its place while
 * it is open ({@link suspendStartupStatus}). Anything else written to the terminal meanwhile, by `output`, the
 * `neighbors` streams or the console, gets rows of its own above the line. Nothing is drawn when the output is not a
 * terminal.
 */
export function showStartupStatus(
	output: StartupStatusOutput = process.stdout as unknown as StartupStatusOutput,
	neighbors: StartupStatusNeighbors = defaultNeighbors(),
): void {
	if (shown !== undefined || output.isTTY !== true) return;
	const ownWrite = output.write;
	const status: ShownStatus = {
		output,
		suspended: 0,
		drawn: false,
		drawnWidth: 0,
		unwatch: () => {},
		write: (text) => {
			try {
				ownWrite.call(output, text);
			} catch {
				// A status line is a courtesy: a terminal that cannot be written to never stops startup.
			}
		},
	};
	status.unwatch = watch(status, neighbors);
	shown = status;
	process.once("exit", eraseOnExit);
	draw(status);
}

/** Erase the status line for good: startup failed or ends, and what follows is written on its own. */
export function clearStartupStatus(): void {
	const status = shown;
	if (status === undefined) return;
	release(status);
	if (status.drawn) status.write(erase(status));
}

/**
 * Hand the terminal from the status line to the first screen: `start` takes the terminal and `paint` draws the first
 * frame at once, in the same write that erases the line, so the screen is never blank between them (#5546). Without
 * a status line on the screen, only `start` runs and the screen paints when it is ready.
 */
export function replaceStartupStatus(start: () => void, paint: () => void): void {
	const status = shown;
	if (status !== undefined) release(status);
	if (!status?.drawn) {
		start();
		return;
	}
	status.output.cork?.();
	try {
		status.write(erase(status));
		start();
		paint();
	} finally {
		status.output.uncork?.();
	}
}

/** A startup dialog takes the terminal; the status line stays until the dialog draws its first text. */
export function suspendStartupStatus(): void {
	const status = shown;
	if (status !== undefined) status.suspended++;
}

/** Show the status line again once the startup dialog that hid it closed, unless startup cleared it meanwhile. */
export function resumeStartupStatus(): void {
	const status = shown;
	if (status === undefined || status.suspended === 0) return;
	status.suspended--;
	// A dialog leaves the cursor at the start of the rows it used, which it cleared.
	if (status.suspended === 0 && !status.drawn) draw(status);
}

/**
 * Start a child process that writes to the terminal itself, such as a package install: the status line is erased
 * before `spawn` runs, so the child's output never shares its row, and comes back below that output once the child
 * exited (#5546).
 */
export function startupStatusAsideFor<T extends { once(event: "exit" | "error", listener: () => void): unknown }>(
	spawn: () => T,
): T {
	const status = shown;
	if (status === undefined) return spawn();
	if (status.drawn) status.write(erase(status));
	status.suspended++;
	let child: T;
	try {
		child = spawn();
	} catch (error) {
		resumeStartupStatus();
		throw error;
	}
	let exited = false;
	const resume = () => {
		if (exited) return;
		exited = true;
		resumeStartupStatus();
	};
	child.once("exit", resume);
	child.once("error", resume);
	return child;
}
