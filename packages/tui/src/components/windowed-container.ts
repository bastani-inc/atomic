import { type Component, Container } from "../tui.ts";

export interface HistoryRowPosition {
	readonly source: symbol;
	readonly seq: number;
	readonly block: number;
	readonly part: number;
	readonly line: number;
	/** The row stands in for a card whose call and result are drawn on different pages: what it shows depends on which
	 * pages are mounted, so a selection never captures it and a copy draws its entry as the whole transcript does. */
	readonly provisional?: true;
}
const archivePositions = new WeakMap<Component, Omit<HistoryRowPosition, "line">>();

/** A saved leaf: a rendered part of a saved entry, without the row within it. */
export type HistoryLeaf = Omit<HistoryRowPosition, "line">;

/** The rows of one saved leaf that is not mounted, drawn on request. */
export interface HistoryRowsBlock {
	readonly position: HistoryLeaf;
	readonly lines: readonly string[];
}

/** Saved rows that are no longer, or never were, mounted below a history anchor. */
export interface HistorySource {
	/** The last sequence number of the saved rows. */
	readonly last: number;
	/** Draw, without mounting, the saved leaves of entries `from` through `to` at `width`, in document order. */
	read(from: number, to: number, width: number): Promise<readonly HistoryRowsBlock[]>;
}

/** The row that stands for a source's saved history: its mounted saved rows follow it, and everything else of the
 * source can be drawn on request. */
export interface HistoryAnchorView {
	readonly source: symbol;
	readonly edges: HistoryRunEdges;
	/** The first saved leaf mounted right below the anchor, if any. */
	readonly first?: HistoryLeaf;
	readonly last: number;
	/** Draw saved rows at the width of this layout. */
	read(from: number, to: number): Promise<readonly HistoryRowsBlock[]>;
}

const historyAnchors = new WeakMap<Component, { readonly source: symbol; readonly history: HistorySource }>();

/** The rows just outside a run of saved rows from one source, which stay in place when the run is released. */
export interface HistoryRunEdges {
	readonly source: symbol;
	/** The last row above the run, if any. */
	readonly above?: () => number | undefined;
	/** The first row below the run, if any. */
	readonly below?: () => number | undefined;
}

export interface WindowRows {
	readonly length: number;
	at(index: number): string | undefined;
	/** A weak position within a painted leaf; resolving it never draws or requests history. */
	trackRow?(index: number): (() => number | undefined) | undefined;
	historyRow?(index: number): HistoryRowPosition | undefined;
	/** Weak positions of the rows around the saved run that holds `index`; no render, read or retained leaf. */
	historyEdges?(index: number): HistoryRunEdges | undefined;
	/** The mounted history anchor of this document, if any. */
	historyAnchor?(): HistoryAnchorView | undefined;
	/** Visit the rows of the mounted saved entries around `index` from `from` through `to`, in order, drawing an entry
	 * not yet drawn at this width as the background sweep would. A provisional leaf that draws no row is visited once,
	 * with an empty line. Never requests an unmounted page. */
	visitHistoryRun?(
		index: number,
		from: HistoryLeaf | undefined,
		to: HistoryLeaf | undefined,
		visit: (line: string, position: HistoryRowPosition) => void,
	): void;
	/** Visit already rendered, non-replayable rows of an active selection, without requesting historical content. */
	visitVolatileRows?(
		first: number,
		last: number,
		visit: (row: number, line: string, renderer: symbol, history?: HistoryRowPosition) => void,
	): void;
}

export interface WindowRequest {
	readonly width: number;
	readonly top: number;
	/** Rows the reader scrolled by since the last layout, when `top` is the last top moved by them. */
	readonly moved?: number;
	/** Show the row at `top` itself, whatever changed above it since the last layout. */
	readonly exact?: boolean;
	readonly height: number;
	readonly followEnd: boolean;
	readonly requestRender: () => void;
}

export interface WindowLayout extends WindowRows {
	readonly top: number;
}

const SLICE_BUDGET_MS = 8;
const SLICE_CHILDREN = 48;
const SWEEP_INTERVAL_MS = 1_000;
const MAX_WINDOW_PASSES = 4;

