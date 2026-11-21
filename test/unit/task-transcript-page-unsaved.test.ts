import assert from "node:assert/strict";
import type { AgentTool } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

/**
 * A subagent's chat in the engine tells its host which queued messages show in its transcript and have not been seen
 * saved, so a host that loses the engine can list them as unconfirmed.
 */

const TASK = "task-1" as TaskId;
const harnesses: Harness[] = [];
afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
});

/** The user message events a real session sends for a message queued while it works, and for its own prompt. */
async function sessionEvents(): Promise<AgentSessionEvent[]>;
/**
 * The same, live: `onQueuedSave` runs as the session is about to save the queued message, which waits for it; the
 * events so far are in `events`, which keeps growing, and `done` settles once the session answered.
 */
async function sessionEvents(options: {
	readonly onQueuedSave: () => Promise<void>;
}): Promise<{ readonly events: AgentSessionEvent[]; readonly done: Promise<void> }>;
async function sessionEvents(options?: {
	readonly onQueuedSave: () => Promise<void>;
}): Promise<AgentSessionEvent[] | { readonly events: AgentSessionEvent[]; readonly done: Promise<void> }> {
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const tool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Waits until released",
		parameters: Type.Object({}),
		execute: async () => {
			started.resolve();
			await release.promise;
			return { content: [{ type: "text", text: "done" }], details: {} };
		},
	};
	const h = await createHarness({
		tools: [tool],
		extensionFactories: [
			(pi) => {
				pi.on("message_end", async (event) => {
					if (event.message.role === "user" && getMessageText(event.message) === "queued while it worked")
						await options?.onQueuedSave();
				});
			},
		],
	});
	harnesses.push(h);
	h.setResponses([
		fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage("ok"),
	]);
	const events: AgentSessionEvent[] = [];
	h.session.subscribe((event) => {
		if ((event.type === "message_start" || event.type === "message_end") && event.message.role === "user")
			events.push(event);
	});
	const run = h.session.prompt("its own prompt");
	await started.promise;
	await h.session.steer("queued while it worked");
	release.resolve();
	if (options !== undefined) return { events, done: run };
	await run;
	return events;
}

/** A live child session whose events the test sends, and a task view source that follows it. */
function followedChild(saved: Set<object> = new Set()) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session: TaskTranscriptSource = {
		getSessionId: () => "child",
		getEntries: () => [],
		entryReceipt: (message) => (saved.has(message) ? { seq: 1 } : undefined),
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	const source = transcriptOnlySource({
		readTaskTranscript: () => ({ ok: true, value: { messages: [] } }),
		followTaskTranscript: () => ({ session, historyOnly: false }),
	});
	const open = async () => {
		initTheme("dark");
		const page = new TaskAgentTranscriptPage(
			source,
			TASK,
			taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
			() => {},
		);
		await page.load();
		return page;
	};
	const emit = (event: AgentSessionEvent | undefined) => {
		assert.ok(event);
		for (const listener of [...listeners]) listener(event);
	};
	return { open, emit };
}

test("a queued message the subagent's transcript shows is reported unsaved until its save arrives", async () => {
	const events = await sessionEvents();
	const child = followedChild();
	const page = await child.open();
	try {
		const emit = (index: number) => child.emit(events[index]);
		const unsaved = () => page.viewStatus("worker").unsaved;
		// Its own prompt is no queued message.
		emit(0);
		assert.equal(unsaved(), undefined);
		emit(1);
		// The queued one shows, and is not saved yet.
		emit(2);
		assert.deepEqual(unsaved(), ["queued while it worked"]);
		emit(3);
		assert.equal(unsaved(), undefined, "saved");
	} finally {
		page.dispose();
	}
});

