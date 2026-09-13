import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createExtensionRuntime } from "../src/core/extensions/loader.js";
import { installReactiveWidget } from "../src/core/extensions/reactive-widget.js";
import { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionUIContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup() {
	const frames: { type: string; componentId: string; widgetKey?: string; lines?: string[] }[] = [];
	const service = new EngineCustomUiService((line) => frames.push(JSON.parse(line)), new KeybindingsManager());
	const ui = {
		setWidget: (key, factory, options) => {
			if (Array.isArray(factory)) throw new Error("unexpected text widget");
			service.setWidget(key, factory, options?.placement);
		},
	} as ExtensionUIContext;
	const runner = () => {
		const value = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), {} as never, {} as never);
		value.setUIContext(ui, "tui");
		return value;
	};
	return { frames, service, ui, runner };
}

// PR #2700: transactional reload starts B before A's shutdown cleanup.
test("retired runner cleanup leaves replacement reactive widget mounted across same-runner rebind", async () => {
	const { frames, service, ui, runner } = setup();
	const a = runner();
	const b = runner();
	const listeners = new Set<() => void>();
	let snapshot = "waiting";
	const mount = (owner: ExtensionRunner) =>
		installReactiveWidget({
			ui: owner.getUIContext(),
			key: "workflow.run",
			getSnapshot: () => snapshot,
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
			getPreviewLines: (snapshot) => [snapshot],
			render: (snapshot) => [snapshot],
		});
	const old = mount(a);
	await flush();
	const replacement = mount(b);
	await flush();
	const id = frames.filter((frame) => frame.type === "engine_custom_open").at(-1)!.componentId;
	b.setUIContext(ui, "tui");
	frames.length = 0;
	old.dispose();
	a.invalidate();
	snapshot = "next question";
	for (const listener of listeners) listener();
	await flush();
	assert.equal(listeners.size, 1);
	assert.equal(replacement.isMounted(), true);
	assert.equal(
		frames.some((frame) => frame.type === "engine_custom_close" && frame.componentId === id),
		false,
	);
	service.handleLine(
		JSON.stringify({ type: "engine_custom_render", componentId: id, requestId: 1, width: 120, rows: 40 }),
	);
	await flush();
	assert.deepEqual(frames.find((frame) => frame.type === "engine_custom_frame" && frame.componentId === id)?.lines, [
		"next question",
	]);
	replacement.dispose();
	assert.equal(listeners.size, 0);
	assert.equal(frames.filter((frame) => frame.type === "engine_custom_close" && frame.componentId === id).length, 1);
	b.invalidate();
});

// PR #2700: a clear or service shutdown can race the asynchronous renderer callback.
test("clearing pending factories and disposing the engine cannot resurrect widgets", async () => {
	const { frames, service, runner } = setup();
	const a = runner();
	const ui = a.getUIContext();
	let disposals = 0;
	const factory = () => ({
		render: () => ["waiting"],
		invalidate() {},
		dispose() {
			disposals++;
		},
	});
	ui.setWidget("workflow.run", factory);
	ui.setWidget("workflow.run", undefined);
	await flush();
	assert.equal(frames.filter((frame) => frame.type === "engine_custom_open").length, 0);
	assert.equal(disposals, 1);
	ui.setWidget("workflow.run", factory);
	service.dispose();
	await flush();
	assert.equal(frames.filter((frame) => frame.type === "engine_custom_open").length, 0);
	assert.equal(disposals, 2);
	a.invalidate();
});

