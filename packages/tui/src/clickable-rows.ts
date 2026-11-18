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

	/** Forget the rows of the previous render. */
	clear(): void {
		this.rows = new Map();
	}

	/**
	 * Record that the render drew `target` on `row`, named by `key` (stable for the same item across renders). Without
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
		const targets = this.rows.get(Math.floor(row));
		if (!targets) return undefined;
		const column = Math.floor(x);
		const hit = targets.find(
			({ columns }) => columns === undefined || (column >= columns.start && column < columns.end),
		);
		return hit?.target;
	}

	/** What the last render drew on `row`, for `Component.paintedRowKey`. */
	paintedRowKey(row: number): string | undefined {
		const targets = this.rows.get(row);
		if (!targets) return undefined;
		return targets.map(({ key }) => key).join("\u0000");
	}

	/** Run the clicked row, or move the selection on a wheel turn; anything else is left to the renderer. */
	handleMouse(event: TuiMouseEvent, actions: ClickableRowActions<T>): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			if (!actions.scroll || !event.wheelDelta) return undefined;
			return { handled: true, render: actions.scroll(event.wheelDelta < 0 ? -1 : 1) };
		}
		if (!isSingleLeftClick(event)) return undefined;
		const target = this.targetAt(event.x, event.y);
		if (target === undefined) return undefined;
		actions.activate(target);
		return { handled: true };
	}
}
