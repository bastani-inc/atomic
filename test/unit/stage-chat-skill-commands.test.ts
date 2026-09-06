import assert from "node:assert/strict";
import { type AgentSession, buildSkillCatalog } from "@bastani/atomic";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createSessionSkillAutocompleteProvider } from "../../packages/coding-agent/src/modes/interactive/skill-command-autocomplete.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { createStageSkillFixture, submitStageSkillText } from "../fixtures/stage-chat-skill-session.js";
import {
	FakePromptEditor,
	flush,
	makeFakeKeybindings,
	makeHandle,
	makeTestTui,
	StageUiBroker,
	setupRun,
} from "./stage-chat-view-helpers.js";

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

test.each(["blocked", "archived", "disposed", "missing metadata"] as const)(
	"#2884 stage discovery distinguishes %s from missing command metadata",
	async (state) => {
		const store = createStore();
		setupRun(
			store,
			"run-1",
			"stage-a",
			state === "blocked" ? "blocked" : state === "archived" ? "completed" : "running",
		);
		let provider: AutocompleteProvider | undefined;
		class Editor extends FakePromptEditor {
			setAutocompleteProvider(value: AutocompleteProvider) {
				provider = value;
			}
		}
		const { handle } = makeHandle();
		const view = new StageChatView({
			store,
			runId: "run-1",
			stageId: "stage-a",
			workflowName: "test-wf",
			graphTheme: deriveGraphTheme({}),
			handle: state === "archived" ? undefined : { ...handle, isDisposed: state === "disposed" },
			onDetach() {},
			onClose() {},
			piTui: makeTestTui(24),
			piKeybindings: makeFakeKeybindings(),
			piEditorFactory: () => new Editor(),
		});
		try {
			assert.ok(provider);
			assert.equal(
				await provider.getSuggestions(["/skill:fi"], 0, 9, { signal: new AbortController().signal }),
				null,
			);
			assert.equal(
				view._statusMessage,
				state === "missing metadata"
					? "Skill discovery unavailable: this stage host does not expose its session command metadata."
					: "Skill discovery unavailable: This stage chat is not editable.",
			);
		} finally {
			view.dispose();
		}
	},
);

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

test.each(["blocked", "disposed", "question"] as const)(
	"#2884 lazy discovery rechecks %s admission after attachment without a parent fallback",
	async (state) => {
		const fixture = await createStageSkillFixture();
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let pending: ReturnType<AutocompleteProvider["getSuggestions"]> | undefined;
		try {
			let session: AgentSession | undefined;
			let disposed = false;
			const { handle: emptyHandle } = makeHandle();
			const handle = {
				...emptyHandle,
				get agentSession() {
					return session;
				},
				get isDisposed() {
					return disposed;
				},
			};
			let provider: AutocompleteProvider | undefined;
			class Editor extends FakePromptEditor {
				setAutocompleteProvider(value: AutocompleteProvider) {
					provider = value;
				}
			}
			const view = fixture.mount({
				handle,
				piTui: makeTestTui(24),
				piKeybindings: makeFakeKeybindings(),
				piEditorFactory: () => new Editor(),
			});
			// This host has not exposed a session during mount; discovery resolves it lazily.
			handle.ensureAttached = async () => {
				entered.resolve();
				await release.promise;
				session = fixture.stage.session;
			};
			assert.ok(provider);
			assert.equal(handle.agentSession, undefined);
			pending = provider.getSuggestions(["/skill:fi"], 0, 9, { signal: new AbortController().signal });
			await entered.promise;
			if (state === "disposed") disposed = true;
			else if (state === "blocked") {
				fixture.store.recordStageEnd(fixture.runId, { ...fixture.store.runs()[0]!.stages[0]!, status: "blocked" });
			} else {
				fixture.store.recordStagePendingPrompt(fixture.runId, fixture.stageId, {
					id: "question-during-discovery",
					kind: "input",
					message: "Answer this stage question",
					createdAt: Date.now(),
				});
			}
			release.resolve();
			assert.equal(await pending, null);
			assert.match(view._statusMessage, state === "question" ? /mounted stage question owns input/ : /not editable/);
			assert.equal(fixture.main.session.messages.length, 0);
			assert.equal(fixture.userTexts().length, 1);
		} finally {
			release.resolve();
			await pending;
			await fixture.cleanup();
		}
	},
);

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

test("#2884 a skill admission refusal after resume does not leave a running chat visually paused", async () => {
	const store = createStore();
	setupRun(store, "run-1", "stage-a");
	const { handle } = makeHandle(undefined, [], "paused");
	handle.sendUserMessage = async () => {
		throw new Error("Fixture skill admission refused after resume");
	};
	const view = new StageChatView({
		store,
		runId: "run-1",
		stageId: "stage-a",
		workflowName: "test-wf",
		graphTheme: deriveGraphTheme({}),
		handle,
		onDetach() {},
		onClose() {},
	});
	try {
		assert.match(view.render(120).join("\n"), /PAUSED/);
		submitStageSkillText(view, "/skill:fixture refused");
		await vi.waitFor(() => assert.equal(view._statusMessage, "Fixture skill admission refused after resume"));
		assert.equal(handle.status, "running");
		assert.doesNotMatch(view.render(120).join("\n"), /PAUSED/);
	} finally {
		view.dispose();
	}
});
