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
import { colorEnvironment } from "../../modes/interactive/theme/color-utils.ts";
import { getGlobalTheme } from "../../modes/interactive/theme/global-theme.ts";
import { CodeHighlighter, type Theme } from "../../modes/interactive/theme/theme.js";
import { getHighlightGrammarRevision } from "../../utils/syntax-highlight.ts";
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
	theme: Theme;
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
	const plain = stripTerminalSequences(line);
	const indent = /^ */.exec(plain)?.[0].length ?? 0;
	let widest = 2;
	if (/[^\x00-\x7f]/u.test(plain))
		for (const { segment } of graphemes(plain)) widest = Math.max(widest, visibleWidth(segment));
	const hang = Math.max(0, Math.min(width - widest, indent + 2, Math.floor(width / 2)));
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

/** Stands for a grapheme wider than an entire source row, where it cannot be drawn intact. */
export const WIDE_CHARACTER_PLACEHOLDER = "\uFFFD";

/** Replace only graphemes too wide for the whole row. */
function placeholdWideCharacters(text: string, width: number): string {
	if (!/[^\x00-\x7f]/u.test(text)) return text;
	let narrowed = "";
	for (const { segment } of graphemes(text))
		narrowed += visibleWidth(segment) > width ? WIDE_CHARACTER_PLACEHOLDER : segment;
	return narrowed;
}

/** Only a mounted, visible folded title needs the delimiter census. */
class ScriptSource {
	readonly code: string | null;
	private index?: ReturnType<typeof scriptPreviewIndex>;
	constructor(code: string | null) {
		this.code = code;
	}
	folded(width: number) {
		// With four cells or fewer, the truncation mark comes before the first digit in `… +N lines`.
		const needCount = width >= 5;
		if (!this.index || (needCount && this.index.omitted === "more"))
			this.index = scriptPreviewIndex(this.code ?? "", needCount);
		return this.index;
	}
}

/** Count logical rows once; retain just the first ten spans, never an array of the hidden source. */
function scriptPreviewIndex(
	text: string,
	needCount: boolean,
): { preview: [number, number][]; omitted: number | "more" } {
	if (needCount && !text.includes("\n") && !text.includes("\r")) return { preview: [[0, text.length]], omitted: 0 };
	// Only control strings can consume line breaks. Jump over their payloads with the display parser.
	const events = /\r\n?|\n|\x1b[PX\x5d-\x5f]|[\x90\x98\x9d-\x9f]/g;
	const nextBreak = () => {
		for (;;) {
			const event = events.exec(text);
			if (!event || event[0][0] === "\n" || event[0][0] === "\r") return event;
			events.lastIndex = afterControlString(text, event[0], events.lastIndex);
		}
	};
	const preview: [number, number][] = [];
	let start = 0;
	while (preview.length < SCRIPT_PREVIEW_LINES) {
		const end = nextBreak();
		preview.push([start, end?.index ?? text.length]);
		if (!end) return { preview, omitted: 0 };
		start = events.lastIndex;
	}
	if (!needCount) return { preview, omitted: "more" };
	let omitted = 1;
	if (text.includes("\n", start) || text.includes("\r", start)) {
		const openers = /\x1b[PX\x5d-\x5f]|[\x90\x98\x9d-\x9f]/g;
		openers.lastIndex = start;
		if (openers.test(text)) {
			while (nextBreak()) omitted++;
		} else {
			const breaks = /\r\n?|\n/g;
			breaks.lastIndex = start;
			while (breaks.test(text)) omitted++;
		}
	}
	return { preview, omitted };
}

/** Step through the bounded payload with the display parser, including its tab and CRLF length rules. */
function afterControlString(text: string, opener: string, start: number): number {
	const parser = new TerminalTextSanitizer();
	parser.write(opener);
	while (start < text.length && parser.inControlString) {
		const begin = start;
		const ch = text[start++];
		if (ch === "\r" && text[start] === "\n") start++;
		if (parser.write(ch === "\r" ? "\n" : ch === "\t" ? "   " : ch).endsWith("\n")) return begin;
	}
	return start;
}

