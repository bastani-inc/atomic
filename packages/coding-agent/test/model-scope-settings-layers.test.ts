import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { createEngineHostPair } from "./helpers/in-process-engine-pair.ts";
import { createHarness } from "./suite/harness.ts";

const provider = "picker-scope-layers";
const current = `${provider}/current-model`;
const other = `${provider}/other-model`;
const third = `${provider}/third-model`;
const models = [
	{ id: "current-model", reasoning: true },
	{ id: "other-model", reasoning: true },
	{ id: "third-model", reasoning: true },
];
const scopes: Array<{ name: string; enabledModels?: string[] }> = [
	{ name: "a nonempty global scope", enabledModels: [third] },
	{ name: "no global scope" },
	{ name: "an empty global scope", enabledModels: [] },
	{ name: "the chosen model already globally enabled", enabledModels: [other.toUpperCase()] },
];
const scenarios = (["in-process", "isolated"] as const).flatMap((mode) => scopes.map((scope) => ({ mode, ...scope })));

test.each(scenarios)(
	"$mode preserves $name when a project limits model scope (#5237)",
	async ({ mode, enabledModels }) => {
		const storage = new InMemorySettingsStorage();
		const project = { enabledModels: [current] };
		storage.withLock("global", () => JSON.stringify({ enabledModels }));
		storage.withLock("project", () => JSON.stringify(project));
		const engineSettings = SettingsManager.fromStorage(storage);
		const hostSettings = SettingsManager.fromStorage(storage);
		const pair =
			mode === "isolated"
				? await createEngineHostPair({
						provider,
						models,
						settingsManager: engineSettings,
						hostSettingsManager: hostSettings,
					})
				: undefined;
		const harness = pair?.engine ?? (await createHarness({ provider, models, settingsManager: engineSettings }));
		try {
			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			harness.session.setScopedModels([{ model: harness.getModel("current-model")! }]);
			if (pair) {
				await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
				await pair.runtime.initializeFromEngine();
				await pair.drain();
			}
			const session = pair?.runtime.session ?? harness.session;
			await session.setModel(harness.getModel("other-model")!, { persist: true });
			await pair?.drain();
			await Promise.all([engineSettings.flush(), hostSettings.flush()]);

			const expected =
				enabledModels?.length && !enabledModels.some((id) => id.toLowerCase() === other)
					? [...enabledModels, other]
					: enabledModels;
			const saved = SettingsManager.fromStorage(storage);
			assert.deepEqual(saved.getGlobalSettings().enabledModels, expected);
			assert.deepEqual(engineSettings.getGlobalSettings().enabledModels, expected);
			if (pair) assert.deepEqual(hostSettings.getGlobalSettings().enabledModels, expected);
			assert.deepEqual(saved.getProjectSettings(), project);
			assert.deepEqual(saved.getEnabledModels(), [current]);
			assert.ok(session.scopedModels.some(({ model }) => model.id === "other-model"));
		} finally {
			if (pair) await pair.cleanup();
			else await harness.cleanup();
		}
	},
);
