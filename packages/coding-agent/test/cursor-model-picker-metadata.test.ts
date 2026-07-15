import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function fakeTui(): TUI {
	return { requestRender: () => {} } as TUI;
}

describe("Cursor model picker metadata", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	test("renders a concise row id with its human-readable mode name", async () => {
		harness = await createHarness({
			models: [{ id: "claude-fable-5-1m-max", name: "Fable 5 (1M, Max)", reasoning: true }],
		});
		const model = harness.getModel("claude-fable-5-1m-max")!;
		const selector = new ModelSelectorComponent(
			fakeTui(), model, harness.settingsManager, harness.session.modelRegistry, [], () => {}, () => {},
		);
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const rendered = stripAnsi(selector.render(120).join("\n"));
		expect(rendered).toContain(`→ ${model.id} [${model.provider}]`);
		expect(rendered).toContain("Model Name: Fable 5 (1M, Max)");
		expect(rendered).not.toContain("max-mode-low");
	});
});
