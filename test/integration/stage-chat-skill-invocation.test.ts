import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildSkillCatalog, SessionManager } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { ensurePostMortemStageHandle } from "../../packages/workflows/src/runs/foreground/postmortem-stage-chat.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { createStageSkillFixture, submitStageSkillText } from "../fixtures/stage-chat-skill-session.js";
import { FakePromptEditor, makeFakeKeybindings, makeTestTui } from "../unit/stage-chat-view-helpers.js";

// RFC #2884: discovery must never substitute the main session's catalog.
test("editable stage chat expands its skill once into one admitted stage message", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const view = fixture.mount();
		fixture.stage.appendResponses([fauxAssistantMessage("Stage skill acknowledged.")]);
		submitStageSkillText(view, "/skill:fixture   args  ");
		await vi.waitFor(() => assert.equal(fixture.userTexts().length, 2));
		const text = fixture.userTexts()[1]!;
		assert.match(text, /STAGE SKILL BODY/);
		assert.ok(text.includes(`location="${fixture.stageSkill.filePath}"`));
		assert.ok(text.includes(`References are relative to ${fixture.stageSkill.baseDir}.`));
		assert.equal(text.match(/<skill name=/g)?.length, 1);
		assert.ok(text.endsWith("\n\nargs"));
		assert.doesNotMatch(text, /MAIN SKILL BODY/);
		assert.equal(fixture.main.session.messages.length, 0);
		assert.equal(fixture.stage.session.sessionManager.getCwd(), join(fixture.directory, "stage-cwd"));
		assert.doesNotMatch(view.render(140).map(stripVTControlCharacters).join("\n"), /\/skill:fixture {3}args/);
	} finally {
		await fixture.cleanup();
	}
});

test("streaming Enter and Ctrl+F use stage admission and retain their distinct expanded queues", async () => {
	const fixture = await createStageSkillFixture();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let streaming: Promise<unknown> | undefined;
	try {
		fixture.stage.appendResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Hold released.");
			},
			fauxAssistantMessage("Queued skill acknowledged."),
		]);
		streaming = fixture.handle.sendUserMessage!("Hold the stage.");
		await started.promise;
		const view = fixture.mount();
		submitStageSkillText(view, "/skill:fixture enter-args");
		await vi.waitFor(() => assert.equal(fixture.stage.session.getSteeringMessages().length, 1));
		assert.match(fixture.stage.session.getSteeringMessages()[0]!, /STAGE SKILL BODY/);
		assert.ok(fixture.stage.session.getSteeringMessages()[0]!.endsWith("\n\nenter-args"));
		submitStageSkillText(view, "/skill:fixture@user follow-args", "\x06");
		await vi.waitFor(() => assert.equal(fixture.stage.session.getFollowUpMessages().length, 1));
		const followUp = fixture.stage.session.getFollowUpMessages()[0]!;
		assert.match(followUp, /STAGE USER ALTERNATIVE/);
		assert.ok(followUp.endsWith("\n\nfollow-args"));
		assert.equal(followUp.match(/<skill name=/g)?.length, 1);
		assert.equal(fixture.main.session.messages.length, 0);
	} finally {
		fixture.stage.session.clearQueue();
		release.resolve();
		await streaming;
		await fixture.cleanup();
	}
});

test("streaming skill input cannot bypass a refusal at the stage admission boundary", async () => {
	const fixture = await createStageSkillFixture();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let streaming: Promise<unknown> | undefined;
	try {
		fixture.stage.appendResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Hold released.");
			},
		]);
		streaming = fixture.handle.sendUserMessage!("Hold for admission check.");
		await started.promise;
		const admit = fixture.handle.sendUserMessage!.bind(fixture.handle);
		fixture.handle.sendUserMessage = (text, options) =>
			admit(text, options, () => {
				throw new Error("Stage admission refused skill fixture");
			});
		const view = fixture.mount();
		submitStageSkillText(view, "/skill:fixture denied");
		await vi.waitFor(() =>
			assert.match(
				view.render(100).map(stripVTControlCharacters).join("\n"),
				/Stage admission refused skill fixture/,
			),
		);
		assert.deepEqual(fixture.stage.session.getSteeringMessages(), []);
		assert.deepEqual(fixture.stage.session.getFollowUpMessages(), []);
		assert.equal(fixture.userTexts().length, 2);
	} finally {
		fixture.stage.session.clearQueue();
		release.resolve();
		await streaming;
		await fixture.cleanup();
	}
});

