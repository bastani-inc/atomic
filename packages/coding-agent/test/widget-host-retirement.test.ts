import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.js";
import { noOpUIContext } from "../src/core/extensions/runner-ui.js";
import type { ExtensionContext, ExtensionError, ExtensionUIContext } from "../src/core/extensions/types.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SessionManager } from "../src/core/session-manager.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import { EngineCustomUiService } from "../src/modes/interactive-engine/engine-custom-ui.js";
import "../src/modes/interactive/interactive-extension-runtime.js";
import "../src/modes/interactive/interactive-extension-context.js";
import "../src/modes/interactive/interactive-extension-widgets.js";
import { createWidgetReloadResourceLoader, createWidgetReloadSession } from "./helpers/widget-reload.js";
import { createTestExtensionsResult } from "./utilities.js";

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const KEYS = ["workflow.run", "second", "healthy"] as const;

function createHost(kind: "local" | "engine") {
	type Widget = { render(width: number): string[]; invalidate(): void; dispose?(): void };
	const reported: string[] = [];
	const opened: string[] = [];
	const openedIds: string[] = [];
	const closed: string[] = [];
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
		showExtensionError(_path: string, error: string) {
			reported.push(error);
		},
	} as unknown as InteractiveModeBase;
	const active = new Map<string, string>();
	const rendered = new Map<string, string[]>();
	const engine = new EngineCustomUiService(
		(line) => {
			const frame = JSON.parse(line) as { type: string; componentId: string; widgetKey: string; lines: string[] };
			if (frame.type === "engine_custom_open") {
				active.set(frame.componentId, frame.widgetKey);
				opened.push(frame.widgetKey);
				openedIds.push(frame.componentId);
			}
			if (frame.type === "engine_custom_close") {
				active.delete(frame.componentId);
				closed.push(frame.componentId);
			}
			if (frame.type === "engine_custom_frame") rendered.set(frame.componentId, frame.lines);
		},
		new KeybindingsManager(),
		(error) => reported.push(error.error),
	);
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
		reported,
		opened,
		openedIds,
		closed,
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
		disposeRemote(componentId: string) {
			if (kind !== "engine") return false;
			return engine.handleLine(JSON.stringify({ type: "engine_custom_dispose", componentId }));
		},
	};
}

type RetirementFixture = {
	kind: "local" | "engine";
	host: ReturnType<typeof createHost>;
	session: Awaited<ReturnType<typeof createWidgetReloadSession>>["session"];
	held: ExtensionUIContext[];
	contexts: ExtensionContext[];
	disposed: string[];
	errors: ExtensionError[];
	lifecycle: string[];
	subscriptions: Set<number>;
	timers: Map<number, ReturnType<typeof setInterval>>;
	keys: string[];
	dispose(): Promise<void>;
};

