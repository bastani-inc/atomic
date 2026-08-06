/**
 * Unit tests for the `/workflow <name> …` dispatch confirmation
 * (`src/tui/dispatch-confirm.ts`).
 *
 * Visual contract — ui/dispatch-mockup.html §1 (full-id identity rows):
 *  - One rounded dispatched panel with the full UUID on its own identity row.
 *  - Workflow name and running status follow on the next row.
 *  - Inputs render in the body and the connect hint keeps the complete UUID.
 *  - Inputs wrap to a second body row only when row 1's interior cannot
 *    hold them; the body row uses the same overflow rules.
 *
 * cross-ref: src/tui/dispatch-confirm.ts · src/tui/chat-surface.ts
 *            · ui/dispatch-mockup.html
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderDispatchConfirm } from "../../packages/workflows/src/tui/dispatch-confirm.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { statusIcon } from "../../packages/workflows/src/tui/status-helpers.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string) => s.replace(ANSI_RE, "");

describe("renderDispatchConfirm — themed", () => {
	test("emits rounded dispatched panel with run card and connect hint", () => {
		const out = renderDispatchConfirm({
			workflowName: "fan-out-and-synthesize",
			runId: "0391c9c1-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { prompt: "map the codebase", max_branches: 4 },
			theme: deriveGraphTheme({}),
			width: 140,
		});
		const plain = stripAnsi(out);

		// Identity keeps the complete run id and workflow name.
		assert.match(plain, /0391c9c1-aaaa-bbbb-cccc-dddddddddddd/);
		assert.match(plain, /fan-out-and-synthesize/);

		// Status badge in the trailing slot.
		assert.match(plain, /● running/);

		// Inputs ride row 1 (wide terminal → inline path).
		assert.match(plain, /prompt="map the codebase"/);
		assert.match(plain, /max_branches=4/);

		// Guidance preserves the complete actionable id and explains the graph in
		// plain language without attach/detach jargon.
		assert.match(plain, /▸ \/workflow connect 0391c9c1-aaaa-bbbb-cccc-dddddddddddd\s+see agents working/);
		assert.match(plain, /chat with and steer each stage/);
		assert.doesNotMatch(plain, /attach|detach/i);
		// Legacy chrome MUST be gone.
		assert.doesNotMatch(plain, /✓ submitted/);
		assert.doesNotMatch(plain, /\[ DISPATCHED \]/);
		assert.doesNotMatch(plain, /\bstarting…/);
		assert.doesNotMatch(plain, /▸ \/workflow status/);

		assert.match(plain, /^╭ DISPATCHED /);
		assert.doesNotMatch(plain, /\brun id\b/);
		assert.match(
			plain,
			new RegExp(`${statusIcon("running")} {2}fan-out-and-synthesize {2}${statusIcon("running")} running`),
		);

		// Themed mode emits ANSI escapes.
		assert.match(out, /\x1b\[/);
	});

	test("wide terminal → inputs render inside the rounded run card", () => {
		const out = renderDispatchConfirm({
			workflowName: "fan-out-and-synthesize",
			runId: "be3181c1-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { prompt: "explore the codebase", max_branches: 4 },
			theme: deriveGraphTheme({}),
			width: 160,
		});
		const lines = stripAnsi(out).split("\n");
		assert.match(lines[0]!, /DISPATCHED/);
		assert.match(lines[1]!, /be3181c1-aaaa-bbbb-cccc-dddddddddddd/);
		assert.match(lines[2]!, /fan-out-and-synthesize/);
		assert.match(lines[3]!, /prompt="explore the codebase"/);
		assert.match(lines[3]!, /max_branches=4/);
		assert.match(lines.join("\n"), /● running/);
		assert.match(lines.join("\n"), /▸ \/workflow connect be3181c1-aaaa-bbbb-cccc-dddddddddddd/);
	});

	test("narrow terminal → rounded card remains width-safe", () => {
		const out = renderDispatchConfirm({
			workflowName: "fan-out-and-synthesize",
			runId: "be3181c1-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { prompt: "explore the codebase", max_branches: 4 },
			theme: deriveGraphTheme({}),
			width: 60,
		});
		const lines = stripAnsi(out).split("\n");
		assert.match(lines.join("\n"), /be3181c1-aaaa-bbbb-cccc-dddddddddddd/);
		assert.match(lines.join("\n"), /● running/);
		assert.match(lines.join("\n"), /prompt=/);
		assert.match(lines.join("\n"), /▸ \/workflow connect be3181c1-aaaa-bbbb-cccc-dddddddddddd/);
	});

	test("every terminal width preserves the complete connect id and rounded-box edges", () => {
		const runId = "339e05a4-2289-408e-9076-d1a348f582ae";
		for (let width = 20; width <= 120; width += 1) {
			const lines = stripAnsi(
				renderDispatchConfirm({
					workflowName: "publish-release",
					runId,
					inputs: {},
					theme: deriveGraphTheme({}),
					width,
				}),
			).split("\n");
			const expectedWidth = Math.max(32, width);
			for (const [index, line] of lines.entries()) {
				assert.equal(visibleWidth(line), expectedWidth, `width ${width}, row ${index}: ${line}`);
				if (index === 0) assert.match(line, /^╭.*╮$/, `width ${width}: top edge`);
				else if (index === lines.length - 1) assert.match(line, /^╰.*╯$/, `width ${width}: bottom edge`);
				else assert.match(line, /^│.*│$/, `width ${width}, row ${index}: side edges`);
			}

			const hintStart = lines.findIndex((line) => line.includes("/workflow connect"));
			assert.notEqual(hintStart, -1, `width ${width}: connect hint missing`);
			let reassembledId = "";
			for (const boxedLine of lines.slice(hintStart, -1)) {
				let content = boxedLine.slice(1, -1).trim();
				if (content.startsWith("▸ /workflow connect ")) content = content.slice("▸ /workflow connect ".length);
				else if (content.startsWith("see agents")) break;
				const suffixAt = content.indexOf("  see agents");
				if (suffixAt >= 0) content = content.slice(0, suffixAt);
				content = content.trim();
				assert.doesNotMatch(content, /…/, `width ${width}: identifier chunk was ellipsized`);
				reassembledId += content;
				if (suffixAt >= 0) break;
			}
			assert.equal(reassembledId, runId, `width ${width}: connect id changed across wrapped rows`);
		}
	});

	test("zero inputs renders a single identity row + hint, with no body row", () => {
		const out = renderDispatchConfirm({
			workflowName: "primer",
			runId: "5b91ee54-aaaa-bbbb-cccc-dddddddddddd",
			inputs: {},
			theme: deriveGraphTheme({}),
			width: 100,
		});
		const plain = stripAnsi(out);
		assert.match(plain, /5b91ee54-aaaa-bbbb-cccc-dddddddddddd/);
		assert.match(plain, /primer/);
		assert.match(plain, /● running/);
		assert.match(plain, /▸ \/workflow connect 5b91ee54-aaaa-bbbb-cccc-dddddddddddd/);
		// No legacy `(none)` placeholder.
		assert.doesNotMatch(stripAnsi(out), /\(none\)/);
	});

	test("more than 3 inputs collapses tail to +N more", () => {
		const out = renderDispatchConfirm({
			workflowName: "ship-feature",
			runId: "7c4a91bf-eeee-ffff-aaaa-bbbbbbbbbbbb",
			inputs: {
				prompt: "x",
				model: "claude-opus-4",
				max_branches: 12,
				target: "main",
				branch: "feat/x",
				dry_run: false,
			},
			theme: deriveGraphTheme({}),
			width: 160,
		});
		const plain = stripAnsi(out);
		assert.match(plain, /\+3 more/);
	});

	test("string values are quoted; truncation preserves closing quote", () => {
		const longValue =
			"map every TypeScript file in the codebase, focus on stage runner architecture and persistence ports";
		const out = renderDispatchConfirm({
			workflowName: "deep-research",
			runId: "abcd1234-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { prompt: longValue },
			theme: deriveGraphTheme({}),
			width: 80,
		});
		const plain = stripAnsi(out);
		const inputsLine = plain.split("\n").find((l) => l.includes("prompt="))!;
		assert.match(inputsLine, /prompt="[^"]+…?"/, `inputs line: ${inputsLine}`);
	});
});

describe("renderDispatchConfirm — plain", () => {
	test("preserves the rounded shape without ANSI escapes", () => {
		const out = renderDispatchConfirm({
			workflowName: "tournament",
			runId: "abc12345-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { prompt: "hello" },
			width: 140,
		});
		assert.doesNotMatch(out, /\x1b\[/);

		// Plain identity rows carry the full run id, workflow name, and status.
		assert.match(out, /abc12345-aaaa-bbbb-cccc-dddddddddddd/);
		assert.match(out, new RegExp(`${statusIcon("running")} {2}tournament {2}${statusIcon("running")} running`));
		assert.match(out, /● running/);

		// Inputs present (inline on wide terminal).
		assert.match(out, /prompt="hello"/);

		// All workflows explain how to see agents and chat with/steer stages.
		assert.match(out, /▸ \/workflow connect abc12345-aaaa-bbbb-cccc-dddddddddddd\s+see agents working/);
		assert.match(out, /chat with and steer each stage/);
		assert.doesNotMatch(out, /attach|detach/i);
		assert.doesNotMatch(out, /▸ \/workflow status/);
		assert.doesNotMatch(out, /Ask here anytime for status or to steer this run\./);

		// Legacy chrome MUST be gone in plain mode too.
		assert.doesNotMatch(out, /✓ submitted/);
		assert.doesNotMatch(out, /\[ DISPATCHED \]/);
		assert.doesNotMatch(out, /\bstarting…/);
		assert.doesNotMatch(out, /\brun id\b/);
	});

	test("zero inputs in plain mode renders just identity row + hint", () => {
		const out = renderDispatchConfirm({
			workflowName: "primer",
			runId: "5b91ee54-aaaa-bbbb-cccc-dddddddddddd",
			inputs: {},
			width: 100,
		});
		assert.match(out, /5b91ee54-aaaa-bbbb-cccc-dddddddddddd/);
		assert.match(out, new RegExp(`${statusIcon("running")} {2}primer {2}${statusIcon("running")} running`));
		assert.match(out, /▸ \/workflow connect 5b91ee54-aaaa-bbbb-cccc-dddddddddddd/);
	});
});

describe("renderDispatchConfirm — multi-line input values", () => {
	const WIDTH = 120;

	/**
	 * Every rendered row must be exactly the render width. A value carrying a
	 * literal newline used to emit extra physical lines that no border wrapped,
	 * so the box was destroyed from that row down. Multi-line inputs are
	 * ordinary: any `prompt` or `acceptance_criteria` block contains newlines.
	 */
	const assertAllRowsExactWidth = (out: string, width: number) => {
		const offenders = out
			.split("\n")
			.map((line, index) => ({ index, width: visibleWidth(line), line }))
			.filter((row) => row.width !== width);
		assert.deepEqual(
			offenders.map((row) => ({ index: row.index, width: row.width })),
			[],
			`every row must be ${width} cells; got ${JSON.stringify(offenders, null, 2)}`,
		);
	};

	const multiLineInputs = {
		prompt: "<keepContext>\nImplement the thing.\n</keepContext>",
		acceptance_criteria: "<keepContext>\nAll criteria must hold.\n</keepContext>",
		git_worktree_dir: "/Users/example/projects/checkout",
		base_branch: "main",
		create_pr: false,
	};

	test("newline-bearing values never break the box (themed)", () => {
		const out = renderDispatchConfirm({
			workflowName: "ralph",
			runId: "12ffba70-4883-408e-9101-8dc400a1d999",
			inputs: multiLineInputs,
			theme: deriveGraphTheme({}),
			width: WIDTH,
		});
		assertAllRowsExactWidth(out, WIDTH);
		assert.doesNotMatch(stripAnsi(out).split("\n").slice(1, -1).join("\n"), /^[^│]/m);
	});

	test("newline-bearing values never break the box (plain)", () => {
		const out = renderDispatchConfirm({
			workflowName: "ralph",
			runId: "12ffba70-4883-408e-9101-8dc400a1d999",
			inputs: multiLineInputs,
			width: WIDTH,
		});
		assertAllRowsExactWidth(out, WIDTH);
	});

	test("CR, CRLF, and tab are collapsed rather than emitted", () => {
		const out = renderDispatchConfirm({
			workflowName: "primer",
			runId: "7c02aa31-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { note: "alpha\r\nbeta\rgamma\tdelta" },
			width: WIDTH,
		});
		assertAllRowsExactWidth(out, WIDTH);
		const plain = stripAnsi(out);
		assert.doesNotMatch(plain, /\r/);
		assert.doesNotMatch(plain, /\t/);
		// The surviving text stays readable on one row.
		assert.match(plain, /alpha beta gamma delta/);
	});

	test("U+2028/U+2029 survive JSON.stringify and must still be collapsed", () => {
		// JSON.stringify does NOT escape these, so the object projection would
		// otherwise carry a terminal-visible line break into a card row.
		const out = renderDispatchConfirm({
			workflowName: "primer",
			runId: "9a41bb02-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { cfg: { label: "one\u2028two\u2029three" } },
			width: WIDTH,
		});
		assertAllRowsExactWidth(out, WIDTH);
		assert.doesNotMatch(out, /[\u2028\u2029]/);
	});

	test("escape sequences in an input value cannot inject ANSI into the card", () => {
		const out = renderDispatchConfirm({
			workflowName: "primer",
			runId: "3f7c1d90-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { note: "safe\u001b[31mINJECTED\u001b[0m" },
			width: WIDTH,
		});
		assertAllRowsExactWidth(out, WIDTH);
		assert.match(stripAnsi(out), /safe\[31mINJECTED\[0m|safe/);
		assert.doesNotMatch(out, /\u001b\[31m/);
	});

	test("single-line inputs are unchanged by the sanitizer", () => {
		// 140 cells, not WIDTH: at 120 the per-pair value budget truncates
		// "map the codebase" on its own. That is pre-existing truncation
		// policy, and asserting against it here would test the wrong thing —
		// this case exists to prove the sanitizer leaves clean values alone.
		const wideEnough = 140;
		const out = renderDispatchConfirm({
			workflowName: "primer",
			runId: "1d5e7a44-aaaa-bbbb-cccc-dddddddddddd",
			inputs: { prompt: "map the codebase", max_branches: 4 },
			width: wideEnough,
		});
		assertAllRowsExactWidth(out, wideEnough);
		assert.match(stripAnsi(out), /prompt="map the codebase"/);
		assert.match(stripAnsi(out), /max_branches=4/);
	});
});
