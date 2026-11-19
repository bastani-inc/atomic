import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { type Component, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@bastani/atomic-tui";
import type { MarkdownTransformer } from "../../../core/extensions/types.ts";
import { stripTerminalControls } from "../../../utils/ansi.js";
import { singleLineDisplayText, terminalDisplayText } from "../../../utils/terminal-text.ts";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { ToolBlock } from "./tool-block.ts";

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
	private interruptedActivity: readonly string[];
	private readonly hideTerminalNotice: boolean;
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
		interruptedActivity: readonly string[] = [],
		hideTerminalNotice = false,
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
		this.interruptedActivity = interruptedActivity;
		this.hideTerminalNotice = hideTerminalNotice;
		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message, isStreaming, interruptedActivity);
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

	updateContent(
		message: AssistantMessage,
		isStreaming = this.isStreaming,
		interruptedActivity: readonly string[] = this.interruptedActivity,
	): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;
		this.interruptedActivity = interruptedActivity;

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
			// Raw terminal sequences in model text must not reach the terminal; Atomic styles after parsing (#4889).
			const text = content.type === "text" ? stripTerminalControls(content.text).trim() : "";
			if (content.type === "text" && text) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				addVisibleChild(
					markdownBlock(
						"text",
						text,
						() =>
							new Markdown(text, this.outputPad, 0, this.markdownTheme, undefined, {
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
					const thinking = stripTerminalControls(thinkingContent.thinking).trim();
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
		if (this.hideTerminalNotice) return;
		if (message.stopReason === "length") {
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (message.stopReason === "aborted") {
			const notice = interruptedNotice(message.errorMessage);
			const reason = terminalDisplayText(notice).split("\n")[0].trim();
			const ownActivity = message.content
				.flatMap((content) => (content.type === "toolCall" ? [singleLineDisplayText(content.name).trim()] : []))
				.filter(Boolean);
			const fallbackActivity = hasAssistantVisibleContent(message.content)
				? []
				: this.interruptedActivity.map((name) => singleLineDisplayText(name).trim()).filter(Boolean);
			const activity = ownActivity.length > 0 ? ownActivity : fallbackActivity;
			const meta = [...new Set(activity)];
			if (reason !== "Interrupted by user" && reason && !/^(?:\w*Error\b|at\s|Caused by:)/u.test(reason))
				meta.push(reason);
			if (meta.length === 0) meta.push("response");
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new ToolBlock({ status: "stopped", title: "Interrupted", meta, outputPad: this.outputPad }),
			);
		} else if (!hasToolCalls && message.stopReason === "error") {
			const errorMsg = message.errorMessage || "Unknown error";
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
		}
	}
}

export function hasAssistantVisibleContent(content: AssistantMessage["content"]): boolean {
	for (const block of content) {
		if (block.type === "toolCall") return true;
		if (block.type === "text" && stripTerminalControls(block.text).trim().length > 0) return true;
		if (block.type === "thinking" && stripTerminalControls(block.thinking).trim().length > 0) return true;
	}
	return false;
}

/**
 * The line shown under an interrupted response: "Interrupted by user" for every interrupt, whatever the provider or
 * retry loop called it. Only an abort Atomic itself caused with an explanation, such as a dismissed question, keeps
 * that explanation.
 */
export function interruptedNotice(errorMessage: string | undefined): string {
	const text = errorMessage?.trim() ?? "";
	if (
		text === "" ||
		/^(?:(?:the |this )?(?:operation|request) (?:was )?aborted|operation aborted|aborterror\b.*|aborted after \d+ retry attempts?|interrupted(?: by user)?)\.?$/i.test(
			text,
		)
	)
		return "Interrupted by user";
	return text;
}
