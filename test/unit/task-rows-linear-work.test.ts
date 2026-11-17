import assert from "node:assert/strict";
import { Container, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	type ChatMessageEntry,
	LiveChatEntriesController,
	renderChatMessageEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { TaskList, taskListSections } from "../../packages/coding-agent/src/modes/interactive/components/task-list.js";
import {
	disposeInteractiveTasks,
	refreshInteractiveTasks,
} from "../../packages/coding-agent/src/modes/interactive/interactive-task-projection.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { measureStringWork } from "../../packages/tui/test/string-work.ts";
import { taskFixture } from "../helpers/task-projection.js";
import { taskRecord } from "../helpers/task-record.js";

initTheme();
setKeybindings(new KeybindingsManager());

const TASK_COUNTS = [100, 1_000] as const;
const WIDTH = 80;
const ROW_WORK_PER_TASK = 4_000;
const READS_PER_ENTRY = 4;
const COMPARISONS_PER_TASK_PER_DOUBLING = 4;

function tasks(count: number): TaskRecord[] {
	return Array.from({ length: count }, (_, index) => ({
		...taskRecord(`task-${index}`, index % 5 === 0 ? "command" : "agent"),
		agentName: "worker",
		title: `Task ${index - (index % 4 === 3 ? 1 : 0)}`,
		launchOrdinal: index,
		...(index % 3 === 0 ? { launchGroupId: `group-${Math.floor(index / 9)}` } : {}),
	}));
}

function countReads<T>(array: T[], reads: { count: number }): T[] {
	return new Proxy(array, {
		get(target, property, receiver) {
			if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) reads.count++;
			return Reflect.get(target, property, receiver);
		},
	});
}

test("a task list renders its rows with work linear in the number of tasks", () => {
	for (const count of TASK_COUNTS) {
		const list = new TaskList(tasks(count));
		const { value, work } = measureStringWork(() => list.render(WIDTH));
		assert.ok(value.length >= count);
		assert.ok(work <= ROW_WORK_PER_TASK * count, `${count} tasks: ${work} string work`);
	}
});

test("chat task rows render, and update, with work linear in the tasks and the transcript", async () => {
	for (const count of TASK_COUNTS) {
		const fixture = taskFixture();
		const session = {};
		const chatContainer = new Container();
		const mode = { session, chatContainer, toolOutputExpanded: false, ui: { requestRender() {} } };
		try {
			for (let index = 0; index < count; index++) {
				chatContainer.addChild({ render: () => [`message ${index}`], invalidate() {} });
				await fixture.start(`Task ${index % (count / 2)}`);
			}
			bindOwnerTaskStore(session, fixture.store);
			refreshInteractiveTasks(mode);
			assert.equal(chatContainer.children.length, 2 * count);

			const { work } = measureStringWork(() => chatContainer.render(WIDTH));
			assert.ok(work <= ROW_WORK_PER_TASK * count, `${count} tasks: ${work} string work per frame`);

			const reads = { count: 0 };
			chatContainer.children = countReads(chatContainer.children, reads);
			refreshInteractiveTasks(mode);
			const bound = READS_PER_ENTRY * chatContainer.children.length;
			assert.ok(reads.count <= bound, `${count} tasks: ${reads.count} child reads per update, bound ${bound}`);
		} finally {
			disposeInteractiveTasks(mode);
			await fixture.dispose();
		}
	}
});

test("the live chat updates and renders its task rows with work linear in the tasks and the transcript", () => {
	for (const count of TASK_COUNTS) {
		const reads = { count: 0 };
		const transcript: ChatMessageEntry[] = Array.from({ length: count }, (_, index) => ({
			role: "system",
			kind: "system",
			text: `message ${index}`,
		}));
		const entries = countReads<ChatMessageEntry | { role: string }>(transcript, reads);
		const chat = new LiveChatEntriesController(entries);
		const listed = tasks(count);
		chat.upsertTasks(listed);
		reads.count = 0;
		chat.upsertTasks(listed);
		const bound = READS_PER_ENTRY * transcript.length;
		assert.ok(reads.count <= bound, `${count} tasks: ${reads.count} entry reads per update, bound ${bound}`);

		const rows = transcript.filter((entry) => entry.kind === "task");
		assert.equal(rows.length, count);
		const { work } = measureStringWork(() => {
			for (const entry of rows)
				renderChatMessageEntry(entry, { ui: { requestRender() {} }, cwd: "/" }).render(WIDTH);
		});
		assert.ok(work <= ROW_WORK_PER_TASK * count, `${count} tasks: ${work} string work per frame`);
	}
});

test("task list sections order tasks with comparisons proportional to n log n", () => {
	const sort = Array.prototype.sort;
	for (const count of TASK_COUNTS) {
		const listed = tasks(count).map((task, index) =>
			index % 2 === 0 ? task : { ...task, execution: { kind: "queued" as const } },
		);
		let comparisons = 0;
		Array.prototype.sort = function <T>(this: T[], compare?: (a: T, b: T) => number): T[] {
			return sort.call(this, (a: T, b: T) => {
				comparisons++;
				return compare ? compare(a, b) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
			}) as T[];
		};
		try {
			taskListSections(listed);
		} finally {
			Array.prototype.sort = sort;
		}
		const bound = COMPARISONS_PER_TASK_PER_DOUBLING * count * Math.log2(count);
		assert.ok(comparisons <= bound, `${count} tasks: ${comparisons} comparisons, bound ${Math.round(bound)}`);
	}
});
