import assert from "node:assert/strict";
import { test } from "vitest";
import { ThemedText } from "../src/modes/interactive/components/themed-text.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

test("themed notices rebuild their colors after invalidation", () => {
	initTheme("dark");
	const notice = new ThemedText(() => theme.fg("accent", "Notice"));
	const before = notice.render(80);
	initTheme("light");
	notice.invalidate();
	assert.notDeepEqual(notice.render(80), before);
	assert.ok(notice.render(80).join("").includes("Notice"));
});
