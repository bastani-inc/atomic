/**
 * Component for displaying inline `!` / `!!` bash-mode command execution in Atomic's shell block family.
 */

import {
	type Component,
	Container,
	getKeybindings,
	Spacer,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import { replaceTabs } from "../../../core/tools/render-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "../../../core/tools/truncate.ts";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import { theme } from "../theme/theme.js";
import { atomicWorkingFrame, atomicWorkingGlyph, watchAtomicWorkingClock } from "./atomic-working-status.ts";
import { keyHintIfBound } from "./keybinding-hints.js";
import { DETAIL_FIRST_PREFIX, DETAIL_PREFIX } from "./notice-line.ts";
import { TOOL_BLOCK_LIMITS } from "./tool-block.ts";
import { blockRows, type RowRange, rowsFrom } from "./transcript-block-clicks.ts";
import { formatWorkingElapsed } from "./working-run-meter.ts";

const SGR_SEQUENCE = /\x1b\[[0-9;:]*m/g;
const NON_PRINTABLE_ASCII = /[^\x20-\x7e]/;
const COLLAPSED_VISUAL_LINES = TOOL_BLOCK_LIMITS.bash;

function noColor(): boolean {
	return process.env.NO_COLOR !== undefined;
}

/** Strips SGR color/style codes under NO_COLOR while keeping APC clickable key-hint markers intact. */
function finalizeLine(line: string, colorOff: boolean): string {
	return colorOff ? line.replace(SGR_SEQUENCE, "") : line;
}

function utf8ByteLength(text: string): number {
	return NON_PRINTABLE_ASCII.test(text) ? Buffer.byteLength(text, "utf8") : text.length;
}

function truncateLineUtf8Tail(line: string, maxBytes: number): string {
	const buf = Buffer.from(line, "utf8");
	if (buf.length <= maxBytes) return line;
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
	return buf.subarray(start).toString("utf8");
}

function normalizeTabLine(line: string): string {
	return line.includes("\t") ? replaceTabs(line) : line;
}

/** Exact visual row count of a single logical line at `detailWidth` without allocating when ASCII-fast-path applies. */
function measureVisualRows(line: string, lineBytes: number, detailWidth: number): number {
	if (lineBytes === line.length && !line.includes("\t")) {
		if (line.length <= detailWidth) return 1;
		if (!line.includes(" ")) return Math.ceil(line.length / detailWidth);
	}
	const tabbed = normalizeTabLine(line);
	if (!NON_PRINTABLE_ASCII.test(tabbed)) {
		if (tabbed.length <= detailWidth) return 1;
		if (!tabbed.includes(" ")) return Math.ceil(tabbed.length / detailWidth);
	}
	return Math.max(1, wrapTextWithAnsi(tabbed, detailWidth).length);
}

/** Wraps a single logical line at `detailWidth`, taking all rows or only the last `tailRows` visual rows. */
function wrapLogicalLine(line: string, detailWidth: number, tailRows?: number): string[] {
	const tabbed = normalizeTabLine(line);
	if (!NON_PRINTABLE_ASCII.test(tabbed)) {
		if (tabbed.length <= detailWidth) return [tabbed];
		if (!tabbed.includes(" ")) {
			const total = Math.ceil(tabbed.length / detailWidth);
			const first = tailRows === undefined ? 0 : Math.max(0, total - tailRows);
			const rows: string[] = [];
			for (let row = first; row < total; row++) {
				rows.push(tabbed.slice(row * detailWidth, (row + 1) * detailWidth));
			}
			return rows;
		}
	}
	const wrapped = wrapTextWithAnsi(tabbed, detailWidth);
	const rows = wrapped.length > 0 ? wrapped : [""];
	return tailRows === undefined || rows.length <= tailRows ? rows : rows.slice(rows.length - tailRows);
}

interface ContextTailWindow {
	readonly start: number;
	readonly end: number;
	readonly truncated: boolean;
	readonly partialFirstLine: string | undefined;
}

function themeRenderStamp(): string {
	return `${theme.getStyleLevel()}:${theme.getFgAnsi("bashMode")}:${theme.getBgAnsi("userMessageBg")}`;
}

interface HeaderCache {
	readonly width: number;
	readonly pad: number;
	readonly colorOff: boolean;
	readonly themeStamp: string;
	readonly rows: readonly string[];
}

interface OutputCache {
	readonly width: number;
	readonly pad: number;
	readonly colorOff: boolean;
	readonly themeStamp: string;
	readonly version: number;
	readonly expanded: boolean;
	readonly status: "running" | "complete" | "cancelled" | "error";
	readonly keybindings: unknown;
	readonly detailRows: readonly string[];
}

interface IndicatorCache {
	readonly width: number;
	readonly pad: number;
	readonly colorOff: boolean;
	readonly themeStamp: string;
	readonly keybindings: unknown;
	readonly hasPriorDetails: boolean;
	readonly frame: number;
	readonly elapsedSec: number;
	readonly rows: readonly string[];
}

export class BashExecutionComponent extends Container {
	readonly expandsOnClick = true;
	private command: string;
	private outputLines: string[] = [];
	private outputLineBytes: number[] = [];
	private contentVersion = 0;
	private status: "running" | "complete" | "cancelled" | "error" = "running";
	private exitCode: number | undefined = undefined;
	private truncationResult?: TruncationResult;
	private fullOutputPath?: string;
	private expanded = false;
	/** `dim` marks `!!` commands, whose output is excluded from the model context. */
	private readonly excludeFromContext: boolean;
	private readonly colorKey: "dim" | "bashMode";
	private readonly ui: TUI;
	private readonly startedAt = Date.now();
	private outputPad: number;
	private stopWorkingClock: (() => void) | undefined;
	private disposed = false;
	private headerCache: HeaderCache | undefined;
	private outputCache: OutputCache | undefined;
	private indicatorCache: IndicatorCache | undefined;
	private frameCache:
		| {
				readonly width: number;
				readonly pad: number;
				readonly colorOff: boolean;
				readonly themeStamp: string;
				readonly keybindings: unknown;
				readonly version: number;
				readonly expanded: boolean;
				readonly status: "running" | "complete" | "cancelled" | "error";
				readonly frame: number;
				readonly elapsedSec: number;
				readonly rows: string[];
		  }
		| undefined;

	constructor(command: string, ui: TUI, excludeFromContext = false, outputPad = 1) {
		super();
		this.command = command;
		this.ui = ui;
		this.excludeFromContext = excludeFromContext;
		this.colorKey = excludeFromContext ? "dim" : "bashMode";
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));
		const body: Component = {
			render: (width: number) => this.renderBlock(width),
			invalidate: () => {
				this.headerCache = undefined;
				this.outputCache = undefined;
				this.indicatorCache = undefined;
				this.frameCache = undefined;
			},
		};
		this.addChild(body);
		this.syncWorkingClock();
	}

	isWorking(): boolean {
		return this.status === "running";
	}

	/**
	 * Set whether the output is expanded (shows full output) or collapsed (preview only).
	 */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.outputCache = undefined;
		this.frameCache = undefined;
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Its rows: an expand hint in them is part of the block, which a click on it expands or collapses. */
	override render(width: number): string[] {
		const safeWidth = Math.max(1, Math.floor(width));
		const pad = Math.max(0, Math.min(Math.floor(this.outputPad), safeWidth - 1));
		const colorOff = noColor();
		const themeStamp = themeRenderStamp();
		const keybindings = getKeybindings();
		const running = this.status === "running";
		const frame = running ? atomicWorkingFrame() : -1;
		const elapsedSec = running ? Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000)) : -1;
		const cached = this.frameCache;
		if (
			cached &&
			cached.width === safeWidth &&
			cached.pad === pad &&
			cached.colorOff === colorOff &&
			cached.themeStamp === themeStamp &&
			cached.keybindings === keybindings &&
			cached.version === this.contentVersion &&
			cached.expanded === this.expanded &&
			cached.status === this.status &&
			cached.frame === frame &&
			cached.elapsedSec === elapsedSec
		) {
			return cached.rows;
		}
		const rows = blockRows(super.render(width));
		this.frameCache = {
			width: safeWidth,
			pad,
			colorOff,
			themeStamp,
			keybindings,
			version: this.contentVersion,
			expanded: this.expanded,
			status: this.status,
			frame,
			elapsedSec,
			rows,
		};
		return rows;
	}

	/** Every row of the block below the spacer it starts with. */
	clickArea(width: number): RowRange | undefined {
		const [spacer] = this.children;
		return rowsFrom(spacer?.render(width).length ?? 0, this.render(width).length);
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.headerCache = undefined;
		this.outputCache = undefined;
		this.indicatorCache = undefined;
		this.frameCache = undefined;
	}

	override invalidate(): void {
		this.headerCache = undefined;
		this.outputCache = undefined;
		this.indicatorCache = undefined;
		this.frameCache = undefined;
		super.invalidate();
	}

	dispose(): void {
		this.disposed = true;
		this.stopWorkingClock?.();
		this.stopWorkingClock = undefined;
	}

	appendOutput(chunk: string): void {
		// Normalize line endings, then make the text inert for the terminal
		const clean = terminalDisplayText(chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));

		// Append to output lines while keeping exact per-line UTF-8 byte lengths for O(1) tail scans.
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			const lastIdx = this.outputLines.length - 1;
			const continuation = newLines[0]!;
			if (continuation.length > 0) {
				this.outputLines[lastIdx] += continuation;
				this.outputLineBytes[lastIdx] = this.outputLineBytes[lastIdx]! + utf8ByteLength(continuation);
			}
			for (let i = 1; i < newLines.length; i++) {
				const line = newLines[i]!;
				this.outputLines.push(line);
				this.outputLineBytes.push(utf8ByteLength(line));
			}
		} else {
			for (const line of newLines) {
				this.outputLines.push(line);
				this.outputLineBytes.push(utf8ByteLength(line));
			}
		}

		this.contentVersion++;
	}

	setComplete(
		exitCode: number | undefined,
		cancelled: boolean,
		truncationResult?: TruncationResult,
		fullOutputPath?: string,
	): void {
		this.exitCode = exitCode;
		this.status = cancelled
			? "cancelled"
			: exitCode !== 0 && exitCode !== undefined && exitCode !== null
				? "error"
				: "complete";
		this.truncationResult = truncationResult;
		this.fullOutputPath = fullOutputPath;

		this.syncWorkingClock();
		this.contentVersion++;
	}

	private syncWorkingClock(): void {
		if (!this.disposed && this.status === "running") {
			this.stopWorkingClock ??= watchAtomicWorkingClock(() => {
				if (this.disposed || this.status !== "running") {
					this.stopWorkingClock?.();
					this.stopWorkingClock = undefined;
					return;
				}
				// Re-render only the working indicator line; keep cached header and output rows intact.
				this.ui.requestRender();
			});
		} else {
			this.stopWorkingClock?.();
			this.stopWorkingClock = undefined;
		}
	}

	/**
	 * Resolves the tail window matching `truncateTail` (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`) without joining
	 * the entire output array. Trailing empty lines from newline-terminated output are stripped for display.
	 */
	private resolveContextTail(): ContextTailWindow {
		let end = this.outputLines.length;
		while (end > 0 && this.outputLines[end - 1] === "") end--;
		if (end === 0) return { start: 0, end: 0, truncated: false, partialFirstLine: undefined };

		let keptLines = 0;
		let keptBytes = 0;
		let start = end;
		let partialFirstLine: string | undefined;

		for (let i = end - 1; i >= 0 && keptLines < DEFAULT_MAX_LINES; i--) {
			const lineBytes = this.outputLineBytes[i]!;
			const addedBytes = lineBytes + (keptLines > 0 ? 1 : 0);
			if (keptBytes + addedBytes > DEFAULT_MAX_BYTES) {
				if (keptLines === 0) {
					partialFirstLine = truncateLineUtf8Tail(this.outputLines[i]!, DEFAULT_MAX_BYTES);
					start = i;
					keptLines = 1;
				}
				break;
			}
			keptBytes += addedBytes;
			start = i;
			keptLines++;
		}

		const truncated = start > 0 || partialFirstLine !== undefined;
		return { start, end, truncated, partialFirstLine };
	}

	private renderHeaderRows(safeWidth: number, pad: number, colorOff: boolean, themeStamp: string): readonly string[] {
		const cached = this.headerCache;
		if (
			cached &&
			cached.width === safeWidth &&
			cached.pad === pad &&
			cached.colorOff === colorOff &&
			cached.themeStamp === themeStamp
		) {
			return cached.rows;
		}
		const lead = " ".repeat(pad);
		const contentWidth = Math.max(1, safeWidth - pad);
		const prefix = this.excludeFromContext ? "!! " : "! ";
		const prefixWidth = prefix.length;
		const commandText = terminalDisplayText(this.command).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const commandWidth = Math.max(1, contentWidth - prefixWidth);
		const wrappedCommand = commandText.split("\n").flatMap((line) => {
			const parts = wrapTextWithAnsi(line, commandWidth);
			return parts.length > 0 ? parts : [""];
		});
		const styledPrefix = theme.fg(this.colorKey, theme.bold(prefix));
		const continuation = " ".repeat(prefixWidth);
		const commandFg = this.excludeFromContext ? "muted" : "userMessageText";
		const rows = wrappedCommand.map((part, index) => {
			const inner = `${index === 0 ? styledPrefix : continuation}${theme.fg(commandFg, part)}`;
			const tinted = this.excludeFromContext ? inner : theme.bg("userMessageBg", inner);
			return finalizeLine(truncateToWidth(`${lead}${tinted}`, safeWidth, "…"), colorOff);
		});
		this.headerCache = { width: safeWidth, pad, colorOff, themeStamp, rows };
		return rows;
	}

	private renderOutputDetailRows(
		safeWidth: number,
		pad: number,
		colorOff: boolean,
		themeStamp: string,
		keybindings: unknown,
	): readonly string[] {
		const cached = this.outputCache;
		if (
			cached &&
			cached.width === safeWidth &&
			cached.pad === pad &&
			cached.colorOff === colorOff &&
			cached.themeStamp === themeStamp &&
			cached.keybindings === keybindings &&
			cached.version === this.contentVersion &&
			cached.expanded === this.expanded &&
			cached.status === this.status
		) {
			return cached.detailRows;
		}
		const expandHint = this.expanded
			? keyHintIfBound("app.tools.expand", "to collapse")
			: keyHintIfBound("app.tools.expand", "to expand");

		const lead = " ".repeat(pad);
		const contentWidth = Math.max(1, safeWidth - pad);
		const detailWidth = Math.max(1, contentWidth - DETAIL_PREFIX.length);
		const tail = this.resolveContextTail();
		const lineCount = tail.end - tail.start;
		const lineAt = (index: number): string =>
			index === tail.start && tail.partialFirstLine !== undefined ? tail.partialFirstLine : this.outputLines[index]!;
		const styleOutputRow = (text: string, logicalIndex: number): string => {
			const isErrorLine = this.status === "error" && (lineCount <= 3 || logicalIndex === tail.end - 1);
			return theme.fg(isErrorLine ? "error" : "toolOutput", text);
		};

		const wrappedDetails: string[] = [];

		if (lineCount > 0) {
			let totalVisualRows = 0;
			for (let i = tail.start; i < tail.end; i++) {
				const line = lineAt(i);
				const bytes =
					i === tail.start && tail.partialFirstLine !== undefined
						? utf8ByteLength(line)
						: this.outputLineBytes[i]!;
				totalVisualRows += measureVisualRows(line, bytes, detailWidth);
			}

			if (!this.expanded && totalVisualRows > COLLAPSED_VISUAL_LINES) {
				const hidden = totalVisualRows - COLLAPSED_VISUAL_LINES;
				const label = `… +${hidden} earlier ${hidden === 1 ? "line" : "lines"}${expandHint ? ` (${expandHint})` : ""}`;
				for (const part of wrapTextWithAnsi(theme.fg("dim", label), detailWidth)) {
					wrappedDetails.push(part.trimEnd());
				}
				// Walk backwards collecting only the tail visual rows needed for the collapsed preview.
				const collected: string[] = [];
				let remaining = COLLAPSED_VISUAL_LINES;
				for (let i = tail.end - 1; i >= tail.start && remaining > 0; i--) {
					const chunkRows = wrapLogicalLine(lineAt(i), detailWidth, remaining);
					for (let r = chunkRows.length - 1; r >= 0 && remaining > 0; r--) {
						collected.push(styleOutputRow(chunkRows[r]!, i).trimEnd());
						remaining--;
					}
				}
				for (let i = collected.length - 1; i >= 0; i--) {
					wrappedDetails.push(collected[i]!);
				}
			} else {
				for (let i = tail.start; i < tail.end; i++) {
					for (const part of wrapLogicalLine(lineAt(i), detailWidth)) {
						wrappedDetails.push(styleOutputRow(part, i).trimEnd());
					}
				}
				if (this.expanded && totalVisualRows > COLLAPSED_VISUAL_LINES && expandHint) {
					for (const part of wrapTextWithAnsi(theme.fg("dim", `(${expandHint})`), detailWidth)) {
						wrappedDetails.push(part.trimEnd());
					}
				}
			}
		}

		if (this.status !== "running") {
			const statusItems: string[] = [];
			if (this.status === "complete" && lineCount === 0) {
				statusItems.push(theme.fg("dim", "(no output)"));
			} else if (this.status === "cancelled") {
				statusItems.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				statusItems.push(theme.fg("error", `exit ${this.exitCode}`));
			}
			const wasTruncated = this.truncationResult?.truncated || tail.truncated;
			if (wasTruncated && this.fullOutputPath) {
				statusItems.push(
					theme.fg("warning", `Output truncated · full output: ${terminalDisplayText(this.fullOutputPath)}`),
				);
			}
			for (const item of statusItems) {
				const parts = wrapTextWithAnsi(item, detailWidth);
				for (const part of parts.length > 0 ? parts : [""]) {
					wrappedDetails.push(part.trimEnd());
				}
			}
		}

		const detailRows = wrappedDetails.map((line, index) => {
			const connector = index === 0 ? DETAIL_FIRST_PREFIX : DETAIL_PREFIX;
			return finalizeLine(truncateToWidth(`${lead}${theme.fg("dim", connector)}${line}`, safeWidth, "…"), colorOff);
		});

		this.outputCache = {
			width: safeWidth,
			pad,
			colorOff,
			themeStamp,
			keybindings,
			version: this.contentVersion,
			expanded: this.expanded,
			status: this.status,
			detailRows,
		};
		return detailRows;
	}

	private renderRunningIndicatorRows(
		safeWidth: number,
		pad: number,
		colorOff: boolean,
		themeStamp: string,
		keybindings: unknown,
		hasPriorDetails: boolean,
	): readonly string[] {
		const frame = atomicWorkingFrame();
		const elapsedSec = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
		const cached = this.indicatorCache;
		if (
			cached &&
			cached.width === safeWidth &&
			cached.pad === pad &&
			cached.colorOff === colorOff &&
			cached.themeStamp === themeStamp &&
			cached.keybindings === keybindings &&
			cached.hasPriorDetails === hasPriorDetails &&
			cached.frame === frame &&
			cached.elapsedSec === elapsedSec
		) {
			return cached.rows;
		}
		const lead = " ".repeat(pad);
		const contentWidth = Math.max(1, safeWidth - pad);
		const detailWidth = Math.max(1, contentWidth - DETAIL_PREFIX.length);
		const elapsedText = elapsedSec >= 1 ? formatWorkingElapsed(elapsedSec * 1000) : undefined;
		const cancelHint = keyHintIfBound("tui.select.cancel", "to cancel");
		const metaParts = [...(elapsedText ? [elapsedText] : []), ...(cancelHint ? [cancelHint] : [])];
		const metaText = metaParts.length > 0 ? theme.fg("dim", ` (${metaParts.join(" · ")})`) : "";
		const indicator = `${atomicWorkingGlyph(frame)} ${theme.fg("muted", "Running…")}${metaText}`;
		const connectorPrefix = `${lead}${theme.fg("dim", hasPriorDetails ? DETAIL_PREFIX : DETAIL_FIRST_PREFIX)}`;
		// Fast path: UTF-16 length of the hint is a sound upper bound on visible width for ASCII/APC hints.
		const plainUpperBound = 10 + (elapsedText ? elapsedText.length + 3 : 0) + (cancelHint ? cancelHint.length : 0);
		let rows: string[];
		if (plainUpperBound <= detailWidth) {
			rows = [finalizeLine(`${connectorPrefix}${indicator}`, colorOff)];
		} else {
			const parts = wrapTextWithAnsi(indicator, detailWidth);
			rows = (parts.length > 0 ? parts : [""]).map((part, index) => {
				const connector = !hasPriorDetails && index === 0 ? DETAIL_FIRST_PREFIX : DETAIL_PREFIX;
				return finalizeLine(
					truncateToWidth(`${lead}${theme.fg("dim", connector)}${part.trimEnd()}`, safeWidth, "…"),
					colorOff,
				);
			});
		}
		this.indicatorCache = {
			width: safeWidth,
			pad,
			colorOff,
			themeStamp,
			keybindings,
			hasPriorDetails,
			frame,
			elapsedSec,
			rows,
		};
		return rows;
	}

	private renderBlock(width: number): string[] {
		if (width < 1) return [];
		const safeWidth = Math.max(1, Math.floor(width));
		const pad = Math.max(0, Math.min(Math.floor(this.outputPad), safeWidth - 1));
		const colorOff = noColor();
		const themeStamp = themeRenderStamp();
		const keybindings = getKeybindings();
		const headerRows = this.renderHeaderRows(safeWidth, pad, colorOff, themeStamp);
		const detailRows = this.renderOutputDetailRows(safeWidth, pad, colorOff, themeStamp, keybindings);
		if (this.status !== "running") {
			return [...headerRows, ...detailRows];
		}
		const indicatorRows = this.renderRunningIndicatorRows(
			safeWidth,
			pad,
			colorOff,
			themeStamp,
			keybindings,
			detailRows.length > 0,
		);
		return [...headerRows, ...detailRows, ...indicatorRows];
	}

	/**
	 * Get the raw output for creating BashExecutionMessage.
	 */
	getOutput(): string {
		return this.outputLines.join("\n");
	}

	/**
	 * Get the command that was executed.
	 */
	getCommand(): string {
		return this.command;
	}
}
