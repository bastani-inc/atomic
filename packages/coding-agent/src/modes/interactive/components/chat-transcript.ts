import {
	type Component,
	type Container,
	getKeybindings,
	type KeybindingsManager,
	matchesKey,
	type ScrollViewScrollbar,
	Spacer,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	type WheelScrollLines,
} from "@bastani/atomic-tui";
import { colorEnvironment } from "../theme/color-utils.ts";
import { isUserPromptRow } from "./jump-to-latest.ts";
import { disposeRenderer as disposeComponent } from "./renderer-disposal.js";
import { type ClickExpandableBlock, clickUnit, isClickExpandableBlock } from "./transcript-block-clicks.ts";
import { WheelScrollAccelerator } from "./wheel-scroll-accelerator.ts";

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

/**
 * What an entry's rendered rows depend on beyond the entry object itself. A string is compared whole; parts are
 * compared one by one with `Object.is`, so a host can name the objects and fields an entry renders from without
 * serializing them on every frame.
 */
export type ChatTranscriptCacheKeyValue = string | readonly unknown[];

export type ChatTranscriptCacheKey<TEntry extends ChatTranscriptEntryLike> = (
	entry: TEntry,
	index: number,
) => ChatTranscriptCacheKeyValue;

interface CachedChatTranscriptBlock<TEntry extends ChatTranscriptEntryLike> {
	readonly entry: TEntry;
	readonly key: ChatTranscriptCacheKeyValue;
	readonly width: number;
	readonly component: Component;
	/** The component's own rows, without the leading spacer its position adds. */
	readonly body: readonly string[];
	readonly bodyPromptRows: readonly number[];
	readonly spaced: boolean;
	readonly lines: readonly string[];
	readonly promptRows: readonly number[];
}

/** The blocks a transcript drew and their first rows, at the width it drew them. */
interface CachedTranscriptPaint<TEntry extends ChatTranscriptEntryLike> {
	readonly width: number;
	readonly blocks: readonly (CachedChatTranscriptBlock<TEntry> | undefined)[];
	readonly starts: readonly number[];
}

/** Row offsets of every cached block, kept current from the first block that changed onward. */
interface TranscriptRowLayout {
	readonly starts: number[];
	readonly prompts: number[];
	segments: readonly RowWindowSegment[];
	rowCount: number;
}

/** `ensureBlockCache` found every block current. */
const UNCHANGED = Number.POSITIVE_INFINITY;

/** Stands in for an entry with no block, so blocks keep their positions in a click's sibling list. */
const EMPTY_COMPONENT: Component = { render: () => [], invalidate: () => {} };

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

interface MeasuredRowWindow {
	readonly rowCount: number;
	readonly segments?: readonly RowWindowSegment[];
	renderRows(start: number, end: number): string[];
	findUserPromptRow?(start: number): number | undefined;
}

interface RowWindowComponent extends Component {
	readonly supportsRowWindow: true;
	rowCount(width: number): number;
	renderRows(width: number, startRow: number, endRow: number): string[];
	measureRows?(width: number): MeasuredRowWindow;
	/**
	 * Optional row map, letting the viewport keep a scroll anchor that sits
	 * *inside* this component when its interior changes height.
	 */
	rowSegments?(width: number): readonly RowWindowSegment[];
}

interface WindowedComponentRows {
	readonly kind: "windowed";
	readonly renderRows: MeasuredRowWindow["renderRows"];
	readonly findUserPromptRow: MeasuredRowWindow["findUserPromptRow"];
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
	if (needsLeadingSpacer(role) && container.children.length > 0 && !ownsLeadingSpacer(component)) {
		container.addChild(new Spacer(1));
	}
	container.addChild(component);
}

