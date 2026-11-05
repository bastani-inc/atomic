/**
 * Render counts for the ask_user_question dialog (#4333).
 *
 * Under background load every repaint the host asks for re-ran the whole dialog, and each frame rendered the
 * option lists several times over to measure heights. These tests count component renders instead of timing them:
 * a keystroke builds one frame in which each component renders at most once, a repaint that follows no change to
 * the dialog builds nothing, and previews and layout are wrapped once per (content, width).
 */
import assert from "node:assert/strict";
import { Markdown } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import { buildItemsForQuestion } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../../packages/coding-agent/src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionParams } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.ts";
import { MultiSelectView } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/multi-select-view.ts";
import { OptionListView } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/option-list-view.ts";
import {
	MAX_CACHED_PREVIEW_WIDTHS,
	MarkdownContentCache,
	NO_PREVIEW_TEXT,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/markdown-content-cache.ts";
import * as layoutDecider from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-layout-decider.ts";
import { TabBar } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/tab-bar.ts";
import { WrappingSelect } from "../../packages/coding-agent/src/core/tools/ask-user-question/view/components/wrapping-select.ts";
import { getMarkdownTheme, initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { benchmarkQuestionnaire, KEY_CYCLE } from "../../scripts/perf/ask-user-question-load/fixture.ts";

vi.mock(
	"../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-layout-decider.ts",
	async (importOriginal) => {
		const original =
			await importOriginal<
				typeof import("../../packages/coding-agent/src/core/tools/ask-user-question/view/components/preview/preview-layout-decider.ts")
			>();
		return { ...original, crossTabLeftWidthWithDonation: vi.fn(original.crossTabLeftWidthWithDonation) };
	},
);

/** Wide enough for the side-by-side preview layout. */
const WIDE = 120;
/** Below `PREVIEW_MIN_WIDTH`, so previews stack under the options. */
const NARROW = 80;

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	vi.restoreAllMocks();
});

interface RenderCounts {
	/** Frames built: the tab bar renders exactly once in every multi-question frame. */
	readonly frames: number;
	readonly optionLists: number;
	readonly optionListInstances: number;
	readonly multiSelects: number;
	readonly markdown: number;
}

function countRenders(): { read(): RenderCounts; reset(): void } {
	const tabBar = vi.spyOn(TabBar.prototype, "render");
	const select = vi.spyOn(WrappingSelect.prototype, "render");
	const multiSelect = vi.spyOn(MultiSelectView.prototype, "render");
	const markdown = vi.spyOn(Markdown.prototype, "render");
	return {
		read: () => ({
			frames: tabBar.mock.calls.length,
			optionLists: select.mock.calls.length,
			optionListInstances: new Set(select.mock.contexts).size,
			multiSelects: multiSelect.mock.calls.length,
			markdown: markdown.mock.calls.length,
		}),
		reset: () => {
			for (const spy of [tabBar, select, multiSelect, markdown]) spy.mockClear();
		},
	};
}

function openDialog(terminal: { columns: number } = { columns: WIDE }): QuestionnaireSession {
	const params = benchmarkQuestionnaire();
	return new QuestionnaireSession({
		tui: { terminal, requestRender() {} },
		theme,
		params,
		itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
		done() {},
	});
}

test("a keystroke builds one frame and renders each component in it at most once (#4333)", () => {
	const session = openDialog();
	session.component.render(WIDE);
	const counts = countRenders();
	for (const [index, key] of KEY_CYCLE.entries()) {
		counts.reset();
		session.component.handleInput(key);
		const painted = session.component.render(WIDE);
		const repainted = session.component.render(WIDE);
		const seen = counts.read();
		assert.equal(seen.frames, 1, `key ${index} built ${seen.frames} frames`);
		assert.equal(
			seen.optionListInstances,
			seen.optionLists,
			`key ${index} rendered an option list twice in one frame`,
		);
		assert.ok(seen.optionLists <= 2, `key ${index} rendered ${seen.optionLists} option lists`);
		assert.ok(seen.multiSelects <= 1, `key ${index} rendered the multi-select list ${seen.multiSelects} times`);
		assert.equal(seen.markdown, 0, `key ${index} re-wrapped ${seen.markdown} previews`);
		assert.equal(repainted, painted, "a repaint with no change returns the frame already built");
	}
});

test("repaints that follow no change to the dialog reuse its frame (#4333)", () => {
	const session = openDialog();
	const first = session.component.render(WIDE);
	const counts = countRenders();
	for (let repaint = 0; repaint < 25; repaint++) assert.equal(session.component.render(WIDE), first);
	assert.deepEqual(counts.read(), { frames: 0, optionLists: 0, optionListInstances: 0, multiSelects: 0, markdown: 0 });
});

