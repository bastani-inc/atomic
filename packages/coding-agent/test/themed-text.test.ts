import assert from "node:assert/strict";
import { Markdown } from "@bastani/atomic-tui";
import { afterEach, test, vi } from "vitest";
import { ThemedText } from "../src/modes/interactive/components/themed-text.js";
import { getMarkdownTheme, getThemeByName, initTheme, theme } from "../src/modes/interactive/theme/theme.js";

afterEach(() => {
	vi.unstubAllEnvs();
	initTheme("dark");
});

test("themed notices rebuild their colors after invalidation", () => {
	initTheme("dark");
	const notice = new ThemedText(() => theme.fg("accent", "Notice"));
	const before = notice.render(80);
	initTheme("light");
	notice.invalidate();
	assert.notDeepEqual(notice.render(80), before);
	assert.ok(notice.render(80).join("").includes("Notice"));
});

test("Theme style helpers emit SGR escapes without stdout TTY and honor NO_COLOR/FORCE_COLOR while preserving noTint", () => {
	vi.stubEnv("NO_COLOR", undefined);
	vi.stubEnv("FORCE_COLOR", undefined);
	initTheme("dark");

	assert.equal(theme.bold("word"), "\x1b[1mword\x1b[22m");
	assert.equal(theme.italic("word"), "\x1b[3mword\x1b[23m");
	assert.equal(theme.underline("word"), "\x1b[4mword\x1b[24m");
	assert.equal(theme.dim("word"), "\x1b[2mword\x1b[22m");
	assert.equal(theme.inverse("word"), "\x1b[7mword\x1b[27m");
	assert.equal(theme.strikethrough("word"), "\x1b[9mword\x1b[29m");

	const md = new Markdown("before **bolded** and ~~struck~~ after", 0, 0, getMarkdownTheme()).render(80).join("\n");
	assert.match(md, /\x1b\[1mbolded\x1b\[22m/);
	assert.match(md, /\x1b\[9mstruck\x1b\[29m/);

	vi.stubEnv("NO_COLOR", "1");
	assert.equal(theme.bold("word"), "word");
	assert.equal(theme.italic("word"), "word");
	assert.equal(theme.underline("word"), "word");
	assert.equal(theme.dim("word"), "word");
	assert.equal(theme.inverse("word"), "word");
	assert.equal(theme.strikethrough("word"), "word");

	const mdNoColor = new Markdown("before **bolded** and ~~struck~~ after", 0, 0, getMarkdownTheme())
		.render(80)
		.join("\n");
	assert.doesNotMatch(mdNoColor, /\x1b\[(?:1|9)m/);

	vi.stubEnv("NO_COLOR", undefined);
	vi.stubEnv("FORCE_COLOR", "0");
	assert.equal(theme.bold("word"), "word");

	vi.stubEnv("FORCE_COLOR", "1");
	assert.equal(theme.bold("word"), "\x1b[1mword\x1b[22m");

	vi.stubEnv("FORCE_COLOR", undefined);
	const systemTheme = getThemeByName("system");
	assert.ok(systemTheme);
	assert.match(systemTheme.fg("muted", "x"), /^\x1b\[2m.*\x1b\[22m\x1b\[39m$/);
});
