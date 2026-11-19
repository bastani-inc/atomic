import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTuiEnvValue } from "./env.ts";
import { deleteKittyImage, isImageLine } from "./terminal-image.ts";
import {
	type Component,
	type Container,
	type ScrollbackFrameGate,
	type ScrollbackFrameGateOptions,
	type TUI,
	TuiBase,
	type TuiStopOptions,
} from "./tui.ts";
import { visibleWidth } from "./utils.ts";

/** OSC 133 prompt markers at the start of a rendered line. Fullscreen uses them for prompt navigation. */
const OSC133_ZONE_PREFIX = /^(?:\x1b\]133;[ABC](?:;[^\x07\x1b]*)?(?:\x07|\x1b\\))+/;

const KITTY_SEQUENCE_PREFIX = "\x1b_G";
const MAX_RENDER_WRITE_CHARS = 1024 * 1024;
/** The most rendered rows a scrollback frame gate holds, in UTF-8 bytes; a larger frame is written as rendered. */
const MAX_HELD_FRAME_BYTES = 64 * 1024;

/**
 * Streams terminal output in 1 MiB chunks so a full render never forms one string large enough to exceed V8's limit.
 *
 * `append()` fills the current chunk and flushes it when full. Oversized input is split at chunk boundaries, preserving
 * surrogate pairs so each write remains valid UTF-16. Callers append synchronized-output begin/end sequences themselves;
 * the final `flush()` writes any remainder, including the end sequence.
 */
class BoundedTerminalWriter {
	private buffer = "";
	private writtenChars = 0;
	private readonly write: (data: string) => void;

	constructor(write: (data: string) => void) {
		this.write = write;
	}

	/**
	 * Append terminal data, flushing full chunks as needed. Callers must call `flush()` after the final append.
	 * @param value Terminal data to write in order; oversized values are split without splitting surrogate pairs.
	 */
	append(value: string): void {
		let offset = 0;
		while (offset < value.length) {
			const capacity = MAX_RENDER_WRITE_CHARS - this.buffer.length;
			if (capacity === 0) {
				this.flush();
				continue;
			}

			let end = Math.min(value.length, offset + capacity);
			if (
				end < value.length &&
				value.charCodeAt(end - 1) >= 0xd800 &&
				value.charCodeAt(end - 1) <= 0xdbff &&
				value.charCodeAt(end) >= 0xdc00 &&
				value.charCodeAt(end) <= 0xdfff
			) {
				end--;
			}
			if (end === offset) {
				this.flush();
				continue;
			}

			this.buffer += value.slice(offset, end);
			offset = end;
			if (this.buffer.length === MAX_RENDER_WRITE_CHARS) {
				this.flush();
			}
		}
	}

	/** Write the current chunk, if any, and retain only its character count for debug output. */
	flush(): void {
		if (!this.buffer) return;
		this.write(this.buffer);
		this.writtenChars += this.buffer.length;
		this.buffer = "";
	}

	get length(): number {
		return this.writtenChars + this.buffer.length;
	}
}

interface KittyImageHeader {
	ids: number[];
	rows: number;
}

function parseKittyImageHeader(line: string): KittyImageHeader | undefined {
	const sequenceStart = line.indexOf(KITTY_SEQUENCE_PREFIX);
	if (sequenceStart === -1) return undefined;
	const paramsStart = sequenceStart + KITTY_SEQUENCE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return undefined;

	const ids: number[] = [];
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (value === undefined) continue;
		const numberValue = Number(value);
		if (!Number.isInteger(numberValue) || numberValue <= 0 || numberValue > 0xffffffff) continue;
		if (key === "i") ids.push(numberValue);
		else if (key === "r") rows = numberValue;
	}
	return { ids, rows };
}

function extractKittyImageIds(line: string): number[] {
	return parseKittyImageHeader(line)?.ids ?? [];
}

function extractKittyImageRows(line: string): number {
	return parseKittyImageHeader(line)?.rows ?? 1;
}

function isTermuxSession(): boolean {
	return Boolean(process.env.TERMUX_VERSION);
}

export interface TuiMainScreenRenderState {
	previousLines: string[];
	previousWidth: number;
	previousHeight: number;
	cursorRow: number;
	hardwareCursorRow: number;
	maxLinesRendered: number;
	previousViewportTop: number;
}