test("the frame is rebuilt when the render width or the terminal columns change (#4333)", () => {
	const terminal = { columns: WIDE };
	const session = openDialog(terminal);
	const wide = session.component.render(WIDE);
	const counts = countRenders();

	terminal.columns = NARROW;
	const columnsChanged = session.component.render(WIDE);
	assert.equal(counts.read().frames, 1, "new terminal columns rebuild the frame");
	assert.notDeepEqual(columnsChanged, wide, "the preview layout follows the terminal columns");

	counts.reset();
	const narrow = session.component.render(NARROW);
	assert.equal(counts.read().frames, 1, "a new width rebuilds the frame");
	assert.equal(session.component.render(NARROW), narrow);
	assert.equal(counts.read().frames, 1, "the rebuilt frame is cached for its new size");

	counts.reset();
	terminal.columns = WIDE;
	assert.deepEqual(session.component.render(WIDE), wide, "returning to the first size draws the first frame again");
	assert.equal(counts.read().frames, 1);
});

test("invalidate() drops the cached frame and the wrapped previews (#4333)", () => {
	const session = openDialog();
	const before = session.component.render(WIDE);
	const counts = countRenders();
	session.component.invalidate();
	const after = session.component.render(WIDE);
	const seen = counts.read();
	assert.equal(seen.frames, 1);
	assert.ok(seen.markdown > 0, "previews are wrapped again after an invalidation");
	assert.deepEqual(after, before);
});

test("every frame keeps the dialog's height, on every tab and in every state (#4333)", () => {
	for (const width of [WIDE, NARROW]) {
		const session = openDialog({ columns: width });
		const height = session.component.render(width).length;
		for (const [index, key] of KEY_CYCLE.entries()) {
			session.component.handleInput(key);
			assert.equal(session.component.render(width).length, height, `key ${index} at width ${width}`);
		}
		for (let tab = 0; tab < 4; tab++) {
			session.component.handleInput("\t");
			assert.equal(session.component.render(width).length, height, `tab ${tab + 1} at width ${width}`);
		}
	}
});

test("the dialog's layout is decided once per pane width (#4333)", () => {
	const decide = vi.mocked(layoutDecider.crossTabLeftWidthWithDonation);
	const session = openDialog();
	decide.mockClear();
	session.component.render(WIDE);
	const firstFrame = decide.mock.calls.length;
	assert.ok(firstFrame >= 1, "the first frame decides the layout");
	assert.equal(new Set(decide.mock.calls.map((call) => call[3])).size, firstFrame, "each pane width is decided once");
	for (const key of KEY_CYCLE) {
		session.component.handleInput(key);
		session.component.render(WIDE);
	}
	assert.equal(decide.mock.calls.length, firstFrame, "keystrokes reuse the decided layout");
});

function previewQuestionnaire(): QuestionParams["questions"][number] {
	return {
		question: "Which layout?",
		header: "Layout",
		options: [
			{ label: "Code", description: "a code preview", preview: "```ts\nconst a = 1;\nconst b = 2;\n```" },
			{ label: "Prose", description: "a prose preview", preview: "Some **bold** prose that wraps in a narrow box." },
			{ label: "None", description: "no preview" },
		],
	};
}

test("previews are wrapped once per option and width, and fence lines are dropped (#4333)", () => {
	const cache = new MarkdownContentCache(previewQuestionnaire(), theme, getMarkdownTheme());
	const markdown = vi.spyOn(Markdown.prototype, "render");
	const code = cache.bodyFor(0, 40);
	assert.equal(markdown.mock.calls.length, 1);
	assert.equal(cache.bodyFor(0, 40), code, "a second request at the same width returns the same lines");
	assert.equal(markdown.mock.calls.length, 1);
	assert.equal(
		code.some((line) => line.includes("```")),
		false,
	);
	assert.equal(code.length, 2);
	cache.bodyFor(1, 40);
	assert.equal(markdown.mock.calls.length, 2, "each option is wrapped separately");
	cache.bodyFor(0, 30);
	assert.equal(markdown.mock.calls.length, 3, "a new width is wrapped once");
	cache.bodyFor(0, 40);
	cache.bodyFor(0, 30);
	assert.equal(markdown.mock.calls.length, 3, "both widths stay cached");
});

