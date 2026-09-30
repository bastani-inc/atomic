import assert from "node:assert/strict";
import { test } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

test("fullscreen wheel scrolling defaults to auto and clamps configured lines (#9758)", () => {
	assert.equal(SettingsManager.inMemory().getFullscreenWheelScrollLines(), "auto");
	for (const [input, expected] of [
		[0, 1],
		[2.9, 2],
		[101, 100],
		[Number.NaN, "auto"],
	] as const) {
		assert.equal(
			SettingsManager.inMemory({ fullscreenWheelScrollLines: input }).getFullscreenWheelScrollLines(),
			expected,
		);
	}
	const settings = SettingsManager.inMemory();
	settings.setFullscreenWheelScrollLines(6);
	assert.equal(settings.getFullscreenWheelScrollLines(), 6);
});