async function createRetirementFixture(
	kind: "local" | "engine",
	options: {
		omitted?: boolean;
		throwingDispose?: boolean;
		reentrantKey?: "workflow.run" | "new";
		rejectCandidate?: boolean;
	} = {},
): Promise<RetirementFixture> {
	const omitted = options.omitted ?? false;
	const throwingDispose = options.throwingDispose ?? true;
	const reentrantKey = options.reentrantKey;
	const rejectCandidate = options.rejectCandidate ?? false;
	const host = createHost(kind);
	const dir = await mkdtemp(join(tmpdir(), "widget-host-retirement-"));
	const held: ExtensionUIContext[] = [];
	const contexts: ExtensionContext[] = [];
	const disposed: string[] = [];
	const errors: ExtensionError[] = [];
	const lifecycle: string[] = [];
	const subscriptions = new Set<number>();
	const timers = new Map<number, ReturnType<typeof setInterval>>();
	const keys = [...KEYS];
	let generation = 0;
	let cleanup = false;
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
						contexts.push(ctx);
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
										if (reentrantKey && key === "workflow.run")
											ui.setWidget(reentrantKey, () => ({
												render: () => ["resurrected"],
												invalidate() {},
											}));
										if (key !== "healthy" && throwingDispose) throw new Error(`dispose failed: ${key}`);
									},
								}),
								{ placement: key === "second" ? "belowEditor" : "aboveEditor" },
							);
						}
						if (id > 1) pi.sendMessage({ customType: "released", content: "after retirement", display: false });
					});
					pi.on("session_shutdown", () => {
						lifecycle.push(`stop:${current}`);
						clearInterval(timers.get(current));
						timers.delete(current);
						subscriptions.delete(current);
						if (rejectCandidate && current > 1) throw new Error("candidate shutdown failed");
					});
				},
			],
			dir,
		);
	const loader = createWidgetReloadResourceLoader({
		loaded: await load(),
		load,
		beforePrepareCommit: () => {
			if (rejectCandidate) throw new Error("candidate rejected");
		},
		onCommit: () => {
			lifecycle.push("commit");
		},
	});
	const { session } = await createWidgetReloadSession({
		dir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(),
	});
	const unsubscribe = session.subscribe((event) => {
		if (event.type === "message_end" && event.message.role === "custom") lifecycle.push("release");
	});
	await session.bindExtensions({ mode: "tui", uiContext: host.ui, onError: (error) => errors.push(error) });
	return {
		kind,
		host,
		session,
		held,
		contexts,
		disposed,
		errors,
		lifecycle,
		subscriptions,
		timers,
		keys,
		async dispose() {
			cleanup = true;
			unsubscribe();
			session.dispose();
			host.release();
			for (const timer of timers.values()) clearInterval(timer);
			await rm(dir, { recursive: true, force: true });
		},
	};
}

async function expectRetiredOwnerSilenced(fixture: RetirementFixture, retiring: ExtensionRunner): Promise<void> {
	retiring.invalidate();
	retiring.invalidate();
	assert.throws(() => retiring.createContext().ui, /no longer active|stale|reload/i);
	fixture.held[0].setWidget("workflow.run", () => ({ render: () => ["stale"], invalidate() {} }));
	fixture.held[0].setWidget("new", () => ({ render: () => ["stale"], invalidate() {} }));
	const after = await fixture.host.snapshot();
	assert.ok([...after.values()].every((lines) => lines?.every((line) => line.endsWith(":2"))));
	assert.deepEqual([...fixture.disposed].sort(), fixture.keys.map((key) => `${key}:1`).sort());
}

