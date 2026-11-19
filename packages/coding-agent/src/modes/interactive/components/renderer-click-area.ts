import {
	Box,
	type Component,
	Container,
	Editor,
	Input,
	MouseRegion,
	SelectList,
	SettingsList,
	stripTerminalSequences,
	visibleWidth,
} from "@bastani/atomic-tui";
import { type RowRange, rowsFrom, sameRows } from "./transcript-block-clicks.ts";

const tuiMouseMethods = new Set(
	[Box, Container, Editor, Input, MouseRegion, SelectList, SettingsList].map((type) => type.prototype.handleMouse),
);

/** A direct control handles its own click. Do not enter a wrapper's default dispatcher to look for one. */
function isRendererControl(component: Component): boolean {
	const handler = component.handleMouse;
	if (typeof handler !== "function" || tuiMouseMethods.has(handler)) return false;
	if (Object.hasOwn(component, "handleMouse")) return true;
	// A layout container (or a region that delegates to a child) is not a leaf, including in bundled TUI copies.
	if ("children" in component || ("child" in component && "onMouse" in component)) return false;
	const prototype = Object.getPrototypeOf(component);
	return prototype !== null && Object.hasOwn(prototype, "handleMouse");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** A label includes spaces between its printed cells, but not the blank cells on either side. */
function onLabel(row: string, x: number): boolean {
	let column = 0;
	let first = Number.POSITIVE_INFINITY;
	let end = 0;
	for (const { segment } of graphemes.segment(stripTerminalSequences(row))) {
		const width = visibleWidth(segment);
		if (width > 0 && visibleWidth(segment.trim()) > 0) {
			first = Math.min(first, column);
			end = column + width;
		}
		column += width;
	}
	return x >= first && x < end;
}

/** Use the rows the block already measured for clickArea, and only its directly mounted renderer(s). */
export function rendererRows(
	start: number,
	rows: readonly string[],
	host: Container,
	renderers: readonly (Component | undefined)[],
	{ top = 0, title }: { top?: number; title?: number } = {},
): RowRange | undefined {
	const area = rowsFrom(start, rows.length);
	if (!area || !renderers.some((renderer) => renderer !== undefined)) return area;
	return {
		...area,
		clickRenderer(event, windowRows) {
			if (event.y === title) return undefined;
			const y = event.y - top;
			const hit = host.childAtRow(event.width, y);
			if (!hit || !renderers.includes(hit.component) || !isRendererControl(hit.component)) return undefined;
			if (!sameRows(windowRows, rows)) return undefined;
			if (!onLabel(rows[event.y] ?? "", event.x)) return undefined;
			return host.handleMouse({ ...event, y, height: event.height - top });
		},
	};
}
