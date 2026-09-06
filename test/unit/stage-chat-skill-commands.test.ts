import assert from "node:assert/strict";
import { type AgentSession, buildSkillCatalog } from "@bastani/atomic";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { createSessionSkillAutocompleteProvider } from "../../packages/coding-agent/src/modes/interactive/skill-command-autocomplete.js";
import { createStageSkillFixture } from "../fixtures/stage-chat-skill-session.js";
import { FakePromptEditor, flush, makeFakeKeybindings, makeTestTui, StageUiBroker } from "./stage-chat-view-helpers.js";

test("#2884 stage skill suggestions use the attached catalog and source metadata, including qualified alternatives", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const provider = createSessionSkillAutocompleteProvider(async () => fixture.stage.session);
		const text = "/skill:fi";
		const suggestions = await provider.getSuggestions([text], 0, text.length, {
			signal: new AbortController().signal,
		});
		assert.deepEqual(
			suggestions?.items.map((item) => item.value),
			["skill:fixture", "skill:fixture@project", "skill:fixture@user"],
		);
		assert.match(suggestions?.items[0]?.description ?? "", /\[p:npm:stage-project\]/);
		assert.ok(suggestions?.items.every((item) => !item.description?.includes("main-project")));
		assert.ok(suggestions);
		const applied = provider.applyCompletion([text], 0, text.length, suggestions.items[1]!, suggestions.prefix);
		assert.equal(applied.lines[0], "/skill:fixture@project ");
	} finally {
		await fixture.cleanup();
	}
});

test("#2884 stage discovery honors disabled registration and observes catalog reload without remount", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const provider = createSessionSkillAutocompleteProvider(async () => fixture.stage.session);
		const query = () => provider.getSuggestions(["/skill:fi"], 0, 9, { signal: new AbortController().signal });
		fixture.stage.settingsManager.setEnableSkillCommands(false);
		assert.equal(await query(), null);
		fixture.stage.settingsManager.setEnableSkillCommands(true);
		fixture.setCatalog(buildSkillCatalog([fixture.userSkill]));
		const reloaded = await query();
		assert.deepEqual(
			reloaded?.items.map((item) => item.value),
			["skill:fixture"],
		);
		assert.match(reloaded?.items[0]?.description ?? "", /\[u:npm:stage-user\]/);
	} finally {
		await fixture.cleanup();
	}
});

test("#2884 missing metadata is explicit and cancelled discovery publishes no result or warning", async () => {
	const warnings: string[] = [];
	const provider = createSessionSkillAutocompleteProvider(
		async () => undefined,
		(message) => warnings.push(message),
	);
	assert.equal(await provider.getSuggestions(["/skill:"], 0, 7, { signal: new AbortController().signal }), null);
	assert.match(warnings[0] ?? "", /stage host does not expose.*command metadata/);
	const pending = Promise.withResolvers<AgentSession | undefined>();
	const cancelled = createSessionSkillAutocompleteProvider(
		() => pending.promise,
		(message) => warnings.push(message),
	);
	const abort = new AbortController();
	const suggestions = cancelled.getSuggestions(["/skill:"], 0, 7, { signal: abort.signal });
	abort.abort();
	pending.resolve(undefined);
	assert.equal(await suggestions, null);
	assert.equal(warnings.length, 1);
});

test("#2884 mounted stage editor replaces inherited parent completion with stage-bound discovery", async () => {
	const fixture = await createStageSkillFixture();
	try {
		let provider: AutocompleteProvider | undefined;
		class Editor extends FakePromptEditor {
			setAutocompleteProvider(value: AutocompleteProvider) {
				provider = value;
			}
		}
		fixture.mount({
			piTui: makeTestTui(24),
			piKeybindings: makeFakeKeybindings(),
			piEditorFactory: () => new Editor(),
		});
		assert.ok(provider);
		const result = await provider.getSuggestions(["/skill:fi"], 0, 9, { signal: new AbortController().signal });
		assert.match(result?.items[0]?.description ?? "", /stage-project/);
		assert.ok(result?.items.every((item) => !item.description?.includes("main-project")));
	} finally {
		await fixture.cleanup();
	}
});

test("#2884 mounted custom questions receive slash-looking input literally before composer commands", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const broker = new StageUiBroker(fixture.store);
		const view = fixture.mount({
			stageUiBroker: broker,
			piTui: makeTestTui(24),
			piTheme: {},
			piKeybindings: makeFakeKeybindings(),
		});
		let text = "";
		const answer = broker.requestCustomUi(
			fixture.runId,
			fixture.stageId,
			(_tui, _theme, _keys, done) => ({
				render: () => [text],
				handleInput(data: string) {
					if (data === "\r") done(text);
					else text += data;
					return true;
				},
				invalidate() {},
			}),
			{ overlay: true },
		);
		await flush();
		const before = fixture.userTexts();
		for (const character of "/skill:fixture literal") view.handleInput(character);
		view.handleInput("\r");
		assert.equal(await answer, "/skill:fixture literal");
		assert.deepEqual(fixture.userTexts(), before);
		assert.equal(fixture.stage.session.getSteeringMessages().length, 0);
	} finally {
		await fixture.cleanup();
	}
});
