import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, stripTerminalSequences, visibleWidth } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { renderSubagentToolResult } from "../../packages/subagents/src/extension/tool-rendering.js";
import {
	registerSubagentControl,
	unregisterSubagentControl,
} from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { inspectInProcessChildStatus } from "../../packages/subagents/src/runs/inprocess/control-status.js";
import { createSubagentControl } from "../../packages/subagents/src/runs/inprocess/runner.js";
import type { Details, SubagentStatusGroup } from "../../packages/subagents/src/shared/types.js";

function group(parentPath = "43ad4599", count = 1): SubagentStatusGroup {
	return {
		parentPath,
		children: Array.from({ length: count }, (_, index) => ({
			path: `${parentPath}/debugger_${index + 1}`,
			parentPath,
			taskName: "debugger",
			depth: 1,
			status: "running",
			loaded: index % 2 === 0,
			sessionFile: `/sessions/${parentPath}/debugger_${index + 1}.jsonl`,
		})),
	};
}

function result(groups: SubagentStatusGroup[]) {
	return {
		content: [{ type: "text" as const, text: "Unchanged model-facing status" }],
		details: { mode: "management", results: [], statusGroups: groups } satisfies Details,
	};
}

function render(groups: SubagentStatusGroup[], expanded = false, width = 100) {
	return renderSubagentToolResult(result(groups), { expanded, isPartial: false }, theme, {
		toolCallId: "status-fixture",
		state: {},
		invalidate() {},
	}).render(width);
}
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");

test("status inspection preserves text and missing identities while supplying parent, child and all snapshots", () => {
	const control = createSubagentControl({ path: "status-test-parent", depth: 0 });
	control.native.registerAgent("debugger");
	const admission = control.native.admitChildSession(
		{ taskName: "debugger", agentName: "debugger", cwd: process.cwd() },
		{ path: control.parent.path, depth: 0 },
	);
	assert.ok(admission.child);
	const child = admission.child;
	registerSubagentControl(control);
	try {
		const parent = inspectInProcessChildStatus(control.parent.path);
		assert.equal(parent?.content[0]?.type, "text");
		assert.deepEqual(parent?.content, [
			{
				type: "text",
				text: `Parent: ${control.parent.path}\n${child.path} — ${child.status} (${child.loaded ? "loaded" : "cold"})`,
			},
		]);
		assert.deepEqual(parent?.details?.statusGroups, [
			{ parentPath: control.parent.path, children: [{ ...child, sessionFile: undefined }] },
		]);
		const single = inspectInProcessChildStatus(child.path);
		assert.deepEqual(single?.content, [
			{
				type: "text",
				text: `Child: ${child.path}\nParent: ${child.parentPath}\nTask: ${child.taskName}\nDepth: ${child.depth}\nStatus: ${child.status}\nResidency: ${child.loaded ? "loaded" : "cold"}`,
			},
		]);
		assert.deepEqual(single?.details?.statusGroups, parent?.details?.statusGroups);
		assert.deepEqual(inspectInProcessChildStatus()?.details?.statusGroups, parent?.details?.statusGroups);
		assert.deepEqual(inspectInProcessChildStatus()?.content, parent?.content);
		assert.equal(inspectInProcessChildStatus("missing-status-parent"), undefined);
		assert.equal(inspectInProcessChildStatus(`${control.parent.path}/missing`), undefined);
	} finally {
		unregisterSubagentControl(control);
	}
	assert.equal(inspectInProcessChildStatus(), undefined);
});

test("status queries isolate children and parents and keep previously returned snapshots unchanged", () => {
	const controls = ["status-first", "status-second"].map((path) => createSubagentControl({ path, depth: 0 }));
	try {
		for (const control of controls) {
			control.native.registerAgent("debugger");
			for (const taskName of ["second", "first"]) {
				assert.ok(
					control.native.admitChildSession(
						{ taskName, agentName: "debugger", cwd: process.cwd() },
						{ path: control.parent.path, depth: 0 },
					).child,
				);
			}
			registerSubagentControl(control);
		}
		const all = inspectInProcessChildStatus();
		assert.equal(all?.details?.statusGroups?.length, 2);
		const parent = inspectInProcessChildStatus(controls[0]!.parent.path);
		assert.equal(parent?.details?.statusGroups?.length, 1);
		assert.equal(parent?.details?.statusGroups?.[0]?.children.length, 2);
		const child = controls[0]!.listChildren()[0]!;
		const single = inspectInProcessChildStatus(child.path);
		assert.deepEqual(
			single?.details?.statusGroups?.[0]?.children.map((entry) => entry.path),
			[child.path],
		);
		const snapshot = JSON.stringify(all);
		controls[0]!.native.publishChildStatus(child.path, "running");
		assert.equal(JSON.stringify(all), snapshot);
		assert.equal(inspectInProcessChildStatus(child.path)?.details?.statusGroups?.[0]?.children[0]?.status, "running");
	} finally {
		for (const control of controls) unregisterSubagentControl(control);
	}
});

