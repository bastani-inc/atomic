// @ts-nocheck

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { bindStoreDurableBackend } from "../../packages/workflows/src/durable/store-backend.js";
import { createToolControlRegistry } from "../../packages/workflows/src/engine/run-tool-control-registry.js";
import { createExtensionRuntime } from "../../packages/workflows/src/extension/runtime.js";
import { registerWorkflowSlashCommand } from "../../packages/workflows/src/extension/workflow-command-registration.js";
import { handleWorkflowsCommand, openWorkflowRun } from "../../packages/workflows/src/extension/workflow-open-run.js";
import { createJobTracker } from "../../packages/workflows/src/runs/background/job-tracker.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { workflow } from "../../packages/workflows/src/sdk-surface.js";
import { StageUiBroker } from "../../packages/workflows/src/shared/stage-ui-broker.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";
import * as h from "./overlay-graph-helpers.js";

const { makeStage, makeRun, makeStore } = h;

function storeWith(runIds) {
	return makeStore({
		runs: runIds.map((id) => ({ ...makeRun([makeStage("A")]), id, name: `wf-${id}` })),
		notices: [],
		version: 1,
	});
}

function harness() {
	initTheme("dark");
	const opened = [];
	const messages = { info: [], error: [] };
	const pickers = [];
	const ctx = {
		hasUI: true,
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					pickers.push((tui, theme, keys, done) =>
						factory(tui, theme, keys, (result) => {
							done(result);
							resolve(result);
						}),
					);
				}),
		},
	};
	const overlay = {
		open: (runId, surface, stageId, stageRunId, options) =>
			opened.push({ runId, surface, stageId, stageRunId, options }),
	};
	const reporter = { info: (m) => messages.info.push(m), error: (m) => messages.error.push(m) };
	return { opened, messages, pickers, ctx, overlay, reporter };
}