interface Entry {
	readonly component: Component;
	/** Opaque identity for selections. Holding it does not keep this entry or its component alive. */
	selectionRenderer?: symbol;
	/** The windowed container whose children include `component`. */
	owner: WindowedContainer | undefined;
	lines: readonly string[];
	width: number;
	current: boolean;
	height: number;
	index: number;
	renderedIn: number;
}

function weakRowPosition(
	owner: WeakRef<WindowedContainer>,
	leaf: WeakRef<Component>,
	within: number,
): () => number | undefined {
	return () => {
		const component = leaf.deref();
		const span = component && owner.deref()?.windowRowSpan(component);
		return span && span.bottom > span.top ? span.top + Math.min(within, span.bottom - span.top - 1) : undefined;
	};
}

/** Order of two saved leaves, ignoring the row within them. */
function compareLeaves(a: HistoryLeaf, b: HistoryLeaf): number {
	return a.seq - b.seq || a.block - b.block || a.part - b.part;
}

const entries = new WeakMap<Component, Entry>();
let staleChanges = 0;

function yieldThen(run: () => void): void {
	setImmediate(run).unref();
}

export class WindowedContainer extends Container {
	/** Identify the leaf of a mutable saved transcript. A selection can then keep just its selected characters
	 * across eviction or an external rewrite, without keeping the component or its page. */
	static markHistoryComponent(
		component: Component,
		source: symbol,
		seq: number,
		block: number,
		part: number,
		provisional = false,
	): void {
		archivePositions.set(component, { source, seq, block, part, ...(provisional ? { provisional: true } : {}) });
	}
	/** Mark the row that stands for a source's saved history. Its mounted saved rows follow it; a copy can draw the
	 * rest of a selection from `history`. Holding the anchor's source does not keep the anchor alive. */
	static markHistoryAnchor(component: Component, source: symbol, history: HistorySource): void {
		historyAnchors.set(component, { source, history });
		const owner = entries.get(component)?.owner;
		(owner?.windowHost ?? owner)?.anchors.push(new WeakRef(component));
	}
	/** History anchors this window has laid out. */
	private anchors: WeakRef<Component>[] = [];
	/** The container that last laid this one out among its own rows, when this one is nested in it. */
	private windowHost: WindowedContainer | undefined;
	/** The windowed container this one is a child of, in that layout. */
	private windowParent: WindowedContainer | undefined;
	/** The host's laid-out entries this container's children occupied, `[first, end)`. */
	private windowSpan = { first: 0, end: 0 };
	private laidOut: Entry[] = [];
	private observed = false;
	/** Observe only children whose rows are actually returned to the viewport, never an offscreen measurement. */
	onVisibleChild?: (child: Component) => void;
	private offsets: number[] = [0];
	private staleOffsetsFrom = Number.POSITIVE_INFINITY;
	private width = 0;
	private layouts = 0;
	private windowStart = 0;
	private windowEnd = 0;
	private measuredRows = 0;
	private measuredChildren = 0;
	private lastRowIndex = 0;
	private lastTop = 0;
	private requestRender: (() => void) | undefined;
	private sweep: { stale: number; up: number; down: number; full: boolean } | undefined;
	private sweepScheduled = false;
	private lastFullSweepAt = Number.NEGATIVE_INFINITY;
	private sweptStale = -1;

	/** Content width of the window that laid out these children, including a containing window's layout. */
	protected get windowLayoutWidth(): number | undefined {
		return this.windowHost?.width || this.width || undefined;
	}

	protected windowChildren(): readonly Component[] {
		return this.children;
	}

	/** The last window layout's span for a leaf, measured in the root document's rows; no render or tree walk. */
	windowRowSpan(component: Component): { readonly top: number; readonly bottom: number } | undefined {
		const entry = entries.get(component);
		const root = this.windowHost ?? this;
		if (!entry || root.laidOut[entry.index] !== entry) return undefined;
		return { top: root.offsets[entry.index]!, bottom: root.offsets[entry.index + 1]! };
	}

	override invalidate(): void {
		for (const child of this.windowChildren()) {
			const entry = entries.get(child);
			if (entry?.current) {
				entry.current = false;
				staleChanges++;
			}
		}
		super.invalidate();
	}

