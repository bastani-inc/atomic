import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, type TUI, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, describe, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { BashExecutionComponent } from "../src/modes/interactive/components/bash-execution.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function createStubTui(columns = 80): TUI {
	return {
		terminal: { columns, rows: 24 },
		requestRender: () => {},
	} as unknown as TUI;
}

function plain(component: BashExecutionComponent, width = 80): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line).trimEnd());
}

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
});

describe("BashExecutionComponent shell block family", () => {
	test("renders ! command echo and connector-aligned output without heavy horizontal rules or trailing blank line", () => {
		const bash = new BashExecutionComponent("echo hello world", createStubTui(), false, 1);
		bash.appendOutput("hello world\n");
		bash.setComplete(0, false);

		const lines = plain(bash, 80);
		assert.ok(
			!lines.some((line) => /^─{10,}$/.test(line.trim())),
			`unexpected horizontal borders:\n${lines.join("\n")}`,
		);
		assert.equal(lines.length, 3, `no phantom blank line:\n${lines.join("\n")}`);
		assert.equal(lines[0], "");
		assert.equal(lines[1], " ! echo hello world");
		assert.equal(lines[2], "   ⎿  hello world");
	});

	test("renders !! prefix for commands excluded from model context", () => {
		const bash = new BashExecutionComponent("env", createStubTui(), true, 1);
		bash.appendOutput("SECRET=1");
		bash.setComplete(0, false);

		const lines = plain(bash, 80);
		assert.equal(lines[1], " !! env");
		assert.equal(lines[2], "   ⎿  SECRET=1");
	});

	test("renders explicit (no output) marker for empty completed output", () => {
		const bash = new BashExecutionComponent("true", createStubTui(), false, 1);
		bash.setComplete(0, false);

		const lines = plain(bash, 80);
		assert.equal(lines[1], " ! true");
		assert.equal(lines[2], "   ⎿  (no output)");
	});

	test("collapses long output to 5 tail lines with expand hint and expands cleanly", () => {
		const bash = new BashExecutionComponent("seq 1 25", createStubTui(), false, 1);
		bash.appendOutput(Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join("\n"));
		bash.setComplete(0, false);

		const collapsed = plain(bash, 80);
		assert.match(collapsed[2] ?? "", /^ {3}⎿ {2}… \+20 earlier lines \(.+ to expand\)$/);
		assert.equal(collapsed[3], "      line 21");
		assert.equal(collapsed[7], "      line 25");
		assert.ok(!collapsed.some((line) => line.includes("line 20")));

		bash.setExpanded(true);
		const expanded = plain(bash, 80);
		assert.equal(expanded[2], "   ⎿  line 1");
		assert.ok(expanded.some((line) => line === "      line 25"));
	});

	test("shows exit code on failure, cancelled state, running working glyph, and fullOutputPath warning", () => {
		const running = new BashExecutionComponent("sleep 10", createStubTui(), false, 1);
		const runningText = plain(running, 80).join("\n");
		assert.match(runningText, / ! sleep 10/);
		assert.match(runningText, / {3}⎿ {2}∀ Running…/);
		running.setComplete(0, true);
		const cancelledText = plain(running, 80).join("\n");
		assert.match(cancelledText, / {3}⎿ {2}\(cancelled\)/);

		const failed = new BashExecutionComponent("sh -c 'echo boom; exit 42'", createStubTui(), false, 1);
		failed.appendOutput("boom");
		failed.setComplete(42, false, { truncated: true } as never, "/tmp/full.log");
		const failedLines = plain(failed, 80);
		assert.equal(failedLines[1], " ! sh -c 'echo boom; exit 42'");
		assert.equal(failedLines[2], "   ⎿  boom");
		assert.equal(failedLines[3], "      exit 42");
		assert.match(failedLines[4] ?? "", /^ {6}Output truncated · full output: \/tmp\/full\.log$/);
	});

	test("respects outputPad 0 vs 1, narrow/wide widths, and dark/light/NO_COLOR parity", () => {
		const prevNoColor = process.env.NO_COLOR;
		try {
			const frames: string[][] = [];
			for (const [themeName, noColor] of [
				["dark", undefined],
				["light", undefined],
				["dark", "1"],
			] as const) {
				if (noColor === undefined) delete process.env.NO_COLOR;
				else process.env.NO_COLOR = noColor;
				initTheme(themeName);
				const bash = new BashExecutionComponent("echo test", createStubTui(), false, 1);
				bash.appendOutput("a".repeat(120));
				bash.setComplete(0, false);
				for (const w of [60, 80, 120, 200]) {
					const rendered = bash.render(w);
					for (const row of rendered) {
						assert.ok(visibleWidth(row) <= w, `width ${w} overflowed: ${visibleWidth(row)}`);
					}
				}
				frames.push(plain(bash, 80));
			}
			assert.deepEqual(frames[1], frames[0]);
			assert.deepEqual(frames[2], frames[0]);
		} finally {
			if (prevNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = prevNoColor;
		}
	});

	test("caches header and output rows across running working-clock ticks on 100k lines", () => {
		const bash = new BashExecutionComponent("seq 1 100000", createStubTui(120), false, 1);
		try {
			const chunk = Array.from({ length: 100_000 }, (_, i) => `line-${i + 1}`).join("\n");
			bash.appendOutput(`${chunk}\n`);
			const first = bash.render(120);
			assert.ok(first.length <= 10, `collapsed running output stays bounded: ${first.length}`);
			const ticks = 100;
			const started = performance.now();
			for (let i = 0; i < ticks; i++) {
				const frame = bash.render(120);
				assert.equal(frame.length, first.length);
			}
			const elapsedMs = performance.now() - started;
			// 100 working-clock ticks without new output must stay O(1) per frame (re-rendering only the indicator line).
			assert.ok(
				elapsedMs < 150,
				`100 running ticks on 100k lines took ${elapsedMs.toFixed(1)} ms (expected < 150 ms)`,
			);
		} finally {
			bash.dispose();
		}
	});

	test("collapses a single 40 KB line by visual rows and expands on toggle", () => {
		const bash = new BashExecutionComponent("python3 -c 'print(\"L\"*40000)'", createStubTui(120), false, 1);
		bash.appendOutput(`${"L".repeat(40_000)}\n`);
		bash.setComplete(0, false);

		const collapsed = plain(bash, 120);
		assert.ok(collapsed.length <= 10, `collapsed 40 KB line must stay bounded, got ${collapsed.length} rows`);
		assert.match(collapsed[2] ?? "", /^ {3}⎿ {2}… \+\d+ earlier lines \(.+ to expand\)$/);
		for (const row of bash.render(120)) {
			assert.ok(visibleWidth(row) <= 120);
		}

		bash.setExpanded(true);
		const expanded = plain(bash, 120);
		assert.ok(expanded.length > 300, `expanded 40 KB line must show all visual rows, got ${expanded.length}`);
		assert.ok(expanded.length > collapsed.length);
	});

	test("preserves clickable APC key-hint markers while stripping SGR colors under NO_COLOR", () => {
		const prevNoColor = process.env.NO_COLOR;
		try {
			process.env.NO_COLOR = "1";
			initTheme("dark");

			const running = new BashExecutionComponent("sleep 10", createStubTui(120), false, 1);
			try {
				const runningRaw = running.render(120).join("\n");
				assert.doesNotMatch(runningRaw, /\x1b\[[0-9;:]*m/, "NO_COLOR must not emit SGR color sequences");
				assert.match(
					runningRaw,
					/\x1b_pi:h:k:/,
					"NO_COLOR must keep clickable APC key-hint markers on cancel hint",
				);
				assert.match(runningRaw, /\x1b_pi:\/h\x07/, "NO_COLOR must keep APC hint closing markers");
			} finally {
				running.dispose();
			}

			const long = new BashExecutionComponent("seq 1 25", createStubTui(120), false, 1);
			long.appendOutput(`${Array.from({ length: 25 }, (_, i) => `row-${i + 1}`).join("\n")}\n`);
			long.setComplete(0, false);
			const collapsedRaw = long.render(120).join("\n");
			assert.doesNotMatch(
				collapsedRaw,
				/\x1b\[[0-9;:]*m/,
				"NO_COLOR must not emit SGR sequences on collapsed output",
			);
			assert.match(
				collapsedRaw,
				/\x1b_pi:\/h\x07ctrl\+o to expand\x1b_pi:\/h\x07/,
				"NO_COLOR must keep APC hint markers on expand hint",
			);
		} finally {
			if (prevNoColor === undefined) delete process.env.NO_COLOR;
			else process.env.NO_COLOR = prevNoColor;
			initTheme("dark");
		}
	});
});
