import { type Component, ScrollView, VStack } from "@earendil-works/pi-tui";
import {
	getScrollbarGeometry,
	getScrollViewBox,
	type LayoutBox,
	type LayoutFrame,
	renderLayoutFrame,
	type ScrollbarGeometry,
} from "@earendil-works/pi-tui/dist/layout.js";
import { isTerminalLeftMousePress, parseTerminalMouseInput } from "./mouse-input.js";
import { sliceColumns, visibleWidth } from "./text-helpers.js";

const EMPTY_RENDER: () => void = () => {};
export const GRAPH_HEADER_ROWS = 3;
export const GRAPH_FOOTER_ROWS = 3;

export function graphLayoutMarginRows(height: number): number {
	return Math.max(1, Math.floor(height)) >= 9 ? 1 : 0;
}

export function graphLayoutBodyRows(height: number): number {
	const safeHeight = Math.max(1, Math.floor(height));
	return Math.max(0, safeHeight - GRAPH_HEADER_ROWS - GRAPH_FOOTER_ROWS - graphLayoutMarginRows(safeHeight) * 2);
}

export function graphLayoutNaturalHeight(bodyRows: number): number {
	const safeBodyRows = Math.max(1, Math.floor(bodyRows));
	const base = GRAPH_HEADER_ROWS + GRAPH_FOOTER_ROWS + safeBodyRows;
	return base >= GRAPH_HEADER_ROWS + GRAPH_FOOTER_ROWS + 3 ? base + 2 : base;
}

export interface GraphViewLayoutCallbacks {
	renderHeader: (width: number) => string[];
	renderBody: (width: number, top: number, rows: number, contentRows: number) => string[];
	renderFooter: (width: number) => string[];
	bodyContentHeight: (width: number, viewportRows: number) => number;
	beforeFrame?: (scrollView: ScrollView, viewportRows: number, contentRows: number, width: number) => void;
	requestRender?: () => void;
}

export interface GraphViewLayoutFrame {
	frame: LayoutFrame;
	bodyBox: LayoutBox | undefined;
	topMarginRows: number;
	bottomMarginRows: number;
	wrappedRows: boolean[];
	scrollbar: ScrollbarGeometry | undefined;
}

function collectWrappedRows(box: LayoutBox, height: number, wrappedRows: boolean[]): void {
	if (box.lines) {
		const offset = box.lineOffset ?? 0;
		const firstRow = Math.max(box.rect.y, box.clip.y, 0);
		const lastRow = Math.min(box.rect.y + box.rect.height, box.clip.y + box.clip.height, height);
		for (let row = firstRow; row < lastRow; row++) {
			if (box.lines[offset + row - box.rect.y] !== undefined) wrappedRows[row] = true;
		}
	}
	for (const child of box.children) collectWrappedRows(child, height, wrappedRows);
}

class CallbackComponent implements Component {
	constructor(private readonly renderLines: (width: number) => string[]) {}

	render(width: number): string[] {
		return this.renderLines(width);
	}

	invalidate(): void {}
}

/**
 * Layout root for the graph overlay.
 *
 * pi-tui mounts extension overlays as ordinary components, while its
 * ScrollView/VStack sizing pass belongs to TuiAltScreen. This small bridge
 * runs that same installed pi-tui layout pass for the overlay component, so
 * the graph body still gets a real constrained ScrollView without changing
 * the host TUI or the transcript surface.
 */
export class GraphViewLayout {
	readonly scrollView: ScrollView;

	private readonly root: VStack;
	private readonly callbacks: GraphViewLayoutCallbacks;
	private bodyViewportRows = 0;
	private bodyContentRows = 0;
	private scrollbar: ScrollbarGeometry | undefined;
	private draggingScrollbar: { grabOffset: number } | undefined;

