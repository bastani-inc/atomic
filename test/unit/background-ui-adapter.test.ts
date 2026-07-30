/**
 * Tests for buildBackgroundUIAdapter — the surface that makes background
 * workflow HIL non-blocking by routing through the store instead of
 * pi.ui dialogs.
 *
 * Cross-checks the round-trip:
 *   1. Adapter records a PendingPrompt of the right kind / message
 *   2. Adapter awaits the store's resolver
 *   3. resolvePendingPrompt forwards the response, adapter resolves with it
 *
 * Includes the safety-default branch: when recordPendingPrompt rejects
 * (run missing / terminal / already prompting), the adapter resolves with
 * a kind-appropriate default rather than throwing — workflow authors should
 * not have to defensively try/catch every ctx.ui.* call.
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { buildBackgroundUIAdapter } from "../../packages/workflows/src/extension/background-ui-adapter.js";
import type { Store } from "../../packages/workflows/src/shared/store.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";

function seedRun(s: Store, id = "r1"): RunSnapshot {
	const run: RunSnapshot = {
		id,
		name: `run-${id}`,
		inputs: {},
		status: "running",
		stages: [],
		startedAt: Date.now(),
	};
	s.recordRunStart(run);
	return run;
}

function activePrompt(s: Store, runId: string) {
	const run = s.runs().find((r) => r.id === runId);
	return run?.pendingPrompt;
}

describe("buildBackgroundUIAdapter — round-trip", () => {
	test("input: records prompt, awaits, resolves to user-typed string", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.input("What is your name?");
		const prompt = activePrompt(store, "r1");
		assert.ok(prompt, "input should record a pending prompt");
		assert.equal(prompt!.kind, "input");
		assert.equal(prompt!.message, "What is your name?");
		store.resolvePendingPrompt("r1", prompt!.id, "ada");
		assert.equal(await pending, "ada");
		assert.equal(activePrompt(store, "r1"), undefined);
	});

	test("confirm: records prompt, awaits, resolves to boolean", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.confirm("Proceed?");
		const prompt = activePrompt(store, "r1");
		assert.equal(prompt?.kind, "confirm");
		store.resolvePendingPrompt("r1", prompt!.id, true);
		assert.equal(await pending, true);
	});

	test("select: records choices + resolves to a typed option", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.select("Pick", ["a", "b", "c"] as const);
		const prompt = activePrompt(store, "r1");
		assert.equal(prompt?.kind, "select");
		assert.deepEqual(prompt?.choices, ["a", "b", "c"]);
		store.resolvePendingPrompt("r1", prompt!.id, "b");
		assert.equal(await pending, "b");
	});

	test("select: falls back to first option when response isn't a valid choice", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.select("Pick", ["a", "b", "c"] as const);
		const prompt = activePrompt(store, "r1");
		store.resolvePendingPrompt("r1", prompt!.id, "not-a-choice");
		assert.equal(await pending, "a");
	});

	test("select: empty options rejects without recording a prompt", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");

		await assert.rejects(ui.select("Pick", [] as readonly string[]), /ctx\.ui\.select requires at least one option/);
		assert.equal(activePrompt(store, "r1"), undefined);
	});

	test("editor: forwards `initial` text + resolves to edited string", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.editor("starter");
		const prompt = activePrompt(store, "r1");
		assert.equal(prompt?.kind, "editor");
		assert.equal(prompt?.initial, "starter");
		store.resolvePendingPrompt("r1", prompt!.id, "edited");
		assert.equal(await pending, "edited");
	});

	test("editor: defaults to `initial` when resolved with non-string", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.editor("starter");
		const prompt = activePrompt(store, "r1");
		store.resolvePendingPrompt("r1", prompt!.id, undefined);
		assert.equal(await pending, "starter");
	});
});

describe("buildBackgroundUIAdapter — safe defaults when prompt cannot be recorded", () => {
	test("input resolves to empty string when run is missing", async () => {
		const store = createStore();
		const ui = buildBackgroundUIAdapter(store, "missing");
		assert.equal(await ui.input("hi"), "");
	});

	test("confirm resolves to false when run is terminal", async () => {
		const store = createStore();
		seedRun(store);
		store.recordRunEnd("r1", "completed");
		const ui = buildBackgroundUIAdapter(store, "r1");
		assert.equal(await ui.confirm("Proceed?"), false);
	});

	test("select resolves to the first option when prompt cannot be recorded", async () => {
		const store = createStore();
		seedRun(store);
		// Block the slot by recording an existing prompt manually.
		store.recordPendingPrompt("r1", {
			id: "existing",
			kind: "input",
			message: "blocking",
			createdAt: Date.now(),
		});
		const ui = buildBackgroundUIAdapter(store, "r1");
		assert.equal(await ui.select("Pick", ["x", "y"] as const), "x");
	});

	test("editor resolves to initial value when run is missing", async () => {
		const store = createStore();
		const ui = buildBackgroundUIAdapter(store, "missing");
		assert.equal(await ui.editor("fallback"), "fallback");
	});
});

describe("buildBackgroundUIAdapter — termination unblocks waiters", () => {
	test("recordRunEnd rejects the awaiter (does not hang)", async () => {
		const store = createStore();
		seedRun(store);
		const ui = buildBackgroundUIAdapter(store, "r1");
		const pending = ui.input("anything?");
		// give the await a microtask to register, then end the run
		await Promise.resolve();
		store.recordRunEnd("r1", "killed", undefined, "user abort");
		await assert.rejects(pending);
	});
});
