import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, compositeTuiLine } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { extractSegments, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";
import { measureStringWork } from "./string-work.ts";

/**
 * Input sizes ten times apart. A bound per unit of input that holds at both leaves no room for work that grows with
 * the square of the input.
 */
const SIZES = [2_000, 20_000] as const;
/**
 * String work per character of one scan over styled text: the escape scan reads each character, the grapheme
 * segmenter yields it, the width checks read each grapheme's first code point, and slices copy what the scan keeps.
 */
const SCAN_WORK_PER_CHARACTER = 8;
/**
 * String work per character of one scan over text made of unterminated escape introducers. Each introducer reads up
 * to 32 characters ahead before it consults the search it remembers (`DIRECT_TERMINATOR_SEARCH` in utils.ts), so with
 * an introducer every other character a scan reads each character about 16 times more than it reads plain text.
 */
const ESCAPE_DENSE_SCAN_WORK_PER_CHARACTER = 48;
/** Scans wrapping makes over its input: it measures the line, splits it into tokens, and measures and breaks each. */
const WRAP_SCANS = 3;
/** Scans compositing makes per character of base and overlay input: it cuts both and measures the composed line. */
const COMPOSITE_SCANS = 2;
/** Line reads per frame: the diff reads every previous and new line, and image placement checks read both again. */
const FRAME_READS_PER_LINE = 8;
/**
 * String work per character of a frame: each line is stripped of prompt markers, checked for fake cursors, cursor
 * markers and images, reset, normalized and, when it changed, written.
 */
const FRAME_WORK_PER_CHARACTER = 16;

let inputSalt = 0;

/**
 * Text of exactly `length` characters made by repeating `pieces` from a position that changes on every call, so
 * `visibleWidth`'s cache of measured strings never answers for a string under measurement.
 */
function textOf(pieces: readonly string[], length: number): string {
	let text = "";
	for (let index = inputSalt++; text.length < length; index++) text += pieces[index % pieces.length];
	return text.slice(0, length);
}

type Input = { name: string; workPerCharacter: number; make: (length: number) => string };

const INPUTS: readonly Input[] = [
	{
		name: "styled prose",
		workPerCharacter: SCAN_WORK_PER_CHARACTER,
		make: (length) =>
			textOf(
				[
					"alpha ",
					"\x1b[1mbold\x1b[22m ",
					"\x1b[31mred\x1b[39m ",
					"\x1b]8;;https://example.com\x07link\x1b]8;;\x07 ",
					"tab\there ",
					"supercalifragilisticexpialidocious-and-longer-than-a-line ",
				],
				length,
			),
	},
	{
		name: "wide and combining graphemes",
		workPerCharacter: SCAN_WORK_PER_CHARACTER,
		make: (length) => textOf(["漢字", "かな ", "😀 ", "e\u0301clair ", "👍🏽", "\u0e01\u0e33 "], length),
	},
	{
		name: "unterminated escape introducers",
		workPerCharacter: ESCAPE_DENSE_SCAN_WORK_PER_CHARACTER,
		make: (length) => textOf(["\x1b[", "\x1b]", "x"], length),
	},
];

/** Runs `measure` on each input at each size and asserts its string work stays within `scans` scans of the input. */
function assertLinear(scans: number, measure: (make: (length: number) => string, length: number) => number): void {
	for (const input of INPUTS) {
		for (const length of SIZES) {
			const work = measure(input.make, length);
			const bound = scans * input.workPerCharacter * length;
			assert.ok(work <= bound, `${input.name}, ${length} characters: ${work} string work, bound ${bound}`);
		}
	}
}

describe("text measurement does work linear in its input", () => {
	it("visibleWidth reads each character a bounded number of times", () => {
		assertLinear(1, (make, length) => {
			const text = make(length);
			return measureStringWork(() => visibleWidth(text)).work;
		});
	});

	it("truncateToWidth reads each character a bounded number of times", () => {
		assertLinear(1, (make, length) => {
			const text = make(length);
			return measureStringWork(() => truncateToWidth(text, length / 4)).work;
		});
	});

	it("wrapTextWithAnsi reads each character a bounded number of times", () => {
		assertLinear(WRAP_SCANS, (make, length) => {
			const text = make(length);
			return measureStringWork(() => wrapTextWithAnsi(text, 40)).work;
		});
	});

	it("sliceByColumn and extractSegments read each character a bounded number of times", () => {
		assertLinear(1, (make, length) => {
			const text = make(length);
			const width = visibleWidth(text);
			return measureStringWork(() => sliceByColumn(text, Math.floor(width / 4), Math.floor(width / 4))).work;
		});
		assertLinear(1, (make, length) => {
			const text = make(length);
			const width = visibleWidth(text);
			const third = Math.floor(width / 3);
			return measureStringWork(() => extractSegments(text, third, 2 * third, width)).work;
		});
	});

	it("compositing an overlay line reads each base and overlay character a bounded number of times", () => {
		assertLinear(COMPOSITE_SCANS, (make, length) => {
			const base = make(length / 2);
			const overlay = make(length / 2);
			const width = visibleWidth(base);
			const third = Math.floor(width / 3);
			return measureStringWork(() => compositeTuiLine(base, overlay, third, third, width)).work;
		});
	});
});

class CountingTerminal implements Terminal {
	readonly kittyProtocolActive = false;
	columns = 80;
	rows = 24;
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(): void {}
}

/** Line reads through every array `countReads` wrapped. */
let lineReads = 0;

/** `lines`, counting every read of one of its elements into `lineReads`. */
function countReads(lines: string[]): string[] {
	return new Proxy(lines, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) lineReads++;
			return Reflect.get(target, property, receiver);
		},
	});
}

