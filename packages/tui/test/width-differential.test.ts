import assert from "node:assert";
import { describe, it } from "node:test";
import { truncateToWidth, visibleWidth } from "../src/utils.ts";
import {
	truncateToWidth as referenceTruncateToWidth,
	visibleWidth as referenceVisibleWidth,
} from "./fixtures/width-reference.ts";

/** Random strings compared per seed; each mixes escape sequences, wide and combining text, controls and tabs. */
const STRINGS_PER_SEED = 1_500;
const SEEDS = [1, 7, 42, 5_252];

const PIECES = [
	// Plain text, including the letters that end a CSI sequence
	"a",
	"hello ",
	"m",
	"G",
	"K",
	"H",
	"J",
	" ",
	"\\",
	"[",
	"]",
	"_",
	"\t",
	"\t\t",
	// SGR and other CSI sequences, with and without a recognized final byte
	"\x1b[31m",
	"\x1b[0m",
	"\x1b[1;4m",
	"\x1b[38;2;10;20;30m",
	"\x1b[48;5;240m",
	"\x1b[24m",
	"\x1b[2K",
	"\x1b[1G",
	"\x1b[H",
	"\x1b[2J",
	"\x1b[1A",
	"\x1b[?25l",
	// OSC hyperlinks and titles, terminated by BEL or ST, or not at all
	"\x1b]8;;https://example.com\x07",
	"\x1b]8;;\x07",
	"\x1b]8;id=1;https://example.com/a\x1b\\",
	"\x1b]8;;\x1b\\",
	"\x1b]0;title",
	"\x1b]133;A\x1b\\",
	// APC cursor marker
	"\x1b_pi:c\x07",
	// Bare introducers and terminators
	"\x1b",
	"\x1b[",
	"\x1b]",
	"\x1b_",
	"\x07",
	"\x1b\\",
	// Wide and halfwidth text
	"日本",
	"語",
	"한",
	"ｱ",
	"Ａ",
	"\u3000",
	"\u1100\u1161",
	// Emoji: presentation selectors, modifiers, ZWJ sequences, keycaps, flags
	"🙂",
	"👍🏽",
	"👨‍👩‍👧",
	"🏳️‍🌈",
	"❤️",
	"❤",
	"#️⃣",
	"🇺🇸",
	"🇺",
	"\u200d",
	"\ufe0f",
	"\u{1f3fb}",
	// Combining and spacing marks, Indic and Thai/Lao text
	"e\u0301",
	"\u0301",
	"\u0300\u0300",
	"\u20e3",
	"\u034f",
	"क्ष",
	"कि",
	"\u093e",
	"\u0f7f",
	"\u102b",
	"\u1031",
	"ำ",
	"\u0eb3",
	// Controls, format characters, lone surrogates
	"\x00",
	"\x7f",
	"\x9b",
	"\r",
	"\n",
	"\u00ad",
	"\u200b",
	"\u2060",
	"\u0600",
	"\ud83d",
	"\ude00",
];
const ELLIPSES = ["...", "…", "", "\x1b[2m...\x1b[22m", "🙂", "\t", "ab", "\x1b]8;;https://example.com\x07…"];

/** Deterministic PRNG (mulberry32), so a failure reproduces from its seed. */
function createRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

function randomString(random: () => number): string {
	const pieceCount = Math.floor(random() * 40);
	let text = "";
	for (let i = 0; i < pieceCount; i++) {
		text += PIECES[Math.floor(random() * PIECES.length)];
	}
	return text;
}

describe("width measurement matches the reference implementation", () => {
	for (const seed of SEEDS) {
		it(`visibleWidth and truncateToWidth agree on random escape-laden text (seed ${seed})`, () => {
			const random = createRandom(seed);
			for (let i = 0; i < STRINGS_PER_SEED; i++) {
				const text = randomString(random);
				assert.strictEqual(
					visibleWidth(text),
					referenceVisibleWidth(text),
					`visibleWidth(${JSON.stringify(text)})`,
				);

				const maxWidth = Math.floor(random() * 30) - 1;
				const ellipsis = random() < 0.2 ? undefined : ELLIPSES[Math.floor(random() * ELLIPSES.length)];
				const pad = random() < 0.3;
				const args = JSON.stringify([text, maxWidth, ellipsis, pad]);
				assert.strictEqual(
					truncateToWidth(text, maxWidth, ellipsis, pad),
					referenceTruncateToWidth(text, maxWidth, ellipsis, pad),
					`truncateToWidth(...${args})`,
				);
			}
		});
	}

	it("agrees on text long enough to span many escape sequences", () => {
		const random = createRandom(99);
		for (let i = 0; i < 100; i++) {
			let text = "";
			while (text.length < 2_000) text += randomString(random);
			assert.strictEqual(visibleWidth(text), referenceVisibleWidth(text));
			for (const maxWidth of [1, 3, 40, 120, 4_000]) {
				assert.strictEqual(truncateToWidth(text, maxWidth), referenceTruncateToWidth(text, maxWidth));
				assert.strictEqual(
					truncateToWidth(text, maxWidth, "…", true),
					referenceTruncateToWidth(text, maxWidth, "…", true),
				);
			}
		}
	});
});