function ownsLeadingSpacer(component: Component): boolean {
	return "ownsLeadingSpacer" in component && component.ownsLeadingSpacer === true;
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
	/** Only a block whose rows leave measureRows for the actual viewport is visible. */
	onVisibleEntry?: (entry: TEntry) => void;

	private readonly cacheKey: ChatTranscriptCacheKey<TEntry> | undefined;
	private blockCache: Array<CachedChatTranscriptBlock<TEntry> | undefined> = [];
	private measuredRows: MeasuredRowWindow | undefined;
	/** The blocks and their first rows as last drawn, which a click is resolved against. */
	private paintedLayout: CachedTranscriptPaint<TEntry> | undefined;
	private readonly layout: TranscriptRowLayout = { starts: [], prompts: [], segments: [], rowCount: 0 };
	private dirtyEntries = new WeakSet<TEntry>();
	private staticComponents: readonly Component[] = [];
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
		const measured = this.measureRows(width);
		return measured.renderRows(0, measured.rowCount);
	}

	rowCount(width: number): number {
		if (!this.supportsRowWindow) return this.renderAllRows(width).length;
		return this.measureRows(width).rowCount;
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
		return this.measureRows(width).segments ?? [];
	}

	renderRows(width: number, startRow: number, endRow: number): string[] {
		const start = Math.max(0, Math.floor(startRow));
		const end = Math.max(start, Math.floor(endRow));
		if (end <= start) return [];
		if (!this.supportsRowWindow) return this.renderAllRows(width).slice(start, end);
		return this.measureRows(width).renderRows(start, end);
	}

	/**
	 * The row layout of every entry at `width`.
	 *
	 * Work per call is proportional to what changed: an entry is rendered again only when it is new, its cache key
	 * changed, or the width changed, and row offsets are recomputed from the first changed entry onward. Entries that
	 * only moved (a prepend, a splice) keep their rendered rows.
	 */
	measureRows(width: number): MeasuredRowWindow {
		const firstChanged = this.ensureBlockCache(width);
		if (this.measuredRows !== undefined && firstChanged === UNCHANGED) return this.measuredRows;
		this.refreshLayout(Math.min(firstChanged, this.blockCache.length));
		const { starts, prompts, segments, rowCount } = this.layout;
		const blocks = this.blockCache;
		let painted: CachedTranscriptPaint<TEntry> | undefined;
		this.measuredRows = {
			rowCount,
			segments,
			findUserPromptRow: (start) => prompts[indexAtOrBefore(prompts, start)],
			renderRows: (start, end) => {
				// Drawing these rows is what the reader sees; a click resolves against this layout until the next draw,
				// though a search or prompt jump may measure the transcript again before then.
				painted ??= { width, blocks: [...blocks], starts: [...starts] };
				this.paintedLayout = painted;
				const lines: string[] = [];
				for (let index = Math.max(0, indexAtOrBefore(starts, start)); index < blocks.length; index++) {
					const block = blocks[index];
					const blockStart = starts[index] ?? 0;
					if (blockStart >= end) break;
					if (block === undefined) continue;
					const localEnd = Math.min(block.lines.length, end - blockStart);
					if (localEnd > Math.max(0, start - blockStart)) this.onVisibleEntry?.(block.entry);
					for (let row = Math.max(0, start - blockStart); row < localEnd; row++) {
						lines.push(block.lines[row] ?? "");
					}
				}
				return lines;
			},
		};
		return this.measuredRows;
	}

	/** The entry whose block the last draw at `width` put on row `row`, and the row within that block. */
	paintedEntryAt(width: number, row: number): { readonly entry: TEntry; readonly row: number } | undefined {
		const painted = this.paintedLayout;
		if (!this.supportsRowWindow || row < 0 || painted === undefined || painted.width !== width) return undefined;
		const index = indexAtOrBefore(painted.starts, row);
		const block = painted.blocks[index];
		const start = painted.starts[index] ?? 0;
		if (block === undefined || row - start >= block.lines.length) return undefined;
		return { entry: block.entry, row: row - start };
	}

	/**
	 * The entries whose blocks a single click on row `row` of the transcript, as last laid out at `width`, expands or
	 * collapses, and those blocks as drawn. Undefined unless the row is one a block draws; only a windowed transcript,
	 * one built with a cache key, can tell.
	 */
	clickedEntries(
		width: number,
		row: number,
	):
		| {
				readonly target: TEntry;
				readonly entries: readonly TEntry[];
				readonly blocks: readonly ClickExpandableBlock[];
		  }
		| undefined {
		const painted = this.paintedLayout;
		if (!this.supportsRowWindow || row < 0 || painted === undefined || painted.width !== width) return undefined;
		// The rows as last drawn, which is what the reader saw: entries that arrived since are not drawn yet.
		const blocks = painted.blocks;
		const index = indexAtOrBefore(painted.starts, row);
		const block = blocks[index];
		if (block === undefined) return undefined;
		const bodyRow = row - (painted.starts[index] ?? 0) - (block.spaced ? 1 : 0);
		if (bodyRow < 0 || bodyRow >= block.body.length) return undefined;
		if (!isClickExpandableBlock(block.component)) return undefined;
		const area = block.component.clickArea(width);
		if (!area || bodyRow < area.start || bodyRow >= area.end) return undefined;
		return this.clickGroupAt(blocks, index);
	}

	/** The target's current group and data, at the width of the body that will expand. */
	currentClickGroup(width: number, entry: TEntry) {
		this.measureRows(width);
		return this.clickGroupAt(this.blockCache, this.entries.indexOf(entry));
	}

	private clickGroupAt(blocks: readonly (CachedChatTranscriptBlock<TEntry> | undefined)[], index: number) {
		const target = blocks[index]?.entry;
		if (target === undefined) return undefined;
		const components = blocks.map((candidate) => candidate?.component ?? EMPTY_COMPONENT);
		const unit = clickUnit(components, index);
		if (unit === undefined) return undefined;
		const entryOf = new Map<Component, TEntry>();
		for (const candidate of blocks) if (candidate !== undefined) entryOf.set(candidate.component, candidate.entry);
		const entries = unit.flatMap((component) => {
			const entry = entryOf.get(component);
			return entry === undefined ? [] : [entry];
		});
		return { target, entries, blocks: unit };
	}

	requestEntryRender(entry: TEntry): void {
		this.dirtyEntries.add(entry);
		this.measuredRows = undefined;
	}

	invalidate(): void {
		for (const block of this.blockCache) disposeComponent(block?.component);
		for (const component of new Set(this.staticComponents)) disposeComponent(component);
		this.blockCache = [];
		this.staticComponents = [];
		this.dirtyEntries = new WeakSet<TEntry>();
		this.measuredRows = undefined;
		this.paintedLayout = undefined;
	}

	/**
	 * Brings every block up to date. Returns the index of the first block whose rows or position may have changed,
	 * or `UNCHANGED`.
	 */
	private ensureBlockCache(width: number): number {
		const entries = this.entries;
		const previous = this.blockCache;
		if (sameEntries(previous, entries)) {
			let firstChanged = UNCHANGED;
			for (let index = 0; index < entries.length; index++) {
				const cached = previous[index];
				const block = this.currentBlock(entries[index], index, width, cached);
				if (block === cached) continue;
				if (cached !== undefined && cached.component !== block?.component) disposeComponent(cached.component);
				previous[index] = block;
				firstChanged = Math.min(firstChanged, index);
			}
			return firstChanged;
		}
		// Entries were added, removed or moved: find each one's block by identity, so a moved entry keeps its rows.
		const byEntry = new Map<TEntry, CachedChatTranscriptBlock<TEntry>>();
		for (const block of previous) if (block !== undefined) byEntry.set(block.entry, block);
		const kept = new Set<Component>();
		const next: Array<CachedChatTranscriptBlock<TEntry> | undefined> = [];
		let firstChanged = Math.min(previous.length, entries.length);
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			const block = this.currentBlock(entry, index, width, entry === undefined ? undefined : byEntry.get(entry));
			if (block !== undefined) kept.add(block.component);
			next.push(block);
			if (block !== previous[index]) firstChanged = Math.min(firstChanged, index);
		}
		for (const block of previous) {
			if (block !== undefined && !kept.has(block.component)) disposeComponent(block.component);
		}
		this.blockCache = next;
		return firstChanged;
	}

	/**
	 * `cached` while it still shows `entry` at `index`; otherwise the entry's block, rendered again only when its key or
	 * the width changed. A block whose position alone changed keeps its rendered rows and only gains or loses its
	 * leading spacer. The caller disposes a replaced component.
	 */
	private currentBlock(
		entry: TEntry | undefined,
		index: number,
		width: number,
		cached: CachedChatTranscriptBlock<TEntry> | undefined,
	): CachedChatTranscriptBlock<TEntry> | undefined {
		if (entry === undefined) return undefined;
		const key = this.cacheKey?.(entry, index) ?? `${index}:${entry.role}`;
		const spaced = index > 0 && needsLeadingSpacer(entry.role);
		const reusable = cached !== undefined && cached.width === width && sameCacheKey(cached.key, key);
		if (reusable && !this.dirtyEntries.has(entry)) {
			const cachedSpaced = spaced && leadsWithSpacer(cached.component, cached.body);
			return cached.spaced === cachedSpaced ? cached : withSpacing(cached, cachedSpaced);
		}
		this.dirtyEntries.delete(entry);
		const component = reusable ? cached.component : this.renderEntry(entry);
		const body = component.render(width);
		const bodyPromptRows: number[] = [];
		for (let row = 0; row < body.length; row++) {
			if (isUserPromptRow(body[row] ?? "")) bodyPromptRows.push(row);
		}
		const blockSpaced = spaced && leadsWithSpacer(component, body);
		return withSpacing(
			{ entry, key, width, component, body, bodyPromptRows, spaced: blockSpaced, lines: [], promptRows: [] },
			blockSpaced,
		);
	}

	/** Recomputes row offsets, prompt rows and segments from block `from` onward; earlier blocks did not move. */
	private refreshLayout(from: number): void {
		const layout = this.layout;
		const blocks = this.blockCache;
		let row = from === 0 ? 0 : (layout.starts[from - 1] ?? 0) + (blocks[from - 1]?.lines.length ?? 0);
		layout.starts.length = blocks.length;
		layout.prompts.length = indexAtOrBefore(layout.prompts, row - 1) + 1;
		const segments = layout.segments.slice(0, from);
		for (let index = from; index < blocks.length; index++) {
			const block = blocks[index];
			layout.starts[index] = row;
			const rows = block?.lines.length ?? 0;
			if (block !== undefined) {
				segments.push({ id: block.entry, rows });
				for (const promptRow of block.promptRows) layout.prompts.push(row + promptRow);
			}
			row += rows;
		}
		layout.segments = segments;
		layout.rowCount = row;
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
		const nextComponents: Component[] = [];
		try {
			for (let index = 0; index < this.entries.length; index += 1) {
				const entry = this.entries[index];
				if (entry === undefined) continue;
				const component = this.renderEntry(entry);
				nextComponents.push(component);
				const block = this.renderEntryBlock(component, entry, index, width);
				segments.push({ id: entry, rows: block.length });
				for (const line of block) lines.push(line);
			}
		} finally {
			const retained = new Set(nextComponents);
			for (const component of new Set(this.staticComponents)) {
				if (!retained.has(component)) disposeComponent(component);
			}
			this.staticComponents = nextComponents;
		}
		this.staticSegments = segments;
		this.staticSegmentsWidth = width;
		return lines;
	}

	private renderEntryBlock(component: Component, entry: TEntry, index: number, width: number): string[] {
		const rendered = component.render(width);
		if (rendered.length === 0) return [];
		const lines: string[] = [];
		if (index > 0 && needsLeadingSpacer(entry.role) && !ownsLeadingSpacer(component)) lines.push("");
		for (const line of rendered) lines.push(line);
		return lines;
	}
}

