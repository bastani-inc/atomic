import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@bastani/atomic-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { parenthesizedKeyHint } from "./keybinding-hints.js";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends Box {
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

	/** Every row of the branch summary, its padding included. */
	clickArea(width: number): RowRange | undefined {
		return rowsFrom(0, this.render(width).length);
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setMarkdownSettings(theme: MarkdownTheme, renderLatex: boolean): void {
		this.markdownTheme = theme;
		this.renderLatex = renderLatex;
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
