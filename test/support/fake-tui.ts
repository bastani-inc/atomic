/** Minimal host TUI fixture for components that read terminal geometry. */

import type { TUI } from "@earendil-works/pi-tui";

export function makeTestTui(rows: number | (() => number | undefined)): TUI {
	const readRows = typeof rows === "function" ? rows : () => rows;
	// The members consumers actually read stay structurally checked; only the
	// final widening to the full TUI class is asserted, at one boundary
	// (Greptile P2 on PR #2315). `terminal` is itself narrowed to the two
	// geometry members the graph and stage-chat views consume.
	const fixture: Pick<TUI, "requestRender"> & {
		terminal: Pick<TUI["terminal"], "rows" | "columns">;
	} = {
		requestRender: () => {},
		terminal: {
			get rows() {
				return readRows() as number;
			},
			columns: 80,
		},
	};
	return fixture as TUI;
}
