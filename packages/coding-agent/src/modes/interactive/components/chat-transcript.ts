import { type Component, type Container, matchesKey, Spacer } from "@earendil-works/pi-tui";

/**
 * Roles that participate in pi's chat spacing contract.
 *
 * Assistant turns own their leading whitespace internally, and tool rows attach
 * directly under the assistant/tool-call row they belong to. User-like rows get
 * one blank line when they are not the first row in the transcript.
 */
export type ChatTranscriptRole =
	| "assistant"
	| "thinking"
	| "tool"
	| "user"
	| "custom"
	| "notice"
	| "system"
	| "summary";

export interface ChatTranscriptEntryLike {
	readonly role: ChatTranscriptRole;
}

export type ChatTranscriptRenderer<TEntry extends ChatTranscriptEntryLike> = (entry: TEntry) => Component;

export type ChatTranscriptCacheKey<TEntry extends ChatTranscriptEntryLike> = (entry: TEntry, index: number) => string;

interface CachedChatTranscriptBlock<TEntry extends ChatTranscriptEntryLike> {
	readonly entry: TEntry;
	readonly key: string;
	readonly width: number;
	readonly component: Component;
	readonly lines: readonly string[];
}

type DisposableComponent = Component & { dispose?: () => void };

/**
 * A run of rows inside a windowed component, tagged with the identity of the
 * thing that produced them.
 *
 * `id` is compared with `===` only, and is never rendered. Entry *objects* are
 * the natural id for a transcript: cache keys carry the entry's index and so
 * change for every survivor of a splice, while the entry objects themselves are
 * moved, not rebuilt.
 */
export interface RowWindowSegment {
	readonly id: unknown;
	readonly rows: number;
}

interface RowWindowComponent extends Component {
	readonly supportsRowWindow: true;
	rowCount(width: number): number;
	renderRows(width: number, startRow: number, endRow: number): string[];
	/**
	 * Optional row map, letting the viewport keep a scroll anchor that sits
	 * *inside* this component when its interior changes height.
	 */
	rowSegments?(width: number): readonly RowWindowSegment[];
}

interface WindowedComponentRows {
	readonly kind: "windowed";
	readonly component: RowWindowComponent;
	readonly rowCount: number;
	readonly segments: readonly RowWindowSegment[] | undefined;
}

interface StaticComponentRows {
	readonly kind: "static";
	readonly lines: readonly string[];
	readonly rowCount: number;
	/**
	 * Present when a static component can still identify its own rows. A
	 * transcript built without a cache key renders every row each frame rather
	 * than windowing, but it knows just as well which entry produced which rows,
	 * and the anchor needs that whenever it is the component spanning the anchor.
	 */
	readonly segments?: readonly RowWindowSegment[] | undefined;
}

type ComponentRows = WindowedComponentRows | StaticComponentRows;

export function addChatTranscriptEntry(container: Container, component: Component, role: ChatTranscriptRole): void {
	if (needsLeadingSpacer(role) && container.children.length > 0) {
		container.addChild(new Spacer(1));
	}
	container.addChild(component);
}

function needsLeadingSpacer(role: ChatTranscriptRole): boolean {
	return role === "user" || role === "custom" || role === "notice" || role === "system" || role === "summary";
}

/**
 * Reusable pi chat transcript scaffold for extension surfaces.
 *
 * This intentionally mirrors InteractiveMode.addMessageToChat spacing without
 * coupling consumers to a full AgentSession. Extension UIs can bring their own
 * message model while still rendering inside the same Container/Spacer rhythm
 * as the main chat.
 */
export class ChatTranscriptComponent<TEntry extends ChatTranscriptEntryLike> implements Component {
	private readonly entries: readonly TEntry[];
	private readonly renderEntry: ChatTranscriptRenderer<TEntry>;
	readonly supportsRowWindow: boolean;

