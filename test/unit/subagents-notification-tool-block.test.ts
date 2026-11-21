import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.ts";
import { renderSubagentNotification } from "../../packages/subagents/src/extension/index.ts";
import type { SubagentNotifyDetails } from "../../packages/subagents/src/runs/foreground/notify.ts";

const originalKeybindings = getKeybindings();

function render(details: SubagentNotifyDetails, expanded = false): { raw: string; plain: string } {
	const raw = renderSubagentNotification({ content: "", details }, { expanded }, theme).render(100).join("\n");
	return { raw, plain: stripAnsi(raw) };
}

beforeEach(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+o" }));
});

afterEach(() => setKeybindings(originalKeybindings));

test("completion notifications render as status-colored tool blocks without losing content", () => {
	const completed = render({
		agent: "debugger",
		status: "completed",
		taskInfo: "task 1/2",
		durationMs: 65_000,
		resultPreview: "summary line\nadditional detail",
		sessionLabel: "session file",
		sessionValue: "/tmp/sessions/child.jsonl",
	});
	const failed = render({ agent: "debugger", status: "failed", resultPreview: "failure detail" });
	const interrupted = render({ agent: "debugger", status: "interrupted", resultPreview: "stopped" });

	assert.ok(!completed.raw.includes("\u001b[48;"), "completed notification has no background shading");
	assert.ok(!failed.raw.includes("\u001b[48;"), "failed notification has no background shading");
	assert.ok(!interrupted.raw.includes("\u001b[48;"), "interrupted notification has no background shading");
	assert.ok(completed.raw.includes(theme.fg("success", "●")), "completed notification uses success glyph");
	assert.ok(failed.raw.includes(theme.fg("error", "✗")), "failed notification uses error glyph");
	assert.ok(interrupted.raw.includes(theme.fg("error", "◯")), "interrupted notification uses the stopped mark");
	assert.match(completed.plain, /● debugger completed · task 1\/2 · 1m 5s/);
	assert.match(completed.plain, /⎿ {2}summary line/);
	assert.match(completed.plain, /ctrl\+o full notification/);
	assert.match(completed.plain, /session file: \/tmp\/sessions\/child\.jsonl/);
	assert.match(failed.plain, /✗ debugger failed/);
	assert.match(interrupted.plain, /◯ debugger interrupted/);
});

test("tool-block rendering preserves collapsed and expanded preview behavior", () => {
	const details: SubagentNotifyDetails = {
		agent: "worker",
		status: "completed",
		resultPreview: "first line\nsecond line",
	};
	const collapsed = render(details);
	const expanded = render(details, true);

	assert.match(collapsed.plain, /first line/);
	assert.doesNotMatch(collapsed.plain, /second line/);
	assert.match(collapsed.plain, /ctrl\+o full notification/);
	assert.match(expanded.plain, /first line/);
	assert.match(expanded.plain, /second line/);
	assert.doesNotMatch(expanded.plain, /full notification/);
});
