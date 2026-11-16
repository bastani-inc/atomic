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
});