	private readonly cacheKey: ChatTranscriptCacheKey<TEntry> | undefined;
	private blockCache: Array<CachedChatTranscriptBlock<TEntry> | undefined> = [];
	/** Per-entry heights recorded by the most recent `renderAllRows`. */
	private staticSegments: readonly RowWindowSegment[] = [];
	/** Width those heights were measured at; they mean nothing at another width. */
	private staticSegmentsWidth: number | undefined;

	constructor(
		entries: readonly TEntry[],
		renderEntry: ChatTranscriptRenderer<TEntry>,
		cacheKey?: ChatTranscriptCacheKey<TEntry>,
	) {
		this.entries = entries;
		this.renderEntry = renderEntry;
		this.cacheKey = cacheKey;
		this.supportsRowWindow = cacheKey !== undefined;
	}

	render(width: number): string[] {
		if (!this.supportsRowWindow) return this.renderAllRows(width);
		return this.renderRows(width, 0, this.rowCount(width));
	}

	rowCount(width: number): number {
		if (!this.supportsRowWindow) return this.renderAllRows(width).length;
		this.ensureBlockCache(width);
		let count = 0;
		for (const block of this.blockCache) {
			if (block !== undefined) count += block.lines.length;
		}
		return count;
	}

	/**
	 * One segment per cached entry block, identified by the entry object itself.
	 */
	rowSegments(width: number): readonly RowWindowSegment[] {
		if (!this.supportsRowWindow) {
			// Recorded by the last renderAllRows. The viewport measures a static
			// component by rendering it and only then reads its segments, so this
			// is populated for the frame being measured. A width mismatch means the
			// heights describe a different layout, and reporting them would move the
			// anchor by a stale delta; the caller falls back to whole-component
			// accounting instead.
			return this.staticSegmentsWidth === width ? this.staticSegments : [];
		}
		this.ensureBlockCache(width);
		const segments: RowWindowSegment[] = [];
		for (const block of this.blockCache) {
			if (block !== undefined) segments.push({ id: block.entry, rows: block.lines.length });
		}
		return segments;
	}

	renderRows(width: number, startRow: number, endRow: number): string[] {
		const start = Math.max(0, Math.floor(startRow));
		const end = Math.max(start, Math.floor(endRow));
		if (end <= start) return [];
		if (!this.supportsRowWindow) return this.renderAllRows(width).slice(start, end);

		this.ensureBlockCache(width);
		const lines: string[] = [];
		let cursor = 0;
		for (let index = 0; index < this.entries.length; index += 1) {
			const block = this.blockCache[index];
			if (block === undefined) continue;
			const blockStart = cursor;
			const blockEnd = blockStart + block.lines.length;
			if (blockEnd > start && blockStart < end) {
				const localStart = Math.max(0, start - blockStart);
				const localEnd = Math.min(block.lines.length, end - blockStart);
				lines.push(...block.lines.slice(localStart, localEnd));
			}
			cursor = blockEnd;
			if (cursor >= end) break;
		}
		return lines;
	}

	invalidate(): void {
		for (const block of this.blockCache) disposeComponent(block?.component);
		this.blockCache = [];
	}

	private ensureBlockCache(width: number): void {
		if (this.blockCache.length > this.entries.length) {
			for (let index = this.entries.length; index < this.blockCache.length; index += 1) {
				disposeComponent(this.blockCache[index]?.component);
			}
			this.blockCache.length = this.entries.length;
		}
		for (let index = 0; index < this.entries.length; index += 1) {
			const entry = this.entries[index];
			if (entry === undefined) continue;
			const key = this.cacheKey?.(entry, index) ?? `${index}:${entry.role}`;
			const cached = this.blockCache[index];
			if (cached !== undefined && cached.entry === entry && cached.key === key && cached.width === width) {
				continue;
			}
			disposeComponent(cached?.component);
			const component = this.renderEntry(entry);
			this.blockCache[index] = {
				entry,
				key,
				width,
				component,
				lines: this.renderEntryBlock(component, entry, index, width),
			};
		}
	}

