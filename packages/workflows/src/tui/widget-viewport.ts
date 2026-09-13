import { type ReactiveWidgetComponent, ScrollableComponentViewport } from "@bastani/atomic";
import { truncateToWidth } from "./text-helpers.js";

/** Shared list cap, including its scroll hint. Short terminals use at most a third. */
export const WORKFLOW_WIDGET_MAX_ROWS = 10;

/** Renderer-owned identity-row start and exclusive end (last run includes the bottom border). */
export interface WorkflowWidgetRunRows {
	id: string;
	start: number;
	end: number;
}

export class WorkflowWidgetViewport implements ReactiveWidgetComponent {
	private readonly viewport = new ScrollableComponentViewport();
	private lines: string[] = [];
	private scrollable = false;
	private runRows: readonly WorkflowWidgetRunRows[] = [];

	constructor(
		private readonly content: ReactiveWidgetComponent,
		private readonly terminalRows: () => number,
		private readonly requestRender: () => void,
		private readonly getRunRows?: () => readonly WorkflowWidgetRunRows[],
	) {
		this.viewport.setComponents([{ render: () => this.lines, invalidate() {} }]);
		this.viewport.scrollTo(0);
	}

	scroll(direction: -1 | 1): void {
		if (!this.scrollable) return;
		this.viewport.scrollBy(direction);
		this.requestRender();
	}

	render(width: number): string[] {
		const cap = Math.max(1, Math.min(WORKFLOW_WIDGET_MAX_ROWS, Math.floor(this.terminalRows() / 3)));
		const nextLines = this.content.render(width);
		const nextRunRows = this.getRunRows?.() ?? [];
		// A collapsed summary temporarily hides the expanded list, not its anchor.
		if (this.getRunRows && nextLines.length === 1 && nextRunRows.length === 0) {
			this.scrollable = false;
			return nextLines;
		}
		const previousLineCount = this.lines.length;
		const offset = this.viewport.getMaxScroll() - this.viewport.getScrollFromBottom();
		const anchoredOffset = this.getRunRows ? this.resolveAnchor(offset, nextRunRows) : undefined;
		this.lines = nextLines;
		this.runRows = nextRunRows;
		if (anchoredOffset !== undefined) {
			this.viewport.scrollTo(anchoredOffset);
		} else if (previousLineCount <= 1 || (this.lines.length < previousLineCount && this.lines.length <= cap)) {
			this.viewport.scrollTo(0);
		}
		this.scrollable = this.lines.length > 1;
		// #3015: the dock can paint only the first row of our nominal viewport.
		// Advance one row and allow the final source row to become the first row,
		// even when the whole list fits our cap. No clipped row can be skipped.
		this.viewport.setVisibleRows(1);
		this.viewport.render(width);
		if (!this.scrollable) return this.lines;
		const first = this.viewport.getMaxScroll() - this.viewport.getScrollFromBottom() + 1;
		const visible = this.lines.slice(first - 1, first - 1 + Math.max(1, cap - 1));
		// At a one-row budget retain content rather than only chrome.
		if (cap === 1) return visible;
		const hint = ` ${first}–${first + visible.length - 1}/${this.lines.length} · Alt+PgUp/PgDn scroll workflows`;
		return [...visible, truncateToWidth(hint, width, "…")];
	}

	private resolveAnchor(offset: number, next: readonly WorkflowWidgetRunRows[]): number {
		if (offset === 0 || next.length === 0) return 0;
		// The separator immediately before a run belongs to that next visible run.
		const index = this.runRows.findIndex((run) => offset >= run.start - 1 && offset < run.end);
		const anchor = this.runRows[index];
		if (!anchor) return 0;
		const byId = new Map(next.map((run) => [run.id, run]));
		const retained = byId.get(anchor.id);
		if (retained) return Math.min(retained.end - 1, retained.start + offset - anchor.start);
		// Deleted anchor: prefer its next surviving neighbour, then the previous one.
		const neighbours = [...this.runRows.slice(index + 1), ...this.runRows.slice(0, index).reverse()];
		for (const neighbour of neighbours) {
			const survivor = byId.get(neighbour.id);
			if (survivor) return survivor.start;
		}
		return 0;
	}

	invalidate(): void {
		this.content.invalidate?.();
	}
	dispose(): void {
		this.content.dispose?.();
	}
}
