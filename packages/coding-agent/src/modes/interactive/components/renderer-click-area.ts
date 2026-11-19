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
import { type RowRange, rowsFrom } from "./transcript-block-clicks.ts";

// The public TUI classes that supply a mouse handler. Extensions can load another copy of the package,
// so comparing a handler only to this copy's prototype would mistake a stock dispatcher for an override.
const tuiMouseClasses = { Box, Container, Editor, Input, MouseRegion, SelectList, SettingsList };
const tuiMouseMethods = new Set(Object.values(tuiMouseClasses).map((type) => type.prototype.handleMouse));

/** A direct control handles its own click. Do not enter a wrapper's default dispatcher to look for one. */
function isRendererControl(component: Component): boolean {
	const handler = component.handleMouse;
	if (typeof handler !== "function" || tuiMouseMethods.has(handler)) return false;
	if (Object.hasOwn(component, "handleMouse")) return true;
	// Find the declaration, not just the immediate subclass: HStack inherits Container's row-only dispatcher.
	for (
		let owner = Object.getPrototypeOf(component), depth = 0;
		owner && depth < 32;
		owner = Object.getPrototypeOf(owner), depth++
	) {
		if (Object.hasOwn(owner, "handleMouse")) return !Object.hasOwn(tuiMouseClasses, owner.constructor?.name);
	}
	return false;
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
		clickRenderer(event) {
			if (event.y === title) return undefined;
			const y = event.y - top;
			const hit = host.childAtRow(event.width, y);
			if (!hit || !renderers.includes(hit.component) || !isRendererControl(hit.component)) return undefined;
			const line = stripTerminalSequences(rows[event.y] ?? "");
			const leftPadding = line.slice(0, line.length - line.trimStart().length);
			if (event.x < visibleWidth(leftPadding) || event.x >= visibleWidth(line.trimEnd())) return undefined;
			return host.handleMouse({ ...event, y, height: event.height - top });
		},
	};
}
