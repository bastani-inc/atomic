import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseDispatchResult,
	type TuiMouseEvent,
} from "../tui.ts";

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
	lines: readonly string[];
	width: number;
	current: boolean;
	height: number;
	index: number;
	renderedIn: number;
}

const entries = new WeakMap<Component, Entry>();
let staleChanges = 0;

function yieldThen(run: () => void): void {
	setImmediate(run).unref();
}

export class WindowedContainer extends Container {
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
		for (let pass = 0; pass < MAX_WINDOW_PASSES; pass++) {
			if (!this.renderRows(top - height, top + 2 * height, width, layout)) break;
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

	override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
		if (event.width !== this.width || this.laidOut.length === 0) return super.handleMouse(event);
		if (event.y < 0 || event.y >= event.height || event.y >= this.rowCount()) return undefined;
		const index = this.indexAt(event.y);
		const entry = this.laidOut[index];
		const start = this.offsets[index] ?? 0;
		const end = this.offsets[index + 1] ?? start;
		if (!entry || event.y >= end) return undefined;
		return dispatchMouseEvent(entry.component, { ...event, y: event.y - start, height: end - start });
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
		const visit = (container: WindowedContainer): void => {
			for (const child of container.windowChildren()) {
				if (child instanceof WindowedContainer) {
					visit(child);
					continue;
				}
				if (rebuilt === undefined) {
					if (laidOut[index]?.component === child) {
						index++;
						continue;
					}
					rebuilt = laidOut.slice(0, index);
				}
				rebuilt.push(this.entryFor(child));
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
			entry = { component, lines: [], width: 0, current: false, height: estimate, index: 0, renderedIn: 0 };
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
