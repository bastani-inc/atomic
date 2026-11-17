import {
	type Component,
	Markdown,
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
export interface ToolBlockSpec {
	readonly status: ToolBlockStatus;
	readonly title: string | Component;
	readonly args?: string;
	readonly meta?: readonly string[];
	readonly details?: Component;
	readonly body?: Component;
	readonly outputPad?: number;
}

export const TOOL_BLOCK_LIMITS = {
	bash: 5,
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

function renderedTitle(title: Component): string {
	return title
		.render(16_384)
		.map((line) => line.trimEnd())
		.join(" ")
		.trim();
}

function shortenedTitle(title: string, width: number): string {
	if (visibleWidth(title) <= width) return title;
	const closing = title.lastIndexOf(")");
	if (closing > title.indexOf("(") && closing > 0) {
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

export class ToolBlockRecords implements Component {
	readonly toolBlockKind = "records";
	private readonly records: readonly (string | Component)[];
	constructor(records: readonly (string | Component)[]) {
		this.records = records;
	}
	invalidate(): void {
		for (const record of this.records) if (typeof record !== "string") record.invalidate();
	}
	render(width: number): string[] {
		if (width < 1) return [];
		const contentWidth = Math.max(1, width - DETAIL_PREFIX.length);
		return this.records.flatMap((record) => {
			const component = typeof record === "string" ? new Text(theme.fg("toolOutput", record), 0, 0) : record;
			return component.render(contentWidth).map((line, index) => {
				const prefix = index === 0 ? DETAIL_FIRST_PREFIX : DETAIL_PREFIX;
				return truncateToWidth(`${theme.fg("dim", prefix)}${line.trimEnd()}`, width, "…");
			});
		});
	}
}

export class ToolBlock implements Component {
	readonly toolBlockKind = "block";
	private readonly spec: ToolBlockSpec;
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
		const titleText =
			typeof this.spec.title === "string" ? inlineText(this.spec.title) : renderedTitle(this.spec.title);
		const args = this.spec.args === undefined ? undefined : inlineText(this.spec.args);
		const minimumTitle =
			typeof this.spec.title === "string"
				? visibleWidth(titleText) + (args === undefined ? 0 : 2 + (args.length > 0 ? 1 : 0))
				: Math.min(visibleWidth(titleText), 8);
		const metaText = () => meta.map((part) => ` · ${part}`).join("");
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
		} else title = shortenedTitle(titleText, availableTitle);
		const header = truncateToWidth(`${glyph} ${title}${theme.fg("dim", metaText())}`, contentWidth, "…");
		const rows = [header];
		if (this.spec.body) {
			const bodyWidth = Math.max(1, contentWidth - 2);
			rows.push(
				...this.spec.body
					.render(bodyWidth)
					.map((line) => truncateToWidth(`  ${line.trimEnd()}`, contentWidth, "…")),
			);
		}
		if (this.spec.details) {
			const records =
				this.spec.details instanceof ToolBlockRecords
					? this.spec.details
					: new ToolBlockRecords([this.spec.details]);
			rows.push(...records.render(contentWidth));
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
			rows.push(...rendered);
		}
		return rows;
	}
}

export function isToolBlock(component: Component): component is ToolBlock | ToolBlockGroup {
	return "toolBlockKind" in component && (component.toolBlockKind === "block" || component.toolBlockKind === "group");
}

export class ToolBlockMarkdown implements Component {
	private readonly markdown: Markdown;
	constructor(text: string) {
		this.markdown = new Markdown(terminalDisplayText(text), 0, 0, getMarkdownTheme(), undefined, {
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
