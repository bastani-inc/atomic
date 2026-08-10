import type { ScrollView } from "@earendil-works/pi-tui";
import { expect, test } from "vitest";
import {
	createProductionFullscreenContext,
	getLayoutFrame,
	type LayoutBox,
	type ProductionFullscreenContext,
	type ProductionFullscreenOptions,
} from "./helpers/interactive-fullscreen-layout.ts";

type ScrollLayoutBox = LayoutBox & {
	children: LayoutBox[];
	scrollView: ScrollView;
	scrollContentLines: readonly string[];
};

interface ScrollbarGeometryForTest {
	column: number;
	trackTop: number;
	trackHeight: number;
	thumbTop: number;
	thumbHeight: number;
	maxScrollTop: number;
}

function getTranscriptBox(context: ProductionFullscreenContext): ScrollLayoutBox {
	const box = getLayoutFrame(context.tui).root.children[0];
	if (!box) throw new Error("fullscreen transcript box did not render");
	return box as ScrollLayoutBox;
}

function getScrollbarGeometryForTest(box: ScrollLayoutBox): ScrollbarGeometryForTest {
	const contentHeight = box.children[0]?.rect.height ?? box.scrollContentLines.length;
	const trackHeight = box.rect.height;
	const thumbHeight = Math.max(
		Math.min(2, trackHeight),
		Math.min(trackHeight, Math.round((trackHeight * trackHeight) / contentHeight)),
	);
	const maxScrollTop = Math.max(0, contentHeight - trackHeight);
	const maxThumbTop = trackHeight - thumbHeight;
	const thumbOffset = maxScrollTop === 0 ? 0 : Math.round((box.scrollView.scrollTop / maxScrollTop) * maxThumbTop);
	return {
		column: box.rect.x + box.rect.width - 1,
		trackTop: box.rect.y,
		trackHeight,
		thumbTop: box.rect.y + thumbOffset,
		thumbHeight,
		maxScrollTop,
	};
}

async function withFullscreenContext(
	options: ProductionFullscreenOptions,
	callback: (context: ProductionFullscreenContext) => void | Promise<void>,
): Promise<void> {
	const context = createProductionFullscreenContext(options);
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		context.tui.renderNow();
		await callback(context);
	} finally {
		context.resolveTheme();
		await context.initPromise;
		context.tui.stop();
		context.restoreOffline();
	}
}

for (const { mode, visible } of [
	{ mode: "auto" as const, visible: false },
	{ mode: "always" as const, visible: true },
	{ mode: "hidden" as const, visible: false },
]) {
	test(`fullscreen scrollbar mode ${mode} is rendered`, async () => {
		await withFullscreenContext(
			{ columns: 24, rows: 12, transcriptLines: 80, fullscreenScrollbar: mode },
			(context) => {
				const transcript = context.context.transcriptScrollView;
				if (!transcript) throw new Error("fullscreen transcript did not mount");

				expect(transcript.scrollbar).toBe(mode);
				expect(transcript.isScrollbarVisible).toBe(visible);
				expect(transcript.getContentWidth(24)).toBe(mode === "always" ? 23 : 24);
			},
		);
	});
}

test("always mode reserves the transcript's rightmost column", async () => {
	await withFullscreenContext(
		{ columns: 24, rows: 12, transcriptLines: 80, fullscreenScrollbar: "always" },
		(context) => {
			const box = getTranscriptBox(context);
			expect(box.rect.width).toBe(24);
			expect(box.children[0]?.rect.width).toBe(23);
			expect(box.scrollView.isScrollbarVisible).toBe(true);
		},
	);
});

test("dragging the fullscreen scrollbar thumb updates the transcript viewport", async () => {
	await withFullscreenContext(
		{ columns: 24, rows: 12, transcriptLines: 80, fullscreenScrollbar: "always" },
		(context) => {
			const transcript = context.context.transcriptScrollView;
			if (!transcript) throw new Error("fullscreen transcript did not mount");
			const geometry = getScrollbarGeometryForTest(getTranscriptBox(context));
			const initialScrollTop = transcript.scrollTop;
			expect(initialScrollTop).toBeGreaterThan(0);
			expect(geometry.maxScrollTop).toBe(initialScrollTop);

			const wireColumn = geometry.column + 1;
			const pressWireRow = geometry.thumbTop + geometry.thumbHeight;
			context.terminal.input(`\x1b[<0;${wireColumn};${pressWireRow}M`);
			context.terminal.input(`\x1b[<32;${wireColumn};${geometry.trackTop + 1}M`);
			expect(transcript.scrollTop).toBeLessThan(initialScrollTop);
			expect(transcript.scrollTop).toBe(0);

			context.terminal.input(`\x1b[<0;${wireColumn};${geometry.trackTop + 1}m`);
			expect(transcript.scrollTop).toBe(0);
		},
	);
});
