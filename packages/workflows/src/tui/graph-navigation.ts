import type { LayoutNode } from "./layout.js";

export interface GraphNodeNavigation {
	readonly up?: number;
	readonly down?: number;
	readonly left?: number;
	readonly right?: number;
	readonly arrows: string;
}

interface ColumnEntry {
	readonly index: number;
	readonly row: number;
}

function nearestIndex(column: readonly ColumnEntry[] | undefined, row: number): number | undefined {
	if (column === undefined || column.length === 0) return undefined;
	let low = 0;
	let high = column.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (column[middle]!.row < row) low = middle + 1;
		else high = middle;
	}
	const before = column[low - 1];
	const after = column[low];
	if (before === undefined) return after?.index;
	if (after === undefined) return before.index;
	const beforeDistance = row - before.row;
	const afterDistance = after.row - row;
	if (beforeDistance === afterDistance) return Math.min(before.index, after.index);
	return beforeDistance < afterDistance ? before.index : after.index;
}

export function buildGraphNavigation(layout: readonly LayoutNode[]): readonly GraphNodeNavigation[] {
	const columns = new Map<number, ColumnEntry[]>();
	for (let index = 0; index < layout.length; index++) {
		const node = layout[index]!;
		let column = columns.get(node.col);
		if (column === undefined) {
			column = [];
			columns.set(node.col, column);
		}
		column.push({ index, row: node.row });
	}
	for (const column of columns.values()) column.sort((a, b) => a.row - b.row || a.index - b.index);
	const navigation: GraphNodeNavigation[] = new Array(layout.length);
	for (const [depth, column] of columns) {
		for (let position = 0; position < column.length; position++) {
			const node = column[position]!;
			const up = nearestIndex(columns.get(depth - 1), node.row);
			const down = nearestIndex(columns.get(depth + 1), node.row);
			const left = column[position - 1]?.index;
			const right = column[position + 1]?.index;
			navigation[node.index] = {
				up,
				down,
				left,
				right,
				arrows: `${up === undefined ? "" : "↑"}${down === undefined ? "" : "↓"}${left === undefined ? "" : "←"}${right === undefined ? "" : "→"}`,
			};
		}
	}
	return navigation;
}
