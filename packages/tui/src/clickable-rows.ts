import type { TuiMouseEvent, TuiMouseEventResult } from "./tui.ts";

/** A plain left click: released where it was pressed, not part of a double- or triple-click, with no modifier held. */
export function isSingleLeftClick(event: TuiMouseEvent): boolean {
	return (
		event.type === "click" &&
		event.button === "left" &&
		(event.clickCount ?? 1) === 1 &&
		!event.shift &&
		!event.alt &&
		!event.ctrl
	);
}

/** The columns a target covers on its row: `start` inclusive, `end` exclusive. */
export interface ClickableColumns {
	readonly start: number;
	readonly end: number;
}

/** What a list does when one of its rows is clicked or the wheel turns over it. */
export interface ClickableRowActions<T> {
	/**
	 * Run `target` the way Enter runs the selected row: move the selection to it, then confirm it, with every
	 * confirmation step the keyboard has.
	 */
	activate(target: T): void;
	/** Wheel over the list: move the selection, or scroll, one step. Return whether anything changed. */
	scroll?(direction: -1 | 1): boolean;
}

/** The rows one render recorded; see {@link ClickableRows.snapshot}. */
export interface ClickableRowsSnapshot<T> {
	readonly rows: Map<number, RowTarget<T>[]>;
}

interface RowTarget<T> {
	readonly target: T;
	readonly key: string;
	readonly columns: ClickableColumns | undefined;
}

/**
 * The rows a list drew in its last render, each naming the item drawn there, and the rule that runs one on a click.
 *
 * Every selectable row goes through this, so a list behaves the same everywhere:
 * - A single left click runs the row as Enter would with the row selected. The list moves its selection there and
 *   confirms it, so anything that asks for confirmation from the keyboard asks the same way after a click.
 * - The press is left to the renderer, so a drag across rows still selects their text, and the renderer turns a press
 *   and release into a click only when the screen under the pointer did not change between them.
 * - A double or triple click, or a click with a modifier held, is a text-selection gesture and runs nothing.
 * - The wheel over the list moves its selection when the list gives a `scroll` action.
 *
 * A list calls {@link clear} when it starts rendering, {@link add} for each row it draws an item on, and forwards
 * `handleMouse` and `paintedRowKey` here.
 */
export class ClickableRows<T> {
	private rows = new Map<number, RowTarget<T>[]>();
	/** What the last press landed on. The click that follows it must land on the same item. */
	private pressedKey: string | undefined;

	/** Forget the rows of the previous render. */
	clear(): void {
		this.rows = new Map();
	}

	/**
	 * The rows recorded since the last {@link clear}, for a list that caches its render. The next render starts with
	 * {@link clear}, which leaves the snapshot as it was.
	 */
	snapshot(): ClickableRowsSnapshot<T> {
		return { rows: this.rows };
	}

	/** Bring back the rows of a cached render. */
	restore(snapshot: ClickableRowsSnapshot<T>): void {
		this.rows = snapshot.rows;
	}

	/**
	 * Record, after {@link clear}, that the render drew `target` on `row`, named by `key` (stable for the same item across renders). Without
	 * `columns` the target covers the whole row.
	 */
	add(row: number, target: T, key: string, columns?: ClickableColumns): void {
		const targets = this.rows.get(row);
		const entry = { target, key, columns };
		if (targets) targets.push(entry);
		else this.rows.set(row, [entry]);
	}

	/** Copy the rows `other` recorded, moved down by `rowOffset` rows and right by `columnOffset` columns. */
	addFrom(other: ClickableRows<T>, rowOffset: number, columnOffset = 0): void {
		for (const [row, targets] of other.rows) {
			for (const { target, key, columns } of targets) {
				this.add(
					row + rowOffset,
					target,
					key,
					columns && { start: columns.start + columnOffset, end: columns.end + columnOffset },
				);
			}
		}
	}

	/** Whether the last render drew any target. */
	get size(): number {
		return this.rows.size;
	}

	/** The target drawn at column `x` of `row` in the last render. */
	targetAt(x: number, row: number): T | undefined {
		return this.hitAt(x, row)?.target;
	}

	/** What the last render drew on `row`, for `Component.paintedRowKey`. */
	paintedRowKey(row: number): string | undefined {
		const targets = this.rows.get(row);
		if (!targets) return undefined;
		return targets.map(({ key }) => key).join("\u0000");
	}

	/**
	 * Run the clicked row, or move the selection on a wheel turn. The press itself is not taken: the renderer keeps it
	 * for text selection and sends the click only when the pointer was released where it was pressed. A click that
	 * follows a press on another item, as when the rows moved under the pointer, runs nothing. A click with no press
	 * before it, as one forwarded from another process, runs the item drawn under it.
	 */
	handleMouse(event: TuiMouseEvent, actions: ClickableRowActions<T>): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			if (!actions.scroll || !event.wheelDelta) return undefined;
			return { handled: true, render: actions.scroll(event.wheelDelta < 0 ? -1 : 1) };
		}
		if (event.type === "press") {
			this.pressedKey = event.button === "left" ? this.keyAt(event.x, event.y) : undefined;
			return undefined;
		}
		if (event.type !== "click") return undefined;
		const pressed = this.pressedKey;
		this.pressedKey = undefined;
		if (!isSingleLeftClick(event)) return undefined;
		const hit = this.hitAt(event.x, event.y);
		if (hit === undefined || (pressed !== undefined && pressed !== hit.key)) return undefined;
		actions.activate(hit.target);
		return { handled: true };
	}

	private keyAt(x: number, row: number): string | undefined {
		return this.hitAt(x, row)?.key;
	}

	private hitAt(x: number, row: number): RowTarget<T> | undefined {
		const targets = this.rows.get(Math.floor(row));
		if (!targets) return undefined;
		const column = Math.floor(x);
		return targets.find(({ columns }) => columns === undefined || (column >= columns.start && column < columns.end));
	}
}
