import { beforeAll, describe, expect, test, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	buildContextWindowChoices,
	ContextWindowSelectorComponent,
} from "../src/modes/interactive/components/context-window-selector.ts";

// The component renders themed text eagerly, so initialize the theme like startup does.
beforeAll(() => {
	initTheme("dark");
});

describe("buildContextWindowChoices", () => {
	test("names the smallest tier Default and the largest Long context with token labels", () => {
		const { choices, currentIndex } = buildContextWindowChoices([400_000, 1_000_000], 1_000_000);

		expect(choices).toEqual([
			{
				contextWindow: 400_000,
				value: "400000",
				label: "Default",
				isDefault: true,
				tokensLabel: "400k tokens",
			},
			{
				contextWindow: 1_000_000,
				value: "1000000",
				label: "Long context",
				isDefault: false,
				tokensLabel: "1m tokens",
			},
		]);
		expect(currentIndex).toBe(1);
	});

	test("sorts ascending, dedupes, and defaults currentIndex to 0 when current is unknown", () => {
		const { choices, currentIndex } = buildContextWindowChoices([1_000_000, 400_000, 400_000], 999);

		expect(choices.map((choice) => choice.contextWindow)).toEqual([400_000, 1_000_000]);
		expect(currentIndex).toBe(0);
	});
});

describe("ContextWindowSelectorComponent", () => {
	// Regression guard for the interactive freeze: the TUI only routes keyboard input
	// to a focused component that exposes `handleInput`. A component without it silently
	// drops every keystroke, leaving the selector uninteractable.
	test("is interactable and selects the matching window via number shortcuts", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const component = new ContextWindowSelectorComponent(
			"GPT-5.5",
			[400_000, 1_000_000],
			400_000,
			onSelect,
			onCancel,
		);

		expect(typeof component.handleInput).toBe("function");

		component.handleInput("2");
		expect(onSelect).toHaveBeenLastCalledWith(1_000_000);

		component.handleInput("1");
		expect(onSelect).toHaveBeenLastCalledWith(400_000);
		expect(onCancel).not.toHaveBeenCalled();
	});

	test("ignores out-of-range number shortcuts", () => {
		const onSelect = vi.fn();
		const component = new ContextWindowSelectorComponent("GPT-5.5", [400_000, 1_000_000], 400_000, onSelect, () => {});

		component.handleInput("3");
		expect(onSelect).not.toHaveBeenCalled();
	});
});
