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
	readonly rows?: number;
	readonly fd?: number;
	write: Write;
	/** Node's and Bun's terminal streams read their size from the terminal again, at once, and report a change. */
	_refreshSize?(): void;
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

/** Whatever else writes to the terminal the status line is on. */
export interface StartupStatusNeighbors {
	/** Other streams, such as stderr; only those on a terminal are watched. */
	readonly streams: readonly { readonly isTTY?: boolean; write: Write }[];
	readonly console: Partial<Record<(typeof CONSOLE_WRITERS)[number], (...args: unknown[]) => unknown>>;
}

const DIM = "\x1b[2m";
const NORMAL_INTENSITY = "\x1b[22m";
/** Starts every frame of Atomic's renderer. */
const BEGIN_SYNCHRONIZED_OUTPUT = "\x1b[?2026h";
/** From the start of the row below the line: up to the line's row, and erase that row. */
const ERASE_LINE = "\r\x1b[1A\x1b[2K";
/**
 * Sequences that neither draw nor move the cursor: string sequences (OSC, DCS, APC, PM, SOS), CSI with private
 * parameters (modes, keyboard protocols, synchronized output), colors and terminal queries. Only used to tell what a
 * startup dialog writes before its first frame from what others write meanwhile.
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

function bytesOf(chunk: string | Uint8Array, encoding?: BufferEncoding): Buffer {
	return typeof chunk === "string"
		? Buffer.from(chunk, encoding)
		: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
}

function textOf(chunk: string | Uint8Array, encoding?: BufferEncoding): string {
	return typeof chunk === "string" && (encoding === undefined || /^utf-?8$/i.test(encoding))
		? chunk
		: bytesOf(chunk, encoding).toString();
}

/** Whether a write draws or moves the cursor, rather than only switching modes or asking the terminal something. */
function draws(text: string): boolean {
	return text.replace(INERT_SEQUENCE, "").length > 0;
}

interface ShownStatus {
	readonly output: StartupStatusOutput;
	/**
	 * The line is on the row right above the cursor and nothing else has written to the terminal since Atomic drew it,
	 * so erasing that row erases nothing but the line. Anything else on the terminal ends this: the line then stays as
	 * it is, a finished line of its own that nothing is written over.
	 */
	owned: boolean;
	/**
	 * Something Atomic cannot watch may write to the terminal: a child process that inherits it, or extension code in
	 * this process. Atomic then neither erases the line nor draws it again.
	 */
	shared: boolean;
	/** Startup dialogs that have the terminal. */
	dialogs: number;
	/** The open dialog's first frame took the line's place, so the line comes back when the dialog clears its rows. */
	replaced: boolean;
	/** Another stream or the console wrote since the dialog's first frame took the line's place. */
	othersWrote: boolean;
	/** The terminal's size when the line was drawn; a terminal that changed size may have rewrapped the line. */
	size: string;
	/** Undoes the watch on the terminal's other writers and on its size. */
	unwatch: () => void;
	/** The output's own write, which the watch does not see. */
	write: (data: string | Uint8Array, done?: () => void) => void;
}

let shown: ShownStatus | undefined;

/** The terminal's size as it is now, not as the stream last heard of it. */
function sizeOf(output: StartupStatusOutput): string {
	try {
		output._refreshSize?.();
	} catch {
		// The size the stream last heard of is all there is.
	}
	return `${output.columns}x${output.rows}`;
}

/** Whether erasing the row above the cursor erases the line and nothing else. */
function erasable(status: ShownStatus): boolean {
	return status.owned && sizeOf(status.output) === status.size;
}

/**
 * The line as a finished row of its own, starting at the cursor once `before` moved it: whatever anyone writes next,
 * even where Atomic cannot see it, starts on the row below. Empty when the terminal is too narrow for any of it.
 */
