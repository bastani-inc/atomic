import assert from "node:assert/strict";
import { test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";
import { deepMergeSettings } from "../src/core/settings-merge.js";
import { getDefaultToolNames } from "../src/core/tools/index.js";

test("defaultTools modifiers layer over the inherited Atomic tool selection", () => {
	const settings = deepMergeSettings({ defaultTools: ["read", "bash"] }, { defaultTools: ["-bash", "+codemode"] });
	assert.deepEqual(SettingsManager.inMemory(settings).getDefaultTools(), ["read", "codemode"]);
	assert.deepEqual(SettingsManager.inMemory({ defaultTools: ["+codemode", "-bash"] }).getDefaultTools(), [
		...getDefaultToolNames().filter((name) => name !== "bash"),
		"codemode",
	]);
	assert.deepEqual(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools(), []);
	assert.deepEqual(SettingsManager.inMemory({ defaultTools: ["read", "+codemode", "-read"] }).getDefaultTools(), [
		"codemode",
	]);
});

test("project modifiers preserve an explicitly empty inherited tool selection", () => {
	const settings = deepMergeSettings({ defaultTools: [] }, { defaultTools: ["+codemode"] });
	assert.deepEqual(SettingsManager.inMemory(settings).getDefaultTools(), ["codemode"]);
	const cleared = deepMergeSettings({ defaultTools: ["read"] }, { defaultTools: [] });
	assert.deepEqual(SettingsManager.inMemory(cleared).getDefaultTools(), []);
});
