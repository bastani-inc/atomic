import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import webAccessEagerFactory from "../../../packages/web-access/index.js";
import { getBuiltinPackageLocations } from "../src/core/builtin-packages.ts";
import { createEventBus } from "../src/core/event-bus.js";
import { hasLazyBuiltinSpec } from "../src/core/extensions/lazy-builtin.js";
import { loadExtensionFromFactory, loadExtensions } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";
import type { ToolDefinition } from "../src/core/extensions/types.ts";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

afterEach(() => {
	if (originalHome === undefined) delete process.env.HOME;
	else process.env.HOME = originalHome;
	if (originalUserProfile === undefined) delete process.env.USERPROFILE;
	else process.env.USERPROFILE = originalUserProfile;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function serializeToolSurface(tool: ToolDefinition | undefined): string {
	assert.ok(tool, "expected tool definition");
	return JSON.stringify({
		name: tool.name,
		label: tool.label,
		description: tool.description,
		promptSnippet: tool.promptSnippet,
		promptGuidelines: tool.promptGuidelines,
		parameters: tool.parameters,
		exposure: tool.exposure,
	});
}

describe("lazy builtin web-access", () => {
	test("registers byte-identical tools, commands, and shortcuts compared to eager web-access without loading bundle", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-web-"));
		tempDirs.push(dir);
		const fakeHome = join(dir, "home");
		mkdirSync(fakeHome, { recursive: true });
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;

		const webLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "web-access");
		assert.ok(webLocation, "web-access builtin location must exist");
		const entryPath = join(webLocation.packageDir, "index.ts");

		const lazyLoaded = await loadExtensions([entryPath], dir);
		assert.equal(hasLazyBuiltinSpec("web-access"), true);
		assert.deepEqual(lazyLoaded.errors, []);
		assert.equal(lazyLoaded.extensions.length, 1);
		assert.equal(extensionLoaderTestHooks.hasNativeBuiltinFactory(entryPath), false);

		const eagerExt = await loadExtensionFromFactory(
			webAccessEagerFactory,
			dir,
			createEventBus(),
			createExtensionRuntime(),
			entryPath,
		);
		const lazyExt = lazyLoaded.extensions[0]!;

		assert.deepEqual([...lazyExt.tools.keys()], [...eagerExt.tools.keys()]);
		for (const toolName of eagerExt.tools.keys()) {
			assert.equal(
				serializeToolSurface(lazyExt.tools.get(toolName)?.definition),
				serializeToolSurface(eagerExt.tools.get(toolName)?.definition),
				`tool surface mismatch for ${toolName}`,
			);
		}

		assert.deepEqual([...lazyExt.commands.keys()], [...eagerExt.commands.keys()]);
		for (const cmdName of eagerExt.commands.keys()) {
			assert.equal(
				lazyExt.commands.get(cmdName)?.description,
				eagerExt.commands.get(cmdName)?.description,
				`command description mismatch for ${cmdName}`,
			);
		}

		assert.deepEqual([...lazyExt.shortcuts.keys()], [...eagerExt.shortcuts.keys()]);
		for (const key of eagerExt.shortcuts.keys()) {
			assert.equal(lazyExt.shortcuts.get(key)?.description, eagerExt.shortcuts.get(key)?.description);
		}
	});

	test("honors custom shortcuts from ~/.atomic/web-search.json while dormant", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-web-shortcuts-"));
		tempDirs.push(dir);
		const fakeHome = join(dir, "home");
		mkdirSync(join(fakeHome, ".atomic"), { recursive: true });
		writeFileSync(
			join(fakeHome, ".atomic", "web-search.json"),
			JSON.stringify({ shortcuts: { curate: "alt+shift+c", activity: "alt+shift+a" } }),
		);
		process.env.HOME = fakeHome;
		process.env.USERPROFILE = fakeHome;

		const webLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "web-access");
		assert.ok(webLocation);
		const entryPath = join(webLocation.packageDir, "index.ts");

		const lazyLoaded = await loadExtensions([entryPath], dir);
		assert.deepEqual(lazyLoaded.errors, []);
		const shortcuts = [...lazyLoaded.extensions[0]!.shortcuts.keys()];
		assert.deepEqual(shortcuts, ["alt+shift+c", "alt+shift+a"]);
	});

	test("marks all_failed web_search and fetch_content tool_result as isError without activating", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-web-result-"));
		tempDirs.push(dir);
		const webLocation = getBuiltinPackageLocations(true).find((loc) => loc.distDirName === "web-access");
		assert.ok(webLocation);
		const entryPath = join(webLocation.packageDir, "index.ts");

		const lazyLoaded = await loadExtensions([entryPath], dir);
		const handlers = lazyLoaded.extensions[0]!.handlers.get("tool_result") ?? [];
		assert.ok(handlers.length > 0);
		const res = await handlers[0]!(
			{ type: "tool_result", toolName: "web_search", details: { outcome: "all_failed" } } as never,
			{} as never,
		);
		assert.deepEqual(res, { isError: true });
	});
});
