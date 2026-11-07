import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type {
	TaskTranscriptView,
	TaskViewResult,
	TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const TASK = "task-1" as TaskId;
const PAGE_UP = "\x1b[5~";
const CTRL_END = "\x1b[1;5F";

const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

const latestPage = (count: number): TaskViewResult<TaskTranscriptView> => ({
	ok: true,
	value: {
		messages: Array.from({ length: count }, (_, i) => ({ role: "user" as const, content: `M-${i}`, timestamp: i })),
	},
});

/** A live transcript binding whose subscribers the test can count. */
function liveSession(name: string) {
	const listeners = new Set<() => void>();
	const session: TaskTranscriptSource = {
		getSessionId: () => name,
		getEntries: () => [],
		subscribe: (listener) => {
			listeners.add(listener as () => void);
			return () => listeners.delete(listener as () => void);
		},
	};
	return { session, listeners };
}

function openPage(source: TaskViewSource) {
	initTheme("dark");
	const page = new TaskAgentTranscriptPage(
		source,
		TASK,
		taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
		() => {},
	);
	const text = () => stripVTControlCharacters(page.render(80, 20).join("\n"));
	return { page, text };
}

test("a live transcript whose session changes while the reader is above the end follows the new session at once (#4521)", async () => {
	const first = liveSession("first");
	const second = liveSession("second");
	let current = first.session;
	const { page, text } = openPage({
		readTaskTranscript: () => latestPage(60),
		followTaskTranscript: () => ({ session: current, historyOnly: false }),
	} as Partial<TaskViewSource> as TaskViewSource);
	try {
		await page.load();
		text();
		assert.equal(first.listeners.size, 1);
		page.handleInput(PAGE_UP);
		text();
		current = second.session;
		page.refresh();
		await flush();
		assert.equal(first.listeners.size, 0, "the old session is left");
		assert.equal(second.listeners.size, 1, "a live session is followed even while the reader is above the end");
	} finally {
		page.dispose();
	}
});

test("a transcript whose live session ends leaves it and keeps showing the page without an error (#4521)", async () => {
	const live = liveSession("live");
	let follow: { session: TaskTranscriptSource; historyOnly: boolean } = { session: live.session, historyOnly: false };
	const { page, text } = openPage({
		readTaskTranscript: () => latestPage(3),
		followTaskTranscript: () => follow,
	} as Partial<TaskViewSource> as TaskViewSource);
	try {
		await page.load();
		assert.equal(live.listeners.size, 1);
		follow = { session: { getSessionId: () => "kept", getEntries: () => [] }, historyOnly: true };
		page.refresh();
		await flush();
		assert.equal(live.listeners.size, 0);
		assert.equal(page.status, "", "no error while adopting a page without a live session");
		assert.match(text(), /M-2/);
	} finally {
		page.dispose();
	}
});

test("a re-read transcript waits for the reader to reach the end, not for any key (#4521)", async () => {
	let reads = 0;
	let count = 60;
	const { page, text } = openPage({
		readTaskTranscript: () => {
			reads++;
			return latestPage(count);
		},
		followTaskTranscript: () => ({
			session: { getSessionId: () => "kept", getEntries: () => [] },
			historyOnly: true,
		}),
	} as Partial<TaskViewSource> as TaskViewSource);
	try {
		await page.load();
		text();
		page.handleInput(PAGE_UP);
		text();
		count = 61;
		page.refresh();
		await flush();
		const before = reads;
		page.handleInput(PAGE_UP);
		text();
		await flush();
		assert.equal(reads, before, "a key that leaves the reader above the end reads nothing");
		page.handleInput(CTRL_END);
		await flush();
		assert.equal(reads, before + 1);
		assert.match(text(), /M-60/);
	} finally {
		page.dispose();
	}
});