	layoutWindow(request: WindowRequest): WindowLayout {
		const width = Math.max(1, Math.floor(request.width));
		const height = Math.max(0, Math.floor(request.height));
		this.requestRender = request.requestRender;
		// A scroll moves from the rows the reader saw, wherever rows added or removed above have put them since.
		const anchor =
			!request.exact && (request.top === this.lastTop || request.moved !== undefined)
				? this.scrollAnchor(this.lastTop, height)
				: undefined;
		if (width !== this.width) {
			this.width = width;
			for (const entry of this.laidOut) entry.current = false;
			staleChanges++;
		}
		this.syncEntries();
		this.updateOffsets();
		const layout = ++this.layouts;
		let top = this.topFor(request, anchor, height);
		for (let pass = 0; pass < MAX_WINDOW_PASSES; pass++) {
			if (!this.renderRows(top - height, top + 2 * height, width, layout)) break;
			this.updateOffsets();
			top = this.topFor(request, anchor, height);
		}
		this.scheduleSweep();
		this.lastTop = top;
		const length = this.rowCount();
		return {
			top,
			length,
			at: this.observed ? (index) => this.visibleRowAt(index) : (index) => this.rowAt(index),
			trackRow: (index) => {
				if (index < 0 || index >= length) return undefined;
				const anchor = this.locateAnchor(index);
				if (!anchor) return undefined;
				return weakRowPosition(new WeakRef(this), new WeakRef(anchor.entry.component), anchor.within);
			},
			historyRow: (index) => {
				if (index < 0 || index >= length) return undefined;
				const anchor = this.locateAnchor(index);
				const position = anchor && archivePositions.get(anchor.entry.component);
				return position && anchor ? { ...position, line: anchor.within } : undefined;
			},
			historyEdges: (index) => {
				const run = index >= 0 && index < length ? this.historyRunAt(index) : undefined;
				if (!run) return undefined;
				const owner = new WeakRef(this);
				const edge = (index: number, within: number) =>
					weakRowPosition(owner, new WeakRef(this.laidOut[index]!.component), within);
				return {
					source: run.source,
					...(run.first > 0 ? { above: edge(run.first - 1, Number.MAX_SAFE_INTEGER) } : {}),
					...(run.last + 1 < this.laidOut.length ? { below: edge(run.last + 1, 0) } : {}),
				};
			},
			historyAnchor: () => {
				const at = this.anchorIndex();
				if (at === undefined) return undefined;
				const anchor = this.laidOut[at]!;
				const { source, history } = historyAnchors.get(anchor.component)!;
				let below = at + 1;
				while (
					below < this.laidOut.length &&
					(this.laidOut[below]!.height === 0 ||
						archivePositions.get(this.laidOut[below]!.component)?.source === source)
				)
					below++;
				const owner = new WeakRef(this);
				const edge = (index: number, within: number) =>
					weakRowPosition(owner, new WeakRef(this.laidOut[index]!.component), within);
				let next = at + 1;
				while (next < below && this.laidOut[next]!.height === 0) next++;
				const first = next < below ? archivePositions.get(this.laidOut[next]!.component) : undefined;
				const width = this.width;
				return {
					source,
					edges: {
						source,
						above: edge(at, Number.MAX_SAFE_INTEGER),
						...(below < this.laidOut.length ? { below: edge(below, 0) } : {}),
					},
					...(first ? { first } : {}),
					last: history.last,
					read: (from, to) => history.read(from, to, width),
				};
			},
			visitHistoryRun: (index, from, to, visit) => {
				const run = index >= 0 && index < length ? this.historyRunAt(index) : undefined;
				if (!run) return;
				let moved = false;
				for (let i = run.first; i <= run.last; i++) {
					const entry = this.laidOut[i]!;
					const position = archivePositions.get(entry.component);
					if (position?.source !== run.source) continue;
					if (from && compareLeaves(position, from) < 0) continue;
					if (to && compareLeaves(position, to) > 0) continue;
					if (!entry.current || entry.width !== this.width) moved = this.renderEntry(entry, this.width) || moved;
					for (let line = 0; line < entry.lines.length; line++) visit(entry.lines[line]!, { ...position, line });
					// A provisional leaf that draws nothing now (its card is drawn at the other end of the pair) is still
					// provisional: a copy draws its entry as the whole transcript does.
					if (position.provisional && entry.lines.length === 0) visit("", { ...position, line: 0 });
				}
				if (moved) this.requestRender?.();
			},
			visitVolatileRows: (first, last, visit) => {
				if (!length || first >= length || last < 0) return;
				for (let i = this.indexAt(Math.max(0, first)); i < this.laidOut.length; i++) {
					const entry = this.laidOut[i]!,
						start = this.offsets[i]!;
					if (start > last) break;
					if (!entry.current) continue;
					const history = archivePositions.get(entry.component);
					if (!history && entry.component.selectionTextMayChangeOnReplay !== true) continue;
					entry.selectionRenderer ??= Symbol();
					for (let row = Math.max(first, start); row <= last && row < start + entry.lines.length; row++)
						visit(
							row,
							entry.lines[row - start]!,
							entry.selectionRenderer,
							history && { ...history, line: row - start },
						);
				}
			},
		};
	}

