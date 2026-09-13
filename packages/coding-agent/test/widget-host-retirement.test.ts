import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionError, ExtensionUIContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import "../src/modes/interactive/interactive-extension-runtime.js";
import "../src/modes/interactive/interactive-extension-context.js";
import "../src/modes/interactive/interactive-extension-widgets.js";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function createHost(kind: "local" | "engine") {
	type Widget = { render(width: number): string[]; invalidate(): void; dispose?(): void };
	const local = {
		extensionWidgetsAbove: new Map<string, Widget>(),
		extensionWidgetsBelow: new Map<string, Widget>(),
		widgetReleaseListeners: new Map<string, Set<() => void>>(),
		ui: { terminal: { rows: 40 }, requestRender() {} },
		widgetContainerAbove: new Container(),
		widgetContainerBelow: new Container(),
		renderWidgets: InteractiveModeBase.prototype.renderWidgets,
		renderWidgetContainer: InteractiveModeBase.prototype.renderWidgetContainer,
		notifyExtensionWidgetRelease: InteractiveModeBase.prototype.notifyExtensionWidgetRelease,
	} as unknown as InteractiveModeBase;
	const active = new Map<string, string>();
	const rendered = new Map<string, string[]>();
	const engine = new EngineCustomUiService((line) => {
		const frame = JSON.parse(line) as { type: string; componentId: string; widgetKey: string; lines: string[] };
		if (frame.type === "engine_custom_open") active.set(frame.componentId, frame.widgetKey);
		if (frame.type === "engine_custom_close") active.delete(frame.componentId);
		if (frame.type === "engine_custom_frame") rendered.set(frame.componentId, frame.lines);
	}, new KeybindingsManager());
	const ui: ExtensionUIContext = {
		...noOpUIContext,
		setWidget(key, content, options) {
			if (kind === "local") InteractiveModeBase.prototype.setExtensionWidget.call(local, key, content, options);
			else {
				assert.ok(!Array.isArray(content));
				engine.setWidget(key, content, options?.placement, options?.scroll);
			}
		},
		onWidgetRelease: (key, listener) =>
			kind === "local"
				? InteractiveModeBase.prototype.onExtensionWidgetRelease.call(local, key, listener)
				: engine.onWidgetRelease(key, listener),
	};
	return {
		ui,
		async snapshot() {
			await flush();
			if (kind === "local") {
				const snapshot = new Map(
					[...local.extensionWidgetsAbove, ...local.extensionWidgetsBelow].map(([key, widget]) => [
						key,
						widget.render(80),
					]),
				);
				assert.deepEqual(
					[...local.widgetContainerAbove.render(80), ...local.widgetContainerBelow.render(80)].filter((line) =>
						line.trim(),
					),
					[...snapshot.values()].flat(),
					"rendered dock must match retained host components after disposal",
				);
				return snapshot;
			}
			for (const componentId of active.keys())
				engine.handleLine(
					JSON.stringify({ type: "engine_custom_render", componentId, requestId: 1, width: 80, rows: 40 }),
				);
			await flush();
			return new Map([...active].map(([id, key]) => [key, rendered.get(id)]));
		},
		release() {
			if (kind === "local") InteractiveModeBase.prototype.clearExtensionWidgets.call(local);
			else engine.dispose();
		},
	};
}

