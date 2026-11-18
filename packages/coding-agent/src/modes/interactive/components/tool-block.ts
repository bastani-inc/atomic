import {
	type Component,
	type DefaultTextStyle,
	Markdown,
	type MarkdownTheme,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@bastani/atomic-tui";
import { terminalDisplayText } from "../../../utils/terminal-text.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { atomicWorkingGlyph } from "./atomic-working-status.ts";
import { keyHintIfBound } from "./keybinding-hints.js";
import { DETAIL_FIRST_PREFIX, DETAIL_PREFIX, type NoticeStatus, STATUS_MARKERS } from "./notice-line.ts";

export type ToolBlockStatus = NoticeStatus;
export type ToolGroupFamily = "read" | "search" | "find" | "list" | "bash";
export type ToolGroupRole =
	| { readonly kind: "standalone" }
	| { readonly kind: "hidden" }
	| {
			readonly kind: "head";
			readonly clauses: readonly { readonly family: ToolGroupFamily; readonly count: number }[];
	  };
export interface ToolBlockSpec {
	readonly status: ToolBlockStatus;
	readonly title: string | Component;
	readonly args?: string;
	readonly meta?: readonly string[];
	readonly details?: Component;
	readonly body?: Component;
	readonly outputPad?: number;
}

/**
 * A call title that may span rows, such as a script shown as the call's argument. When it renders more than one row,
 * the first row follows the status glyph, the other rows sit under the title, and the metadata ends the last row.
 */
export interface ToolBlockTitleRows extends Component {
	readonly toolBlockTitleRows: true;
}

function keepsTitleRows(title: string | Component): title is ToolBlockTitleRows {
	return typeof title !== "string" && "toolBlockTitleRows" in title && title.toolBlockTitleRows === true;
}

export const TOOL_BLOCK_LIMITS = {
	bash: 5,
	script: 10,
	search: 8,
	paths: 8,
	diff: 12,
	todo: 6,
	web: 3,
	inbound: 3,
	agent: 1,
} as const;

function noColor(): boolean {
	return process.env.NO_COLOR !== undefined;
}

function inlineText(value: string): string {
	return terminalDisplayText(value)
		.replace(/[\r\n\t]+/g, " ")
		.trim();
}

function renderedTitle(title: Component, width: number): string {
	if (width < 1) return "";
	return title
		.render(width)
		.map((line) => line.trimEnd())
		.join(" ")
		.trim();
}

function shortenedTitle(title: string, width: number): string {
	if (visibleWidth(title) <= width) return title;
	const closing = title.lastIndexOf(")");
	const plain = stripTerminalSequences(title);
	const opening = plain.indexOf("(");
	if (opening > 0 && !/\s/u.test(plain[opening - 1] ?? "") && closing > 0) {
		const suffix = title.slice(closing);
		const room = width - visibleWidth(suffix);
		if (room > 0) return `${truncateToWidth(title.slice(0, closing), room, "…")}${suffix}`;
	}
	return truncateToWidth(title, width, "…");
}

export function collapseToolBlockLines(
	lines: readonly string[],
	limit: number,
	expanded: boolean,
	tail = false,
): string[] {
	const count = Math.max(0, Math.floor(limit));
	if (expanded || lines.length <= count) return [...lines];
	const omitted = lines.length - count;
	const hint = keyHintIfBound("app.tools.expand", "to expand");
	const label = `… +${omitted} ${tail ? "earlier " : ""}${omitted === 1 ? "line" : "lines"}${hint ? ` (${hint})` : ""}`;
	const note = theme.fg("dim", label);
	return tail ? [note, ...lines.slice(lines.length - count)] : [...lines.slice(0, count), note];
}

export function componentNeedsWorkingClock(component: Component | undefined): boolean {
	return (
		component !== undefined &&
		"isWorking" in component &&
		typeof component.isWorking === "function" &&
		component.isWorking() === true
	);
}

export class ToolBlockRecords implements Component {
	readonly toolBlockKind = "records";
	private readonly records: readonly (string | Component)[];
	private readonly options: { preserveConnectors?: boolean };
	isWorking(): boolean {
		return this.records.some((record) => typeof record !== "string" && componentNeedsWorkingClock(record));
	}
	constructor(records: readonly (string | Component)[], options: { preserveConnectors?: boolean } = {}) {
		this.records = records;
		this.options = options;
	}
	invalidate(): void {
		for (const record of this.records) if (typeof record !== "string") record.invalidate();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const contentWidth = Math.max(1, width - DETAIL_PREFIX.length);
		return this.records.flatMap((record) => {
			const component = typeof record === "string" ? new Text(theme.fg("toolOutput", record), 0, 0) : record;
			const lines = component.render(contentWidth);
			if (
				this.options.preserveConnectors &&
				typeof record !== "string" &&
				stripTerminalSequences(lines[0] ?? "").startsWith(DETAIL_FIRST_PREFIX) &&
				lines.slice(1).every((line) => line.trim() === "" || stripTerminalSequences(line).startsWith(DETAIL_PREFIX))
			)
				return component.render(width).map((line) => truncateToWidth(line, width, "…"));
			return lines.map((line, index) => {
				const prefix = index === 0 ? DETAIL_FIRST_PREFIX : DETAIL_PREFIX;
				return truncateToWidth(`${theme.fg("dim", prefix)}${line.trimEnd()}`, width, "…");
			});
		});
	}
}

export class ToolBlock implements Component {
	readonly toolBlockKind = "block";
	private readonly spec: ToolBlockSpec;
	isWorking(): boolean {
		return (
			this.spec.status === "running" ||
			componentNeedsWorkingClock(this.spec.details) ||
			componentNeedsWorkingClock(this.spec.body)
		);
	}
	constructor(spec: ToolBlockSpec) {
		this.spec = spec;
	}
	invalidate(): void {
		if (typeof this.spec.title !== "string") this.spec.title.invalidate();
		this.spec.body?.invalidate();
		this.spec.details?.invalidate();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const pad = Math.max(0, Math.min(Math.floor(this.spec.outputPad ?? 1), Math.floor(width) - 1));
		const contentWidth = Math.max(1, Math.floor(width) - pad);
		const marker = STATUS_MARKERS[this.spec.status];
		const glyph =
			this.spec.status === "running" && !noColor() ? atomicWorkingGlyph() : theme.fg(marker.color, marker.glyph);
		const titleWidth = Math.max(0, contentWidth - 2);
		const meta = [...(this.spec.meta ?? [])].filter((part) => visibleWidth(part) > 0);
		const metaText = () => meta.map((part) => ` · ${part}`).join("");
		const titleRows = keepsTitleRows(this.spec.title)
			? this.titleRows(this.spec.title, titleWidth, visibleWidth(metaText()))
			: undefined;
		if (titleRows) {
			const last = titleRows.length - 1;
			while (meta.length > 0 && visibleWidth(titleRows[last] ?? "") + visibleWidth(metaText()) > titleWidth)
				meta.pop();
			return this.withBody(
				titleRows.map((row, index) =>
					truncateToWidth(
						`${index === 0 ? `${glyph} ` : "  "}${row}${index === last ? theme.fg("dim", metaText()) : ""}`,
						contentWidth,
						"…",
					),
				),
				contentWidth,
				pad,
			);
		}
		const titleText =
			typeof this.spec.title === "string" ? inlineText(this.spec.title) : renderedTitle(this.spec.title, titleWidth);
		const args = this.spec.args === undefined ? undefined : inlineText(this.spec.args);
		const minimumTitle =
			typeof this.spec.title === "string"
				? visibleWidth(titleText) + (args === undefined ? 0 : 2 + (args.length > 0 ? 1 : 0))
				: Math.min(visibleWidth(titleText), 8);
		while (meta.length > 0 && minimumTitle + visibleWidth(metaText()) > titleWidth) meta.pop();
		const availableTitle = Math.max(0, titleWidth - visibleWidth(metaText()));
		let title: string;
		if (typeof this.spec.title === "string") {
			const name = theme.fg("toolTitle", theme.bold(titleText));
			if (args === undefined) title = truncateToWidth(name, availableTitle, "…");
			else {
				const argumentWidth = Math.max(0, availableTitle - visibleWidth(titleText) - 2);
				title = `${name}${theme.fg("text", `(${truncateToWidth(args, argumentWidth, "…")})`)}`;
				title = truncateToWidth(title, availableTitle, "…");
			}
		} else
			title = shortenedTitle(
				availableTitle === titleWidth ? titleText : renderedTitle(this.spec.title, availableTitle),
				availableTitle,
			);
		const header = truncateToWidth(`${glyph} ${title}${theme.fg("dim", metaText())}`, contentWidth, "…");
		return this.withBody([header], contentWidth, pad);
	}

	/**
	 * The title's rows when it spans several, or undefined when it fits one row, which the caller lays out as usual. A
	 * title that fits alone but not beside its metadata is asked again with that room left over.
	 */
	private titleRows(title: ToolBlockTitleRows, width: number, metaWidth: number): string[] | undefined {
		const rows = title.render(width);
		if (rows.length > 1) return rows;
		if (metaWidth === 0 || visibleWidth(rows[0] ?? "") + metaWidth <= width) return undefined;
		const narrower = title.render(Math.max(1, width - metaWidth));
		return narrower.length > 1 ? narrower : undefined;
	}

	private withBody(header: readonly string[], contentWidth: number, pad: number): string[] {
		const rows = [...header];
		if (this.spec.body) {
			const bodyWidth = Math.max(1, contentWidth - 2);
			for (const line of this.spec.body.render(bodyWidth)) {
				rows.push(truncateToWidth(`  ${line.trimEnd()}`, contentWidth, "…"));
			}
		}
		if (this.spec.details) {
			const records =
				"toolBlockKind" in this.spec.details && this.spec.details.toolBlockKind === "records"
					? this.spec.details
					: new ToolBlockRecords([this.spec.details]);
			for (const line of records.render(contentWidth)) rows.push(line);
		}
		return rows.map((line) => {
			const result = `${" ".repeat(pad)}${line}`;
			return noColor() ? stripTerminalSequences(result) : result;
		});
	}
}

export class ToolBlockGroup implements Component {
	readonly toolBlockKind = "group";
	private readonly blocks: readonly ToolBlock[];
	isWorking(): boolean {
		return this.blocks.some((block) => block.isWorking());
	}
	constructor(blocks: readonly ToolBlock[]) {
		this.blocks = blocks;
	}
	invalidate(): void {
		for (const block of this.blocks) block.invalidate();
	}
	render(width: number): string[] {
		const rows: string[] = [];
		for (const block of this.blocks) {
			const rendered = block.render(width);
			if (rendered.length === 0) continue;
			if (rows.length > 0) rows.push("");
			for (const line of rendered) rows.push(line);
		}
		return rows;
	}
}

export function isToolBlock(component: Component): component is ToolBlock | ToolBlockGroup {
	return "toolBlockKind" in component && (component.toolBlockKind === "block" || component.toolBlockKind === "group");
}

export class ToolBlockMarkdown implements Component {
	private readonly markdown: Markdown;
	constructor(text: string, defaultTextStyle?: DefaultTextStyle) {
		this.markdown = new Markdown(terminalDisplayText(text), 0, 0, getMarkdownTheme(), defaultTextStyle, {
			hyperlinks: false,
			images: false,
		});
	}
	invalidate(): void {
		this.markdown.invalidate();
	}
	render(width: number): string[] {
		return width < 1 ? [] : this.markdown.render(width);
	}
}

/** The narrowest width previews are rendered at: rows of later blocks wrap no narrower than this. */
const MARKDOWN_PREVIEW_MIN_ROW_WIDTH = 256;
const FENCE_MARKER = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Columns enough to render the leading block of `text` without wrapping: from its first non-blank line to the next
 * blank line outside a code fence. Each line gets room for table borders and list or quote markers.
 */
function leadingBlockWidth(text: string): number {
	let width = MARKDOWN_PREVIEW_MIN_ROW_WIDTH;
	let fence: string | undefined;
	let started = false;
	for (const line of text.split("\n")) {
		if (!line.trim()) {
			if (started && fence === undefined) break;
			continue;
		}
		started = true;
		const marker = FENCE_MARKER.exec(line)?.[1];
		if (marker !== undefined && (fence === undefined || marker[0] === fence[0])) fence = fence ? undefined : marker;
		const pipes = line.split("|").length - 1;
		width = Math.max(width, visibleWidth(line.replace(/\t/g, "   ")) + 2 * pipes + 16);
	}
	return width;
}

/**
 * Markdown as one-row previews: its rendered rows, its first block unwrapped, without blank rows, code fences or heading
 * markers, and with links as their text. Each row closes its styles. Plain text takes `color`; bold, italic and code keep
 * their emphasis within it.
 */
export function markdownPreviewRows(text: string, color: (text: string) => string): string[] {
	const base = getMarkdownTheme();
	const previewTheme: MarkdownTheme = {
		...base,
		heading: (value) => (/^#+\s*$/.test(stripTerminalSequences(value)) ? "" : base.heading(value)),
		linkUrl: () => "",
		codeBlockBorder: () => "",
		codeBlockIndent: "",
	};
	const display = terminalDisplayText(text);
	return new Markdown(display, 0, 0, previewTheme, { color }, { hyperlinks: false, images: false })
		.render(leadingBlockWidth(display))
		.map((row) => row.trimEnd())
		.filter((row) => stripTerminalSequences(row).trim().length > 0)
		.map((row) => (row.includes("\x1b[") ? `${row}\x1b[0m` : row));
}
