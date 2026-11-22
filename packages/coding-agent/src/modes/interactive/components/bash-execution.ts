/**
 * Component for displaying inline `!` / `!!` bash-mode command execution in Atomic's shell block family.
 */

import {
	type Component,
	Container,
	Spacer,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import { replaceTabs } from "../../../core/tools/render-utils.ts";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	type TruncationResult,
	truncateTail,
} from "../../../core/tools/truncate.ts";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import { theme } from "../theme/theme.js";
import { atomicWorkingGlyph, watchAtomicWorkingClock } from "./atomic-working-status.ts";
import { keyHintIfBound } from "./keybinding-hints.js";
import { DETAIL_FIRST_PREFIX, DETAIL_PREFIX } from "./notice-line.ts";
import { collapseToolBlockLines, TOOL_BLOCK_LIMITS } from "./tool-block.ts";
import { blockRows, type RowRange, rowsFrom } from "./transcript-block-clicks.ts";
import { formatWorkingElapsed } from "./working-run-meter.ts";

function noColor(): boolean {
	return process.env.NO_COLOR !== undefined;
}

export class BashExecutionComponent extends Container {
	readonly expandsOnClick = true;
	private command: string;
	private outputLines: string[] = [];
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
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

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
				this.cachedWidth = undefined;
				this.cachedLines = undefined;
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
		this.expanded = expanded;
		this.invalidateCache();
	}

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Its rows: an expand hint in them is part of the block, which a click on it expands or collapses. */
	override render(width: number): string[] {
		return blockRows(super.render(width));
	}

	/** Every row of the block below the spacer it starts with. */
	clickArea(width: number): RowRange | undefined {
		const [spacer] = this.children;
		return rowsFrom(spacer?.render(width).length ?? 0, this.render(width).length);
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.invalidateCache();
	}

	override invalidate(): void {
		this.invalidateCache();
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

		// Append to output lines
		const newLines = clean.split("\n");
		if (this.outputLines.length > 0 && newLines.length > 0) {
			// Append first chunk to last line (incomplete line continuation)
			this.outputLines[this.outputLines.length - 1] += newLines[0];
			this.outputLines.push(...newLines.slice(1));
		} else {
			this.outputLines.push(...newLines);
		}

		this.invalidateCache();
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
		this.invalidateCache();
	}

	private invalidateCache(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private syncWorkingClock(): void {
		if (!this.disposed && this.status === "running") {
			this.stopWorkingClock ??= watchAtomicWorkingClock(() => {
				if (this.disposed || this.status !== "running") {
					this.stopWorkingClock?.();
					this.stopWorkingClock = undefined;
					return;
				}
				this.invalidateCache();
				this.ui.requestRender();
			});
		} else {
			this.stopWorkingClock?.();
			this.stopWorkingClock = undefined;
		}
	}

	private renderBlock(width: number): string[] {
		if (width < 1) return [];
		if (this.status !== "running" && this.cachedLines !== undefined && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const safeWidth = Math.max(1, Math.floor(width));
		const pad = Math.max(0, Math.min(Math.floor(this.outputPad), safeWidth - 1));
		const lead = " ".repeat(pad);
		const contentWidth = Math.max(1, safeWidth - pad);
		const prefix = this.excludeFromContext ? "!! " : "! ";
		const prefixWidth = prefix.length;

		// Header: `! <command>` (or `!! <command>`), wrapped cleanly with continuation under command text.
		const commandText = terminalDisplayText(this.command).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		const commandWidth = Math.max(1, contentWidth - prefixWidth);
		const wrappedCommand = commandText.split("\n").flatMap((line) => {
			const parts = wrapTextWithAnsi(line, commandWidth);
			return parts.length > 0 ? parts : [""];
		});
		const styledPrefix = theme.fg(this.colorKey, theme.bold(prefix));
		const continuation = " ".repeat(prefixWidth);
		const commandFg = this.excludeFromContext ? "muted" : "userMessageText";
		const headerRows = wrappedCommand.map((part, index) => {
			const inner = `${index === 0 ? styledPrefix : continuation}${theme.fg(commandFg, part)}`;
			const tinted = this.excludeFromContext ? inner : theme.bg("userMessageBg", inner);
			return truncateToWidth(`${lead}${tinted}`, safeWidth, "…");
		});

		// Apply LLM context truncation limits (same limits as bash tool).
		const fullOutput = this.outputLines.join("\n");
		const contextTruncation = truncateTail(fullOutput, {
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		});
		const trimmedContent = contextTruncation.content.replace(/\n+$/, "");
		const availableLines = trimmedContent ? trimmedContent.split("\n") : [];

		// Build logical detail lines for the `  ⎿  ` / `     ` family.
		const detailItems: string[] = [];
		if (availableLines.length > 0) {
			const styledLines = availableLines.map((line, index) => {
				const isErrorLine =
					this.status === "error" && (availableLines.length <= 3 || index === availableLines.length - 1);
				return theme.fg(isErrorLine ? "error" : "toolOutput", replaceTabs(line));
			});
			detailItems.push(...collapseToolBlockLines(styledLines, TOOL_BLOCK_LIMITS.bash, this.expanded, true));
			if (this.expanded && availableLines.length > TOOL_BLOCK_LIMITS.bash) {
				const collapseHint = keyHintIfBound("app.tools.expand", "to collapse");
				if (collapseHint) detailItems.push(theme.fg("dim", `(${collapseHint})`));
			}
		}

		if (this.status === "running") {
			const elapsedMs = Date.now() - this.startedAt;
			const elapsedText = elapsedMs >= 1000 ? formatWorkingElapsed(elapsedMs) : undefined;
			const cancelHint = keyHintIfBound("tui.select.cancel", "to cancel");
			const metaParts = [...(elapsedText ? [elapsedText] : []), ...(cancelHint ? [cancelHint] : [])];
			const metaText = metaParts.length > 0 ? theme.fg("dim", ` (${metaParts.join(" · ")})`) : "";
			detailItems.push(`${atomicWorkingGlyph()} ${theme.fg("muted", "Running…")}${metaText}`);
		} else {
			if (this.status === "complete" && availableLines.length === 0) {
				detailItems.push(theme.fg("dim", "(no output)"));
			} else if (this.status === "cancelled") {
				detailItems.push(theme.fg("warning", "(cancelled)"));
			} else if (this.status === "error") {
				detailItems.push(theme.fg("error", `exit ${this.exitCode}`));
			}
			const wasTruncated = this.truncationResult?.truncated || contextTruncation.truncated;
			if (wasTruncated && this.fullOutputPath) {
				detailItems.push(
					theme.fg("warning", `Output truncated · full output: ${terminalDisplayText(this.fullOutputPath)}`),
				);
			}
		}

		const detailWidth = Math.max(1, contentWidth - DETAIL_PREFIX.length);
		const wrappedDetails: string[] = [];
		for (const item of detailItems) {
			const parts = wrapTextWithAnsi(item, detailWidth);
			for (const part of parts.length > 0 ? parts : [""]) {
				wrappedDetails.push(part.trimEnd());
			}
		}
		const detailRows = wrappedDetails.map((line, index) => {
			const connector = index === 0 ? DETAIL_FIRST_PREFIX : DETAIL_PREFIX;
			return truncateToWidth(`${lead}${theme.fg("dim", connector)}${line}`, safeWidth, "…");
		});

		const rows = [...headerRows, ...detailRows].map((line) => (noColor() ? stripTerminalSequences(line) : line));
		if (this.status !== "running") {
			this.cachedWidth = width;
			this.cachedLines = rows;
		}
		return rows;
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
