import {
	type Component,
	CURSOR_MARKER,
	getKeybindings,
	type OverlayHandle,
	type OverlayOptions,
	ScrollView,
	setKeybindings,
	Text,
	type TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { ExtensionUIContext, HostCustomUiStateListener } from "../src/core/extensions/types.ts";
import { OVERLAY_ACTIVE_ROW_MARKER } from "../src/core/extensions/ui-types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	buildItemsForQuestion,
	createAskUserQuestionToolDefinition,
	QUESTIONNAIRE_OVERLAY_OPTIONS,
} from "../src/core/tools/ask-user-question/ask-user-question.ts";
import { QuestionnaireSession } from "../src/core/tools/ask-user-question/state/questionnaire-session.ts";
import type { QuestionnaireResult, QuestionParams } from "../src/core/tools/ask-user-question/tool/types.ts";
import {
	boundOverlayLines,
	MIN_TRANSCRIPT_STRIP_ROWS,
	ReservedBottomOverlay,
	resolveOverlayMaxHeight,
	type TranscriptOverlayIntersection,
	TranscriptOverlayReserve,
	transcriptOverlayIntersection,
} from "../src/modes/interactive/components/reserved-bottom-overlay.ts";
import {
	isFullscreenViewportAction,
	shouldHandleFullscreenViewportInput,
} from "../src/modes/interactive/interactive-mode-base.ts";
import { createFullscreenTui, isMouseWheelInput } from "../src/modes/interactive/interactive-tui.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import {
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineMessage,
} from "../src/modes/interactive-engine/protocol.ts";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
	type TuiRendererLifecycle,
} from "../src/modes/interactive-engine/remote-component.ts";
import {
	createProductionFullscreenContext,
	type ProductionFullscreenContext,
	RecordingTerminal,
} from "./helpers/interactive-fullscreen-layout.ts";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const HOME = "\x1b[H";
const END = "\x1b[F";
const LEFT = "\x1b[D";
const BACKSPACE = "\x7f";
const DOWN = "\x1b[B";
/** SGR wheel reports at row 2, column 10. */
const WHEEL_UP = "\x1b[<64;10;2M";
const WHEEL_DOWN = "\x1b[<65;10;2M";
const LEFT_CLICK = "\x1b[<0;10;2M";
const X10_WHEEL_UP = `\x1b[M${String.fromCharCode(96, 42, 34)}`;
const X10_WHEEL_DOWN = `\x1b[M${String.fromCharCode(97, 42, 34)}`;
/** pi-tui's `PAGE_SCROLL_OVERLAP`: a page moves `viewportHeight` minus this. */
const PAGE_SCROLL_OVERLAP = 4;
const TRANSCRIPT_LINES = 120;

/** SGR/CSI sequences and OSC-8 hyperlink wrappers, both of which wrap composited rows. */
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const initialKeybindings = getKeybindings();

beforeAll(() => {
	initTheme("dark");
});

afterEach(() => {
	setKeybindings(initialKeybindings);
});

/**
 * Transcript line numbers a user could actually read in the last painted frame.
 *
 * `TuiAltScreen.doRender` composites overlays into `previousScreen` **after**
 * building the layout frame, so `getLayoutFrame(tui).lines` still shows rows an
 * overlay covers. `previousScreen` is the only source that sees occlusion, and
 * seeing occlusion is the whole point of issue #2378.
 */
function visibleTranscriptLines(tui: TuiAltScreen): number[] {
	const screen = (Reflect.get(tui, "previousScreen") as string[] | undefined) ?? [];
	const found: number[] = [];
	for (const row of screen) {
		const match = /transcript line (\d+)/.exec(row.replace(ANSI, ""));
		if (match?.[1]) found.push(Number(match[1]));
	}
	return found;
}

/**
 * The option row carrying the active pointer in the last painted frame, or
 * `undefined` when the bound cropped it away. Read from `previousScreen` for the
 * same reason as above: only the composited screen shows what a user can see.
 */
function activeOptionRow(tui: TuiAltScreen): string | undefined {
	const screen = (Reflect.get(tui, "previousScreen") as string[] | undefined) ?? [];
	for (const row of screen) {
		const plain = row.replace(ANSI, "");
		if (plain.includes("❯")) return plain.trim();
	}
	return undefined;
}

/**
 * A preview-heavy single-select question. Previews force the tall side-by-side
 * layout, which is the shape that used to swallow the transcript viewport and
 * then, once the dialog became an overlay, the transcript's last rows.
 */
function makePreviewParams(): QuestionParams {
	const preview = Array.from({ length: 10 }, (_, index) => `preview line ${index + 1}`).join("\n");
	return {
		questions: [
			{
				question: "Which layout do you prefer?",
				header: "Layout",
				options: [
					{ label: "Single column", description: "One item per line.", preview },
					{ label: "Two column grid", description: "Pairs items side by side.", preview },
					{ label: "Sidebar plus content", description: "Fixed left nav.", preview },
					{ label: "Card deck", description: "Boxed cards.", preview },
				],
			},
		],
	};
}

function makeMultiSelectParams(): QuestionParams {
	const options = ["Alpha", "Bravo", "Charlie", "Delta"].map((label) => ({
		label,
		description: `${label} description.`,
	}));
	return {
		questions: [
			{ question: "Which primary items?", header: "Primary", options, multiSelect: true },
			{ question: "Which secondary items?", header: "Secondary", options, multiSelect: true },
		],
	};
}

function makeNoPreviewParams(): QuestionParams {
	return {
		questions: [
			{
				question: "Which item?",
				header: "Item",
				options: ["Alpha", "Bravo", "Charlie", "Delta"].map((label) => ({
					label,
					description: `${label} description.`,
				})),
			},
		],
	};
}

/**
 * The production fullscreen fixture builds the real init tree but skips the
 * constructor, so the class fields `showExtensionCustom` reads are missing.
 * Seed exactly those, plus the editor text accessors it saves and restores.
 */
function seedCustomUiHostState(context: ProductionFullscreenContext["context"]): void {
	Object.assign(context.editor, {
		getText: () => "",
		setText: () => {},
	});
	Object.assign(context, {
		keybindings: new KeybindingsManager(),
		blockingInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set<HostCustomUiStateListener>(),
	});
}

/**
 * Paint until the reserve settles. The overlay is composited after the layout,
 * so the first frame measures its height, the second turns that into reserved
 * rows, and the third re-pins the follow-end scroll position against them.
 */
function settle(tui: TuiAltScreen): void {
	for (let index = 0; index < 4; index += 1) tui.renderNow();
}

async function waitForCondition(condition: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		if (condition()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 5));
	}
}

interface MountedQuestionnaire {
	fixture: ProductionFullscreenContext;
	tui: TuiAltScreen;
	terminal: RecordingTerminal;
	transcript: ScrollView;
	/** Transcript viewport height with no dialog mounted. */
	baselineViewportHeight: number;
	/** Highest reachable transcript line with no dialog mounted. */
	baselineLastVisibleLine: number;
}

