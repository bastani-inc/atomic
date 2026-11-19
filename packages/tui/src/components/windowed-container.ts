import { type Component, Container, type TuiMouseEvent } from "../tui.ts";

export interface WindowRows {
	readonly length: number;
	at(index: number): string | undefined;
}

export interface WindowRequest {
	readonly width: number;
	readonly top: number;
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
	/** The windowed container whose children include `component`. */
	owner: WindowedContainer | undefined;
	lines: readonly string[];
	width: number;
	current: boolean;
	height: number;
	index: number;
	renderedIn: number;
}

/** Internal to fullscreen paint and dispatch. Public hit geometry does not own screen content. */
export const captureWindowRow = Symbol("captureWindowRow");
type ReadRow = (row: number, line: string) => object | undefined;
type PrepareRows = (child: Component, width: number, height: number, first: number, end: number) => ReadRow | undefined;
export type WindowMouseFrame = Map<
	WindowedContainer,
	Map<number, { x: number; width: number; data: object; capture: PrepareRows }>
>;
export interface WindowMousePaint {
	staged?: WeakMap<Entry, { lines: readonly string[]; capture: PrepareRows; read: ReadRow }>;
	rows?: WindowMouseFrame;
}
let dispatchedFrame: WindowMouseFrame | undefined;
let preparing: { request: WindowRequest; paint: WindowMousePaint } | undefined;
const rowCaptures = new WeakMap<WindowedContainer, PrepareRows>();

export function layoutWindowForPaint(
	window: WindowedContainer,
	request: WindowRequest,
	paint?: WindowMousePaint,
): WindowLayout {
	if (!paint) return window.layoutWindow(request);
	const previous = preparing;
	preparing = { request, paint };
	try {
		return window.layoutWindow(request);
	} finally {
		preparing = previous;
	}
}

/** Opt in to private row data for this window's clipped fullscreen paint. No widget properties are inspected. */
export function observeWindowMouseRows<T extends object>(
	window: WindowedContainer,
	capture: (...args: Parameters<PrepareRows>) => ((row: number, line: string) => T | undefined) | undefined,
): (event: TuiMouseEvent) => T | undefined {
	rowCaptures.set(window, capture);
	return (event) => {
		const hit = dispatchedFrame?.get(window)?.get(event.screenY);
		return hit?.capture === capture && hit.x === event.screenX - event.x && hit.width === event.width
			? (hit.data as T)
			: undefined;
	};
}

export function withWindowMouseFrame<T>(frame: WindowMouseFrame, dispatch: () => T): T {
	const previous = dispatchedFrame;
	dispatchedFrame = frame;
	try {
		return dispatch();
	} finally {
		dispatchedFrame = previous;
	}
}

const entries = new WeakMap<Component, Entry>();
let staleChanges = 0;

function yieldThen(run: () => void): void {
	setImmediate(run).unref();
}

export class WindowedContainer extends Container {
	/** The container that last laid this one out among its own rows, when this one is nested in it. */
	private windowHost: WindowedContainer | undefined;
	/** The windowed container this one is a child of, in that layout. */
	private windowParent: WindowedContainer | undefined;
	/** The host's laid-out entries this container's children occupied, `[first, end)`. */
	private windowSpan = { first: 0, end: 0 };
	private laidOut: Entry[] = [];
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

	[captureWindowRow](paint: WindowMousePaint, row: number, line: string, x: number, y: number): void {
		// paintBox just read this row. Use the ownership of *that draw*, not a child's latest measurement.
		const entry = this.laidOut[this.lastRowIndex];
		const owner = entry?.owner;
		const staged = entry && paint.staged?.get(entry);
		if (!owner || !staged || !entry.current || entry.lines !== staged.lines || entry.renderedIn !== this.layouts)
			return;
		const data = staged.read(row - (this.offsets[this.lastRowIndex] ?? 0), line);
		if (!data) return;
		paint.rows ??= new Map();
		let rows = paint.rows.get(owner);
		if (!rows) {
			rows = new Map();
			paint.rows.set(owner, rows);
		}
		rows.set(y, { x, width: this.width, data, capture: staged.capture });
	}

	protected windowChildren(): readonly Component[] {
		return this.children;
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
		const anchor = request.top === this.lastTop ? this.locateAnchor(request.top) : undefined;
		if (width !== this.width) {
			this.width = width;
			for (const entry of this.laidOut) entry.current = false;
			staleChanges++;
		}
		this.syncEntries();
		this.updateOffsets();
		const layout = ++this.layouts;
		let top = this.topFor(request, anchor, height);
		const paint = preparing?.request === request ? preparing.paint : undefined;
		for (let pass = 0; pass < MAX_WINDOW_PASSES; pass++) {
			if (!this.renderRows(top, height, width, layout, paint)) break;
			this.updateOffsets();
			top = this.topFor(request, anchor, height);
		}
		this.scheduleSweep();
		this.lastTop = top;
		const length = this.rowCount();
		return { top, length, at: (index) => this.rowAt(index) };
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
	override childAtRow(width: number, row: number): ReturnType<Container["childAtRow"]> {
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

	private locateAnchor(top: number): { entry: Entry; within: number } | undefined {
		if (this.laidOut.length === 0) return undefined;
		const index = this.indexAt(Math.max(0, top));
		const entry = this.laidOut[index];
		return entry ? { entry, within: Math.max(0, top - (this.offsets[index] ?? 0)) } : undefined;
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
			top = (this.offsets[anchor.entry.index] ?? 0) + Math.min(anchor.within, Math.max(0, anchor.entry.height - 1));
		}
		return Math.max(0, Math.min(maxTop, top));
	}

	private syncEntries(): void {
		const laidOut = this.laidOut;
		let index = 0;
		let rebuilt: Entry[] | undefined;
		const position = (): number => rebuilt?.length ?? index;
		const visit = (container: WindowedContainer): void => {
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

	private renderRows(top: number, height: number, width: number, layout: number, paint?: WindowMousePaint): boolean {
		if (this.laidOut.length === 0) return false;
		const start = top - height;
		const end = top + 2 * height;
		let changed = false;
		let first = this.indexAt(Math.max(0, start));
		while (first > 0 && this.offsets[first - 1] === this.offsets[first]) first--;
		let index = first;
		for (; index < this.laidOut.length && (this.offsets[index] ?? 0) < Math.max(end, 1); index++) {
			const entry = this.laidOut[index];
			if (!entry || entry.renderedIn === layout) continue;
			if (this.renderEntry(entry, width, layout)) changed = true;
			if (!paint || !entry.owner || !entry.height) continue;
			const capture = rowCaptures.get(entry.owner);
			if (!capture) continue;
			const first = top - (this.offsets[index] ?? 0);
			const read = capture(
				entry.component,
				width,
				entry.height,
				Math.max(0, first),
				Math.min(entry.height, first + height),
			);
			if (read) {
				paint.staged ??= new WeakMap();
				paint.staged.set(entry, { lines: entry.lines, capture, read });
			}
		}
		this.windowStart = first;
		this.windowEnd = index;
		return changed;
	}

	private renderEntry(entry: Entry, width: number, layout = 0): boolean {
		const lines = entry.component.render(width);
		entry.renderedIn = layout;
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
