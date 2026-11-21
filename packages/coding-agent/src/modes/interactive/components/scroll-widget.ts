import { Container, ScrollView, stripHintMarkers, type TuiMouseEvent, VStack } from "@bastani/atomic-tui";
import { LAYOUT_NODE, type StackLayoutNode } from "@bastani/atomic-tui/dist/layout-node.js";
import type { ScrollableWidgetComponent, WidgetScrollState } from "../../../core/extensions/ui-types.js";
import type { DockScene } from "../navigation-scene.js";

/** A native layout node, so the dock's final allocation also owns mouse bounds. */
export class ScrollWidget extends ScrollView {
	private lastState: WidgetScrollState | undefined;
	private requestVersion: number | undefined;

	private readonly widget: ScrollableWidgetComponent;
	private readonly heightCap: () => number;
	get maxHeight(): number {
		return this.heightCap();
	}

	constructor(widget: ScrollableWidgetComponent, maxHeight: number, heightCap: () => number = () => maxHeight) {
		super(widget, { overscroll: "contain", scrollbar: "auto" });
		this.widget = widget;
		this.heightCap = heightCap;
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

/** A row as a picture: what it shows, with nothing on it a click could run (no key hints, no links). */
function inertRow(row: string): string {
	return stripHintMarkers(row).replace(/\x1b\]8;[^;\x07\x1b]*;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Leave legacy widgets opaque; opt-in children expose native dock layout. `scene` answers what the container shows at a
 * width: its children (`live`), the same rows taking no clicks (`inert`), or nothing (`hidden`).
 */
export class WidgetContainer extends Container {
	private readonly scene: (width: number) => DockScene;
	/** The scene of the last render, which a click is judged against. */
	private paintedScene: DockScene = "live";
	/** The last layout laid the children out natively. */
	private native = false;

	constructor(scene: (width: number) => DockScene = () => "live") {
		super();
		this.scene = scene;
	}

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
		// Only children drawn live are laid out natively: a hidden or inert container is drawn by its own render.
		const node = this.paintedScene === "live" ? this.scrollStack()?.[LAYOUT_NODE]() : undefined;
		this.native = node !== undefined;
		return node;
	}

	override render(width: number): string[] {
		const scene = this.scene(width);
		this.paintedScene = scene;
		if (scene === "hidden") return [];
		const rows = this.scrollStack()?.render(width) ?? super.render(width);
		return scene === "inert" ? rows.map(inertRow) : rows;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		// Laid out natively, the screen hands clicks to the children itself.
		return this.paintedScene === "live" && !this.native ? super.handleMouse(event) : undefined;
	}
}
