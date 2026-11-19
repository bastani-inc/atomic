import type { Component, TuiMouseEvent, TuiMouseEventResult } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

/** The zero-width mark {@link ClickableRows.mark} puts before a row's text: an APC sequence carrying the item's key. */
const ROW_MARK_PATTERN = /\x1b_atomic-row:([^\x07\x1b]*)\x1b\\/g;

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

/** What a list does when one of its rows is clicked. */
export interface ClickableRowActions<T> {
	/**
	 * Run `target` the way Enter runs the selected row: move the selection to it, then confirm it, with every
	 * confirmation step the keyboard has.
	 */
	activate(target: T): void;
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
 * - A double or triple click does not run the row again. A modified click is a selection gesture only.
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

	/**
	 * Put a zero-width mark naming item `key` before `text`, for a list drawn inside a layout that places its rows
	 * (frames, columns, wrapping): the component that owns the whole layout calls {@link collect} on its finished lines
	 * to learn where each marked row landed. A row the layout wraps carries the mark on its first line only, so mark
	 * every line of a multi-line row.
	 */
	static mark(key: string, text: string): string {
		return `\x1b_atomic-row:${encodeURIComponent(key)}\x1b\\${text}`;
	}

	/** A zero-width mark that ends the marked span before it without starting another, such as before a trailing count. */
	static readonly END_MARK = "\x1b_atomic-row:\x1b\\";

	/**
	 * Record the rows of a render from the marks {@link mark} left in `lines`, and return the lines without them. A mark
	 * covers its line from its own column to the next mark, or to the end of the line. `resolve` names the target each
	 * key stands for; a key it does not know is dropped.
	 */
	collect(lines: readonly string[], resolve: (key: string) => T | undefined): string[] {
		this.clear();
		return lines.map((line, row) => {
			if (!line.includes("\x1b_atomic-row:")) return line;
			const found: Array<{ key: string; column: number }> = [];
			let stripped = "";
			let last = 0;
			for (const match of line.matchAll(ROW_MARK_PATTERN)) {
				stripped += line.slice(last, match.index);
				last = match.index + match[0].length;
				found.push({ key: decodeURIComponent(match[1] ?? ""), column: visibleWidth(stripped) });
			}
			stripped += line.slice(last);
			const end = visibleWidth(stripped);
			for (const [index, { key, column }] of found.entries()) {
				const target = key === "" ? undefined : resolve(key);
				if (target !== undefined)
					this.add(row, target, key, { start: column, end: found[index + 1]?.column ?? end });
			}
			return stripped;
		});
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
	 * Run the clicked row. The press itself is not taken: the renderer keeps it
	 * for text selection and sends the click only when the pointer was released where it was pressed. A click that
	 * follows a press on another item, as when the rows moved under the pointer, runs nothing. A click with no press
	 * before it, as one forwarded from another process, runs the item drawn under it.
	 */
	handleMouse(event: TuiMouseEvent, actions: ClickableRowActions<T>): TuiMouseEventResult | undefined {
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

/**
 * One row of a list built from components, such as a `Text` per option in a `Container`: every line `content` draws
 * belongs to the row, and a click on any of them runs it through {@link ClickableRows}. A list that stacks these in a
 * container gets clicks by construction, since the container forwards each mouse event to the child drawn there.
 */
export class ClickableRow implements Component {
	private readonly content: Component;
	private readonly key: string;
	private readonly actions: ClickableRowActions<string>;
	private readonly rows = new ClickableRows<string>();

	/** `key` names the row's item, stable across renders; `actions.activate` runs it as Enter on it would. */
	constructor(content: Component, key: string, actions: ClickableRowActions<string>) {
		this.content = content;
		this.key = key;
		this.actions = actions;
	}

	render(width: number): string[] {
		const lines = this.content.render(width);
		this.rows.clear();
		for (let row = 0; row < lines.length; row++) this.rows.add(row, this.key, this.key);
		return lines;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.rows.handleMouse(event, this.actions);
	}

	paintedRowKey(row: number): string | undefined {
		return this.rows.paintedRowKey(row);
	}

	invalidate(): void {
		this.content.invalidate();
	}
}