	settleRows(): void {
		if (this.width === 0) return;
		for (const entry of this.laidOut) this.renderEntry(entry, this.width);
	}

	async renderInSlices(width: number): Promise<string[]> {
		const safeWidth = Math.max(1, Math.floor(width));
		if (safeWidth !== this.width) {
			this.width = safeWidth;
			for (const entry of this.laidOut) entry.current = false;
		}
		this.syncEntries();
		this.updateOffsets();
		let deadline = performance.now() + SLICE_BUDGET_MS;
		for (let index = 0; index < this.laidOut.length; index++) {
			if (performance.now() >= deadline) {
				await new Promise<void>((resolve) => setImmediate(resolve));
				deadline = performance.now() + SLICE_BUDGET_MS;
			}
			const entry = this.laidOut[index];
			if (entry) this.renderEntry(entry, safeWidth);
		}
		const lines: string[] = [];
		for (const entry of this.laidOut) for (const line of entry.lines) lines.push(line);
		return lines;
	}

	/**
	 * The child drawn at `row` as the last layout drew it: an entry, or a nested windowed container with the rows its
	 * children took. A nested container answers from the layout of the container that laid it out, so its own mouse
	 * handler sees the rows that were painted. Without a layout at `width`, the children are rendered to measure them.
	 */
	override childAtRow(width: number, row: number): { component: Component; row: number; height: number } | undefined {
		const window = this.windowAt(width);
		if (!window) return super.childAtRow(width, row);
		const { host, first, end } = window;
		const base = host.offsets[first] ?? 0;
		const absolute = base + row;
		if (row < 0 || absolute >= (host.offsets[end] ?? base)) return undefined;
		const index = host.indexAt(absolute);
		const entry = host.laidOut[index];
		if (!entry || index < first || index >= end) return undefined;
		let child: Component = entry.component;
		let span = { first: index, end: index + 1 };
		for (let owner = entry.owner; owner !== this; owner = owner.windowParent) {
			if (!owner) return undefined;
			child = owner;
			span = owner.windowSpan;
		}
		const start = host.offsets[span.first] ?? 0;
		const stop = host.offsets[span.end] ?? start;
		if (absolute < start || absolute >= stop) return undefined;
		return { component: child, row: absolute - start, height: stop - start };
	}

	private windowAt(width: number): { host: WindowedContainer; first: number; end: number } | undefined {
		if (this.width === width && this.laidOut.length > 0) return { host: this, first: 0, end: this.laidOut.length };
		const host = this.windowHost;
		if (!host || host.width !== width || host.laidOut.length === 0) return undefined;
		const { first, end } = this.windowSpan;
		return end > first && end <= host.laidOut.length ? { host, first, end } : undefined;
	}

	private rowCount(): number {
		return this.offsets[this.laidOut.length] ?? 0;
	}

	private visibleRowAt(row: number): string | undefined {
		const line = this.rowAt(row);
		if (line !== undefined) {
			const entry = this.laidOut[this.lastRowIndex];
			if (entry) entry.owner?.onVisibleChild?.(entry.component);
		}
		return line;
	}

	private rowAt(row: number): string | undefined {
		if (row < 0 || row >= this.rowCount()) return undefined;
		let index = this.lastRowIndex;
		if (!((this.offsets[index] ?? 0) <= row && row < (this.offsets[index + 1] ?? 0))) index = this.indexAt(row);
		this.lastRowIndex = index;
		const entry = this.laidOut[index];
		if (!entry?.current) return "";
		return entry.lines[row - (this.offsets[index] ?? 0)] ?? "";
	}