	/**
	 * Render every entry, recording each one's height as it goes.
	 *
	 * The heights are what `rowSegments` reports on this path. They are a
	 * by-product of work this method already does, so identifying rows costs
	 * nothing extra and, unlike a cache key, cannot miss an entry mutated in
	 * place -- which is the behaviour a transcript without a cache key exists to
	 * provide.
	 */
	private renderAllRows(width: number): string[] {
		const lines: string[] = [];
		const segments: RowWindowSegment[] = [];
		for (let index = 0; index < this.entries.length; index += 1) {
			const entry = this.entries[index];
			if (entry === undefined) continue;
			const block = this.renderEntryBlock(this.renderEntry(entry), entry, index, width);
			segments.push({ id: entry, rows: block.length });
			lines.push(...block);
		}
		this.staticSegments = segments;
		this.staticSegmentsWidth = width;
		return lines;
	}

	private renderEntryBlock(component: Component, entry: TEntry, index: number, width: number): string[] {
		const lines: string[] = [];
		if (index > 0 && needsLeadingSpacer(entry.role)) lines.push("");
		lines.push(...component.render(width));
		return lines;
	}
}

function disposeComponent(component: Component | undefined): void {
	(component as DisposableComponent | undefined)?.dispose?.();
}

const DEFAULT_SCROLL_STEP_ROWS = 4;

/**
 * Sticky-bottom, scrollable viewport for chat-like component stacks.
 *
 * Pi's main interactive chat gets terminal scrollback for free. Extension
 * overlays render into a fixed rectangle, so they need an explicit viewport
 * with the same sticky-bottom default plus keyboard and mouse history controls.
 */
export class ScrollableComponentViewport implements Component {
	private components: readonly Component[] = [];
	private visibleRows = 1;
	private scrollFromBottom = 0;
	private lastLineCount = 0;
	private lastComponentSegments: readonly (readonly RowWindowSegment[] | undefined)[] = [];
	private lastComponentRowCounts: readonly number[] = [];
	private lastWidth = 0;
	private maxScroll = 0;

	setComponents(components: readonly Component[]): void {
		this.components = components;
	}

	setVisibleRows(rows: number): void {
		this.visibleRows = Math.max(1, Math.floor(rows));
		this.clampScroll();
	}

	getScrollFromBottom(): number {
		return this.scrollFromBottom;
	}

	getMaxScroll(): number {
		return this.maxScroll;
	}

	scrollToBottom(): void {
		this.scrollFromBottom = 0;
	}

	scrollToTop(): void {
		this.scrollFromBottom = this.maxScroll;
	}

	scrollBy(deltaRows: number): void {
		// Positive deltas move toward newer content; negative deltas move up
		// into older history. Store the offset from the sticky bottom so new
		// streaming output can keep following when the offset is zero.
		this.scrollFromBottom -= deltaRows;
		this.clampScroll();
	}

	/**
	 * Park the viewport with `row` as its first visible row.
	 *
	 * The absolute counterpart of `scrollBy`, for a caller that already knows
	 * which row it wants on screen — transcript search revealing a match it
	 * found outside the current window. The target is clamped against the row
	 * count of the **last render**, because that is the only layout this
	 * viewport has measured; a caller that just changed the component stack
	 * should render before scrolling to a row of the new content.
	 */
	scrollTo(row: number): void {
		const target = Math.max(0, Math.min(this.maxScroll, Math.floor(row)));
		this.scrollFromBottom = this.maxScroll - target;
		this.clampScroll();
	}

	/**
	 * Total rows the component stack occupies at `width`, on and off screen.
	 *
	 * This measures rather than paints: it is what lets a search read the whole
	 * transcript instead of the window the reader happens to be parked on.
	 */
	rowCount(width: number): number {
		return this.measureComponentRows(width).reduce((sum, rows) => sum + rows.rowCount, 0);
	}

	/**
	 * Rows `startRow` (inclusive) through `endRow` (exclusive) of the whole
	 * stack, independent of the current scroll offset. Deliberately not paired
	 * with `supportsRowWindow`: a viewport is a scroll container rather than a
	 * windowed component, and an enclosing viewport must keep measuring it by
	 * its visible height.
	 */
	renderRows(width: number, startRow: number, endRow: number): string[] {
		return this.renderVisibleRows(this.measureComponentRows(width), width, startRow, endRow);
	}

