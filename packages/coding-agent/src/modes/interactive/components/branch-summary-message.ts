import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@bastani/atomic-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { parenthesizedKeyHint } from "./keybinding-hints.js";
import { createMarkdownTransform, hasExtensionMarkdownTransform } from "./markdown-transform.ts";
import { blockRows, type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends Box {
	get selectionTextMayChangeOnReplay(): boolean {
		return this.expanded && hasExtensionMarkdownTransform(this.markdownTransformers);
	}

	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private renderLatex: boolean;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;

	constructor(
		message: BranchSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		renderLatex = true,
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
	) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.renderLatex = renderLatex;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.updateDisplay();
	}

	/** A click anywhere on the branch summary expands or collapses it, as Ctrl+O does. */
	readonly expandsOnClick = true;

	isExpanded(): boolean {
		return this.expanded;
	}

	/** Its rows: an expand hint in them is part of the block, which a click on it expands or collapses. */
	override render(width: number): string[] {
		return blockRows(super.render(width));
	}

	/** Every row of the branch summary, its padding included. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(0, this.render(width).length);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();
		const content = new Container();

		const label = theme.fg("customMessageLabel", `\x1b[1m[branch]\x1b[22m`);
		content.addChild(new Text(label, 0, 0));
		content.addChild(new Spacer(1));

		if (this.expanded) {
			const header = "**Branch Summary**\n\n";
			const transform = createMarkdownTransform(
				"summary",
				() => false,
				this.markdownTransformers,
				this.messageId,
				this.timestamp,
			);
			content.addChild(
				new Markdown(
					this.message.summary,
					0,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("customMessageText", text),
					},
					{
						// Transformers see only the summary content, not Atomic's header.
						transform: (markdown, width) => header + transform(markdown, width),
						renderLatex: this.renderLatex,
					},
				),
			);
		} else {
			const hint = parenthesizedKeyHint("app.tools.expand", "Expand");
			content.addChild(new Text(theme.fg("customMessageText", "Branch summary") + (hint ? ` ${hint}` : ""), 0, 0));
		}
		this.addChild(content);
	}
}
