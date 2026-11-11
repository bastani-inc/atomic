import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type {
	TaskTranscriptView,
	TaskViewResult,
	TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

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
	const { page, text } = openPage(
		transcriptOnlySource({
			readTaskTranscript: () => latestPage(60),
			followTaskTranscript: () => ({ session: current, historyOnly: false }),
		}),
	);
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
	const { page, text } = openPage(
		transcriptOnlySource({
			readTaskTranscript: () => latestPage(3),
			followTaskTranscript: () => follow,
		}),
	);
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
	const { page, text } = openPage(
		transcriptOnlySource({
			readTaskTranscript: () => {
				reads++;
				return latestPage(count);
			},
			followTaskTranscript: () => ({
				session: { getSessionId: () => "kept", getEntries: () => [] },
				historyOnly: true,
			}),
		}),
	);
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

function messagingPage(source: TaskViewSource, notices: string[] = []) {
	initTheme("dark");
	const page = new TaskAgentTranscriptPage(
		source,
		TASK,
		taskTranscriptEnvironment({ keybindings: new KeybindingsManager(), notify: (message) => notices.push(message) }),
		() => {},
	);
	const send = async (text: string) => {
		for (const ch of text) page.handleInput(ch);
		page.handleInput("\r");
		await flush();
	};
	return { page, send };
}

test("a page built without a reporter tells the host about a message that failed after it closed (#4521)", async () => {
	const answer = Promise.withResolvers<void>();
	const notices: string[] = [];
	const source = transcriptOnlySource({
		readTaskTranscript: () => latestPage(1),
		followTaskTranscript: () => undefined,
		sendTaskMessage: () => answer.promise,
	});
	const { page, send } = messagingPage(source, notices);
	await page.load();
	await send("late note");
	page.dispose();
	answer.reject(new TaskMessageError("delivery-refused", { taskId: TASK, target: "worker-1" }));
	await flush();
	assert.equal(notices.length, 1);
	assert.match(notices[0] ?? "", /Intercom did not deliver the message: worker-1 \(delivery-refused\)/);
});

test("two messages that failed after their pages closed both come back, in order, on reopening (#4521)", async () => {
	const answers = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
	let sends = 0;
	const source = transcriptOnlySource({
		readTaskTranscript: () => latestPage(1),
		followTaskTranscript: () => undefined,
		sendTaskMessage: () => answers[sends++]!.promise,
	});
	const first = messagingPage(source);
	await first.page.load();
	await first.send("first note");
	first.page.dispose();
	const second = messagingPage(source);
	await second.page.load();
	await second.send("second note");
	second.page.dispose();
	for (const answer of answers) answer.reject(new TaskMessageError("delivery-refused", { taskId: TASK }));
	await flush();
	const reopened = messagingPage(source);
	try {
		await reopened.page.load();
		const text = stripVTControlCharacters(reopened.page.render(80, 20).join("\n"));
		assert.match(text, /first note[\s\S]*second note/);
	} finally {
		reopened.page.dispose();
	}
});