/** Read only enough source to fill the row. Invisible controls and combining marks may take several chunks. */
function foldedLine(code: string, start: number, end: number, width: number, narrow: boolean): string {
	if (width < 1) return "";
	const sanitizer = new TerminalTextSanitizer();
	let text = "";
	let chunk = width + 1;
	while (start < end) {
		let stop = Math.min(end, start + chunk);
		if (stop < end && code.charCodeAt(stop - 1) >= 0xd800 && code.charCodeAt(stop - 1) <= 0xdbff) stop++;
		if (stop < end && code[stop - 1] === "\r" && code[stop] === "\n") stop++;
		text += escapeBidiControls(sanitizer.write(replaceTabs(code.slice(start, stop).replace(/\r\n?/g, "\n"))));
		start = stop;
		if (start === end) text += sanitizer.end();
		const display = narrow ? placeholdWideCharacters(text, 1) : text;
		// No width-cache entries for temporary prefixes. Geometric lookahead makes even a single huge combining
		// cluster linear in its own length, without reaching farther as an offscreen tail grows.
		if (truncateToWidth(display, width, "") !== display)
			return `${stripTerminalSequences(truncateToWidth(display, width - 1, ""))}…`;
		if (start === end) return display;
		chunk *= 2;
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
	private timeRowWidth?: number;
	private readonly highlighter = new CodeHighlighter();
	private last?: {
		width: number;
		metadataWidth: number;
		running: boolean;
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
	render(width: number, metadataWidth?: number, running = false): string[] {
		if (width < 1) return [];
		// A foreign title wrapper gets the normal component contract: a one-row summary, not flattened source rows.
		if (metadataWidth === undefined) return new CodemodeCall(this.source.code, this.theme).render(width);
		const theme = getGlobalTheme();
		const colors = process.env.NO_COLOR === undefined && !colorEnvironment().off;
		const languages = colors ? getHighlightGrammarRevision() : 0;
		const folded = this.expanded ? undefined : this.source.folded(Math.max(1, width - indentWithin(width, 2)));
		const hint = folded?.omitted && folded.omitted !== "more" ? keyHintIfBound("app.tools.expand", "to expand") : "";
		const last = this.last;
		if (
			last &&
			last.width === width &&
			last.metadataWidth === metadataWidth &&
			last.running === running &&
			last.colors === colors &&
			last.theme === theme &&
			last.languages === languages &&
			last.hint === hint
		)
			return last.rows;
		const rows = this.layout(width, metadataWidth, colors, hint, running, folded);
		this.last = { width, metadataWidth, running, colors, theme, languages, hint, rows };
		return rows;
	}
	private layout(
		width: number,
		metadataWidth: number,
		colors: boolean,
		hint: string,
		running: boolean,
		folded?: ReturnType<typeof scriptPreviewIndex>,
	): string[] {
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
		const omitted = folded?.omitted;
		let preview: string;
		if (!folded) {
			preview = scriptSource(code);
			preview = placeholdWideCharacters(preview, codeWidth);
		} else {
			const room = folded.preview.length === 1 ? inlineWidth : codeWidth;
			preview = folded.preview.map(([start, end]) => foldedLine(code, start, end, room, codeWidth === 1)).join("\n");
		}
		const lines = colors ? this.highlighter.highlight(preview, "javascript") : preview.split("\n");
		if (lines.length === 1) {
			const inline = `${open}${lines[0]}${close}`;
			if (!this.expanded) return [truncateToWidth(inline, titleWidth, "…")];
			if (visibleWidth(inline) <= width) {
				// A clock tick must not move code out from under a mouse selection. Put the time on its own row if needed.
				// Reserve its row before the first tick as well: details below the title may already be selected.
				// Even the full span of representable JS dates has at most ten hours digits.
				const timeRoom = running && width >= 13 ? " · 4800000000h 59m".length : metadataWidth;
				if (visibleWidth(inline) + timeRoom > width) this.timeRowWidth = width;
				// Settling this same call must not move its following rows under an in-flight selection either.
				return this.timeRowWidth === width ? [inline, ""] : [inline];
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
		if (!state.cache || state.cache.source.code !== code || state.cache.theme !== theme)
			state.cache = { source: new ScriptSource(code), theme };
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
			const sourceRecord = () => {
				const state = context.state as CodemodeRenderState;
				state.scriptHighlighter ??= new CodeHighlighter();
				return new Text(
					state.scriptHighlighter.highlight(terminalDisplayText(replaceTabs(code)), "javascript").join("\n"),
					0,
					0,
				);
			};
			if (layout?.open && layout.source.code === code && layout.open === transcript?.title) {
				// An extension may wrap this result in a whole replacement block. The host knows whether it mounted
				// the script title only after the result renderer returns; do not omit source on its promise alone.
				const title = layout.open;
				let record: Text | undefined;
				records.push({
					invalidate: () => record?.invalidate(),
					render(width) {
						if (transcript.mounted === title) return [];
						record ??= sourceRecord();
						return record.render(width);
					},
				});
			} else records.push(sourceRecord());
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
