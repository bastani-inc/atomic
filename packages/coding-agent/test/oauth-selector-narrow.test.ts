import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { OAuthSelectorComponent } from "../src/modes/interactive/components/oauth-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { fakeModelRuntime } from "./model-runtime-test-utils.js";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => setKeybindings(previousKeys));

test("login keeps the provider label before a long configured-status tag at narrow widths (#5237)", () => {
	const picker = new OAuthSelectorComponent(
		"login",
		fakeModelRuntime({ getStoredCredentialType: () => "oauth" }),
		[
			{ id: "anthropic", name: "Anthropic", authType: "oauth" },
			{ id: "anthropic", name: "Anthropic", authType: "api_key" },
		],
		() => {},
		() => {},
		() => ({ configured: true, source: "stored", label: "OAuth" }),
	);
	for (const width of [27, 40, 50, 80]) {
		const lines = picker.render(width);
		const row = lines.map(stripAnsi).find((line) => line.includes("Anth"));
		assert.ok(row?.includes("Anthropic"), `provider name is cut at ${width}: ${row}`);
		if (width >= 40) assert.ok(row.includes("Anthropic · subscription"), row);
		if (width >= 80) assert.ok(row.includes("✓ subscription configured"), row);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
	}
});