	constructor(callbacks: GraphViewLayoutCallbacks) {
		this.callbacks = callbacks;

		const margin = new CallbackComponent(() => [""]);
		const header = new CallbackComponent((width) => this.callbacks.renderHeader(width));
		const body = new CallbackComponent((width) => this.renderBody(width));
		const footer = new CallbackComponent((width) => this.callbacks.renderFooter(width));
		this.scrollView = new ScrollView(body, {
			axis: "vertical",
			follow: "none",
			overscroll: "contain",
			scrollbar: "hidden",
		});

		const marginVisible = ({ height }: { height: number }): boolean => graphLayoutMarginRows(height) > 0;
		this.root = new VStack([
			{ component: margin, basis: 1, grow: 0, shrink: 0, minSize: 0, visible: marginVisible },
			{ component: header, basis: GRAPH_HEADER_ROWS, grow: 0, shrink: 1, minSize: 0 },
			{ component: this.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 0 },
			{ component: footer, basis: GRAPH_FOOTER_ROWS, grow: 0, shrink: 1, minSize: 1 },
			{ component: margin, basis: 1, grow: 0, shrink: 0, minSize: 0, visible: marginVisible },
		]);
	}

	render(width: number, height: number): GraphViewLayoutFrame {
		const safeWidth = Math.max(1, Math.floor(width));
		const safeHeight = Math.max(1, Math.floor(height));
		const marginRows = graphLayoutMarginRows(safeHeight);
		this.bodyViewportRows = graphLayoutBodyRows(safeHeight);
		this.bodyContentRows = Math.max(
			0,
			Math.floor(this.callbacks.bodyContentHeight(safeWidth, this.bodyViewportRows)),
		);
		const requestRender = this.callbacks.requestRender ?? EMPTY_RENDER;
		this.scrollView.updateLayout(this.bodyContentRows, this.bodyViewportRows, requestRender);
		this.scrollView.setScrollbar(this.bodyContentRows > this.bodyViewportRows ? "always" : "hidden");
		this.callbacks.beforeFrame?.(this.scrollView, this.bodyViewportRows, this.bodyContentRows, safeWidth);

		const frame = renderLayoutFrame(this.root, safeWidth, safeHeight, requestRender);
		const bodyBox = getScrollViewBox(frame, this.scrollView);
		this.scrollbar = bodyBox ? getScrollbarGeometry(bodyBox) : undefined;
		if (!this.scrollbar) this.draggingScrollbar = undefined;
		const wrappedRows = Array.from({ length: safeHeight }, () => false);
		collectWrappedRows(frame.root, safeHeight, wrappedRows);
		return {
			frame,
			bodyBox,
			topMarginRows: marginRows,
			bottomMarginRows: marginRows,
			wrappedRows,
			scrollbar: this.scrollbar,
		};
	}

	/** Repaint the thumb after overlays that cover the body rows. */
	paintScrollbar(lines: string[], width: number): void {
		const geometry = this.scrollbar;
		if (!geometry) return;
		for (let offset = 0; offset < geometry.thumbHeight; offset++) {
			const row = geometry.thumbTop + offset;
			if (row < 0 || row >= lines.length || geometry.column < 0 || geometry.column >= width) continue;
			const line = lines[row] ?? " ".repeat(width);
			const before = sliceColumns(line, 0, geometry.column, true);
			const after = sliceColumns(line, geometry.column + 1, width - geometry.column - 1, true);
			const beforePad = " ".repeat(Math.max(0, geometry.column - visibleWidth(before)));
			const afterPad = " ".repeat(Math.max(0, width - geometry.column - 1 - visibleWidth(after)));
			lines[row] = `${before}${beforePad}${this.scrollView.scrollbarStyle(" ")}${after}${afterPad}`;
		}
	}

	dispose(): void {
		this.draggingScrollbar = undefined;
		this.scrollbar = undefined;
		this.scrollView.updateLayout(this.bodyContentRows, this.bodyViewportRows, EMPTY_RENDER);
		this.scrollView.setScrollbarActive(false);
		this.scrollView.setScrollbar("hidden");
	}

