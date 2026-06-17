import { describe, expect, test } from "vitest";
import { buildContextWindowSelectOptions } from "../src/modes/interactive/components/context-window-selector.ts";

describe("context-window selector options", () => {
	test("uses raw token strings as stable values and disambiguates colliding display labels", () => {
		const choices = buildContextWindowSelectOptions([400_000, 1_040_000, 1_049_000], 1_049_000);

		expect(choices.options.map((option) => option.value)).toEqual(["400000", "1040000", "1049000"]);
		expect(new Set(choices.options.map((option) => option.value)).size).toBe(3);
		expect(choices.currentValue).toBe("1049000");
		expect(choices.currentLabel).toBe("1.0m (1049000 tokens)");
		expect(choices.valueToContextWindow.get("1040000")).toBe(1_040_000);
		expect(choices.valueToContextWindow.get("1049000")).toBe(1_049_000);
		expect(choices.options.find((option) => option.value === "1040000")?.label).toBe(
			"1.0m (1040000 tokens)",
		);
		expect(choices.options.find((option) => option.value === "1049000")?.label).toBe(
			"1.0m (1049000 tokens)",
		);
		expect(choices.options.find((option) => option.value === "1049000")?.description).toBe("current");
	});

	test("keeps compact labels for non-colliding context windows", () => {
		const choices = buildContextWindowSelectOptions([400_000, 1_000_000], 400_000);

		expect(choices.options).toEqual([
			{ value: "400000", label: "400k", description: "current" },
			{ value: "1000000", label: "1m" },
		]);
		expect(choices.currentLabel).toBe("400k");
	});
});