let debugLogAppends: Promise<void> = Promise.resolve();

/** A frame's rendered rows, ready to compare with and write over the previous frame. */
interface RenderedFrame {
	readonly lines: string[];
	readonly cursorPos: { row: number; col: number } | null;
	readonly width: number;
	readonly height: number;
}

/** What the previous frame left, read before rendering, as every frame reads it. */
interface FrameStart {
	readonly widthChanged: boolean;
	readonly heightChanged: boolean;
	readonly prevViewportTop: number;
	readonly hardwareCursorRow: number;
}

interface HeldFrame {
	readonly frame: RenderedFrame;
	readonly start: FrameStart;
	/** The gated container's first row in the frame, and the rows each of its children drew. */
	readonly row: number;
	readonly children: ReadonlyArray<{ component: Component; height: number }>;
}

interface FrameGateState {
	container: Container | undefined;
	readonly timeoutMs: number;
	onRelease: (() => void) | undefined;
	held: HeldFrame | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
}

function sameFrame(a: RenderedFrame, b: RenderedFrame): boolean {
	if (a.width !== b.width || a.height !== b.height || a.lines.length !== b.lines.length) return false;
	if (a.cursorPos?.row !== b.cursorPos?.row || a.cursorPos?.col !== b.cursorPos?.col) return false;
	for (let i = 0; i < a.lines.length; i++) if (a.lines[i] !== b.lines[i]) return false;
	return true;
}

/** Within the byte bound, and no row the differential writer would refuse: such a frame must throw where main throws. */
function holdable(lines: readonly string[], width: number): boolean {
	let bytes = 0;
	for (const line of lines) {
		bytes += Buffer.byteLength(line);
		if (bytes > MAX_HELD_FRAME_BYTES) return false;
	}
	for (const line of lines) if (!isImageLine(line) && visibleWidth(line) > width) return false;
	return true;
}

function appendDebugLog(logPath: string, data: string): void {
	debugLogAppends = debugLogAppends.then(async () => {
		try {
			await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
			await fs.promises.appendFile(logPath, data);
		} catch {}
	});
}

function writeRenderCrashLog(crashLogPath: string, crashData: string): void {
	fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
	fs.writeFileSync(crashLogPath, crashData);
}

/** TUI implementation that renders into the terminal's main screen and scrollback. */
export class TuiMainScreen extends TuiBase implements TUI {
	readonly mode = "regular" as const;
	private previousLines: string[] = [];
	private previousKittyImageIds = new Set<number>();
	private previousWidth = 0;
	private previousHeight = 0;
	private cursorRow = 0;
	private hardwareCursorRow = 0;
	private maxLinesRendered = 0;
	private previousViewportTop = 0;
	private frameGate: FrameGateState | undefined;

	/**
	 * Hold at most one frame that draws `container`, at most 64 KiB and `timeoutMs`, while a side lookup for its rows is
	 * outstanding. Every frame still renders when it would without a gate. A frame that does not draw the container is
	 * written at once. A second, different frame writes the held one first, then itself, in order, and releases the gate.
	 * A frame over the byte bound, a frame with an overlay, an expired hold, a newer gate, a forced redraw and `stop()` do
	 * the same: the held frame is written exactly as it was rendered, and rows the lookup returns later wait for a later
	 * redraw.
	 */
	gateScrollbackFrame(container: Container, options: ScrollbackFrameGateOptions): ScrollbackFrameGate | undefined {
		this.releaseFrameGate();
		if (this.stopped) return undefined;
		const state: FrameGateState = {
			container,
			timeoutMs: options.timeoutMs,
			onRelease: options.onRelease,
			held: undefined,
			timer: undefined,
		};
		this.frameGate = state;
		return {
			settle: (update) => this.settleFrameGate(state, update),
			release: () => {
				if (this.frameGate === state) this.releaseFrameGate();
			},
		};
	}

	override stop(options: TuiStopOptions = {}): void {
		this.releaseFrameGate();
		super.stop(options);
	}

