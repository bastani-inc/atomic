import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { getThemeByName, initTheme, refreshColorEnvironment, theme } from "../src/modes/interactive/theme/theme.js";

const COLOR_SGR = /\x1b\[(?:[0-9;]*;)?(?:3[0-9]|4[0-9]|9[0-7]|10[0-7])(?:;[0-9;]*)?m/;

afterEach(() => {
	vi.unstubAllEnvs();
	initTheme("dark");
});

test("NO_COLOR makes every themed foreground and background plain, whatever the theme", () => {
	vi.stubEnv("FORCE_COLOR", undefined);
	vi.stubEnv("NO_COLOR", "1");
	refreshColorEnvironment();
	for (const name of ["dark", "light", "system"]) {
		const named = getThemeByName(name);
		assert.ok(named, name);
		assert.equal(named.fg("accent", "word"), "word", `${name} fg`);
		assert.equal(named.fg("muted", "word"), "word", `${name} muted fg`);
		assert.equal(named.bg("selectedBg", "word"), "word", `${name} bg`);
		assert.equal(named.bg("toolSuccessBg", "a\x1b[0mb"), "a\x1b[0mb", `${name} bg keeps the text`);
		assert.equal(named.getFgAnsi("accent"), "", `${name} fg sequence`);
		assert.equal(named.getBgAnsi("selectedBg"), "", `${name} bg sequence`);
	}
});

test("a refresh after NO_COLOR changes turns color off and back on, for colors and text styles alike", () => {
	vi.stubEnv("FORCE_COLOR", undefined);
	vi.stubEnv("NO_COLOR", undefined);
	initTheme("dark");
	assert.match(theme.fg("accent", "word"), COLOR_SGR);
	assert.match(theme.bg("selectedBg", "word"), COLOR_SGR);
	assert.equal(theme.bold("word"), "\x1b[1mword\x1b[22m");

	vi.stubEnv("NO_COLOR", "1");
	refreshColorEnvironment();
	assert.equal(theme.fg("accent", "word"), "word");
	assert.equal(theme.bg("selectedBg", "word"), "word");
	assert.equal(theme.getThinkingBorderColor("high")("─"), "─");
	assert.equal(theme.bold("word"), "word");
	assert.equal(theme.getStyleLevel(), 0);

	vi.stubEnv("NO_COLOR", undefined);
	refreshColorEnvironment();
	assert.match(theme.fg("accent", "word"), COLOR_SGR);
	assert.equal(theme.bold("word"), "\x1b[1mword\x1b[22m");
});

test("painting never reads NO_COLOR or FORCE_COLOR: the color environment is read when a theme is loaded", () => {
	vi.stubEnv("NO_COLOR", undefined);
	vi.stubEnv("FORCE_COLOR", undefined);
	initTheme("dark");
	const original = process.env;
	let reads = 0;
	process.env = new Proxy(original, {
		get(target, key, receiver) {
			if (key === "NO_COLOR" || key === "FORCE_COLOR") reads++;
			return Reflect.get(target, key, receiver);
		},
	});
	try {
		for (let index = 0; index < 1_000; index++) {
			theme.fg("accent", "word");
			theme.bg("selectedBg", "word");
			theme.bold("word");
			theme.getFgAnsi("muted");
		}
	} finally {
		process.env = original;
	}
	assert.equal(reads, 0);
});

test("FORCE_COLOR follows the style level: 0 turns colour off, 2 limits it to 256 colours, 3 keeps true colour", () => {
	vi.stubEnv("NO_COLOR", undefined);
	vi.stubEnv("COLORTERM", "truecolor");
	vi.stubEnv("ATOMIC_TRUE_COLOR", "1");
	initTheme("dark");

	vi.stubEnv("FORCE_COLOR", "0");
	refreshColorEnvironment();
	assert.equal(theme.fg("accent", "word"), "word");
	assert.equal(theme.bg("selectedBg", "word"), "word");

	vi.stubEnv("FORCE_COLOR", "2");
	refreshColorEnvironment();
	assert.match(theme.fg("accent", "word"), /^\x1b\[38;5;\d+mword\x1b\[39m$/);
	assert.match(theme.bg("selectedBg", "word"), /^\x1b\[48;5;\d+mword\x1b\[49m$/);

	vi.stubEnv("FORCE_COLOR", "3");
	refreshColorEnvironment();
	assert.match(theme.fg("accent", "word"), /^\x1b\[38;2;\d+;\d+;\d+mword\x1b\[39m$/);

	vi.stubEnv("FORCE_COLOR", undefined);
	refreshColorEnvironment();
	assert.match(theme.fg("accent", "word"), /^\x1b\[38;2;\d+;\d+;\d+mword\x1b\[39m$/);
});

test("NO_COLOR wins over FORCE_COLOR for themed colour", () => {
	vi.stubEnv("NO_COLOR", "1");
	vi.stubEnv("FORCE_COLOR", "3");
	initTheme("dark");
	assert.equal(theme.fg("accent", "word"), "word");
	assert.equal(theme.bg("selectedBg", "word"), "word");
});