	handleInput(data: string): boolean {
		const wheelDeltaRows = mouseWheelDeltaRows(data);
		if (wheelDeltaRows !== 0) {
			this.scrollBy(wheelDeltaRows);
			return true;
		}
		if (isMouseSequence(data)) return true;
		if (matchesKey(data, "pageUp")) {
			this.scrollBy(-this.pageSize());
			return true;
		}
		if (matchesKey(data, "pageDown")) {
			this.scrollBy(this.pageSize());
			return true;
		}
		if (matchesKey(data, "home")) {
			this.scrollToTop();
			return true;
		}
		if (matchesKey(data, "end")) {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const componentRows = this.measureComponentRows(width);
		const rowCounts = componentRows.map((rows) => rows.rowCount);
		const lineCount = rowCounts.reduce((sum, count) => sum + count, 0);
		const maxScroll = Math.max(0, lineCount - this.visibleRows);
		// The offset is a distance from the bottom, so the first visible row is
		// `maxScroll - scrollFromBottom`. Rows appearing or disappearing move the
		// content a scrolled-up viewer is reading unless the offset moves with
		// them -- a live subagent widget does exactly that every time it gains or
		// drops its current-tool row.
		//
		// Which way the offset must move depends on where the rows changed, so a
		// plain `scrollFromBottom += lineCount - lastLineCount` is wrong half the
		// time. Rows changing *below* the anchor need the offset adjusted by that
		// delta; rows changing *above* it need the offset left alone, because the
		// bottom-relative distance to the anchored content did not change. Anchor
		// on the row the viewer is actually reading and re-derive the offset from
		// it. A viewer already at the bottom keeps scrollFromBottom === 0 and is
		// skipped entirely, so sticky-bottom following is untouched.
		//
		// Per-component row counts alone cannot place a change that happens
		// inside the component holding the anchor -- and in the chat host the
		// whole transcript is one component, so that is the normal case. A
		// component that can hand over a row map turns the "where" question into
		// "where did the anchored segment go". Both kinds may supply one: a
		// transcript built without a cache key is not windowed, but it is still
		// one component spanning the anchor and still knows its own rows.
		const segments = componentRows.map((rows) => rows.segments);
		if (this.scrollFromBottom > 0 && this.lastWidth === width) {
			const previousMaxScroll = Math.max(0, this.lastLineCount - this.visibleRows);
			const anchorRow = Math.max(0, previousMaxScroll - this.scrollFromBottom);
			const shift = rowsShiftedAboveAnchor(
				{ rowCounts: this.lastComponentRowCounts, segments: this.lastComponentSegments },
				{ rowCounts, segments },
				anchorRow,
			);
			const nextAnchorRow = Math.max(0, Math.min(maxScroll, anchorRow + shift));
			this.scrollFromBottom = maxScroll - nextAnchorRow;
		}
		this.lastLineCount = lineCount;
		this.lastComponentRowCounts = rowCounts;
		this.lastComponentSegments = segments;
		this.lastWidth = width;
		this.maxScroll = maxScroll;
		this.clampScroll();

		const start = Math.max(0, maxScroll - this.scrollFromBottom);
		const visible = this.renderVisibleRows(componentRows, width, start, start + this.visibleRows);
		while (visible.length < this.visibleRows) visible.push(" ".repeat(width));
		return visible;
	}

	invalidate(): void {
		for (const component of this.components) component.invalidate();
	}

	private measureComponentRows(width: number): ComponentRows[] {
		return this.components.map((component) => {
			if (isRowWindowComponent(component)) {
				return {
					kind: "windowed",
					component,
					rowCount: component.rowCount(width),
					segments: component.rowSegments?.(width),
				};
			}
			const lines = component.render(width);
			// Read segments only after rendering: a static transcript records its
			// per-entry heights as a by-product of that render, so asking first
			// would return the previous frame's layout.
			const segments = segmentReporter(component)?.rowSegments(width);
			return {
				kind: "static",
				lines,
				rowCount: lines.length,
				segments: segments !== undefined && segments.length > 0 ? segments : undefined,
			};
		});
	}

	private renderVisibleRows(
		componentRows: readonly ComponentRows[],
		width: number,
		startRow: number,
		endRow: number,
	): string[] {
		const lines: string[] = [];
		let cursor = 0;
		for (const rows of componentRows) {
			const componentStart = cursor;
			const componentEnd = componentStart + rows.rowCount;
			if (componentEnd > startRow && componentStart < endRow) {
				const localStart = Math.max(0, startRow - componentStart);
				const localEnd = Math.min(rows.rowCount, endRow - componentStart);
				if (rows.kind === "windowed") {
					lines.push(...rows.component.renderRows(width, localStart, localEnd));
				} else {
					lines.push(...rows.lines.slice(localStart, localEnd));
				}
			}
			cursor = componentEnd;
			if (cursor >= endRow) break;
		}
		return lines;
	}

	private pageSize(): number {
		return Math.max(4, this.visibleRows - 2);
	}

	private clampScroll(): void {
		this.scrollFromBottom = Math.max(0, Math.min(this.maxScroll, this.scrollFromBottom));
	}
}

/** One rendered frame's row layout, as the viewport measured it. */
interface ComponentRowLayout {
	readonly rowCounts: readonly number[];
	readonly segments: readonly (readonly RowWindowSegment[] | undefined)[];
}

/**
 * Rows gained or lost above `anchorRow`, measured in the previous frame's rows.
 *
 * The anchored row moves down by exactly this many rows, so adding it to the
 * anchor keeps the same content under the viewer.
 *
 * Components entirely above the anchor contribute their whole height delta.
 * The component that *spans* the anchor contributes only what changed above the
 * anchored row, which needs its row map (`rowSegments`); without one it
 * contributes nothing, which is the old behaviour and is right for the
 * append-and-mutate-at-the-tail widgets that have no interior.
 *
 * Row counts are compared positionally over the shared prefix, which is what the
 * chat stacks this viewport drives actually do — they append and mutate at the
 * tail. A component inserted or removed *ahead* of the anchor would be
 * misattributed; the anchor then lands one component off rather than drifting on
 * every frame, and the next user scroll re-establishes it.
 */
function rowsShiftedAboveAnchor(previous: ComponentRowLayout, next: ComponentRowLayout, anchorRow: number): number {
	let cursor = 0;
	let shift = 0;
	const shared = Math.min(previous.rowCounts.length, next.rowCounts.length);
	for (let index = 0; index < shared; index += 1) {
		const previousRows = previous.rowCounts[index] ?? 0;
		const componentEnd = cursor + previousRows;
		if (componentEnd > anchorRow) {
			return shift + rowsShiftedInsideComponent(previous.segments[index], next.segments[index], anchorRow - cursor);
		}
		shift += (next.rowCounts[index] ?? 0) - previousRows;
		cursor = componentEnd;
	}
	return shift;
}

/**
 * Rows gained or lost above `anchorRow` *within* one windowed component.
 *
 * Rather than diffing heights, this finds the segment the viewer is parked on
 * and reports how far that same segment moved. Segments are matched by `===` on
 * their id, so a transcript splice that renumbers every cache key still lines
 * up: the entry objects survive it. If the anchored segment itself is gone
 * (the viewer was reading rows that were compacted away) the nearest surviving
 * neighbour above it — then below it — stands in, so the viewer lands on the
 * closest content that still exists instead of drifting by the whole delta.
 */
function rowsShiftedInsideComponent(
	previousSegments: readonly RowWindowSegment[] | undefined,
	nextSegments: readonly RowWindowSegment[] | undefined,
	anchorRow: number,
): number {
	if (previousSegments === undefined || nextSegments === undefined) return 0;
	const nextStarts = new Map<unknown, number>();
	let cursor = 0;
	for (const segment of nextSegments) {
		if (!nextStarts.has(segment.id)) nextStarts.set(segment.id, cursor);
		cursor += segment.rows;
	}
	const previousStarts: number[] = [];
	let anchorIndex = -1;
	cursor = 0;
	for (let index = 0; index < previousSegments.length; index += 1) {
		previousStarts.push(cursor);
		cursor += previousSegments[index]?.rows ?? 0;
		if (anchorIndex < 0 && cursor > anchorRow) anchorIndex = index;
	}
	if (anchorIndex < 0) return 0;
	for (let index = anchorIndex; index >= 0; index -= 1) {
		const nextStart = nextStarts.get(previousSegments[index]?.id);
		if (nextStart !== undefined) return nextStart - (previousStarts[index] ?? 0);
	}
	for (let index = anchorIndex + 1; index < previousSegments.length; index += 1) {
		const nextStart = nextStarts.get(previousSegments[index]?.id);
		if (nextStart !== undefined) return nextStart - (previousStarts[index] ?? 0);
	}
	return 0;
}

function isRowWindowComponent(component: Component): component is RowWindowComponent {
	const candidate = component as Partial<RowWindowComponent>;
	return (
		candidate.supportsRowWindow === true &&
		typeof candidate.rowCount === "function" &&
		typeof candidate.renderRows === "function"
	);
}

/**
 * A component that can identify its own rows without being windowed.
 *
 * `ScrollableChatTranscriptComponent` builds its transcript without a cache key
 * — deliberately, because that is what lets it reflect entries mutated in place
 * — so it is not a `RowWindowComponent` and renders every row each frame. It
 * still knows which entry produced which rows, and it is still the component
 * spanning the anchor, so the anchor needs to ask.
 */
function segmentReporter(
	component: Component,
): { rowSegments(width: number): readonly RowWindowSegment[] } | undefined {
	const candidate = component as Partial<RowWindowComponent>;
	return typeof candidate.rowSegments === "function"
		? (candidate as { rowSegments(width: number): readonly RowWindowSegment[] })
		: undefined;
}

export class ScrollableChatTranscriptComponent<TEntry extends ChatTranscriptEntryLike> implements Component {
	private readonly viewport = new ScrollableComponentViewport();
	private readonly transcript: ChatTranscriptComponent<TEntry>;

