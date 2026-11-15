import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { bindOwnerTaskStore, CustomEditor } from "@bastani/atomic";
import { setKeybindings } from "@bastani/atomic-tui";
import { test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { createStageSkillFixture } from "../fixtures/stage-chat-skill-session.js";
import { taskFixture } from "../helpers/task-projection.js";
import { makeTestTui } from "../support/fake-tui.js";

test("stage slash suggestions select /tasks and inspect only the stage owner without model admission", async () => {
	const fixture = await createStageSkillFixture();
	const mainTasks = taskFixture();
	const stageTasks = taskFixture({
		kind: "workflow-stage",
		sessionId: fixture.stage.session.sessionId,
		runId: fixture.runId,
		stageId: fixture.stageId,
		stageAttemptId: "autocomplete",
	});
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	let editor: CustomEditor | undefined;
	try {
		bindOwnerTaskStore(fixture.main.session, mainTasks.store);
		bindOwnerTaskStore(fixture.stage.session, stageTasks.store);
		await mainTasks.start("MAIN OWNER PRIVATE TASK");
		await stageTasks.start("STAGE OWNER TASK");
		// A local task command remains discoverable even when skill registration is disabled.
		fixture.stage.settingsManager.setEnableSkillCommands(false);
		const view = fixture.mount({
			piTui: makeTestTui(30),
			piKeybindings: keys,
			piEditorFactory: (tui, theme) => {
				editor = new CustomEditor(tui, theme, keys);
				return editor;
			},
		});
		const beforeStage = fixture.userTexts();
		const beforeMain = [...fixture.main.session.messages];
		view.focused = true;
		view.render(100);
		for (const character of "/tas") view.handleInput(character);
		await vi.waitFor(() => {
			assert.match(stripVTControlCharacters(view.render(100).join("\n")), /→ tasks\s+Inspect agents and shells/);
		});
		view.handleInput("\t");
		assert.equal(editor?.getText(), "/tasks ");
		view.handleInput("\r");
		await vi.waitFor(() => assert.match(stripVTControlCharacters(view.render(100).join("\n")), /STAGE OWNER TASK/));
		assert.doesNotMatch(stripVTControlCharacters(view.render(100).join("\n")), /MAIN OWNER PRIVATE TASK/);
		assert.deepEqual(fixture.userTexts(), beforeStage);
		assert.deepEqual(fixture.main.session.messages, beforeMain);
		view.handleInput("\x1b");
		assert.doesNotMatch(stripVTControlCharacters(view.render(100).join("\n")), /STAGE OWNER TASK/);
	} finally {
		await fixture.cleanup();
		await stageTasks.dispose();
		await mainTasks.dispose();
	}
});
