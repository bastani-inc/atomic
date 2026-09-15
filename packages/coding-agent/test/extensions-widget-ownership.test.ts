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
import { SessionManager } from "../src/core/session-manager.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import { createWidgetReloadResourceLoader, createWidgetReloadSession } from "./helpers/widget-reload.js";
import { createTestExtensionsResult } from "./utilities.js";

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

// PR #2700: old shutdown can yield after its widget hid but before runner invalidation.
test("self-cleared runner cannot reclaim a committed replacement, while live owners can hide and remount", async () => {
	const { frames, service, ui, runner } = setup();
	const a = runner();
	const b = runner();
	const factory = (label: string) => () => ({ render: () => [label], invalidate() {} });
	const mount = async (owner: ExtensionRunner, label: string) => {
		owner.getUIContext().setWidget("workflow.run", factory(label));
		await flush();
		return frames.filter((frame) => frame.type === "engine_custom_open").at(-1)!.componentId;
	};
	const render = async (id: string, label: string) => {
		frames.length = 0;
		service.handleLine(
			JSON.stringify({ type: "engine_custom_render", componentId: id, requestId: 1, width: 120, rows: 40 }),
		);
		await flush();
		assert.deepEqual(frames.find((frame) => frame.type === "engine_custom_frame")?.lines, [label]);
	};
	try {
		await mount(a, "A");
		a.getUIContext().setWidget("workflow.run", undefined);
		a.setUIContext(ui, "tui");
		await render(await mount(a, "A remounted"), "A remounted");
		a.getUIContext().setWidget("workflow.run", undefined);
		b.stageWidgets();
		b.getUIContext().setWidget("workflow.run", factory("B"));
		b.commitWidgets();
		await flush();
		const replacementId = frames.filter((frame) => frame.type === "engine_custom_open").at(-1)!.componentId;
		frames.length = 0;
		await Promise.resolve().then(() => a.getUIContext().setWidget("workflow.run", factory("late A")));
		await flush();
		a.invalidate();
		assert.equal(
			frames.some((frame) => frame.type === "engine_custom_close" && frame.componentId === replacementId),
			false,
		);
		await render(replacementId, "B");
		const updatedId = await mount(b, "B updated");
		await render(updatedId, "B updated");
		b.getUIContext().setWidget("workflow.run", undefined);
		assert.equal(
			frames.filter((frame) => frame.type === "engine_custom_close" && frame.componentId === updatedId).length,
			1,
		);
		await render(await mount(b, "B remounted"), "B remounted");
	} finally {
		a.invalidate();
		b.invalidate();
		service.dispose();
	}
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
		const resourceLoader = createWidgetReloadResourceLoader({
			loaded: await load(),
			load,
			beforePrepareCommit: () => {
				if (reject) throw new Error("candidate rejected");
			},
		});
		const { session } = await createWidgetReloadSession({
			dir,
			resourceLoader,
			sessionManager: SessionManager.inMemory(dir),
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

test("same-runner replacement and hide/remount leave queued factories inert", () => {
	const queued: Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], string[] | undefined>[] = [];
	const host: ExtensionUIContext = {
		...noOpUIContext,
		setWidget: (_key, content) => {
			if (typeof content === "function") queued.push(content);
		},
	};
	const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), {} as never, {} as never);
	runner.setUIContext(host, "tui");
	const ui = runner.getUIContext();
	let staleCalls = 0;
	const factory = () => {
		staleCalls++;
		return { render: () => ["old"], invalidate() {} };
	};
	ui.setWidget("workflow.run", factory);
	ui.setWidget("workflow.run", () => ({ render: () => ["replacement"], invalidate() {} }));
	assert.deepEqual(queued[0]!({} as never, undefined as never).render(120), []);
	assert.equal(staleCalls, 0);
	ui.setWidget("workflow.run", undefined);
	ui.setWidget("workflow.run", ["remounted"]);
	assert.deepEqual(queued[0]!({} as never, undefined as never).render(120), []);
	assert.deepEqual(queued[1]!({} as never, undefined as never).render(120), []);
	assert.equal(staleCalls, 0);
	runner.invalidate();
});

test("invalidation rechecks ownership before deleting a later key", () => {
	const visible = new Map<string, string[] | undefined>();
	const mounted = new Map<string, { dispose?(): void }>();
	const host: ExtensionUIContext = {
		...noOpUIContext,
		setWidget: (key, content) => {
			const previous = mounted.get(key);
			if (content === undefined) {
				mounted.delete(key);
				visible.delete(key);
				previous?.dispose?.();
				return;
			}
			const widget =
				typeof content === "function" ? content({} as never, undefined as never) : { render: () => content };
			mounted.set(key, widget);
			visible.set(key, widget.render(120));
			previous?.dispose?.();
		},
	};
	const make = () => {
		const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), {} as never, {} as never);
		runner.setUIContext(host, "tui");
		return runner;
	};
	const retiring = make();
	const live = make();
	retiring.getUIContext().setWidget("first", () => ({
		render: () => ["first"],
		invalidate() {},
		dispose() {
			live.getUIContext().setWidget("second", ["replacement"]);
		},
	}));
	retiring.getUIContext().setWidget("second", ["old second"]);
	retiring.invalidate();
	assert.deepEqual(visible.get("second"), ["replacement"]);
	live.invalidate();
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

// PR #2700: retained clear history must not keep factories or release listeners active.
test("cleared ownership history isolates queued factories and forwards releases only for the live owner", () => {
	const queued: Exclude<Parameters<ExtensionUIContext["setWidget"]>[1], string[] | undefined>[] = [];
	const listeners = new Set<() => void>();
	const visible = new Map<string, string[] | undefined>();
	const host: ExtensionUIContext = {
		...noOpUIContext,
		setWidget: (key, content) => {
			if (typeof content === "function") queued.push(content);
			else visible.set(key, content);
		},
		onWidgetRelease: (_key, listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	const make = () => {
		const runner = new ExtensionRunner([], createExtensionRuntime(), process.cwd(), {} as never, {} as never);
		runner.setUIContext(host, "tui");
		return runner;
	};
	const a = make();
	const b = make();
	let factoryCalls = 0;
	let aReleases = 0;
	let bReleases = 0;
	const stopA = a.getUIContext().onWidgetRelease!("workflow.run", () => {
		aReleases++;
	});
	const stopB = b.getUIContext().onWidgetRelease!("workflow.run", () => {
		bReleases++;
	});
	const release = () => {
		for (const listener of listeners) listener();
	};
	a.getUIContext().setWidget("workflow.run", () => {
		factoryCalls++;
		return { render: () => ["A"], invalidate() {} };
	});
	a.getUIContext().setWidget("workflow.run", undefined);
	assert.deepEqual(queued[0]!({} as never, undefined as never).render(120), []);
	assert.equal(factoryCalls, 0);
	release();
	assert.deepEqual([aReleases, bReleases], [0, 0]);
	a.getUIContext().setWidget("workflow.run", ["A remounted"]);
	release();
	assert.deepEqual([aReleases, bReleases], [1, 0]);
	b.getUIContext().setWidget("workflow.run", ["B"]);
	release();
	assert.deepEqual([aReleases, bReleases], [1, 1]);
	b.getUIContext().setWidget("workflow.run", undefined);
	a.getUIContext().setWidget("workflow.run", ["late A after B clear"]);
	assert.equal(visible.get("workflow.run"), undefined);
	release();
	assert.deepEqual([aReleases, bReleases], [1, 1]);
	b.getUIContext().setWidget("workflow.run", ["B remounted"]);
	a.invalidate();
	release();
	assert.deepEqual([aReleases, bReleases], [1, 2]);
	assert.deepEqual(visible.get("workflow.run"), ["B remounted"]);
	b.invalidate();
	assert.equal(visible.get("workflow.run"), undefined);
	release();
	assert.deepEqual([aReleases, bReleases], [1, 2]);
	stopA();
	stopB();
	assert.equal(listeners.size, 0);
});

test("old registration a,b then successor registration b,a disposes successor widgets as b,a", async () => {
	const { service, runner } = setup();
	const disposed: string[] = [];
	const factory = (key: string, label: string) => () => ({
		render: () => [label],
		invalidate() {},
		dispose() {
			disposed.push(key);
		},
	});
	const old = runner();
	const successor = runner();
	try {
		old.getUIContext().setWidget("a", factory("a", "old-a"));
		old.getUIContext().setWidget("b", factory("b", "old-b"));
		await flush();
		successor.stageWidgets();
		successor.getUIContext().setWidget("b", factory("b", "new-b"));
		successor.getUIContext().setWidget("a", factory("a", "new-a"));
		successor.commitWidgets();
		await flush();
		disposed.length = 0;
		successor.invalidate();
		assert.deepEqual(disposed, ["b", "a"]);
	} finally {
		old.invalidate();
		successor.invalidate();
		service.dispose();
	}
});

test("registration a,b then hide/remount a invalidates as a,b", async () => {
	const { service, runner } = setup();
	const disposed: string[] = [];
	const factory = (key: string) => () => ({
		render: () => [key],
		invalidate() {},
		dispose() {
			disposed.push(key);
		},
	});
	const owner = runner();
	try {
		const widgetUi = owner.getUIContext();
		widgetUi.setWidget("a", factory("a"));
		widgetUi.setWidget("b", factory("b"));
		await flush();
		widgetUi.setWidget("a", undefined);
		await flush();
		widgetUi.setWidget("a", factory("a"));
		await flush();
		disposed.length = 0;
		owner.invalidate();
		assert.deepEqual(disposed, ["a", "b"]);
	} finally {
		owner.invalidate();
		service.dispose();
	}
});

test("never-published runner hide of a live owner's key or an absent key does not block the live owner's update", async () => {
	const { frames, service, runner } = setup();
	const live = runner();
	const stranger = runner();
	const factory = (label: string) => () => ({ render: () => [label], invalidate() {} });
	try {
		live.getUIContext().setWidget("owned", factory("live"));
		await flush();
		stranger.getUIContext().setWidget("owned", undefined);
		stranger.getUIContext().setWidget("absent", undefined);
		frames.length = 0;
		live.getUIContext().setWidget("owned", factory("updated"));
		await flush();
		const updatedId = frames.filter((frame) => frame.type === "engine_custom_open").at(-1)?.componentId;
		assert.ok(updatedId);
		service.handleLine(
			JSON.stringify({ type: "engine_custom_render", componentId: updatedId, requestId: 1, width: 120, rows: 40 }),
		);
		await flush();
		assert.deepEqual(frames.find((frame) => frame.type === "engine_custom_frame")?.lines, ["updated"]);
	} finally {
		live.invalidate();
		stranger.invalidate();
		service.dispose();
	}
});
