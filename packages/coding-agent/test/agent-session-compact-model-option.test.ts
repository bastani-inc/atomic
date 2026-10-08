import assert from "node:assert/strict";
import { afterEach, describe, it } from "vitest";
import { createHarness, fauxModel, type Harness } from "./test-harness.js";

const longPrompt = Array.from({ length: 24 }, (_, i) => `context line ${i}`).join("\n");
const plannerModel = { ...fauxModel, id: "faux-planner", name: "Faux Planner" };

describe("session.compact({ compactionModel })", () => {
	const harnesses: Harness[] = [];
	afterEach(() => {
		for (const harness of harnesses.splice(0)) harness.cleanup();
	});

	async function harnessWithPlanner(responses: string[]): Promise<Harness> {
		const harness = await createHarness({
			settings: { compaction: { enabled: false, preserve_recent: 0 } },
			responses,
		});
		harnesses.push(harness);
		harness.session.modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			apiKey: "faux-key",
			api: fauxModel.api,
			models: [fauxModel, plannerModel],
		});
		return harness;
	}

	it("plans with the requested model for this run without saving the setting", async () => {
		const harness = await harnessWithPlanner(["first response", "1:2,6\n"]);
		await harness.session.prompt(longPrompt);

		const result = await harness.session.compact({ compactionModel: "faux/faux-planner" });

		assert.equal(result.backend, "planner");
		assert.equal(result.model, "faux/faux-planner");
		assert.equal(harness.settingsManager.getCompactionModel(), "");
	});

	it("rejects an unknown model before interrupting the session", async () => {
		const harness = await harnessWithPlanner(["first response"]);
		await harness.session.prompt(longPrompt);

		await assert.rejects(harness.session.compact({ compactionModel: "faux/missing" }), /Invalid compactionModel/);
		assert.equal(harness.eventsOfType("compaction_start").length, 0);
	});
});