test("qualified, unknown, ambiguous and unreadable selectors retain session semantics and attached diagnostics", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const view = fixture.mount();
		async function submit(text: string) {
			const count = fixture.userTexts().length;
			fixture.stage.appendResponses([fauxAssistantMessage("Selector acknowledged.")]);
			submitStageSkillText(view, text);
			await vi.waitFor(() => {
				assert.equal(fixture.userTexts().length, count + 1);
				assert.equal(fixture.stage.session.isStreaming, false);
			});
			return fixture.userTexts().at(-1)!;
		}
		const qualified = await submit("/skill:fixture@user args");
		assert.match(qualified, /STAGE USER ALTERNATIVE/);
		assert.doesNotMatch(qualified, /STAGE SKILL BODY/);
		assert.equal(await submit("/skill:does-not-exist arg"), "/skill:does-not-exist arg");
		assert.equal(await submit("/skill:fixture@unknown arg"), "/skill:fixture@unknown arg");
		assert.match(view.render(140).map(stripVTControlCharacters).join("\n"), /Unknown skill selector/);
		const second = await fixture.skill("second-project", "project", "SECOND PROJECT CANDIDATE.");
		fixture.setCatalog(buildSkillCatalog([fixture.stageSkill, second, fixture.userSkill], [fixture.stageSkill]));
		assert.equal(await submit("/skill:fixture@project"), "/skill:fixture@project");
		assert.match(view.render(140).map(stripVTControlCharacters).join("\n"), /ambiguous/);
		rmSync(fixture.userSkill.filePath);
		assert.equal(await submit("/skill:fixture@user"), "/skill:fixture@user");
		assert.match(view.render(140).map(stripVTControlCharacters).join("\n"), /ENOENT|no such file/i);
		assert.equal(fixture.main.session.messages.length, 0);
	} finally {
		await fixture.cleanup();
	}
});

test("disabled command registration does not authorize or forbid typed invocation and reload uses the stage catalog", async () => {
	const fixture = await createStageSkillFixture();
	try {
		fixture.stage.settingsManager.setEnableSkillCommands(false);
		const view = fixture.mount();
		fixture.stage.appendResponses([fauxAssistantMessage("Disabled discovery manual invocation acknowledged.")]);
		submitStageSkillText(view, "/skill:fixture manual");
		await vi.waitFor(() => {
			assert.equal(fixture.userTexts().length, 2);
			assert.equal(fixture.stage.session.isStreaming, false);
		});
		assert.match(fixture.userTexts()[1]!, /STAGE SKILL BODY/);
		const replacement = await fixture.skill("reloaded-project", "project", "RELOADED STAGE BODY.");
		fixture.setCatalog(buildSkillCatalog([replacement]));
		await fixture.stage.session.reload();
		fixture.stage.appendResponses([fauxAssistantMessage("Reloaded invocation acknowledged.")]);
		submitStageSkillText(view, "/skill:fixture after-reload");
		await vi.waitFor(() => assert.equal(fixture.userTexts().length, 3));
		assert.match(fixture.userTexts()[2]!, /RELOADED STAGE BODY/);
		assert.doesNotMatch(fixture.userTexts()[2]!, /STAGE SKILL BODY|MAIN SKILL BODY/);
		assert.ok(fixture.userTexts()[2]!.includes(replacement.baseDir));
	} finally {
		await fixture.cleanup();
	}
});

test("detaching an attached pane during admission cannot redirect its skill to another owner", async () => {
	const fixture = await createStageSkillFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		const attach = fixture.handle.ensureAttached.bind(fixture.handle);
		fixture.handle.ensureAttached = async () => {
			entered.resolve();
			await release.promise;
			await attach();
		};
		const view = fixture.mount();
		fixture.stage.appendResponses([fauxAssistantMessage("Original stage acknowledged.")]);
		submitStageSkillText(view, "/skill:fixture original-stage");
		await entered.promise;
		view.dispose();
		const other = fixture.mount({ handle: undefined, stageId: "different-stage" });
		release.resolve();
		await vi.waitFor(() => assert.equal(fixture.userTexts().length, 2));
		assert.match(fixture.userTexts()[1]!, /STAGE SKILL BODY/);
		assert.ok(fixture.userTexts()[1]!.endsWith("original-stage"));
		assert.doesNotMatch(other.render(100).map(stripVTControlCharacters).join("\n"), /Original stage acknowledged/);
		assert.equal(fixture.main.session.messages.length, 0);
	} finally {
		release.resolve();
		await fixture.cleanup();
	}
});

