import assert from "node:assert/strict";
import { CURSOR_MARKER, setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager, useWindowsKeybindings } from "../src/core/keybindings.js";
import { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const REORDER_UP = useWindowsKeybindings() ? "\x1bq" : "\x1b[1;3A";
const REORDER_DOWN = "\x1b[1;3B";

interface ModelState {
	id: string;
	name: string;
	enabled: boolean;
}

function getMarkerStates(selector: ScopedModelsSelectorComponent, models: ModelState[]): boolean[] {
	const lines = stripAnsi(selector.render(120).join("\n")).split("\n");
	return models.map((model) => {
		const line = lines.find((candidate) => candidate.includes(`/${model.id}`));
		if (!line) throw new Error(`Expected rendered row for ${model.id}`);
		return line.includes("[✓] ");
	});
}

describe("scoped models selector", () => {
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

	async function createSelector(models: ModelState[]) {
		harness = await createHarness({ models });
		const provider = harness.models[0].provider;
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: models.filter((model) => model.enabled).map((model) => `${provider}/${model.id}`),
			},
			{
				onChange: (enabledModelIds) => {
					for (const model of models) {
						model.enabled = enabledModelIds === null || enabledModelIds.includes(`${provider}/${model.id}`);
					}
				},
				onCancel: () => {},
			},
		);
		return selector;
	}

	it("labels models by raw ID, with a differing display name in a dim column (pi #5916, #4269)", async () => {
		const selector = await createSelector([
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Renamed B", enabled: true },
		]);
		const provider = harness!.models[0].provider;

		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.slice(7).trimEnd());
		assert.ok(rows.includes(`${provider}/model-a`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/model-b  Renamed B`), rows.join("\n"));
	});

	it("shows the level each model is cycled to after its ID (#4269)", async () => {
		harness = await createHarness({
			models: [
				{ id: "reasoning-model", name: "Reasoning Model", reasoning: true },
				{ id: "plain-model", name: "Plain Model", reasoning: false },
			],
		});
		const provider = harness.models[0].provider;
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: [...harness.models], enabledModelIds: null, thinkingLevelFor: () => "xhigh" },
			{ onChange: () => {}, onCancel: () => {} },
		);

		const rows = stripAnsi(selector.render(120).join("\n"))
			.split("\n")
			.map((line) => line.slice(7).trimEnd());
		assert.ok(rows.includes(`${provider}/reasoning-model  xhigh`), rows.join("\n"));
		assert.ok(rows.includes(`${provider}/plain-model`), rows.join("\n"));
	});

	it.each(["model-b", "model"])("keeps the model selected when reordering with filter %s (#3657)", async (query) => {
		harness = await createHarness({
			models: [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
			],
		});
		const orderedIds = harness.models.map((model) => `${model.provider}/${model.id}`);
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: harness.models, enabledModelIds: orderedIds },
			{
				onChange: (ids) => {
					changes.push(ids);
				},
				onCancel: () => {},
			},
		);
		selector.handleInput(query);
		if (query === "model") selector.handleInput("\x1b[B");

		assert.doesNotThrow(() => selector.handleInput(REORDER_UP));
		assert.deepEqual(changes, [[orderedIds[1], orderedIds[0]]]);
		assert.match(stripAnsi(selector.render(120).join("\n")), /❯ \[✓\] \S+\/model-b *$/m);

		selector.handleInput(REORDER_UP);
		assert.equal(changes.length, 1);

		selector.handleInput(REORDER_DOWN);
		assert.deepEqual(changes, [[orderedIds[1], orderedIds[0]], orderedIds]);
		assert.match(stripAnsi(selector.render(120).join("\n")), /❯ \[✓\] \S+\/model-b *$/m);

		selector.handleInput(REORDER_DOWN);
		assert.equal(changes.length, 2);
	});

	it.each(["empty", "populated"])(
		"invalidates the prior yank when clearing search with a %s model list (#3668)",
		async (list) => {
			if (list === "populated") harness = await createHarness({ models: [{ id: "model-a", name: "Model A" }] });
			let cancellations = 0;
			const selector = new ScopedModelsSelectorComponent(
				{ allModels: harness?.models ?? [], enabledModelIds: null },
				{
					onChange: () => {},
					onCancel: () => {
						cancellations++;
					},
				},
			);
			selector.focused = true;
			for (const key of ["a", "\x15", "beta", "\x15", "\x19"]) selector.handleInput(key);
			assert.equal(selector.getSearchInput().getValue(), "beta");

			selector.handleInput("\x03");
			assert.equal(selector.getSearchInput().getValue(), "");
			assert.equal(cancellations, 0);
			selector.handleInput("\x1by");
			assert.equal(selector.getSearchInput().getValue(), "");
			assert.ok(selector.render(120).some((line) => line.includes(`⌕ ${CURSOR_MARKER}`)));
			if (list === "populated") assert.match(stripAnsi(selector.render(120).join("\n")), /\/model-a *$/m);

			selector.handleInput("ok");
			assert.equal(selector.getSearchInput().getValue(), "ok");
			assert.ok(selector.render(120).some((line) => line.includes(`⌕ ok${CURSOR_MARKER}`)));
			selector.handleInput("\x03");
			selector.handleInput("\x03");
			assert.equal(cancellations, 1);
		},
	);

	it.each(["\x1b[99;5u", "\x1b[1089::99;5u", "\x1b[27;5;99~"])(
		"Ctrl+C encoding %j clears scoped search before cancelling (#5237)",
		async (key) => {
			harness = await createHarness({ models: [{ id: "model-a", name: "Model A" }] });
			let cancellations = 0;
			const selector = new ScopedModelsSelectorComponent(
				{ allModels: harness.models, enabledModelIds: null },
				{
					onChange: () => {},
					onCancel: () => {
						cancellations++;
					},
				},
			);
			selector.handleInput("model");
			selector.handleInput(key);
			assert.equal(selector.getSearchInput().getValue(), "");
			assert.equal(cancellations, 0);
			selector.handleInput(key);
			assert.equal(cancellations, 1);
		},
	);

	it("marks every model after enabling all", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
			{ id: "model-c", name: "Model C", enabled: false },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x01");

		expect(models.map((model) => model.enabled)).toEqual([true, true, true]);
		expect(getMarkerStates(selector, models)).toEqual([true, true, true]);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("all enabled");
	});

	it("disables only the selected model after enabling all", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
			{ id: "model-c", name: "Model C", enabled: false },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x01");
		selector.handleInput("\r");

		expect(models.map((model) => model.enabled)).toEqual([false, true, true]);
		expect(getMarkerStates(selector, models)).toEqual([false, true, true]);
	});

	it("enables only the selected model after clearing all", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: true },
			{ id: "model-c", name: "Model C", enabled: true },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x18");
		expect(models.map((model) => model.enabled)).toEqual([false, false, false]);
		expect(getMarkerStates(selector, models)).toEqual([false, false, false]);

		selector.handleInput("\r");
		expect(models.map((model) => model.enabled)).toEqual([true, false, false]);
		expect(getMarkerStates(selector, models)).toEqual([true, false, false]);
	});

	it("restores the all-enabled state after re-enabling the last disabled model", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
			{ id: "model-c", name: "Model C", enabled: false },
		];
		const selector = await createSelector(models);

		selector.handleInput("\x01"); // enable all -> null
		selector.handleInput("\r"); // disable model-a; enabled models re-sort first: [b, c, a]
		selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[B"); // move selection back to model-a
		selector.handleInput("\r"); // re-enable model-a

		expect(models.map((model) => model.enabled)).toEqual([true, true, true]);
		expect(getMarkerStates(selector, models)).toEqual([true, true, true]);
		expect(stripAnsi(selector.render(120).join("\n"))).toContain("all enabled");
	});

	it("uses the shared selector: checkboxes, a count under the title, and a hint of exactly its keys (#5224)", async () => {
		const models = [
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
		];
		const selector = await createSelector(models);
		const lines = () => stripAnsi(selector.render(160).join("\n")).split("\n");
		const reorder = useWindowsKeybindings() ? "alt+q/alt+↓" : "alt+↑/alt+↓";
		expect(lines()[1]).toBe("  Scoped models");
		expect(lines()[2]).toBe("  Changes are saved automatically · 1/2 enabled");
		expect(lines().at(-2)?.trim()).toBe(
			`↑↓ select · enter toggle · ctrl+a all · ctrl+x clear · ctrl+p provider · ${reorder} reorder · type to search · esc cancel`,
		);
		selector.handleInput("\x1b[B");
		expect(lines().at(-2)).not.toContain("reorder");
		for (const width of [40, 80, 160]) {
			for (const line of selector.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("reuses model metadata while toggling and refreshes it with the catalog (#5237)", async () => {
		harness = await createHarness({ models: [{ id: "model-a", reasoning: true }] });
		let name = "Original custom title";
		let nameReads = 0;
		let level = "low";
		const model = {
			...harness.models[0],
			get name() {
				nameReads++;
				return name;
			},
		};
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: [model], enabledModelIds: null, thinkingLevelFor: () => level },
			{ onChange: () => {}, onCancel: () => {} },
		);
		assert.ok(stripAnsi(selector.render(160).join("\n")).includes(name));
		nameReads = 0;
		level = "high";

		selector.handleInput("\r");

		const toggled = stripAnsi(selector.render(160).join("\n"));
		assert.equal(nameReads, 0);
		assert.ok(toggled.includes(`[ ] ${model.provider}/${model.id}  high`), toggled);
		assert.ok(toggled.includes(name), toggled);

		name = "Refreshed custom title";
		selector.updateModels([model]);
		selector.handleInput("Refreshed");
		const refreshed = stripAnsi(selector.render(160).join("\n"));
		assert.ok(nameReads > 0);
		assert.ok(refreshed.includes(name), refreshed);
		assert.ok(!refreshed.includes("Original custom title"), refreshed);
	});

	it("resolves row labels and metadata lazily for visible rows on open and toggle (#5237)", async () => {
		const modelSpecs = Array.from({ length: 20 }, (_, index) => ({
			id: `model-${String(index).padStart(2, "0")}`,
			name: `Distinct Title ${index}`,
			reasoning: true,
		}));
		harness = await createHarness({ models: modelSpecs });
		const nameReads = new Set<string>();
		const levelReads = new Set<string>();
		const trackedModels = harness.models.map((baseModel, index) => ({
			...baseModel,
			get name() {
				nameReads.add(baseModel.id);
				return `Distinct Title ${index}`;
			},
		}));

		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: trackedModels,
				enabledModelIds: null,
				thinkingLevelFor: (model) => {
					levelReads.add(model.id);
					return "high";
				},
			},
			{ onChange: () => {}, onCancel: () => {} },
		);

		assert.equal(nameReads.size, 0);
		assert.equal(levelReads.size, 0);

		selector.render(120);
		assert.equal(nameReads.size, 8);
		assert.equal(levelReads.size, 8);
		assert.equal(nameReads.has("model-19"), false);
		assert.equal(levelReads.has("model-19"), false);

		nameReads.clear();
		levelReads.clear();
		selector.handleInput("\r");
		selector.render(120);
		assert.deepEqual([...nameReads], ["model-08"]);
		assert.equal(levelReads.size, 8);
		assert.equal(levelReads.has("model-00"), false);
		assert.equal(levelReads.has("model-19"), false);

		selector.handleInput("Distinct Title 19");
		const searched = stripAnsi(selector.render(120).join("\n"));
		assert.ok(nameReads.has("model-19"));
		assert.ok(levelReads.has("model-19"));
		assert.ok(searched.includes("model-19  high  Distinct Title 19"), searched);
	});

	it("clears the search before esc closes it", async () => {
		let cancellations = 0;
		harness = await createHarness({ models: [{ id: "model-a", name: "Model A" }] });
		const selector = new ScopedModelsSelectorComponent(
			{ allModels: harness.models, enabledModelIds: null },
			{ onChange: () => {}, onCancel: () => cancellations++ },
		);
		selector.handleInput("zz");
		selector.handleInput("\x1b");
		assert.equal(selector.getSearchInput().getValue(), "");
		assert.equal(cancellations, 0);
		selector.handleInput("\x1b");
		assert.equal(cancellations, 1);
	});

	it("ignores the displayed thinking level when filtering and bulk-clearing models (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "gpt-5", name: "GPT-5", reasoning: true },
				{ id: "o3", name: "o3", reasoning: true },
				{ id: "claude-opus", name: "Claude Opus", reasoning: true },
				{ id: "gemini-pro", name: "Gemini Pro", reasoning: true },
				{ id: "mistral-medium", name: "Mistral Medium", reasoning: true },
			],
		});
		const provider = harness.models[0].provider;
		let latestEnabledIds: string[] | null = null;
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: null,
				thinkingLevelFor: () => "medium",
			},
			{
				onChange: (enabledModelIds) => {
					latestEnabledIds = enabledModelIds;
				},
				onCancel: () => {},
			},
		);

		selector.handleInput("medium");

		const filteredOutput = stripAnsi(selector.render(120).join("\n"));
		assert.ok(filteredOutput.includes(`${provider}/mistral-medium  medium`), filteredOutput);
		assert.ok(!filteredOutput.includes(`${provider}/gpt-5`), filteredOutput);
		assert.ok(!filteredOutput.includes(`${provider}/o3`), filteredOutput);

		selector.handleInput("\x18");

		assert.deepEqual(latestEnabledIds, [
			`${provider}/gpt-5`,
			`${provider}/o3`,
			`${provider}/claude-opus`,
			`${provider}/gemini-pro`,
		]);
	});

	it("deduplicates enabled model IDs on construction and update so toggling disables the model (#5237)", async () => {
		harness = await createHarness({
			models: [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
			],
		});
		const provider = harness.models[0].provider;
		const modelA = `${provider}/model-a`;
		const changes: Array<string[] | null> = [];
		const selector = new ScopedModelsSelectorComponent(
			{
				allModels: [...harness.models],
				enabledModelIds: [modelA, modelA],
			},
			{
				onChange: (enabledModelIds) => {
					changes.push(enabledModelIds);
				},
				onCancel: () => {},
			},
		);

		const initialLines = stripAnsi(selector.render(120).join("\n")).split("\n");
		assert.equal(initialLines.filter((line) => line.includes(modelA)).length, 1);
		assert.ok(initialLines.some((line) => line.includes("1/2 enabled")));

		selector.handleInput("\r");
		assert.deepEqual(changes, [[]]);

		selector.updateModels([...harness.models], [modelA, modelA]);
		const updatedLines = stripAnsi(selector.render(120).join("\n")).split("\n");
		assert.equal(updatedLines.filter((line) => line.includes(modelA)).length, 1);
		assert.ok(updatedLines.some((line) => line.includes("1/2 enabled")));

		selector.handleInput("\r");
		assert.deepEqual(changes, [[], []]);
	});

	it("keeps enter toggle and esc cancel in narrow hints instead of ctrl+x clear (#5237)", async () => {
		const selector = await createSelector([
			{ id: "model-a", name: "Model A", enabled: true },
			{ id: "model-b", name: "Model B", enabled: false },
		]);

		for (let width = 27; width <= 41; width++) {
			const hint = stripAnsi(selector.render(width).at(-2) ?? "").trim();
			assert.ok(hint.includes("enter toggle"), `missing enter toggle at width ${width}: ${hint}`);
			assert.ok(hint.includes("esc cancel"), `missing esc cancel at width ${width}: ${hint}`);
		}

		for (let width = 42; width <= 54; width++) {
			const hint = stripAnsi(selector.render(width).at(-2) ?? "").trim();
			assert.ok(hint.includes("enter toggle"), `missing enter toggle at width ${width}: ${hint}`);
			assert.ok(hint.includes("esc cancel"), `missing esc cancel at width ${width}: ${hint}`);
			if (!hint.includes("ctrl+x clear")) {
				assert.ok(hint.includes("ctrl+a all"), `dropped ctrl+a all before ctrl+x clear at width ${width}: ${hint}`);
			}
		}

		selector.handleInput("model");
		for (let width = 30; width <= 40; width++) {
			const hint = stripAnsi(selector.render(width).at(-2) ?? "").trim();
			assert.ok(hint.includes("enter toggle"), `missing enter toggle at width ${width}: ${hint}`);
			assert.ok(hint.includes("esc clear"), `missing esc clear at width ${width}: ${hint}`);
		}
	});
});
