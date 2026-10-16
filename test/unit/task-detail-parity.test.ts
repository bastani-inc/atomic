import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { OwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import { TaskDetail } from "../../packages/coding-agent/src/modes/interactive/components/task-detail.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd()).join("\n");

test("shell detail shows exit code, error and the last output lines with omission disclosure", () => {
	initTheme("dark");
	const task = taskRecord("shell", "command");
	task.execution = {
		kind: "settled",
		result: { kind: "failed", code: "Exit", message: "Compilation failed", exitCode: 2 },
	};
	const detail = new TaskDetail(task, {
		stdinAvailable: false,
		output: Array.from({ length: 20 }, (_, i) => `line-${i}`).join("\n"),
		outputOmitted: true,
	});
	const text = plain(detail.render(80));
	assert.match(text, /Failed.*exit 2/);
	assert.match(text, /Error\nCompilation failed/);
	assert.match(text, /line-19/);
	assert.doesNotMatch(text, /line-0\n/);
	assert.match(text, /Earlier output omitted/);
	assert.doesNotMatch(text, /Cancel task|Foreground wait/);
});

test("detail keeps status, zero metrics and the selected action pinned while content scrolls", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Inspect rendering");
		fixture.runners[0].context.reportActivity({
			reportId: "metrics",
			change: { kind: "metrics", elapsedMs: 12000, tokenCount: 0, toolCount: 0 },
		});
		for (let i = 0; i < 7; i++)
			fixture.runners[0].context.reportActivity({
				reportId: `action-${i}`,
				change: { kind: "action", tool: "read", text: `component-${i}` },
			});
		fixture.store.drain();
		await new Promise<void>((resolve) => setImmediate(resolve));
		inspector.handleInput("\r");
		for (const key of ["", "\x1b[6~", "\x1b[6~", "\x1b[5~"]) {
			if (key) inspector.handleInput(key);
			const rows = inspector.renderViewport(64, 10);
			assert.ok(rows.length <= 10);
			assert.ok(rows.every((row) => visibleWidth(row) <= 64));
			assert.match(plain(rows), /worker › Inspect rendering/);
			assert.match(plain(rows), /Running · 12s · 0 tokens · 0 tools/);
			assert.match(plain(rows), /› Inspect transcript/);
		}
		inspector.handleInput("\x1b[D");
		assert.equal(inspector.navigation.focus.kind, "tasks");
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("configured x inspection takes precedence over the reference stop shortcut", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager({ "app.tasks.inspect": "x" }));
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Selected agent");
		inspector.handleInput("x");
		assert.equal(inspector.navigation.focus.kind, "detail");
		assert.doesNotMatch(plain(inspector.renderViewport(80, 24)), /y.*confirm|x stop/);
		assert.equal(fixture.store.tasks[0].execution.kind, "running");
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

test("earlier transcript pages remain selected when background activity arrives", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Read history");
		const child = SessionManager.inMemory();
		for (let i = 0; i < 120; i++)
			await child.appendMessage({ role: "user", content: `entry-${String(i).padStart(3, "0")}`, timestamp: i });
		fixture.runners[0].context.bindTranscript(child);
		inspector.handleInput("\r");
		inspector.handleInput("\r");
		fixture.runners[0].context.reportActivity({
			reportId: "during-load",
			change: { kind: "action", tool: "read", text: "while loading" },
		});
		fixture.store.drain();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(plain(inspector.renderViewport(80, 1000)), /entry-119/);
		inspector.handleInput("\x1b[5~");
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(plain(inspector.renderViewport(80, 1000)), /entry-000/);
		fixture.runners[0].context.reportActivity({
			reportId: "activity",
			change: { kind: "action", tool: "read", text: "new work" },
		});
		fixture.store.drain();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.match(plain(inspector.renderViewport(80, 1000)), /entry-000/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});

for (const [binding, input] of [
	["left", "\x1b[D"],
	["pageDown", "\x1b[6~"],
] as const) {
	test(`configured ${binding} inspection works in the list and detail`, async () => {
		initTheme("dark");
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager({ "app.tasks.inspect": binding }));
		const fixture = taskFixture();
		const inspector = new TaskInspector(
			fixture.store,
			() => {},
			() => {},
		);
		try {
			await fixture.start("Inspect selected");
			inspector.handleInput(input);
			assert.equal(inspector.navigation.focus.kind, "detail");
			inspector.handleInput(input);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.match(plain(inspector.renderViewport(80, 24)), /Transcript unavailable/);
		} finally {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		}
	});
}

test("tasks inspector excludes foreground work and retains previously backgrounded results", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Foreground-only task", undefined, false);
		assert.match(plain(inspector.renderViewport(80, 24)), /No background tasks/);
		await fixture.settle(0);
		await fixture.start("Background review");
		assert.doesNotMatch(plain(inspector.renderViewport(80, 24)), /Foreground-only/);
		assert.match(plain(inspector.renderViewport(80, 24)), /Background review/);
		await fixture.settle(1);
		assert.equal(fixture.store.tasks.length, 2);
		assert.equal(fixture.store.backgroundTasks.length, 1);
		assert.match(plain(inspector.renderViewport(80, 24)), /Completed/);
		const reattached = new OwnerTaskStore(fixture.supervisor, fixture.owner);
		try {
			assert.ok(reattached.connect().ok);
			assert.equal(
				reattached.backgroundTasks.length,
				1,
				"fresh terminal snapshot retains background membership without replaying events",
			);
			assert.equal(reattached.backgroundTasks[0].title, "Background review");
		} finally {
			reattached.dispose();
		}
	} finally {
		inspector.dispose();
		await fixture.dispose();
	}
});

test("transcript has stable chrome, bounded rows and Home/End navigation at narrow sizes", async () => {
	initTheme("dark");
	const previous = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		await fixture.start("Long transcript");
		const child = SessionManager.inMemory();
		for (let i = 0; i < 12; i++)
			await child.appendMessage({ role: "user", content: `MESSAGE-${i} ${"界".repeat(40)}\u001b[2J`, timestamp: i });
		fixture.runners[0].context.bindTranscript(child);
		inspector.handleInput("\r");
		inspector.handleInput("\r");
		await new Promise<void>((resolve) => setImmediate(resolve));
		for (const width of [24, 48, 100]) {
			const rows = inspector.renderViewport(width, 12);
			assert.equal(rows.length, 12);
			assert.ok(rows.every((row) => visibleWidth(row) <= width));
			assert.match(plain(rows), /^Transcript/);
			assert.doesNotMatch(rows.join("\n"), /\u001b\[2J/);
			assert.doesNotMatch(plain(rows), /╭|╰/);
		}
		inspector.handleInput("\x1b[F");
		assert.match(plain(inspector.renderViewport(100, 12)), /MESSAGE-11/);
		inspector.handleInput("\x1b[H");
		assert.match(plain(inspector.renderViewport(100, 12)), /MESSAGE-0/);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(previous);
	}
});
