import assert from "node:assert/strict";
import { test } from "vitest";
import { createEngineHostPair } from "./helpers/in-process-engine-pair.ts";

const models = [
	{ id: "alpha", reasoning: true },
	{ id: "beta", reasoning: true },
	{ id: "gamma", reasoning: true },
];

async function scopedPair() {
	const pair = await createEngineHostPair({ models, serializeEngineCommands: true });
	await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
	await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
	pair.engine.session.setScopedModels([
		{ model: pair.engine.getModel("alpha")! },
		{ model: pair.engine.getModel("beta")! },
	]);
	await pair.runtime.initializeFromEngine();
	await pair.drain();
	return pair;
}

test.each(["before", "during"] as const)(
	"a refresh requested %s a scope sync cannot restore the old scope in the same read (#5224)",
	async (timing) => {
		const pair = await scopedPair();
		try {
			pair.holdHostTrafficFrom((record) => record.type === "response" && record.command === "refresh_models");
			const changeScope = () => pair.runtime.session.setScopedModels([{ model: pair.engine.getModel("gamma")! }]);
			if (timing === "during") changeScope();
			const refresh = pair.runtime.session.modelRuntime.refresh({ allowNetwork: false });
			if (timing === "before") changeScope();
			await pair.drain();
			assert.deepEqual(
				pair.commandsReceived.slice(-2).map(({ type }) => type),
				["refresh_models", "set_scoped_models"],
			);
			await pair.releaseHostTraffic();
			await refresh;
			await pair.drain();

			assert.deepEqual(
				pair.engine.session.scopedModels.map(({ model }) => model.id),
				["gamma"],
			);
			assert.deepEqual(
				pair.runtime.session.scopedModels.map(({ model }) => model.id),
				["gamma"],
			);
			assert.equal((await pair.runtime.session.cycleModel("forward"))?.model.id, "gamma");
		} finally {
			await pair.releaseHostTraffic();
			await pair.cleanup();
		}
	},
);

test.each(["before", "during"] as const)(
	"refresh requested %s a queued scope sync keeps the chosen scope behind a thinking change (#5224)",
	async (timing) => {
		const pair = await scopedPair();
		try {
			pair.holdHostTrafficFrom((record) => record.type === "response" && record.command === "set_thinking_level");
			const thinking = pair.runtime.session.setThinkingLevel("high");
			await pair.drain();
			const changeScope = () => pair.runtime.session.setScopedModels([{ model: pair.engine.getModel("gamma")! }]);
			if (timing === "during") changeScope();
			const refresh = pair.runtime.session.modelRuntime.refresh({ allowNetwork: false });
			if (timing === "before") changeScope();
			await pair.drain();
			assert.equal(pair.commandsReceived.at(-1)?.type, "refresh_models");
			await pair.releaseHostTraffic();
			await refresh;
			assert.deepEqual(
				pair.runtime.session.scopedModels.map(({ model }) => model.id),
				["gamma"],
			);
			await thinking;
			await pair.drain();
			assert.deepEqual(
				pair.engine.session.scopedModels.map(({ model }) => model.id),
				["gamma"],
			);
			assert.deepEqual(
				pair.runtime.session.scopedModels.map(({ model }) => model.id),
				["gamma"],
			);
		} finally {
			await pair.releaseHostTraffic();
			await pair.cleanup();
		}
	},
);

test("a failed scope sync does not block a later authoritative catalog (#5224)", async () => {
	const pair = await scopedPair();
	try {
		pair.failCommand("set_scoped_models", "scope could not be saved");
		pair.runtime.session.setScopedModels([{ model: pair.engine.getModel("gamma")! }]);
		await pair.drain();
		assert.deepEqual(
			pair.runtime.session.scopedModels.map(({ model }) => model.id),
			["gamma"],
		);
		await pair.runtime.session.modelRuntime.refresh({ allowNetwork: false });
		assert.deepEqual(
			pair.runtime.session.scopedModels.map(({ model }) => model.id),
			["alpha", "beta"],
		);
	} finally {
		await pair.cleanup();
	}
});