test("a shown queued message not seen saved is reported with its receipt and its session, for a host that loses the engine", async () => {
	// The session's save of the queued message waits, so its page reports it while it is shown and not saved.
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const live = await sessionEvents({
		onQueuedSave: async () => {
			held.resolve();
			await release.promise;
		},
	});
	const child = followedChild();
	const page = await child.open();
	try {
		await held.promise;
		for (const event of live.events) child.emit(event);
		const status = page.viewStatus("worker");
		assert.deepEqual(status.unsaved, ["queued while it worked"]);
		const receipt = status.receipts?.taken[0];
		assert.equal(status.receipts?.sessionId, "child");
		assert.equal(status.receipts?.taken.length, 1, "one receipt per message, in the order of `unsaved`");
		assert.equal(typeof receipt?.id, "string");
		assert.equal(typeof receipt?.after, "number");
		release.resolve();
		await live.done;
		child.emit(live.events.at(-1));
		assert.equal(page.viewStatus("worker").receipts, undefined, "saved: nothing left to find");
	} finally {
		release.resolve();
		page.dispose();
	}
});

test("a shown queued message saved while no chat of it was open is not reported when one opens again, whatever its session's window holds", async () => {
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const live = await sessionEvents({
		onQueuedSave: async () => {
			held.resolve();
			await release.promise;
		},
	});
	// Its session cannot say where it stored the message (as after a compaction left it out of the window).
	const child = followedChild();
	const first = await child.open();
	await held.promise;
	for (const event of live.events) child.emit(event);
	assert.deepEqual(first.viewStatus("worker").unsaved, ["queued while it worked"]);
	first.dispose();
	release.resolve();
	await live.done;
	const reopened = await child.open();
	try {
		assert.equal(reopened.viewStatus("worker").unsaved, undefined);
		assert.equal(reopened.viewStatus("worker").receipts, undefined);
	} finally {
		reopened.dispose();
	}
});

test("another message saved with a queued message's text is not that message's save", async () => {
	const events = await sessionEvents();
	const child = followedChild();
	const page = await child.open();
	try {
		for (const index of [0, 1, 2]) child.emit(events[index]);
		// A different message, such as one sent directly, saved with the same text.
		child.emit({
			type: "message_end",
			message: { role: "user", content: "queued while it worked", timestamp: Date.now() },
		} as AgentSessionEvent);
		assert.deepEqual(page.viewStatus("worker").unsaved, ["queued while it worked"]);
		child.emit(events[3]);
		assert.equal(page.viewStatus("worker").unsaved, undefined, "its own save");
	} finally {
		page.dispose();
	}
});

test("a chat opened again while a shown queued message's save is on its way still reports it", async () => {
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const live = await sessionEvents({
		onQueuedSave: async () => {
			held.resolve();
			await release.promise;
		},
	});
	const child = followedChild();
	const first = await child.open();
	await held.promise;
	for (const event of live.events) child.emit(event);
	assert.deepEqual(first.viewStatus("worker").unsaved, ["queued while it worked"]);
	first.dispose();

	const reopened = await child.open();
	try {
		assert.deepEqual(
			reopened.viewStatus("worker").unsaved,
			["queued while it worked"],
			"the same child, not saved yet",
		);
		release.resolve();
		await live.done;
		child.emit(live.events.at(-1));
		assert.equal(reopened.viewStatus("worker").unsaved, undefined, "saved");
	} finally {
		release.resolve();
		reopened.dispose();
	}
});

test("a shown queued message saved while no chat of it was open is not reported when one opens again", async () => {
	const events = await sessionEvents();
	const saved = new Set<object>();
	const child = followedChild(saved);
	const first = await child.open();
	child.emit(events[0]);
	child.emit(events[1]);
	child.emit(events[2]);
	first.dispose();
	// Its save arrives while no page follows the session.
	const start = events[2];
	assert.ok(start?.type === "message_start");
	saved.add(start.message);

	const reopened = await child.open();
	try {
		assert.equal(reopened.viewStatus("worker").unsaved, undefined);
	} finally {
		reopened.dispose();
	}
});

test("two chats of one subagent report a shown queued message once, and its save once", async () => {
	const events = await sessionEvents();
	const child = followedChild();
	const panel = await child.open();
	const tasks = await child.open();
	try {
		child.emit(events[0]);
		child.emit(events[1]);
		child.emit(events[2]);
		assert.deepEqual(panel.viewStatus("worker").unsaved, ["queued while it worked"]);
		assert.deepEqual(tasks.viewStatus("worker").unsaved, ["queued while it worked"]);
		panel.dispose();
		child.emit(events[3]);
		assert.equal(tasks.viewStatus("worker").unsaved, undefined);
	} finally {
		panel.dispose();
		tasks.dispose();
	}
});
