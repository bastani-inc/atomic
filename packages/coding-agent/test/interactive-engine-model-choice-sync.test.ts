import assert from "node:assert/strict";
import { afterEach, test } from "vitest";
import { createEngineHostPair, type EngineHostPair } from "./helpers/in-process-engine-pair.ts";

const pairs: EngineHostPair[] = [];

afterEach(async () => {
	while (pairs.length > 0) await pairs.pop()?.cleanup();
});

async function modelPair(changeLevelOnSelect = false) {
	const pair = await createEngineHostPair({
		models: [
			{ id: "current-model", reasoning: true },
			{ id: "other-model", reasoning: true },
		],
		engineExtensions: changeLevelOnSelect
			? [
					(pi) => {
						pi.on("model_select", () => pi.setThinkingLevel("low"));
					},
				]
			: [],
	});
	pairs.push(pair);
	await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.engine.session.setThinkingLevel("medium");
	await pair.runtime.initializeFromEngine();
	await pair.drain();
	return pair;
}

test.each([false, true])(
	"model cycling keeps a newer engine thinking level with persist %s (#5237)",
	async (persist) => {
		const pair = await modelPair(true);
		const result = await pair.runtime.session.cycleModel("forward", { persist });
		await pair.drain();

		assert.deepEqual(Object.keys(result ?? {}).sort(), ["isScoped", "model", "thinkingLevel"]);
		assert.equal(result?.model.id, "other-model");
		assert.equal(result?.thinkingLevel, "medium");
		assert.equal(result?.isScoped, false);
		assert.equal(pair.engine.session.thinkingLevel, "low");
		assert.equal(pair.runtime.session.thinkingLevel, "low");
		if (persist) {
			assert.equal(pair.engine.settingsManager.getDefaultThinkingLevel(), "medium");
			assert.equal(pair.hostHarness.settingsManager.getDefaultThinkingLevel(), "medium");
		}
	},
);

test.each([false, true])(
	"model selection persists the applied level with an explicit choice %s (#5237)",
	async (explicit) => {
		const pair = await modelPair(true);
		await pair.runtime.session.setThinkingLevel("high");
		const other = pair.engine.getModel("other-model")!;
		await pair.runtime.session.setModel(other, {
			persist: true,
			...(explicit ? { thinkingLevel: "high" as const } : {}),
		});
		await pair.drain();

		assert.equal(pair.engine.session.thinkingLevel, "low");
		assert.equal(pair.runtime.session.thinkingLevel, "low");
		for (const settings of [pair.engine.settingsManager, pair.hostHarness.settingsManager]) {
			assert.equal(settings.getModelThinkingLevel(other.provider, other.id), "high");
			assert.equal(settings.getDefaultThinkingLevel(), "high");
		}
	},
);

test("model selection does not persist a transient thinking change after its answer (#5237)", async () => {
	const pair = await modelPair();
	const other = pair.engine.getModel("other-model")!;
	const answered = Promise.withResolvers<void>();
	pair.holdHostTrafficFrom((record) => {
		const matches = record.type === "response" && record.command === "set_model";
		if (matches) answered.resolve();
		return matches;
	});
	const selection = pair.runtime.session.setModel(other, { persist: true, thinkingLevel: "high" });
	try {
		await answered.promise;
		await pair.engine.session.setThinkingLevel("medium");
		await pair.drain();
	} finally {
		await pair.releaseHostTraffic();
		await selection;
	}
	await pair.drain();

	assert.equal(pair.engine.session.thinkingLevel, "medium");
	assert.equal(pair.runtime.session.thinkingLevel, "medium");
	for (const settings of [pair.engine.settingsManager, pair.hostHarness.settingsManager]) {
		assert.equal(settings.getModelThinkingLevel(other.provider, other.id), "high");
		assert.equal(settings.getDefaultThinkingLevel(), "high");
	}
});

test.each(["set", "cycle"] as const)(
	"a %s answer keeps a newer engine model in the same read (#5237)",
	async (operation) => {
		const pair = await modelPair();
		const current = pair.engine.getModel("current-model")!;
		const other = pair.engine.getModel("other-model")!;
		const answered = Promise.withResolvers<void>();
		pair.holdHostTrafficFrom((record) => {
			const matches = record.type === "response" && record.command === `${operation}_model`;
			if (matches) answered.resolve();
			return matches;
		});
		const selection =
			operation === "set" ? pair.runtime.session.setModel(other) : pair.runtime.session.cycleModel("forward");
		try {
			await answered.promise;
			await pair.engine.session.setModel(current);
			await pair.drain();
		} finally {
			await pair.releaseHostTraffic();
			await selection;
		}
		await pair.drain();

		assert.equal(pair.engine.session.model?.id, current.id);
		assert.equal(pair.runtime.session.model?.id, current.id);
	},
);