function indexAtOrBefore(sorted: readonly number[], target: number): number {
	let low = 0;
	let high = sorted.length;
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if ((sorted[middle] ?? 0) <= target) low = middle + 1;
		else high = middle;
	}
	return low - 1;
}

function sameEntries<TEntry extends ChatTranscriptEntryLike>(
	blocks: ReadonlyArray<CachedChatTranscriptBlock<TEntry> | undefined>,
	entries: readonly TEntry[],
): boolean {
	if (blocks.length !== entries.length) return false;
	for (let index = 0; index < entries.length; index++) if (blocks[index]?.entry !== entries[index]) return false;
	return true;
}

function sameCacheKey(left: ChatTranscriptCacheKeyValue, right: ChatTranscriptCacheKeyValue): boolean {
	if (left === right) return true;
	if (typeof left === "string" || typeof right === "string" || left.length !== right.length) return false;
	for (let index = 0; index < left.length; index++) if (!Object.is(left[index], right[index])) return false;
	return true;
}

/** The block's rows at its position: one blank row ahead of a user-like entry that is not the first. */
function withSpacing<TEntry extends ChatTranscriptEntryLike>(
	block: CachedChatTranscriptBlock<TEntry>,
	spaced: boolean,
): CachedChatTranscriptBlock<TEntry> {
	return {
		...block,
		spaced,
		lines: spaced ? ["", ...block.body] : block.body,
		promptRows: spaced ? block.bodyPromptRows.map((row) => row + 1) : block.bodyPromptRows,
	};
}