test("mounted HIL answers beginning with skill syntax remain literal and admission-disabled prompts cannot answer", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const prompt = {
			id: "skill-literal-answer",
			kind: "input" as const,
			message: "Give a literal answer",
			createdAt: Date.now(),
		};
		assert.equal(fixture.store.recordStagePendingPrompt(fixture.runId, fixture.stageId, prompt), true);
		const answer = fixture.store.awaitStagePendingPrompt(fixture.runId, fixture.stageId, prompt.id);
		const view = fixture.mount();
		submitStageSkillText(view, "/skill:fixture this-is-an-answer");
		assert.equal(await answer, "/skill:fixture this-is-an-answer");
		assert.equal(fixture.userTexts().length, 1);
		assert.deepEqual(fixture.stage.session.getSteeringMessages(), []);
		assert.deepEqual(fixture.stage.session.getFollowUpMessages(), []);
		view.dispose();
		const disabled = { ...prompt, id: "disabled-answer" };
		assert.equal(fixture.store.recordStagePendingPrompt(fixture.runId, fixture.stageId, disabled), true);
		const disabledView = fixture.mount({ canSubmitPrompt: () => false });
		submitStageSkillText(disabledView, "/skill:fixture refused-answer");
		assert.equal(fixture.store.runs()[0]!.stages[0]!.pendingPrompt?.id, disabled.id);
		assert.equal(fixture.userTexts().length, 1);
	} finally {
		await fixture.cleanup();
	}
});

test("blocked and archived stage composers cannot submit a skill and tasks remains a local view command", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const view = fixture.mount();
		submitStageSkillText(view, "/tasks");
		await vi.waitFor(() => assert.match(view.render(120).map(stripVTControlCharacters).join("\n"), /unavailable/i));
		assert.equal(fixture.userTexts().length, 1);
		view.dispose();
		const snapshot = fixture.store.runs()[0]!.stages[0]!;
		fixture.store.recordStageEnd(fixture.runId, { ...snapshot, status: "blocked" });
		const blocked = fixture.mount();
		submitStageSkillText(blocked, "/skill:fixture blocked");
		blocked.handleInput("\x06");
		assert.equal(fixture.userTexts().length, 1);
		fixture.store.recordStageEnd(fixture.runId, { ...snapshot, status: "completed", endedAt: Date.now() });
		const archived = fixture.mount({ handle: undefined });
		submitStageSkillText(archived, "/skill:fixture archived");
		archived.handleInput("\x06");
		assert.equal(fixture.userTexts().length, 1);
		assert.deepEqual(fixture.stage.session.getSteeringMessages(), []);
		assert.deepEqual(fixture.stage.session.getFollowUpMessages(), []);
	} finally {
		await fixture.cleanup();
	}
});

test("replay refuses skill-bearing user delivery without creating a session", async () => {
	const store = createStore();
	const name = "skill-replay-admission";
	const first = await run(
		workflow({
			name,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("first").prompt("first");
				await ctx.stage("second").prompt("second");
				return {};
			},
		}),
		{},
		{
			store,
			adapters: {
				prompt: {
					prompt: async (text) => {
						if (text === "second") throw new Error("Fixture interruption");
						return "retained result";
					},
				},
			},
		},
	);
	assert.equal(first.status, "failed");
	const source = store.runs().find((candidate) => candidate.id === first.runId)!;
	assert.ok(source.failedStageId);
	let creations = 0;
	const replay = await run(
		workflow({
			name,
			description: "",
			inputs: {},
			outputs: {},
			run: async (ctx) => {
				await ctx.stage("first").sendUserMessage("/skill:fixture forbidden");
				return {};
			},
		}),
		{},
		{
			store,
			continuation: { source, resumeFromStageId: source.failedStageId },
			adapters: {
				prompt: {
					prompt: async () => {
						creations++;
						return "unexpected";
					},
				},
			},
		},
	);
	assert.equal(replay.status, "failed");
	assert.match(replay.error ?? "", /replayed stage "first" cannot send a user message/);
	assert.equal(creations, 0);
	assert.equal(replay.stages[0]!.replayed, true);
});

