import { describe, expect, it, vi } from "vitest";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function plainRender(selector: ExtensionSelectorComponent): string {
	return selector
		.render(120)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("ExtensionSelectorComponent", () => {
	it("renders an optional back hint between select and cancel", () => {
		initTheme("dark");
		const selector = new ExtensionSelectorComponent(
			"Confirm rewind",
			["Yes", "No"],
			() => {},
			() => {},
			{ onBack: () => {} },
		);

		const rendered = plainRender(selector);
		const selectIndex = rendered.indexOf("select");
		const backIndex = rendered.indexOf("← back");
		const cancelIndex = rendered.indexOf("cancel");

		expect(selectIndex).toBeGreaterThanOrEqual(0);
		expect(backIndex).toBeGreaterThan(selectIndex);
		expect(cancelIndex).toBeGreaterThan(backIndex);
	});

	it("calls the optional back callback on left arrow", () => {
		initTheme("dark");
		const onBack = vi.fn();
		const onCancel = vi.fn();
		const selector = new ExtensionSelectorComponent(
			"Confirm rewind",
			["Yes", "No"],
			() => {},
			onCancel,
			{ onBack },
		);

		selector.handleInput("\x1b[D");

		expect(onBack).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
	});
});
