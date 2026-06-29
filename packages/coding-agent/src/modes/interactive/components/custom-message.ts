import type { TextContent } from "@earendil-works/pi-ai/compat";
import type { Component } from "@earendil-works/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@earendil-works/pi-tui";
import type { MessageRenderer } from "../../../core/extensions/types.ts";
import type { CustomMessage } from "../../../core/messages.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Type guard ensuring a value returned by an extension's custom renderer is a
 * real TUI Component (exposes a callable `render`). Extension renderer output is
 * untrusted at runtime: a renderer that returns a string or other non-Component
 * value would otherwise be added as a child and crash `Container.render()` with
 * "child.render is not a function".
 */
function isRenderableComponent(value: unknown): value is Component {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { render?: unknown }).render === "function"
	);
}

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private spacer?: Spacer;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private _expanded = false;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		// The leading spacer is mounted in rebuild() alongside actual content, so a
		// renderer that suppresses output (returns null) leaves no blank row.
		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previously mounted content (spacer + content) before rebuilding.
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		if (this.spacer) {
			this.removeChild(this.spacer);
			this.spacer = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(this.message, { expanded: this._expanded }, theme);
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
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box, preceded by the standard leading spacer.
		this.spacer = new Spacer(1);
		this.addChild(this.spacer);
		this.addChild(this.box);
		this.box.clear();

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
			new Markdown(text, 0, 0, this.markdownTheme, {
				color: (text: string) => theme.fg("customMessageText", text),
			}),
		);
	}
}
