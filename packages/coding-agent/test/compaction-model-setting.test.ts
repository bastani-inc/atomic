import assert from "node:assert/strict";
import { test } from "vitest";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.js";

test("persists compactionModel independently at global and project scope (#3470)", async () => {
	const storage = new InMemorySettingsStorage();
	const settings = SettingsManager.fromStorage(storage);
	assert.equal(settings.getCompactionModel(), "");
	settings.setCompactionModel("openai/gpt-5");
	settings.setCompactionModel("auto", "project");
	await settings.flush();
	await settings.reload();
	assert.equal(settings.getCompactionModel(), "auto");
	settings.setProjectTrusted(false);
	assert.equal(settings.getCompactionModel(), "openai/gpt-5");
});

test("accepts project Morph compaction selections on write and load", async () => {
	const settings = SettingsManager.inMemory();
	settings.setCompactionModel("morph/morph-compactor", "project");
	await settings.flush();
	assert.equal(settings.getCompactionModel(), "morph/morph-compactor");
	const storage = new InMemorySettingsStorage();
	storage.withLock("project", () => JSON.stringify({ compactionModel: "morph/morph-compactor" }));
	assert.equal(SettingsManager.fromStorage(storage).getCompactionModel(), "morph/morph-compactor");
	assert.equal(SettingsManager.fromStorage(storage, { projectTrusted: false }).getCompactionModel(), "");
	assert.throws(() => settings.setCompactionModel(" auto"), /compactionModel/);
});