	constructor(entries: readonly TEntry[], renderEntry: ChatTranscriptRenderer<TEntry>) {
		this.transcript = new ChatTranscriptComponent(entries, renderEntry);
		this.viewport.setComponents([this.transcript]);
	}

	setVisibleRows(rows: number): void {
		this.viewport.setVisibleRows(rows);
	}

	handleInput(data: string): boolean {
		return this.viewport.handleInput(data);
	}

	render(width: number): string[] {
		return this.viewport.render(width);
	}

	invalidate(): void {
		this.viewport.invalidate();
	}

	getScrollFromBottom(): number {
		return this.viewport.getScrollFromBottom();
	}

	getMaxScroll(): number {
		return this.viewport.getMaxScroll();
	}

	scrollToBottom(): void {
		this.viewport.scrollToBottom();
	}
}

function mouseWheelDeltaRows(data: string): number {
	const sgr = data.match(/^\x1b\[<(\d+);\d+;\d+M$/);
	if (sgr) return wheelDeltaForButtonCode(Number.parseInt(sgr[1]!, 10));
	if (data.startsWith("\x1b[M") && data.length >= 6) {
		return wheelDeltaForButtonCode(data.charCodeAt(3) - 32);
	}
	return 0;
}

function wheelDeltaForButtonCode(code: number): number {
	if ((code & 64) === 0) return 0;
	const direction = code & 3;
	if (direction === 0) return -DEFAULT_SCROLL_STEP_ROWS;
	if (direction === 1) return DEFAULT_SCROLL_STEP_ROWS;
	return 0;
}

function isMouseSequence(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M");
}
