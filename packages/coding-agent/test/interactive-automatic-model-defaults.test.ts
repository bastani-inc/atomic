import assert from "node:assert/strict";
import { afterEach, beforeAll, test, vi } from "vitest";
import { KEYBINDINGS } from "../src/core/keybindings.js";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.js";
import "../src/modes/interactive/interactive-model-routing.js";
import "../src/modes/interactive/interactive-editor-actions.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { createHarness, type Harness } from "./suite/harness.js";

let harness: Harness;
beforeAll(() => initTheme("dark"));
afterEach(() => harness?.cleanup());

async function createMode() {
	harness = await createHarness({
		models: [
			{ id: "first", reasoning: true },
			{ id: "second", reasoning: true },
			{ id: "plain", reasoning: false },
		],
	});
	return {
		session: harness.session,
		footer: { invalidate: () => {} },
		updateEditorBorderColor: () => {},
		showStatus: () => {},
		showError: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
		checkDaxnutsEasterEgg: () => {},
		findExactModelMatch: async (id: string) => harness.getModel(id),
		selectThinkingLevel: InteractiveModeBase.prototype.selectThinkingLevel,
	};
}

function assertDefaults(modelId: string, level: string) {
	assert.equal(harness.settingsManager.getDefaultProvider(), harness.session.model?.provider);
	assert.equal(harness.settingsManager.getDefaultModel(), modelId);
	assert.equal(harness.settingsManager.getDefaultThinkingLevel(), level);
	assert.equal(harness.settingsManager.getModelThinkingLevel(harness.session.model!.provider, modelId), level);
}

test("removed actions are absent from the keybinding registry", () => {
	for (const action of ["app.message.copy", "app.models.save", "app.thinking.save"]) {
		assert.equal(Object.hasOwn(KEYBINDINGS, action), false);
	}
});

test("model and thinking commands automatically persist the last user choices", async () => {
	const mode = await createMode();
	await InteractiveModeBase.prototype.handleModelCommand.call(mode as never, "second");
	InteractiveModeBase.prototype.handleThinkingCommand.call(mode as never, "high");
	assertDefaults("second", "high");
	InteractiveModeBase.prototype.handleThinkingCommand.call(mode as never, "low");
	assertDefaults("second", "low");
	assert.equal(mode.showError.mock.calls.length, 0);
});

test("available and scoped model cycling persist the model and effective thinking level", async () => {
	const mode = await createMode();
	harness.session.setThinkingLevel("high");
	await InteractiveModeBase.prototype.cycleModel.call(mode as never, "forward");
	assertDefaults("second", "high");
	harness.session.setScopedModels([
		{ model: harness.getModel("first")!, thinkingLevel: "low" },
		{ model: harness.getModel("second")!, thinkingLevel: "high" },
	]);
	await InteractiveModeBase.prototype.cycleModel.call(mode as never, "backward");
	assertDefaults("first", "low");
	InteractiveModeBase.prototype.cycleThinkingLevel.call(mode as never);
	assertDefaults("first", harness.session.thinkingLevel);
});

test("model switching saves the capability-clamped thinking level", async () => {
	const mode = await createMode();
	harness.session.setThinkingLevel("high");
	await InteractiveModeBase.prototype.handleModelCommand.call(mode as never, "plain");
	assertDefaults("plain", "off");
});

test("programmatic changes do not replace the user's defaults", async () => {
	const mode = await createMode();
	await InteractiveModeBase.prototype.handleModelCommand.call(mode as never, "second");
	InteractiveModeBase.prototype.handleThinkingCommand.call(mode as never, "high");
	await harness.session.setModel(harness.getModel("first")!);
	harness.session.setThinkingLevel("low");
	assert.equal(harness.settingsManager.getDefaultModel(), "second");
	assert.equal(harness.settingsManager.getDefaultThinkingLevel(), "high");
});

test("failed user model selection leaves defaults unchanged", async () => {
	const mode = await createMode();
	await InteractiveModeBase.prototype.handleModelCommand.call(mode as never, "second");
	vi.spyOn(harness.session.modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
	await InteractiveModeBase.prototype.handleModelCommand.call(mode as never, "first");
	assert.equal(harness.settingsManager.getDefaultModel(), "second");
	assert.equal(mode.showError.mock.calls.length, 1);
});