// PR #2700: the original SDK exception matrix covered only the engine host.
// Exercise real session transactions and both actual widget hosts, observing retained components, not only disposal calls.
for (const kind of ["local", "engine"] as const) {
	// PR #2700: registration history is absent for empty and never-mounted owners.
	test.each(["empty", "never-mounted", "hidden"])(
		`${kind} retiring initially %s owner cannot publish during shutdown`,
		async (initial) => {
			const host = createHost(kind);
			const dir = await mkdtemp(join(tmpdir(), "widget-empty-owner-"));
			const held: ExtensionUIContext[] = [];
			const lifecycle: string[] = [];
			let generation = 0;
			let reject = true;
			const factory = (label: string) => () => ({ render: () => [label], invalidate() {} });
			const load = () =>
				createTestExtensionsResult(
					[
						(pi) => {
							let id = 0;
							pi.on("session_start", (_event, ctx) => {
								id = ++generation;
								held.push(ctx.ui);
								lifecycle.push(`start:${id}`);
								if (id === 1) {
									if (initial === "hidden") ctx.ui.setWidget("workflow.run", factory("old"));
									if (initial !== "never-mounted") ctx.ui.setWidget("workflow.run", undefined);
								} else ctx.ui.setWidget("workflow.run", factory(`candidate:${id}`));
							});
							pi.on("session_shutdown", async () => {
								lifecycle.push(`stop:${id}`);
								await flush();
								held[id - 1].setWidget("workflow.run", factory("stale"));
								held[id - 1].setWidget("new", factory("resurrected"));
								await flush();
							});
						},
					],
					dir,
				);
			const loader = createWidgetReloadResourceLoader({
				loaded: await load(),
				load,
				beforePrepareCommit: () => {
					if (reject) throw new Error("candidate rejected");
				},
				onCommit: () => {
					lifecycle.push("commit");
				},
			});
			const { session } = await createWidgetReloadSession({
				dir,
				resourceLoader: loader,
				sessionManager: SessionManager.inMemory(),
			});
			try {
				await session.bindExtensions({ mode: "tui", uiContext: host.ui });
				assert.equal((await host.snapshot()).size, 0);
				const retiring = session.extensionRunner;
				await assert.rejects(() => session.reload({ failOnExtensionErrors: true }), /candidate rejected/);
				assert.equal(session.extensionRunner, retiring);
				assert.equal((await host.snapshot()).size, 0);
				// Rollback must leave this owner free to acquire a previously untouched key.
				held[0].setWidget("unrelated", factory("old unrelated"));
				assert.deepEqual(await host.snapshot(), new Map([["unrelated", ["old unrelated"]]]));
				reject = false;
				await session.reload({ failOnExtensionErrors: true });
				assert.deepEqual(lifecycle, ["start:1", "start:2", "stop:2", "start:3", "commit", "stop:1"]);
				assert.deepEqual(await host.snapshot(), new Map([["workflow.run", ["candidate:3"]]]));
				retiring.invalidate();
				held[0].setWidget("workflow.run", factory("stale after invalidation"));
				assert.deepEqual(await host.snapshot(), new Map([["workflow.run", ["candidate:3"]]]));
				await session.bindExtensions({ mode: "tui", uiContext: host.ui });
				session.extensionRunner.getUIContext().setWidget("workflow.run", factory("rebound"));
				assert.deepEqual(await host.snapshot(), new Map([["workflow.run", ["rebound"]]]));
			} finally {
				session.dispose();
				host.release();
				await rm(dir, { recursive: true, force: true });
			}
		},
	);

	test.each([
		{
			name: "replacement",
			reason: "reload" as const,
			omitted: false,
			expectedKeys: new Map([
				["workflow.run", ["workflow.run:2"]],
				["second", ["second:2"]],
				["healthy", ["healthy:2"]],
			]),
			expectedLifecycle: ["start:1", "start:2", "commit", "stop:1", "release"],
			disposalEvent: "session_start",
		},
		{
			name: "omitted",
			reason: "reload" as const,
			omitted: true,
			expectedKeys: new Map([["candidate", ["candidate:2"]]]),
			expectedLifecycle: ["start:1", "start:2", "commit", "stop:1", "release"],
			disposalEvent: "session_shutdown",
		},
		{
			name: "startup replacement",
			reason: "startup" as const,
			omitted: false,
			expectedKeys: new Map([
				["workflow.run", ["workflow.run:2"]],
				["second", ["second:2"]],
				["healthy", ["healthy:2"]],
			]),
			expectedLifecycle: ["start:1", "start:2", "commit", "release"],
			disposalEvent: "session_start",
		},
		{
			name: "startup omitted",
			reason: "startup" as const,
			omitted: true,
			expectedKeys: new Map([["candidate", ["candidate:2"]]]),
			expectedLifecycle: ["start:1", "start:2", "commit", "release"],
			disposalEvent: "session_shutdown",
		},
	])(
		`${kind} committed reload: $name`,
		async ({ reason, omitted, expectedKeys, expectedLifecycle, disposalEvent }) => {
			const fixture = await createRetirementFixture(kind, { omitted });
			try {
				const retiring = fixture.session.extensionRunner;
				await fixture.session.reload({ reason, failOnExtensionErrors: true });
				assert.notEqual(fixture.session.extensionRunner, retiring);
				assert.deepEqual(fixture.lifecycle, expectedLifecycle);
				assert.deepEqual(await fixture.host.snapshot(), expectedKeys);
				assert.deepEqual([...fixture.subscriptions], [2]);
				assert.equal(fixture.timers.size, 1);
				assert.deepEqual(
					fixture.errors.map(({ extensionPath, event, error }) => ({ extensionPath, event, error })),
					[
						{ extensionPath: "<runtime>", event: disposalEvent, error: "dispose failed: workflow.run" },
						{ extensionPath: "<runtime>", event: disposalEvent, error: "dispose failed: second" },
					],
				);
				const openedAfterReload = fixture.host.opened.length;
				const closedAfterReload = fixture.host.closed.length;
				if (kind === "engine") {
					assert.deepEqual(fixture.host.opened, [...fixture.keys, ...expectedKeys.keys()]);
					for (const id of fixture.host.openedIds.slice(0, 3)) {
						assert.equal(fixture.host.closed.filter((componentId) => componentId === id).length, 1);
					}
				}
				await expectRetiredOwnerSilenced(fixture, retiring);
				if (kind === "engine") {
					assert.equal(fixture.host.opened.length, openedAfterReload);
					assert.equal(fixture.host.closed.length, closedAfterReload);
				}
				await fixture.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				assert.equal(fixture.subscriptions.size, 0);
				assert.equal(fixture.timers.size, 0);
			} finally {
				await fixture.dispose();
			}
		},
	);

	test(`${kind} rejected candidate keeps the retiring owner live`, async () => {
		const fixture = await createRetirementFixture(kind, { rejectCandidate: true });
		try {
			const before = await fixture.host.snapshot();
			assert.equal(before.size, 3);
			const retiring = fixture.session.extensionRunner;
			const openedBefore = [...fixture.host.opened];
			const closedBefore = [...fixture.host.closed];
			await assert.rejects(() => fixture.session.reload({ failOnExtensionErrors: true }), /candidate rejected/);
			assert.equal(fixture.session.extensionRunner, retiring);
			assert.deepEqual(await fixture.host.snapshot(), before);
			assert.deepEqual(fixture.disposed, []);
			assert.deepEqual(fixture.lifecycle, ["start:1", "start:2", "stop:2"]);
			assert.deepEqual([...fixture.subscriptions], [1]);
			assert.equal(fixture.timers.size, 1);
			fixture.held[1].setWidget("candidate resurrection", () => ({ render: () => ["stale"], invalidate() {} }));
			assert.throws(() => fixture.contexts[1].ui, /no longer active|stale|reload/i);
			if (kind === "engine") {
				assert.deepEqual(fixture.host.opened, openedBefore);
				assert.deepEqual(fixture.host.closed, closedBefore);
			}
			await expectRetiredOwnerSilenced(fixture, retiring);
		} finally {
			await fixture.dispose();
		}
	});

	test(`${kind} hide retry after a throwing dispose releases the key once`, async () => {
		const fixture = await createRetirementFixture(kind);
		try {
			assert.equal((await fixture.host.snapshot()).size, 3);
			const retiring = fixture.session.extensionRunner;
			assert.throws(() => fixture.held[0].setWidget("workflow.run", undefined), /dispose failed/);
			fixture.held[0].setWidget("workflow.run", undefined);
			assert.deepEqual(
				await fixture.host.snapshot(),
				new Map([
					["second", ["second:1"]],
					["healthy", ["healthy:1"]],
				]),
			);
			await expectRetiredOwnerSilenced(fixture, retiring);
		} finally {
			await fixture.dispose();
		}
	});

	test(`${kind} host release reports throwing disposals once`, async () => {
		const fixture = await createRetirementFixture(kind);
		try {
			assert.equal((await fixture.host.snapshot()).size, 3);
			const retiring = fixture.session.extensionRunner;
			const releases: string[] = [];
			for (const key of fixture.keys) fixture.host.ui.onWidgetRelease!(key, () => releases.push(key));
			fixture.host.release();
			assert.deepEqual(fixture.host.reported, ["dispose failed: workflow.run", "dispose failed: second"]);
			if (kind === "engine") {
				assert.deepEqual(fixture.disposed, ["workflow.run:1", "second:1", "healthy:1"]);
			}
			fixture.host.release();
			assert.equal(fixture.host.reported.length, 2);
			assert.equal((await fixture.host.snapshot()).size, 0);
			if (kind === "local") assert.deepEqual(releases.sort(), [...fixture.keys].sort());
			await expectRetiredOwnerSilenced(fixture, retiring);
		} finally {
			await fixture.dispose();
		}
	});

	test.each([
		{ name: "no reentry", reentrantKey: undefined, throwingDispose: true, expectedErrors: 2 },
		{
			name: "reentrant same key",
			reentrantKey: "workflow.run" as const,
			throwingDispose: false,
			expectedErrors: 0,
		},
		{
			name: "reentrant same key throwing",
			reentrantKey: "workflow.run" as const,
			throwingDispose: true,
			expectedErrors: 2,
		},
		{ name: "reentrant new key", reentrantKey: "new" as const, throwingDispose: false, expectedErrors: 0 },
		{
			name: "reentrant new key throwing",
			reentrantKey: "new" as const,
			throwingDispose: true,
			expectedErrors: 2,
		},
	])(`${kind} old-owner invalidation: $name`, async ({ reentrantKey, throwingDispose, expectedErrors }) => {
		const fixture = await createRetirementFixture(kind, { reentrantKey, throwingDispose });
		try {
			assert.equal((await fixture.host.snapshot()).size, 3);
			const retiring = fixture.session.extensionRunner;
			const openedIds = [...fixture.host.openedIds];
			await expectRetiredOwnerSilenced(fixture, retiring);
			assert.equal(fixture.errors.length, expectedErrors);
			assert.deepEqual(fixture.disposed, ["workflow.run:1", "second:1", "healthy:1"]);
			assert.throws(() => fixture.contexts[0].ui, /no longer active|stale|reload/i);
			if (kind === "engine") {
				for (const id of openedIds) {
					assert.equal(fixture.host.closed.filter((componentId) => componentId === id).length, 1);
				}
				const closed = fixture.host.closed.length;
				retiring.invalidate();
				assert.equal(fixture.host.closed.length, closed);
			}
		} finally {
			await fixture.dispose();
		}
	});
}