describe("/workflows (#5224)", () => {
	it("with no runs says so, and opens nothing", async () => {
		const t = harness();
		await handleWorkflowsCommand("", t.ctx, t.reporter, { overlay: t.overlay, store: storeWith([]) });
		assert.deepEqual(t.messages.info, ["No workflows in this session."]);
		assert.equal(t.opened.length, 0);
		assert.equal(t.pickers.length, 0);
	});

	it("with exactly one run opens its graph directly, never a picker", async () => {
		const t = harness();
		await handleWorkflowsCommand("", t.ctx, t.reporter, { overlay: t.overlay, store: storeWith(["run-1"]) });
		assert.equal(t.opened.length, 1);
		assert.equal(t.opened[0].runId, "run-1");
		assert.equal(t.pickers.length, 0);
	});

	it("with several runs lists them, and the graph picked from the list returns to it", async () => {
		const t = harness();
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
			overlay: t.overlay,
			store: storeWith(["run-1", "run-2"]),
		});
		await Promise.resolve();
		assert.equal(t.pickers.length, 1, "several runs open a list");
		assert.equal(t.opened.length, 0);
		const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
		component.render(100);
		component.handleInput("\r");
		await pending;
		assert.equal(t.opened.length, 1, "Enter on a row opens that run's graph");
		assert.equal(typeof t.opened[0].options?.onReturn, "function", "Esc at the graph's top goes back to the list");
		t.opened[0].options.onReturn();
		await Promise.resolve();
		assert.equal(t.pickers.length, 2, "returning reopens the list");
	});

	it("returns to the sheet when only the opened run remains (#5245)", async () => {
		const t = harness();
		const store = createStore();
		store.recordRunStart({ ...makeRun([]), id: "aaaaaaaa", startedAt: 1 });
		store.recordRunStart({ ...makeRun([]), id: "bbbbbbbb", startedAt: 2 });
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
			overlay: t.overlay,
			store,
			definitions: () => [{ normalizedName: "deploy", description: "Deploy", inputs: {} }],
		});
		const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
		component.render(100);
		component.handleInput("\r");
		await pending;
		assert.equal(t.opened[0].runId, "bbbbbbbb");
		store.removeRun("aaaaaaaa");
		t.opened[0].options.onReturn();
		await Promise.resolve();
		assert.equal(t.opened.length, 1, "return must not open the same graph again");
		assert.equal(t.pickers.length, 2);
		const returned = t.pickers[1]({ requestRender() {} }, undefined, undefined, () => {});
		assert.match(returned.render(100).join("\n"), /Definitions/);
		returned.handleInput("\x1b");
		returned.dispose?.();
		component.dispose?.();
	});

	it("names a run directly, and refuses an unknown one with the session's runs", async () => {
		const t = harness();
		const first = "11111111-1111-4111-8111-111111111111";
		const second = "22222222-2222-4222-8222-222222222222";
		const store = storeWith([first, second]);
		await handleWorkflowsCommand("22222222", t.ctx, t.reporter, { overlay: t.overlay, store });
		assert.deepEqual(t.messages.error, []);
		assert.equal(t.opened[0].runId, second, "a run-id prefix opens that run");
		await handleWorkflowsCommand("33333333", t.ctx, t.reporter, { overlay: t.overlay, store });
		assert.match(t.messages.error[0], /Run not found: 33333333/);
	});

	it("without an interactive surface prints the list instead of opening anything", async () => {
		const t = harness();
		await handleWorkflowsCommand("", { hasUI: false, ui: {} }, t.reporter, {
			overlay: t.overlay,
			store: storeWith(["run-1"]),
		});
		assert.equal(t.opened.length, 0);
		assert.equal(t.messages.info.length, 1);
	});

	it("with no runs but registered definitions opens the sheet, and Enter on a definition starts it", async () => {
		initTheme("dark");
		const t = harness();
		const started = [];
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
			overlay: t.overlay,
			store: storeWith([]),
			definitions: () => [{ normalizedName: "ralph", description: "iterate a fix", inputs: {} }],
			startDefinition: async (name) => {
				started.push(name);
			},
		});
		await Promise.resolve();
		assert.equal(t.pickers.length, 1, "definitions to start open the sheet");
		const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
		const text = component.render(80).join("\n");
		assert.match(text, /Definitions/);
		assert.match(text, /ralph/);
		component.handleInput("\r");
		await pending;
		assert.deepEqual(started, ["ralph"]);
		assert.equal(t.opened.length, 0);
		assert.deepEqual(t.messages.info, []);
	});

	it("lists definitions below several runs, and Esc closes the sheet without opening anything", async () => {
		initTheme("dark");
		const t = harness();
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
			overlay: t.overlay,
			store: storeWith(["run-1", "run-2"]),
			definitions: () => [{ normalizedName: "ralph", description: "iterate a fix", inputs: {} }],
		});
		await Promise.resolve();
		const component = t.pickers[0]({ requestRender() {}, terminal: { rows: 40 } }, undefined, undefined, () => {});
		const text = component.render(100).join("\n");
		assert.ok(text.indexOf("Definitions") >= 0, "the viewport fits both groups");
		assert.ok(text.indexOf("Runs") < text.indexOf("Definitions"), "runs come first");
		component.handleInput("\x1b");
		await pending;
		assert.equal(t.opened.length, 0);
	});

	it("openWorkflowRun passes the opener's way back to the graph", () => {
		const t = harness();
		const onReturn = () => {};
		assert.equal(openWorkflowRun("run-1", t.ctx, { overlay: t.overlay }, { onReturn }), true);
		assert.equal(t.opened[0].options.onReturn, onReturn);
		assert.equal(openWorkflowRun("run-1", { ui: {} }, { overlay: t.overlay }), false);
	});
});