function leadsWithSpacer(component: Component, body: readonly string[]): boolean {
	return body.length > 0 && !ownsLeadingSpacer(component);
}

/** Alt+wheel moves this many wheel steps at once, as the main transcript does. */
export const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
/** How long an `"auto"` scrollbar stays visible after the last scroll. */
export const SCROLLBAR_HIDE_DELAY_MS = 1000;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:;[^\x07\x1b]*)?(?:\x07|\x1b\\)/;
const SCROLLBAR_THUMB = "┃";
const SCROLLBAR_TRACK = "│";
const SCROLLBAR_CELL_RESET = "\x1b[0m\x1b]8;;\x07";
const PINNED_PROMPT_SCAN_ROWS = 64;
const MAX_PINNED_PROMPT_SCAN_ROWS = 16_384;

/** Settings and hooks of a {@link ScrollableComponentViewport}; every member is optional. */
export interface ScrollableComponentViewportOptions {
	/** Rows per wheel event, or `"auto"` to follow wheel velocity (`fullscreenWheelScrollLines`). Default `"auto"`. */
	readonly wheelScrollLines?: () => WheelScrollLines | undefined;
	/** Scrollbar display (`fullscreenScrollbar`). Default `"hidden"`. */
	readonly scrollbar?: () => ScrollViewScrollbar | undefined;
	/** Painted in the last row while the viewport is scrolled away from its live end. */
	readonly followIndicator?: Pick<Component, "render">;
	readonly pinnedPrompt?: (promptRow: string) => string;
	readonly observeFollowing?: (following: boolean) => void;
	/** Asked to repaint when an `"auto"` scrollbar hides. */
	readonly requestRender?: () => void;
	/** Called after a render whose first row lies within one viewport of the top. */
	readonly onNearTop?: () => void;
	/** Milliseconds, for wheel velocity and the `"auto"` scrollbar. Default `performance.now()`. */
	readonly now?: () => number;
	/** Whether `"auto"` wheel scrolling accelerates; by default only where the terminal does not already. */
	readonly accelerateWheel?: boolean;
	readonly scrollbarThumbStyle?: (text: string) => string;
	readonly scrollbarTrackStyle?: (text: string) => string;
}

