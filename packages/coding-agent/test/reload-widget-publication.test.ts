import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionError } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

// PR #2700: both staged publication and omitted-widget retirement must finish after commit.
test.each([false, true])("SDK reload contains widget disposal failures (omitted: %s)", async (omitted) => {
	const dir = await mkdtemp(join(tmpdir(), "reload-widget-publication-"));
	const source = new EventEmitter();
	const timers = new Set<ReturnType<typeof setInterval>>();
	const lifecycle: string[] = [];
	const frames: string[] = [];
	const errors: ExtensionError[] = [];
	const disposed: string[] = [];
	let starts = 0;
	let cleaningUp = false;
	const load = () =>
		createTestExtensionsResult(
			[
				(pi) => {
					let timer: ReturnType<typeof setInterval>;
					const listener = () => {};
					let generation = 0;
					pi.on("session_start", (_event, ctx) => {
						generation = ++starts;
						lifecycle.push(`start:${generation}`);
						timer = setInterval(() => {}, 60_000);
						timers.add(timer);
						source.on("update", listener);
						for (const key of ["workflow.run", "second", "healthy"]) {
							if (omitted && generation > 1) continue;
							ctx.ui.setWidget(key, () => ({
								render: () => [`${key}:${generation}`],
								invalidate() {},
								dispose() {
									disposed.push(`${key}:${generation}`);
									if (!cleaningUp && generation === 1 && key !== "healthy")
										throw new Error(`dispose failed: ${key}`);
								},
							}));
						}
						if (omitted)
							ctx.ui.setWidget("replacement", () => ({ render: () => [`live:${generation}`], invalidate() {} }));
						if (generation > 1)
							pi.sendMessage({ customType: "released", content: "after retirement", display: false });
					});
					pi.on("session_shutdown", () => {
						lifecycle.push(`shutdown:${generation}`);
						clearInterval(timer);
						timers.delete(timer);
						source.off("update", listener);
					});
				},
			],
			dir,
		);
	let loaded = await load();
	const resourceLoader = {
		...createTestResourceLoader(),
		getExtensions: () => loaded,
		prepareReload: async () => {
			const candidate = await load();
			return {
				loader: createTestResourceLoader({ extensionsResult: candidate }),
				activate() {},
				commit() {
					loaded = candidate;
					lifecycle.push("commit");
				},
			};
		},
	};
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json") });
	const engine = new EngineCustomUiService((line) => frames.push(line), new KeybindingsManager());
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		resourceLoader,
		modelRuntime,
		sessionManager: SessionManager.inMemory(),
		settingsManager: SettingsManager.inMemory(),
		noTools: "all",
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "custom") lifecycle.push("release");
	});
	try {
		await session.bindExtensions({
			mode: "tui",
			onError: (error) => errors.push(error),
			uiContext: {
				...noOpUIContext,
				setWidget(key, content, options) {
					assert.ok(typeof content === "function" || content === undefined);
					engine.setWidget(key, content, options?.placement);
				},
			},
		});
		await vi.waitFor(() =>
			assert.equal(frames.filter((line) => line.includes('"engine_custom_open"')).length, omitted ? 4 : 3),
		);
		const retiring = session.extensionRunner;
		await session.reload({ failOnExtensionErrors: true });
		assert.notEqual(session.extensionRunner, retiring);
		assert.deepEqual(lifecycle, ["start:1", "start:2", "commit", "shutdown:1", "release"]);
		assert.equal(source.listenerCount("update"), 1);
		assert.equal(timers.size, 1);
		assert.throws(() => retiring.createContext().ui, /no longer active|stale|reload/i);
		assert.deepEqual(
			errors.map(({ extensionPath, event, error }) => ({ extensionPath, event, error })),
			[
				{
					extensionPath: "<runtime>",
					event: omitted ? "session_shutdown" : "session_start",
					error: "dispose failed: workflow.run",
				},
				{
					extensionPath: "<runtime>",
					event: omitted ? "session_shutdown" : "session_start",
					error: "dispose failed: second",
				},
			],
		);
		assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
		await vi.waitFor(() =>
			assert.equal(frames.filter((line) => line.includes('"engine_custom_open"')).length, omitted ? 5 : 4),
		);
		const lastOpen = frames.filter((line) => line.includes('"engine_custom_open"')).at(-1)!;
		assert.ok(lastOpen.includes(omitted ? '"widgetKey":"replacement"' : '"widgetKey":"healthy"'));
		const afterReload = [...frames];
		retiring.invalidate();
		retiring.invalidate();
		assert.deepEqual(frames, afterReload);
		assert.equal(errors.length, 2);
		assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
		assert.throws(() => retiring.createContext().ui, /no longer active|stale|reload/i);
		const { componentId } = JSON.parse(lastOpen) as { componentId: string };
		engine.handleLine(
			JSON.stringify({ type: "engine_custom_render", componentId, requestId: 1, width: 120, rows: 40 }),
		);
		await vi.waitFor(() => assert.ok(frames.some((line) => line.includes(omitted ? "live:2" : "healthy:2"))));
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		assert.equal(source.listenerCount("update"), 0);
		assert.equal(timers.size, 0);
	} finally {
		cleaningUp = true;
		unsubscribe();
		for (const timer of timers) clearInterval(timer);
		source.removeAllListeners();
		session.dispose();
		engine.dispose();
		await rm(dir, { recursive: true, force: true });
	}
});
