import assert from "node:assert/strict";
import type { ModelsRefreshResult } from "@bastani/atomic-ai";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { resolveCliModel } from "../src/core/model-resolver-cli.js";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";
import { stripAnsi } from "./helpers/visible-text.js";
import { createHarness, type Harness } from "./suite/harness.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function untagged(line: string): string {
	return line.trimEnd().replace(/\s{2,}(current|default)$/, "");
}

function rowBody(line: string): string {
	return untagged(line).slice(5);
}

function selectedModelId(selector: ModelSelectorComponent): string | undefined {
	const row = stripAnsi(selector.render(120).join("\n"))
		.split("\n")
		.find((line) => line.startsWith(" ❯"));
	return row
		?.replace(/^ ❯\s*([●○]\s*)?/, "")
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
				.find((line) => line.includes(`/${id}`));

		const provider = currentModel.provider;
		expect(untagged(getModelRow("current-model") ?? "")).toBe(` ❯ ● ${provider}/current-model  high`);
		selector.handleInput("\x1b[B");
		expect(untagged(getModelRow("current-model") ?? "")).toBe(`   ● ${provider}/current-model  high`);
		expect(untagged(getModelRow("browsed-model") ?? "")).toBe(` ❯ ○ ${provider}/browsed-model  high`);
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

		const rows = stripAnsi(selector.render(120).join("\n")).split("\n").map(rowBody);
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
			.find((line) => line.startsWith(" ❯ ● "))!;
		const rowText = rowBody(row).trim();
		selector.dispose();

		await session.setModel(currentModel);
		assert.equal(rowText, `${currentModel.provider}/current-model  ${session.thinkingLevel}`);
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
			.find((line) => line.startsWith(" ❯ ● "))!;
		const rowText = rowBody(row).trim();

		const [reference, level] = rowText.split(/\s+/);
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

		const rows = stripAnsi(selector.render(120).join("\n")).split("\n").map(rowBody);
		// A name that adds words the ID lacks follows it, dimmed; one that only restates the ID is left out (pi #5916).
		assert.ok(rows.includes(`${provider}/minimax/minimax-m3  MiniMax M3 [parasail]`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/claude-sonnet-4-5`), rows.join("\n"));
		assert.ok(selector.render(120).join("\n").includes(theme.fg("muted", "MiniMax M3 [parasail]")));

		// "parasail" is only in the display name.
		for (const character of "parasail") selector.handleInput(character);
		const matches = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.filter((line) => line.includes(`${provider}/`));
		assert.deepEqual(matches.map(rowBody), [`${provider}/minimax/minimax-m3  MiniMax M3 [parasail]`]);
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

	it("does not match the shown thinking level or current tag when searching (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "gpt-5", name: "GPT 5", reasoning: true },
				{ id: "o3", name: "O3", reasoning: true },
				{ id: "mistral-medium", name: "Mistral Medium", reasoning: true },
				{ id: "default-target", name: "Default Target", reasoning: true },
			],
		});
		const currentModel = harness.getModel("gpt-5")!;
		const provider = currentModel.provider;
		harness.settingsManager.setDefaultModelAndProvider(provider, "default-target");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			"medium",
		);

		for (const char of "medium") selector.handleInput(char);
		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.value.id),
			["mistral-medium"],
		);

		selector.selector.clearSearch();
		for (const char of "current") selector.handleInput(char);
		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.value.id),
			[],
		);

		selector.selector.clearSearch();
		for (const char of "default") selector.handleInput(char);
		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.value.id),
			["default-target"],
		);
		selector.dispose();
	});

	it("highlights the best search match instead of the current model when opened with an initial search term (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "gpt-5", name: "GPT 5", reasoning: true },
				{ id: "gpt-5-nano", name: "GPT 5 Nano", reasoning: true },
				{ id: "gpt-4.1-nano", name: "GPT 4.1 Nano", reasoning: false },
				{ id: "o3", name: "O3", reasoning: true },
			],
		});
		const modelRuntime = harness.session.modelRuntime;
		const baseSnapshot = modelRuntime.getAvailableSnapshot();
		const models: Model<Api>[] = [
			{ ...baseSnapshot[0]!, provider: "openai", id: "gpt-5", name: "gpt-5" },
			{ ...baseSnapshot[1]!, provider: "azure", id: "gpt-5-nano", name: "gpt-5-nano" },
			{ ...baseSnapshot[2]!, provider: "openai", id: "gpt-5-nano", name: "gpt-5-nano" },
			{ ...baseSnapshot[3]!, provider: "openai", id: "o3", name: "o3" },
		];
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(models);
		vi.spyOn(modelRuntime, "getModel").mockImplementation((provider, id) =>
			models.find((model) => model.provider === provider && model.id === id),
		);
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			models[0],
			harness.settingsManager,
			modelRuntime,
			[],
			onSelect,
			() => {},
			"nano",
			"medium",
		);

		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.id),
			["azure/gpt-5-nano", "openai/gpt-5-nano", "openai/o3", "openai/gpt-5"],
		);
		assert.equal(selector.selector.getSelected()?.id, "azure/gpt-5-nano");

		selector.handleInput("\r");
		assert.equal(onSelect.mock.calls.length, 1);
		assert.equal(`${onSelect.mock.calls[0]?.[0]?.provider}/${onSelect.mock.calls[0]?.[0]?.id}`, "azure/gpt-5-nano");
		selector.dispose();
	});

	it("steps effort on SS3 and Kitty left/right arrows without selecting or closing (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
				{ id: "plain-model", name: "Plain Model", reasoning: false },
			],
		});
		const currentModel = harness.getModel("current-model")!;
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			"medium",
		);

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1bOC");
		assert.equal(onSelect.mock.calls.length, 0);
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("other-model  high"));

		selector.handleInput("\x1bOD");
		assert.equal(onSelect.mock.calls.length, 0);
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("other-model  medium"));

		selector.handleInput("\x1bOD");
		assert.equal(onSelect.mock.calls.length, 0);
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("other-model  low"));

		selector.handleInput("\x1b[1;1:1C");
		assert.equal(onSelect.mock.calls.length, 0);
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("other-model  medium"));

		selector.handleInput("\x1b[1;1:1D");
		assert.equal(onSelect.mock.calls.length, 0);
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("other-model  low"));

		selector.handleInput("\x1b[B");
		selector.handleInput("\x1bOC");
		selector.handleInput("\x1b[1;1:1C");
		assert.equal(onSelect.mock.calls.length, 0);
		assert.equal(selectedModelId(selector), "plain-model");

		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		assert.equal(onSelect.mock.calls.length, 1);
		assert.equal(onSelect.mock.calls[0]?.[0]?.id, "other-model");
		assert.equal(onSelect.mock.calls[0]?.[1], "low");
		selector.dispose();
	});

	it("hints ←→ effort only when the selected model supports more than one thinking level (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "multi-level", name: "Multi Level", reasoning: true },
				{ id: "single-level", name: "Single Level", reasoning: true },
				{ id: "plain-model", name: "Plain Model", reasoning: false },
			],
		});
		const modelRuntime = harness.session.modelRuntime;
		const baseModels = modelRuntime.getAvailableSnapshot();
		const models = baseModels.map((model) =>
			model.id === "single-level"
				? {
						...model,
						thinkingLevelMap: {
							off: null,
							minimal: null,
							low: null,
							medium: null,
							high: "high" as const,
						},
					}
				: model,
		);
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue(models);
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			models[0],
			harness.settingsManager,
			modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			"medium",
		);

		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("←→ effort"));
		selector.handleInput("\x1b[B");
		assert.equal(stripAnsi(selector.render(120).join("\n")).includes("←→ effort"), false);
		selector.handleInput("\x1b[C");
		selector.handleInput("\x1b[B");
		assert.equal(stripAnsi(selector.render(120).join("\n")).includes("←→ effort"), false);
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		assert.equal(onSelect.mock.calls.length, 1);
		assert.equal(onSelect.mock.calls[0]?.[0]?.id, "single-level");
		assert.equal(onSelect.mock.calls[0]?.length, 1);
		selector.dispose();
	});

	it("clamps or drops a stale ←→ effort choice when catalog refresh changes supported levels (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha 1", reasoning: true },
				{ id: "alpha-2", name: "Alpha 2", reasoning: true },
			],
		});
		const { promise, resolve } = Promise.withResolvers<ModelsRefreshResult>();
		const modelRuntime = harness.session.modelRuntime;
		const baseSnapshot = modelRuntime.getAvailableSnapshot();
		const initialAlpha1 = { ...baseSnapshot[0]!, thinkingLevelMap: { xhigh: "xhigh" as const } };
		const initialAlpha2 = baseSnapshot[1]!;
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([initialAlpha1, initialAlpha2]);
		vi.spyOn(modelRuntime, "refresh").mockReturnValue(promise);
		const onSelect = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			initialAlpha1,
			harness.settingsManager,
			modelRuntime,
			[],
			onSelect,
			() => {},
			undefined,
			"high",
		);

		selector.handleInput("\x1b[C");
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("alpha-1  xhigh"));

		const refreshedAlpha1 = { ...baseSnapshot[0]!, thinkingLevelMap: undefined };
		const refreshedAlpha2 = { ...baseSnapshot[1]!, reasoning: false };
		vi.spyOn(modelRuntime, "getAvailableSnapshot").mockReturnValue([refreshedAlpha1, refreshedAlpha2]);
		vi.spyOn(modelRuntime, "getModel").mockImplementation((_provider, id) =>
			id === "alpha-1" ? refreshedAlpha1 : id === "alpha-2" ? refreshedAlpha2 : undefined,
		);

		resolve({ aborted: false, errors: new Map() });
		await vi.waitFor(() => {
			assert.ok(stripAnsi(selector.render(120).join("\n")).includes("Model catalogs refreshed."));
		});

		const renderedAfterRefresh = stripAnsi(selector.render(120).join("\n"));
		assert.equal(renderedAfterRefresh.includes("alpha-1  xhigh"), false);
		assert.ok(renderedAfterRefresh.includes("alpha-1  high"));

		selector.handleInput("\x1b[C");
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("alpha-1  high"));

		selector.handleInput("\r");
		assert.equal(onSelect.mock.calls.length, 1);
		assert.equal(onSelect.mock.calls[0]?.[0]?.id, "alpha-1");
		assert.equal(onSelect.mock.calls[0]?.[1], "high");
		selector.dispose();
	});

	it("reconciles effort when refreshed capabilities update the same model object (#5237)", async () => {
		harness = await createHarness({ models: [{ id: "mutable-model", name: "Mutable Model", reasoning: true }] });
		const model: Model<Api> = { ...harness.models[0]!, thinkingLevelMap: { xhigh: "xhigh" } };
		const runtime = harness.session.modelRuntime;
		const refresh = Promise.withResolvers<ModelsRefreshResult>();
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue([model]);
		vi.spyOn(runtime, "refresh").mockReturnValue(refresh.promise);
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			model,
			harness.settingsManager,
			runtime,
			[],
			() => {},
			() => {},
			undefined,
			"high",
		);
		selector.handleInput("\x1b[C");
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("mutable-model  xhigh"));
		model.thinkingLevelMap!.xhigh = null;
		refresh.resolve({ aborted: false, errors: new Map() });
		await vi.waitFor(() =>
			assert.ok(stripAnsi(selector.render(120).join("\n")).includes("Model catalogs refreshed.")),
		);
		assert.ok(stripAnsi(selector.render(120).join("\n")).includes("mutable-model  high"));
		assert.equal(stripAnsi(selector.render(120).join("\n")).includes("mutable-model  xhigh"), false);
		selector.dispose();
	});

	it("invalidates cached model metadata when same-object reasoning, name, id, or provider changes on refresh (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "mutable-reasoning", name: "Reasoning Target", reasoning: false },
				{ id: "mutable-name", name: "Before Label [alpha]", reasoning: false },
				{ id: "mutable-id-before", name: "Id Target [beta]", reasoning: false },
				{ id: "mutable-prov", name: "Prov Target [gamma]", reasoning: false },
			],
		});
		const baseModels = harness.session.modelRuntime.getAvailableSnapshot();
		const reasoningModel: Model<Api> = { ...baseModels[0]!, reasoning: false };
		const nameModel: Model<Api> = { ...baseModels[1]!, name: "Before Label [alpha]" };
		const idModel: Model<Api> = { ...baseModels[2]!, id: "mutable-id-before" };
		const providerModel: Model<Api> = { ...baseModels[3]!, provider: "prov-before" };
		const models = [reasoningModel, nameModel, idModel, providerModel];
		const runtime = harness.session.modelRuntime;
		const refresh = Promise.withResolvers<ModelsRefreshResult>();
		vi.spyOn(runtime, "getAvailableSnapshot").mockReturnValue(models);
		vi.spyOn(runtime, "getModel").mockImplementation((provider, id) =>
			models.find((candidate) => candidate.provider === provider && candidate.id === id),
		);
		vi.spyOn(runtime, "refresh").mockReturnValue(refresh.promise);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			reasoningModel,
			harness.settingsManager,
			runtime,
			[],
			() => {},
			() => {},
			undefined,
			"high",
		);

		const initialRendered = stripAnsi(selector.render(120).join("\n"));
		assert.equal(initialRendered.includes("mutable-reasoning  high"), false);
		assert.ok(initialRendered.includes("Before Label [alpha]"));
		assert.ok(initialRendered.includes("mutable-id-before"));
		assert.ok(initialRendered.includes("prov-before/mutable-prov"));

		for (const query of ["alpha", "mutable-id-before", "prov-before"]) {
			selector.selector.setQuery(query);
			assert.equal(selector.selector.state.getVisible().length, 1);
		}
		selector.selector.setQuery("");

		(reasoningModel as { reasoning: boolean }).reasoning = true;
		(nameModel as { name: string }).name = "After Label [qzvx]";
		(idModel as { id: string }).id = "mutable-id-after";
		(providerModel as { provider: string }).provider = "prov-after";

		refresh.resolve({ aborted: false, errors: new Map() });
		await vi.waitFor(() =>
			assert.ok(stripAnsi(selector.render(120).join("\n")).includes("Model catalogs refreshed.")),
		);

		const refreshedRendered = stripAnsi(selector.render(120).join("\n"));
		assert.ok(refreshedRendered.includes("mutable-reasoning  high"));
		assert.ok(refreshedRendered.includes("After Label [qzvx]"));
		assert.equal(refreshedRendered.includes("Before Label [alpha]"), false);
		assert.ok(refreshedRendered.includes("mutable-id-after"));
		assert.equal(refreshedRendered.includes("mutable-id-before"), false);
		assert.ok(refreshedRendered.includes("prov-after/mutable-prov"));
		assert.equal(refreshedRendered.includes("prov-before/mutable-prov"), false);

		selector.selector.setQuery("qzvx");
		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.value.id),
			["mutable-name"],
		);
		selector.selector.setQuery("mutable-id-after");
		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.value.id),
			["mutable-id-after"],
		);
		selector.selector.setQuery("prov-after");
		assert.deepEqual(
			selector.selector.state.getVisible().map((item) => item.value.id),
			["mutable-prov"],
		);
		selector.dispose();
	});

	it("rebuilds only the stepped row on ←→ and caches per-model metadata across rebuilds (#5237)", async () => {
		harness = await createHarness({
			models: Array.from({ length: 15 }, (_, index) => ({
				id: `alpha-${String(index).padStart(2, "0")}`,
				name: `Alpha ${index} [custom]`,
				reasoning: true,
			})),
		});
		let idReads = 0;
		let providerReads = 0;
		let nameReads = 0;
		const baseModels = harness.session.modelRuntime.getAvailableSnapshot();
		const firstBase = baseModels[0]!;
		const trackedFirst: Model<Api> = { ...firstBase };
		Object.defineProperties(trackedFirst, {
			id: {
				enumerable: true,
				get() {
					idReads++;
					return firstBase.id;
				},
			},
			provider: {
				enumerable: true,
				get() {
					providerReads++;
					return firstBase.provider;
				},
			},
			name: {
				enumerable: true,
				get() {
					nameReads++;
					return firstBase.name;
				},
			},
		});
		const models = [trackedFirst, ...baseModels.slice(1)];
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(models);
		vi.spyOn(harness.session.modelRuntime, "getModel").mockImplementation((provider, id) =>
			models.find((model) => model.provider === provider && model.id === id),
		);
		const levelSpy = vi.spyOn(harness.settingsManager, "getModelThinkingLevel");
		levelSpy.mockClear();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			trackedFirst,
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			() => {},
			() => {},
			undefined,
			"medium",
		);
		selector.render(120);
		assert.equal(
			levelSpy.mock.calls.some(([, modelId]) => modelId === "alpha-14"),
			false,
		);
		selector.selector.setQuery("custom");
		selector.selector.setQuery("");

		const beforeItems = [...selector.selector.state.getVisible()];
		levelSpy.mockClear();

		selector.handleInput("\x1b[C");
		selector.render(120);

		const afterItems = selector.selector.state.getVisible();
		assert.notEqual(afterItems[0], beforeItems[0]);
		assert.equal(afterItems[1], beforeItems[1]);
		assert.equal(afterItems[2], beforeItems[2]);
		assert.ok(afterItems[0]?.label.endsWith("  high"));
		assert.ok(
			levelSpy.mock.calls.every(([, modelId]) => modelId === "alpha-00"),
			`expected getModelThinkingLevel only for alpha-00, got ${JSON.stringify(levelSpy.mock.calls)}`,
		);

		selector.handleInput("\x1b[D");
		const steppedBackRow = selector.selector.state.getVisible()[0]!;
		idReads = 0;
		providerReads = 0;
		nameReads = 0;
		assert.ok(steppedBackRow.label.endsWith("  medium"));
		assert.equal(steppedBackRow.description, "Alpha 0 [custom]");
		assert.ok(steppedBackRow.searchText.includes("Alpha 0 [custom]"));
		assert.equal(idReads, 0);
		assert.equal(providerReads, 0);
		assert.equal(nameReads, 0);
		selector.dispose();
	});

	it("ignores mouse events and cancel callbacks after dispose (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "alpha-1", name: "Alpha 1", reasoning: true },
				{ id: "alpha-2", name: "Alpha 2", reasoning: true },
			],
		});
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			harness.getModel("alpha-1"),
			harness.settingsManager,
			harness.session.modelRuntime,
			[],
			onSelect,
			onCancel,
			undefined,
			"medium",
		);
		selector.render(120);
		selector.dispose();

		const mouseResult = selector.handleMouse({
			type: "wheel",
			button: "none",
			x: 4,
			y: 4,
			width: 120,
			wheelDelta: 1,
		});
		assert.equal(mouseResult, undefined);
		assert.equal(selectedModelId(selector), "alpha-1");

		selector.selector.handleInput("\x1b");
		assert.equal(onCancel.mock.calls.length, 0);
		assert.equal(onSelect.mock.calls.length, 0);
	});

	it("reconciles chosen thinking levels in linear time across model list rebuilds (#5237)", async () => {
		const totalModels = 60;
		const steppedCount = 40;
		harness = await createHarness({
			models: Array.from({ length: totalModels }, (_, index) => ({
				id: `alpha-${String(index).padStart(2, "0")}`,
				name: `Alpha ${index}`,
				reasoning: true,
			})),
		});
		let idReads = 0;
		const trackedModels = harness.session.modelRuntime.getAvailableSnapshot().map((baseModel) => {
			const modelId = baseModel.id;
			const tracked = { ...baseModel };
			Object.defineProperty(tracked, "id", {
				enumerable: true,
				get() {
					idReads++;
					return modelId;
				},
			});
			return tracked;
		});
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(trackedModels);
		vi.spyOn(harness.session.modelRuntime, "getModel").mockImplementation((provider, id) =>
			trackedModels.find((model) => model.provider === provider && model.id === id),
		);

		const selector = new ModelSelectorComponent(
			createFakeTui(),
			trackedModels[0],
			harness.settingsManager,
			harness.session.modelRuntime,
			trackedModels.slice(0, 10).map((model) => ({ model })),
			() => {},
			() => {},
			undefined,
			"medium",
		);
		assert.ok(
			idReads <= totalModels * 4,
			`expected linear model id reads during initial sort and build, got ${idReads} reads for ${totalModels} models`,
		);

		selector.handleInput("\t");
		for (let index = 0; index < steppedCount; index++) {
			selector.handleInput("\x1b[C");
			selector.handleInput("\x1b[B");
		}

		idReads = 0;
		selector.handleInput("\t");
		assert.ok(
			idReads <= totalModels * 3,
			`expected linear model key lookups during reconcile, got ${idReads} reads for ${totalModels} models`,
		);

		selector.handleInput("\t");
		const visible = selector.selector.state.getVisible();
		assert.ok(visible[0]?.label.endsWith("  high"));
		assert.ok(visible[steppedCount - 1]?.label.endsWith("  high"));
		selector.dispose();
	});
});
