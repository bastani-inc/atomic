import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.js";

function render(selector: ExtensionSelectorComponent): string {
	return stripAnsi(selector.render(80).join("\n"));
}

function visibleOptions(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("option-"))
		.map((line) => line.trim().replace(/^→ /, ""));
}

describe("extension selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("windows long option lists around the selection (pi #6688)", () => {
		const options = Array.from({ length: 15 }, (_, index) => `option-${index + 1}`);
		const selector = new ExtensionSelectorComponent(
			"Choose",
			options,
			() => {},
			() => {},
		);

		let output = render(selector);
		assert.deepEqual(visibleOptions(output), options.slice(0, 10));
		assert.ok(output.includes("→ option-1"));
		assert.ok(output.includes("  (1/15)"));

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		assert.deepEqual(visibleOptions(output), options.slice(2, 12));
		assert.ok(output.includes("→ option-8"));
		assert.ok(output.includes("  (8/15)"));

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		assert.deepEqual(visibleOptions(output), options.slice(5, 15));
		assert.ok(output.includes("→ option-15"));
		assert.ok(output.includes("  (15/15)"));
	});

	it("shows the window indicator for exactly eleven options and not for ten", () => {
		const eleven = Array.from({ length: 11 }, (_, index) => `option-${index + 1}`);
		assert.ok(
			render(
				new ExtensionSelectorComponent(
					"Choose",
					eleven,
					() => {},
					() => {},
				),
			).includes("  (1/11)"),
		);
		const ten = eleven.slice(0, 10);
		const tenOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				ten,
				() => {},
				() => {},
			),
		);
		assert.deepEqual(visibleOptions(tenOutput), ten);
		assert.ok(!tenOutput.includes("(1/10)"));
	});

	it("renders short and empty option lists without a scroll indicator", () => {
		const shortOptions = ["option-1", "option-2", "option-3"];
		const shortOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				shortOptions,
				() => {},
				() => {},
			),
		);
		assert.deepEqual(visibleOptions(shortOutput), shortOptions);
		assert.ok(shortOutput.includes("→ option-1"));
		assert.ok(!shortOutput.includes("(1/3)"));

		const emptyOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				[],
				() => {},
				() => {},
			),
		);
		assert.ok(emptyOutput.includes("Choose"));
		assert.ok(emptyOutput.includes("↑↓ navigate"));
		assert.ok(!emptyOutput.includes("→"));
	});
});