	captureRenderState(): TuiMainScreenRenderState {
		return {
			previousLines: [...this.previousLines],
			previousWidth: this.previousWidth,
			previousHeight: this.previousHeight,
			cursorRow: this.cursorRow,
			hardwareCursorRow: this.hardwareCursorRow,
			maxLinesRendered: this.maxLinesRendered,
			previousViewportTop: this.previousViewportTop,
		};
	}

	restoreRenderState(state: TuiMainScreenRenderState): void {
		this.releaseFrameGate();
		this.previousLines = state.previousLines.map((line) => (isImageLine(line) ? "" : line));
		this.previousKittyImageIds = new Set();
		this.previousWidth = state.previousWidth;
		this.previousHeight = state.previousHeight;
		this.cursorRow = state.cursorRow;
		this.hardwareCursorRow = state.hardwareCursorRow;
		this.maxLinesRendered = state.maxLinesRendered;
		this.previousViewportTop = state.previousViewportTop;
	}

	protected override resetRenderState(): void {
		this.releaseFrameGate();
		this.previousLines = [];
		this.previousWidth = -1;
		this.previousHeight = -1;
		this.cursorRow = 0;
		this.hardwareCursorRow = 0;
		this.maxLinesRendered = 0;
		this.previousViewportTop = 0;
	}

	protected override beforeTerminalStop(options: TuiStopOptions): void {
		if (options.preserveScreen || this.previousLines.length === 0) return;
		this.terminal.write(" ");
		const targetRow = this.previousLines.length;
		const lineDiff = targetRow - this.hardwareCursorRow;
		if (lineDiff > 0) this.terminal.write(`\x1b[${lineDiff}B`);
		else if (lineDiff < 0) this.terminal.write(`\x1b[${-lineDiff}A`);
		this.terminal.write("\r\n");
	}

	private collectKittyImageIds(lines: string[]): Set<number> {
		const ids = new Set<number>();
		for (const line of lines) {
			for (const id of extractKittyImageIds(line)) {
				ids.add(id);
			}
		}
		return ids;
	}

	private deleteKittyImages(ids: Iterable<number>): string {
		let buffer = "";
		for (const id of ids) {
			buffer += deleteKittyImage(id);
		}
		return buffer;
	}

	private getKittyImageReservedRows(lines: string[], index: number, maxIndex = lines.length - 1): number {
		const rows = extractKittyImageRows(lines[index] ?? "");
		if (rows <= 1) return 1;

		const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
		let reservedRows = 1;
		while (reservedRows < maxRows) {
			const line = lines[index + reservedRows] ?? "";
			if (isImageLine(line) || visibleWidth(line) > 0) break;
			reservedRows++;
		}
		return reservedRows;
	}

	private expandChangedRangeForKittyImages(
		firstChanged: number,
		lastChanged: number,
		newLines: string[],
	): { firstChanged: number; lastChanged: number } {
		let expandedFirstChanged = firstChanged;
		let expandedLastChanged = lastChanged;
		const expandForLines = (lines: string[]): void => {
			for (let i = 0; i < lines.length; i++) {
				if (extractKittyImageIds(lines[i]).length === 0) continue;
				const blockEnd = i + this.getKittyImageReservedRows(lines, i) - 1;
				if (i >= firstChanged || (i <= lastChanged && blockEnd >= firstChanged)) {
					expandedFirstChanged = Math.min(expandedFirstChanged, i);
					expandedLastChanged = Math.max(expandedLastChanged, blockEnd);
				}
			}
		};

		expandForLines(this.previousLines);
		expandForLines(newLines);
		return { firstChanged: expandedFirstChanged, lastChanged: expandedLastChanged };
	}

	private deleteChangedKittyImages(firstChanged: number, lastChanged: number): string {
		if (firstChanged < 0 || lastChanged < firstChanged) return "";

		const ids = new Set<number>();
		const maxLine = Math.min(lastChanged, this.previousLines.length - 1);
		for (let i = firstChanged; i <= maxLine; i++) {
			for (const id of extractKittyImageIds(this.previousLines[i] ?? "")) {
				ids.add(id);
			}
		}

		return this.deleteKittyImages(ids);
	}