function lineFor(status: ShownStatus, before: string): string {
	status.size = sizeOf(status.output);
	const columns = status.output.columns;
	// The last column is left free: a character written there wraps the cursor on some terminals.
	const text = fitToWidth(STARTUP_STATUS_TEXT, Math.max(0, (columns && columns > 0 ? columns : 80) - 1));
	status.owned = text.length > 0 && !status.shared;
	if (text.length === 0) return "";
	return `${before}${colorEnvironment().off ? text : `${DIM}${text}${NORMAL_INTENSITY}`}\r\n`;
}

function othersWrote(status: ShownStatus): void {
	status.owned = false;
	if (status.replaced) status.othersWrote = true;
}

/**
 * Before a write to a terminal stream. While a startup dialog has the terminal, what it writes to the output before its
 * first frame only switches modes and asks the terminal things, and leaves the line alone; Atomic's renderer starts
 * each frame with a synchronized update, and the first one erases the line inside it, so the screen is never without
 * both (#5546). Anything else written means the line is no longer Atomic's alone: it stays as it is.
 */
function beforeWrite(
	status: ShownStatus,
	toOutput: boolean,
	chunk: string | Uint8Array,
	rest: never[],
): [string | Uint8Array, never[]] {
	if (toOutput && status.dialogs > 0) {
		if (status.replaced) return [chunk, rest];
		const encoding = typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : undefined;
		const text = textOf(chunk, encoding);
		if (!draws(text)) return [chunk, rest];
		if (text.startsWith(BEGIN_SYNCHRONIZED_OUTPUT)) {
			if (!erasable(status)) {
				status.owned = false;
				return [chunk, rest];
			}
			status.owned = false;
			status.replaced = true;
			status.othersWrote = false;
			const frame = `${BEGIN_SYNCHRONIZED_OUTPUT}${ERASE_LINE}${text.slice(BEGIN_SYNCHRONIZED_OUTPUT.length)}`;
			return [frame, (encoding === undefined ? rest : rest.slice(1)) as never[]];
		}
	}
	othersWrote(status);
	return [chunk, rest];
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
			if (shown !== status || chunk === undefined || chunk.length === 0) return original.call(this, chunk, ...rest);
			const [data, remaining] = beforeWrite(status, stream === status.output, chunk, rest);
			return original.call(this, data, ...remaining);
		});
	}
	for (const name of CONSOLE_WRITERS) {
		const original = neighbors.console[name];
		if (typeof original !== "function") continue;
		// What a console call writes is unknown: some runtimes write it past the streams, and some calls write nothing.
		replace(neighbors.console, name, function (this: unknown, ...args: unknown[]) {
			if (shown === status) othersWrote(status);
			return original.apply(this, args);
		});
	}
	// A terminal that changed size may have rewrapped the line over more rows, and moved some into its history.
	const onResize = () => {
		if (shown === status && `${status.output.columns}x${status.output.rows}` !== status.size) status.owned = false;
	};
	status.output.on?.("resize", onResize);
	undo.push(() => status.output.off?.("resize", onResize));
	return () => {
		for (const step of undo.reverse()) step();
	};
}

/** Run `render`, and send everything it writes to the output, after `before` and before `after`, in one write. */
function inOneWrite(status: ShownStatus, before: string, render: () => void, after: () => string): void {
	const output = status.output;
	const chunks: Buffer[] = [Buffer.from(before)];
	const done: Array<() => void> = [];
	const forward = output.write;
	const collect = (chunk: string | Uint8Array, ...rest: unknown[]) => {
		chunks.push(bytesOf(chunk, typeof rest[0] === "string" ? (rest[0] as BufferEncoding) : undefined));
		const callback = rest.find((argument) => typeof argument === "function");
		if (callback) done.push(callback as () => void);
		return true;
	};
	output.write = collect as Write;
	try {
		render();
	} finally {
		if (output.write === (collect as Write)) output.write = forward;
		chunks.push(Buffer.from(after()));
		status.write(Buffer.concat(chunks), () => {
			for (const callback of done) callback();
		});
	}
}

