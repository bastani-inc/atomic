import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { bindTaskResumer } from "../../packages/coding-agent/src/core/tasks/task-resumer.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { stripVTControlCharacters } from "../helpers/visible-text.ts";
import { makeTestTui } from "../support/fake-tui.js";

const LEFT = "\x1b[D";
const ESC = "\x1b";
const ENTER = "\r";
const SPACE = " ";

let previousKeys: ReturnType<typeof getKeybindings>;
beforeEach(() => {
	initTheme("dark");
	previousKeys = getKeybindings();
	setKeybindings(new KeybindingsManager());
});
afterEach(() => {
	setKeybindings(previousKeys);
	vi.useRealTimers();
});

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function harness(source?: (owner: TaskViewSource) => TaskViewSource) {
	const fixture = taskFixture();
	const owner = ownerTaskViewSource(fixture.store);
	const keys = getKeybindings();
	const environment = taskTranscriptEnvironment({ tui: makeTestTui(24), keybindings: keys });
	let closed = 0;
	const inspector = new TaskInspector(
		source?.(owner) ?? owner,
		() => {},
		() => {
			closed++;
		},
		undefined,
		() => environment,
	);
	const text = (width = 100, rows = 24) =>
		inspector
			.renderViewport(width, rows)
			.map((line) => stripVTControlCharacters(line).trimEnd())
			.join("\n");
	const type = async (value: string) => {
		for (const ch of value) inspector.handleInput(ch);
		await flush();
	};
	return {
		fixture,
		inspector,
		text,
		type,
		closed: () => closed,
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
		},
	};
}

async function withTranscript(h: Awaited<ReturnType<typeof harness>>, title: string) {
	await h.fixture.start(title);
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: `prompt of ${title}`, timestamp: 0 });
	const transcript: TaskTranscriptSource = Object.assign(session, { subscribe: () => () => {} });
	h.fixture.runners.at(-1)?.context.bindTranscript(transcript);
}

test("Enter on a /tasks row opens its chat, Space opens its detail, and ← unwinds one level (#5224)", async () => {
	const h = await harness();
	try {
		await withTranscript(h, "Open me");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /^Transcript · worker/, "Enter opens the chat directly");
		assert.match(h.text(), /← tasks · pgup\/pgdn scroll/, "the hint names where ← goes");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^ Tasks\b/m, "← from a chat opened from the list returns to the list");
		h.inspector.handleInput(SPACE);
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /› Inspect transcript/, "Space peeks at the task's detail page");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /← task · pgup\/pgdn scroll/, "a chat opened from the detail page names it");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /› Inspect transcript/);
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^ Tasks\b/m);
		h.inspector.handleInput(LEFT);
		assert.equal(h.closed(), 1, "← on the list closes it");
	} finally {
		await h.dispose();
	}
});

test("← at the start of a typed prompt leaves the chat and keeps the draft for the return (#5224)", async () => {
	const h = await harness();
	try {
		await withTranscript(h, "Draft task");
		h.inspector.handleInput(ENTER);
		await flush();
		await h.type("half a thought");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^Transcript/, "← inside the text moves the cursor");
		h.inspector.handleInput("\x1b[H");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^ Tasks\b/m, "← at the start of the prompt leaves");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /half a thought/, "the draft comes back");
	} finally {
		await h.dispose();
	}
});

test("every /tasks hint names exactly its live keys, ← included (#5224)", async () => {
	const h = await harness();
	try {
		await withTranscript(h, "Hinted");
		const last = () => h.text().split("\n").at(-1);
		assert.equal(last(), "  ↑↓ select · space peek · enter/→ open · x stop · / filter · esc/← close · ? keys");
		h.inspector.handleInput(SPACE);
		h.inspector.handleInput(ENTER);
		await flush();
		assert.equal(last(), "  ↑↓ actions · enter/→ select · x stop · pgup/pgdn scroll · esc/← back to list · ? keys");
		h.inspector.handleInput(ESC);
		h.inspector.handleInput(ENTER);
		await flush();
		assert.equal(last(), "  ← tasks · pgup/pgdn scroll · ? keys");
	} finally {
		await h.dispose();
	}
});