	protected doRender(): void {
		if (this.stopped) return;
		const width = this.terminal.columns;
		const height = this.terminal.rows;
		let start = this.frameStart(width, height);

		// Render all components to get new lines
		// Resolve fake cursors before compositing so overlays and line slicing see plain SGR codes
		// Drop OSC 133 markers: the terminal reads 133;A as a new shell prompt, which ends program status (OSC 7501)
		let newLines: string[];
		let cursorPos: { row: number; col: number } | null;
		try {
			newLines = this.resolveFakeCursors(this.render(width).map((line) => line.replace(OSC133_ZONE_PREFIX, "")));

			// Composite overlays into the rendered lines (before differential compare)
			if (this.hasOverlayEntries) {
				newLines = this.compositeOverlays(newLines, width, height);
			}

			// Extract cursor position before applying line resets (marker must be found first)
			cursorPos = this.extractCursorPosition(newLines, height);

			newLines = this.applyLineResets(newLines);
		} catch (error) {
			// A renderer threw: main had already written the frame that is held.
			if (this.frameGate?.held) this.releaseFrameGate();
			throw error;
		}
		const frame: RenderedFrame = { lines: newLines, cursorPos, width, height };
		const gate = this.frameGate;
		if (gate) {
			const outcome = this.offerFrame(gate, frame, start);
			if (outcome === "held") return;
			// The held frame is now on screen, where main wrote it before rendering this one.
			if (outcome === "wrote-held") start = this.frameStart(width, height);
		}
		this.writeFrame(frame, start);
	}

	private frameStart(width: number, height: number): FrameStart {
		const heightChanged = this.previousHeight !== 0 && this.previousHeight !== height;
		const previousBufferLength = this.previousHeight > 0 ? this.previousViewportTop + this.previousHeight : height;
		return {
			widthChanged: this.previousWidth !== 0 && this.previousWidth !== width,
			heightChanged,
			prevViewportTop: heightChanged ? Math.max(0, previousBufferLength - height) : this.previousViewportTop,
			hardwareCursorRow: this.hardwareCursorRow,
		};
	}

	/** Hold `frame`, or say whether the held frame was written ahead of it. */
	private offerFrame(gate: FrameGateState, frame: RenderedFrame, start: FrameStart): "held" | "wrote-held" | "write" {
		if (gate.held) {
			// Nothing changed: main would only place the cursor where the held frame places it.
			if (sameFrame(gate.held.frame, frame)) return "held";
			this.releaseFrameGate();
			return "wrote-held";
		}
		const drawn = gate.container && this.drawnRowsOf(gate.container, frame.width);
		let height = 0;
		for (const child of drawn?.children ?? []) height += child.height;
		if (!drawn || height === 0) return "write";
		const cursor = frame.cursorPos?.row;
		if (
			this.hasOverlayEntries ||
			(cursor !== undefined && cursor >= drawn.row && cursor < drawn.row + height) ||
			!holdable(frame.lines, frame.width)
		) {
			this.releaseFrameGate();
			return "write";
		}
		gate.held = { frame, start, row: drawn.row, children: drawn.children };
		gate.timer = setTimeout(() => {
			if (this.frameGate === gate) this.releaseFrameGate();
		}, gate.timeoutMs);
		return "held";
	}

	private settleFrameGate(gate: FrameGateState, update: (() => void) | undefined): void {
		if (this.frameGate !== gate) return;
		const { held, container } = gate;
		let frame = held?.frame;
		try {
			// Before any frame drew the container, the next frame draws what `update` leaves.
			if (!held || !container) update?.();
			else if (update) frame = this.recomposeHeldFrame(held, container, update);
		} finally {
			if (this.frameGate === gate) {
				if (held && frame) gate.held = { ...held, frame };
				this.releaseFrameGate();
			}
		}
	}