function eraseOnExit(): void {
	const status = shown;
	if (status === undefined || !erasable(status)) return;
	status.owned = false;
	try {
		if (status.output.fd !== undefined) writeSync(status.output.fd, ERASE_LINE);
		else status.write(ERASE_LINE);
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
 * Show a one-line status while startup work runs before anything else is drawn, so the terminal is never blank. The
 * line is a finished line of its own: whatever else is written to the terminal meanwhile goes below it. Atomic erases
 * it only while nothing else has written since it was drawn, when the first screen or a startup dialog takes its place
 * ({@link replaceStartupStatus}, {@link suspendStartupStatus}) or startup ends ({@link clearStartupStatus}); otherwise
 * it stays, whole. Nothing is drawn when the output is not a terminal.
 */
export function showStartupStatus(
	output: StartupStatusOutput = process.stdout as unknown as StartupStatusOutput,
	neighbors: StartupStatusNeighbors = defaultNeighbors(),
): void {
	if (shown !== undefined || output.isTTY !== true) return;
	const ownWrite = output.write;
	const status: ShownStatus = {
		output,
		owned: false,
		shared: false,
		dialogs: 0,
		replaced: false,
		othersWrote: false,
		size: "",
		unwatch: () => {},
		write: (data, done) => {
			try {
				ownWrite.call(output, data, done as never);
			} catch {
				// A status line is a courtesy: a terminal that cannot be written to never stops startup.
			}
		},
	};
	status.unwatch = watch(status, neighbors);
	shown = status;
	process.once("exit", eraseOnExit);
	const line = lineFor(status, "");
	if (line.length > 0) status.write(line);
}

/**
 * Something Atomic cannot watch may write to the terminal from now on: a child process that inherits it, such as a
 * package install, or extension code running in this process. The status line stays as it is, and what they write
 * goes below it (#5546).
 */
export function leaveStartupStatusLine(): void {
	const status = shown;
	if (status === undefined) return;
	status.shared = true;
	status.owned = false;
}

/** Startup failed or ends, and what follows is written on its own: the line is erased if it is still Atomic's alone. */
export function clearStartupStatus(): void {
	const status = shown;
	if (status === undefined) return;
	const erase = erasable(status);
	release(status);
	if (erase) status.write(ERASE_LINE);
}

/**
 * Hand the terminal from the status line to the first screen: everything `start` (which takes the terminal) and `paint`
 * (which draws the first frame) write goes to the terminal in one write, which also erases the line while it is still
 * Atomic's alone, so the screen is never without both (#5546). Without a status line, only `start` runs and the screen
 * paints when it is ready.
 */
export function replaceStartupStatus(start: () => void, paint: () => void): void {
	const status = shown;
	if (status === undefined) {
		start();
		return;
	}
	const erase = erasable(status);
	release(status);
	inOneWrite(
		status,
		erase ? ERASE_LINE : "",
		() => {
			start();
			paint();
		},
		() => "",
	);
}

/** A startup dialog takes the terminal; the line stays until the dialog draws its first frame. */
export function suspendStartupStatus(): void {
	const status = shown;
	if (status !== undefined) status.dialogs++;
}

/**
 * The startup dialog that took the line's place clears its rows with what `clear` writes: the line comes back at the
 * start of the first in the same write, so the screen is never without both while startup still runs (#5546). Returns
 * whether it ran `clear`; when the line did not give way to the dialog, the caller clears as it would.
 */
export function restoreStartupStatus(clear: () => void): boolean {
	const status = shown;
	if (status === undefined || !status.replaced || status.shared) return false;
	status.replaced = false;
	inOneWrite(status, "", clear, () => lineFor(status, "\r"));
	return true;
}

/** The startup dialog closed: the line comes back if the dialog took its place and did not bring it back itself. */
export function resumeStartupStatus(): void {
	const status = shown;
	if (status === undefined || status.dialogs === 0) return;
	status.dialogs--;
	if (status.dialogs > 0 || !status.replaced) return;
	status.replaced = false;
	if (status.shared) return;
	// The dialog left the cursor at the start of the rows it used, unless someone else wrote meanwhile: then the line
	// starts on a row below whatever they wrote.
	const line = lineFor(status, status.othersWrote ? "\r\n" : "\r");
	if (line.length > 0) status.write(line);
}
