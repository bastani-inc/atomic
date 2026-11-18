import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { NoticeLine } from "../../packages/coding-agent/src/modes/interactive/components/notice-line.js";
import { initTheme, refreshColorEnvironment } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { StageNotice } from "../../packages/workflows/src/shared/store-types.js";
import { noticeRow, noticeSummary } from "../../packages/workflows/src/tui/stage-chat-view-transcript.js";
import type { NoticeEntry } from "../../packages/workflows/src/tui/stage-chat-view-types.js";

const plain = (rows: readonly string[]) => rows.map((row) => stripVTControlCharacters(row));
const COLOR_SGR = /\x1b\[(?:[\d;]*;)?(?:3\d|4\d|9[0-7]|10[0-7])(?:;[\d;]*)?m/;
const CARD_BORDER = /[╭╮╰╯│─]/;

beforeEach(() => {
	refreshColorEnvironment();
	initTheme("dark");
});
afterEach(() => {
	vi.unstubAllEnvs();
	refreshColorEnvironment();
	initTheme("dark");
});

function entry(notice: Omit<StageNotice, "ts">): NoticeEntry {
	const full: StageNotice = { ts: 1, ...notice };
	return {
		role: "notice",
		noticeId: full.id,
		kind: full.kind,
		value: full.to,
		...(full.from === undefined ? {} : { from: full.from }),
		...(full.meta === undefined ? {} : { meta: full.meta }),
		text: noticeSummary(full),
	};
}

const NOTICES = {
	model: entry({ id: "m", kind: "model", from: "gpt-5.5", to: "gpt-5.5-codex", meta: "fallback" }),
	thinking: entry({ id: "t", kind: "thinking", from: "medium", to: "high" }),
	compaction: entry({ id: "c", kind: "compaction", to: "compacted", meta: "120.4k → 31.2k" }),
	tree: entry({ id: "b", kind: "tree", to: "entry-42" }),
	abort: entry({ id: "a", kind: "abort", to: "interrupted" }),
	mcp: entry({ id: "p", kind: "mcp", to: "github connected" }),
	cleanup: entry({
		id: "q",
		kind: "cleanup",
		to: "quarantined",
		meta: "task-1 process-group:42: Output reader drain was not confirmed; task-1 pipe:3: still open",
	}),
	decision: entry({
		id: "d",
		kind: "decision",
		to: "advanced",
		from: "typesafe/jev-latest",
		meta: "Decision model advanced the stage (p=0.93, addressed p=0.91)",
	}),
	undelivered: entry({ id: "u", kind: "undelivered", to: "check the tests\nand the docs" }),
} as const;

const render = (notice: NoticeEntry, width: number, settings: { expanded?: boolean; outputPad?: number } = {}) =>
	noticeRow(notice, () => settings).render(width);

test("every stage notice is one notice line at the output pad, with no card border", () => {
	for (const [kind, notice] of Object.entries(NOTICES)) {
		const rows = plain(render(notice, 120));
		assert.ok(rows.length >= 1, kind);
		assert.doesNotMatch(rows.join("\n"), CARD_BORDER, `${kind} draws no card border`);
		assert.doesNotMatch(rows.join("\n"), /STAGE |TASK CLEANUP|MESSAGE NOT DELIVERED/, `${kind} has no card title`);
		assert.match(rows[0] ?? "", /^ [●✗◼!⏸›] \S/, `${kind} opens with one shared status glyph at pad 1`);
		for (const row of rows.slice(1)) assert.match(row, /^ {3}(?:⎿ {2}| {3})/, `${kind} details sit under ⎿`);
	}
});

test("each kind reads as the main chat's notices do, with its facts on the header", () => {
	const header = (notice: NoticeEntry) => plain(render(notice, 120))[0]?.trim();
	assert.equal(header(NOTICES.model), '› Model changed to "gpt-5.5-codex" · was gpt-5.5 · fallback');
	assert.equal(header(NOTICES.thinking), '› Thinking level changed to "high" · was medium');
	assert.equal(header(NOTICES.compaction), "● Context compacted · 120.4k → 31.2k");
	assert.equal(header(NOTICES.tree), '› Branch changed to "entry-42"');
	assert.equal(header(NOTICES.abort), "◼ Stage interrupted");
	assert.equal(header(NOTICES.mcp), "› mcp github connected");
	assert.equal(header(NOTICES.cleanup), "! Task finished; its process cleanup is still being confirmed · quarantined");
	assert.equal(
		header(NOTICES.decision),
		"● Decision model advanced the stage (p=0.93, addressed p=0.91) · typesafe/jev-latest",
	);
	assert.equal(header(NOTICES.undelivered), "! Stage finished before this message was delivered");
});

test("readiness outcomes use the shared status glyphs", () => {
	const glyph = (value: string, meta?: string) =>
		plain(
			render(entry({ id: value, kind: "decision", to: value, ...(meta === undefined ? {} : { meta }) }), 120),
		)[0]?.trim()[0];
	assert.deepEqual([glyph("advanced"), glyph("stayed"), glyph("asked")], ["●", "›", "!"]);
	assert.equal(
		plain(render(entry({ id: "x", kind: "decision", to: "asked" }), 120))[0]?.trim(),
		"! Decision model judged the stage's readiness · asked",
	);
});

test("collapsed notices count their hidden lines with the expand key; expanded shows them", () => {
	const collapsedCleanup = plain(render(NOTICES.cleanup, 120));
	assert.equal(collapsedCleanup.length, 2);
	assert.match(collapsedCleanup[1] ?? "", /^ {3}⎿ {2}… \+2 lines/);
	const expandedCleanup = plain(render(NOTICES.cleanup, 120, { expanded: true }));
	assert.deepEqual(
		expandedCleanup.slice(1).map((row) => row.trim().replace(/^⎿\s+/, "")),
		["task-1 process-group:42: Output reader drain was not confirmed", "task-1 pipe:3: still open"],
	);
	const collapsedUndelivered = plain(render(NOTICES.undelivered, 120));
	assert.match(collapsedUndelivered[1] ?? "", /… \+2 lines/);
	const expandedUndelivered = plain(render(NOTICES.undelivered, 120, { expanded: true })).join("\n");
	assert.match(expandedUndelivered, /message check the tests and the docs/);
	assert.match(expandedUndelivered, /Send it to another stage if it still matters\./);
	assert.deepEqual(render(NOTICES.model, 120, { expanded: true }), render(NOTICES.model, 120));
});

test("the output pad moves the notice and changes nothing else", () => {
	for (const notice of Object.values(NOTICES)) {
		const base = plain(render(notice, 100, { outputPad: 0, expanded: true }));
		for (const outputPad of [1, 4]) {
			const rows = plain(render(notice, 100 + outputPad, { outputPad, expanded: true }));
			assert.match(rows[0] ?? "", new RegExp(`^ {${outputPad}}\\S`));
			assert.deepEqual(
				rows.map((row) => row.slice(outputPad)),
				base,
			);
		}
	}
});

test("notices fit 40, 80 and 120 columns and keep their state glyph", () => {
	for (const width of [40, 80, 120]) {
		for (const [kind, notice] of Object.entries(NOTICES)) {
			for (const expanded of [false, true]) {
				const rows = plain(render(notice, width, { expanded }));
				for (const row of rows)
					assert.ok(visibleWidth(row) <= width, `${kind} at ${width}: ${JSON.stringify(row)}`);
				assert.match(rows[0] ?? "", /^ [●✗◼!⏸›] /, `${kind} at ${width}`);
			}
		}
	}
	assert.match(plain(render(NOTICES.decision, 40))[0] ?? "", /Decision model/);
});

test("under NO_COLOR a stage notice is plain and keeps its glyph", () => {
	vi.stubEnv("NO_COLOR", "1");
	refreshColorEnvironment();
	initTheme("dark");
	for (const notice of Object.values(NOTICES)) {
		const rows = render(notice, 80, { expanded: true });
		for (const row of rows) assert.doesNotMatch(row, COLOR_SGR);
		assert.match(rows[0] ?? "", /^ [●✗◼!⏸›] /);
	}
});

test("a stage notice is drawn by the main chat's notice component, styling included", () => {
	const rows = render(NOTICES.cleanup, 90);
	const main = new NoticeLine(
		{
			status: "warning",
			label: "Task",
			outcome: "finished; its process cleanup is still being confirmed",
			meta: ["quarantined"],
			detail: "task-1 process-group:42: Output reader drain was not confirmed\ntask-1 pipe:3: still open",
			countHiddenDetail: true,
		},
		false,
	).render(90);
	assert.deepEqual(rows, main);
});

test("notice text from a stage is rendered inert", () => {
	const EVIL = "a\x1b]52;c;YQ==\x07b\x1b[2Jc\u202ed\u2066e";
	const RAW_UNSAFE = /\x1b\]52|\x1b\[2J|[\u202a-\u202e\u2066-\u2069\u0007]/;
	for (const kind of ["model", "undelivered", "cleanup", "decision"] as const) {
		const rows = render(
			entry({ id: kind, kind, to: `value ${EVIL}`, from: `from ${EVIL}`, meta: `meta ${EVIL}` }),
			120,
			{
				expanded: true,
			},
		);
		assert.doesNotMatch(rows.join("\n"), RAW_UNSAFE, kind);
	}
});
