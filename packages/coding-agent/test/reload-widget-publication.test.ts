import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionContext, ExtensionError } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import { createWidgetReloadResourceLoader, createWidgetReloadSession } from "./helpers/widget-reload.js";
import { createTestExtensionsResult } from "./utilities.js";

// PR #2700: one exception-path matrix for replacement, omission, rollback and startup release.
test.each([
	"replacement",
	"omitted",
	"startup replacement",
	"startup omitted",
	"rejected",
	"host release",
	"engine shutdown",
	"reentrant same key",
	"reentrant same key throwing",
	"reentrant new key",
	"reentrant new key throwing",
])("SDK widget cleanup exception matrix: %s", async (scenario) => {
	const omitted = scenario.includes("omitted");
	const startup = scenario.startsWith("startup");
	const rejected = scenario === "rejected";
	const reentrant = scenario.startsWith("reentrant");
	const dir = await mkdtemp(join(tmpdir(), "reload-widget-publication-"));
	const source = new EventEmitter();
	const timers = new Set<ReturnType<typeof setInterval>>();
	const lifecycle: string[] = [];
	const frames: string[] = [];
	const errors: ExtensionError[] = [];
	const disposed: string[] = [];
	const contexts: ExtensionContext[] = [];
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
						contexts.push(ctx);
						generation = ++starts;
						lifecycle.push(`start:${generation}`);
						timer = setInterval(() => {}, 60_000);
						timers.add(timer);
						source.on("update", listener);
						for (const key of ["workflow.run", "second", "healthy"]) {
							const ui = ctx.ui;
							if (omitted && generation > 1) continue;
							ctx.ui.setWidget(key, () => ({
								render: () => [`${key}:${generation}`],
								invalidate() {},
								dispose() {
									disposed.push(`${key}:${generation}`);
									if (key === "healthy") {
										clearInterval(timer);
										timers.delete(timer);
										source.off("update", listener);
									}
									if (!cleaningUp && reentrant && key === "workflow.run") {
										ui.setWidget(scenario.includes("new key") ? "new" : key, () => ({
											render: () => ["resurrected"],
											invalidate() {},
										}));
									}
									if (
										!cleaningUp &&
										generation === 1 &&
										key !== "healthy" &&
										(!reentrant || scenario.endsWith("throwing"))
									)
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
						if (rejected && generation > 1) throw new Error("candidate shutdown disposal failed");
					});
				},
			],
			dir,
		);
	const resourceLoader = createWidgetReloadResourceLoader({
		loaded: await load(),
		load,
		beforePrepareCommit: () => {
			if (rejected) throw new Error("candidate rejected");
		},
		onCommit: () => {
			lifecycle.push("commit");
		},
	});
	const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json") });
	const engine = new EngineCustomUiService((line) => frames.push(line), new KeybindingsManager());
	const { session } = await createWidgetReloadSession({
		dir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		modelRuntime,
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
		const oldOpens = frames.filter((line) => line.includes('"engine_custom_open"'));
		if (reentrant) {
			retiring.invalidate();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
			assert.equal(source.listenerCount("update"), 0);
			assert.equal(timers.size, 0);
			assert.equal(errors.length, scenario.endsWith("throwing") ? 2 : 0);
			assert.throws(() => contexts[0].ui, /no longer active|stale|reload/i);
			assert.deepEqual(
				frames.filter((line) => line.includes('"engine_custom_open"')),
				oldOpens,
			);
			for (const open of oldOpens) {
				const { componentId } = JSON.parse(open) as { componentId: string };
				assert.equal(
					frames.filter((line) => line.includes('"engine_custom_close"') && line.includes(componentId)).length,
					1,
				);
			}
			const afterInvalidation = [...frames];
			retiring.invalidate();
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.deepEqual(frames, afterInvalidation);
			assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
			assert.equal(errors.length, scenario.endsWith("throwing") ? 2 : 0);
			return;
		}
		if (scenario === "host release" || scenario === "engine shutdown") {
			const releases: string[] = [];
			const unsubscribes = ["workflow.run", "second", "healthy"].map((key) =>
				engine.onWidgetRelease(key, () => releases.push(key)),
			);
			try {
				if (scenario === "engine shutdown") {
					assert.throws(() => engine.dispose(), /dispose failed: workflow.run/);
					assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
					engine.dispose();
				} else {
					for (const open of oldOpens) {
						const { componentId, widgetKey } = JSON.parse(open) as { componentId: string; widgetKey: string };
						const release = () =>
							engine.handleLine(JSON.stringify({ type: "engine_custom_dispose", componentId }));
						if (widgetKey === "healthy") release();
						else assert.throws(release, /dispose failed/);
						release();
					}
					assert.deepEqual(releases, ["workflow.run", "second", "healthy"]);
				}
				retiring.invalidate();
				retiring.invalidate();
				assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
				assert.equal(source.listenerCount("update"), 0);
				assert.equal(timers.size, 0);
				for (const open of oldOpens) {
					const { componentId } = JSON.parse(open) as { componentId: string };
					assert.equal(
						frames.filter((line) => line.includes('"engine_custom_close"') && line.includes(componentId)).length,
						1,
					);
				}
			} finally {
				for (const unsubscribe of unsubscribes) unsubscribe();
			}
			return;
		}
		if (rejected) {
			await assert.rejects(() => session.reload({ failOnExtensionErrors: true }), /candidate rejected/);
			assert.equal(session.extensionRunner, retiring);
			assert.deepEqual(lifecycle, ["start:1", "start:2", "shutdown:2"]);
			assert.equal(source.listenerCount("update"), 1);
			assert.equal(timers.size, 1);
			assert.deepEqual(disposed, [], "staged candidate factories never acquire live components");
			assert.deepEqual(frames, oldOpens, "rollback must not touch the old owner's widgets");
			assert.throws(() => contexts[1].ui, /no longer active|stale|reload/i);
			retiring.invalidate();
			retiring.invalidate();
			assert.deepEqual(disposed, ["workflow.run:1", "second:1", "healthy:1"]);
			assert.equal(source.listenerCount("update"), 0);
			assert.equal(timers.size, 0);
			assert.throws(() => retiring.createContext().ui, /no longer active|stale|reload/i);
			for (const open of oldOpens) {
				const { componentId } = JSON.parse(open) as { componentId: string };
				assert.equal(
					frames.filter((line) => line.includes('"engine_custom_close"') && line.includes(componentId)).length,
					1,
				);
			}
			return;
		}
		await session.reload({ reason: startup ? "startup" : "reload", failOnExtensionErrors: true });
		assert.notEqual(session.extensionRunner, retiring);
		assert.deepEqual(
			lifecycle,
			startup
				? ["start:1", "start:2", "commit", "release"]
				: ["start:1", "start:2", "commit", "shutdown:1", "release"],
		);
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
		for (const open of oldOpens) {
			const { componentId } = JSON.parse(open) as { componentId: string };
			assert.equal(
				frames.filter((line) => line.includes('"engine_custom_close"') && line.includes(componentId)).length,
				1,
			);
		}
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
