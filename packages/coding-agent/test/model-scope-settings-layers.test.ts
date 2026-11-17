import assert from "node:assert/strict";
import { setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, test } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import type { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import type { ScopedModelsSelectorComponent } from "../src/modes/interactive/components/scoped-models-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-model-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { createEngineHostPair } from "./helpers/in-process-engine-pair.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

beforeAll(() => initTheme("dark"));

const showModelsSelector = Reflect.get(InteractiveModeBase.prototype, "showModelsSelector") as (this: object) => void;
const showModelSelector = Reflect.get(InteractiveModeBase.prototype, "showModelSelector") as (
	this: object,
	initialSearchInput?: string,
) => void;
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";
const CTRL_A = "\x01";

const provider = "picker-scope-layers";
const current = `${provider}/current-model`;
const other = `${provider}/other-model`;
const third = `${provider}/third-model`;
const models = [
	{ id: "current-model", reasoning: true },
	{ id: "other-model", reasoning: true },
	{ id: "third-model", reasoning: true },
];
const scopes: Array<{ name: string; enabledModels?: string[] }> = [
	{ name: "a nonempty global scope", enabledModels: [third] },
	{ name: "no global scope" },
	{ name: "an empty global scope", enabledModels: [] },
	{ name: "the chosen model already globally enabled", enabledModels: [other.toUpperCase()] },
];
const scenarios = (["in-process", "isolated"] as const).flatMap((mode) => scopes.map((scope) => ({ mode, ...scope })));

test.each(scenarios)(
	"$mode preserves $name when a project limits model scope (#5237)",
	async ({ mode, enabledModels }) => {
		const storage = new InMemorySettingsStorage();
		const project = { enabledModels: [current] };
		storage.withLock("global", () => JSON.stringify({ enabledModels }));
		storage.withLock("project", () => JSON.stringify(project));
		const engineSettings = SettingsManager.fromStorage(storage);
		const hostSettings = SettingsManager.fromStorage(storage);
		const pair =
			mode === "isolated"
				? await createEngineHostPair({
						provider,
						models,
						settingsManager: engineSettings,
						hostSettingsManager: hostSettings,
					})
				: undefined;
		const harness = pair?.engine ?? (await createHarness({ provider, models, settingsManager: engineSettings }));
		try {
			await harness.session.bindExtensions({ shutdownHandler: () => {} });
			harness.session.setScopedModels([{ model: harness.getModel("current-model")! }]);
			if (pair) {
				await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
				await pair.runtime.initializeFromEngine();
				await pair.drain();
			}
			const session = pair?.runtime.session ?? harness.session;
			await session.setModel(harness.getModel("other-model")!, { persist: true });
			await pair?.drain();
			await Promise.all([engineSettings.flush(), hostSettings.flush()]);

			const expected =
				enabledModels?.length && !enabledModels.some((id) => id.toLowerCase() === other)
					? [...enabledModels, other]
					: enabledModels;
			const saved = SettingsManager.fromStorage(storage);
			assert.deepEqual(saved.getGlobalSettings().enabledModels, expected);
			assert.deepEqual(engineSettings.getGlobalSettings().enabledModels, expected);
			if (pair) assert.deepEqual(hostSettings.getGlobalSettings().enabledModels, expected);
			assert.deepEqual(saved.getProjectSettings(), project);
			assert.deepEqual(saved.getEnabledModels(), [current]);
			assert.ok(session.scopedModels.some(({ model }) => model.id === "other-model"));
		} finally {
			if (pair) await pair.cleanup();
			else await harness.cleanup();
		}
	},
);

function openScopedModelsPicker(session: Harness["session"], settingsManager: SettingsManager) {
	let selector: ScopedModelsSelectorComponent | undefined;
	const context = {
		session,
		settingsManager,
		showSelector: (
			factory: (done: () => void) => { component: ScopedModelsSelectorComponent; dispose?: () => void },
		) => {
			let dispose: (() => void) | undefined;
			const created = factory(() => dispose?.());
			selector = created.component;
			dispose = created.dispose;
		},
		updateAvailableProviderCount: async () => {},
		setupAutocompleteProvider: () => {},
		ui: { requestRender: () => {} },
		showStatus: () => {},
	};
	showModelsSelector.call(context);
	if (!selector) throw new Error("scoped models picker did not open");
	return selector;
}

function openModelPicker(session: Harness["session"], settingsManager: SettingsManager, initialSearchInput?: string) {
	let selector: ModelSelectorComponent | undefined;
	const context = {
		session,
		settingsManager,
		showSelector: (factory: (done: () => void) => { component: ModelSelectorComponent; dispose?: () => void }) => {
			let dispose: (() => void) | undefined;
			const created = factory(() => dispose?.());
			selector = created.component;
			dispose = created.dispose;
		},
		updateAvailableProviderCount: async () => {},
		footer: { invalidate: () => {} },
		updateEditorBorderColor: () => {},
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		ui: { requestRender: () => {} },
		showStatus: () => {},
		showError: () => {},
	};
	showModelSelector.call(context, initialSearchInput);
	if (!selector) throw new Error("model picker did not open");
	return selector;
}

test("isolated /scoped-models updates the engine Ctrl+P scope and the /model scope (#5237)", async () => {
	setKeybindings(new KeybindingsManager());
	const storage = new InMemorySettingsStorage();
	storage.withLock("global", () => JSON.stringify({ enabledModels: [current, other] }));
	storage.withLock("project", () => "{}");
	const engineSettings = SettingsManager.fromStorage(storage);
	const hostSettings = SettingsManager.fromStorage(storage);
	const pair = await createEngineHostPair({
		provider,
		models,
		settingsManager: engineSettings,
		hostSettingsManager: hostSettings,
	});
	try {
		await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
		await pair.engine.session.setModel(pair.engine.getModel("current-model")!);
		pair.engine.session.setScopedModels([
			{ model: pair.engine.getModel("current-model")! },
			{ model: pair.engine.getModel("other-model")! },
		]);
		await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
		await pair.runtime.initializeFromEngine();
		await pair.drain();

		const scopedPicker = openScopedModelsPicker(pair.runtime.session, hostSettings);
		scopedPicker.handleInput(DOWN);
		scopedPicker.handleInput(ENTER);
		scopedPicker.handleInput(ESC);
		await pair.drain();

		assert.deepEqual(
			pair.runtime.session.scopedModels.map(({ model }) => model.id),
			["current-model"],
		);
		assert.deepEqual(
			pair.engine.session.scopedModels.map(({ model }) => model.id),
			["current-model"],
		);
		assert.equal(await pair.runtime.session.cycleModel("forward"), undefined);
		assert.equal(pair.runtime.session.model?.id, "current-model");

		const allScopedPicker = openScopedModelsPicker(pair.runtime.session, hostSettings);
		allScopedPicker.handleInput(CTRL_A);
		allScopedPicker.handleInput(ESC);
		await pair.drain();

		assert.deepEqual(pair.runtime.session.scopedModels, []);
		assert.deepEqual(pair.engine.session.scopedModels, []);

		const modelPicker = openModelPicker(pair.runtime.session, hostSettings, "third-model");
		try {
			const rendered = stripAnsi(modelPicker.render(100).join("\n"));
			assert.ok(!rendered.includes("Scope: scoped models"));
			assert.ok(rendered.includes("third-model"));
			assert.ok(!rendered.includes('No matches for "third-model"'));
		} finally {
			modelPicker.dispose();
		}
	} finally {
		await pair.cleanup();
	}
});

test.each([
	{
		name: "enabling all models then persisting a model choice",
		keys: [CTRL_A, ESC],
		action: "set" as const,
		targetId: "third-model",
	},
	{
		name: "enabling all models then persisting a cycled model",
		keys: [CTRL_A, ESC],
		action: "cycle" as const,
		targetId: "other-model",
	},
	{
		name: "disabling a scoped model then re-selecting it as the persisted default",
		keys: [DOWN, ENTER, ESC],
		action: "set" as const,
		targetId: "other-model",
	},
	{
		name: "disabling a scoped model then persisting a model outside the previous scope",
		keys: [DOWN, ENTER, ESC],
		action: "set" as const,
		targetId: "third-model",
	},
])(
	"isolated /scoped-models matches in-process global settings when $name (#5237)",
	async ({ keys, action, targetId }) => {
		setKeybindings(new KeybindingsManager());
		const initialGlobal = { enabledModels: [current, other] };

		const refStorage = new InMemorySettingsStorage();
		refStorage.withLock("global", () => JSON.stringify(initialGlobal));
		refStorage.withLock("project", () => "{}");
		const refSettings = SettingsManager.fromStorage(refStorage);
		const reference = await createHarness({ provider, models, settingsManager: refSettings });
		let expectedStoredGlobal: ReturnType<SettingsManager["getGlobalSettings"]>;
		let expectedInMemoryGlobal: ReturnType<SettingsManager["getGlobalSettings"]>;
		let expectedScope: string[];
		try {
			await reference.session.bindExtensions({ shutdownHandler: () => {} });
			await reference.session.setModel(reference.getModel("current-model")!);
			reference.session.setScopedModels([
				{ model: reference.getModel("current-model")! },
				{ model: reference.getModel("other-model")! },
			]);
			const refPicker = openScopedModelsPicker(reference.session, refSettings);
			for (const key of keys) refPicker.handleInput(key);
			await refSettings.flush();
			if (action === "set") {
				await reference.session.setModel(reference.getModel(targetId)!, { persist: true });
			} else {
				await reference.session.cycleModel("forward", { persist: true });
			}
			await refSettings.flush();
			expectedStoredGlobal = SettingsManager.fromStorage(refStorage).getGlobalSettings();
			expectedInMemoryGlobal = refSettings.getGlobalSettings();
			expectedScope = reference.session.scopedModels.map(({ model }) => model.id);
		} finally {
			await reference.cleanup();
		}

		const storage = new InMemorySettingsStorage();
		storage.withLock("global", () => JSON.stringify(initialGlobal));
		storage.withLock("project", () => "{}");
		const engineSettings = SettingsManager.fromStorage(storage);
		const hostSettings = SettingsManager.fromStorage(storage);
		const pair = await createEngineHostPair({
			provider,
			models,
			settingsManager: engineSettings,
			hostSettingsManager: hostSettings,
		});
		try {
			await pair.engine.session.bindExtensions({ shutdownHandler: () => {} });
			await pair.engine.session.setModel(pair.engine.getModel("current-model")!);
			pair.engine.session.setScopedModels([
				{ model: pair.engine.getModel("current-model")! },
				{ model: pair.engine.getModel("other-model")! },
			]);
			await pair.runtime.session.bindExtensions({ shutdownHandler: () => {} });
			await pair.runtime.initializeFromEngine();
			await pair.drain();

			const picker = openScopedModelsPicker(pair.runtime.session, hostSettings);
			for (const key of keys) picker.handleInput(key);
			await pair.drain();
			await Promise.all([engineSettings.flush(), hostSettings.flush()]);

			if (action === "set") {
				await pair.runtime.session.setModel(pair.engine.getModel(targetId)!, { persist: true });
			} else {
				await pair.runtime.session.cycleModel("forward", { persist: true });
			}
			await pair.drain();
			await Promise.all([engineSettings.flush(), hostSettings.flush()]);

			assert.deepEqual(SettingsManager.fromStorage(storage).getGlobalSettings(), expectedStoredGlobal);
			assert.deepEqual(engineSettings.getGlobalSettings(), expectedInMemoryGlobal);
			assert.deepEqual(hostSettings.getGlobalSettings(), expectedInMemoryGlobal);
			assert.deepEqual(
				pair.engine.session.scopedModels.map(({ model }) => model.id),
				expectedScope,
			);
			assert.deepEqual(
				pair.runtime.session.scopedModels.map(({ model }) => model.id),
				expectedScope,
			);
		} finally {
			await pair.cleanup();
		}
	},
);
