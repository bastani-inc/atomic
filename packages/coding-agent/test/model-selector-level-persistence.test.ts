import assert from "node:assert/strict";
import { setKeybindings, type TUI } from "@bastani/atomic-tui";
import { afterEach, beforeAll, beforeEach, describe, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ENTER = "\r";

type SelectorFactory = (done: () => void) => { component: ModelSelectorComponent; dispose?: () => void };

/** The interactive mode around `/model`: the real routing, with the screen replaced by a captured picker. */
function openModelPicker(harness: Harness) {
	let picker: ModelSelectorComponent | undefined;
	let closed = false;
	const status: string[] = [];
	const errors: string[] = [];
	const mode = {
		session: harness.session,
		settingsManager: harness.settingsManager,
		ui: { requestRender: () => {} } as unknown as TUI,
		footer: { invalidate: () => {} },
		showSelector: (create: SelectorFactory) => {
			const created = create(() => {
				closed = true;
				created.dispose?.();
			});
			picker = created.component;
		},
		updateAvailableProviderCount: async () => {},
		updateEditorBorderColor: () => {},
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		showStatus: (message: string) => status.push(message),
		showError: (message: string) => errors.push(message),
	};
	InteractiveModeBase.prototype.showModelSelector.call(mode as unknown as InteractiveModeBase);
	if (!picker) throw new Error("expected /model to open a picker");
	const opened = picker;
	return {
		picker: opened,
		status,
		errors,
		isClosed: () => closed,
		row: (id: string) =>
			stripAnsi(opened.render(160).join("\n"))
				.split("\n")
				.find((line) => line.includes(`/${id}`))
				?.trim(),
	};
}

describe("/model ←→ reasoning level (#5224)", () => {
	let harness: Harness | undefined;

	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
	});

	async function setUp() {
		harness = await createHarness({
			models: [
				{ id: "current-model", name: "Current Model", reasoning: true },
				{ id: "other-model", name: "Other Model", reasoning: true },
			],
		});
		const current = harness.getModel("current-model")!;
		await harness.session.setModel(current);
		await harness.session.setThinkingLevel("low");
		return { harness, provider: current.provider };
	}

	it("saves the level chosen with ←→ as the model's level and the default, and the next picker shows it", async () => {
		const { harness, provider } = await setUp();
		const first = openModelPicker(harness);
		first.picker.handleInput(DOWN);
		assert.match(first.row("other-model") ?? "", /other-model +low\b/);
		first.picker.handleInput(RIGHT);
		assert.match(first.row("other-model") ?? "", /other-model +medium\b/);
		first.picker.handleInput(ENTER);
		await vi.waitFor(() => assert.equal(first.isClosed(), true));

		assert.deepEqual(first.errors, []);
		assert.equal(harness.session.model?.id, "other-model");
		assert.equal(harness.session.thinkingLevel, "medium");
		assert.equal(harness.settingsManager.getModelThinkingLevel(provider, "other-model"), "medium");
		assert.equal(harness.settingsManager.getDefaultThinkingLevel(), "medium");
		assert.ok(first.status.some((line) => line.includes("other-model") && line.includes("medium")));

		// The saved level survives: a fresh picker labels the model with it, and a model switch back applies it.
		const second = openModelPicker(harness);
		assert.match(second.row("other-model") ?? "", /other-model +medium\b/);
		second.picker.dispose();
	});

	it.each([
		["without ←→", [] as string[]],
		["after → then ← back to the shown level", [RIGHT, LEFT]],
	])("switches at the level the row shows %s", async (_name, keys) => {
		const { harness } = await setUp();
		const picker = openModelPicker(harness);
		picker.picker.handleInput(DOWN);
		for (const key of keys) picker.picker.handleInput(key);
		assert.match(picker.row("other-model") ?? "", /other-model +low\b/);
		picker.picker.handleInput(ENTER);
		await vi.waitFor(() => assert.equal(picker.isClosed(), true));

		assert.equal(harness.session.model?.id, "other-model");
		assert.equal(harness.session.thinkingLevel, "low");
	});

	it("does not save a level when the picker is cancelled after ←→", async () => {
		const { harness, provider } = await setUp();
		const picker = openModelPicker(harness);
		picker.picker.handleInput(DOWN);
		picker.picker.handleInput(RIGHT);
		picker.picker.handleInput("\x1b");
		assert.equal(picker.isClosed(), true);

		assert.equal(harness.session.model?.id, "current-model");
		assert.equal(harness.session.thinkingLevel, "low");
		assert.equal(harness.settingsManager.getModelThinkingLevel(provider, "other-model"), undefined);
	});

	it("ignores a second selection while the first model switch is in flight (#5237)", async () => {
		const { harness, provider } = await setUp();
		const picker = openModelPicker(harness);
		picker.picker.handleInput(DOWN);
		picker.picker.handleInput(RIGHT);
		picker.picker.handleInput(ENTER);
		picker.picker.handleInput("\x1b[A");
		picker.picker.handleInput(ENTER);
		await vi.waitFor(() => assert.equal(picker.isClosed(), true));

		assert.equal(harness.session.model?.id, "other-model");
		assert.equal(harness.session.thinkingLevel, "medium");
		assert.equal(harness.settingsManager.getModelThinkingLevel(provider, "other-model"), "medium");
		assert.equal(harness.settingsManager.getModelThinkingLevel(provider, "current-model"), undefined);
	});

	it("ignores a second → enter burst on the same model while a slow model_select handler is running (#5237)", async () => {
		const { harness, provider } = await setUp();
		const { promise, resolve } = Promise.withResolvers<void>();
		const originalEmitModelSelect = harness.session._emitModelSelect.bind(harness.session);
		vi.spyOn(harness.session, "_emitModelSelect").mockImplementation(async (nextModel, previousModel, source) => {
			await promise;
			await originalEmitModelSelect(nextModel, previousModel, source);
		});

		const picker = openModelPicker(harness);
		picker.picker.handleInput(DOWN);
		picker.picker.handleInput(RIGHT);
		picker.picker.handleInput(ENTER);
		picker.picker.handleInput(RIGHT);
		picker.picker.handleInput(ENTER);
		resolve();
		await vi.waitFor(() => assert.equal(picker.isClosed(), true));

		assert.equal(harness.session.model?.id, "other-model");
		assert.equal(harness.session.thinkingLevel, "medium");
		assert.equal(harness.settingsManager.getModelThinkingLevel(provider, "other-model"), "medium");
	});

	it("applies the chosen level in the model switch mutation before model_select handlers run (#5237)", async () => {
		const { harness, provider } = await setUp();
		let levelDuringModelSelect: string | undefined;
		const originalEmitModelSelect = harness.session._emitModelSelect.bind(harness.session);
		vi.spyOn(harness.session, "_emitModelSelect").mockImplementation(async (nextModel, previousModel, source) => {
			levelDuringModelSelect = harness.session.thinkingLevel;
			await originalEmitModelSelect(nextModel, previousModel, source);
			await harness.session.setThinkingLevel("high", { persist: true });
		});

		const picker = openModelPicker(harness);
		picker.picker.handleInput(DOWN);
		picker.picker.handleInput(RIGHT);
		picker.picker.handleInput(ENTER);
		await vi.waitFor(() => assert.equal(picker.isClosed(), true));

		assert.equal(levelDuringModelSelect, "medium");
		assert.equal(harness.session.model?.id, "other-model");
		assert.equal(harness.session.thinkingLevel, "high");
		assert.equal(harness.settingsManager.getModelThinkingLevel(provider, "other-model"), "high");
	});
});
