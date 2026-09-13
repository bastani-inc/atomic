import { Container, ScrollView, VStack } from "@earendil-works/pi-tui";
import { LAYOUT_NODE, type StackLayoutNode } from "@earendil-works/pi-tui/dist/layout-node.js";
import type { ScrollableWidgetComponent, WidgetScrollState } from "../../../core/extensions/ui-types.js";

/** A native layout node, so the dock's final allocation also owns mouse bounds. */
export class ScrollWidget extends ScrollView {
	private lastState: WidgetScrollState | undefined;
	private requestVersion: number | undefined;

	private readonly widget: ScrollableWidgetComponent;
	readonly maxHeight: number;

	constructor(widget: ScrollableWidgetComponent, maxHeight: number) {
		super(widget, { overscroll: "contain", scrollbar: "auto" });
		this.widget = widget;
		this.maxHeight = maxHeight;
	}

	override scrollBy(lines: number): number {
		super.scrollBy(lines);
		// Native wheel routing forwards unused delta to the transcript even with contain.
		// This opt-in viewport consumes it after native hit-testing and clamping.
		return 0;
	}

	override get isScrollbarVisible(): boolean {
		return this.viewportHeight > 0 && (this.lastState?.contentHeight ?? 0) > this.viewportHeight;
	}

	override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
		super.updateLayout(contentHeight, viewportHeight, requestRender);
		const request = this.widget.getScrollRequest?.();
		if (request && (this.requestVersion === undefined || request.version > this.requestVersion)) {
			this.requestVersion = request.version;
			this.scrollTo(request.scrollTop);
		}
		const state = { scrollTop: this.scrollTop, viewportHeight: this.viewportHeight, contentHeight };
		if (
			state.scrollTop !== this.lastState?.scrollTop ||
			state.viewportHeight !== this.lastState?.viewportHeight ||
			state.contentHeight !== this.lastState?.contentHeight
		) {
			this.lastState = state;
			this.widget.onScroll?.(state);
		}
	}

	dispose(): void {
		this.setScrollbar("hidden");
		this.widget.dispose?.();
	}
}

/** Leave legacy widgets opaque; opt-in children expose native dock layout. */
export class WidgetContainer extends Container {
	private scrollStack(): VStack | undefined {
		if (!this.children.some((child) => child instanceof ScrollWidget)) return undefined;
		return new VStack(
			this.children.map((component) => ({
				component,
				...(component instanceof ScrollWidget
					? { maxSize: component.maxHeight, shrink: 1, minSize: 0 }
					: { shrink: 0 }),
			})),
		);
	}

	[LAYOUT_NODE](): StackLayoutNode | undefined {
		return this.scrollStack()?.[LAYOUT_NODE]();
	}

	override render(width: number): string[] {
		return this.scrollStack()?.render(width) ?? super.render(width);
	}
}
