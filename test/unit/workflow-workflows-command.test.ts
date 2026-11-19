// @ts-nocheck

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { handleWorkflowsCommand, openWorkflowRun } from "../../packages/workflows/src/extension/workflow-open-run.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { stripVTControlCharacters as stripAnsi } from "../helpers/visible-text.ts";
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
	it("with no runs shows a top-edged empty sheet without inactive search and closes on Esc (#5224)", async () => {
		const t = harness();
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, { overlay: t.overlay, store: storeWith([]) });
		await Promise.resolve();
		assert.equal(t.pickers.length, 1, "the sheet replaces the editor");
		let closed = 0;
		const sheet = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {
			closed += 1;
		});
		for (const width of [80, 160]) {
			assert.deepEqual(
				sheet.render(width).map((line) => stripAnsi(line).trimEnd()),
				["▔".repeat(width), "  Workflows", "  No workflows in this session.", "  esc to close"],
			);
		}
		sheet.handleInput("x");
		sheet.handleInput("\r");
		assert.equal(closed, 0, "inactive search and Enter do not act on an empty sheet");
		assert.doesNotMatch(stripAnsi(sheet.render(80).join("\n")), /Search|matches|clear/);
		sheet.handleInput("\x1b");
		assert.equal(closed, 1);
		await pending;
		assert.deepEqual(t.messages.info, [], "nothing is printed to the chat");
		assert.equal(t.opened.length, 0);
	});

	it("with no runs and no interactive surface prints the one line instead (#5224)", async () => {
		const t = harness();
		await handleWorkflowsCommand("", { hasUI: false, ui: {} }, t.reporter, {
			overlay: t.overlay,
			store: storeWith([]),
		});
		assert.deepEqual(t.messages.info, ["No workflows in this session."]);
	});

	it("with exactly one run opens its graph directly, never a picker (#5224)", async () => {
		const t = harness();
		await handleWorkflowsCommand("", t.ctx, t.reporter, { overlay: t.overlay, store: storeWith(["run-1"]) });
		assert.equal(t.opened.length, 1);
		assert.equal(t.opened[0].runId, "run-1");
		assert.equal(t.pickers.length, 0);
	});

	it("with several runs lists them, and the graph picked from the list returns to it (#5224)", async () => {
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

	it("returns to the sheet when only the opened run remains (#5224)", async () => {
		const t = harness();
		const store = createStore();
		store.recordRunStart({ ...makeRun([]), id: "aaaaaaaa", startedAt: 1 });
		store.recordRunStart({ ...makeRun([]), id: "bbbbbbbb", startedAt: 2 });
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
			overlay: t.overlay,
			store,
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
		assert.match(returned.render(100).join("\n"), /bbbbbbbb/);
		returned.handleInput("\x1b");
		returned.dispose?.();
		component.dispose?.();
	});

	it("reports a reopened sheet failure instead of leaving its error unhandled (#5224)", async () => {
		const t = harness();
		const unhandled = [];
		const onUnhandled = (reason) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const store = createStore();
			store.recordRunStart({ ...makeRun([]), id: "aaaaaaaa", startedAt: 1 });
			store.recordRunStart({ ...makeRun([]), id: "bbbbbbbb", startedAt: 2 });
			const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
				overlay: t.overlay,
				store,
			});
			const first = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
			first.render(100);
			first.handleInput("\r");
			await pending;
			t.overlay.open = () => {
				throw new Error("reopen failed");
			};
			t.opened[0].options.onReturn();
			await Promise.resolve();
			const reopened = t.pickers[1]({ requestRender() {} }, undefined, undefined, () => {});
			reopened.render(100);
			reopened.handleInput("\r");
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.deepEqual(unhandled, []);
			assert.deepEqual(t.messages.error, ["/workflows failed: reopen failed"]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("back from a run's graph, the list opens again with that run selected, not the first row (#5224)", async () => {
		const t = harness();
		const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
			overlay: t.overlay,
			store: storeWith(["run-1", "run-2", "run-3"]),
		});
		await Promise.resolve();
		const first = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
		first.render(120);
		first.handleInput("\x1b[B");
		first.handleInput("\r");
		await pending;
		const chosen = t.opened[0].runId;
		t.opened[0].options.onReturn();
		await new Promise((resolve) => setTimeout(resolve, 0));
		const again = t.pickers[1]({ requestRender() {} }, undefined, undefined, () => {});
		again.render(120);
		again.handleInput("\r");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(t.opened[1].runId, chosen, "Enter at once reopens the same run");
	});

	it("names a run directly, and refuses an unknown one with the session's runs (#5224)", async () => {
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

	it("opens a named stage's chat when a second token names a stage, and refuses an unknown stage (#5224)", async () => {
		const t = harness();
		const runId = "11111111-1111-4111-8111-111111111111";
		const store = storeWith([runId]);
		await handleWorkflowsCommand(`${runId} A`, t.ctx, t.reporter, { overlay: t.overlay, store });
		await handleWorkflowsCommand(`${runId.slice(0, 8)}\tA`, t.ctx, t.reporter, { overlay: t.overlay, store });
		assert.deepEqual(t.messages.error, []);
		assert.deepEqual(
			t.opened.map(({ runId: id, stageId, stageRunId }) => ({ runId: id, stageId, stageRunId })),
			[
				{ runId, stageId: "A", stageRunId: runId },
				{ runId, stageId: "A", stageRunId: runId },
			],
		);
		await handleWorkflowsCommand(`${runId} missing`, t.ctx, t.reporter, { overlay: t.overlay, store });
		assert.match(t.messages.error[0], /Stage not found in run/);
	});

	it("without an interactive surface prints the list instead of opening anything (#5224)", async () => {
		const t = harness();
		await handleWorkflowsCommand("", { hasUI: false, ui: {} }, t.reporter, {
			overlay: t.overlay,
			store: storeWith(["run-1"]),
		});
		assert.equal(t.opened.length, 0);
		assert.equal(t.messages.info.length, 1);
	});

	it("prints retained runs when the host cannot mount the session sheet (#5224)", async () => {
		const t = harness();
		await handleWorkflowsCommand("", { hasUI: true, ui: {} }, t.reporter, {
			overlay: t.overlay,
			store: storeWith(["run-1", "run-2"]),
		});
		assert.equal(t.messages.info.length, 1);
		assert.match(t.messages.info[0], /wf-run-1/);
		assert.match(t.messages.info[0], /wf-run-2/);
		assert.deepEqual(t.opened, []);
		assert.deepEqual(t.pickers, []);
	});

	it("openWorkflowRun passes the opener's way back to the graph (#5224)", () => {
		const t = harness();
		const onReturn = () => {};
		openWorkflowRun("run-1", t.ctx, { overlay: t.overlay }, { onReturn });
		assert.equal(t.opened[0].options.onReturn, onReturn);
		openWorkflowRun("run-1", { ui: {} }, { overlay: t.overlay });
		assert.equal(t.opened[1].surface, undefined, "without its own surface the session's is used");
	});
});

it("does not open a replacement run when the painted run disappears before another frame (#5224)", async () => {
	const t = harness();
	const store = createStore();
	store.recordRunStart({ ...makeRun([]), id: "aaaaaaaa", startedAt: 1 });
	store.recordRunStart({ ...makeRun([]), id: "bbbbbbbb", startedAt: 2 });
	const pending = handleWorkflowsCommand("", t.ctx, t.reporter, {
		overlay: t.overlay,
		store,
	});
	const component = t.pickers[0]({ requestRender() {} }, undefined, undefined, () => {});
	try {
		assert.match(component.render(100).join("\n"), /bbbbbbbb/);
		store.removeRun("bbbbbbbb");
		component.handleInput("\r");
		await Promise.resolve();
		assert.deepEqual(t.opened, []);
		component.render(100);
		component.handleInput("\r");
		await pending;
		assert.equal(t.opened.length, 1);
		assert.equal(t.opened[0].runId, "aaaaaaaa");
	} finally {
		component.dispose?.();
	}
});
