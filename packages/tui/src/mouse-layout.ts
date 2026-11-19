import type { Component } from "./tui.ts";

export interface DrawnChild {
	component: Component;
	height: number;
	frame?: Frame;
}
export interface Frame {
	width: number;
	x: number;
	y: number;
	children: DrawnChild[];
}

let measurement: WeakMap<MouseLayout, Frame> | undefined;

/** A synchronous size check may read the child rows it measured, but must not publish them as a painted frame. */
export function withMeasuredMouseLayouts<T>(measure: () => T): T {
	const previous = measurement;
	measurement = new WeakMap();
	try {
		return measure();
	} finally {
		measurement = previous;
	}
}

// Read the layout structurally: extensions may bring their own copy of Container or Box. Older copies record
// the same child heights, but not a snapshot of their grandchildren; take it while those rows are being drawn.
export function frameOf(component: Component): Frame | undefined {
	const stack = component as Component & {
		mouseLayout?: { current?: Frame; width?: number; children?: DrawnChild[] };
		paddingX?: number;
		paddingY?: number;
	};
	const layout = stack.mouseLayout;
	if (!layout) return undefined;
	if (layout.current) return layout.current;
	if (layout.width === undefined || !Array.isArray(layout.children)) return undefined;
	return {
		width: layout.width,
		x: stack.paddingX ?? 0,
		y: stack.paddingY ?? 0,
		children: layout.children.map(({ component, height }) => drawnChild(component, height)),
	};
}

export function drawnChild(component: Component, height: number): DrawnChild {
	return { component, height, frame: frameOf(component) };
}

export class MouseLayout {
	private painted?: Frame;

	child(component: Component, height: number): DrawnChild {
		return drawnChild(component, height);
	}

	get current(): Frame | undefined {
		return measurement?.get(this) ?? this.painted;
	}

	set(width: number, children: DrawnChild[], x = 0, y = 0): void {
		const rows = { width, x, y, children };
		if (measurement) measurement.set(this, rows);
		else this.painted = rows;
	}

	atWidth(width: number): DrawnChild[] | undefined {
		const rows = this.current;
		return rows?.width === width ? rows.children : undefined;
	}
}

export interface ChildRow {
	component: Component;
	row: number;
	height: number;
	entry?: { component: Component; row: number; frame?: Frame };
}
export interface MouseCell {
	component: Component;
	x: number;
	y: number;
	width: number;
}

export function sameMouseCell(pressed: MouseCell | undefined, cell: MouseCell | undefined): boolean {
	return (
		!!pressed &&
		!!cell &&
		pressed.component === cell.component &&
		pressed.x === cell.x &&
		pressed.y === cell.y &&
		pressed.width === cell.width
	);
}

/** The innermost child drawn at a cell, from recorded heights and padding alone. */
export function paintedMouseCell(
	component: Component,
	x: number,
	y: number,
	width: number,
	rows: Frame | undefined,
): MouseCell {
	while (rows) {
		const childX = x - rows.x;
		let childY = y - rows.y;
		if (childX < 0 || childX >= rows.width || childY < 0) break;
		const hit = rows.children.find((child) => {
			if (childY < child.height) return true;
			childY -= child.height;
			return false;
		});
		if (!hit) break;
		x = childX;
		y = childY;
		width = rows.width;
		component = hit.component;
		rows = hit.frame;
	}
	return { component, x, y, width };
}
