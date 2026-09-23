import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

const themeSource = join(
	dirname(fileURLToPath(import.meta.url)),
	"../src/modes/interactive/theme/catppuccin-mocha.json",
);

describe("DefaultResourceLoader.createSessionLoader with CLI theme path (#3229)", () => {
	let tempDir: string;
	let agentDir: string;
	let cwd: string;
	let themePath: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `rl-3229-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		cwd = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		themePath = join(tempDir, "catppuccin-mocha.json");
		copyFileSync(themeSource, themePath);
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("creates a stage session loader without crashing when a theme was passed via --theme (#3229)", async () => {
		const loader = new DefaultResourceLoader({ cwd, agentDir, additionalThemePaths: [themePath] });
		await loader.reload();
		assert.ok(
			loader.getThemes().themes.some((t) => t.name === "catppuccin-mocha"),
			"parent loader should load the CLI theme",
		);

		const child = await loader.createSessionLoader({});
		assert.notEqual(child, loader);
		assert.ok(
			child.getThemes().themes.some((t) => t.name === "catppuccin-mocha"),
			"session loader should retain the CLI theme",
		);
	});
});