test("the preview cache keeps the newest widths and drops the oldest (#4333)", () => {
	const cache = new MarkdownContentCache(previewQuestionnaire(), theme, getMarkdownTheme());
	const markdown = vi.spyOn(Markdown.prototype, "render");
	const widths = Array.from({ length: MAX_CACHED_PREVIEW_WIDTHS }, (_, i) => 40 + i);
	for (const width of widths) cache.bodyFor(0, width);
	for (const width of widths) cache.bodyFor(0, width);
	assert.equal(markdown.mock.calls.length, MAX_CACHED_PREVIEW_WIDTHS, "the cache holds its full width budget");

	cache.bodyFor(0, 99);
	markdown.mockClear();
	for (const width of widths.slice(1)) cache.bodyFor(0, width);
	assert.equal(markdown.mock.calls.length, 0, "the newer widths survive an eviction");
	cache.bodyFor(0, widths[0] ?? 40);
	assert.equal(markdown.mock.calls.length, 1, "the oldest width was evicted");
});

test("invalidating the preview cache re-wraps on the next request (#4333)", () => {
	const cache = new MarkdownContentCache(previewQuestionnaire(), theme, getMarkdownTheme());
	const markdown = vi.spyOn(Markdown.prototype, "render");
	const before = cache.bodyFor(1, 40);
	cache.invalidate();
	const after = cache.bodyFor(1, 40);
	assert.equal(markdown.mock.calls.length, 2);
	assert.notEqual(after, before);
	assert.deepEqual(after, before);
});

test("an option without a preview gets a padded placeholder and no markdown render (#4333)", () => {
	const cache = new MarkdownContentCache(previewQuestionnaire(), theme, getMarkdownTheme());
	const markdown = vi.spyOn(Markdown.prototype, "render");
	const [placeholder] = cache.bodyFor(2, 30);
	assert.equal(markdown.mock.calls.length, 0);
	assert.ok(placeholder?.includes(NO_PREVIEW_TEXT));
	assert.ok(placeholder?.endsWith(" ".repeat(30 - NO_PREVIEW_TEXT.length)));
});

test("an option list measures and paints from one layout per props and width (#4333)", () => {
	const items = buildItemsForQuestion(previewQuestionnaire());
	const list = new OptionListView({
		items,
		theme: { selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s },
	});
	list.setProps({ selectedIndex: 0, focused: true, inputBuffer: "", inputCaret: 0 });
	const select = vi.spyOn(WrappingSelect.prototype, "render");
	const height = list.height(40);
	const lines = list.render(40);
	assert.equal(height, lines.length);
	assert.equal(select.mock.calls.length, 1, "measuring then painting renders once");
	assert.equal(list.render(40), lines);

	list.render(30);
	assert.equal(select.mock.calls.length, 2, "a new width lays the list out again");
	list.setProps({ selectedIndex: 1, focused: true, inputBuffer: "", inputCaret: 0 });
	assert.ok(
		list.render(30).some((line) => line.startsWith("❯ 2. Prose")),
		"new props move the pointer",
	);
	list.render(40);
	assert.equal(select.mock.calls.length, 4, "new props lay the list out again, once per width");
	list.invalidate();
	list.render(40);
	assert.equal(select.mock.calls.length, 5, "invalidate() drops the layout");
});

test("a multi-select list is measured once per width (#4333)", () => {
	const question = benchmarkQuestionnaire().questions[2];
	assert.ok(question?.multiSelect);
	const view = new MultiSelectView(theme, question);
	const measure = vi.spyOn(
		MultiSelectView.prototype as unknown as { measureHeight(width: number): number },
		"measureHeight",
	);
	const height = view.naturalHeight(40);
	assert.equal(view.naturalHeight(40), height);
	assert.equal(measure.mock.calls.length, 1);
	assert.ok(view.naturalHeight(200) < height, "a wider list wraps its descriptions onto fewer rows");
	assert.equal(measure.mock.calls.length, 2);
	view.invalidate();
	view.naturalHeight(200);
	assert.equal(measure.mock.calls.length, 3, "invalidate() drops the measurement");
});

test("the dialog footprint covers a multi-select tab taller than every other tab (#4333)", () => {
	const params: QuestionParams = {
		questions: [
			{
				question: "Short single-select?",
				header: "Short",
				options: [
					{ label: "Yes", description: "y" },
					{ label: "No", description: "n" },
				],
			},
			{
				question: "Tall multi-select?",
				header: "Tall",
				multiSelect: true,
				options: Array.from({ length: 4 }, (_, i) => ({
					label: `Choice ${i}`,
					description:
						`Choice ${i} has a long description that wraps across several rows of a narrow dialog. `.repeat(3),
				})),
			},
		],
	};
	const session = new QuestionnaireSession({
		tui: { terminal: { columns: NARROW }, requestRender() {} },
		theme,
		params,
		itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
		done() {},
	});
	const height = session.component.render(NARROW).length;
	for (let tab = 0; tab < 3; tab++) {
		session.component.handleInput("\t");
		assert.equal(session.component.render(NARROW).length, height, `tab ${tab + 1}`);
	}
});
