import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { ANSI_RE, defaultTheme, makePendingPrompt, makeRunPromptSnap, makeStore } from "./overlay-graph-helpers.js";

const RUN_ID = "339e05a4-2289-408e-9076-d1a348f582ae";

function renderPromptOverlay(viewportRows: number): string[] {
	const snapshot = makeRunPromptSnap([], makePendingPrompt({ message: "Continue?" }));
	const run: RunSnapshot = { ...snapshot.runs[0]!, id: RUN_ID, name: "build-check" };
	const view = new GraphView({
		mode: "overlay",
		runId: RUN_ID,
		store: makeStore({ ...snapshot, runs: [run] }),
		graphTheme: defaultTheme,
		getViewportRows: () => viewportRows,
	});
	const lines = view.render(96);
	view.dispose();
	return lines;
}

function stripAnsi(line: string): string {
	return line.replace(ANSI_RE, "");
}

describe("GraphView prompt overlay height budget", () => {
	test("keeps every prompt box closed and answer hints visible while sweeping short viewport heights", () => {
		for (const viewportRows of Array.from({ length: 17 }, (_, index) => index + 14)) {
			const lines = renderPromptOverlay(viewportRows);
			const plain = lines.map(stripAnsi);
			const openBoxes: Array<{ left: number; width: number }> = [];
			for (const line of plain) {
				for (let column = 0; column < line.length; column++) {
					if (line[column] === "╭") {
						const right = line.indexOf("╮", column + 1);
						assert.ok(right > column, `viewportRows=${viewportRows} has an open top border`);
						openBoxes.push({ left: column, width: right - column });
					}
					if (line[column] === "╰") {
						const openBox = openBoxes.pop();
						const right = line.indexOf("╯", column + 1);
						assert.ok(openBox, `viewportRows=${viewportRows} closes a box before one is open`);
						assert.equal(column, openBox.left, `viewportRows=${viewportRows} shifts a box's bottom border`);
						assert.equal(
							right - column,
							openBox.width,
							`viewportRows=${viewportRows} changes a box's bottom width`,
						);
					}
				}
			}

			assert.equal(openBoxes.length, 0, `viewportRows=${viewportRows} leaves a box unclosed\n${plain.join("\n")}`);
			assert.match(plain.join("\n"), /enter Submit · ctrl\+c Skip/, `viewportRows=${viewportRows}`);
			assert.equal(lines.length, viewportRows);
			for (const line of lines) assert.equal(visibleWidth(line), 96, `viewportRows=${viewportRows}`);
		}
	});

	test("does not emit a partial prompt below the minimum complete height", () => {
		const rows13 = renderPromptOverlay(13).map(stripAnsi).join("\n");
		const rows14 = renderPromptOverlay(14).map(stripAnsi).join("\n");

		assert.doesNotMatch(rows13, /AWAITING INPUT/);
		assert.match(rows14, /AWAITING INPUT/);
		assert.match(rows14, /enter Submit · ctrl\+c Skip/);
	});

	test("omits supplementary attribution before sacrificing the complete prompt UI", () => {
		const rows21 = renderPromptOverlay(21).map(stripAnsi).join("\n");
		const rows22 = renderPromptOverlay(22).map(stripAnsi).join("\n");

		assert.doesNotMatch(rows21, new RegExp(RUN_ID));
		assert.match(rows21, /Continue\?/);
		assert.match(rows21, /enter Submit · ctrl\+c Skip/);
		assert.match(rows21, /╰─+╯/);
		assert.match(rows22, new RegExp(RUN_ID));
	});
});
