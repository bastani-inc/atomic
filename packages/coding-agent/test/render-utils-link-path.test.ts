import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, resetCapabilitiesCache, setCapabilityOverrides } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { linkPath } from "../src/core/tools/render-utils.ts";

const clearedEnvironment = [
	"TMUX",
	"COLORTERM",
	"KITTY_WINDOW_ID",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
] as const;

describe("linkPath in the Rex terminal", () => {
	beforeEach(() => {
		for (const key of clearedEnvironment) vi.stubEnv(key, undefined);
		vi.stubEnv("TERM", "xterm-256color");
		vi.stubEnv("TERM_PROGRAM", "rex");
		setCapabilityOverrides({});
		resetCapabilitiesCache();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		setCapabilityOverrides({});
		resetCapabilitiesCache();
	});

	test("reports truecolor, Kitty images and hyperlinks for TERM_PROGRAM=rex", () => {
		assert.deepEqual(getCapabilities(), { images: "kitty", trueColor: true, hyperlinks: true });
	});

	test("wraps a tool path in an OSC 8 hyperlink instead of leaving plain text", () => {
		const cwd = process.cwd();
		const linked = linkPath("src/index.ts", "src/index.ts", cwd);

		const url = pathToFileURL(resolve(cwd, "src/index.ts")).href;
		assert.equal(linked, `\x1b]8;;${url}\x1b\\src/index.ts\x1b]8;;\x1b\\`);
	});
});
