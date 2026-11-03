import assert from "node:assert/strict";
import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { resolveCliModel } from "../src/core/model-resolver-cli.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("model selector", () => {
	let harness: Harness | undefined;

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	// Upstream pi #8900: the current model keeps a leading "✓ " while the cursor browses away.
	// Adapted for Atomic's constructor, which takes a SettingsManager before the ModelRuntime.
	it("keeps the current model marked while browsing", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "browsed-model", name: "Browsed Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			"high",
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`/${id}`))
				?.trimEnd();

		const provider = currentModel.provider;
		expect(getModelRow("current-model")).toBe(`→ ✓ ${provider}/current-model  high`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ ${provider}/current-model  high`);
		expect(getModelRow("browsed-model")).toBe(`→   ${provider}/browsed-model  high`);
		selector.dispose();
	});

	it("moves by one page with remapped selection page keys (upstream #7629)", async () => {
		setKeybindings(new KeybindingsManager({ "tui.select.pageUp": "alt+v", "tui.select.pageDown": "ctrl+v" }));
		harness = await createHarness({
			models: Array.from({ length: 12 }, (_, index) => ({ id: `model-${String(index).padStart(2, "0")}` })),
		});
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
		);
		assert.equal(selector.capturesViewportInput, true);

		selector.handleInput("\x16"); // Ctrl+V
		selector.handleInput("\x16");
		selector.handleInput("\x1bv"); // Alt+V
		selector.handleInput("\r");

		assert.equal(onSelect.mock.calls[0]?.[0]?.id, "model-01");
		selector.dispose();
	});

	it("labels each model with its raw ID and the level selecting it applies (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "saved-level-model", name: "Saved Level Model", reasoning: true },
				{ id: "other-reasoning-model", name: "Other Reasoning Model", reasoning: true },
				{ id: "plain-model", name: "Plain Model", reasoning: false },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const provider = currentModel.provider;
		harness.settingsManager.setModelThinkingLevel(provider, "saved-level-model", "low");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			"high",
		);

		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.slice(4).trimEnd());
		// Each row shows the level selecting it applies: a saved per-model level, else the current level it inherits.
		assert.ok(rows.includes(`${provider}/current-model  high`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/saved-level-model  low`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/other-reasoning-model  high`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/plain-model`), rows.join("\n"));
		selector.dispose();
	});

	it("labels the current model with the level selecting it applies, even over the level it runs at (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
			],
		});
		const session = harness.session;
		const currentModel = harness.getModel("current-model")!;
		await session.setModel(currentModel);
		await session.setThinkingLevel("high");
		// A saved override the running session does not use, as after `--model provider/id:high`.
		harness.settingsManager.setModelThinkingLevel(currentModel.provider, currentModel.id, "low");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			session.model,
			harness.settingsManager,
			session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			session.thinkingLevel,
		);
		const row = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.find((line) => line.startsWith("→ ✓ "))!
			.slice(4)
			.trim();
		selector.dispose();

		await session.setModel(currentModel);
		assert.equal(row, `${currentModel.provider}/current-model  ${session.thinkingLevel}`);
		assert.equal(session.thinkingLevel, "low");
	});

	it("labels a selected model so that --model parses the label back to the same model and level (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			"low",
		);
		const row = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.find((line) => line.startsWith("→ ✓ "))!
			.slice(4)
			.trim();

		const [reference, level] = row.split(/\s+/);
		const parsed = resolveCliModel({
			cliModel: `${reference}:${level}`,
			modelRuntime: harness.session.modelRuntime,
		});
		assert.equal(parsed.error, undefined);
		assert.equal(parsed.model?.provider, currentModel.provider);
		assert.equal(parsed.model?.id, currentModel.id);
		assert.equal(parsed.thinkingLevel, "low");
		selector.dispose();
	});

	it("shows a display name only as a dim column after the ID, and search still finds it (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "minimax/minimax-m3", name: "MiniMax M3 [parasail]" },
				{ id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
			],
		});
		const provider = harness.getModel("minimax/minimax-m3")!.provider;
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			undefined,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
		);

		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.slice(4).trimEnd());
		// A name that adds words the ID lacks follows it, dimmed; one that only restates the ID is left out (pi #5916).
		assert.ok(rows.includes(`${provider}/minimax/minimax-m3  MiniMax M3 [parasail]`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/claude-sonnet-4-5`), rows.join("\n"));
		assert.ok(selector.render(120).join("\n").includes(theme.fg("muted", "MiniMax M3 [parasail]")));

		// "parasail" is only in the display name.
		for (const character of "parasail") selector.handleInput(character);
		const matches = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`${provider}/`));
		assert.deepEqual(
			matches.map((line) => line.slice(4).trimEnd()),
			[`${provider}/minimax/minimax-m3  MiniMax M3 [parasail]`],
		);
		selector.dispose();
	});

	it("has no save-default shortcut or hint", async () => {
		harness = await createHarness();
		const currentModel = harness.getModel()!;
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			saveDefault,
			() => {},
		);

		expect(stripAnsi(selector.render(120).join("\n"))).not.toContain("set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\r");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
		selector.dispose();
	});
});