test("status rows use names and all native states, with diagnostics disclosed only on expansion", () => {
	initTheme("dark");
	const groups = [group("parent", 6)];
	const statuses = ["pending", "running", "ok", "error", "interrupted", "continued"] as const;
	groups[0]!.children.forEach((child, index) => {
		child.status = statuses[index]!;
	});
	const collapsed = plain(render(groups));
	for (const [index, label] of ["Pending", "Running", "Completed", "Failed", "Interrupted", "Continued"].entries()) {
		assert.match(collapsed, new RegExp(`debugger_${index + 1} · ${label}`));
	}
	// The agent panel's marks: queued, running (and continued), done, failed, and stopped in the error colour.
	for (const glyph of ["○", "◯", "●", "✗"]) assert.ok(collapsed.includes(glyph));
	assert.doesNotMatch(collapsed, /[∀✓■]/u);
	assert.doesNotMatch(collapsed, /Path:|Parent:|Residency:|Session:|loaded|cold|\/sessions/);
	const expanded = plain(render(groups, true));
	assert.match(expanded, /Path: parent\/debugger_1/);
	assert.match(expanded, /Parent: parent · Depth: 1/);
	assert.match(expanded, /Residency: loaded/);
	assert.match(expanded, /Residency: cold/);
	assert.match(expanded, /Session: \/sessions\/parent\/debugger_1.jsonl/);
	assert.match(expanded, /Task: debugger/);
});

test("compact status bounds children across groups and expansion restores every identity", () => {
	initTheme("dark");
	const groups = [group("first", 4), group("second", 4), group("third", 2)];
	const collapsed = plain(render(groups));
	assert.match(collapsed, /10 agents/);
	assert.equal(collapsed.match(/ · Running/g)?.length, 6);
	assert.match(collapsed, /Run first/);
	assert.match(collapsed, /Run second/);
	assert.doesNotMatch(collapsed, /Run third/);
	assert.match(collapsed, /4 more agents/);
	const expanded = plain(render(groups, true));
	assert.equal(expanded.match(/ · Running/g)?.length, 10);
	for (const current of groups)
		for (const child of current.children) assert.ok(expanded.includes(`Path: ${child.path}`));
	assert.doesNotMatch(expanded, /more agents/);
	assert.doesNotMatch(plain(render([group()])), /Run 43ad4599|Parent:|43ad4599/);
	assert.match(plain(render([group("empty", 0)])), /No subagents/);
});

test("status rendering stays stable, bounds Unicode and strips terminal controls without mutating its snapshot", () => {
	initTheme("dark");
	const groups = [group()];
	groups[0]!.children[0]!.taskName = `\x1b[31m${"界".repeat(70)}\x1b[0m\n\tunsafe\x1b]0;injected-title\x07`;
	groups[0]!.children[0]!.path = `43ad4599/${groups[0]!.children[0]!.taskName}_1`;
	const value = result(groups);
	const original = JSON.stringify(value);
	for (const expanded of [false, true]) {
		const view = renderSubagentToolResult(value, { expanded, isPartial: false }, theme, {
			toolCallId: "stable-status",
			state: {},
			invalidate() {},
		});
		for (const width of [12, 48, 100, 48]) {
			const lines = view.render(width);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			assert.doesNotMatch(lines.join("\n"), /\x1b\]0;|\x07|\t|\x1b\[31m/);
			assert.deepEqual(view.render(width), lines);
			view.invalidate();
			assert.deepEqual(view.render(width), lines);
		}
	}
	assert.equal(JSON.stringify(value), original);
});

test("status disclosure hint respects custom and unbound expand keys", () => {
	initTheme("dark");
	const previous = getKeybindings();
	try {
		setKeybindings(new KeybindingsManager({ "app.tools.expand": "ctrl+e" }));
		assert.match(plain(render([group()])), /ctrl\+e to expand/);
		assert.doesNotMatch(plain(render([group()], true)), /to expand/);
		setKeybindings(new KeybindingsManager({ "app.tools.expand": [] }));
		assert.doesNotMatch(plain(render([group()])), /to expand|ctrl\+/);
	} finally {
		setKeybindings(previous);
	}
});

test("expanded status preserves empty run identities alongside populated runs", () => {
	initTheme("dark");
	for (const groups of [[group("empty", 0)], [group("empty", 0), group("active")]]) {
		const expanded = plain(render(groups, true));
		assert.match(expanded, /Run empty\s+No subagents/);
		assert.doesNotMatch(plain(render(groups)), /Run empty/);
	}
	assert.match(plain(render([], true)), /No subagents/);
	const control = createSubagentControl({ path: "empty-native-parent", depth: 0 });
	registerSubagentControl(control);
	try {
		const inspection = inspectInProcessChildStatus(control.parent.path);
		assert.deepEqual(inspection?.content, [{ type: "text", text: "Parent: empty-native-parent" }]);
		assert.deepEqual(inspection?.details?.statusGroups, [{ parentPath: "empty-native-parent", children: [] }]);
		assert.match(plain(render(inspection!.details!.statusGroups!, true)), /Run empty-native-parent/);
	} finally {
		unregisterSubagentControl(control);
	}
});

test("killed status cards explicitly reject resumability", () => {
	initTheme("dark");
	const snapshot = group();
	snapshot.children[0]!.status = "killed";
	for (const expanded of [false, true]) {
		const output = plain(render([snapshot], expanded));
		assert.match(output, /Killed \(non-resumable\)/);
		assert.doesNotMatch(output, /Interrupted|Resume|Continue/);
	}
});
