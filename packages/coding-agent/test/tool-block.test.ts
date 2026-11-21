import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, Text, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { NoticeLine } from "../src/modes/interactive/components/notice-line.ts";
import {
	collapseToolBlockLines,
	ToolBlock,
	ToolBlockMarkdown,
	ToolBlockRecords,
} from "../src/modes/interactive/components/tool-block.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const previousKeys = getKeybindings();
beforeEach(() => {
	initTheme("dark", false);
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());

test("tool blocks share one header and connector anatomy without a tinted frame (#5224)", () => {
	const block = new ToolBlock({
		status: "running",
		title: "Bash",
		args: "echo sample",
		meta: ["3s", "timeout 60s"],
		details: new Text("sample\nsecond", 0, 0),
	});
	for (const width of [80, 160]) {
		const rows = block.render(width);
		assert.deepEqual(plain(rows), [" ∀ Bash(echo sample) · 3s · timeout 60s", "   ⎿  sample", "      second"]);
		assert.ok(rows.every((line) => visibleWidth(line) <= width));
		assert.ok(!rows.join("").includes("\u001b[48;"));
	}
});

test("notices share the prose column and the tool block's connector indentation (#5224)", () => {
	const notice = new NoticeLine(
		{
			status: "success",
			label: "Workflow",
			subject: "sample",
			outcome: "completed",
			meta: ["12s"],
			detail: "first\nsecond",
		},
		true,
	);
	assert.deepEqual(plain(notice.render(80)), [' ● Workflow "sample" completed · 12s', "   ⎿  first", "      second"]);
});

test("notice fields render bidirectional controls inert without changing the saved text (#5224)", () => {
	const spec = {
		status: "success",
		label: "Agent",
		subject: "worker\u202eexe\u202c",
		outcome: "finished",
		detail: "result\u2066hidden\u2069",
	} as const;
	const notice = new NoticeLine(spec, true);
	const text = plain(notice.render(80)).join("\n");
	assert.doesNotMatch(text, /[\u202a-\u202e\u2066-\u2069]/u);
	assert.match(text, /<U\+202E>/);
	assert.match(text, /<U\+2066>/);
	assert.equal(spec.subject, "worker\u202eexe\u202c");
});

test("large expanded results keep every row without overflowing a render call (#5224)", () => {
	const count = 150_000;
	const block = new ToolBlock({
		status: "success",
		title: "Sample",
		details: { render: () => Array<string>(count).fill("value"), invalidate() {} },
	});
	const rows = plain(block.render(40));
	assert.equal(rows.length, count + 1);
	assert.equal(rows[1], "   ⎿  value");
	assert.equal(rows.at(-1), "      value");
});

test("tool header arguments shorten before the closing parenthesis and state metadata (#5224)", () => {
	const block = new ToolBlock({ status: "failure", title: "Bash", args: "x".repeat(300), meta: ["exit 2", "12s"] });
	for (const width of [20, 80, 160]) {
		const [row = ""] = plain(block.render(width));
		assert.match(row, /Bash\(x+…\) · exit 2/);
		assert.ok(visibleWidth(row) <= width);
	}
});

test("each independent result record gets a connector and continuation rows do not (#5224)", () => {
	const block = new ToolBlock({
		status: "success",
		title: "Workflow",
		args: "sample",
		details: new ToolBlockRecords([new Text("first\ncontinued", 0, 0), "second"]),
	});
	assert.deepEqual(plain(block.render(80)), [" ● Workflow(sample)", "   ⎿  first", "      continued", "   ⎿  second"]);
});

test("tool states remain distinguishable without color and degrade at narrow widths (#5224)", () => {
	const previous = process.env.NO_COLOR;
	process.env.NO_COLOR = "1";
	try {
		const glyphs = [
			["running", "∀"],
			["success", "●"],
			["failure", "✗"],
			["stopped", "◼"],
			["warning", "!"],
			["paused", "‖"],
			["info", "›"],
			["waiting", "◌"],
			["shell-running", "⧗"],
			["input", "◆"],
			["agent-running", "◯"],
		] as const;
		for (const [status, glyph] of [...glyphs, ["task-stopped", "◯"] as const]) {
			const block = new ToolBlock({ status, title: "Sample", args: "value" });
			assert.equal(plain(block.render(80))[0], ` ${glyph} Sample(value)`);
			for (const width of [0, 1, 2, 8]) assert.ok(block.render(width).every((line) => visibleWidth(line) <= width));
		}
		// Each mark is its own, except the agent panel's pair: a running and a stopped subagent share the open circle,
		// which colour and their words tell apart.
		assert.equal(new Set(glyphs.map(([, glyph]) => glyph)).size, glyphs.length);
	} finally {
		if (previous === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = previous;
	}
});

test("collapse rows preserve exact counts, direction and the bound expand key (#5224)", () => {
	setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
	const lines = ["one", "two", "three", "four"];
	assert.deepEqual(plain(collapseToolBlockLines(lines, 3, false)), [
		"one",
		"two",
		"three",
		"… +1 line (ctrl+e to expand)",
	]);
	assert.deepEqual(plain(collapseToolBlockLines(lines, 2, false, true)), [
		"… +2 earlier lines (ctrl+e to expand)",
		"three",
		"four",
	]);
	assert.deepEqual(collapseToolBlockLines(lines, 1, true), lines);
});

test("shared markdown keeps formatting and literal code while peer links remain inert (#5224)", () => {
	const component = new ToolBlockMarkdown(
		"**bold** and [docs](https://example.test/guide)\n\n```text\n**literal**\n```\n![photo](https://example.test/image.png)\u001b]52;c;c2FtcGxl\u0007",
	);
	const rows = component.render(80);
	const text = plain(rows).join("\n");
	assert.match(text, /bold and/);
	assert.doesNotMatch(text, /\*\*bold\*\*/);
	assert.match(text, /\*\*literal\*\*/);
	assert.match(text, /https:\/\/example\.test\/guide/);
	assert.match(text, /\[image\]/);
	assert.ok(!rows.join("").includes("\u001b]8;"));
	assert.ok(!rows.join("").includes("\u001b]52;"));
});