test("editable postmortem skill invocation appends to its own retained session without reviving workflow work", async () => {
	const fixture = await createStageSkillFixture();
	const registry = createStageControlRegistry();
	let restored: Awaited<ReturnType<typeof createHarness>> | undefined;
	try {
		const file = fixture.stage.session.sessionFile;
		assert.ok(file);
		restored = await createHarness({
			resourceLoader: fixture.loader,
			sessionManager: SessionManager.open(file),
			fauxProvider: { api: "stage-skill-postmortem", provider: "stage-skill-postmortem" },
		});
		const session = restored.session;
		const snapshot = {
			...fixture.store.runs()[0]!.stages[0]!,
			status: "completed" as const,
			endedAt: Date.now(),
			sessionFile: file,
		};
		const resolved = ensurePostMortemStageHandle(fixture.runId, snapshot, {
			registry,
			cwd: fixture.directory,
			adapters: {
				agentSession: {
					async create() {
						return session as StageSessionRuntime;
					},
				},
			},
		});
		assert.ok(resolved.ok);
		const beforeUsers = getUserTexts(restored).length;
		const beforeStoredUsers = SessionManager.open(file)
			.buildSessionContext()
			.messages.filter((message) => message.role === "user").length;
		if (!resolved.ok) throw new Error("Postmortem fixture was not eligible");
		fixture.store.recordStageEnd(fixture.runId, snapshot);
		const before = JSON.stringify(fixture.store.runs()[0]!.stages[0]);
		const view = fixture.mount({ handle: resolved.handle });
		restored.appendResponses([fauxAssistantMessage("Postmortem skill acknowledged.")]);
		submitStageSkillText(view, "/skill:fixture postmortem-args");
		await vi.waitFor(() => assert.equal(getUserTexts(restored!).length, beforeUsers + 1));
		assert.match(getUserTexts(restored).at(-1)!, /STAGE SKILL BODY/);
		assert.equal(
			getUserTexts(restored)
				.at(-1)!
				.match(/<skill name=/g)?.length,
			1,
		);
		assert.equal(
			SessionManager.open(file)
				.buildSessionContext()
				.messages.filter((message) => message.role === "user").length,
			beforeStoredUsers + 1,
		);
		assert.equal(JSON.stringify(fixture.store.runs()[0]!.stages[0]), before);
		assert.equal(resolved.handle.status, "completed");
		assert.deepEqual(registry.run(fixture.runId).stages(), []);
		await assert.rejects(
			resolved.handle.resume("/skill:fixture forbidden"),
			/cannot pause or resume workflow execution/,
		);
		assert.equal(fixture.userTexts().length, 1);
	} finally {
		registry.clear();
		restored?.cleanup();
		await fixture.cleanup();
	}
});

test("equivalent stage and main catalogs resolve the same qualified skill content", async () => {
	const fixture = await createStageSkillFixture();
	try {
		fixture.main.session.resourceLoader.getSkillCatalog = () => fixture.catalog;
		fixture.main.appendResponses([fauxAssistantMessage("Main equivalent catalog acknowledged.")]);
		await fixture.main.session.prompt("/skill:fixture@user same-args");
		fixture.stage.appendResponses([fauxAssistantMessage("Stage equivalent catalog acknowledged.")]);
		const view = fixture.mount();
		submitStageSkillText(view, "/skill:fixture@user same-args");
		await vi.waitFor(() => assert.equal(fixture.userTexts().length, 2));
		assert.equal(fixture.userTexts()[1], getUserTexts(fixture.main)[0]);
	} finally {
		await fixture.cleanup();
	}
});