/**
 * Mount the real `ask_user_question` dialog through the real host custom-UI
 * path, on top of the real fullscreen layout, and run `body` while it is open.
 */
async function withMountedQuestionnaire(
	options: { columns: number; rows: number },
	body: (mounted: MountedQuestionnaire) => void,
): Promise<void> {
	const fixture = createProductionFullscreenContext({ ...options, transcriptLines: TRANSCRIPT_LINES });
	const { context, tui, terminal } = fixture;
	const controller = new AbortController();
	const tool = createAskUserQuestionToolDefinition();
	let execution: ReturnType<typeof tool.execute> | undefined;

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		settle(tui);
		const transcript = context.transcriptScrollView;
		if (!transcript) throw new Error("fullscreen transcript did not mount");
		transcript.scrollToEnd();
		settle(tui);
		const baselineViewportHeight = transcript.viewportHeight;
		const baselineVisible = visibleTranscriptLines(tui);
		const baselineLastVisibleLine = baselineVisible.at(-1) ?? 0;
		expect(baselineViewportHeight).toBeGreaterThan(MIN_TRANSCRIPT_STRIP_ROWS);
		expect(baselineLastVisibleLine).toBe(TRANSCRIPT_LINES);

		seedCustomUiHostState(context);
		const ui = {
			setWorkingVisible: () => {},
			custom: <T>(
				factory: Parameters<ExtensionUIContext["custom"]>[0],
				customOptions?: Parameters<ExtensionUIContext["custom"]>[1],
			) => context.showExtensionCustom(factory, customOptions) as Promise<T>,
		} as Pick<ExtensionUIContext, "custom" | "setWorkingVisible">;

		execution = tool.execute("ask-2378", makePreviewParams(), controller.signal, () => undefined, {
			hasUI: true,
			ui,
		} as Parameters<typeof tool.execute>[4]);
		execution.catch(() => undefined);

		await new Promise<void>((resolve) => setImmediate(resolve));
		settle(tui);

		body({
			fixture,
			tui,
			terminal,
			transcript,
			baselineViewportHeight,
			baselineLastVisibleLine,
		});
	} finally {
		controller.abort(new Error("test teardown"));
		await execution?.catch(() => undefined);
		fixture.resolveTheme();
		await fixture.initPromise;
		fixture.tui.stop();
		fixture.restoreOffline();
	}
}

interface MountedQuestionnaireSession extends MountedQuestionnaire {
	session: QuestionnaireSession;
}

/** Mount explicit parameters through the real production custom-UI host. */
async function withMountedQuestionnaireSession(
	options: { columns: number; rows: number },
	params: QuestionParams,
	body: (mounted: MountedQuestionnaireSession) => void,
): Promise<void> {
	const fixture = createProductionFullscreenContext({ ...options, transcriptLines: TRANSCRIPT_LINES });
	const { context, tui, terminal } = fixture;
	const controller = new AbortController();
	let mount: Promise<QuestionnaireResult> | undefined;

	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		settle(tui);
		const transcript = context.transcriptScrollView;
		if (!transcript) throw new Error("fullscreen transcript did not mount");
		transcript.scrollToEnd();
		settle(tui);
		const baselineViewportHeight = transcript.viewportHeight;
		const baselineLastVisibleLine = visibleTranscriptLines(tui).at(-1) ?? 0;

		seedCustomUiHostState(context);
		let session: QuestionnaireSession | undefined;
		mount = context.showExtensionCustom<QuestionnaireResult>(
			(mountTui, mountTheme, _keybindings, done) => {
				session = new QuestionnaireSession({
					tui: mountTui,
					theme: mountTheme,
					params,
					itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
					done,
				});
				return session.component;
			},
			{
				signal: controller.signal,
				overlay: true,
				reserveTranscriptRows: true,
				overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
			},
		);
		mount.catch(() => undefined);
		await new Promise<void>((resolve) => setImmediate(resolve));
		settle(tui);
		if (!session) throw new Error("questionnaire session did not mount");

		body({
			fixture,
			tui,
			terminal,
			transcript,
			baselineViewportHeight,
			baselineLastVisibleLine,
			session,
		});
	} finally {
		controller.abort(new Error("test teardown"));
		await mount?.catch(() => undefined);
		fixture.resolveTheme();
		await fixture.initPromise;
		fixture.tui.stop();
		fixture.restoreOffline();
	}
}

class FixedHeightOverlay implements Component {
	constructor(
		private readonly height: number,
		private readonly label: string,
		private readonly activeRow?: number,
	) {}

	render(_width: number): string[] {
		return Array.from({ length: this.height }, (_, index) => {
			const row = `${this.label} ${index + 1}`;
			return index + 1 === this.activeRow ? `${row} ACTIVE${OVERLAY_ACTIVE_ROW_MARKER}` : row;
		});
	}

	handleInput(_data: string): void {}

	invalidate(): void {}
}

interface MountedReserveOverlay {
	handle: OverlayHandle;
	close: () => void;
	result: Promise<void>;
}

async function mountReserveOverlay(
	context: ProductionFullscreenContext["context"],
	height: number,
	label: string,
	signal: AbortSignal,
	overlayOptions?: OverlayOptions,
	activeRow?: number,
): Promise<MountedReserveOverlay> {
	let handle: OverlayHandle | undefined;
	let close: (() => void) | undefined;
	const result = context.showExtensionCustom<void>(
		(_tui, _theme, _keybindings, done) => {
			close = () => done();
			return new FixedHeightOverlay(height, label, activeRow);
		},
		{
			overlay: true,
			reserveTranscriptRows: true,
			signal,
			overlayOptions: { ...QUESTIONNAIRE_OVERLAY_OPTIONS, ...overlayOptions },
			onHandle: (mountedHandle) => {
				handle = mountedHandle;
			},
		},
	);
	result.catch(() => undefined);
	await new Promise<void>((resolve) => setImmediate(resolve));
	if (!handle || !close) throw new Error(`${label} overlay did not mount`);
	return { handle, close, result };
}

const STACKED_OVERLAY_CASES = [
	{ columns: 80, rows: 24, closeFirst: "short" as const },
	{ columns: 80, rows: 24, closeFirst: "tall" as const },
	{ columns: 120, rows: 40, closeFirst: "short" as const },
	{ columns: 120, rows: 40, closeFirst: "tall" as const },
];

const MARGIN_CASES: Array<{ name: string; margin: OverlayOptions["margin"] }> = [
	{ name: "zero object", margin: { bottom: 0 } },
	{ name: "bottom object", margin: { bottom: 2 } },
	{ name: "numeric", margin: 2 },
	{ name: "top and bottom", margin: { top: 5, bottom: 2 } },
	{ name: "floating", margin: { bottom: 10 } },
];