// PR #2700: the original SDK exception matrix covered only the engine host.
// Exercise real session transactions and both actual widget hosts, observing retained components, not only disposal calls.
for (const kind of ["local", "engine"] as const) {
	test.each([
		"replacement",
		"omitted",
		"startup replacement",
		"startup omitted",
		"rejected",
		"clear retry",
		"host release",
		"old-owner invalidation",
		"reentrant same key",
		"reentrant same key throwing",
		"reentrant new key",
		"reentrant new key throwing",
	])(`${kind} widget retirement: %s`, async (scenario) => {
		const host = createHost(kind);
		const dir = await mkdtemp(join(tmpdir(), "widget-host-retirement-"));
		const held: ExtensionUIContext[] = [];
		const disposed: string[] = [];
		const releases: string[] = [];
		const errors: ExtensionError[] = [];
		const lifecycle: string[] = [];
		const subscriptions = new Set<number>();
		const timers = new Map<number, ReturnType<typeof setInterval>>();
		const omitted = scenario.includes("omitted");
		const reentrant = scenario.startsWith("reentrant");
		let generation = 0;
		let cleanup = false;
		const keys = ["workflow.run", "second", "healthy"];
		const load = () =>
			createTestExtensionsResult(
				[
					(pi) => {
						let current = 0;
						pi.on("session_start", (_event, ctx) => {
							current = ++generation;
							const id = current;
							const ui = ctx.ui;
							held.push(ui);
							lifecycle.push(`start:${id}`);
							subscriptions.add(id);
							timers.set(
								id,
								setInterval(() => {}, 60_000),
							);
							for (const key of id > 1 && omitted ? ["candidate"] : keys) {
								ui.setWidget(
									key,
									() => ({
										render: () => [`${key}:${id}`],
										invalidate() {},
										dispose() {
											disposed.push(`${key}:${id}`);
											if (key === "healthy" || key === "candidate") {
												clearInterval(timers.get(id));
												timers.delete(id);
												subscriptions.delete(id);
											}
											if (cleanup || id !== 1) return;
											if (reentrant && key === "workflow.run")
												ui.setWidget(scenario.includes("new key") ? "new" : key, () => ({
													render: () => ["resurrected"],
													invalidate() {},
												}));
											if (key !== "healthy" && (!reentrant || scenario.endsWith("throwing")))
												throw new Error(`dispose failed: ${key}`);
										},
									}),
									{ placement: key === "second" ? "belowEditor" : "aboveEditor" },
								);
							}
						});
						pi.on("session_shutdown", () => {
							lifecycle.push(`stop:${current}`);
							clearInterval(timers.get(current));
							timers.delete(current);
							subscriptions.delete(current);
							if (scenario === "rejected" && current > 1) throw new Error("candidate shutdown failed");
						});
					},
				],
				dir,
			);
		let loaded = await load();
		const loader = {
			...createTestResourceLoader(),
			getExtensions: () => loaded,
			prepareReload: async () => {
				const candidate = await load();
				return {
					loader: createTestResourceLoader({ extensionsResult: candidate }),
					activate() {},
					prepareCommit() {
						if (scenario === "rejected") throw new Error("candidate rejected");
						return {
							commit() {
								loaded = candidate;
								lifecycle.push("commit");
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
			resourceLoader: loader,
			modelRuntime,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
			noTools: "all",
		});
		try {
			await session.bindExtensions({ mode: "tui", uiContext: host.ui, onError: (error) => errors.push(error) });
			const before = await host.snapshot();
			assert.equal(before.size, 3);
			const retiring = session.extensionRunner;
			if (scenario === "clear retry") {
				assert.throws(() => held[0].setWidget("workflow.run", undefined), /dispose failed/);
				held[0].setWidget("workflow.run", undefined);
				assert.deepEqual(
					await host.snapshot(),
					new Map([
						["second", ["second:1"]],
						["healthy", ["healthy:1"]],
					]),
				);
			} else if (scenario === "host release") {
				for (const key of keys) host.ui.onWidgetRelease!(key, () => releases.push(key));
				assert.throws(() => host.release(), /dispose failed: workflow.run/);
				host.release();
				assert.equal((await host.snapshot()).size, 0);
				if (kind === "local") assert.deepEqual(releases.sort(), [...keys].sort());
			} else if (scenario === "rejected") {
				await assert.rejects(() => session.reload({ failOnExtensionErrors: true }), /candidate rejected/);
				assert.equal(session.extensionRunner, retiring);
				assert.deepEqual(await host.snapshot(), before);
				assert.deepEqual(disposed, []);
				assert.deepEqual(lifecycle, ["start:1", "start:2", "stop:2"]);
				assert.deepEqual([...subscriptions], [1]);
				assert.equal(timers.size, 1);
				held[1].setWidget("candidate resurrection", () => ({ render: () => ["stale"], invalidate() {} }));
			} else if (!reentrant && scenario !== "old-owner invalidation") {
				const startup = scenario.startsWith("startup");
				await session.reload({ reason: startup ? "startup" : "reload", failOnExtensionErrors: true });
				assert.deepEqual(
					lifecycle,
					startup ? ["start:1", "start:2", "commit"] : ["start:1", "start:2", "commit", "stop:1"],
				);
				assert.deepEqual(
					await host.snapshot(),
					new Map(omitted ? [["candidate", ["candidate:2"]]] : [["healthy", ["healthy:2"]]]),
				);
				assert.deepEqual([...subscriptions], [2]);
				assert.equal(timers.size, 1);
				assert.equal(errors.length, 2);
			}
			retiring.invalidate();
			retiring.invalidate();
			assert.throws(() => retiring.createContext().ui, /no longer active|stale|reload/i);
			if (reentrant) assert.equal(errors.length, scenario.endsWith("throwing") ? 2 : 0);
			if (scenario === "old-owner invalidation") assert.equal(errors.length, 2);
			held[0].setWidget("workflow.run", () => ({ render: () => ["stale"], invalidate() {} }));
			held[0].setWidget("new", () => ({ render: () => ["stale"], invalidate() {} }));
			const after = await host.snapshot();
			assert.ok([...after.values()].every((lines) => lines?.every((line) => line.endsWith(":2"))));
			assert.deepEqual([...disposed].sort(), keys.map((key) => `${key}:1`).sort());
			if (session.extensionRunner === retiring) {
				assert.equal(after.size, 0);
				assert.equal(timers.size, 0);
				assert.equal(subscriptions.size, 0);
			}
		} finally {
			cleanup = true;
			session.dispose();
			host.release();
			for (const timer of timers.values()) clearInterval(timer);
			await rm(dir, { recursive: true, force: true });
		}
	});
}
