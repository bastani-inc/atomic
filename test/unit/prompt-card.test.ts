/**
 * Smoke tests for the HIL prompt card (graph viewer overlay surface).
 * cross-ref: src/tui/prompt-card.ts
 *
 * Covers:
 *  - createPromptCardState seeds caret from `initial`
 *  - renderPromptCard returns width-bounded ANSI lines for every kind
 *  - handlePromptCardInput discriminates submit/cancel/noop correctly
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { PendingPrompt } from "../../packages/workflows/src/shared/store-types.ts";
import { hexToAnsi } from "../../packages/workflows/src/tui/color-utils.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import {
	createPromptCardState,
	defaultResponseFor,
	handlePromptCardInput,
	renderPromptCard,
} from "../../packages/workflows/src/tui/prompt-card.ts";
import { renderPromptCardLayout } from "../../packages/workflows/src/tui/prompt-card-render.ts";
import { statusColor, statusIcon } from "../../packages/workflows/src/tui/status-helpers.ts";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.ts";
import { makeFakeKeybindings } from "../support/fake-keybindings.ts";

const theme = deriveGraphTheme({});
const keybindings = makeFakeKeybindings();
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

function makePrompt(overrides: Partial<PendingPrompt> = {}): PendingPrompt {
	return {
		id: "test-prompt",
		kind: "input",
		message: "Hello there",
		createdAt: Date.now(),
		...overrides,
	};
}

describe("createPromptCardState", () => {
	test("seeds rawText + caret from initial value", () => {
		const state = createPromptCardState(makePrompt({ initial: "seed" }));
		assert.equal(state.rawText, "seed");
		assert.equal(state.caret, 4);
		assert.equal(state.selectedIndex, 0);
		assert.equal(state.confirmValue, false);
	});

	test("defaults to empty rawText when initial is undefined", () => {
		const state = createPromptCardState(makePrompt());
		assert.equal(state.rawText, "");
		assert.equal(state.caret, 0);
	});
});

describe("handlePromptCardInput — confirm", () => {
	test("y submits true, n submits false", () => {
		const state = createPromptCardState(makePrompt({ kind: "confirm" }));
		assert.deepEqual(handlePromptCardInput("y", state), { kind: "submit", response: true });
		const state2 = createPromptCardState(makePrompt({ kind: "confirm" }));
		assert.deepEqual(handlePromptCardInput("n", state2), { kind: "submit", response: false });
	});

	test("space toggles current selection without submitting", () => {
		const state = createPromptCardState(makePrompt({ kind: "confirm" }));
		assert.equal(state.confirmValue, false);
		assert.deepEqual(handlePromptCardInput(" ", state), { kind: "noop" });
		assert.equal(state.confirmValue, true);
	});

	test("enter submits the currently toggled value", () => {
		const state = createPromptCardState(makePrompt({ kind: "confirm" }));
		state.confirmValue = true;
		assert.deepEqual(handlePromptCardInput("\r", state), { kind: "submit", response: true });
	});

	test("ctrl+c variants cancel while Escape variants are consumed", () => {
		for (const key of ["\x03", "\x1b[99;5u", "\x1b[99;5:1u", "\x1b[27;5;99~"]) {
			const state = createPromptCardState(makePrompt({ kind: "confirm" }));
			assert.deepEqual(handlePromptCardInput(key, state), { kind: "cancel" }, `key=${JSON.stringify(key)}`);
		}
		for (const key of ["\x1b", "\x1b[27u", "\x1b[27;1;27~"]) {
			const state = createPromptCardState(makePrompt({ kind: "confirm" }));
			assert.deepEqual(handlePromptCardInput(key, state), { kind: "noop" }, `key=${JSON.stringify(key)}`);
		}
	});
});

describe("handlePromptCardInput — select", () => {
	test("arrow keys cycle the index without submitting", () => {
		const state = createPromptCardState(makePrompt({ kind: "select", choices: ["a", "b", "c"] }));
		assert.deepEqual(handlePromptCardInput("\x1b[B", state), { kind: "noop" });
		assert.equal(state.selectedIndex, 1);
		assert.deepEqual(handlePromptCardInput("\x1b[C", state), { kind: "noop" });
		assert.equal(state.selectedIndex, 2);
		assert.deepEqual(handlePromptCardInput("\x1b[B", state), { kind: "noop" });
		assert.equal(state.selectedIndex, 0, "wraps at the end");
		assert.deepEqual(handlePromptCardInput("\x1b[A", state), { kind: "noop" });
		assert.equal(state.selectedIndex, 2, "wraps before the start");
		assert.deepEqual(handlePromptCardInput("\x1b[D", state), { kind: "noop" });
		assert.equal(state.selectedIndex, 1);
	});

	test("configured select keybindings navigate and submit deterministically", () => {
		const state = createPromptCardState(makePrompt({ kind: "select", choices: ["a", "b", "c"] }));
		const remapped = makeFakeKeybindings({
			"tui.select.down": ["d"],
			"tui.select.up": ["u"],
			"tui.select.confirm": ["s"],
		});

		assert.deepEqual(handlePromptCardInput("d", state, remapped), { kind: "noop" });
		assert.equal(state.selectedIndex, 1);
		assert.deepEqual(handlePromptCardInput("u", state, remapped), { kind: "noop" });
		assert.equal(state.selectedIndex, 0);
		state.selectedIndex = 2;
		assert.deepEqual(handlePromptCardInput("s", state, remapped), { kind: "submit", response: "c" });
	});

	test("bare Escape does not resolve select prompts", () => {
		const state = createPromptCardState(makePrompt({ kind: "select", choices: ["a", "b"] }));
		assert.deepEqual(handlePromptCardInput("\x1b", state), { kind: "noop" });
		assert.equal(state.selectedIndex, 0);
	});

	test("enter submits the selected choice", () => {
		const state = createPromptCardState(makePrompt({ kind: "select", choices: ["a", "b", "c"] }));
		state.selectedIndex = 1;
		assert.deepEqual(handlePromptCardInput("\r", state), { kind: "submit", response: "b" });
	});
});

describe("handlePromptCardInput — input", () => {
	test("typing chars appends to rawText", () => {
		const state = createPromptCardState(makePrompt({ kind: "input" }));
		handlePromptCardInput("h", state);
		handlePromptCardInput("i", state);
		assert.equal(state.rawText, "hi");
		assert.equal(state.caret, 2);
	});

	test("backspace removes char before caret", () => {
		const state = createPromptCardState(makePrompt({ kind: "input", initial: "abc" }));
		handlePromptCardInput("\x7f", state);
		assert.equal(state.rawText, "ab");
		assert.equal(state.caret, 2);
	});

	test("enter submits the buffer", () => {
		const state = createPromptCardState(makePrompt({ kind: "input", initial: "answer" }));
		assert.deepEqual(handlePromptCardInput("\r", state), { kind: "submit", response: "answer" });
	});

	test("supports readline-style movement and delete keybindings", () => {
		const state = createPromptCardState(makePrompt({ kind: "input", initial: "alpha beta gamma" }));

		handlePromptCardInput("\x01", state, keybindings); // ctrl+a
		assert.equal(state.caret, 0);
		handlePromptCardInput("\x1bf", state, keybindings); // alt+f
		assert.equal(state.caret, 5);
		handlePromptCardInput("\x1bf", state, keybindings); // alt+f over whitespace + beta
		assert.equal(state.caret, 10);
		handlePromptCardInput("\x17", state, keybindings); // ctrl+w
		assert.equal(state.rawText, "alpha  gamma");
		assert.equal(state.caret, 6);
		handlePromptCardInput("\x05", state, keybindings); // ctrl+e
		assert.equal(state.caret, "alpha  gamma".length);
		handlePromptCardInput("\x0b", state, keybindings); // ctrl+k at end noops
		assert.equal(state.rawText, "alpha  gamma");
	});

	test("decodes terminal printable key sequences", () => {
		const state = createPromptCardState(makePrompt({ kind: "input" }));
		handlePromptCardInput("\x1b[97;1u", state, keybindings);
		assert.equal(state.rawText, "a");
		assert.equal(state.caret, 1);
	});
});

describe("handlePromptCardInput — editor", () => {
	test("enter inserts a newline (not submit)", () => {
		const state = createPromptCardState(makePrompt({ kind: "editor", initial: "line1" }));
		handlePromptCardInput("\r", state);
		assert.equal(state.rawText, "line1\n");
		assert.equal(state.caret, 6);
	});

	test("tab focuses Submit response action and enter submits the buffer", () => {
		const state = createPromptCardState(makePrompt({ kind: "editor", initial: "draft" }));
		assert.deepEqual(handlePromptCardInput("\t", state), { kind: "noop" });
		assert.equal(state.editorSubmitFocused, true);
		assert.deepEqual(handlePromptCardInput("\r", state), { kind: "submit", response: "draft" });
	});

	test("moves the caret up and down across editor lines", () => {
		const state = createPromptCardState(makePrompt({ kind: "editor", initial: "abc\ndefgh\nij" }));
		state.caret = 7; // after "def"

		handlePromptCardInput("\x1b[A", state, keybindings);
		assert.equal(state.caret, 3);
		handlePromptCardInput("\x1b[B", state, keybindings);
		assert.equal(state.caret, 7);
	});

	test("bare Escape does not resolve editor prompts", () => {
		const state = createPromptCardState(makePrompt({ kind: "editor", initial: "draft" }));
		assert.deepEqual(handlePromptCardInput("\x1b", state, keybindings), { kind: "noop" });
		assert.equal(state.rawText, "draft");
		assert.equal(state.caret, "draft".length);
	});
});

describe("defaultResponseFor", () => {
	test("input/editor default to initial or empty", () => {
		assert.equal(defaultResponseFor(makePrompt({ kind: "input" })), "");
		assert.equal(defaultResponseFor(makePrompt({ kind: "editor", initial: "x" })), "x");
	});

	test("confirm defaults to false", () => {
		assert.equal(defaultResponseFor(makePrompt({ kind: "confirm" })), false);
	});

	test("select defaults to first choice (or empty)", () => {
		assert.equal(defaultResponseFor(makePrompt({ kind: "select", choices: ["a", "b"] })), "a");
		assert.equal(defaultResponseFor(makePrompt({ kind: "select" })), "");
	});
});

describe("renderPromptCard", () => {
	test("renders multiple lines, each exactly matching the requested width", () => {
		const state = createPromptCardState(makePrompt({ kind: "input", message: "What's your name?" }));
		const lines = renderPromptCard({ state, theme, width: 60, cursorOn: true });
		assert.ok(lines.length > 0);
		for (const line of lines) {
			assert.equal(visibleWidth(line), 60, `line width mismatch: ${visibleWidth(line)}`);
		}
	});

	test("renders for every prompt kind without throwing", () => {
		const kinds: PendingPrompt["kind"][] = ["input", "confirm", "select", "editor"];
		for (const kind of kinds) {
			const state = createPromptCardState(makePrompt({ kind, choices: kind === "select" ? ["a", "b"] : undefined }));
			const lines = renderPromptCard({ state, theme, width: 50, cursorOn: false });
			assert.ok(lines.length > 0, `kind ${kind} produced no lines`);
		}
	});

	test("never emits more complete rows than the caller's budget for any prompt kind", () => {
		const kinds: PendingPrompt["kind"][] = ["input", "confirm", "select", "editor"];
		for (const kind of kinds) {
			for (const choiceCount of [2, 3, 5, 8]) {
				const choices = Array.from({ length: choiceCount }, (_, index) => `choice-${index + 1}`);
				const state = createPromptCardState(
					makePrompt({
						kind,
						choices: kind === "select" ? choices : undefined,
						initial: kind === "editor" ? "first\nsecond\nthird" : undefined,
					}),
				);
				for (let width = 40; width <= 100; width += 2) {
					for (let maxRows = 1; maxRows <= 30; maxRows++) {
						const lines = renderPromptCard({ state, theme, width, cursorOn: false, maxRows });
						assert.ok(
							lines.length <= maxRows,
							`kind=${kind} choices=${choiceCount} width=${width} maxRows=${maxRows} emitted=${lines.length}`,
						);
					}
				}
			}
		}
	});

	test("includes the prompt message in the rendered text", () => {
		const state = createPromptCardState(makePrompt({ message: "UNIQUE-MARKER-XYZ" }));
		const lines = renderPromptCard({ state, theme, width: 60, cursorOn: false });
		const joined = lines.join("\n");
		assert.ok(joined.includes("UNIQUE-MARKER-XYZ"), "message text must appear in output");
	});

	test("renders an identity-only awaiting-input attribution banner", () => {
		const runId = "d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f";
		const question = "Ship this change?";
		const state = createPromptCardState(makePrompt({ message: question }));
		const lines = renderPromptCard({
			state,
			theme,
			width: 80,
			cursorOn: false,
			identity: { runId, name: "build-check" },
		});
		const plain = lines.map(stripAnsi);
		const bannerEnd = plain.findIndex((line) => line.startsWith("╰"));
		assert.ok(bannerEnd >= 0, "attribution banner has a bottom border");
		const banner = plain.slice(0, bannerEnd + 1).join("\n");

		assert.match(banner, /^╭ AWAITING INPUT /);
		assert.ok(banner.includes(runId), "banner keeps the complete run id");
		assert.ok(banner.includes("build-check"), "banner keeps the workflow name");
		assert.doesNotMatch(banner, /Ship this change\?/);
		assert.equal(plain.filter((line) => line.startsWith("╭ AWAITING INPUT ")).length, 1);
		assert.ok(
			lines[1]?.includes(`${hexToAnsi(statusColor("awaiting_input", theme))}${statusIcon("awaiting_input")}`),
		);
		assert.ok(plain.join("\n").includes(question), "the existing prompt UI still renders the question below");
	});

	test("keeps select questions visible as budgets grow and attribution appears", () => {
		const questionMarkers = Array.from({ length: 4 }, (_, index) => `MONOTONIC-QUESTION-${index + 1}`);
		const state = createPromptCardState(
			makePrompt({ kind: "select", message: questionMarkers.join("\n"), choices: ["stable", "beta", "nightly"] }),
		);
		let previousVisibleMarkers = new Set<string>();
		for (let maxRows = 8; maxRows <= 24; maxRows += 1) {
			const rendered = renderPromptCard({
				state,
				theme,
				width: 72,
				cursorOn: false,
				identity: { runId: "339e05a4-2289-408e-9076-d1a348f582ae", name: "build-check" },
				maxRows,
			})
				.map(stripAnsi)
				.join("\n");
			const visibleMarkers = new Set(questionMarkers.filter((marker) => rendered.includes(marker)));
			const bannerIsVisible = rendered.includes("339e05a4-2289-408e-9076-d1a348f582ae");
			if (bannerIsVisible) {
				assert.ok(visibleMarkers.size > 0, `maxRows=${maxRows} lets attribution starve the question`);
			}
			for (const marker of previousVisibleMarkers) {
				assert.ok(visibleMarkers.has(marker), `increasing maxRows to ${maxRows} removes ${marker}`);
			}
			previousVisibleMarkers = visibleMarkers;
		}
	});

	test("keeps attributed select and confirm question content visible and monotonic from 8 through 24 rows", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		const workflowName = "middle-rung-workflow";
		const questionMarkers = Array.from({ length: 4 }, (_, index) => `LADDER-QUESTION-${index + 1}`);
		const middleRungKinds = new Set<PendingPrompt["kind"]>();
		for (const kind of ["confirm", "select"] as const) {
			const state = createPromptCardState(
				makePrompt({
					kind,
					message: questionMarkers.join("\n"),
					choices: kind === "select" ? ["stable", "beta", "nightly"] : undefined,
				}),
			);
			let previousVisibleMarkers = new Set<string>();
			for (let maxRows = 8; maxRows <= 24; maxRows += 1) {
				const layout = renderPromptCardLayout({
					state,
					theme,
					width: 72,
					cursorOn: false,
					identity: { runId, name: workflowName },
					maxRows,
				});
				const rendered = layout.lines.map(stripAnsi).join("\n");
				const visibleMarkers = new Set(questionMarkers.filter((marker) => rendered.includes(marker)));
				const bannerIsVisible = rendered.includes(runId);
				if (bannerIsVisible) {
					assert.ok(layout.visibleQuestionRows >= 1, `${kind} maxRows=${maxRows} renders a zero-row question`);
					if (!rendered.includes(workflowName)) middleRungKinds.add(kind);
				}
				for (const marker of previousVisibleMarkers) {
					assert.ok(visibleMarkers.has(marker), `${kind} increasing maxRows to ${maxRows} removes ${marker}`);
				}
				previousVisibleMarkers = visibleMarkers;
			}
		}
		assert.deepEqual([...middleRungKinds], ["confirm", "select"], "both prompt kinds must use the one-row rung");
	});

	test("wraps the attribution id without breaking borders at narrow widths", () => {
		const runId = "d4e5f6a1-77b2-4c31-9e0a-2f1c8b4d6e5f";
		const state = createPromptCardState(makePrompt({ message: "UNIQUE-PROMPT" }));
		for (const width of [80, 40, 30, 20]) {
			const lines = renderPromptCard({
				state,
				theme,
				width,
				cursorOn: false,
				identity: { runId, name: "build-check" },
			});
			const plain = lines.map(stripAnsi);
			const expectedWidth = Math.max(22, width);
			for (const line of plain) assert.equal(visibleWidth(line), expectedWidth);
			const banner = plain.slice(0, plain.findIndex((line) => line.startsWith("╰")) + 1);
			const idStart = banner.findIndex((line) => line.includes(runId.slice(0, 8)));
			const nameRow = banner.findIndex((line, index) => index > idStart && line.includes("build-check"));
			const renderedId = banner
				.slice(idStart, nameRow)
				.join("")
				.replace(/[^0-9a-f-]/gi, "");
			assert.equal(renderedId, runId, `full id is retained at width ${width}`);
			assert.ok(plain.every((line) => line.startsWith("╭") || line.startsWith("╰") || line.startsWith("│")));
		}
	});

	test("response field uses rounded border chrome", () => {
		const state = createPromptCardState(makePrompt({ kind: "input" }));
		const lines = renderPromptCard({ state, theme, width: 60, cursorOn: false });
		const plain = lines.map(stripAnsi).join("\n");

		assert.match(plain, /╭ response ─+╮/);
		assert.match(plain, /╰─+╯/);
		assert.doesNotMatch(plain, /[\u250c\u2510\u2514\u2518]/);
	});

	test("outer prompt card does not paint a background slab behind the border", () => {
		const state = createPromptCardState(makePrompt({ kind: "input" }));
		const lines = renderPromptCard({ state, theme, width: 60, cursorOn: false });

		assert.ok(!lines[0]!.startsWith("\x1b[48;"));
		assert.ok(!lines.at(-1)!.startsWith("\x1b[48;"));
	});
});