const SUFFIX_UNION_CASES: Array<{
	name: string;
	intersections: TranscriptOverlayIntersection[];
	expectedRows: number;
}> = [
	{ name: "empty", intersections: [], expectedRows: 0 },
	{ name: "bottom suffix", intersections: [{ top: 12, bottom: 18 }], expectedRows: 6 },
	{
		name: "connected intervals",
		intersections: [
			{ top: 10, bottom: 16 },
			{ top: 14, bottom: 18 },
		],
		expectedRows: 8,
	},
	{
		name: "nested intervals",
		intersections: [
			{ top: 12, bottom: 18 },
			{ top: 14, bottom: 17 },
		],
		expectedRows: 6,
	},
	{ name: "floating interval", intersections: [{ top: 6, bottom: 14 }], expectedRows: 0 },
];

interface OverlayGeometry {
	height: number;
	margin?: OverlayOptions["margin"];
	maxHeight?: OverlayOptions["maxHeight"];
}

const MAX_HEIGHT_ACTIVE_CASES: Array<{
	name: string;
	activeRow: number;
	maxHeight: OverlayOptions["maxHeight"];
	margin?: OverlayOptions["margin"];
}> = [
	{ name: "numeric cap with an early active row", activeRow: 2, maxHeight: 4 },
	{ name: "numeric cap with a late active row", activeRow: 9, maxHeight: 4 },
	{ name: "percentage cap with a late active row", activeRow: 9, maxHeight: "25%", margin: { bottom: 2 } },
];

function paintedScreen(tui: TuiAltScreen): string[] {
	return ((Reflect.get(tui, "previousScreen") as string[] | undefined) ?? []).map((line) => line.replace(ANSI, ""));
}