	/**
	 * The held frame, with the container's children as `update` leaves them: rows the frame drew for children that remain,
	 * and rows of the children `update` added. A child added since the frame was rendered waits for the next frame.
	 */
	private recomposeHeldFrame(held: HeldFrame, container: Container, update: () => void): RenderedFrame {
		const { frame } = held;
		const before = new Set(container.children);
		update();
		const drawn = new Map<Component, string[][]>();
		let end = held.row;
		for (const { component, height } of held.children) {
			const rows = frame.lines.slice(end, end + height);
			const kept = drawn.get(component);
			if (kept) kept.push(rows);
			else drawn.set(component, [rows]);
			end += height;
		}
		const lines = frame.lines.slice(0, held.row);
		for (const child of container.children) {
			const rows =
				drawn.get(child)?.shift() ?? (before.has(child) ? undefined : this.finishRows(child.render(frame.width)));
			if (rows) for (const line of rows) lines.push(line);
		}
		const moved = lines.length - end;
		for (let i = end; i < frame.lines.length; i++) lines.push(frame.lines[i]!);
		const cursorPos =
			frame.cursorPos && frame.cursorPos.row >= end
				? { row: frame.cursorPos.row + moved, col: frame.cursorPos.col }
				: frame.cursorPos;
		return { lines, cursorPos, width: frame.width, height: frame.height };
	}

	/** The per-line treatment a rendered frame gets, for rows that join a frame which was already rendered. */
	private finishRows(rows: string[]): string[] {
		return this.applyLineResets(this.resolveFakeCursors(rows.map((line) => line.replace(OSC133_ZONE_PREFIX, ""))));
	}

	private endFrameGate(gate: FrameGateState): void {
		if (gate.timer) clearTimeout(gate.timer);
		gate.timer = undefined;
		gate.held = undefined;
		gate.container = undefined;
	}

	/** Write a held frame exactly as it was rendered, and end the gate. */
	private releaseFrameGate(): void {
		const gate = this.frameGate;
		if (!gate) return;
		this.frameGate = undefined;
		const held = gate.held;
		const onRelease = gate.onRelease;
		gate.onRelease = undefined;
		this.endFrameGate(gate);
		if (held && !this.stopped) this.writeFrame(held.frame, held.start);
		onRelease?.();
	}

	private writeFrame(frame: RenderedFrame, start: FrameStart): void {
		const { lines: newLines, cursorPos, width, height } = frame;
		const { widthChanged, heightChanged } = start;
		let prevViewportTop = start.prevViewportTop;
		let viewportTop = prevViewportTop;
		let hardwareCursorRow = start.hardwareCursorRow;
		const computeLineDiff = (targetRow: number): number => {
			const currentScreenRow = hardwareCursorRow - prevViewportTop;
			const targetScreenRow = targetRow - viewportTop;
			return targetScreenRow - currentScreenRow;
		};
		// Helper to clear scrollback and viewport and render all new lines
		const fullRender = (clear: boolean): void => {
			this.fullRedrawCount += 1;
			const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
			output.append("\x1b[?2026h"); // Begin synchronized output
			if (clear) {
				output.append(this.deleteKittyImages(this.previousKittyImageIds));
				output.append("\x1b[2J\x1b[H\x1b[3J"); // Clear screen, home, then clear scrollback
			}
			for (let i = 0; i < newLines.length; i++) {
				if (i > 0) output.append("\r\n");
				const line = newLines[i];
				const isImage = isImageLine(line);
				const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i) : 1;
				if (imageReservedRows > 1 && imageReservedRows <= height) {
					for (let row = 1; row < imageReservedRows; row++) {
						output.append("\r\n");
					}
					output.append(`\x1b[${imageReservedRows - 1}A`);
					output.append(line);
					output.append(`\x1b[${imageReservedRows - 1}B`);
					i += imageReservedRows - 1;
					continue;
				}
				output.append(line);
			}
			output.append("\x1b[?2026l"); // End synchronized output
			output.flush();
			this.cursorRow = Math.max(0, newLines.length - 1);
			this.hardwareCursorRow = this.cursorRow;
			// Reset max lines when clearing, otherwise track growth
			if (clear) {
				this.maxLinesRendered = newLines.length;
			} else {
				this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
			}
			const bufferLength = Math.max(height, newLines.length);
			this.previousViewportTop = Math.max(0, bufferLength - height);
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
		};

		const redrawLogDirectory = getTuiEnvValue("TUI_DEBUG_REDRAW") === "1" ? this.logDirectory : undefined;
		const logRedraw = (reason: string): void => {
			if (redrawLogDirectory === undefined) return;
			const logPath = path.join(redrawLogDirectory, "pi-tui-debug.log");
			const msg = `[${new Date().toISOString()}] fullRender: ${reason} (prev=${this.previousLines.length}, new=${newLines.length}, height=${height})\n`;
			appendDebugLog(logPath, msg);
		};

