import { LAYOUT_NODE, type ScrollLayoutNode } from "../layout-node.ts";
import { type Component, Container } from "../tui.ts";

/** Whether NO_COLOR (any value) or FORCE_COLOR=0 asks for no color. */
function colorTurnedOff(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env.NO_COLOR !== undefined) return true;
	const forced = env.FORCE_COLOR?.trim().toLowerCase();
	return forced === "0" || forced === "false";
}

export type ScrollViewScrollbar = "hidden" | "auto" | "always";

export interface ScrollViewOptions {
	axis?: "vertical";
	follow?: "none" | "end";
	primary?: boolean;
	overscroll?: "chain" | "contain";
	scrollbar?: ScrollViewScrollbar;
	scrollbarTrackStyle?: (text: string) => string;
	scrollbarThumbStyle?: (text: string) => string;
	scrollbarHideDelayMs?: number;
}

export interface ScrollViewScrollToOptions {
	/** Keep follow-end disabled even when the target is the current content end. */
	disableFollow?: boolean;
	/** Show this row in the next frame even if rows above it change before then: a jump, not a held place. */
	exact?: boolean;
}

export class ScrollView extends Container {
	private readonly child: Component;
	readonly followEnd: boolean;
	readonly primary: boolean;
	readonly overscroll: "chain" | "contain";
	readonly scrollbarTrackStyle: (text: string) => string;
	readonly scrollbarThumbStyle: (text: string) => string;
	private currentScrollbar: ScrollViewScrollbar;
	private readonly scrollbarHideDelayMs: number;
	private currentScrollTop = 0;
	/** Rows `scrollBy` moved since the last layout; undefined once the view was moved to an absolute row. */
	private movedSinceLayout: number | undefined = 0;
	/** Whether an exact jump was asked for since the last layout. */
	private exactSinceLayout = false;
	private contentHeight = 0;
	private currentViewportHeight = 0;
	private followingEnd: boolean;
	private followSuppressedAtEnd = false;
	private requestRenderCallback: (() => void) | undefined;
	private transientScrollbarVisible = false;
	private scrollbarActive = false;
	private scrollbarHideTimer: NodeJS.Timeout | undefined;
	private historyNavigation?: (action: "older" | "newer" | "start" | "end") => void;

	/** Observe explicit navigation, including a turn clamped at the edge of a partial transcript. Layout is silent. */
	setHistoryNavigation(listener?: (action: "older" | "newer" | "start" | "end") => void): void {
		this.historyNavigation = listener;
	}

	constructor(component: Component, options: ScrollViewOptions = {}) {
		super();
		if (options.axis !== undefined && options.axis !== "vertical") {
			throw new Error(`Unsupported ScrollView axis: ${options.axis}`);
		}
		this.child = component;
		this.children.push(component);
		this.followEnd = (options.follow ?? "none") === "end";
		this.followingEnd = this.followEnd;
		this.primary = options.primary ?? false;
		this.overscroll = options.overscroll ?? "chain";
		this.currentScrollbar = options.scrollbar ?? "hidden";
		// The default styles honor NO_COLOR and FORCE_COLOR=0, read once here rather than on every painted cell.
		const plain = colorTurnedOff();
		this.scrollbarTrackStyle = options.scrollbarTrackStyle ?? ((text) => (plain ? text : `\x1b[90m${text}\x1b[39m`));
		this.scrollbarThumbStyle = options.scrollbarThumbStyle ?? ((text) => (plain ? text : `\x1b[37m${text}\x1b[39m`));
		this.scrollbarHideDelayMs = Math.max(0, Math.floor(options.scrollbarHideDelayMs ?? 1000));
	}

	get hasHistoryNavigation(): boolean {
		return this.historyNavigation !== undefined;
	}

	get scrollTop(): number {
		return this.currentScrollTop;
	}

	/**
	 * Rows the reader scrolled by since the last layout, relative to the rows it showed then; undefined after a move to
	 * an absolute row. Content added or removed above those rows meanwhile does not move what the scroll lands on.
	 */
	get scrolledSinceLayout(): number | undefined {
		return this.movedSinceLayout;
	}

	/** Whether the next frame must show the row last jumped to with `exact`, whatever changed above it. */
	get jumpedSinceLayout(): boolean {
		return this.exactSinceLayout;
	}

	get isFollowingEnd(): boolean {
		return this.followingEnd;
	}

	get viewportHeight(): number {
		return this.currentViewportHeight;
	}

	get scrollbar(): ScrollViewScrollbar {
		return this.currentScrollbar;
	}

	get isScrollbarVisible(): boolean {
		if (this.scrollbar === "always") return this.currentViewportHeight > 0;
		return (
			this.scrollbar === "auto" && this.contentHeight > this.currentViewportHeight && this.transientScrollbarVisible
		);
	}

	get isScrollbarActive(): boolean {
		return this.scrollbarActive;
	}

	setScrollbar(scrollbar: ScrollViewScrollbar): void {
		if (scrollbar === this.currentScrollbar) return;
		this.currentScrollbar = scrollbar;
		if (scrollbar !== "auto") this.hideTransientScrollbar();
		else if (this.scrollbarActive) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	getContentWidth(width: number): number {
		return this.scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	private markScrollbarActivity(): void {
		if (this.scrollbar !== "auto" || this.contentHeight <= this.currentViewportHeight) return;
		this.transientScrollbarVisible = true;
		if (this.scrollbarHideTimer) {
			clearTimeout(this.scrollbarHideTimer);
			this.scrollbarHideTimer = undefined;
		}
		if (this.scrollbarActive) return;
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.transientScrollbarVisible = false;
			this.requestRenderCallback?.();
		}, this.scrollbarHideDelayMs);
		this.scrollbarHideTimer.unref();
	}

