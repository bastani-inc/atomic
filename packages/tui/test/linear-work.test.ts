import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { SelectList } from "../src/components/select-list.ts";
import { fuzzyFilter, fuzzyMatch } from "../src/fuzzy.ts";
import type { Terminal } from "../src/terminal.ts";
import { type Component, compositeTuiLine } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { extractSegments, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../src/utils.ts";
import { measureStringWork } from "./string-work.ts";

const SIZES = [2_000, 20_000] as const;
const SCAN_WORK_PER_CHARACTER = 8;
const ESCAPE_DENSE_SCAN_WORK_PER_CHARACTER = 48;
const WRAP_SCANS = 3;
const COMPOSITE_SCANS = 2;
const FRAME_READS_PER_LINE = 8;
const FRAME_WORK_PER_CHARACTER = 16;

const REPEATED_QUERY_WORK_PER_CHARACTER = 16;
const FILTER_WORK_PER_CHARACTER_PER_TOKEN = 8;
const SELECT_FILTER_WORK_PER_CHARACTER = 2;

let inputSalt = 0;

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

describe("selector filtering does work linear in its input", () => {
	it("fuzzyMatch scores a query that recurs throughout its text with work linear in the text", () => {
		for (const length of SIZES) {
			const text = "a".repeat(length);
			const query = "a".repeat(length / 10);
			const { value, work } = measureStringWork(() => fuzzyMatch(query, text));
			assert.equal(value.matches, true);
			const bound = REPEATED_QUERY_WORK_PER_CHARACTER * (text.length + query.length);
			assert.ok(work <= bound, `${length} characters: ${work} string work, bound ${bound}`);
		}
	});

	it("fuzzyFilter does work linear in the items' text for each query token", () => {
		const query = "model 7 prev";
		const tokens = query.split(" ").length;
		for (const count of SIZES) {
			const items = Array.from({ length: count }, (_, index) => `provider-${index}/model-${index}-preview`);
			const { value, work } = measureStringWork(() => fuzzyFilter(items, query, (item) => item));
			assert.ok(value.length > 0);
			const bound = FILTER_WORK_PER_CHARACTER_PER_TOKEN * tokens * (characters(items) + query.length);
			assert.ok(work <= bound, `${count} items: ${work} string work, bound ${bound}`);
		}
	});

	it("SelectList filters its items with work linear in their values and the filter", () => {
		const theme = {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
		};
		for (const count of SIZES) {
			const items = Array.from({ length: count }, (_, index) => ({
				value: `command-${index}`,
				label: `command ${index}`,
			}));
			const filter = "Command-".repeat(count / 8);
			const list = new SelectList(items, 5, theme);
			const { work } = measureStringWork(() => list.setFilter(filter));
			const input = characters(items.map((item) => item.value)) + filter.length;
			const bound = SELECT_FILTER_WORK_PER_CHARACTER * input;
			assert.ok(work <= bound, `${count} items: ${work} string work, bound ${bound}`);
		}
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

let lineReads = 0;

function countReads(lines: string[]): string[] {
	return new Proxy(lines, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) lineReads++;
			return Reflect.get(target, property, receiver);
		},
	});
}

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