		// First render - just output everything without clearing (assumes clean screen)
		if (this.previousLines.length === 0 && !widthChanged && !heightChanged) {
			logRedraw("first render");
			fullRender(false);
			return;
		}

		// Width changes always need a full re-render because wrapping changes.
		if (widthChanged) {
			logRedraw(`terminal width changed (${this.previousWidth} -> ${width})`);
			fullRender(true);
			return;
		}

		// Height changes normally need a full re-render to keep the visible viewport aligned,
		// but Termux changes height when the software keyboard shows or hides.
		// In that environment, a full redraw causes the entire history to replay on every toggle.
		if (heightChanged && !isTermuxSession()) {
			logRedraw(`terminal height changed (${this.previousHeight} -> ${height})`);
			fullRender(true);
			return;
		}

		// Content shrunk below the working area and no overlays - re-render to clear empty rows
		// (overlays need the padding, so only do this when no overlays are active)
		// Configurable via setClearOnShrink()
		if (this.getClearOnShrink() && newLines.length < this.maxLinesRendered && !this.hasOverlayEntries) {
			logRedraw(`clearOnShrink (maxLinesRendered=${this.maxLinesRendered})`);
			fullRender(true);
			return;
		}

		// Find first and last changed lines
		let firstChanged = -1;
		let lastChanged = -1;
		const maxLines = Math.max(newLines.length, this.previousLines.length);
		for (let i = 0; i < maxLines; i++) {
			const oldLine = i < this.previousLines.length ? this.previousLines[i] : "";
			const newLine = i < newLines.length ? newLines[i] : "";

			if (oldLine !== newLine) {
				if (firstChanged === -1) {
					firstChanged = i;
				}
				lastChanged = i;
			}
		}
		const appendedLines = newLines.length > this.previousLines.length;
		if (appendedLines) {
			if (firstChanged === -1) {
				firstChanged = this.previousLines.length;
			}
			lastChanged = newLines.length - 1;
		}
		if (firstChanged !== -1) {
			const expandedRange = this.expandChangedRangeForKittyImages(firstChanged, lastChanged, newLines);
			firstChanged = expandedRange.firstChanged;
			lastChanged = expandedRange.lastChanged;
		}
		const appendStart = appendedLines && firstChanged === this.previousLines.length && firstChanged > 0;

		// No changes - but still need to update hardware cursor position if it moved
		if (firstChanged === -1) {
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousViewportTop = prevViewportTop;
			this.previousHeight = height;
			return;
		}

		// All changes are in deleted lines (nothing to render, just clear)
		if (firstChanged >= newLines.length) {
			if (this.previousLines.length > newLines.length) {
				const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
				output.append("\x1b[?2026h");
				output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
				// Move to end of new content (clamp to 0 for empty content)
				const targetRow = Math.max(0, newLines.length - 1);
				if (targetRow < prevViewportTop) {
					logRedraw(`deleted lines moved viewport up (${targetRow} < ${prevViewportTop})`);
					fullRender(true);
					return;
				}
				const lineDiff = computeLineDiff(targetRow);
				if (lineDiff > 0) output.append(`\x1b[${lineDiff}B`);
				else if (lineDiff < 0) output.append(`\x1b[${-lineDiff}A`);
				output.append("\r");
				// Clear extra lines without scrolling
				const extraLines = this.previousLines.length - newLines.length;
				if (extraLines > height) {
					logRedraw(`extraLines > height (${extraLines} > ${height})`);
					fullRender(true);
					return;
				}
				const clearStartOffset = newLines.length === 0 ? 0 : 1;
				if (extraLines > 0 && clearStartOffset > 0) {
					output.append(`\x1b[${clearStartOffset}B`);
				}
				for (let i = 0; i < extraLines; i++) {
					output.append("\r\x1b[2K");
					if (i < extraLines - 1) output.append("\x1b[1B");
				}
				const moveBack = Math.max(0, extraLines - 1 + clearStartOffset);
				if (moveBack > 0) {
					output.append(`\x1b[${moveBack}A`);
				}
				output.append("\x1b[?2026l");
				output.flush();
				this.cursorRow = targetRow;
				this.hardwareCursorRow = targetRow;
			}
			this.positionHardwareCursor(cursorPos, newLines.length);
			this.previousLines = newLines;
			this.previousKittyImageIds = this.collectKittyImageIds(newLines);
			this.previousWidth = width;
			this.previousHeight = height;
			this.previousViewportTop = prevViewportTop;
			return;
		}

