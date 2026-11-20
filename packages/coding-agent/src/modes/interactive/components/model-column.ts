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

/**
 * The cell after a paint sees `report` at `now`. `cell` is undefined for a row the view has not painted yet. A row
 * the view already listed, as on its first paint or when it scrolls into view, shows a known model at once, as it
 * always did; a row `added` to the list since the view last painted is new, and its model waits for its level like
 * one that becomes known.
 */
export function nextModelCell(
	cell: ModelCell | undefined,
	report: ModelCellReport,
	now: number,
	added: boolean,
): ModelCell {
	const model = report.model;
	if (cell === undefined) {
		if (!added) return model === undefined ? UNKNOWN : SHOWN;
		cell = UNKNOWN;
	}
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
	private readonly cells = new Map<string, ModelCell>();
	/**
	 * The deadlines of the waiting rows painted last, by row id. A waiting row out of view needs no timer: its next
	 * paint shows its model if its time is up.
	 */
	private waiting = new Map<string, number>();
	/**
	 * The list the view last painted from; undefined before its first paint, and after it was too narrow for the
	 * column. It is read only when it changes, and then only as far as a paint needs it.
	 */
	private roster: readonly { readonly id: string }[] | undefined;
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
	 * Moves the cell of each row painted now on by what it reports and returns the ids of the rows that show their
	 * model. `listed` is every row of the view, painted or not: rows scrolled out of view keep their cells. Only when it
	 * is another list than last time is any of it read: the last list, to tell a row added since from one scrolled into
	 * view, and the new one, to forget the kept cells of rows no longer in it. A paint otherwise costs what its painted
	 * rows cost.
	 */
	paint(
		reports: Iterable<readonly [id: string, report: ModelCellReport]>,
		listed: readonly { readonly id: string }[],
	): ReadonlySet<string> {
		const now = performance.now();
		const previous = this.roster;
		let previousIds: Set<string> | undefined;
		const added = (id: string): boolean => {
			if (previous === undefined || previous === listed) return false;
			if (previousIds === undefined) {
				previousIds = new Set();
				for (const row of previous) previousIds.add(row.id);
			}
			return !previousIds.has(id);
		};
		const painted = new Set<string>();
		const shown = new Set<string>();
		const waiting = new Map<string, number>();
		let earliest = Number.POSITIVE_INFINITY;
		for (const [id, report] of reports) {
			const before = this.cells.get(id);
			const cell = nextModelCell(before, report, now, before === undefined && added(id));
			painted.add(id);
			this.cells.set(id, cell);
			if (cell.kind === "shown") shown.add(id);
			else if (cell.kind === "waiting") {
				const due = cell.since + MODEL_LEVEL_WAIT_MS;
				waiting.set(id, due);
				earliest = Math.min(earliest, due);
			}
		}
		this.waiting = waiting;
		if (listed !== previous) {
			this.roster = listed;
			if (this.cells.size > painted.size) {
				const ids = new Set<string>();
				for (const row of listed) ids.add(row.id);
				for (const id of this.cells.keys()) if (!painted.has(id) && !ids.has(id)) this.cells.delete(id);
			}
		}
		this.arm(earliest);
		return shown;
	}

	/** Forgets every cell, as when the view is too narrow for the column: its next paint is like a first one. */
	forget(): void {
		this.cells.clear();
		this.waiting.clear();
		this.roster = undefined;
		this.disarm();
	}

	/**
	 * The column width to paint at `width`, for shown labels at most `measured` cells wide; `fits(column)` says whether
	 * a column that wide leaves every painted row its whole right column and some of its task. It is `measured`, or the
	 * widest column this view painted at this width that still fits, else the one it painted last if that fits: the
	 * column does not narrow while it fits. It is 0 when even the widest label the rows report, `widest`, shown or still
	 * waiting, does not fit, as labels are never cut to fit: there is then no column, exactly as without waiting.
	 */
	column(width: number, measured: number, fits: (column: number) => boolean, widest = measured): number {
		if (width !== this.heldWidth) {
			this.heldWidth = width;
			this.held = 0;
			this.last = 0;
		}
		let column = 0;
		if (widest === 0 || fits(widest)) {
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
		this.forget();
		this.heldWidth = -1;
		this.held = 0;
		this.last = 0;
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
		for (const [id, due] of this.waiting) {
			if (due <= deadline) {
				this.cells.set(id, SHOWN);
				this.waiting.delete(id);
				expired = true;
			} else earliest = Math.min(earliest, due);
		}
		this.arm(earliest);
		if (expired) this.onExpire?.();
	}
}
