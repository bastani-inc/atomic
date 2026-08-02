import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { PendingPrompt, RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { GraphView } from "../../packages/workflows/src/tui/graph-view.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";
import { ANSI_RE, defaultTheme, makePendingPrompt, makeRunPromptSnap, makeStore } from "./overlay-graph-helpers.js";

const RUN_ID = "339e05a4-2289-408e-9076-d1a348f582ae";

function renderPromptOverlay(viewportRows: number, prompt = makePendingPrompt({ message: "Continue?" })): string[] {
	const snapshot = makeRunPromptSnap([], prompt);
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

function promptIdentityBanner(plain: readonly string[]): string[] {
	const bannerStart = plain.findIndex((line) => line.includes("╭ AWAITING INPUT "));
	if (bannerStart < 0) return [];
	const left = plain[bannerStart]!.indexOf("╭ AWAITING INPUT ");
	const card = plain.slice(bannerStart).map((line) => line.slice(left, left + 72));
	const bannerEnd = card.findIndex((line, index) => index > 0 && line.startsWith("╰"));
	return bannerEnd < 0 ? [] : card.slice(0, bannerEnd + 1);
}

function assertRoundedBoxesClosed(plain: string[], context: string): void {
	const openBoxes: Array<{ left: number; width: number }> = [];
	for (const line of plain) {
		for (let column = 0; column < line.length; column++) {
			if (line[column] === "╭") {
				const right = line.indexOf("╮", column + 1);
				assert.ok(right > column, `${context} has an open top border`);
				openBoxes.push({ left: column, width: right - column });
			}
			if (line[column] === "╰") {
				const openBox = openBoxes.pop();
				const right = line.indexOf("╯", column + 1);
				assert.ok(openBox, `${context} closes a box before one is open`);
				assert.equal(column, openBox.left, `${context} shifts a box's bottom border`);
				assert.equal(right - column, openBox.width, `${context} changes a box's bottom width`);
			}
		}
	}
	assert.equal(openBoxes.length, 0, `${context} leaves a box unclosed\n${plain.join("\n")}`);
}

function assertGraphFooterAtBodyBoundary(plain: string[], viewportRows: number, context: string): void {
	const marginRows = viewportRows >= 9 ? 1 : 0;
	const footerStart = viewportRows - marginRows - 3;
	assert.match(plain[footerStart]!, /╭─+╮/, `${context} is missing the GRAPH footer top border`);
	assert.match(plain[footerStart + 1]!, /│ GRAPH │/, `${context} is missing the GRAPH footer label`);
	assert.match(plain[footerStart + 2]!, /╰─+╯/, `${context} is missing the GRAPH footer bottom border`);
	for (const line of plain.slice(footerStart + 3)) {
		assert.equal(line.trim(), "", `${context} painted past the panel body/status region`);
	}
}

function promptCases(): Array<{ label: string; prompt: PendingPrompt }> {
	const cases: Array<{ label: string; prompt: PendingPrompt }> = [
		{ label: "input", prompt: makePendingPrompt({ kind: "input", message: "Continue?" }) },
		{ label: "confirm", prompt: makePendingPrompt({ kind: "confirm", message: "Continue?" }) },
		{
			label: "editor",
			prompt: makePendingPrompt({ kind: "editor", message: "Explain the decision", initial: "first\nsecond" }),
		},
	];
	for (const choiceCount of [2, 3, 5, 6, 8]) {
		const choices = Array.from({ length: choiceCount }, (_, index) =>
			choiceCount === 8 && index === 0
				? "A deliberately long option label that must remain width-safe while the select list scrolls"
				: `choice-${index + 1}`,
		);
		cases.push({
			label: `select choices=${choiceCount}${choiceCount === 8 ? " long-label" : ""}`,
			prompt: makePendingPrompt({ kind: "select", message: "Choose one", choices }),
		});
	}
	return cases;
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

	test("keeps the graph footer and every prompt box closed for every prompt kind across viewport heights", () => {
		for (const { label, prompt } of promptCases()) {
			for (let viewportRows = 8; viewportRows <= 40; viewportRows++) {
				const context = `${label} viewportRows=${viewportRows}`;
				const lines = renderPromptOverlay(viewportRows, prompt);
				const plain = lines.map(stripAnsi);

				assertRoundedBoxesClosed(plain, context);
				assertGraphFooterAtBodyBoundary(plain, viewportRows, context);
				assert.equal(lines.length, viewportRows, context);
				for (const line of lines) assert.equal(visibleWidth(line), 96, context);
			}
		}
	});

	test("renders a reduced complete prompt below the full-control height", () => {
		const rows13 = renderPromptOverlay(13).map(stripAnsi).join("\n");
		const rows14 = renderPromptOverlay(14).map(stripAnsi).join("\n");

		assert.match(rows13, /AWAITING INPUT/);
		assert.match(rows13, /Continue\?/);
		assert.match(rows13, /enter Submit · ctrl\+c Skip/);
		assert.match(rows14, /AWAITING INPUT/);
		assert.match(rows14, /enter Submit · ctrl\+c Skip/);
	});

	test("omits supplementary attribution before sacrificing the complete prompt UI", () => {
		const rows21 = renderPromptOverlay(17).map(stripAnsi).join("\n");
		const rows22 = renderPromptOverlay(19).map(stripAnsi).join("\n");

		assert.doesNotMatch(rows21, new RegExp(RUN_ID));
		assert.match(rows21, /Continue\?/);
		assert.match(rows21, /enter Submit · ctrl\+c Skip/);
		assert.match(rows21, /╰─+╯/);
		assert.match(rows22, new RegExp(RUN_ID));
		const selectPrompt = makePendingPrompt({
			kind: "select",
			message: "OVERLAY-SELECT-QUESTION",
			choices: ["stable", "beta", "nightly"],
		});
		for (const viewportRows of [21, 22]) {
			const overlay = renderPromptOverlay(viewportRows, selectPrompt).map(stripAnsi).join("\n");
			assert.match(overlay, /OVERLAY-SELECT-QUESTION/, `viewportRows=${viewportRows}`);
			assert.match(overlay, new RegExp(RUN_ID), `viewportRows=${viewportRows}`);
		}
	});

	test("uses the full-id-only banner between full attribution and banner yield", () => {
		const yielded = renderPromptOverlay(17).map(stripAnsi);
		const oneRow = renderPromptOverlay(18).map(stripAnsi);
		const twoRows = renderPromptOverlay(19).map(stripAnsi);
		const oneRowBanner = promptIdentityBanner(oneRow);
		const twoRowBanner = promptIdentityBanner(twoRows);

		assert.doesNotMatch(yielded.join("\n"), new RegExp(RUN_ID));
		assert.ok(oneRowBanner.join("\n").includes(RUN_ID), "one-row banner must carry the complete run id");
		assert.doesNotMatch(oneRowBanner.join("\n"), /build-check/);
		assert.equal(oneRowBanner.length, 3, "one-row banner has only top, full-id, and bottom rows");
		assert.ok(twoRowBanner.join("\n").includes(RUN_ID));
		assert.match(twoRowBanner.join("\n"), /build-check/);
		assert.equal(twoRowBanner.length, 4, "two-row banner shape must remain unchanged");
	});
});