		// Differential rendering can only touch what was actually visible.
		// If the first changed line is above the previous viewport, we need a full redraw.
		if (firstChanged < prevViewportTop) {
			logRedraw(`firstChanged < viewportTop (${firstChanged} < ${prevViewportTop})`);
			fullRender(true);
			return;
		}

		// Render from first changed line to end
		// Keep updates wrapped in synchronized output while writing bounded chunks.
		const output = new BoundedTerminalWriter((data) => this.terminal.write(data));
		output.append("\x1b[?2026h"); // Begin synchronized output
		output.append(this.deleteChangedKittyImages(firstChanged, lastChanged));
		const prevViewportBottom = prevViewportTop + height - 1;
		const moveTargetRow = appendStart ? firstChanged - 1 : firstChanged;
		if (moveTargetRow > prevViewportBottom) {
			const currentScreenRow = Math.max(0, Math.min(height - 1, hardwareCursorRow - prevViewportTop));
			const moveToBottom = height - 1 - currentScreenRow;
			if (moveToBottom > 0) {
				output.append(`\x1b[${moveToBottom}B`);
			}
			const scroll = moveTargetRow - prevViewportBottom;
			output.append("\r\n".repeat(scroll));
			prevViewportTop += scroll;
			viewportTop += scroll;
			hardwareCursorRow = moveTargetRow;
		}

		// Move cursor to first changed line (use hardwareCursorRow for actual position)
		const lineDiff = computeLineDiff(moveTargetRow);
		if (lineDiff > 0) {
			output.append(`\x1b[${lineDiff}B`); // Move down
		} else if (lineDiff < 0) {
			output.append(`\x1b[${-lineDiff}A`); // Move up
		}

		output.append(appendStart ? "\r\n" : "\r"); // Move to column 0

		// Only render changed lines (firstChanged to lastChanged), not all lines to end
		// This reduces flicker when only a single line changes (e.g., spinner animation)
		const renderEnd = Math.min(lastChanged, newLines.length - 1);
		for (let i = firstChanged; i <= renderEnd; i++) {
			if (i > firstChanged) output.append("\r\n");
			const line = newLines[i];
			const isImage = isImageLine(line);
			const imageReservedRows = isImage ? this.getKittyImageReservedRows(newLines, i, renderEnd) : 1;
			if (imageReservedRows > 1) {
				const imageStartScreenRow = i - viewportTop;
				if (imageStartScreenRow < 0 || imageStartScreenRow + imageReservedRows > height) {
					logRedraw(
						`kitty image pre-clear would scroll (${imageStartScreenRow} + ${imageReservedRows} > ${height})`,
					);
					fullRender(true);
					return;
				}

				output.append("\x1b[2K");
				for (let row = 1; row < imageReservedRows; row++) {
					output.append("\r\n\x1b[2K");
				}
				output.append(`\x1b[${imageReservedRows - 1}A`);
				output.append(line);
				output.append(`\x1b[${imageReservedRows - 1}B`);
				i += imageReservedRows - 1;
				continue;
			}

			output.append("\x1b[2K"); // Clear current line
			if (!isImage && visibleWidth(line) > width) {
				// Log all lines to crash file for debugging
				const crashLogPath = path.join(this.logDirectory ?? os.tmpdir(), "pi-tui-crash.log");
				const crashData = [
					`Crash at ${new Date().toISOString()}`,
					`Terminal width: ${width}`,
					`Line ${i} visible width: ${visibleWidth(line)}`,
					"",
					"=== All rendered lines ===",
					...newLines.map((l, idx) => `[${idx}] (w=${visibleWidth(l)}) ${l}`),
					"",
				].join("\n");
				writeRenderCrashLog(crashLogPath, crashData);

				// Clean up terminal state before throwing
				this.stop();

				const errorMsg = [
					`Rendered line ${i} exceeds terminal width (${visibleWidth(line)} > ${width}).`,
					"",
					"This is likely caused by a custom TUI component not truncating its output.",
					"Use visibleWidth() to measure and truncateToWidth() to truncate lines.",
					"",
					`Debug log written to: ${crashLogPath}`,
				].join("\n");
				throw new Error(errorMsg);
			}
			output.append(line);
		}

