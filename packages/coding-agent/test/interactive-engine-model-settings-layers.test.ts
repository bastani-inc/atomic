import assert from "node:assert/strict";
import type { ThinkingLevel } from "@bastani/atomic-agent-core";
import { test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import { InMemorySettingsStorage, type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createEngineHostPair } from "./helpers/in-process-engine-pair.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const provider = "picker-settings-layers";
const models = [
	{ id: "current-model", reasoning: true },
	{ id: "other-model", reasoning: true },
	{ id: "third-model", reasoning: true },
];

function settingsStorage(global: Settings, project: Settings): InMemorySettingsStorage {
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify(global));
	storage.withLock("project", () => JSON.stringify(project));
	return storage;
}

type Choice = "set" | "implicit" | "cycle";
interface Scenario {
	name: string;
	project: Settings;
	choice: Choice;
	level?: ThinkingLevel;
	transientLevel?: boolean;
	scoped?: boolean;
}

const scenarios: Scenario[] = [
	{
		name: "explicit level under a project reasoning default",
		project: { defaultThinkingLevel: "high" },
		choice: "set",
		level: "low",
	},
	{
		name: "implicit level under a project reasoning default",
		project: { defaultThinkingLevel: "high" },
		choice: "implicit",
	},
	{ name: "cycling under a project reasoning default", project: { defaultThinkingLevel: "high" }, choice: "cycle" },
	{
		name: "a project startup model with a saved level",
		project: {
			defaultProvider: provider,
			defaultModel: "current-model",
			modelThinkingLevels: { [`${provider}/current-model`]: "high" },
		},
		choice: "set",
		level: "low",
	},
	{
		name: "a project per-model level",
		project: { modelThinkingLevels: { [`${provider}/other-model`]: "high" } },
		choice: "set",
		level: "low",
	},
	{
		name: "a project startup model without a saved level and a transient extension level",
		project: { defaultProvider: provider, defaultModel: "current-model" },
		choice: "set",
		level: "high",
		transientLevel: true,
	},
	{
		name: "a project startup model outside the active scope",
		project: {
			defaultProvider: provider,
			defaultModel: "current-model",
			modelThinkingLevels: { [`${provider}/current-model`]: "high" },
		},
		choice: "set",
		level: "low",
		scoped: true,
	},
];

async function initialize(harness: Harness, scoped: boolean): Promise<void> {
	await harness.session.bindExtensions({ shutdownHandler: () => {} });
	await harness.session.setThinkingLevel("medium");
	if (scoped) harness.session.setScopedModels([{ model: harness.getModel("third-model")! }]);
}

async function choose(session: AgentSession, harness: Harness, scenario: Scenario): Promise<void> {
	if (scenario.choice === "cycle") await session.cycleModel("forward", { persist: true });
	else await session.setModel(harness.getModel("other-model")!, { persist: true, thinkingLevel: scenario.level });
}

test.each(scenarios)("isolated model choices save only global preferences with $name (#5237)", async (scenario) => {
	const global: Settings = {
		defaultProvider: provider,
		defaultModel: "third-model",
		defaultThinkingLevel: "medium",
		...(scenario.scoped ? { enabledModels: [`${provider}/third-model`] } : {}),
	};
	const extensionFactories: ExtensionFactory[] = scenario.transientLevel
		? [
				(atomic) => {
					atomic.on("model_select", () => atomic.setThinkingLevel("low"));
				},
			]
		: [];
	const referenceSettings = SettingsManager.fromStorage(settingsStorage(global, scenario.project));
	const reference = await createHarness({ provider, models, settingsManager: referenceSettings, extensionFactories });
	let expected: Settings;
	try {
		await initialize(reference, scenario.scoped === true);
		await choose(reference.session, reference, scenario);
		await referenceSettings.flush();
		expected = referenceSettings.getGlobalSettings();
	} finally {
		await reference.cleanup();
	}

	const storage = settingsStorage(global, scenario.project);
	const engineSettings = SettingsManager.fromStorage(storage);
	const hostSettings = SettingsManager.fromStorage(storage);
	const pair = await createEngineHostPair({
		provider,
		models,
		settingsManager: engineSettings,
		hostSettingsManager: hostSettings,
		engineExtensions: extensionFactories,
	});
	try {
		await initialize(pair.engine, scenario.scoped === true);
		await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
		await pair.runtime.initializeFromEngine();
		await pair.drain();
		await choose(pair.runtime.session, pair.engine, scenario);
		await pair.drain();
		await Promise.all([engineSettings.flush(), hostSettings.flush()]);

		assert.deepEqual(SettingsManager.fromStorage(storage).getGlobalSettings(), expected);
		assert.deepEqual(hostSettings.getGlobalSettings(), expected);
		assert.deepEqual(engineSettings.getProjectSettings(), scenario.project);
		assert.deepEqual(hostSettings.getProjectSettings(), scenario.project);
		assert.equal(pair.runtime.session.model?.id, "other-model");
		assert.equal(pair.runtime.session.thinkingLevel, pair.engine.session.thinkingLevel);
	} finally {
		await pair.cleanup();
	}
});
