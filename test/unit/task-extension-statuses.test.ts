import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import {
	taskExtensionStatuses,
	watchTaskExtensionStatuses,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";

const plain = (lines: string[]) => stripVTControlCharacters(lines.join("\n"));

test("a task keeps the extension statuses its own session writes, per task (#4103)", async () => {
	const fixture = taskFixture();
	try {
		const first = await fixture.start("first");
		const second = await fixture.start("second");
		fixture.runners[0].context.setExtensionStatus("tps", "42 tok/s");
		fixture.runners[0].context.setExtensionStatus("mcp", "2 servers");
		fixture.runners[1].context.setExtensionStatus("tps", "7 tok/s");

		assert.deepEqual(
			[...taskExtensionStatuses(first)],
			[
				["tps", "42 tok/s"],
				["mcp", "2 servers"],
			],
		);
		assert.deepEqual([...taskExtensionStatuses(second)], [["tps", "7 tok/s"]]);

		fixture.runners[0].context.setExtensionStatus("tps", undefined);
		assert.deepEqual([...taskExtensionStatuses(first)], [["mcp", "2 servers"]]);
	} finally {
		await fixture.dispose();
	}
});

test("watchers hear only changes to their task's statuses and stop when released (#4103)", async () => {
	const fixture = taskFixture();
	try {
		const first = await fixture.start("first");
		await fixture.start("second");
		let heard = 0;
		const release = watchTaskExtensionStatuses(first, () => heard++);

		fixture.runners[0].context.setExtensionStatus("tps", "42 tok/s");
		fixture.runners[0].context.setExtensionStatus("tps", "42 tok/s"); // unchanged: no repaint
		fixture.runners[1].context.setExtensionStatus("tps", "7 tok/s"); // another task's
		assert.equal(heard, 1);

		release();
		fixture.runners[0].context.setExtensionStatus("tps", "43 tok/s");
		assert.equal(heard, 1);
	} finally {
		await fixture.dispose();
	}
});

test("a task's statuses clear when its session is replaced or the task ends (#4103)", async () => {
	const fixture = taskFixture();
	try {
		const lease = await fixture.start("first");
		let heard = 0;
		watchTaskExtensionStatuses(lease, () => heard++);

		fixture.runners[0].context.setExtensionStatus("tps", "42 tok/s");
		fixture.runners[0].context.clearExtensionStatuses();
		assert.equal(taskExtensionStatuses(lease).size, 0);
		assert.equal(heard, 2, "the clear repaints watchers");

		fixture.runners[0].context.setExtensionStatus("tps", "43 tok/s");
		await fixture.settle(0);
		assert.equal(taskExtensionStatuses(lease).size, 0);
		assert.equal(heard, 4, "ending the task clears and repaints");
	} finally {
		await fixture.dispose();
	}
});

for (const page of ["detail", "transcript"] as const) {
	test(`the task ${page} page shows that task's own status row, live, and drops it when the task ends (#4103)`, async () => {
		initTheme("dark");
		const previous = getKeybindings();
		setKeybindings(new KeybindingsManager());
		const fixture = taskFixture();
		let repaints = 0;
		const inspector = new TaskInspector(
			fixture.store,
			() => {
				repaints++;
			},
			() => {},
		);
		try {
			await fixture.start("first");
			await fixture.start("second");
			inspector.open(fixture.store.tasks[0].ref.taskId);
			// The compact picker is not a task page: it shows no status row even when the task has statuses.
			fixture.runners[0].context.setExtensionStatus("tps", "42 tok/s");
			assert.doesNotMatch(plain(inspector.renderPicker(80, 12)), /42 tok\/s/);

			inspector.handleInput("\r");
			if (page === "transcript") {
				inspector.handleInput("\r");
				assert.match(plain(inspector.renderViewport(80, 24)), /Transcript ·/);
			}
			const visible = plain(inspector.renderViewport(80, 24));
			assert.match(visible, /42 tok\/s/);
			// The status is the last row, beneath the page's own footer, like the main chat's status row.
			assert.match(plain(inspector.renderViewport(80, 24).slice(-1)), /^42 tok\/s\s*$/);

			// Another task's status never appears; this task's later writes repaint the page.
			fixture.runners[1].context.setExtensionStatus("other", "second only");
			const before = repaints;
			fixture.runners[0].context.setExtensionStatus("mcp", "2 servers");
			assert.ok(repaints > before, "a status write repaints the open page");
			const updated = plain(inspector.renderViewport(80, 24));
			assert.match(updated, /2 servers • 42 tok\/s/);
			assert.doesNotMatch(updated, /second only/);
			assert.ok(inspector.renderViewport(80, 24).length <= 24, "the status row fits inside the page's height");

			// Ending the task clears its row.
			await fixture.settle(0);
			assert.doesNotMatch(plain(inspector.renderViewport(80, 24)), /tok\/s|2 servers/);
		} finally {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		}
	});
}

test("a disposed inspector stops listening to task statuses (#4103)", async () => {
	initTheme("dark");
	const fixture = taskFixture();
	let repaints = 0;
	const inspector = new TaskInspector(
		fixture.store,
		() => {
			repaints++;
		},
		() => {},
	);
	try {
		await fixture.start("first");
		inspector.open(fixture.store.tasks[0].ref.taskId);
		inspector.handleInput("\r");
		inspector.renderViewport(80, 24);
		inspector.dispose();
		const before = repaints;
		fixture.runners[0].context.setExtensionStatus("tps", "42 tok/s");
		assert.equal(repaints, before, "a disposed inspector is no longer repainted");
	} finally {
		await fixture.dispose();
	}
});