	private indexAt(row: number): number {
		let low = 0;
		let high = this.laidOut.length - 1;
		while (low < high) {
			const middle = (low + high + 1) >> 1;
			if ((this.offsets[middle] ?? 0) <= row) low = middle;
			else high = middle - 1;
		}
		return Math.max(0, low);
	}

	/** The laid-out index of the first history anchor still in this window. */
	private anchorIndex(): number | undefined {
		for (let i = 0; i < this.anchors.length; i++) {
			const component = this.anchors[i]!.deref();
			const entry = component && entries.get(component);
			if (entry && this.laidOut[entry.index] === entry) return entry.index;
			if (!component) this.anchors.splice(i--, 1);
		}
		return undefined;
	}

	/** The laid-out entries of the saved run around `row`: one source, possibly with empty rows between. */
	private historyRunAt(row: number): { source: symbol; first: number; last: number } | undefined {
		if (this.laidOut.length === 0) return undefined;
		const at = this.indexAt(row);
		const source = archivePositions.get(this.laidOut[at]!.component)?.source;
		if (!source) return undefined;
		const inRun = (entry: Entry) => entry.height === 0 || archivePositions.get(entry.component)?.source === source;
		let first = at,
			last = at;
		while (first > 0 && inRun(this.laidOut[first - 1]!)) first--;
		while (last + 1 < this.laidOut.length && inRun(this.laidOut[last + 1]!)) last++;
		return { source, first, last };
	}

	private locateAnchor(top: number): { entry: Entry; within: number } | undefined {
		if (this.laidOut.length === 0) return undefined;
		const index = this.indexAt(Math.max(0, top));
		const entry = this.laidOut[index];
		return entry ? { entry, within: Math.max(0, top - (this.offsets[index] ?? 0)) } : undefined;
	}

	/**
	 * The row that keeps the reader's place when rows change before the next frame: the row at `top`, or, while a
	 * history anchor is on screen, the first row after it. Saved pages are mounted right after that anchor, so the rows
	 * the reader saw below it keep their place, not the rows above it.
	 */
	private scrollAnchor(top: number, height: number): { entry: Entry; within: number } | undefined {
		const at = this.locateAnchor(top);
		if (!at) return undefined;
		for (let index = this.indexAt(Math.max(0, top)); index < this.laidOut.length; index++) {
			if ((this.offsets[index] ?? 0) >= top + height) break;
			if (!historyAnchors.has(this.laidOut[index]!.component)) continue;
			const next = this.laidOut[index + 1];
			return next ? { entry: next, within: top - (this.offsets[index + 1] ?? 0) } : at;
		}
		return at;
	}

	private topFor(
		request: WindowRequest,
		anchor: { entry: Entry; within: number } | undefined,
		height: number,
	): number {
		const maxTop = Math.max(0, this.rowCount() - height);
		if (request.followEnd) return maxTop;
		let top = Math.floor(request.top);
		if (anchor && this.laidOut[anchor.entry.index] === anchor.entry) {
			top =
				(this.offsets[anchor.entry.index] ?? 0) +
				Math.min(anchor.within, Math.max(0, anchor.entry.height - 1)) +
				(request.moved ?? 0);
		}
		return Math.max(0, Math.min(maxTop, top));
	}

	private syncEntries(): void {
		const laidOut = this.laidOut;
		let index = 0;
		let rebuilt: Entry[] | undefined;
		const position = (): number => rebuilt?.length ?? index;
		this.observed = false;
		const visit = (container: WindowedContainer): void => {
			if (container.onVisibleChild) this.observed = true;
			for (const child of container.windowChildren()) {
				if (child instanceof WindowedContainer) {
					child.windowHost = this;
					child.windowParent = container;
					const first = position();
					visit(child);
					child.windowSpan = { first, end: position() };
					continue;
				}
				if (rebuilt === undefined) {
					const kept = laidOut[index];
					if (kept?.component === child) {
						kept.owner = container;
						index++;
						continue;
					}
					rebuilt = laidOut.slice(0, index);
				}
				const entry = this.entryFor(child);
				entry.owner = container;
				rebuilt.push(entry);
			}
		};
		visit(this);
		if (rebuilt === undefined) {
			if (index === laidOut.length) return;
			rebuilt = laidOut.slice(0, index);
		}
		for (let position = index; position < rebuilt.length; position++) {
			const entry = rebuilt[position];
			if (entry) entry.index = position;
		}
		this.laidOut = rebuilt;
		this.staleOffsetsFrom = Math.min(this.staleOffsetsFrom, index);
		this.lastRowIndex = 0;
	}

