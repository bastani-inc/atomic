import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";

const saved = { NO_COLOR: process.env.NO_COLOR, FORCE_COLOR: process.env.FORCE_COLOR };

function restore(name: keyof typeof saved): void {
	const value = saved[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function defaultStyles(): { track: string; thumb: string } {
	const view = new ScrollView(new Text("row", 0, 0), { scrollbar: "always" });
	return { track: view.scrollbarTrackStyle("│"), thumb: view.scrollbarThumbStyle("┃") };
}

describe("ScrollView default scrollbar styles", () => {
	afterEach(() => {
		restore("NO_COLOR");
		restore("FORCE_COLOR");
	});

	it("are colored when nothing turns color off", () => {
		delete process.env.NO_COLOR;
		delete process.env.FORCE_COLOR;
		assert.deepEqual(defaultStyles(), { track: "\x1b[90m│\x1b[39m", thumb: "\x1b[37m┃\x1b[39m" });
	});

	it("are plain under NO_COLOR and FORCE_COLOR=0", () => {
		delete process.env.FORCE_COLOR;
		process.env.NO_COLOR = "1";
		assert.deepEqual(defaultStyles(), { track: "│", thumb: "┃" });

		delete process.env.NO_COLOR;
		process.env.FORCE_COLOR = "0";
		assert.deepEqual(defaultStyles(), { track: "│", thumb: "┃" });
	});
});