	private hideTransientScrollbar(): void {
		this.transientScrollbarVisible = false;
		if (!this.scrollbarHideTimer) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	setScrollbarActive(active: boolean): void {
		if (active === this.scrollbarActive) return;
		this.scrollbarActive = active;
		this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollTo(scrollTop: number, options: ScrollViewScrollToOptions = {}): void {
		const requested = Number.isFinite(scrollTop) ? Math.trunc(scrollTop) : this.currentScrollTop;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const next = Math.max(0, Math.min(maxScrollTop, requested));
		if (options.exact) {
			this.exactSinceLayout = true;
			this.movedSinceLayout = undefined;
		}
		const nextFollowSuppressedAtEnd = options.disableFollow === true && next === maxScrollTop;
		const nextFollowingEnd = !nextFollowSuppressedAtEnd && this.followEnd && next === maxScrollTop;
		if (
			next === this.currentScrollTop &&
			nextFollowingEnd === this.followingEnd &&
			nextFollowSuppressedAtEnd === this.followSuppressedAtEnd
		) {
			return;
		}
		const moved = next !== this.currentScrollTop;
		if (moved) this.movedSinceLayout = undefined;
		this.currentScrollTop = next;
		this.followingEnd = nextFollowingEnd;
		this.followSuppressedAtEnd = nextFollowSuppressedAtEnd;
		if (moved) this.markScrollbarActivity();
		this.requestRenderCallback?.();
	}

	scrollBy(lines: number): number {
		const requested = Number.isFinite(lines) ? Math.trunc(lines) : 0;
		if (requested === 0) return 0;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const start = this.followingEnd ? maxScrollTop : this.currentScrollTop;
		const next = Math.max(0, Math.min(maxScrollTop, start + requested));
		const moved = next - start;
		const wasFollowingEnd = this.followingEnd;
		if (this.movedSinceLayout !== undefined) this.movedSinceLayout += next - this.currentScrollTop;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd && next === maxScrollTop;
		this.followSuppressedAtEnd = false;
		if (moved !== 0) this.markScrollbarActivity();
		if (moved !== 0 || this.followingEnd !== wasFollowingEnd) this.requestRenderCallback?.();
		this.historyNavigation?.(requested < 0 ? "older" : "newer");
		return requested - moved;
	}

	scrollToStart(): void {
		const changed =
			this.currentScrollTop !== 0 ||
			this.followingEnd !== (this.followEnd && this.contentHeight <= this.currentViewportHeight);
		if (this.currentScrollTop !== 0) this.movedSinceLayout = undefined;
		this.currentScrollTop = 0;
		this.followingEnd = this.followEnd && this.contentHeight <= this.currentViewportHeight;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
		this.historyNavigation?.("start");
	}

	scrollToEnd(): void {
		const next = Math.max(0, this.contentHeight - this.currentViewportHeight);
		const changed = this.currentScrollTop !== next || this.followingEnd !== this.followEnd;
		if (this.currentScrollTop !== next) this.movedSinceLayout = undefined;
		this.currentScrollTop = next;
		this.followingEnd = this.followEnd;
		this.followSuppressedAtEnd = false;
		if (changed) {
			this.markScrollbarActivity();
			this.requestRenderCallback?.();
		}
		this.historyNavigation?.("end");
	}

	updateLayout(
		contentHeight: number,
		viewportHeight: number,
		requestRender: () => void,
		anchoredScrollTop?: number,
	): void {
		this.contentHeight = Math.max(0, Math.floor(contentHeight));
		this.currentViewportHeight = Math.max(0, Math.floor(viewportHeight));
		this.requestRenderCallback = requestRender;
		this.movedSinceLayout = 0;
		this.exactSinceLayout = false;
		const maxScrollTop = Math.max(0, this.contentHeight - this.currentViewportHeight);
		if (this.followingEnd) this.currentScrollTop = maxScrollTop;
		else this.currentScrollTop = Math.max(0, Math.min(anchoredScrollTop ?? this.currentScrollTop, maxScrollTop));
		if (this.currentScrollTop < maxScrollTop) this.followSuppressedAtEnd = false;
		if (this.followEnd && this.currentScrollTop === maxScrollTop && !this.followSuppressedAtEnd) {
			this.followingEnd = true;
		}
		if (this.contentHeight <= this.currentViewportHeight) this.hideTransientScrollbar();
	}

	override addChild(_component: Component): void {
		throw new Error("ScrollView has exactly one child");
	}

	override removeChild(_component: Component): void {
		throw new Error("ScrollView child cannot be removed");
	}

	override clear(): void {
		throw new Error("ScrollView child cannot be cleared");
	}

	override render(width: number): string[] {
		const contentWidth = this.getContentWidth(width);
		const lines = this.child.render(contentWidth);
		return contentWidth === width ? lines : lines.map((line) => `${line} `);
	}

	[LAYOUT_NODE](): ScrollLayoutNode {
		return { type: "scroll", component: this.child, state: this };
	}
}