	private entryFor(component: Component): Entry {
		let entry = entries.get(component);
		if (!entry) {
			const estimate =
				this.measuredChildren > 0 ? Math.max(1, Math.round(this.measuredRows / this.measuredChildren)) : 1;
			entry = {
				component,
				owner: undefined,
				lines: [],
				width: 0,
				current: false,
				height: estimate,
				index: 0,
				renderedIn: 0,
			};
			entries.set(component, entry);
			staleChanges++;
			if (historyAnchors.has(component)) this.anchors.push(new WeakRef(component));
		} else if (entry.width !== this.width) {
			entry.current = false;
		}
		return entry;
	}

	private updateOffsets(): void {
		const from = this.staleOffsetsFrom;
		if (from === Number.POSITIVE_INFINITY) return;
		const { laidOut, offsets } = this;
		offsets.length = laidOut.length + 1;
		let row = from === 0 ? 0 : (offsets[from] ?? 0);
		for (let index = from; index < laidOut.length; index++) {
			offsets[index] = row;
			row += laidOut[index]?.height ?? 0;
		}
		offsets[laidOut.length] = row;
		this.staleOffsetsFrom = Number.POSITIVE_INFINITY;
	}

	private renderRows(start: number, end: number, width: number, layout: number): boolean {
		if (this.laidOut.length === 0) return false;
		let changed = false;
		let first = this.indexAt(Math.max(0, start));
		while (first > 0 && this.offsets[first - 1] === this.offsets[first]) first--;
		let index = first;
		for (; index < this.laidOut.length && (this.offsets[index] ?? 0) < Math.max(end, 1); index++) {
			const entry = this.laidOut[index];
			if (!entry || entry.renderedIn === layout) continue;
			entry.renderedIn = layout;
			if (this.renderEntry(entry, width)) changed = true;
		}
		this.windowStart = first;
		this.windowEnd = index;
		return changed;
	}

	private renderEntry(entry: Entry, width: number): boolean {
		const lines = entry.component.render(width);
		if (entry.width === 0) {
			this.measuredRows += lines.length;
			this.measuredChildren++;
		}
		entry.lines = lines;
		entry.width = width;
		entry.current = true;
		if (entry.height === lines.length) return false;
		entry.height = lines.length;
		if (this.laidOut[entry.index] === entry) this.staleOffsetsFrom = Math.min(this.staleOffsetsFrom, entry.index);
		return true;
	}

	private scheduleSweep(): void {
		if (this.sweepScheduled) return;
		this.sweepScheduled = true;
		const run = () => this.sweepSlice();
		if (this.sweptStale !== staleChanges) yieldThen(run);
		else setTimeout(run, Math.max(0, this.lastFullSweepAt + SWEEP_INTERVAL_MS - performance.now())).unref();
	}

	private sweepSlice(): void {
		if (this.width === 0) {
			this.sweepScheduled = false;
			return;
		}
		let sweep = this.sweep;
		if (!sweep || sweep.stale !== staleChanges) {
			const full = sweep?.full ?? this.sweptStale === staleChanges;
			sweep = { stale: staleChanges, up: this.windowStart - 1, down: this.windowEnd, full };
			this.sweep = sweep;
		}
		const deadline = performance.now() + SLICE_BUDGET_MS;
		let rendered = 0;
		let moved = false;
		while (rendered < SLICE_CHILDREN && performance.now() < deadline) {
			let index: number;
			if (sweep.up >= 0) index = sweep.up--;
			else if (sweep.down < this.laidOut.length) index = sweep.down++;
			else break;
			const entry = this.laidOut[index];
			if (!entry || (entry.current && !sweep.full)) continue;
			rendered++;
			if (this.renderEntry(entry, this.width)) moved = true;
		}
		if (moved) this.requestRender?.();
		if (sweep.up >= 0 || sweep.down < this.laidOut.length) {
			yieldThen(() => this.sweepSlice());
			return;
		}
		this.sweep = undefined;
		this.sweepScheduled = false;
		this.sweptStale = sweep.stale;
		if (sweep.full) this.lastFullSweepAt = performance.now();
	}
}
