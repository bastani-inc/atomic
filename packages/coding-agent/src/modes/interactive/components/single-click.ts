import type { TuiMouseEvent } from "@bastani/atomic-tui";

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
