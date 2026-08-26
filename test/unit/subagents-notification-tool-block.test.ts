import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
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

function backgroundPrefix(token: "toolSuccessBg" | "toolErrorBg" | "toolPendingBg"): string {
	const probe = "background-probe";
	return theme.bg(token, probe).split(probe, 1)[0] ?? "";
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
	const successBackground = backgroundPrefix("toolSuccessBg");
	const errorBackground = backgroundPrefix("toolErrorBg");
	const pendingBackground = backgroundPrefix("toolPendingBg");

	assert.notEqual(successBackground, "");
	assert.notEqual(errorBackground, "");
	assert.notEqual(pendingBackground, "");
	assert.notEqual(successBackground, errorBackground);
	assert.notEqual(successBackground, pendingBackground);
	assert.notEqual(errorBackground, pendingBackground);
	assert.ok(completed.raw.includes(successBackground), "completed notification uses the success tool background");
	assert.ok(failed.raw.includes(errorBackground), "failed notification uses the error tool background");
	assert.ok(interrupted.raw.includes(pendingBackground), "interrupted notification uses the pending tool background");
	assert.match(completed.plain, /✓ debugger completed · task 1\/2 · 1m 5s/);
	assert.match(completed.plain, /⎿ {2}summary line/);
	assert.match(completed.plain, /ctrl\+o full notification/);
	assert.match(completed.plain, /session file: \/tmp\/sessions\/child\.jsonl/);
	assert.match(failed.plain, /✗ debugger failed/);
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
