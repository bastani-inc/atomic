/**
 * When a row shows its model in the model column of the agent panel and /tasks, and how wide that column stays while
 * one of those views is open.
 *
 * A subagent reports its model and its reasoning level apart, the level a moment after the model. Showing each as it
 * arrives would widen the column twice and move every row's task twice. Instead, a row whose model becomes known while
 * the view shows it waits for its level, at most `MODEL_LEVEL_WAIT_MS`, and then shows both at once. A row first seen
 * with its model already known, a finished row, and a model without reasoning levels show the model at once, as
 * before. The column never narrows while it still fits. It is measured again when the width changes or the view is
 * opened again.
 */

/** The longest a row whose model just became known waits for its reasoning level before it shows the model alone. */
export const MODEL_LEVEL_WAIT_MS = 1000;

/**
 * A row's model cell: no model reported yet; its model `model` reported and its level awaited since `since` (on the
 * `performance.now()` clock); or shown, from then on exactly as the row reports it until it reports no model.
 */
export type ModelCell =
	| { readonly kind: "unknown" }
	| { readonly kind: "waiting"; readonly since: number; readonly model: string }
	| { readonly kind: "shown" };

/** What a row reports now. */
export interface ModelCellReport {
	/** The model it names, undefined for none. */
	readonly model: string | undefined;
	/** Nothing more is coming for it: its level is known, or the row finished. */
	readonly settled: boolean;
	/**
	 * Whether its model has no reasoning levels. Asked only when the row's model becomes known, or changes, while it
	 * waits, since the answer can take a lookup in the session's model registry.
	 */
	readonly levelless: () => boolean;
}

const UNKNOWN: ModelCell = { kind: "unknown" };
const SHOWN: ModelCell = { kind: "shown" };

/** The cell after a paint sees `report` at `now`; `cell` is undefined for a row the view has not painted yet. */
export function nextModelCell(cell: ModelCell | undefined, report: ModelCellReport, now: number): ModelCell {
	const model = report.model;
	if (cell === undefined) return model === undefined ? UNKNOWN : SHOWN;
	switch (cell.kind) {
		case "shown":
			return model === undefined ? UNKNOWN : cell;
		case "unknown":
			if (model === undefined) return cell;
			return report.settled || report.levelless() ? SHOWN : { kind: "waiting", since: now, model };
		case "waiting":
			if (model === undefined) return UNKNOWN;
			if (report.settled || now - cell.since >= MODEL_LEVEL_WAIT_MS) return SHOWN;
			// A switch to another model, as on a fallback, keeps the wait's start; a model without levels ends it.
			if (model === cell.model) return cell;
			return report.levelless() ? SHOWN : { kind: "waiting", since: cell.since, model };
	}
}

/** One open view's model cells and column width. */
export class ModelColumn {
	private cells = new Map<string, ModelCell>();
	private heldWidth = -1;
	/** The widest column this view painted at `heldWidth`, and the one it painted last. */
	private held = 0;
	private last = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private timerAt = Number.POSITIVE_INFINITY;
	private readonly onExpire: (() => void) | undefined;

	/** `onExpire` repaints the view once a waiting row's time is up, so it shows its model without another change. */
	constructor(onExpire?: () => void) {
		this.onExpire = onExpire;
	}

	/**
	 * Moves the cell of each row painted now on by what it reports, forgets the rows no longer painted, and returns the
	 * ids of the rows that show their model.
	 */
	paint(reports: Iterable<readonly [id: string, report: ModelCellReport]>): ReadonlySet<string> {
		const now = performance.now();
		const next = new Map<string, ModelCell>();
		const shown = new Set<string>();
		let earliest = Number.POSITIVE_INFINITY;
		for (const [id, report] of reports) {
			const cell = nextModelCell(this.cells.get(id), report, now);
			next.set(id, cell);
			if (cell.kind === "shown") shown.add(id);
			else if (cell.kind === "waiting") earliest = Math.min(earliest, cell.since + MODEL_LEVEL_WAIT_MS);
		}
		this.cells = next;
		this.arm(earliest);
		return shown;
	}

	/**
	 * The column width to paint at `width`, for shown labels at most `measured` cells wide; `fits(column)` says whether
	 * a column that wide leaves every painted row its whole right column and some of its task. It is `measured`, or the
	 * widest column this view painted at this width that still fits, else the one it painted last if that fits: the
	 * column does not narrow while it fits. It is 0 when even `measured` does not fit, as labels are never cut to fit.
	 */
	column(width: number, measured: number, fits: (column: number) => boolean): number {
		if (width !== this.heldWidth) {
			this.heldWidth = width;
			this.held = 0;
			this.last = 0;
		}
		let column = 0;
		if (measured === 0 || fits(measured)) {
			column = measured;
			if (this.held > column && fits(this.held)) column = this.held;
			else if (this.last > column && fits(this.last)) column = this.last;
		}
		if (column > this.held) this.held = column;
		this.last = column;
		return column;
	}

	/** Forgets every cell and the column width, as a view opened again does. */
	reset(): void {
		this.cells = new Map();
		this.heldWidth = -1;
		this.held = 0;
		this.last = 0;
		this.disarm();
	}

	dispose(): void {
		this.reset();
	}

	private arm(deadline: number): void {
		if (this.onExpire === undefined) return;
		if (deadline === Number.POSITIVE_INFINITY) {
			this.disarm();
			return;
		}
		if (this.timer !== undefined && this.timerAt === deadline) return;
		this.disarm();
		this.timerAt = deadline;
		this.timer = setTimeout(() => this.expire(deadline), Math.max(0, deadline - performance.now()));
		this.timer.unref?.();
	}

	private disarm(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.timerAt = Number.POSITIVE_INFINITY;
	}

	/** The rows whose wait ends by `deadline` show their model, and the view repaints. */
	private expire(deadline: number): void {
		this.timer = undefined;
		this.timerAt = Number.POSITIVE_INFINITY;
		let earliest = Number.POSITIVE_INFINITY;
		let expired = false;
		for (const [id, cell] of this.cells) {
			if (cell.kind !== "waiting") continue;
			const due = cell.since + MODEL_LEVEL_WAIT_MS;
			if (due <= deadline) {
				this.cells.set(id, SHOWN);
				expired = true;
			} else earliest = Math.min(earliest, due);
		}
		this.arm(earliest);
		if (expired) this.onExpire?.();
	}
}
