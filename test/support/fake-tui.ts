/** Minimal host TUI fixture for components that read terminal geometry. */

import type { TUI } from "@earendil-works/pi-tui";

export function makeTestTui(rows: number | (() => number | undefined)): TUI {
	const readRows = typeof rows === "function" ? rows : () => rows;
	return {
		requestRender: () => {},
		terminal: {
			get rows() {
				return readRows();
			},
			columns: 80,
		},
	} as unknown as TUI;
}
