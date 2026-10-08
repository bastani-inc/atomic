import { Box, Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@earendil-works/pi-tui";
import type { BranchSummaryMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { parenthesizedKeyHint } from "./keybinding-hints.js";

/**
 * Component that renders a branch summary message with collapsed/expanded state.
 * Uses same background color as custom messages for visual consistency.
 */
export class BranchSummaryMessageComponent extends Box {
	private expanded = false;
	private message: BranchSummaryMessage;
	private markdownTheme: MarkdownTheme;
	private renderLatex: boolean;

	constructor(
		message: BranchSummaryMessage,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		renderLatex = true,
		outputPad = 1,
	) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		this.message = message;
		this.markdownTheme = markdownTheme;
		this.renderLatex = renderLatex;
		this.updateDisplay();
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
			content.addChild(
				new Markdown(
					header + this.message.summary,
					0,
					0,
					this.markdownTheme,
					{
						color: (text: string) => theme.fg("customMessageText", text),
					},
					{ renderLatex: this.renderLatex },
				),
			);
		} else {
			const hint = parenthesizedKeyHint("app.tools.expand", "Expand");
			content.addChild(new Text(theme.fg("customMessageText", "Branch summary") + (hint ? ` ${hint}` : ""), 0, 0));
		}
		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