test("an armed stop whose task finishes is disarmed, the next x only acknowledges it, and a later x dismisses (#5224)", async () => {
	const h = await harness();
	try {
		await h.fixture.start("Racing task");
		h.inspector.handleInput("x");
		assert.match(h.text(), /Press x again within 3s to stop Racing task/);
		await h.fixture.settle();
		h.fixture.store.drain();
		assert.match(h.text(), /Racing task finished · x to acknowledge/);
		h.inspector.handleInput("x");
		assert.match(
			h.text(),
			/Racing task finished · x to dismiss/,
			"the press meant as the stop's second press keeps the row",
		);
		assert.equal(h.fixture.store.backgroundTasks.length, 1);
		h.inspector.handleInput("x");
		assert.doesNotMatch(h.text(), /Racing task/, "the finished row is dismissed");
		assert.equal(h.fixture.store.backgroundTasks.length, 1, "dismissing hides the row, not the task");
	} finally {
		await h.dispose();
	}
});

test("the first x's notice leaves when its window closes (#5224)", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
	const h = await harness();
	try {
		await h.fixture.start("Waiting task");
		h.inspector.handleInput("x");
		assert.match(h.text(), /Press x again within 3s/);
		vi.advanceTimersByTime(3100);
		assert.doesNotMatch(h.text(), /Press x again/);
	} finally {
		await h.dispose();
	}
});

test("shell input: Esc keeps it and its text, ← on empty input returns to the list, and a draft survives (#5224)", async () => {
	const shell = (await import("../helpers/task-record.js")).taskRecord("shell-1", "command");
	const writes: string[] = [];
	const h = await harness((owner) => ({
		...owner,
		tasks: [shell],
		backgroundTasks: [shell],
		stdinAvailable: () => true,
		writeTaskInput: async (_id: TaskId, value: string) => {
			writes.push(value);
			return { ok: true as const, value: { acceptedBytes: value.length } };
		},
		readTaskOutput: async () => ({ ok: true as const, value: { text: "", omitted: false } }),
	}));
	try {
		h.inspector.handleInput(SPACE);
		h.inspector.handleInput(ENTER);
		await flush();
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /Input to /);
		await h.type("yes");
		h.inspector.handleInput(ESC);
		assert.match(h.text(), /Input to /, "Esc does not leave the input");
		assert.match(h.text(), /yes/, "Esc does not clear it");
		for (let i = 0; i < 3; i++) h.inspector.handleInput("\x7f");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^ Tasks\b/m, "← on an empty input returns to the list");
		h.inspector.handleInput(SPACE);
		h.inspector.handleInput(ENTER);
		await flush();
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput(ENTER);
		await h.type("draft");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /Input to /, "← inside the text moves the cursor");
		h.inspector.handleInput("\x1b[H");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^ Tasks\b/m, "← at the start of a draft leaves, as in a chat");
		h.inspector.handleInput(SPACE);
		h.inspector.handleInput(ENTER);
		await flush();
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput("\x1b[B");
		h.inspector.handleInput(ENTER);
		assert.match(
			h
				.text()
				.replace(/[\x00-\x1f]/g, "")
				.replace(/_pi:\/?fc/g, ""),
			/draft/,
			"the draft comes back",
		);
		assert.deepEqual(writes, []);
	} finally {
		await h.dispose();
	}
});

