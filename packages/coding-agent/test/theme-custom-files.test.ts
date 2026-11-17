import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { getAvailableThemes, initTheme, refreshCustomThemes, setTheme } from "../src/modes/interactive/theme/theme.ts";

let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "theme-custom-files-"));
	mkdirSync(join(agentDir, "themes"));
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(agentDir, { recursive: true, force: true });
});

function writeCustomTheme(name: string): void {
	const dark = JSON.parse(readFileSync(join(getThemesDir(), "dark.json"), "utf-8")) as { name: string };
	writeFileSync(join(agentDir, "themes", `${name}.json`), JSON.stringify({ ...dark, name }));
}

test("a custom theme file added while running is listed and selectable once the directory is read again", async () => {
	initTheme("dark");
	writeCustomTheme("added-later");

	await refreshCustomThemes();

	assert.ok(getAvailableThemes().includes("added-later"));
	assert.deepEqual(setTheme("added-later"), { success: true });
});

test("selecting a custom theme reads it from memory, not from the disk", () => {
	writeCustomTheme("read-at-startup");
	initTheme("dark");
	// The file is gone, but the theme was read before the first frame.
	rmSync(join(agentDir, "themes", "read-at-startup.json"));

	assert.deepEqual(setTheme("read-at-startup"), { success: true });
});
