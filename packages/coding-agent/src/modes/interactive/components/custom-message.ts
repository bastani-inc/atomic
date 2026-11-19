import type { TextContent } from "@bastani/atomic-ai/compat";
import type { Component } from "@bastani/atomic-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@bastani/atomic-tui";
import type { MarkdownTransformer, MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { TASK_COMPLETION_MESSAGE_TYPE } from "../../../core/tasks/completion.js";
import { TASK_HEARTBEAT_MESSAGE_TYPE } from "../../../core/tasks/heartbeat-notice.js";
import { stripTerminalControls } from "../../../utils/ansi.js";
import { getMarkdownTheme, theme } from "../theme/theme.js";
import { keyHint, keyText } from "./keybinding-hints.js";
import { createMarkdownTransform } from "./markdown-transform.ts";
import { disposeRenderer } from "./renderer-disposal.js";
import { RendererMouseControls } from "./renderer-mouse-controls.js";
import { TaskCompletionMessage, type TaskCompletionMessageOptions } from "./task-completion-message.js";
import { heartbeatDetailsFrom, TaskHeartbeatMessage } from "./task-heartbeat-message.js";
import { ToolBlock } from "./tool-block.ts";
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

/**
 * Type guard ensuring a value returned by an extension's custom renderer is a
 * real TUI Component (exposes a callable `render`). Extension renderer output is
 * untrusted at runtime: a renderer that returns a string or other non-Component
 * value would otherwise be added as a child and crash `Container.render()` with
 * "child.render is not a function".
 */
function isRenderableComponent(value: unknown): value is Component {
	return typeof value === "object" && value !== null && typeof (value as { render?: unknown }).render === "function";
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	readonly ownsLeadingSpacer = true;
	private disposed = false;
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private controls?: RendererMouseControls;
	private box: Box;
	private spacer?: Spacer;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;
	private outputPad: number;
	private renderLatex: boolean;
	private markdownTransformers: readonly MarkdownTransformer[];
	private messageId?: string;
	private timestamp?: string;
	private completionOptions?: TaskCompletionMessageOptions;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		renderLatex = true,
		markdownTransformers: readonly MarkdownTransformer[] = [],
		messageId?: string,
		timestamp?: string,
		completionOptions?: TaskCompletionMessageOptions & { localMouseControls?: boolean },
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		if (completionOptions?.localMouseControls && customRenderer) this.controls = new RendererMouseControls(this, 1);
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.renderLatex = renderLatex;
		this.markdownTransformers = markdownTransformers;
		this.messageId = messageId;
		this.timestamp = timestamp;
		this.completionOptions = completionOptions;

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		// The leading spacer is mounted in rebuild() alongside actual content, so a
		// renderer that suppresses output (returns null) leaves no blank row.
		this.rebuild();
	}

	/**
	 * A message that draws anything expands on a click, as Ctrl+O expands it: its card or renderer decides what that
	 * shows, and a card with nothing more to show stays as it is.
	 */
	get expandsOnClick(): boolean {
		return this.spacer !== undefined;
	}

	isExpanded(): boolean {
		return this._expanded;
	}

	/** Every row of the card, under the blank row this message leads with. */
	clickArea(width: number): RowRange | undefined {
		if (this.spacer === undefined) return undefined;
		return rowsFrom(this.spacer.render(width).length, this.render(width).length);
	}

	setExpanded(expanded: boolean): void {
		if (this.disposed) return;
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			if (this.customComponent instanceof TaskCompletionMessage) {
				this.customComponent.setExpanded(expanded);
				return;
			}
			this.rebuild();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		disposeRenderer(this.customComponent);
		this.customComponent = undefined;
		this.completionOptions = undefined;
		this.customRenderer = undefined;
		this.controls?.clear();
		this.controls = undefined;
		this.box.clear();
		this.clear();
	}

	setOutputPad(outputPad: number): void {
		if (this.disposed) return;
		if (this.outputPad === outputPad) return;
		this.outputPad = outputPad;
		this.rebuild();
	}

	override invalidate(): void {
		if (this.disposed) return;
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		if (this.disposed) return;
		const previous = this.customComponent;
		this.customComponent = undefined;
		if (previous) this.removeChild(previous);
		try {
			this.buildDisplay(previous);
		} finally {
			if (previous !== this.customComponent) disposeRenderer(previous);
		}
	}

	private buildDisplay(previous?: Component): void {
		if (this.spacer) {
			this.removeChild(this.spacer);
			this.spacer = undefined;
		}
		this.removeChild(this.box);
		if (this.message.customType === TASK_COMPLETION_MESSAGE_TYPE) {
			const card = TaskCompletionMessage.fromMessage(
				this.message,
				this._expanded,
				this.completionOptions,
				TaskCompletionMessage.isCard(previous) ? previous : undefined,
			);
			if (card) {
				this.spacer = new Spacer(1);
				this.customComponent = card;
				this.addChild(this.spacer);
				this.addChild(this.customComponent);
				return;
			}
		}
		if (this.message.customType === TASK_HEARTBEAT_MESSAGE_TYPE) {
			const details = heartbeatDetailsFrom(this.message.details);
			if (details) {
				this.spacer = new Spacer(1);
				this.customComponent = new TaskHeartbeatMessage(details, this._expanded, this.outputPad);
				this.addChild(this.spacer);
				this.addChild(this.customComponent);
				return;
			}
		}

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const options = {
					expanded: this._expanded,
					outputPad: this.outputPad,
					cwd: this.completionOptions?.cwd,
					keyText,
					keyHint,
				};
				const renderer = this.customRenderer;
				const component = this.controls
					? this.controls.render((bindMouseControl) =>
							renderer(this.message, { ...options, bindMouseControl }, theme),
						)
					: renderer(this.message, options, theme);
				// Explicit null = "handled; render nothing". Skip the leading spacer
				// and the default box entirely so the entry occupies zero rows. The
				// workflows inline-form renderer returns null for a rehydrated
				// input-form card on /resume so the input widget does not reappear.
				if (component === null) {
					return;
				}
				// Only mount the result if it is a real Component. A non-Component,
				// non-null return (string, number, plain object, …) is ignored so we
				// fall through to the default rendering path instead of crashing
				// Container.render().
				if (isRenderableComponent(component)) {
					// Custom renderer provides its own styled component
					this.spacer = new Spacer(1);
					this.addChild(this.spacer);
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				this.spacer = new Spacer(1);
				this.customComponent = new ToolBlock({
					status: "failure",
					title: "Message renderer failed",
					outputPad: this.outputPad,
				});
				this.addChild(this.spacer);
				this.addChild(this.customComponent);
				return;
			}
		}

		// Default rendering uses our box, preceded by the standard leading spacer.
		this.spacer = new Spacer(1);
		this.addChild(this.spacer);
		this.addChild(this.box);
		this.box.clear();
		this.box.setPaddingX(this.outputPad);

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			// Raw terminal sequences in the text must not reach the terminal; Atomic styles after parsing (#4889).
			new Markdown(
				stripTerminalControls(text),
				0,
				0,
				this.markdownTheme,
				{
					color: (text: string) => theme.fg("customMessageText", text),
				},
				{
					transform: createMarkdownTransform(
						"custom",
						() => false,
						this.markdownTransformers,
						this.messageId,
						this.timestamp,
					),
					renderLatex: this.renderLatex,
				},
			),
		);
	}
}