test("SDK repeated, empty and rejected reloads retain one live widget controller and clean timers", async () => {
	const dir = await mkdtemp(join(tmpdir(), "atomic-widget-reload-"));
	const listeners = new Set<() => void>();
	const timers = new Set<object>();
	let visible = true;
	let reject = false;
	let generation = 0;
	const lifecycle: string[] = [];
	const load = () =>
		createTestExtensionsResult(
			[
				(pi) => {
					const id = ++generation;
					let dispose: (() => void) | undefined;
					pi.on("session_start", (_event, ctx) => {
						lifecycle.push(`start:${id}`);
						const controller = installReactiveWidget({
							ui: ctx.ui,
							key: "workflow.run",
							getSnapshot: () => visible,
							getPreviewLines: (show) => (show ? [`generation:${id}`] : []),
							render: (show) => (show ? [`generation:${id}`] : []),
							subscribe: (listener) => {
								listeners.add(listener);
								return () => {
									listeners.delete(listener);
								};
							},
							getNextRefreshDelayMs: (show) => (show ? 1000 : undefined),
							timers: {
								setTimeout: () => {
									const handle = {};
									timers.add(handle);
									return handle;
								},
								clearTimeout: (handle) => {
									timers.delete(handle);
								},
							},
						});
						dispose = () => controller.dispose();
					});
					pi.on("session_shutdown", () => {
						lifecycle.push(`stop:${id}`);
						dispose?.();
					});
				},
			],
			dir,
		);
	try {
		let loaded = await load();
		const resourceLoader = {
			...createTestResourceLoader({ extensionsResult: loaded }),
			getExtensions: () => loaded,
			prepareReload: async () => {
				const candidate = await load();
				return {
					loader: createTestResourceLoader({ extensionsResult: candidate }),
					activate() {},
					prepareCommit: () => {
						if (reject) throw new Error("candidate rejected");
						return {
							commit: () => {
								loaded = candidate;
							},
							rollback() {},
						};
					},
					commit() {},
				};
			},
		};
		const modelRuntime = await ModelRuntime.create({ modelsPath: null, authPath: join(dir, "auth.json") });
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			resourceLoader,
			modelRuntime,
			sessionManager: SessionManager.inMemory(dir),
			settingsManager: SettingsManager.inMemory(),
			noTools: "all",
		});
		let widget: { render(width: number): string[] } | undefined;
		try {
			await session.bindExtensions({
				mode: "tui",
				uiContext: {
					...noOpUIContext,
					setWidget: (_key, factory) => {
						assert.ok(factory === undefined || typeof factory === "function");
						widget = factory?.({ requestRender() {} } as never, undefined as never);
					},
				},
			});
			for (const show of [true, true, false, false, true]) {
				visible = show;
				await session.reload({ failOnExtensionErrors: true });
				assert.equal(listeners.size, 1);
				assert.equal(timers.size, show ? 1 : 0);
				assert.deepEqual(widget?.render(120), show ? [`generation:${generation}`] : undefined);
				assert.deepEqual(lifecycle.slice(-2), [`start:${generation}`, `stop:${generation - 1}`]);
			}
			const surviving = widget;
			reject = true;
			await assert.rejects(() => session.reload({ failOnExtensionErrors: true }), /candidate rejected/);
			assert.equal(widget, surviving);
			assert.equal(listeners.size, 1);
			assert.equal(timers.size, 1);
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			assert.equal(listeners.size, 0);
			assert.equal(timers.size, 0);
			assert.equal(widget, undefined);
		} finally {
			session.dispose();
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("queued old factories cannot reacquire a replacement key or affect unrelated widgets", () => {
	const queued: Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], string[] | undefined>[] = [];
	const visible = new Map<string, string[] | undefined>();
	const host: ExtensionUIContext = {
		...noOpUIContext,
		setWidget: (key, content) => {
			if (typeof content === "function") queued.push(content);
			else visible.set(key, content);
		},
	};
	const make = () => {
		const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), {} as never, {} as never);
		runner.setUIContext(host, "tui");
		return runner;
	};
	const a = make();
	const b = make();
	let staleCalls = 0;
	a.getUIContext().setWidget("workflow.run", () => {
		staleCalls++;
		return { render: () => ["old"], invalidate() {} };
	});
	a.getUIContext().setWidget("other", ["unrelated"]);
	b.getUIContext().setWidget("workflow.run", ["replacement"]);
	assert.deepEqual(queued[0]!({} as never, undefined as never).render(120), []);
	assert.equal(staleCalls, 0);
	a.getUIContext().setWidget("workflow.run", undefined);
	assert.deepEqual(visible.get("workflow.run"), ["replacement"]);
	assert.deepEqual(visible.get("other"), ["unrelated"]);
	a.getUIContext().setWidget("workflow.run", ["retiring callback"]);
	assert.deepEqual(visible.get("workflow.run"), ["replacement"]);
	a.invalidate();
	a.getUIContext().setWidget("workflow.run", ["resurrect"]);
	assert.deepEqual(visible.get("workflow.run"), ["replacement"]);
	assert.equal(visible.get("other"), undefined);
	b.invalidate();
	assert.equal(visible.get("workflow.run"), undefined);
});

test("late factory failure is isolated from the replacement registration", async () => {
	const { frames, service } = setup();
	service.setWidget("workflow.run", () => {
		throw new Error("retired factory");
	});
	service.setWidget("workflow.run", () => ({ render: () => ["replacement"], invalidate() {} }));
	await flush();
	assert.deepEqual(
		frames.map((frame) => frame.type),
		["engine_custom_open"],
	);
	service.dispose();
});