test("lazy stage skill discovery failures are contained and diagnosed in the attached chat", async () => {
	const fixture = await createStageSkillFixture();
	try {
		let provider: AutocompleteProvider | undefined;
		class Editor extends FakePromptEditor {
			setAutocompleteProvider(value: AutocompleteProvider) {
				provider = value;
			}
		}
		fixture.handle.ensureAttached = async () => {
			throw new Error("Stage fixture lazy attachment failed");
		};
		const view = fixture.mount({
			piTui: makeTestTui(24),
			piKeybindings: makeFakeKeybindings(),
			piEditorFactory: () => new Editor(),
		});
		assert.ok(provider);
		assert.equal(await provider.getSuggestions(["/skill:fi"], 0, 9, { signal: new AbortController().signal }), null);
		assert.match(
			view.render(140).map(stripVTControlCharacters).join("\n"),
			/Skill discovery unavailable: Stage fixture lazy attachment failed/,
		);
		assert.equal(fixture.userTexts().length, 1);
		assert.equal(fixture.main.session.messages.length, 0);
	} finally {
		await fixture.cleanup();
	}
});

test("resuming a paused stage with a typed skill admits its expanded content once", async () => {
	const fixture = await createStageSkillFixture();
	try {
		await fixture.handle.pause();
		assert.equal(fixture.store.runs()[0]!.stages[0]!.status, "paused");
		const view = fixture.mount();
		fixture.stage.appendResponses([fauxAssistantMessage("Resumed stage skill acknowledged.")]);
		submitStageSkillText(view, "/skill:fixture paused-args");
		await vi.waitFor(() => assert.equal(fixture.userTexts().length, 2));
		const text = fixture.userTexts()[1]!;
		assert.match(text, /STAGE SKILL BODY/);
		assert.ok(text.endsWith("\n\npaused-args"));
		assert.equal(text.match(/<skill name=/g)?.length, 1);
		assert.equal(fixture.main.session.messages.length, 0);
	} finally {
		await fixture.cleanup();
	}
});

test("a stage question arriving during skill attachment keeps input ownership", async () => {
	const fixture = await createStageSkillFixture();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	try {
		const attach = fixture.handle.ensureAttached.bind(fixture.handle);
		fixture.handle.ensureAttached = async () => {
			entered.resolve();
			await release.promise;
			await attach();
		};
		const view = fixture.mount();
		submitStageSkillText(view, "/skill:fixture must-not-answer");
		await entered.promise;
		const prompt = {
			id: "arrived-during-attachment",
			kind: "input" as const,
			message: "Answer this stage question",
			createdAt: Date.now(),
		};
		assert.equal(fixture.store.recordStagePendingPrompt(fixture.runId, fixture.stageId, prompt), true);
		release.resolve();
		// Prompt cards intentionally hide chat chrome; the admission refusal is retained in host status.
		await vi.waitFor(() => assert.match(view._statusMessage, /mounted stage question owns input/));
		assert.match(view.render(140).map(stripVTControlCharacters).join("\n"), /Answer this stage question/);
		assert.equal(fixture.store.runs()[0]!.stages[0]!.pendingPrompt?.id, prompt.id);
		assert.equal(fixture.userTexts().length, 1);
		assert.deepEqual(fixture.stage.session.getSteeringMessages(), []);
		assert.deepEqual(fixture.stage.session.getFollowUpMessages(), []);
		assert.equal(fixture.main.session.messages.length, 0);
	} finally {
		release.resolve();
		await fixture.cleanup();
	}
});

test.each(["stage", "native queue"] as const)(
	"skill expansion diagnostics remain visible after a paused %s resumes",
	async (pause) => {
		const fixture = await createStageSkillFixture();
		try {
			if (pause === "stage") await fixture.handle.pause();
			else fixture.stage.session.pauseQueuedMessages();
			const view = fixture.mount();
			fixture.stage.appendResponses([fauxAssistantMessage("Unknown selector acknowledged literally.")]);
			submitStageSkillText(view, "/skill:fixture@unknown paused-diagnostic");
			await vi.waitFor(() => {
				assert.equal(fixture.userTexts().length, 2);
				assert.equal(fixture.stage.session.isStreaming, false);
			});
			assert.equal(fixture.userTexts()[1], "/skill:fixture@unknown paused-diagnostic");
			assert.match(view.render(140).map(stripVTControlCharacters).join("\n"), /Unknown skill selector/);
		} finally {
			await fixture.cleanup();
		}
	},
);
