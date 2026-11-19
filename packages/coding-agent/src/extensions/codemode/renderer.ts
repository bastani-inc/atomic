import {
	type Component,
	Container,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import { getTextOutput, replaceTabs, str } from "../../core/tools/render-utils.ts";
import { keyHintIfBound } from "../../modes/interactive/components/keybinding-hints.js";
import {
	collapseToolBlockLines,
	getTranscriptTitleLayout,
	TOOL_BLOCK_LIMITS,
	ToolBlock,
	ToolBlockGroup,
	ToolBlockRecords,
	type ToolBlockTitleRows,
	type TranscriptTitleLayout,
} from "../../modes/interactive/components/tool-block.ts";
import {
	builtinToolBlockPresentation,
	formatToolBlockElapsed,
} from "../../modes/interactive/components/tool-block-families.ts";
import { getGlobalTheme } from "../../modes/interactive/theme/global-theme.ts";
import { CodeHighlighter, type Theme } from "../../modes/interactive/theme/theme.js";
import { getHighlightLanguageCount } from "../../utils/syntax-highlight.ts";
import {
	escapeBidiControls,
	singleLineDisplayText,
	TerminalTextSanitizer,
	terminalDisplayText,
} from "../../utils/terminal-text.ts";
import type { CodemodeNestedCall, CodemodeToolDetails, codemodeSchema } from "./tool.js";

interface CodemodeRenderState {
	scriptHighlighter?: CodeHighlighter;
}
type ScriptLayout = TranscriptTitleLayout<{
	source: ScriptSource;
	folded?: CodemodeScriptTitle;
	open?: CodemodeScriptTitle;
}>;

const SCRIPT_HEADER = /^Script (completed|failed)\nWall time [\d.]+ seconds\nOutput:\n$/;
const NESTED_CALL_LIMIT = 8;
const SCRIPT_PREVIEW_LINES = 10;

function indentWithin(width: number, indent: number): number {
	return Math.max(0, Math.min(indent, width - 2));
}

/** Apply the terminal's tab and control-character rules, without trimming source rows. */
function scriptSource(code: string): string {
	return terminalDisplayText(replaceTabs(code.replace(/\r\n?/g, "\n")));
}

/**
 * A script line in rows of `width`: rows after the first hang under the line, two columns past its indent, without
 * leaving them narrower than a wide character. A character that does not fit at the end of a row starts the next one.
 */
function wrapScriptLine(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const indent = /^ */.exec(stripTerminalSequences(line))?.[0].length ?? 0;
	const hang = indentWithin(width, Math.min(indent + 2, Math.floor(width / 2)));
	const room = width - hang;
	// Prose wrapping drops word separators. Break at cell boundaries ourselves so spaces inside literals survive;
	// the TUI then carries the highlight colours across the inserted newlines without reflowing the text.
	const parts: string[] = [];
	let used = 0;
	for (const word of line.match(/\s+|\S+/gu) ?? []) {
		const size = visibleWidth(word);
		if (used && used + size > room && word.trim()) {
			parts.push("\n");
			used = 0;
		}
		if (used + size <= room) {
			parts.push(word);
			used += size;
			continue;
		}
		// Only SGR from the syntax highlighter remains after terminalDisplayText.
		for (const token of word.split(/(\x1b\[[\d;]*m)/u)) {
			if (token.startsWith("\x1b")) parts.push(token);
			else
				for (const { segment } of graphemes(token)) {
					const cells = visibleWidth(segment);
					if (used + cells > room) {
						parts.push("\n");
						used = 0;
					}
					parts.push(segment);
					used += cells;
				}
		}
	}
	return wrapTextWithAnsi(parts.join(""), room).map((row, index) => (index === 0 ? row : `${" ".repeat(hang)}${row}`));
}

let segmenter: Intl.Segmenter | undefined;
function graphemes(text: string): Intl.Segments {
	segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
	return segmenter.segment(text);
}

/** Stands for a character two columns wide on rows one column wide, where it cannot be drawn. */
export const WIDE_CHARACTER_PLACEHOLDER = "\uFFFD";

/** `text` with each character wider than one column replaced by {@link WIDE_CHARACTER_PLACEHOLDER}. */
function placeholdWideCharacters(text: string): string {
	let narrowed = "";
	for (const { segment } of graphemes(text))
		narrowed += visibleWidth(segment) > 1 ? WIDE_CHARACTER_PLACEHOLDER : segment;
	return narrowed;
}

/** Index line boundaries once per argument snapshot. Keep only the ten spans needed for a folded paint. */
class ScriptSource {
	readonly code: string | null;
	readonly preview: [number, number][] = [];
	readonly omitted: number;
	constructor(code: string | null) {
		this.code = code;
		const text = code ?? "";
		let start = 0;
		const breaks = /\r\n?|\n/g;
		while (this.preview.length < SCRIPT_PREVIEW_LINES) {
			const next = breaks.exec(text);
			this.preview.push([start, next?.index ?? text.length]);
			if (!next) {
				this.omitted = 0;
				return;
			}
			start = breaks.lastIndex;
		}
		// An exact omission count needs the delimiters, not the contents or a string/array per hidden line.
		let omitted = 1;
		while (breaks.test(text)) omitted++;
		this.omitted = omitted;
	}
}

/** Read only enough source to fill the row. Invisible controls and combining marks may take several chunks. */
function foldedLine(code: string, start: number, end: number, width: number, narrow: boolean): string {
	if (width < 1) return "";
	const sanitizer = new TerminalTextSanitizer();
	let text = "";
	const chunk = width + 1;
	while (start < end) {
		let stop = Math.min(end, start + chunk);
		if (stop < end && code.charCodeAt(stop - 1) >= 0xd800 && code.charCodeAt(stop - 1) <= 0xdbff) stop++;
		text += escapeBidiControls(sanitizer.write(replaceTabs(code.slice(start, stop))));
		start = stop;
		if (start === end) text += sanitizer.end();
		const display = narrow ? placeholdWideCharacters(text) : text;
		if (start === end || visibleWidth(display) > width) {
			// truncateToWidth closes ANSI styles; the JavaScript lexer needs plain source, not those resets.
			return visibleWidth(display) <= width ? display : stripTerminalSequences(truncateToWidth(display, width, "…"));
		}
	}
	return text;
}

/**
 * The call with its script as the argument, highlighted as JavaScript. A one-line script stays on the title row:
 * collapsed it is cut to fit, expanded it moves under `codemode(` when it does not fit. A longer script opens
 * `codemode(`, shows its lines indented under it, and closes with `)`; collapsed shows the first lines, cut to the
 * width, and expanded shows every line, wrapped under itself.
 */
class CodemodeScriptTitle implements ToolBlockTitleRows {
	private readonly source: ScriptSource;
	private readonly theme: Theme;
	private readonly expanded: boolean;
	private readonly highlighter = new CodeHighlighter();
	private last?: {
		width: number;
		metadataWidth: number;
		colors: boolean;
		theme?: Theme;
		languages: number;
		hint: string;
		rows: string[];
	};
	constructor(source: ScriptSource, theme: Theme, expanded: boolean) {
		this.source = source;
		this.theme = theme;
		this.expanded = expanded;
	}
	invalidate(): void {
		this.last = undefined;
	}
	render(width: number, metadataWidth = 0): string[] {
		if (width < 1) return [];
		const colors = process.env.NO_COLOR === undefined;
		const theme = getGlobalTheme();
		const languages = colors ? getHighlightLanguageCount() : 0;
		const hint = !this.expanded && this.source.omitted ? keyHintIfBound("app.tools.expand", "to expand") : "";
		const last = this.last;
		if (
			last &&
			last.width === width &&
			last.metadataWidth === metadataWidth &&
			last.colors === colors &&
			last.theme === theme &&
			last.languages === languages &&
			last.hint === hint
		)
			return last.rows;
		const rows = this.layout(width, metadataWidth, colors, hint);
		this.last = { width, metadataWidth, colors, theme, languages, hint, rows };
		return rows;
	}
	private layout(width: number, metadataWidth: number, colors: boolean, hint: string): string[] {
		const name = this.theme.fg("toolTitle", this.theme.bold("codemode"));
		const open = `${name}${this.theme.fg("text", "(")}`;
		const close = this.theme.fg("text", ")");
		const titleWidth = Math.max(0, width - metadataWidth);
		const inlineWidth = Math.max(0, titleWidth - 10);
		const code = this.source.code;
		if (code === null) return [truncateToWidth(`${open}[invalid arg]${close}`, titleWidth, "…")];
		// Under `codemode(`, the script is indented two columns unless that leaves it narrower than a wide character.
		const indent = indentWithin(width, 2);
		const codeWidth = Math.max(1, width - indent);
		// Rows one column wide cannot hold a wide character: it shows as a placeholder rather than not at all.
		const omitted = this.expanded ? 0 : this.source.omitted;
		let preview: string;
		if (this.expanded) {
			preview = scriptSource(code);
			if (codeWidth === 1) preview = placeholdWideCharacters(preview);
		} else {
			const room = this.source.preview.length === 1 ? inlineWidth : codeWidth;
			preview = this.source.preview
				.map(([start, end]) => foldedLine(code, start, end, room, codeWidth === 1))
				.join("\n");
		}
		const lines = colors ? this.highlighter.highlight(preview, "javascript") : preview.split("\n");
		if (lines.length === 1) {
			const inline = `${open}${lines[0]}${close}`;
			if (!this.expanded) return [truncateToWidth(inline, titleWidth, "…")];
			if (visibleWidth(inline) <= width) {
				// A clock tick must not move code out from under a mouse selection. Put the time on its own row if needed.
				return visibleWidth(inline) + metadataWidth > width && metadataWidth <= width ? [inline, ""] : [inline];
			}
		}
		const rows = this.expanded
			? lines.flatMap((line) => wrapScriptLine(line, codeWidth))
			: lines.map((line) => truncateToWidth(line, codeWidth, "…"));
		if (omitted) {
			rows.push(
				this.theme.fg("dim", `… +${omitted} ${omitted === 1 ? "line" : "lines"}${hint ? ` (${hint})` : ""}`),
			);
		}
		const margin = " ".repeat(indent);
		return [open, ...rows.map((row) => `${margin}${row}`), close].map((row) => truncateToWidth(row, width, "…"));
	}
}

class CodemodeCall implements Component {
	private readonly code: string | null;
	private readonly theme: Theme;
	constructor(code: string | null, theme: Theme) {
		this.code = code;
		this.theme = theme;
	}
	invalidate(): void {}
	render(width: number): string[] {
		if (width < 1) return [];
		const code = this.code === null ? "[invalid arg]" : singleLineDisplayText(this.code.split("\n")[0]);
		const summary = `${code}${this.code?.includes("\n") ? "…" : ""}`;
		const name = this.theme.fg("toolTitle", this.theme.bold("codemode"));
		return [truncateToWidth(`${name}(${truncateToWidth(summary, Math.max(0, width - 10), "…")})`, width, "…")];
	}
}

function cost(value: number): string {
	return `$${value >= 0.01 ? value.toFixed(2) : value.toPrecision(2)}`;
}

function outputPreview(text: string, expanded: boolean): Component {
	const component = new Text(text, 0, 0);
	return {
		invalidate: () => component.invalidate(),
		render: (width) => collapseToolBlockLines(component.render(width), TOOL_BLOCK_LIMITS.bash, expanded),
	};
}

function nestedCall(call: CodemodeNestedCall, theme: Theme, expanded: boolean, cwd: string): ToolBlock {
	let args: unknown;
	try {
		args = JSON.parse(call.args);
	} catch {
		args = undefined;
	}
	const presentation = builtinToolBlockPresentation({
		toolName: call.name,
		args,
		expanded: false,
		isPartial: false,
		cwd,
		executionStarted: true,
		argsComplete: true,
	});
	const records: Component[] = [];
	if (expanded && call.args) records.push(new Text(terminalDisplayText(replaceTabs(call.args)), 0, 0));
	if (call.error)
		records.push(outputPreview(theme.fg("error", terminalDisplayText(replaceTabs(call.error))), expanded));
	const meta: string[] = [];
	const elapsed = formatToolBlockElapsed(call.durationMs, {
		isRunning: call.status === "running",
		subTenDecimal: call.name === "bash" || call.name === "fetch_content",
	});
	if (elapsed) meta.push(elapsed);
	if (call.cost !== undefined) meta.push(cost(call.cost));
	return new ToolBlock({
		status:
			call.status === "ok"
				? "success"
				: call.status === "error"
					? "failure"
					: call.status === "cancelled"
						? "stopped"
						: "running",
		title: presentation?.title ?? singleLineDisplayText(call.name),
		args: presentation?.args ?? singleLineDisplayText(call.args),
		meta,
		details: records.length ? new ToolBlockRecords(records) : undefined,
		outputPad: 0,
	});
}

export const codemodeRenderers: Pick<
	ToolDefinition<typeof codemodeSchema, CodemodeToolDetails>,
	"renderCall" | "renderResult"
> = {
	renderCall(args, theme, context) {
		const code = str(args?.code);
		const state = getTranscriptTitleLayout(context) as ScriptLayout | undefined;
		if (!state) return new CodemodeCall(code, theme);
		if (!state.cache || state.cache.source.code !== code) state.cache = { source: new ScriptSource(code) };
		const layout = state.cache;
		const slot = context.expanded ? "open" : "folded";
		layout[slot] ??= new CodemodeScriptTitle(layout.source, theme, context.expanded);
		const title = layout[slot];
		state.title = title;
		return title;
	},
	renderResult(result, options, theme, context) {
		const records: Component[] = [];
		const code = str(context.args?.code);
		if (options.expanded && code) {
			const transcript = getTranscriptTitleLayout(context) as ScriptLayout | undefined;
			const layout = transcript?.cache;
			// Only the returned expanded title for these actual arguments replaces the standard source record.
			if (!layout?.open || layout.source.code !== code || layout.open !== transcript?.title) {
				const state = context.state as CodemodeRenderState;
				state.scriptHighlighter ??= new CodeHighlighter();
				records.push(
					new Text(
						state.scriptHighlighter.highlight(terminalDisplayText(replaceTabs(code)), "javascript").join("\n"),
						0,
						0,
					),
				);
			}
		}
		const calls = result.details?.calls ?? [];
		if (calls.length) {
			const shown = options.expanded ? calls : calls.slice(-NESTED_CALL_LIMIT);
			const nested = new Container();
			if (shown.length < calls.length) {
				const binding = keyHintIfBound("app.tools.expand", "to expand");
				nested.addChild(
					new Text(
						theme.fg("dim", `… +${calls.length - shown.length} earlier calls${binding ? ` (${binding})` : ""}`),
						0,
						0,
					),
				);
			}
			nested.addChild(
				new ToolBlockGroup(shown.map((call) => nestedCall(call, theme, options.expanded, context.cwd))),
			);
			records.push(nested);
			const priced = calls.filter((call) => call.cost !== undefined);
			if (priced.length > 1)
				records.push(
					new Text(
						theme.fg("muted", `Model calls: ${cost(priced.reduce((sum, call) => sum + (call.cost ?? 0), 0))}`),
						0,
						0,
					),
				);
		}
		const [first, ...rest] = result.content;
		const content = first?.type === "text" && SCRIPT_HEADER.test(first.text) ? rest : result.content;
		const output = options.isPartial ? "" : getTextOutput({ ...result, content }, context.showImages).trim();
		if (output) {
			const styled = terminalDisplayText(replaceTabs(output))
				.split("\n")
				.map((line) => theme.fg(context.isError ? "error" : "toolOutput", line))
				.join("\n");
			records.push(outputPreview(styled, options.expanded));
		}
		if (result.details?.fullOutputPath)
			records.push(
				new Text(theme.fg("muted", `Full output: ${terminalDisplayText(result.details.fullOutputPath)}`), 0, 0),
			);
		return new ToolBlockRecords(records);
	},
};
