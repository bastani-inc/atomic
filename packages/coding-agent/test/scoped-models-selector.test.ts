import assert from "node:assert/strict";
import { CURSOR_MARKER, setKeybindings } from "@earendil-works/pi-tui";
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
		const line = lines.find((candidate) => candidate.includes(`${model.id} [`));
		if (!line) throw new Error(`Expected rendered row for ${model.id}`);
		return line.slice(2).startsWith("✓ ");
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
		assert.match(stripAnsi(selector.render(120).join("\n")), /→ ✓ model-b \[/);

		selector.handleInput(REORDER_UP);
		assert.equal(changes.length, 1);

		selector.handleInput(REORDER_DOWN);
		assert.deepEqual(changes, [[orderedIds[1], orderedIds[0]], orderedIds]);
		assert.match(stripAnsi(selector.render(120).join("\n")), /→ ✓ model-b \[/);

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
			assert.ok(selector.render(120).some((line) => line.startsWith(`> ${CURSOR_MARKER}`)));
			if (list === "populated") assert.match(stripAnsi(selector.render(120).join("\n")), /model-a \[/);

			selector.handleInput("ok");
			assert.equal(selector.getSearchInput().getValue(), "ok");
			assert.ok(selector.render(120).some((line) => line.startsWith(`> ok${CURSOR_MARKER}`)));
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
});
