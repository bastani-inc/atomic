import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a complete assistant message
 */
interface MarkdownSlot {
	kind: "text" | "thinking";
	markdown: Markdown;
}

export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private renderLatex: boolean;
	private messageId?: string;
	private timestamp?: string;
	private markdownSlots: MarkdownSlot[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		// ChatSessionHost creates components per render, so it needs the initial stream state.
		isStreaming = false,
		renderLatex = true,
		messageId?: string,
		timestamp?: string,
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.renderLatex = renderLatex;
		this.messageId = messageId;
		this.timestamp = timestamp;
		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message, isStreaming);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.markdownSlots = [];
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();
		const previousSlots = this.markdownSlots;
		this.markdownSlots = [];
		const markdownBlock = (kind: MarkdownSlot["kind"], text: string, create: () => Markdown): Markdown => {
			const slot = previousSlots[this.markdownSlots.length];
			const markdown = slot?.kind === kind ? slot.markdown : create();
			markdown.setText(text);
			this.markdownSlots.push({ kind, markdown });
			return markdown;
		};

		// Spacers are added lazily, right before the next visible content block. This puts a blank
		// line before the first visible block and after each visible thinking run that is followed
		// by more visible content, while hidden thinking runs without a label contribute nothing.
		let needsSpacer = true;
		const addVisibleChild = (child: Component) => {
			if (needsSpacer) {
				this.contentContainer.addChild(new Spacer(1));
				needsSpacer = false;
			}
			this.contentContainer.addChild(child);
		};

		// Render content in order
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				addVisibleChild(
					markdownBlock(
						"text",
						content.text.trim(),
						() =>
							new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
								transform: createMarkdownTransform(
									"assistant",
									() => this.isStreaming,
									this.markdownTransformers,
									this.messageId,
									this.timestamp,
								),
								renderLatex: this.renderLatex,
							}),
					),
				);
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") break;
					const thinking = thinkingContent.thinking.trim();
					if (thinking) thinkingBlocks.push(thinking);
				}
				i--;
				if (thinkingBlocks.length === 0) continue;

				// Keep text and tool calls as run boundaries; only adjacent thinking is coalesced.
				if (this.hideThinkingBlock) {
					// A hidden run with an empty label renders nothing, including no spacing.
					if (!this.hiddenThinkingLabel.trim()) continue;
					addVisibleChild(new Text(theme.italic(theme.fg("muted", this.hiddenThinkingLabel)), this.outputPad, 0));
				} else {
					addVisibleChild(
						markdownBlock(
							"thinking",
							thinkingBlocks.join("\n\n"),
							() =>
								new Markdown(
									thinkingBlocks.join("\n\n"),
									this.outputPad,
									0,
									this.markdownTheme,
									{
										color: (text: string) => theme.fg("muted", text),
										italic: true,
									},
									{
										transform: createMarkdownTransform(
											"assistant-thinking",
											() => this.isStreaming,
											this.markdownTransformers,
											this.messageId,
											this.timestamp,
										),
										renderLatex: this.renderLatex,
									},
								),
						),
					);
				}
				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				needsSpacer = true;
			}
		}

		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(
					new Text(theme.fg("muted", interruptedNotice(message.errorMessage)), this.outputPad, 0),
				);
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}

/**
 * The line shown under a response the user interrupted. A generic abort, whatever the provider called it ("Request
 * was aborted", "This operation was aborted", an AbortError), reads as a calm "Interrupted", the way the user asked
 * for it; a specific reason, such as the retry count, is kept.
 */
export function interruptedNotice(errorMessage: string | undefined): string {
	if (
		!errorMessage ||
		/^(?:operation|request|this operation) was aborted\.?$|^operation aborted$|^aborterror\b|^the operation was aborted/i.test(
			errorMessage.trim(),
		)
	)
		return "Interrupted";
	return errorMessage;
}
