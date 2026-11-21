import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import {
	NoticeLine,
	type NoticeLineSpec,
	noticeLineText,
} from "../../packages/coding-agent/src/modes/interactive/components/notice-line.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

beforeAll(() => initTheme("dark"));

const plain = (lines: readonly string[]) => lines.map((line) => stripVTControlCharacters(line));

const command: NoticeLineSpec = {
	status: "success",
	label: "Background command",
	subject: "Print six ticks spaced 30 seconds apart",
	outcome: "completed (exit code 0)",
	meta: ["3m 2s"],
	detail: "tick 1\ntick 2\ntick 3",
};

test("a notice collapses to exactly one line, at 80 and at 160 columns", () => {
	assert.deepEqual(plain(new NoticeLine(command).render(160)), [
		' ● Background command "Print six ticks spaced 30 seconds apart" completed (exit code 0) · 3m 2s',
	]);
	assert.deepEqual(plain(new NoticeLine(command).render(80)), [
		' ● Background command "Print six ticks spaced …" completed (exit code 0) · 3m 2s',
	]);
	assert.equal(visibleWidth(plain(new NoticeLine(command).render(80))[0]!), 80);
});

test("each status has its own marker and colour, the agent panel's for a task's states (#6122)", () => {
	const markers = (["success", "failure", "stopped", "warning", "paused", "running"] as const).map((status) => {
		const spec = { status, label: "Task", subject: "x", outcome: "ended" };
		const [line] = new NoticeLine(spec).render(80);
		return { glyph: stripVTControlCharacters(line!).slice(1, 2), line: line!, text: noticeLineText(spec) };
	});
	assert.deepEqual(
		markers.map((marker) => marker.glyph),
		["●", "✗", "◯", "!", "‖", "◯"],
	);
	assert.ok(markers[0]!.line.startsWith(` ${theme.fg("success", "●")}`));
	assert.ok(markers[1]!.line.startsWith(` ${theme.fg("error", "✗")}`));
	assert.ok(markers[2]!.line.startsWith(` ${theme.fg("error", "◯")}`), "a stopped task: the panel's red circle");
	assert.ok(markers[3]!.line.startsWith(` ${theme.fg("warning", "!")}`));
	assert.ok(markers[4]!.line.startsWith(` ${theme.fg("warning", "‖")}`));
	assert.ok(markers[5]!.line.startsWith(` ${theme.fg("muted", "◯")}`), "a running task: still, not the working ∀");
	assert.deepEqual(
		markers.map((marker) => marker.text.slice(0, 1)),
		["●", "✗", "◯", "!", "‖", "◯"],
		"the plain text reads the same marks",
	);
});

test("a narrow line shortens the quoted subject first and keeps how it ended", () => {
	const [line] = plain(new NoticeLine(command).render(60));
	assert.equal(line, ' ● Background command "Pri…" completed (exit code 0) · 3m 2s');
	assert.equal(visibleWidth(line!), 60);
	for (const width of [1, 5, 20, 40]) {
		const rendered = plain(new NoticeLine(command).render(width));
		assert.equal(rendered.length, 1);
		assert.ok(visibleWidth(rendered[0]!) <= width, `fits ${width} columns`);
	}
});

test("expanding shows the detail under the line, and collapsing hides it again", () => {
	const notice = new NoticeLine(command);
	notice.setExpanded(true);
	assert.deepEqual(plain(notice.render(80)).slice(1), ["   ⎿  tick 1", "      tick 2", "      tick 3"]);
	notice.setExpanded(false);
	assert.equal(notice.render(80).length, 1);
	assert.equal(new NoticeLine({ ...command, detail: undefined }, true).render(80).length, 1);
});

test("terminal controls and line breaks in what a task reports cannot break the line", () => {
	const spec: NoticeLineSpec = {
		status: "failure",
		label: "Background command",
		subject: "evil\u001b[2J\nsecond line",
		outcome: "failed (exit code 1)",
		detail: "out\u001b[31mred\u0007",
	};
	assert.equal(noticeLineText(spec), '✗ Background command "evil second line" failed (exit code 1)');
	const notice = new NoticeLine(spec, true);
	const lines = notice.render(80);
	assert.equal(lines.length, 2);
	for (const line of lines) assert.doesNotMatch(stripVTControlCharacters(line), /[\u0000-\u001f]/);
	assert.match(stripVTControlCharacters(lines[1]!), /^ {3}⎿ {2}out/);
});