test("engine host release through engine_custom_dispose reports each throwing disposal once and releases keys in order", async () => {
	const fixture = await createRetirementFixture("engine");
	try {
		assert.equal((await fixture.host.snapshot()).size, 3);
		const retiring = fixture.session.extensionRunner;
		const releases: string[] = [];
		const openedIds = [...fixture.host.openedIds];
		for (const key of fixture.keys) fixture.host.ui.onWidgetRelease!(key, () => releases.push(key));
		for (const componentId of openedIds) {
			assert.equal(fixture.host.disposeRemote(componentId), true);
			fixture.host.disposeRemote(componentId);
		}
		assert.deepEqual(fixture.host.reported, ["dispose failed: workflow.run", "dispose failed: second"]);
		assert.deepEqual(releases, [...fixture.keys]);
		await expectRetiredOwnerSilenced(fixture, retiring);
		assert.deepEqual(fixture.disposed, ["workflow.run:1", "second:1", "healthy:1"]);
		for (const id of openedIds) {
			assert.equal(fixture.host.closed.filter((componentId) => componentId === id).length, 1);
		}
	} finally {
		await fixture.dispose();
	}
});

// PR #2700: engine.dispose() clears widgetIds before pending factories settle, so a throwing
// dispose on the never-opened component must still reach the extension error sink.
test("engine shutdown reports disposal errors from widgets that never opened", async () => {
	const frames: string[] = [];
	const disposed: string[] = [];
	const reported: ExtensionError[] = [];
	const engine = new EngineCustomUiService(
		(line) => frames.push(line),
		new KeybindingsManager(),
		(error) => reported.push(error),
	);
	engine.setWidget("pending", () => ({
		render: () => ["pending"],
		invalidate() {},
		dispose() {
			disposed.push("pending");
			throw new Error("dispose failed: pending");
		},
	}));
	engine.dispose();
	assert.equal(frames.filter((line) => line.includes('"engine_custom_open"')).length, 0);
	assert.deepEqual(disposed, []);
	assert.deepEqual(reported, []);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.deepEqual(disposed, ["pending"]);
	assert.deepEqual(
		reported.map(({ extensionPath, event, error }) => ({ extensionPath, event, error })),
		[{ extensionPath: "<runtime>", event: "session_shutdown", error: "dispose failed: pending" }],
	);
	assert.equal(frames.filter((line) => line.includes('"engine_custom_open"')).length, 0);
	engine.dispose();
	assert.equal(reported.length, 1);
});
