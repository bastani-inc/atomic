import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	TaskDetail,
	taskDetailActions,
} from "../../packages/coding-agent/src/modes/interactive/components/task-detail.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

// RFC #2884: terminal task inspection never exposes a restart or live action.
test("terminal task detail omits all live actions", () => {
	assert.deepEqual(
		taskDetailActions(
			{ kind: "settled", result: { kind: "failed", code: "fixture", message: "done" } },
			{ kind: "none" },
			true,
		),
		["transcript"],
	);
});

// RFC #2884: input and HIL actions are factual capabilities, not inferred state.
test("live detail exposes only available input and exact question actions", () => {
	assert.deepEqual(taskDetailActions({ kind: "running" }, { kind: "none" }, false), ["transcript", "cancel"]);
	assert.deepEqual(
		taskDetailActions(
			{ kind: "running" },
			{ kind: "input-needed", requestId: "q", prompt: "", route: { sessionId: "s", promptId: "q" } },
			true,
		),
		["transcript", "cancel", "input", "question"],
	);
});

// RFC #2884: narrow display keeps raw prompt, known zero metrics and named actions.
test("detail renders task metadata and configured action hints without inventing missing metrics", () => {
	initTheme("dark");
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager({ "app.tasks.cancel": "ctrl+x" }));
		const task = taskRecord("first");
		task.metrics = { toolCount: 0 };
		task.currentAction = { tool: "bash", text: "checking" };
		const detail = new TaskDetail(task, { prompt: "raw prompt", stdinAvailable: false });
		const text = detail.render(48).map(stripVTControlCharacters).join("\n");
		for (const expected of [
			"Task first",
			"Running",
			"Owner owner",
			"Task first",
			"0 tools",
			"Prompt",
			"raw prompt",
			"› bash checking",
			"Inspect transcript",
			"ctrl+x",
			"Cancel task…",
		])
			assert.ok(text.includes(expected), expected);
		assert.ok(!text.includes("tokens"));
		setKeybindings(new KeybindingsManager({ "app.tasks.cancel": [] }));
		assert.ok(!detail.render(48).map(stripVTControlCharacters).join("\n").includes("ctrl+x"));
	} finally {
		setKeybindings(previous);
	}
});

test("a running task's detail page offers no foreground wait and no binding exists for one (#4662)", () => {
	const actions: string[] = taskDetailActions({ kind: "running" }, { kind: "none" }, true);
	assert.equal(actions.includes("foreground"), false);
	assert.equal(Object.keys(new KeybindingsManager().getResolvedBindings()).includes("app.tasks.foreground"), false);
});