export interface WheelReport {
	readonly direction: -1 | 1;
	readonly alt: boolean;
}

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
	/** Where the last frame drew content: its first stack row, and the frame rows the pinned prompt took above it. */
	private lastPaint: { readonly start: number; readonly pinRows: number; readonly contentRows: number } | undefined;
	private maxScroll = 0;
	/**
	 * Absolute row `scrollTo` asked for, still waiting for the render that can
	 * honour it. See `scrollTo` for why the request has to outlive the call.
	 */
	private pendingScrollRow: number | undefined;
	/** Ctrl+Home holds the first row of content taller than the view, also while earlier history loads, until another scroll. */
	private pinnedToTop = false;
	private readonly keybindings: Pick<KeybindingsManager, "matches"> | undefined;
	private readonly options: ScrollableComponentViewportOptions;
	private readonly wheel: WheelScrollAccelerator;
	private wheelLines: WheelScrollLines = "auto";
	private lastScrollAt = Number.NEGATIVE_INFINITY;
	private scrollbarHideTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(keybindings?: unknown, options: ScrollableComponentViewportOptions = {}) {
		const candidate = keybindings as Partial<Pick<KeybindingsManager, "matches">> | undefined;
		this.keybindings =
			typeof candidate?.matches === "function" ? (candidate as Pick<KeybindingsManager, "matches">) : undefined;
		this.options = options;
		this.wheel = new WheelScrollAccelerator(this.wheelLines, options.accelerateWheel);
	}

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
		const previous = this.scrollFromBottom;
		this.pinnedToTop = false;
		this.pendingScrollRow = undefined;
		this.scrollFromBottom = 0;
		this.noteScroll(previous);
	}

	/** The first row, also of rows a render has not measured yet, such as earlier history that loads later. */
	scrollToTop(): void {
		this.scrollTo(0);
		this.pinnedToTop = true;
	}

	scrollBy(deltaRows: number): void {
		// Positive deltas move toward newer content; negative deltas move up
		// into older history. Store the offset from the sticky bottom so new
		// streaming output can keep following when the offset is zero.
		const previous = this.scrollFromBottom;
		this.pinnedToTop = false;
		this.pendingScrollRow = undefined;
		this.scrollFromBottom -= deltaRows;
		this.clampScroll();
		this.noteScroll(previous);
	}

	/**
	 * Park the viewport with `row` as its first visible row.
	 *
	 * The absolute counterpart of `scrollBy`, for a caller that already knows
	 * which row it wants on screen.
	 *
	 * The request is *also* recorded for the next render, and that is the half
	 * that matters. `scrollFromBottom` is a distance from the bottom, so the
	 * row it names moves whenever the stack grows; and the render that follows
	 * re-derives the offset from the previous frame's layout to hold a
	 * scrolled-up reader's content still, which would drag this request back
	 * with it. A caller who has just measured rows the last render never saw
	 * would otherwise be answered with the old layout's clamp and the old
	 * frame's anchor. The next render resolves the row against the layout it
	 * actually paints; any other scroll before then withdraws the request.
	 */
	scrollTo(row: number): void {
		const previous = this.scrollFromBottom;
		const requestedRow = Number.isNaN(row) ? 0 : Math.max(0, Math.floor(row));
		this.pinnedToTop = false;
		this.pendingScrollRow = requestedRow;
		const target = Math.min(this.maxScroll, requestedRow);
		this.scrollFromBottom = this.maxScroll - target;
		this.clampScroll();
		this.noteScroll(previous);
	}

	/**
	 * Total rows the component stack occupies at `width`, on and off screen.
	 *
	 * This measures rather than paints: it is what lets a search read the whole
	 * transcript instead of the window the reader happens to be parked on.
	 */
	rowCount(width: number): number {
		return this.measureComponentRows(this.contentWidth(width)).reduce((sum, rows) => sum + rows.rowCount, 0);
	}

	/**
	 * Rows `startRow` (inclusive) through `endRow` (exclusive) of the whole
	 * stack, independent of the current scroll offset. Deliberately not paired
	 * with `supportsRowWindow`: a viewport is a scroll container rather than a
	 * windowed component, and an enclosing viewport must keep measuring it by
	 * its visible height.
	 */
	renderRows(width: number, startRow: number, endRow: number): string[] {
		const contentWidth = this.contentWidth(width);
		return this.renderVisibleRows(this.measureComponentRows(contentWidth), startRow, endRow);
	}

	handleInput(data: string): boolean {
		const wheel = parseWheelReport(data);
		if (wheel !== undefined) {
			const lines = this.wheelStep(wheel.direction);
			this.scrollBy(wheel.direction * (wheel.alt ? lines * ALT_WHEEL_SCROLL_MULTIPLIER : lines));
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
		const keybindings = this.keybindings ?? getKeybindings();
		if (keybindings.matches(data, "tui.altScreen.halfPageUp")) {
			this.scrollBy(-this.halfPageSize());
			return true;
		}
		if (keybindings.matches(data, "tui.altScreen.halfPageDown")) {
			this.scrollBy(this.halfPageSize());
			return true;
		}
		if (keybindings.matches(data, "tui.altScreen.previousPrompt")) {
			this.scrollToPrompt(-1);
			return true;
		}
		if (keybindings.matches(data, "tui.altScreen.nextPrompt")) {
			this.scrollToPrompt(1);
			return true;
		}
		if (keybindings.matches(data, "tui.altScreen.top")) {
			this.scrollToTop();
			return true;
		}
		if (keybindings.matches(data, "tui.altScreen.bottom")) {
			this.scrollToBottom();
			return true;
		}
		return false;
	}

	render(width: number): string[] {
		const scrollbar = this.scrollbarMode();
		const contentWidth = this.contentWidth(width, scrollbar);
		const componentRows = this.measureComponentRows(contentWidth);
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
		// Content that fits on one screen has no top to hold: Ctrl+Home there keeps following, as the main transcript does.
		if (maxScroll === 0) this.pinnedToTop = false;
		const pendingScrollRow = this.pinnedToTop ? 0 : this.pendingScrollRow;
		this.pendingScrollRow = undefined;
		if (pendingScrollRow !== undefined) {
			// An absolute request outranks the anchor: the caller measured this
			// frame's rows and named one of them. Re-deriving the anchor here
			// would answer with the previous frame's layout instead.
			this.scrollFromBottom = maxScroll - Math.min(maxScroll, pendingScrollRow);
		} else if (this.scrollFromBottom > 0 && this.lastWidth === contentWidth) {
			// The row the reader had at the top in the last frame, so a change of height keeps it there.
			const anchorRow = Math.max(0, this.maxScroll - this.scrollFromBottom);
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
		this.lastWidth = contentWidth;
		this.maxScroll = maxScroll;
		this.clampScroll();

		this.options.observeFollowing?.(this.scrollFromBottom === 0);
		const start = Math.max(0, maxScroll - this.scrollFromBottom);
		const indicator =
			this.scrollFromBottom > 0 && this.visibleRows > 1
				? (this.options.followIndicator?.render(width).slice(0, 1) ?? [])
				: [];
		const pinned =
			this.scrollFromBottom > 0 && start > 0 && this.visibleRows - indicator.length > 2
				? this.pinnedPromptRow(componentRows, start)
				: undefined;
		const pin = pinned === undefined ? [] : [truncateToWidth(pinned, contentWidth, "")];
		const contentRows = this.visibleRows - indicator.length - pin.length;
		this.lastPaint = { start, pinRows: pin.length, contentRows };
		const visible = [
			...pin,
			...this.renderVisibleRows(componentRows, start, start + contentRows).map(withoutTerminalControl),
		];
		while (visible.length < contentRows + pin.length) visible.push(" ".repeat(contentWidth));
		const painted = this.paintScrollbar(visible, width, scrollbar, { lineCount, start, maxScroll });
		if (start < this.visibleRows) this.options.onNearTop?.();
		return [...painted, ...indicator];
	}

	/**
	 * The component the last frame drew on frame row `row`, the row inside that component, and the width it was laid
	 * out at. Undefined for the pinned prompt row, the jump-to-latest row and rows past the content.
	 */
	componentAtRow(
		row: number,
	): { readonly component: Component; readonly row: number; readonly width: number } | undefined {
		const paint = this.lastPaint;
		if (paint === undefined) return undefined;
		const contentRow = row - paint.pinRows;
		if (contentRow < 0 || contentRow >= paint.contentRows) return undefined;
		let stackRow = paint.start + contentRow;
		for (let index = 0; index < this.lastComponentRowCounts.length; index++) {
			const rows = this.lastComponentRowCounts[index] ?? 0;
			const component = this.components[index];
			if (stackRow < rows)
				return component === undefined ? undefined : { component, row: stackRow, width: this.lastWidth };
			stackRow -= rows;
		}
		return undefined;
	}

	/** The content width the last frame gave its transcript, after reserving any scrollbar. */
	get paintedContentWidth(): number {
		return this.lastWidth;
	}

	/** The first stack row the last frame drew, for holding the view where it is. */
	firstVisibleRow(): number | undefined {
		return this.lastPaint?.start;
	}

	/** Stops the timer that hides an `"auto"` scrollbar. */
	dispose(): void {
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = undefined;
	}

	invalidate(): void {
		for (const component of this.components) component.invalidate();
	}

	private measureComponentRows(width: number): ComponentRows[] {
		return this.components.map((component) => {
			if (isRowWindowComponent(component)) {
				const measured = component.measureRows?.(width);
				return {
					kind: "windowed",
					renderRows: measured?.renderRows ?? ((start, end) => component.renderRows(width, start, end)),
					findUserPromptRow: measured?.findUserPromptRow,
					rowCount: measured?.rowCount ?? component.rowCount(width),
					segments: measured?.segments ?? component.rowSegments?.(width),
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

	private renderVisibleRows(componentRows: readonly ComponentRows[], startRow: number, endRow: number): string[] {
		const lines: string[] = [];
		let cursor = 0;
		for (const rows of componentRows) {
			const componentStart = cursor;
			const componentEnd = componentStart + rows.rowCount;
			if (componentEnd > startRow && componentStart < endRow) {
				const localStart = Math.max(0, startRow - componentStart);
				const localEnd = Math.min(rows.rowCount, endRow - componentStart);
				const selected =
					rows.kind === "windowed"
						? rows.renderRows(localStart, localEnd)
						: rows.lines.slice(localStart, localEnd);
				for (const line of selected) lines.push(line);
			}
			cursor = componentEnd;
			if (cursor >= endRow) break;
		}
		return lines;
	}

	private pageSize(): number {
		return Math.max(4, this.visibleRows - 2);
	}

	private halfPageSize(): number {
		return Math.max(1, Math.floor(this.visibleRows / 2));
	}

	private clampScroll(): void {
		this.scrollFromBottom = Math.max(0, Math.min(this.maxScroll, this.scrollFromBottom));
	}

	private now(): number {
		return this.options.now?.() ?? performance.now();
	}

	private wheelStep(direction: -1 | 1): number {
		const lines = this.options.wheelScrollLines?.() ?? "auto";
		if (lines !== this.wheelLines) {
			this.wheelLines = lines;
			this.wheel.setLines(lines);
		}
		return this.wheel.next(direction, this.now());
	}

	private scrollbarMode(): ScrollViewScrollbar {
		return this.options.scrollbar?.() ?? "hidden";
	}

	/** `"always"` keeps the rightmost column for the scrollbar; the other modes paint over content. */
	private contentWidth(width: number, scrollbar = this.scrollbarMode()): number {
		return scrollbar === "always" && width > 1 ? width - 1 : width;
	}

	/** Shows an `"auto"` scrollbar for {@link SCROLLBAR_HIDE_DELAY_MS} after the position actually changed. */
	private noteScroll(previousScrollFromBottom: number): void {
		if (this.scrollFromBottom === previousScrollFromBottom && this.pendingScrollRow === undefined) return;
		this.lastScrollAt = this.now();
		if (this.scrollbarMode() !== "auto" || this.options.requestRender === undefined) return;
		clearTimeout(this.scrollbarHideTimer);
		this.scrollbarHideTimer = setTimeout(() => {
			this.scrollbarHideTimer = undefined;
			this.options.requestRender?.();
		}, SCROLLBAR_HIDE_DELAY_MS);
		this.scrollbarHideTimer.unref?.();
	}

	private scrollbarVisible(scrollbar: ScrollViewScrollbar, lineCount: number, trackRows: number): boolean {
		if (scrollbar === "always") return trackRows > 0;
		return scrollbar === "auto" && lineCount > trackRows && this.now() - this.lastScrollAt < SCROLLBAR_HIDE_DELAY_MS;
	}

	/** The thumb geometry follows the main transcript's scrollbar: proportional, at least two rows. */
	private paintScrollbar(
		rows: readonly string[],
		width: number,
		scrollbar: ScrollViewScrollbar,
		position: { readonly lineCount: number; readonly start: number; readonly maxScroll: number },
	): string[] {
		const track = rows.length;
		if (width < 2 || !this.scrollbarVisible(scrollbar, position.lineCount, track)) return [...rows];
		const thumbHeight = Math.max(
			Math.min(2, track),
			Math.min(track, Math.round((track * track) / Math.max(1, position.lineCount))),
		);
		const thumbTop =
			position.maxScroll === 0 ? 0 : Math.round((position.start / position.maxScroll) * (track - thumbHeight));
		// The default colors are off with NO_COLOR or FORCE_COLOR=0; the viewport may paint before any theme loads.
		const plain = colorEnvironment().off;
		const thumbStyle =
			this.options.scrollbarThumbStyle ?? ((text: string) => (plain ? text : `\x1b[37m${text}\x1b[39m`));
		const trackStyle =
			this.options.scrollbarTrackStyle ?? ((text: string) => (plain ? text : `\x1b[90m${text}\x1b[39m`));
		const cellWidth = width - 1;
		return rows.map((row, index) => {
			const cell = truncateToWidth(row, cellWidth, "");
			const padding = " ".repeat(Math.max(0, cellWidth - visibleWidth(cell)));
			const thumb = index >= thumbTop && index < thumbTop + thumbHeight;
			return `${cell}${padding}${SCROLLBAR_CELL_RESET}${thumb ? thumbStyle(SCROLLBAR_THUMB) : trackStyle(SCROLLBAR_TRACK)}`;
		});
	}

	private pinnedPromptRow(componentRows: ComponentRows[], start: number): string | undefined {
		const style = this.options.pinnedPrompt;
		if (!style) return undefined;
		const prompt = this.findUserPromptRow(componentRows, start);
		if (prompt === undefined) return undefined;
		let cursor = prompt;
		let windowRows = 1;
		while (cursor < start) {
			const end = Math.min(start, cursor + windowRows);
			const text = firstPromptTextRow(this.renderVisibleRows(componentRows, cursor, end));
			if (text !== undefined) return style(text);
			cursor = end;
			windowRows = PINNED_PROMPT_SCAN_ROWS;
		}
		return undefined;
	}

	private findUserPromptRow(componentRows: readonly ComponentRows[], start: number): number | undefined {
		let componentEnd = componentRows.reduce((total, rows) => total + rows.rowCount, 0);
		for (let index = componentRows.length - 1; index >= 0; index--) {
			const rows = componentRows[index];
			if (rows === undefined) continue;
			const componentStart = componentEnd - rows.rowCount;
			componentEnd = componentStart;
			if (componentStart > start || rows.rowCount === 0) continue;
			const last = Math.min(rows.rowCount - 1, start - componentStart);
			if (rows.kind === "windowed" && rows.findUserPromptRow !== undefined) {
				const prompt = rows.findUserPromptRow(last);
				if (prompt !== undefined) return componentStart + prompt;
				continue;
			}
			if (rows.kind === "static") {
				for (let row = last; row >= 0; row--) {
					if (isUserPromptRow(rows.lines[row] ?? "")) return componentStart + row;
				}
				continue;
			}
			let windowRows = PINNED_PROMPT_SCAN_ROWS;
			for (let end = last + 1; end > 0; ) {
				const begin = Math.max(0, end - windowRows);
				const lines = rows.renderRows(begin, end);
				for (let row = lines.length - 1; row >= 0; row--) {
					if (isUserPromptRow(lines[row] ?? "")) return componentStart + begin + row;
				}
				end = begin;
				windowRows = Math.min(MAX_PINNED_PROMPT_SCAN_ROWS, windowRows * 2);
			}
		}
		return undefined;
	}

	/** Parks the nearest semantic prompt (an OSC 133 `A` mark) above or below the first visible row at the top. */
	private scrollToPrompt(direction: -1 | 1): void {
		if (this.lastWidth <= 0) return;
		const rows = this.renderVisibleRows(this.measureComponentRows(this.lastWidth), 0, this.lastLineCount);
		const top = Math.max(0, this.maxScroll - this.scrollFromBottom);
		for (let row = top + direction; row >= 0 && row < rows.length; row += direction) {
			if (!OSC133_PROMPT_START.test(rows[row] ?? "")) continue;
			this.scrollTo(row);
			return;
		}
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

/** A vertical wheel report (SGR or legacy X10 encoding), with its direction and whether Alt was held. */
export function parseWheelReport(data: string): WheelReport | undefined {
	const sgr = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
	const code =
		sgr !== null
			? Number.parseInt(sgr[1] ?? "", 10)
			: data.startsWith("\x1b[M") && data.length >= 6
				? data.charCodeAt(3) - 32
				: undefined;
	if (code === undefined || (code & 64) === 0) return undefined;
	const button = code & 3;
	if (button > 1) return undefined;
	return { direction: button === 0 ? -1 : 1, alt: (code & 8) !== 0 };
}

const CONTROL_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONTROL_CHARACTER = /[\x00-\x06\x08-\x1a\x1c-\x1f\x7f]/g;

/**
 * A transcript row without the cursor movement, erasing and other control a message may carry: SGR styling,
 * OSC links and prompt marks, and APC images stay. Rows a viewport paints sit inside a fixed rectangle, which
 * anything else would break out of.
 */
function withoutTerminalControl(row: string): string {
	return row
		.replace(CONTROL_SEQUENCE, (sequence) => (sequence.endsWith("m") ? sequence : ""))
		.replace(CONTROL_CHARACTER, " ");
}

function firstPromptTextRow(rows: readonly string[]): string | undefined {
	for (const row of rows) {
		const text = stripTerminalSequences(row);
		if (text.trim()) return text;
	}
	return undefined;
}

function isMouseSequence(data: string): boolean {
	return /^\x1b\[<\d+;\d+;\d+[mM]$/.test(data) || data.startsWith("\x1b[M");
}
