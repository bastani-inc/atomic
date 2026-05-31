import { describe, expect, it, vi } from "vitest";
import { FastModeSelectorComponent } from "../src/modes/interactive/components/fast-mode-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function plainRender(selector: FastModeSelectorComponent): string {
	return selector
		.render(120)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "");
}

describe("FastModeSelectorComponent", () => {
	it("renders chat and workflow rows", () => {
		initTheme("dark");
		const selector = new FastModeSelectorComponent(
			{ chat: false, workflow: true },
			{ onChange: () => {}, onCancel: () => {} },
		);

		const rendered = plainRender(selector);

		expect(rendered).toContain("Codex fast mode");
		expect(rendered).toContain("chat");
		expect(rendered).toContain("workflow");
		expect(rendered).toContain("[disabled]");
		expect(rendered).toContain("[enabled]");
		expect(rendered).toContain("← enable · → disable");
	});

	it("moves rows with tab and shift-tab", () => {
		initTheme("dark");
		const selector = new FastModeSelectorComponent(
			{ chat: false, workflow: false },
			{ onChange: () => {}, onCancel: () => {} },
		);

		expect(selector.getFocusedRow()).toBe("chat");
		selector.handleInput("\t");
		expect(selector.getFocusedRow()).toBe("workflow");
		selector.handleInput("\x1b[Z");
		expect(selector.getFocusedRow()).toBe("chat");
	});

	it("changes the focused row with left and right arrows", () => {
		initTheme("dark");
		const onChange = vi.fn();
		const selector = new FastModeSelectorComponent(
			{ chat: false, workflow: false },
			{ onChange, onCancel: () => {} },
		);

		selector.handleInput("\x1b[D");
		expect(selector.getSettings()).toEqual({ chat: true, workflow: false });
		expect(onChange).toHaveBeenLastCalledWith({ chat: true, workflow: false }, "chat");

		selector.handleInput("\t");
		selector.handleInput("\x1b[D");
		expect(selector.getSettings()).toEqual({ chat: true, workflow: true });
		expect(onChange).toHaveBeenLastCalledWith({ chat: true, workflow: true }, "workflow");

		selector.handleInput("\x1b[C");
		expect(selector.getSettings()).toEqual({ chat: true, workflow: false });
		expect(onChange).toHaveBeenLastCalledWith({ chat: true, workflow: false }, "workflow");
	});

	it("cancels on escape", () => {
		initTheme("dark");
		const onCancel = vi.fn();
		const selector = new FastModeSelectorComponent(
			{ chat: false, workflow: false },
			{ onChange: () => {}, onCancel },
		);

		selector.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledTimes(1);
	});
});
