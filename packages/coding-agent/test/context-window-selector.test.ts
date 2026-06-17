import { describe, expect, test, vi } from "vitest";
import {
	buildContextWindowSelectOptions,
	ContextWindowSelectorComponent,
} from "../src/modes/interactive/components/context-window-selector.ts";

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

describe("ContextWindowSelectorComponent", () => {
	// Regression guard for the interactive freeze: the TUI only routes keyboard
	// input to a focused component that exposes `handleInput` (tui dispatch checks
	// `focusedComponent?.handleInput`). A component without it silently drops every
	// keystroke, leaving the selector uninteractable.
	test("forwards handleInput to the inner select list so it is interactable", () => {
		const component = new ContextWindowSelectorComponent(
			[400_000, 1_000_000],
			400_000,
			() => {},
			() => {},
		);

		expect(typeof component.handleInput).toBe("function");
		const spy = vi.spyOn(component.getSelectList(), "handleInput");
		component.handleInput("\x1b[B");
		expect(spy).toHaveBeenCalledWith("\x1b[B");
	});

	test("maps a chosen list item to its raw context-window value", () => {
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const component = new ContextWindowSelectorComponent([400_000, 1_000_000], 400_000, onSelect, onCancel);
		const list = component.getSelectList();

		list.onSelect?.({ value: "1000000", label: "1m" });
		expect(onSelect).toHaveBeenCalledWith(1_000_000);

		list.onCancel?.();
		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
