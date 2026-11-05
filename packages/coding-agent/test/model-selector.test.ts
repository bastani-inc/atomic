import assert from "node:assert/strict";
import type { ModelsRefreshResult } from "@bastani/pi-ai";
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

function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const row = stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.find((line) => line.startsWith("→"));
	return row
		?.replace(/^→\s*(✓\s*)?/, "")
		.split(" ")[0]
		?.split("/")
		.pop();
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

	describe("when the catalog refresh lands (pi #11810)", () => {
		// Opens the selector with the refresh in flight, so a test can browse first and then let it land.
		async function openWithPendingRefresh(currentId: string | null = "alpha-1"): Promise<{
			activeHarness: Harness;
			selector: ModelSelectorComponent;
			finishRefresh: () => Promise<void>;
		}> {
			const activeHarness = await createHarness({
				models: [{ id: "alpha-1" }, { id: "alpha-2" }, { id: "alpha-3" }, { id: "beta-1" }],
			});
			harness = activeHarness;
			const { promise, resolve } = Promise.withResolvers<ModelsRefreshResult>();
			vi.spyOn(activeHarness.session.modelRuntime, "refresh").mockReturnValue(promise);
			const selector = new ModelSelectorComponent(
				createFakeTui(),
				currentId === null ? undefined : activeHarness.getModel(currentId),
				activeHarness.settingsManager,
				activeHarness.session.modelRuntime,
				[],
				() => {},
				() => {},
			);
			const finishRefresh = async () => {
				resolve({ aborted: false, errors: new Map() });
				await vi.waitFor(() => {
					assert.ok(stripAnsi(selector.render(120).join("\n")).includes("Model catalogs refreshed."));
				});
			};
			return { activeHarness, selector, finishRefresh };
		}

		it("keeps the selection on the browsed model", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");

			await finishRefresh();

			assert.equal(selectedModelId(selector), "alpha-3");
			selector.dispose();
		});

		it("keeps the selection while a search query is active", async () => {
			const { selector, finishRefresh } = await openWithPendingRefresh();
			for (const char of "alpha") selector.handleInput(char);
			selector.handleInput("\x1b[B");
			const browsed = selectedModelId(selector);

			await finishRefresh();

			assert.equal(selectedModelId(selector), browsed);
			assert.notEqual(browsed, "alpha-1");
			selector.dispose();
		});

		it("follows the selected model when new rows shift its position", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const snapshot = modelRuntime.getAvailableSnapshot();
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([
				{ ...snapshot[0]!, id: "added-model" },
				...snapshot,
			]);

			await finishRefresh();

			assert.equal(selectedModelId(selector), "alpha-2");
			selector.handleInput("\x1b[A");
			selector.handleInput("\x1b[A");
			assert.equal(selectedModelId(selector), "alpha-1");
			selector.dispose();
		});

		it("falls back to the current model when the selected model disappears", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const remaining = modelRuntime.getAvailableSnapshot().filter((model) => model.id !== "alpha-2");
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(remaining);

			await finishRefresh();

			assert.equal(selectedModelId(selector), "alpha-1");
			selector.dispose();
		});

		it("selects the browsed model on the top row when the rows above it disappear", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const remaining = modelRuntime.getAvailableSnapshot().filter((model) => model.id !== "alpha-1");
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(remaining);

			await finishRefresh();

			assert.equal(selectedModelId(selector), "alpha-2");
			selector.dispose();
		});

		it("keeps the browsed row position when the selected model disappears and none is current", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh(null);
			selector.handleInput("\x1b[B");
			selector.handleInput("\x1b[B");
			const modelRuntime = activeHarness.session.modelRuntime;
			const remaining = modelRuntime.getAvailableSnapshot().filter((model) => model.id !== "alpha-3");
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(remaining);

			await finishRefresh();

			assert.equal(selectedModelId(selector), "beta-1");
			selector.dispose();
		});

		it("lists models that arrive while the search matches nothing", async () => {
			const { activeHarness, selector, finishRefresh } = await openWithPendingRefresh();
			for (const char of "zzz") selector.handleInput(char);
			const modelRuntime = activeHarness.session.modelRuntime;
			const snapshot = modelRuntime.getAvailableSnapshot();
			vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([
				...snapshot,
				{ ...snapshot[0]!, id: "zzz-added" },
			]);

			await finishRefresh();

			assert.equal(selectedModelId(selector), "zzz-added");
			selector.dispose();
		});
	});
});