	get viewportRows(): number {
		return this.bodyViewportRows;
	}

	get contentRows(): number {
		return this.bodyContentRows;
	}

	get scrollbarGeometry(): ScrollbarGeometry | undefined {
		return this.scrollbar;
	}
	/** Return whether an event belongs to the graph scrollbar without mutating it. */
	isScrollbarInput(data: string): boolean {
		const event = parseTerminalMouseInput(data);
		if (!event) return false;
		if (this.draggingScrollbar) {
			return event.action === "release" || ((event.buttonCode & 32) !== 0 && (event.buttonCode & 3) === 0);
		}
		const geometry = this.scrollbar;
		return (
			geometry !== undefined &&
			event.action === "press" &&
			(event.buttonCode & 64) === 0 &&
			(event.buttonCode & 32) === 0 &&
			(event.buttonCode & 3) === 0 &&
			event.col === geometry.column &&
			event.row >= geometry.trackTop &&
			event.row < geometry.trackTop + geometry.trackHeight
		);
	}

	/** Route a scrollbar press, drag, or release to the graph ScrollView. */
	handleScrollbarInput(data: string): boolean {
		const event = parseTerminalMouseInput(data);
		if (!event) return false;

		if (event.action === "release") {
			if (!this.draggingScrollbar) return false;
			this.draggingScrollbar = undefined;
			return true;
		}

		const moving = (event.buttonCode & 32) !== 0;
		const leftButton = (event.buttonCode & 3) === 0;
		if (this.draggingScrollbar && moving && leftButton) {
			this.scrollToScrollbarRow(event.row);
			return true;
		}

		const geometry = this.scrollbar;
		if (!geometry) return false;
		if (!isTerminalLeftMousePress(event) || event.col !== geometry.column) return false;
		if (event.row < geometry.trackTop || event.row >= geometry.trackTop + geometry.trackHeight) return false;

		if (event.row >= geometry.thumbTop && event.row < geometry.thumbTop + geometry.thumbHeight) {
			this.draggingScrollbar = { grabOffset: event.row - geometry.thumbTop };
		} else {
			this.scrollToScrollbarRow(event.row - Math.floor(geometry.thumbHeight / 2));
		}
		return true;
	}

	invalidate(): void {
		this.root.invalidate();
	}

	private renderBody(width: number): string[] {
		const contentRows = this.bodyContentRows;
		const lines = new Array<string>(contentRows);
		const top = Math.max(0, Math.min(contentRows, this.scrollView.scrollTop));
		const rows = Math.max(0, Math.min(this.bodyViewportRows, contentRows - top));
		const visible = this.callbacks.renderBody(width, top, rows, contentRows);
		for (let index = 0; index < visible.length && index < rows; index++) {
			lines[top + index] = visible[index]!;
		}
		// pi-tui scans upward from scrollTop for an image that crosses the
		// viewport edge. A non-empty sentinel stops that scan at the first
		// hidden row instead of making every frame walk the whole graph.
		if (top > 0) lines[top - 1] = " ";
		return lines;
	}

	private scrollToScrollbarRow(row: number): void {
		const geometry = this.scrollbar;
		if (!geometry || geometry.maxScrollTop <= 0) return;
		const maxThumbTop = Math.max(0, geometry.trackHeight - geometry.thumbHeight);
		if (maxThumbTop === 0) {
			this.scrollView.scrollTo(0);
			return;
		}
		const thumbTop = Math.max(
			geometry.trackTop,
			Math.min(geometry.trackTop + maxThumbTop, row - (this.draggingScrollbar?.grabOffset ?? 0)),
		);
		const ratio = (thumbTop - geometry.trackTop) / maxThumbTop;
		this.scrollView.scrollTo(Math.round(ratio * geometry.maxScrollTop));
	}
}
