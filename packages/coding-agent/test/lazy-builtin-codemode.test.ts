import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, test } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.js";
import { loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createCodemodeExtension } from "../src/extensions/codemode/index.js";
import {
	CODEMODE_TOOL_NAME,
	createCodemodeToolDefinition,
	isCodemodeRendererLoadedForTest,
	isCodemodeTool,
	resetCodemodeRendererForTest,
} from "../src/extensions/codemode/tool.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

const tempDirs: string[] = [];

afterEach(() => {
	resetCodemodeRendererForTest();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("lazy builtin codemode", () => {
	test("tool.ts defers importing renderer.js off startup while preserving exact tool surface and renderCall", () => {
		const source = readFileSync(join(import.meta.dirname, "../src/extensions/codemode/tool.ts"), "utf8");
		assert.equal(/^\s*import\s+[^;]*["']\.\/renderer\.js["']/m.test(source), false);

		initTheme("dark", false);
		const def = createCodemodeToolDefinition();
		assert.equal(def.name, CODEMODE_TOOL_NAME);
		assert.equal(isCodemodeTool({ name: def.name, parameters: def.parameters }), true);
		assert.equal(isCodemodeRendererLoadedForTest(), false);

		const callComponent = def.renderCall?.({ code: "return 42;\n// line 2" }, theme, {} as never);
		assert.ok(callComponent);
		const lines = callComponent.render(60).map(stripVTControlCharacters);
		assert.deepEqual(lines, ["codemode(return 42;…)"]);
		assert.equal(isCodemodeRendererLoadedForTest(), false);
	});

	test("keeps renderer unloaded on fresh or headless session_start and preloads on resumed TUI session with codemode history", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-lazy-codemode-"));
		tempDirs.push(dir);
		const runtime = createExtensionRuntime();
		const ext = await loadExtensionFromFactory(
			createCodemodeExtension(),
			dir,
			createEventBus(),
			runtime,
			"builtin:codemode",
		);
		assert.equal(ext.path, "builtin:codemode");
		assert.equal(ext.sourceInfo.path, "builtin:codemode");

		// Fresh TUI session: renderer stays unloaded.
		const smFresh = SessionManager.inMemory(dir);
		const runnerFresh = new ExtensionRunner([ext], runtime, dir, smFresh, new ModelRegistry(AuthStorage.inMemory()));
		runnerFresh.setUIContext(runnerFresh.getUIContext(), "tui", false);
		await runnerFresh.emit({ type: "session_start", reason: "startup" });
		assert.equal(isCodemodeRendererLoadedForTest(), false);

		// Resumed headless session with codemode history: renderer stays unloaded (no UI).
		const smResumed = SessionManager.inMemory(dir);
		await smResumed.appendMessage({
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "codemode",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 1,
		});
		const runnerHeadless = new ExtensionRunner(
			[ext],
			runtime,
			dir,
			smResumed,
			new ModelRegistry(AuthStorage.inMemory()),
		);
		await runnerHeadless.emit({ type: "session_start", reason: "resume" });
		assert.equal(isCodemodeRendererLoadedForTest(), false);

		// Resumed TUI session with codemode history: renderer preloads so historical cards render richly.
		const runnerTui = new ExtensionRunner([ext], runtime, dir, smResumed, new ModelRegistry(AuthStorage.inMemory()));
		runnerTui.setUIContext(runnerTui.getUIContext(), "tui", false);
		await runnerTui.emit({ type: "session_start", reason: "resume" });
		assert.equal(isCodemodeRendererLoadedForTest(), true);
	});
});