		// Track where cursor ended up after rendering
		let finalCursorRow = renderEnd;

		// If we had more lines before, clear them and move cursor back
		if (this.previousLines.length > newLines.length) {
			// Move to end of new content first if we stopped before it
			if (renderEnd < newLines.length - 1) {
				const moveDown = newLines.length - 1 - renderEnd;
				output.append(`\x1b[${moveDown}B`);
				finalCursorRow = newLines.length - 1;
			}
			const extraLines = this.previousLines.length - newLines.length;
			for (let i = newLines.length; i < this.previousLines.length; i++) {
				output.append("\r\n\x1b[2K");
			}
			// Move cursor back to end of new content
			output.append(`\x1b[${extraLines}A`);
		}

		output.append("\x1b[?2026l"); // End synchronized output

		if (getTuiEnvValue("TUI_DEBUG") === "1") {
			const debugDir = "/tmp/tui";
			const debugPath = path.join(debugDir, `render-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
			const debugData = [
				`firstChanged: ${firstChanged}`,
				`viewportTop: ${viewportTop}`,
				`cursorRow: ${this.cursorRow}`,
				`height: ${height}`,
				`lineDiff: ${lineDiff}`,
				`hardwareCursorRow: ${hardwareCursorRow}`,
				`renderEnd: ${renderEnd}`,
				`finalCursorRow: ${finalCursorRow}`,
				`cursorPos: ${JSON.stringify(cursorPos)}`,
				`newLines.length: ${newLines.length}`,
				`previousLines.length: ${this.previousLines.length}`,
				"",
				"=== newLines ===",
				JSON.stringify(newLines, null, 2),
				"",
				"=== previousLines ===",
				JSON.stringify(this.previousLines, null, 2),
				"",
				"=== buffer ===",
				`[${output.length} chars written in bounded chunks]`,
			].join("\n");
			appendDebugLog(debugPath, debugData);
		}

		output.flush();

		// Track cursor position for next render
		// cursorRow tracks end of content (for viewport calculation)
		// hardwareCursorRow tracks actual terminal cursor position (for movement)
		this.cursorRow = Math.max(0, newLines.length - 1);
		this.hardwareCursorRow = finalCursorRow;
		// Track terminal's working area (grows but doesn't shrink unless cleared)
		this.maxLinesRendered = Math.max(this.maxLinesRendered, newLines.length);
		this.previousViewportTop = Math.max(prevViewportTop, finalCursorRow - height + 1);

		// Position hardware cursor for IME
		this.positionHardwareCursor(cursorPos, newLines.length);

		this.previousLines = newLines;
		this.previousKittyImageIds = this.collectKittyImageIds(newLines);
		this.previousWidth = width;
		this.previousHeight = height;
	}

	/**
	 * Position the hardware cursor for IME candidate window.
	 * @param cursorPos The cursor position extracted from rendered output, or null
	 * @param totalLines Total number of rendered lines
	 */
	private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
		if (!cursorPos || totalLines <= 0) {
			this.terminal.hideCursor();
			return;
		}

		// Clamp cursor position to valid range
		const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
		const targetCol = Math.max(0, cursorPos.col);

		// Move cursor from current position to target
		const rowDelta = targetRow - this.hardwareCursorRow;
		let buffer = "";
		if (rowDelta > 0) {
			buffer += `\x1b[${rowDelta}B`; // Move down
		} else if (rowDelta < 0) {
			buffer += `\x1b[${-rowDelta}A`; // Move up
		}
		// Move to absolute column (1-indexed)
		buffer += `\x1b[${targetCol + 1}G`;

		if (buffer) {
			this.terminal.write(buffer);
		}

		this.hardwareCursorRow = targetRow;
		if (this.getShowHardwareCursor()) {
			this.terminal.showCursor();
		} else {
			this.terminal.hideCursor();
		}
	}
}