it("does not start a zero-input definition when the painted runs disappear (#5245/#5224)", async () => {
	const t = harness();
	const store = createStore();
	store.recordRunStart({ ...makeRun([]), id: "aaaaaaaa", startedAt: 1 });
	store.recordRunStart({ ...makeRun([]), id: "bbbbbbbb", startedAt: 2 });
	const started = [];
	const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
		overlay: t.overlay,
		store,
		definitions: () => [{ normalizedName: "deploy", description: "Deploy without inputs", inputs: {} }],
		startDefinition: async (name) => {
			started.push(name);
		},
	});
	const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
	try {
		assert.match(component.render(100).join("\n"), /bbbbbbbb/);
		store.removeRun("bbbbbbbb");
		store.removeRun("aaaaaaaa");
		component.handleInput("\r");
		await Promise.resolve();
		assert.deepEqual(started, []);
		assert.deepEqual(t.opened, []);
		component.render(100);
		component.handleInput("\r");
		await pending;
		assert.deepEqual(started, ["deploy"]);
	} finally {
		component.dispose?.();
	}
});

it("starts a definition named status from the /workflows sheet instead of running /workflow status (#5245)", async () => {
	const t = harness();
	const store = createStore();
	const backend = await createMemoryTestBackend();
	bindStoreDurableBackend(store, backend);
	const owner = {
		store,
		jobs: createJobTracker(),
		stageControlRegistry: createStageControlRegistry(),
		toolControlRegistry: createToolControlRegistry(),
		stageUiBroker: new StageUiBroker(store),
	};
	let ran = 0;
	const statusDefinition = workflow({
		name: "status",
		description: "Check service health",
		inputs: {},
		outputs: {},
		async run() {
			ran++;
			return {};
		},
	});
	const runtime = createExtensionRuntime({ ...owner, definitions: [statusDefinition] });
	const dispatches = [];
	const originalDispatch = runtime.dispatch.bind(runtime);
	runtime.dispatch = (args, opts) => {
		dispatches.push(args);
		return originalDispatch(args, opts);
	};
	const surfaces = [];
	const handlers = new Map();
	const graphOverlay = { open: t.overlay.open, toggle() {}, close() {} };
	const pi = {
		registerCommand() {},
		sendMessage(msg) {
			if (msg?.details) surfaces.push(msg.details);
		},
	};
	registerWorkflowSlashCommand(pi, handlers, {
		runtimeProxy: runtime,
		runtimeForContext: () => runtime,
		overlay: graphOverlay,
		owner,
		reloadWorkflowResources: () => undefined,
		ensureWorkflowResourcesLoaded: () => undefined,
		runWithLifecycleSuppressedForPolicy: (_policy, action) => action(),
		runControl: {
			pi,
			overlay: graphOverlay,
			runtimeForContext: () => runtime,
			ensureWorkflowResourcesLoaded: () => undefined,
			owner,
		},
	});
	const ctx = {
		...t.ctx,
		cwd: process.cwd(),
		ui: {
			...t.ctx.ui,
			notify: (m) => t.messages.info.push(m),
		},
	};
	const pending = handlers.get("workflows")("", ctx);
	await Promise.resolve();
	assert.equal(t.pickers.length, 1);
	const component = t.pickers[0](
		{ requestRender() {}, terminal: { rows: 40, columns: 100 } },
		undefined,
		undefined,
		() => {},
	);
	try {
		assert.match(component.render(100).join("\n"), /status/);
		component.handleInput("\r");
		await pending;
		await Promise.all(owner.jobs.runIds().map((id) => owner.jobs.get(id)?.promise));
		assert.equal(
			dispatches.some((entry) => entry.action === "run" && entry.workflow === "status"),
			true,
		);
		assert.equal(surfaces.length, 1);
		assert.equal(surfaces[0].kind, "dispatch");
		assert.equal(surfaces[0].workflowName, "status");
		assert.equal(ran, 1);
	} finally {
		component.dispose?.();
		await backend.close?.();
	}
});
