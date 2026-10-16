import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { SessionConflictError } from "../src/core/storage/session/errors.ts";
import { createHarness } from "./suite/harness.ts";

test("the last overlapping thinking choice wins in state and settings (#3678)", async () => {
	const harness = await createHarness({ models: [{ id: "reasoning", reasoning: true }] });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const append = harness.sessionManager.appendThinkingLevelChange.bind(harness.sessionManager);
	vi.spyOn(harness.sessionManager, "appendThinkingLevelChange").mockImplementationOnce(async (level) => {
		entered.resolve();
		await release.promise;
		return append(level);
	});
	const first = harness.session.setThinkingLevel("high", { persist: true });
	await entered.promise;
	const last = harness.session.setThinkingLevel("off", { persist: true });
	release.resolve();
	try {
		await Promise.all([first, last]);
		assert.equal(harness.session.thinkingLevel, "off");
		assert.equal(harness.settingsManager.getDefaultThinkingLevel(), "off");
		assert.equal(harness.settingsManager.getModelThinkingLevel(harness.getModel().provider, "reasoning"), "off");
		assert.deepEqual(
			harness.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "thinking_level_change")
				.map((entry) => entry.thinkingLevel),
			["high", "off"],
		);
	} finally {
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});

for (const scoped of [false, true]) {
	test(`overlapping ${scoped ? "scoped" : "available"} model cycles advance in call order (#3678)`, async () => {
		const harness = await createHarness({ models: [{ id: "one" }, { id: "two" }, { id: "three" }] });
		if (scoped) harness.session.setScopedModels(harness.models.map((model) => ({ model })));
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const append = harness.sessionManager.appendModelChange.bind(harness.sessionManager);
		vi.spyOn(harness.sessionManager, "appendModelChange").mockImplementationOnce(async (...args) => {
			entered.resolve();
			await release.promise;
			return append(...args);
		});
		const first = harness.session.cycleModel("forward", { persist: true });
		await entered.promise;
		const second = harness.session.cycleModel("forward", { persist: true });
		await new Promise<void>((resolve) => setImmediate(resolve));
		release.resolve();
		try {
			const results = await Promise.all([first, second]);
			assert.deepEqual(
				results.map((result) => result?.model.id),
				["two", "three"],
			);
			assert.equal(harness.session.model?.id, "three");
			assert.equal(harness.settingsManager.getDefaultModel(), "three");
		} finally {
			vi.restoreAllMocks();
			await harness.cleanup();
		}
	});
}

test("overlapping thinking cycles each advance from the committed choice (#3678)", async () => {
	const harness = await createHarness({ models: [{ id: "reasoning", reasoning: true }] });
	const levels = harness.session.getAvailableThinkingLevels();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const append = harness.sessionManager.appendThinkingLevelChange.bind(harness.sessionManager);
	vi.spyOn(harness.sessionManager, "appendThinkingLevelChange").mockImplementationOnce(async (level) => {
		entered.resolve();
		await release.promise;
		return append(level);
	});
	const first = harness.session.cycleThinkingLevel({ persist: true });
	await entered.promise;
	const second = harness.session.cycleThinkingLevel({ persist: true });
	release.resolve();
	try {
		assert.deepEqual(await Promise.all([first, second]), [levels[1], levels[2]]);
		assert.equal(harness.session.thinkingLevel, levels[2]);
		assert.equal(harness.settingsManager.getDefaultThinkingLevel(), levels[2]);
	} finally {
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});

test("a model refresh cannot overwrite a later explicit model selection (#3678)", async () => {
	const harness = await createHarness({
		models: [
			{ id: "one", reasoning: true },
			{ id: "two", reasoning: true },
		],
	});
	await harness.session.setThinkingLevel("high");
	const original = harness.getModel("one")!;
	const refreshed = { ...original, reasoning: false };
	const lookup = harness.session.modelRuntime.getModel.bind(harness.session.modelRuntime);
	vi.spyOn(harness.session.modelRuntime, "getModel").mockImplementation((provider, id) =>
		id === "one" ? refreshed : lookup(provider, id),
	);
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const append = harness.sessionManager.appendThinkingLevelChange.bind(harness.sessionManager);
	vi.spyOn(harness.sessionManager, "appendThinkingLevelChange").mockImplementationOnce(async (level) => {
		entered.resolve();
		await release.promise;
		return append(level);
	});
	const refresh = harness.session.refreshCurrentModelFromRegistry();
	await entered.promise;
	const selection = harness.session.setModel(harness.getModel("two")!, { persist: true });
	await new Promise<void>((resolve) => setImmediate(resolve));
	release.resolve();
	try {
		await Promise.all([refresh, selection]);
		assert.equal(harness.session.model?.id, "two");
		assert.equal(harness.settingsManager.getDefaultModel(), "two");
	} finally {
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});

test("a rejected choice preserves its typed error and does not poison the next choice (#3678)", async () => {
	const harness = await createHarness({ models: [{ id: "reasoning", reasoning: true }] });
	const failure = new SessionConflictError(harness.session.sessionId, 1, 2);
	vi.spyOn(harness.sessionManager, "appendThinkingLevelChange").mockRejectedValueOnce(failure);
	try {
		const first = harness.session.setThinkingLevel("high", { persist: true });
		const last = harness.session.setThinkingLevel("low", { persist: true });
		await assert.rejects(first, (error) => error === failure);
		await last;
		assert.equal(harness.session.thinkingLevel, "low");
		assert.equal(harness.settingsManager.getDefaultThinkingLevel(), "low");
	} finally {
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});

test("model-select handlers can await a subsequent choice without deadlocking the choice queue (#3678)", async () => {
	const harness = await createHarness({
		models: [
			{ id: "one", reasoning: true },
			{ id: "two", reasoning: true },
		],
		extensionFactories: [
			(pi) => {
				pi.on("model_select", async () => {
					await pi.setThinkingLevel("low");
				});
			},
		],
	});
	try {
		await harness.session.setModel(harness.getModel("two")!);
		assert.equal(harness.session.model?.id, "two");
		assert.equal(harness.session.thinkingLevel, "low");
	} finally {
		await harness.cleanup();
	}
});