/** The main screen's frame lines count their reads from the line diff on, and become the previous frame's lines. */
class CountingMainScreen extends TuiMainScreen {
	protected override applyLineResets(lines: string[]): string[] {
		return countReads(super.applyLineResets(lines));
	}
}

class Transcript implements Component {
	lines: string[];
	private readonly counted: boolean;
	constructor(length: number, counted: boolean) {
		this.lines = Array.from({ length }, (_, index) => `line ${index} \x1b[1mbold\x1b[22m \x1b[33mwarm\x1b[39m`);
		this.counted = counted;
	}
	render(_width: number): string[] {
		return this.counted ? countReads(this.lines) : this.lines;
	}
	invalidate(): void {}
}

function characters(lines: readonly string[]): number {
	return lines.reduce((sum, line) => sum + line.length, 0);
}

describe("a frame does work linear in the transcript", () => {
	it("the main screen's differential render reads each line a bounded number of times per frame", () => {
		for (const length of SIZES) {
			const tui = new CountingMainScreen(new CountingTerminal());
			const transcript = new Transcript(length, false);
			tui.addChild(transcript);
			tui.renderNow();

			for (const change of ["append a line", "replace the last line"]) {
				transcript.lines =
					change === "append a line" ? [...transcript.lines, "appended"] : [...transcript.lines.slice(0, -1), "⠋"];
				lineReads = 0;
				const { work } = measureStringWork(() => tui.renderNow());
				const lines = transcript.lines.length;
				assert.ok(lineReads <= FRAME_READS_PER_LINE * lines, `${change}, ${lines} lines: ${lineReads} line reads`);
				const bound = FRAME_WORK_PER_CHARACTER * characters(transcript.lines);
				assert.ok(work <= bound, `${change}, ${lines} lines: ${work} string work, bound ${bound}`);
			}
		}
	});

	it("the alternate screen reads each transcript line a bounded number of times per frame", () => {
		for (const length of SIZES) {
			const tui = new TuiAltScreen(new CountingTerminal(), false, undefined, { mouse: false });
			const transcript = new Transcript(length, true);
			tui.setLayoutRoot(new ScrollView(transcript, { follow: "end", primary: true }));
			tui.start();
			try {
				tui.renderNow();
				transcript.lines = [...transcript.lines, "appended"];
				lineReads = 0;
				const { work } = measureStringWork(() => tui.renderNow());
				const lines = transcript.lines.length;
				assert.ok(lineReads <= FRAME_READS_PER_LINE * lines, `${lines} lines: ${lineReads} line reads`);
				const bound = FRAME_WORK_PER_CHARACTER * characters(transcript.lines);
				assert.ok(work <= bound, `${lines} lines: ${work} string work, bound ${bound}`);
			} finally {
				tui.stop();
			}
		}
	});
});
