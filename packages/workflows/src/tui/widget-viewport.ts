import type { ReactiveWidgetComponent, WidgetScrollRequest, WidgetScrollState } from "@bastani/atomic";
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
	private position = 0;
	private version = 0;
	private collapsed = false;
	private state: WidgetScrollState | undefined;
	private lines: string[] = [];
	private runRows: readonly WorkflowWidgetRunRows[] = [];

	constructor(
		private readonly content: ReactiveWidgetComponent,
		private readonly terminalRows: () => number,
		private readonly requestRender: () => void,
		private readonly getRunRows?: () => readonly WorkflowWidgetRunRows[],
		private readonly getHint: () => string = () => "",
	) {}

	getScrollRequest(): WidgetScrollRequest {
		return { version: this.version, scrollTop: this.collapsed ? 0 : this.position };
	}

	onScroll(state: WidgetScrollState): void {
		this.state = state;
		if (!this.collapsed) this.position = state.scrollTop;
	}

	scroll(direction: -1 | 1): void {
		if (this.collapsed) return;
		const height =
			this.state?.viewportHeight ??
			Math.max(1, Math.min(WORKFLOW_WIDGET_MAX_ROWS, Math.floor(this.terminalRows() / 3)));
		const next = Math.max(0, Math.min(Math.max(0, this.lines.length - height), this.position + direction));
		if (next === this.position) return;
		this.position = next;
		this.version++;
		this.requestRender();
	}

	render(width: number): string[] {
		const content = this.content.render(width);
		const hint = content.length > 1 ? this.getHint() : "";
		const nextLines = hint ? [...content, truncateToWidth(hint, width, "…")] : content;
		const nextRunRows = (this.getRunRows?.() ?? []).map((run, index, rows) =>
			hint && index === rows.length - 1 ? { ...run, end: run.end + 1 } : run,
		);
		const collapsed = Boolean(this.getRunRows && nextLines.length === 1 && nextRunRows.length === 0);
		if (collapsed) {
			if (!this.collapsed) this.version++;
			this.collapsed = true;
			return nextLines;
		}
		const anchoredOffset = this.getRunRows ? this.resolveAnchor(this.position, nextRunRows) : this.position;
		if (this.collapsed || anchoredOffset !== this.position) {
			this.position = anchoredOffset;
			this.version++;
		}
		this.collapsed = false;
		this.lines = nextLines;
		this.runRows = nextRunRows;
		return nextLines;
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