test("a finished subagent's chat stays live and a message resumes it; one stopped for good is read-only (#5224)", async () => {
	const h = await harness();
	const resumed: string[] = [];
	let reason: string | undefined;
	const unbind = bindTaskResumer(h.fixture.supervisor, {
		readOnlyReason: () => reason,
		async resume(_id, message) {
			resumed.push(message);
			return { ok: true };
		},
	});
	try {
		await withTranscript(h, "Finished task");
		await h.fixture.settle();
		h.inspector.handleInput(ENTER);
		await flush();
		await h.type("one more thing");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(resumed, ["one more thing"], "the message resumes the finished subagent");
		reason = "worker cannot take messages: it was cancelled for good.";
		assert.match(h.text(), /cannot take messages: it was cancelled for good/);
		await h.type("ignored");
		assert.doesNotMatch(h.text(), /ignored/, "a read-only chat takes no typing");
		h.inspector.handleInput(LEFT);
		assert.match(h.text(), /^ Tasks\b/m, "← still works");
	} finally {
		unbind();
		await h.dispose();
	}
});

test("x x stops a subagent resumably: its chat says 'Stopped · send to resume' and a message resumes it (#5224)", async () => {
	const h = await harness();
	const stops: string[] = [];
	const resumed: string[] = [];
	let stopped = false;
	const unbind = bindTaskResumer(h.fixture.supervisor, {
		readOnlyReason: () => undefined,
		stop(id) {
			stops.push(id);
			stopped = true;
			return Promise.resolve({ ok: true as const });
		},
		isStopped: () => stopped,
		async resume(_id, message) {
			resumed.push(message);
			stopped = false;
			return { ok: true };
		},
	});
	try {
		await withTranscript(h, "Stoppable task");
		h.inspector.handleInput("x");
		h.inspector.handleInput("x");
		await flush();
		assert.equal(stops.length, 1, "the stop goes through the resumable stop, not a cancellation");
		assert.equal(h.fixture.runners[0]?.context.signal.aborted, false);
		await h.fixture.settle();
		h.inspector.handleInput(ENTER);
		await flush();
		assert.match(h.text(), /Stopped · send to resume/);
		await h.type("go on");
		h.inspector.handleInput(ENTER);
		await flush();
		assert.deepEqual(resumed, ["go on"], "only an explicit message resumes it");
		assert.doesNotMatch(h.text(), /Stopped · send to resume/);
	} finally {
		unbind();
		await h.dispose();
	}
});

test("an attached chat goes back only with ← while ↓ stays local to its own tasks (#5224)", async () => {
	for (const key of [LEFT, "\x1b[B"]) {
		const h = await harness();
		try {
			await withTranscript(h, "Panel task");
			const id = h.fixture.store.tasks[0]!.ref.taskId;
			h.inspector.openChat(id, "agents");
			await flush();
			assert.equal(h.text().split("\n").at(-1), "  ← agents · pgup/pgdn scroll · ? keys");
			h.inspector.handleInput(key);
			assert.equal(h.closed(), key === LEFT ? 1 : 0);
			assert.equal(h.inspector.closedByBack, key === LEFT);
		} finally {
			await h.dispose();
		}
	}
});

test("Esc in a waiting subagent's chat never leaves it, and its question stays pending (#5224)", async () => {
	const h = await harness();
	try {
		await withTranscript(h, "Asking task");
		h.fixture.runners[0]!.context.reportActivity({
			reportId: "question",
			change: {
				kind: "attention-set",
				attention: {
					kind: "input-needed",
					requestId: "q",
					prompt: "Ship it?",
					route: { sessionId: "fixture", promptId: "q" },
				},
			},
		});
		h.fixture.store.drain();
		const id = h.fixture.store.tasks[0]!.ref.taskId;
		h.inspector.openChat(id, "agents");
		await flush();
		assert.match(h.text(), /needs input/, "the composer names the wait");
		h.inspector.handleInput(ESC);
		h.inspector.handleInput(ESC);
		await flush();
		assert.equal(h.closed(), 0, "Esc does not leave the chat");
		assert.equal(h.fixture.store.tasks[0]!.attention.kind, "input-needed", "the question is still pending");
		assert.match(h.text(), /Answer worker…/, "the prompt says it answers the question");
	} finally {
		await h.dispose();
	}
});