describe("ask_user_question transcript scrolling (#2378)", () => {
	test.each([
		{ maxHeight: 4 as const, rows: 24, margin: 0, expected: 4 },
		{ maxHeight: "25%" as const, rows: 24, margin: 0, expected: 6 },
		{ maxHeight: "25%" as const, rows: 20, margin: 0, expected: 5 },
		{ maxHeight: "100%" as const, rows: 12, margin: { top: 2, bottom: 3 }, expected: 7 },
		{ maxHeight: 0 as const, rows: 24, margin: 0, expected: 1 },
	])("resolves maxHeight $maxHeight against $rows rows", ({ expected, margin, maxHeight, rows }) => {
		expect(resolveOverlayMaxHeight(maxHeight, rows, margin)).toBe(expected);
	});

	test.each([1, 2, 3, 4])("keeps an active row inside a $budget-row overlay budget", (budget) => {
		const lines = Array.from({ length: 12 }, (_, index) => {
			const row = `budget row ${index + 1}`;
			return index === 8 ? `${row} ACTIVE${OVERLAY_ACTIVE_ROW_MARKER}` : row;
		});
		const bounded = boundOverlayLines(lines, budget);
		expect(bounded).toHaveLength(budget);
		expect(bounded.some((line) => line.includes("budget row 9 ACTIVE"))).toBe(true);
		expect(bounded.join("\n")).not.toContain(OVERLAY_ACTIVE_ROW_MARKER);
	});

	test("requests one settling repaint when the measured overlay height changes", () => {
		let terminalRows = 24;
		let heightChanges = 0;
		const overlay = new ReservedBottomOverlay(
			new FixedHeightOverlay(40, "settling", 35),
			() => terminalRows,
			undefined,
			undefined,
			() => false,
			() => {
				heightChanges += 1;
			},
		);

		overlay.render(80);
		expect(heightChanges).toBe(1);
		overlay.render(80);
		expect(heightChanges).toBe(1);
		terminalRows = 20;
		overlay.render(80);
		expect(heightChanges).toBe(2);
		overlay.render(80);
		expect(heightChanges).toBe(2);
	});

	test("bounds a reserving overlay by both vertical margins before composition", () => {
		const overlay = new ReservedBottomOverlay(new FixedHeightOverlay(40, "top margin", 35), () => 24, { top: 20 });

		const lines = overlay.render(80);
		expect(overlay.renderedHeight).toBe(4);
		expect(lines).toHaveLength(4);
		expect(lines.some((line) => line.includes("top margin 35 ACTIVE"))).toBe(true);
	});

	test("settles the transcript reserve automatically after the first overlay paint", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, terminal, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			transcript.scrollToEnd();
			settle(tui);
			seedCustomUiHostState(context);
			const writesBeforeMount = terminal.writes.length;
			overlay = await mountReserveOverlay(context, 18, "automatic mount", controller.signal);

			await waitForCondition(() => terminal.writes.length >= writesBeforeMount + 2);
			expect(terminal.writes.length).toBeGreaterThanOrEqual(writesBeforeMount + 2);
			expect(transcript.scrollTop).toBe(114);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test("settles a height-changing resize without forced follow-up renders", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, terminal, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			transcript.scrollToEnd();
			settle(tui);
			seedCustomUiHostState(context);
			const writesBeforeMount = terminal.writes.length;
			overlay = await mountReserveOverlay(context, 40, "automatic resize", controller.signal, undefined, 35);
			await waitForCondition(() => terminal.writes.length >= writesBeforeMount + 2);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);

			const writesBeforeResize = terminal.writes.length;
			terminal.resize(80, 20);
			await waitForCondition(() => terminal.writes.length >= writesBeforeResize + 2);
			expect(terminal.writes.length).toBe(writesBeforeResize + 2);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
			const writesAfterSettlement = terminal.writes.length;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			expect(terminal.writes.length).toBe(writesAfterSettlement);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});
	test.each(MAX_HEIGHT_ACTIVE_CASES)(
		"applies $name before active-row windowing",
		async ({ activeRow, margin, maxHeight }) => {
			const fixture = createProductionFullscreenContext({
				columns: 80,
				rows: 24,
				transcriptLines: TRANSCRIPT_LINES,
			});
			const { context, tui } = fixture;
			const controller = new AbortController();
			let overlay: MountedReserveOverlay | undefined;

			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				settle(tui);
				const transcript = context.transcriptScrollView;
				if (!transcript) throw new Error("fullscreen transcript did not mount");
				seedCustomUiHostState(context);
				overlay = await mountReserveOverlay(
					context,
					12,
					"capped row",
					controller.signal,
					{ maxHeight, margin },
					activeRow,
				);
				settle(tui);
				transcript.scrollToEnd();
				settle(tui);

				const screen = paintedScreen(tui);
				expect(screen.some((line) => line.includes(`capped row ${activeRow} ACTIVE`))).toBe(true);
				expect(screen.join("\n")).not.toContain(OVERLAY_ACTIVE_ROW_MARKER);
				expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
			} finally {
				controller.abort(new Error("test teardown"));
				await overlay?.result.catch(() => undefined);
				fixture.resolveTheme();
				await fixture.initPromise;
				fixture.tui.stop();
				fixture.restoreOffline();
			}
		},
	);

	test("recomputes a percentage maxHeight on resize without a second pi-tui crop", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, terminal, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;
		let receivedOptions: OverlayOptions | undefined;
		const showOverlay = tui.showOverlay.bind(tui);
		Object.defineProperty(tui, "showOverlay", {
			configurable: true,
			value: (component: Component, options?: OverlayOptions) => {
				receivedOptions = options;
				return showOverlay(component, options);
			},
		});

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			seedCustomUiHostState(context);
			overlay = await mountReserveOverlay(
				context,
				12,
				"resized cap",
				controller.signal,
				{ margin: { bottom: 2 }, maxHeight: "25%" },
				9,
			);
			settle(tui);
			const paintedCappedRows = (): string[] =>
				paintedScreen(tui).filter((line) => line.includes("resized cap") || line.includes("more rows hidden"));
			expect(receivedOptions?.maxHeight).toBeUndefined();
			expect(paintedCappedRows()).toHaveLength(6);
			expect(paintedScreen(tui).some((line) => line.includes("resized cap 9 ACTIVE"))).toBe(true);

			terminal.resize(80, 20);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(paintedCappedRows()).toHaveLength(5);
			expect(paintedScreen(tui).some((line) => line.includes("resized cap 9 ACTIVE"))).toBe(true);
			expect(visibleTranscriptLines(tui).length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			Reflect.deleteProperty(tui, "showOverlay");
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test.each([
		{ name: "missing bottom anchor", options: { anchor: undefined }, error: "requires an explicit bottom anchor" },
		{
			name: "non-bottom anchor",
			options: { anchor: "center" as const },
			error: "requires an explicit bottom anchor",
		},
		{ name: "explicit row", options: { row: 2 }, error: "does not support overlayOptions.row" },
		{ name: "vertical offset", options: { offsetY: -1 }, error: "does not support a nonzero overlayOptions.offsetY" },
	])("rejects $name for reserving overlays", async ({ error, options: invalidOptions }) => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const reachedPiTui = new Error("invalid reserving options reached pi-tui");
		Object.defineProperty(tui, "showOverlay", {
			configurable: true,
			value: () => {
				throw reachedPiTui;
			},
		});

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			seedCustomUiHostState(context);
			const mount = context.showExtensionCustom<void>(() => new FixedHeightOverlay(4, "invalid"), {
				overlay: true,
				reserveTranscriptRows: true,
				overlayOptions: { ...QUESTIONNAIRE_OVERLAY_OPTIONS, ...invalidOptions },
			});
			await expect(mount).rejects.toThrow(error);
			expect(context.transcriptOverlayReserve).toBeUndefined();
		} finally {
			Reflect.deleteProperty(tui, "showOverlay");
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test.each(SUFFIX_UNION_CASES)("reserves the $name covered transcript suffix", ({ intersections, expectedRows }) => {
		const reserve = new TranscriptOverlayReserve(() => 18);
		for (const intersection of intersections) reserve.register(() => intersection);
		expect(reserve.render(80)).toHaveLength(expectedRows);
	});

	test("computes bottom-margin transcript intersections", () => {
		expect(transcriptOverlayIntersection(12, 24, 18, { bottom: 2 })).toEqual({ top: 10, bottom: 18 });
		expect(transcriptOverlayIntersection(12, 24, 18, 2)).toEqual({ top: 10, bottom: 18 });
		expect(transcriptOverlayIntersection(12, 24, 18, { top: 5, bottom: 2 })).toEqual({
			top: 10,
			bottom: 18,
		});
		expect(transcriptOverlayIntersection(12, 24, 18, { bottom: 10 })).toEqual({ top: 2, bottom: 14 });
	});

	test.each(MARGIN_CASES)("keeps the newest line visible with $name margin", async ({ margin }) => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			seedCustomUiHostState(context);
			overlay = await mountReserveOverlay(context, 12, "margin", controller.signal, { margin });
			settle(tui);

			transcript.scrollToEnd();
			settle(tui);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);

			overlay.handle.setHidden(true);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);

			overlay.handle.setHidden(false);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test("keeps a six-row transcript strip when a tall overlay has a bottom margin", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			seedCustomUiHostState(context);
			overlay = await mountReserveOverlay(context, 40, "tall margin", controller.signal, { margin: { bottom: 2 } });
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);

			const visible = visibleTranscriptLines(tui);
			expect(visible.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
			expect(visible.at(-1)).toBe(TRANSCRIPT_LINES);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test.each(STACKED_OVERLAY_CASES)(
		"coordinates capped stacked reserves at $columns x $rows when $closeFirst closes first",
		async ({ columns, rows, closeFirst }) => {
			const fixture = createProductionFullscreenContext({ columns, rows, transcriptLines: TRANSCRIPT_LINES });
			const { context, terminal, tui } = fixture;
			const controller = new AbortController();
			const mounted: MountedReserveOverlay[] = [];

			try {
				await new Promise<void>((resolve) => setImmediate(resolve));
				settle(tui);
				const transcript = context.transcriptScrollView;
				if (!transcript) throw new Error("fullscreen transcript did not mount");
				const baselineChildCount = context.documentContainer.children.length;
				seedCustomUiHostState(context);

				const short = await mountReserveOverlay(context, 12, "numeric cap", controller.signal, { maxHeight: 4 }, 2);
				mounted.push(short);
				settle(tui);
				const tall = await mountReserveOverlay(
					context,
					18,
					"percentage cap",
					controller.signal,
					{ margin: { bottom: 2 }, maxHeight: "25%" },
					9,
				);
				mounted.push(tall);
				settle(tui);

				const coordinatorCount = (): number =>
					context.documentContainer.children.filter((child) => child instanceof TranscriptOverlayReserve).length;
				const reservedBy = ({ height, margin, maxHeight }: OverlayGeometry): number => {
					const bottomMargin = typeof margin === "number" ? Math.max(0, margin) : Math.max(0, margin?.bottom ?? 0);
					const transcriptBudget = Math.max(
						1,
						Math.floor(terminal.rows - bottomMargin - MIN_TRANSCRIPT_STRIP_ROWS),
					);
					const cap = resolveOverlayMaxHeight(maxHeight, terminal.rows, margin);
					const boundedHeight = Math.min(height, transcriptBudget, cap ?? Number.POSITIVE_INFINITY);
					const intersection = transcriptOverlayIntersection(
						boundedHeight,
						terminal.rows,
						transcript.viewportHeight,
						margin,
					);
					return intersection?.bottom === transcript.viewportHeight
						? transcript.viewportHeight - intersection.top
						: 0;
				};
				const assertReserve = (geometries: OverlayGeometry[], expectedCoordinators: number): void => {
					transcript.scrollToEnd();
					settle(tui);
					const reserved = Math.max(0, ...geometries.map(reservedBy));
					expect(transcript.scrollTop).toBe(TRANSCRIPT_LINES - transcript.viewportHeight + reserved);
					expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
					expect(coordinatorCount()).toBe(expectedCoordinators);
					if (geometries.length > 0) {
						expect(visibleTranscriptLines(tui).length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
						expect(paintedScreen(tui).some((line) => line.includes("ACTIVE"))).toBe(true);
					}
				};

				const shortGeometry: OverlayGeometry = { height: 12, maxHeight: 4 };
				const tallGeometry: OverlayGeometry = { height: 18, margin: { bottom: 2 }, maxHeight: "25%" };
				assertReserve([shortGeometry, tallGeometry], 1);
				tall.handle.setHidden(true);
				assertReserve([shortGeometry], 1);
				short.handle.setHidden(true);
				assertReserve([], 1);
				tall.handle.setHidden(false);
				assertReserve([tallGeometry], 1);
				short.handle.setHidden(false);
				assertReserve([shortGeometry, tallGeometry], 1);

				terminal.resize(columns === 80 ? 120 : 80, rows === 24 ? 40 : 24);
				settle(tui);
				assertReserve([shortGeometry, tallGeometry], 1);

				const first = closeFirst === "short" ? short : tall;
				const survivor = closeFirst === "short" ? tall : short;
				const survivorGeometry = closeFirst === "short" ? tallGeometry : shortGeometry;
				first.close();
				await first.result;
				assertReserve([survivorGeometry], 1);

				survivor.close();
				await survivor.result;
				assertReserve([], 0);
				expect(context.documentContainer.children.length).toBe(baselineChildCount);
			} finally {
				controller.abort(new Error("test teardown"));
				await Promise.all(mounted.map(({ result }) => result.catch(() => undefined)));
				fixture.resolveTheme();
				await fixture.initPromise;
				fixture.tui.stop();
				fixture.restoreOffline();
			}
		},
	);

	test("keeps the transcript viewport height, and with it the page step", async () => {
		await withMountedQuestionnaire({ columns: 200, rows: 40 }, ({ tui, terminal, transcript, ...baseline }) => {
			expect(transcript.viewportHeight).toBe(baseline.baselineViewportHeight);

			transcript.scrollToEnd();
			settle(tui);
			const before = transcript.scrollTop;
			terminal.input(PAGE_UP);
			settle(tui);
			expect(before - transcript.scrollTop).toBe(Math.max(1, baseline.baselineViewportHeight - PAGE_SCROLL_OVERLAP));
		});
	});

	test("keeps the newest transcript line readable above the open dialog", async () => {
		await withMountedQuestionnaire({ columns: 200, rows: 40 }, ({ tui, transcript }) => {
			transcript.scrollToEnd();
			settle(tui);

			const visible = visibleTranscriptLines(tui);
			expect(visible.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
			expect(visible.at(-1)).toBe(TRANSCRIPT_LINES);
		});
	});

	test("leaves a readable transcript strip on a short terminal", async () => {
		await withMountedQuestionnaire({ columns: 200, rows: 24 }, ({ tui, transcript }) => {
			transcript.scrollToEnd();
			settle(tui);

			const visible = visibleTranscriptLines(tui);
			expect(visible.length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
			expect(visible.at(-1)).toBe(TRANSCRIPT_LINES);
		});
	});

	test("keeps the top of the scrollback reachable", async () => {
		await withMountedQuestionnaire({ columns: 200, rows: 24 }, ({ tui, transcript }) => {
			transcript.scrollToStart();
			settle(tui);

			expect(transcript.scrollTop).toBe(0);
			expect(visibleTranscriptLines(tui)[0]).toBe(1);
		});
	});

	test("tracks a resize in both directions", async () => {
		await withMountedQuestionnaire({ columns: 200, rows: 40 }, ({ tui, terminal, transcript }) => {
			for (const rows of [24, 40, 24]) {
				terminal.resize(200, rows);
				settle(tui);
				transcript.scrollToEnd();
				settle(tui);

				const visible = visibleTranscriptLines(tui);
				expect(visible.length, `visible strip at ${rows} rows`).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
				expect(visible.at(-1), `newest line at ${rows} rows`).toBe(TRANSCRIPT_LINES);
			}
		});
	});

	/**
	 * A hidden overlay covers nothing, and pi-tui never renders one — its
	 * `compositeOverlays` filters the stack on visibility first. So the wrapper's
	 * recorded height stays frozen at whatever it was when the overlay was last
	 * painted, and a reserve keyed off that height alone keeps padding the
	 * document against a dialog that is not on screen: the scroll end lands in a
	 * block of blank rows and real transcript lines drop off the top.
	 *
	 * `ctx.ui.custom` exposes the handle through `onHandle`, so this drives the
	 * host mount directly rather than through the tool, which passes none.
	 */
	test("reserves nothing while the overlay is hidden, and restores it on show", async () => {
		const fixture = createProductionFullscreenContext({ columns: 200, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const controller = new AbortController();
		let mount: Promise<QuestionnaireResult> | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			transcript.scrollToEnd();
			settle(tui);
			const baselineMaxScrollTop = transcript.scrollTop;
			const baselineVisibleCount = visibleTranscriptLines(tui).length;

			seedCustomUiHostState(context);
			const params = makePreviewParams();
			let handle: OverlayHandle | undefined;
			mount = context.showExtensionCustom<QuestionnaireResult>(
				(mountTui, mountTheme, _keybindings, done) =>
					new QuestionnaireSession({
						tui: mountTui,
						theme: mountTheme,
						params,
						itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
						done,
					}).component,
				{
					signal: controller.signal,
					overlay: true,
					reserveTranscriptRows: true,
					overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
					onHandle: (overlayHandle) => {
						handle = overlayHandle;
					},
				},
			);
			mount.catch(() => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);

			if (!handle) throw new Error("overlay handle was never delivered");
			const mountedMaxScrollTop = transcript.scrollTop;
			expect(mountedMaxScrollTop).toBeGreaterThan(baselineMaxScrollTop);

			handle.setHidden(true);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(transcript.scrollTop).toBe(baselineMaxScrollTop);
			expect(visibleTranscriptLines(tui).length).toBe(baselineVisibleCount);

			handle.setHidden(false);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(transcript.scrollTop).toBe(mountedMaxScrollTop);
			expect(visibleTranscriptLines(tui).length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
		} finally {
			controller.abort(new Error("test teardown"));
			await mount?.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test("releases the shared reserve when OverlayHandle.hide permanently removes the overlay", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			const baselineChildCount = context.documentContainer.children.length;
			seedCustomUiHostState(context);

			overlay = await mountReserveOverlay(context, 18, "permanent", controller.signal);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(context.transcriptOverlayReserve).toBeInstanceOf(TranscriptOverlayReserve);
			expect(context.documentContainer.children.length).toBe(baselineChildCount + 1);

			overlay.handle.hide();
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(context.transcriptOverlayReserve).toBeUndefined();
			expect(context.documentContainer.children.length).toBe(baselineChildCount);
			expect(transcript.scrollTop).toBe(TRANSCRIPT_LINES - transcript.viewportHeight);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test("releases the exact reserve after raw host overlay removal", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const controller = new AbortController();
		let overlay: MountedReserveOverlay | undefined;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			const baselineChildCount = context.documentContainer.children.length;
			seedCustomUiHostState(context);
			overlay = await mountReserveOverlay(context, 18, "raw removal", controller.signal);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(transcript.scrollTop).toBe(114);

			tui.hideOverlay();
			transcript.scrollToEnd();
			tui.renderNow();
			expect(tui.hasOverlay()).toBe(false);
			expect(transcript.scrollTop).toBe(TRANSCRIPT_LINES - transcript.viewportHeight);

			await Promise.resolve();
			expect(context.transcriptOverlayReserve).toBeUndefined();
			expect(context.documentContainer.children.length).toBe(baselineChildCount);
		} finally {
			controller.abort(new Error("test teardown"));
			await overlay?.result.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	test("keeps stacked reserve membership exact across out-of-order and raw removal", async () => {
		const fixture = createProductionFullscreenContext({ columns: 80, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const controller = new AbortController();
		const mounted: MountedReserveOverlay[] = [];

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			const baselineChildCount = context.documentContainer.children.length;
			seedCustomUiHostState(context);
			const lower = await mountReserveOverlay(context, 12, "lower reserve", controller.signal);
			mounted.push(lower);
			const top = await mountReserveOverlay(context, 18, "top reserve", controller.signal);
			mounted.push(top);
			settle(tui);

			lower.handle.hide();
			settle(tui);
			expect(tui.hasOverlay()).toBe(true);
			expect(context.transcriptOverlayReserve).toBeInstanceOf(TranscriptOverlayReserve);
			expect(context.documentContainer.children.length).toBe(baselineChildCount + 1);

			tui.hideOverlay();
			transcript.scrollToEnd();
			tui.renderNow();
			expect(transcript.scrollTop).toBe(TRANSCRIPT_LINES - transcript.viewportHeight);
			await Promise.resolve();
			expect(context.transcriptOverlayReserve).toBeUndefined();
			expect(context.documentContainer.children.length).toBe(baselineChildCount);
		} finally {
			controller.abort(new Error("test teardown"));
			await Promise.all(mounted.map(({ result }) => result.catch(() => undefined)));
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	/**
	 * The other half of pi-tui's visibility predicate: an `OverlayOptions.visible`
	 * callback that goes false on a resize. pi-tui re-evaluates it every frame, so
	 * the reserve has to as well.
	 */
	test("reserves nothing while an OverlayOptions.visible callback is false", async () => {
		const fixture = createProductionFullscreenContext({ columns: 200, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui, terminal } = fixture;
		const controller = new AbortController();
		let mount: Promise<QuestionnaireResult> | undefined;
		const MIN_VISIBLE_ROWS = 20;

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");

			seedCustomUiHostState(context);
			const params = makePreviewParams();
			mount = context.showExtensionCustom<QuestionnaireResult>(
				(mountTui, mountTheme, _keybindings, done) =>
					new QuestionnaireSession({
						tui: mountTui,
						theme: mountTheme,
						params,
						itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
						done,
					}).component,
				{
					signal: controller.signal,
					overlay: true,
					reserveTranscriptRows: true,
					overlayOptions: {
						...QUESTIONNAIRE_OVERLAY_OPTIONS,
						visible: (_columns, rows) => rows >= MIN_VISIBLE_ROWS,
					},
				},
			);
			mount.catch(() => undefined);
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			const shownMaxScrollTop = transcript.scrollTop;

			terminal.resize(200, MIN_VISIBLE_ROWS - 8);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			// No dialog on screen, so the reserve is gone and the scroll end is the
			// plain `contentHeight - viewportHeight` for this geometry.
			expect(transcript.scrollTop).toBe(TRANSCRIPT_LINES - transcript.viewportHeight);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);

			terminal.resize(200, 24);
			settle(tui);
			transcript.scrollToEnd();
			settle(tui);
			expect(transcript.scrollTop).toBe(shownMaxScrollTop);
		} finally {
			controller.abort(new Error("test teardown"));
			await mount?.catch(() => undefined);
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	/**
	 * `closeMountedUi` returns early while `mounted` is false, so a reserve
	 * attached before `showOverlay` succeeds would never be released — the blank
	 * rows would sit at the end of the transcript for the rest of the session.
	 */
	test("leaves no reserved rows behind when the overlay fails to mount", async () => {
		const fixture = createProductionFullscreenContext({ columns: 200, rows: 24, transcriptLines: TRANSCRIPT_LINES });
		const { context, tui } = fixture;
		const failure = new Error("showOverlay failed");

		try {
			await new Promise<void>((resolve) => setImmediate(resolve));
			settle(tui);
			const documentChildrenBefore = context.documentContainer.children.length;

			seedCustomUiHostState(context);
			// Own property shadows the prototype method for this test only.
			Object.defineProperty(tui, "showOverlay", {
				configurable: true,
				value: () => {
					throw failure;
				},
			});

			const params = makePreviewParams();
			const mount = context.showExtensionCustom<QuestionnaireResult>(
				(mountTui, mountTheme, _keybindings, done) =>
					new QuestionnaireSession({
						tui: mountTui,
						theme: mountTheme,
						params,
						itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
						done,
					}).component,
				{ overlay: true, reserveTranscriptRows: true, overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS },
			);
			await expect(mount).rejects.toBe(failure);

			Reflect.deleteProperty(tui, "showOverlay");
			settle(tui);
			expect(context.documentContainer.children.length).toBe(documentChildrenBefore);
			expect(context.transcriptOverlayReserve).toBeUndefined();

			const transcript = context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			transcript.scrollToEnd();
			settle(tui);
			expect(visibleTranscriptLines(tui).at(-1)).toBe(TRANSCRIPT_LINES);
		} finally {
			Reflect.deleteProperty(tui, "showOverlay");
			fixture.resolveTheme();
			await fixture.initPromise;
			fixture.tui.stop();
			fixture.restoreOffline();
		}
	});

	/**
	 * The bound has to drop rows on a short terminal, and it used to drop them
	 * from the bottom of a fixed head — which removed the selected option. At 80
	 * columns the dialog is 35 rows and the active pointer sits at row
	 * `6 + 2 * optionIndex`, so with a head of `terminalRows - 10` the marker
	 * survived only while `terminalRows > 16 + 2 * optionIndex`: option 1 was lost
	 * at 16 rows, option 4 at 22. The dialog still consumed the arrow keys, so it
	 * simply looked frozen.
	 */
	test.each([16, 18, 20, 22, 24, 30])(
		"keeps the selected option visible at 80x%i as the selection moves",
		async (rows) => {
			await withMountedQuestionnaire({ columns: 80, rows }, ({ tui, terminal }) => {
				for (let option = 1; option <= 4; option += 1) {
					const active = activeOptionRow(tui);
					expect(active, `option ${option} at 80x${rows}`).toBeDefined();
					expect(active, `option ${option} at 80x${rows}`).toContain(`${option}.`);
					terminal.input(DOWN);
					settle(tui);
				}
			});
		},
	);

	test.each([16, 20, 22, 24])("keeps every multi-select and submit row visible at 80x%i", async (rows) => {
		await withMountedQuestionnaireSession(
			{ columns: 80, rows },
			makeMultiSelectParams(),
			({ session, terminal, tui }) => {
				const assertActive = (expected: string): void => {
					const raw = session.component.render(80);
					expect(
						raw.filter((line) => line.includes(OVERLAY_ACTIVE_ROW_MARKER)),
						`${expected} marks exactly one row at 80x${rows}`,
					).toHaveLength(1);
					const painted = activeOptionRow(tui);
					expect(painted, `${expected} is painted at 80x${rows}`).toBeDefined();
					expect(painted, `${expected} is painted at 80x${rows}`).toContain(expected);
					expect(visibleTranscriptLines(tui).length).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_STRIP_ROWS);
				};

				for (const expected of ["1. [ ] Alpha", "2. [ ] Bravo", "3. [ ] Charlie", "4. [ ] Delta"]) {
					assertActive(expected);
					terminal.input(DOWN);
					settle(tui);
				}
				assertActive("Next");

				terminal.input("\t");
				settle(tui);
				for (const expected of ["1. [ ] Alpha", "2. [ ] Bravo", "3. [ ] Charlie", "4. [ ] Delta"]) {
					assertActive(expected);
					terminal.input(DOWN);
					settle(tui);
				}
				assertActive("Submit");

				terminal.input("\t");
				settle(tui);
				assertActive("1. Submit answers");
				terminal.input(DOWN);
				settle(tui);
				assertActive("2. Cancel");
			},
		);
	});

	test.each([16, 20, 24])("keeps the focused Notes input visible at 80x%i", async (rows) => {
		await withMountedQuestionnaire({ columns: 80, rows }, ({ tui, terminal }) => {
			terminal.input("n");
			settle(tui);

			const screen = (Reflect.get(tui, "previousScreen") as string[] | undefined) ?? [];
			expect(screen.some((line) => line.replace(ANSI, "").includes("Notes:"))).toBe(true);
			expect(screen.some((line) => line.includes(CURSOR_MARKER))).toBe(false);
		});
	});

	test("keeps every no-preview single-select and sentinel row visible", async () => {
		await withMountedQuestionnaireSession(
			{ columns: 80, rows: 16 },
			makeNoPreviewParams(),
			({ session, terminal, tui }) => {
				for (const expected of ["1. Alpha", "2. Bravo", "3. Charlie", "4. Delta", "5."]) {
					const raw = session.component.render(80);
					expect(raw.filter((line) => line.includes(OVERLAY_ACTIVE_ROW_MARKER))).toHaveLength(1);
					expect(activeOptionRow(tui)).toContain(expected);
					terminal.input(DOWN);
					settle(tui);
				}
				expect(
					session.component.render(80).filter((line) => line.includes(OVERLAY_ACTIVE_ROW_MARKER)),
				).toHaveLength(1);
				expect(activeOptionRow(tui)).toContain("6.");
			},
		);
	});

	/**
	 * The same guarantee stated as arithmetic rather than as a geometry, so a
	 * future change to `OVERLAY_TAIL_KEEP_ROWS`, to `MIN_TRANSCRIPT_STRIP_ROWS`,
	 * or to the dialog's chrome height is caught without re-measuring a terminal.
	 */
	test("bounds a real questionnaire frame without cropping the marked active row", () => {
		setKeybindings(new KeybindingsManager());
		const params = makePreviewParams();
		const session = new QuestionnaireSession({
			tui: { terminal: { columns: 80 }, requestRender: () => {} },
			theme,
			params,
			itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
			done: (_result: QuestionnaireResult) => {},
		});

		for (let option = 1; option <= 4; option += 1) {
			const frame = session.component.render(80);
			const markedRow = frame.findIndex((line) => line.includes(OVERLAY_ACTIVE_ROW_MARKER));
			expect(markedRow, `option ${option} marks a row`).toBeGreaterThanOrEqual(0);

			for (const rows of [16, 18, 20, 22, 24, 30]) {
				const bounded = boundOverlayLines(frame, rows - MIN_TRANSCRIPT_STRIP_ROWS);
				expect(bounded.length, `height at 80x${rows}`).toBeLessThanOrEqual(rows - MIN_TRANSCRIPT_STRIP_ROWS);
				const pointer = bounded.filter((line) => line.replace(ANSI, "").includes("❯"));
				expect(pointer, `option ${option} survives 80x${rows}`).toHaveLength(1);

				expect(pointer[0], `option ${option} survives 80x${rows}`).toContain(`${option}.`);
				// The mark itself is never painted.
				expect(bounded.some((line) => line.includes(OVERLAY_ACTIVE_ROW_MARKER))).toBe(false);
			}

			session.component.handleInput?.(DOWN);
		}
	});

	test("classifies configured fullscreen viewport actions", () => {
		const defaults = new KeybindingsManager();
		expect(isFullscreenViewportAction(PAGE_UP, defaults)).toBe(true);
		expect(isFullscreenViewportAction(DOWN, defaults)).toBe(false);

		const remapped = new KeybindingsManager({ "tui.altScreen.top": "ctrl+g" });
		expect(isFullscreenViewportAction("\x07", remapped)).toBe(true);
		expect(isFullscreenViewportAction(HOME, remapped)).toBe(false);
	});

	test.each([
		{ name: "SGR wheel up", data: WHEEL_UP, expected: true },
		{ name: "SGR wheel down", data: WHEEL_DOWN, expected: true },
		{ name: "X10 wheel up", data: X10_WHEEL_UP, expected: true },
		{ name: "X10 wheel down", data: X10_WHEEL_DOWN, expected: true },
		{ name: "coalesced wheels", data: `${WHEEL_UP}${WHEEL_DOWN}`, expected: true },
		{ name: "left click", data: LEFT_CLICK, expected: false },
		{ name: "motion", data: "\x1b[<32;10;2M", expected: false },
		{ name: "release", data: "\x1b[<0;10;2m", expected: false },
		{ name: "mixed click and wheel", data: `${LEFT_CLICK}${WHEEL_UP}`, expected: false },
	])("classifies $name mouse input", ({ data, expected }) => {
		expect(isMouseWheelInput(data)).toBe(expected);
	});

	test("reserving wrapper releases only transcript input to the viewport", () => {
		const received: string[] = [];
		const inner = {
			render: (_width: number) => ["inner"],
			invalidate: () => {},
			handleInput: (data: string) => {
				received.push(data);
				return true;
			},
		};
		const keybindings = new KeybindingsManager();
		const wrapper = new ReservedBottomOverlay(
			inner,
			() => 24,
			undefined,
			undefined,
			(data) => isFullscreenViewportAction(data, keybindings) || isMouseWheelInput(data),
		);

		for (const data of [PAGE_UP, PAGE_DOWN, HOME, END, WHEEL_UP, WHEEL_DOWN]) {
			expect(wrapper.handleInput(data)).toBe(false);
		}
		expect(received).toEqual([]);

		const owned = ["draft", DOWN, LEFT, "\r", "\t", " ", "\x1b", LEFT_CLICK];
		for (const data of owned) expect(wrapper.handleInput(data)).toBe(true);
		expect(received).toEqual(owned);
	});

	test("routes page and wheel input to the transcript while the dialog keeps its selection keys", () => {
		setKeybindings(new KeybindingsManager());
		const keybindings = new KeybindingsManager();
		const terminal = new RecordingTerminal();
		terminal.columns = 120;
		terminal.rows = 40;

		const editor: Text = new Text("editor", 0, 0);
		let tui!: TuiAltScreen;
		const shouldHandleViewportInput = (data: string, isMouseInput: boolean, focusedIsOverlay: boolean): boolean =>
			shouldHandleFullscreenViewportInput(
				tui.getFocusedComponent(),
				editor,
				data,
				isMouseInput,
				focusedIsOverlay,
				keybindings,
			);
		tui = createFullscreenTui({
			showHardwareCursor: false,
			logDirectory: "/tmp",
			terminal,
			shouldHandleViewportInput,
		});

		const transcript = new ScrollView(
			new Text(
				Array.from({ length: TRANSCRIPT_LINES }, (_, index) => `transcript line ${index + 1}`).join("\n"),
				0,
				0,
			),
			{ follow: "end", primary: true },
		);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		tui.renderNow();

		try {
			const baselineViewportHeight = transcript.viewportHeight;
			const baselineMaxScrollTop = transcript.scrollTop;

			const params = makePreviewParams();
			const session = new QuestionnaireSession({
				tui,
				theme,
				params,
				itemsByTab: params.questions.map((question) => buildItemsForQuestion(question)),
				done: (_result: QuestionnaireResult) => {},
			});
			const bounded = new ReservedBottomOverlay(
				session.component,
				() => terminal.rows,
				undefined,
				undefined,
				(data) => isFullscreenViewportAction(data, keybindings) || isMouseWheelInput(data),
			);
			tui.showOverlay(bounded, QUESTIONNAIRE_OVERLAY_OPTIONS);
			tui.renderNow();

			expect(tui.hasOverlay()).toBe(true);
			expect(transcript.viewportHeight).toBe(baselineViewportHeight);
			expect(transcript.scrollTop).toBe(baselineMaxScrollTop);

			const cleanFrame = (): string[] =>
				session.component
					.render(terminal.columns)
					.map((line) => line.replace(ANSI, "").replace("\x1b_pi:c\x07", ""));
			const expectDraft = (draft: string): void => {
				expect(cleanFrame().join("\n")).toContain(draft);
			};
			const notesHeaderVisible = (): boolean => cleanFrame().some((line) => line.trim() === "Notes:");

			terminal.input("n");
			terminal.input("draft");
			tui.renderNow();
			expect(notesHeaderVisible()).toBe(true);
			expectDraft("draft");

			const notesScrollTop = transcript.scrollTop;
			terminal.input(PAGE_UP);
			tui.renderNow();
			expect(notesScrollTop - transcript.scrollTop).toBe(Math.max(1, baselineViewportHeight - PAGE_SCROLL_OVERLAP));
			expectDraft("draft");

			const afterPageUp = transcript.scrollTop;
			terminal.input(WHEEL_UP);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(afterPageUp - 1);
			expectDraft("draft");
			terminal.input(WHEEL_DOWN);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(afterPageUp);
			expectDraft("draft");

			terminal.input(PAGE_DOWN);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(baselineMaxScrollTop);
			expectDraft("draft");
			terminal.input(HOME);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(0);
			expectDraft("draft");
			terminal.input(END);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(baselineMaxScrollTop);
			expectDraft("draft");

			terminal.input(LEFT);
			terminal.input(BACKSPACE);
			tui.renderNow();
			expectDraft("drat");
			const beforeClick = transcript.scrollTop;
			terminal.input(LEFT_CLICK);
			tui.renderNow();
			expect(transcript.scrollTop).toBe(beforeClick);
			expectDraft("drat");

			terminal.input("\r");
			tui.renderNow();
			expect(notesHeaderVisible()).toBe(false);
			const beforeSelection = cleanFrame().join("\n");
			const beforeSelectionScroll = transcript.scrollTop;
			terminal.input(DOWN);
			tui.renderNow();
			expect(cleanFrame().join("\n")).not.toBe(beforeSelection);
			expect(transcript.scrollTop).toBe(beforeSelectionScroll);
		} finally {
			tui.stop();
		}
	});
});

/**
 * The questionnaire runs in the isolated engine child by default, so the mount
 * option only reaches the host if it survives the wire. The child's message is
 * serialized and re-parsed here rather than handed to the controller directly:
 * the parser rebuilds `engine_custom_open` field by field, so a field it does
 * not name is silently dropped and the host mounts an unbounded overlay. That
 * is exactly what happened in a live 200x24 CLI run — the dialog covered every
 * transcript row — while the in-process host test stayed green.
 */
test("carries reserveTranscriptRows across the isolated-engine protocol", () => {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener) => {
			listeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (_command) => {},
	};

	let mountOptions: Parameters<ExtensionUIContext["custom"]>[1];
	const ui: RemoteComponentUI = {
		requestRender: () => {},
		setWidget: () => {},
		custom: <T>(_factory, options): Promise<T> => {
			mountOptions = options;
			return new Promise<T>(() => {});
		},
	};
	const lifecycle: TuiRendererLifecycle = { isFullscreen: () => true, onRendererReplaced: () => () => {} };
	new RemoteComponentController(runtime, ui, lifecycle);

	const sent: InteractiveEngineMessage = {
		type: "engine_custom_open",
		componentId: "remote_component_1",
		overlay: true,
		reserveTranscriptRows: true,
		overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
	};
	const received = parseInteractiveEngineMessage(serializeInteractiveEngineMessage(sent));
	expect(received).toBeDefined();
	expect(received).toMatchObject({ type: "engine_custom_open", reserveTranscriptRows: true });
	if (!received) throw new Error("engine_custom_open did not survive the protocol round trip");
	for (const listener of [...listeners]) listener(received);

	expect(mountOptions).toMatchObject({ overlay: true, reserveTranscriptRows: true });
});
