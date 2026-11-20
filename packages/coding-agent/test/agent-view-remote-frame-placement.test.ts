/**
 * A viewed subagent's transcript on the isolated engine's host, painted from a frame the engine drew for another
 * height while the frame for the area's new height is on its way. The frame's layout says where each of its rows goes.
 */
import assert from "node:assert/strict";
import type { TuiMouseEvent } from "@bastani/atomic-tui";
import { describe, test } from "vitest";
import { RemoteAgentTranscript } from "../src/modes/interactive/agent-view/remote-port.ts";
import type { RemoteTranscriptMount } from "../src/modes/interactive-engine/remote-component.ts";
import type { TranscriptFrameLayout } from "../src/modes/interactive-engine/transcript-frame-layout.ts";

const WIDTH = 20;

/** The host's view of an engine transcript whose last frame is `lines`, laid out as `layout` says. */
function transcriptOf(lines: string[], layout?: TranscriptFrameLayout) {
	const clicks: number[] = [];
	const component = {
		render: () => lines,
		paintedLayout: () => layout,
		paintedRowKey: (row: number) => `frame row ${row}`,
		handleMouse: (event: TuiMouseEvent) => {
			clicks.push(event.y);
			return { handled: true };
		},
		handleInput: async () => true,
		invalidate: () => {},
		prime: () => {},
	};
	const mount = { rows: lines.length, component } as unknown as RemoteTranscriptMount;
	return { transcript: new RemoteAgentTranscript(mount, () => false), clicks };
}

function layout(fields: Omit<TranscriptFrameLayout, "width">): TranscriptFrameLayout {
	return { width: WIDTH, ...fields };
}

function click(y: number): TuiMouseEvent {
	return { type: "mouse", action: "press", button: "left", x: 2, y, width: WIDTH, height: 10 } as TuiMouseEvent;
}

describe("a subagent's transcript frame drawn for another height", () => {
	test("keeps the latest rows at the bottom and the form below them when the area grows", () => {
		const { transcript } = transcriptOf(
			["row 6", "row 7", "row 8", "row 9", "form"],
			layout({ bodyRows: 4, firstRow: 6, totalRows: 10, headRows: 0, footRows: 0 }),
		);
		assert.deepEqual(transcript.renderSized(WIDTH, 7), ["", "", "row 6", "row 7", "row 8", "row 9", "form"]);
	});

	test("opens no more rows above than the transcript has", () => {
		const { transcript } = transcriptOf(
			["row 1", "row 2", "row 3", "note"],
			layout({ bodyRows: 3, firstRow: 1, totalRows: 4, headRows: 0, footRows: 0 }),
		);
		assert.deepEqual(transcript.renderSized(WIDTH, 7), ["", "row 1", "row 2", "row 3", "", "", "note"]);
	});

	test("keeps a short transcript at the top and its note at the bottom when the area shrinks", () => {
		const { transcript } = transcriptOf(
			["row 0", "row 1", " ", " ", " ", "note"],
			layout({ bodyRows: 5, firstRow: 0, totalRows: 2, headRows: 0, footRows: 0 }),
		);
		assert.deepEqual(transcript.renderSized(WIDTH, 4), ["row 0", "row 1", " ", "note"]);
	});

	test("keeps a scrolled-up reader's rows, pinned prompt and jump row in place when the area grows", () => {
		const { transcript } = transcriptOf(
			["prompt", "row 3", "row 4", "row 5", "jump"],
			layout({ bodyRows: 5, firstRow: 3, totalRows: 20, headRows: 1, footRows: 1 }),
		);
		assert.deepEqual(transcript.renderSized(WIDTH, 7), ["prompt", "row 3", "row 4", "row 5", "", "", "jump"]);
	});

	test("follows the end once a scrolled-up reader's area grows past it", () => {
		const { transcript } = transcriptOf(
			["row 14", "row 15", "row 16", "jump"],
			layout({ bodyRows: 4, firstRow: 14, totalRows: 19, headRows: 0, footRows: 1 }),
		);
		assert.deepEqual(transcript.renderSized(WIDTH, 6), ["", "row 14", "row 15", "row 16", "", ""]);
	});

	test("cuts a scrolled-up reader's rows at the bottom, above the jump row, when the area shrinks", () => {
		const { transcript } = transcriptOf(
			["prompt", "row 3", "row 4", "row 5", "row 6", "jump", "note"],
			layout({ bodyRows: 6, firstRow: 3, totalRows: 20, headRows: 1, footRows: 1 }),
		);
		assert.deepEqual(transcript.renderSized(WIDTH, 5), ["prompt", "row 3", "row 4", "jump", "note"]);
	});

	test("shows the last rows and blank rows below without a layout, from another width, or where it cannot say", () => {
		const frame = ["row 5", "jump"];
		const tiny = layout({ bodyRows: 2, firstRow: 5, totalRows: 20, headRows: 0, footRows: 1 });
		for (const [lines, frameLayout] of [
			[frame, undefined],
			[frame, { ...tiny, width: WIDTH + 1 }],
			// A two-row frame drew no pinned prompt; the taller frame may draw one.
			[frame, tiny],
		] as const) {
			const { transcript } = transcriptOf([...lines], frameLayout);
			assert.deepEqual(transcript.renderSized(WIDTH, 4), ["row 5", "jump", "", ""]);
		}
		// One row has no room for the jump row: the engine draws the transcript's row there.
		assert.deepEqual(transcriptOf([...frame], tiny).transcript.renderSized(WIDTH, 1), ["row 5"]);
		assert.deepEqual(transcriptOf([...frame]).transcript.renderSized(WIDTH, 1), ["jump"]);
	});

	test("paints a frame drawn for the area's height exactly as the engine sent it", () => {
		const lines = ["row 6", "row 7", "form"];
		const { transcript } = transcriptOf(
			lines,
			layout({ bodyRows: 2, firstRow: 6, totalRows: 8, headRows: 0, footRows: 0 }),
		);
		assert.equal(transcript.renderSized(WIDTH, 3), lines);
	});

	test("sends a click to the frame row painted under it, and none from a row the frame does not have", () => {
		const { transcript, clicks } = transcriptOf(
			["row 6", "row 7", "row 8", "row 9", "form"],
			layout({ bodyRows: 4, firstRow: 6, totalRows: 10, headRows: 0, footRows: 0 }),
		);
		transcript.renderSized(WIDTH, 7);
		assert.equal(transcript.handleMouse(click(0)), undefined);
		assert.equal(transcript.handleMouse(click(1)), undefined);
		assert.deepEqual(transcript.handleMouse(click(2)), { handled: true });
		assert.deepEqual(transcript.handleMouse(click(6)), { handled: true });
		assert.deepEqual(clicks, [0, 4]);
		assert.equal(transcript.paintedRowKey(1), undefined);
		assert.equal(transcript.paintedRowKey(3), "frame row 1");
	});
});
