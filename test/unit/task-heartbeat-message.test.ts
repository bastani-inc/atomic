import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { TaskHeartbeatDetails } from "../../packages/coding-agent/src/core/tasks/heartbeat-notice.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import { TaskDetail } from "../../packages/coding-agent/src/modes/interactive/components/task-detail.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";

const MINUTE = 60_000;
const details: TaskHeartbeatDetails = {
	scheduledAt: Date.UTC(2026, 0, 1, 9, 45),
	tasks: [
		{
			taskId: "task-shell",
			kind: "command",
			title: "npm run build",
			elapsedMs: 45 * MINUTE,
			intervalMs: 15 * MINUTE,
			lastActivityAgoMs: 12_000,
			output: { bytes: 4096, tail: ["compiling 812/900", "\u001b[31mwarning\u001b[0m: unused import"] },
		},
		{
			taskId: "task-agent",
			kind: "agent",
			title: "Trace the auth flow",
			agentName: "codebase-analyzer",
			elapsedMs: 30 * MINUTE,
			intervalMs: 15 * MINUTE,
			lastActivityAgoMs: 9 * MINUTE,
			currentAction: { tool: "bash", text: "sleep 3600", running: true },
			turnCount: 4,
		},
	],
	more: [{ taskId: "task-more", kind: "command", title: "tail -f log" }],
	moreCount: 1,
};

function card(expanded: boolean, width: number): string[] {
	const component = new CustomMessageComponent({
		role: "custom",
		customType: "task-heartbeat",
		content: "♥ Task heartbeat (shell task-shell: npm run build) — still running after 45m",
		display: true,
		details,
		timestamp: 0,
	});
	component.setExpanded(expanded);
	return component.render(width);
}

test("a task heartbeat card lists each task compactly and shows status and output lines when expanded", () => {
	initTheme("dark");
	const collapsed = card(false, 100).map(stripVTControlCharacters).join("\n");
	assert.match(collapsed, /♥ Task heartbeat · 3 tasks still running/);
	assert.match(collapsed, /shell task-shell npm run build · 45m/);
	assert.match(collapsed, /subagent task-agent Trace the auth flow · 30m/);
	assert.match(collapsed, /and 1 more/);
	assert.match(collapsed, /\/tasks to inspect/);
	assert.doesNotMatch(collapsed, /compiling|running bash/, "details stay folded until expanded");
	assert.doesNotMatch(collapsed, /\[task-heartbeat\]/, "not the generic custom-message box");

	const expanded = card(true, 100).map(stripVTControlCharacters).join("\n");
	assert.match(expanded, /elapsed 45m · 4\.0KB output · last output 12s ago/);
	assert.match(expanded, /│ compiling 812\/900/);
	assert.match(expanded, /│ warning: unused import/);
	assert.match(expanded, /agent codebase-analyzer · elapsed 30m · last activity 9m ago · running bash: sleep 3600/);
	assert.match(expanded, /· 4\s+turns/, "a long status line wraps rather than losing its end");
});

test("a task heartbeat card stays within the terminal width", () => {
	initTheme("dark");
	for (const expanded of [false, true])
		for (const width of [20, 48, 100]) assert.ok(card(expanded, width).every((line) => visibleWidth(line) <= width));
});

test("/tasks detail shows a running task's heartbeat cadence, or that it is off", () => {
	initTheme("dark");
	const detail = (heartbeatMs: number | undefined, settled = false) => {
		const task = {
			...taskRecord("heartbeat-detail", "command"),
			...(heartbeatMs === undefined ? {} : { heartbeatMs }),
			...(settled
				? {
						execution: {
							kind: "settled" as const,
							result: { kind: "completed" as const, output: taskRecord("heartbeat-detail").output },
						},
					}
				: { execution: { kind: "running" as const } }),
		};
		return new TaskDetail(task, { stdinAvailable: false }).render(80).map(stripVTControlCharacters).join("\n");
	};
	assert.match(detail(15 * MINUTE), /Heartbeat every 15m/);
	assert.match(detail(90 * MINUTE), /Heartbeat every 1h 30m/);
	assert.match(detail(0), /Heartbeat off/);
	assert.doesNotMatch(detail(15 * MINUTE, true), /Heartbeat/, "finished tasks no longer heartbeat");
	assert.doesNotMatch(detail(undefined), /Heartbeat/);
});
