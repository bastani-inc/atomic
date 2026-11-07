import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import {
	VERBATIM_COMPACTION_PROMPT_VERSION,
	type VerbatimCompactionDetails,
} from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import type { TaskTranscriptEnvironment } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const flush = async () => {
	for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const CTRL_HOME = "\x1b[1;5H";
const CTRL_END = "\x1b[1;5F";
const PAGE_UP = "\x1b[5~";
/** The editor's cursor marker; it is not printable text. */
const APPLICATION_COMMAND = /\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") =>
	({
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	}) as AssistantMessage;

const verbatimDetails: VerbatimCompactionDetails = {
	strategy: "verbatim-lines",
	promptVersion: VERBATIM_COMPACTION_PROMPT_VERSION,
	parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	rung: "planned",
};

interface OpenTranscriptOptions {
	readonly environment?: Partial<TaskTranscriptEnvironment>;
	readonly source?: (owner: TaskViewSource) => TaskViewSource;
	readonly width?: number;
	readonly height?: number;
}

/** Opens the first task's transcript from the task list, as `/tasks` → Enter → Enter does. */
async function openTranscript(transcript: TaskTranscriptSource, options: OpenTranscriptOptions = {}) {
	initTheme("dark");
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const owner = ownerTaskViewSource(fixture.store);
	const source = options.source?.(owner) ?? owner;
	const environment = taskTranscriptEnvironment({
		tui: makeTestTui(options.height ?? 24),
		keybindings: keys,
		...options.environment,
	});
	let renders = 0;
	const inspector = new TaskInspector(
		source,
		() => {
			renders++;
		},
		() => {},
		undefined,
		() => environment,
	);
	await fixture.start("Inspect the shared stack");
	fixture.runners[0].context.bindTranscript(transcript);
	inspector.handleInput("\r");
	await flush();
	inspector.handleInput("\r");
	await flush();
	const frame = (width = options.width ?? 80, height = options.height ?? 24) =>
		inspector
			.renderViewport(width, height)
			.map((line) => stripVTControlCharacters(line.replace(APPLICATION_COMMAND, "")).trimEnd());
	return {
		inspector,
		fixture,
		frame,
		text: () => frame().join("\n"),
		get renders() {
			return renders;
		},
		async type(text: string) {
			for (const ch of text) inspector.handleInput(ch);
			await flush();
		},
		async dispose() {
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		},
	};
}

/** The messages a page's first transcript body row belongs to. */
const firstMessage = (rows: readonly string[]) =>
	rows
		.slice(3)
		.map((row) => /M-\d{3}/.exec(row)?.[0])
		.find((name) => name !== undefined);

test("PageUp is a plain scroll and earlier history loads once near the top, holding the reader's place (#4521)", async () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 250; i++)
		await session.appendMessage({ role: "user", content: `M-${String(i).padStart(3, "0")}`, timestamp: i });
	const reads: Array<string | undefined> = [];
	const host = await openTranscript(session, {
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				readTaskTranscript: (id: TaskId, cursor?: string) => {
					reads.push(cursor);
					return owner.readTaskTranscript(id, cursor);
				},
			}),
	});
	try {
		assert.match(host.text(), /M-249/, "the transcript opens at its latest message");
		assert.deepEqual(reads, [undefined]);
		const latestTop = firstMessage(host.frame());
		host.inspector.handleInput("\x1b[5~");
		const paged = firstMessage(host.frame());
		assert.notEqual(paged, latestTop, "PageUp moves the view");
		assert.ok(Number(paged?.slice(2)) < Number(latestTop?.slice(2)));
		assert.equal(reads.length, 1, "PageUp itself reads nothing");

		host.inspector.handleInput(CTRL_HOME);
		const parked = host.frame();
		host.frame();
		assert.equal(reads.length, 2, "nearing the top asks for the earlier page once");
		assert.ok(reads[1] !== undefined);
		await flush();
		assert.equal(firstMessage(host.frame()), firstMessage(parked), "the earlier page loads above the reader");
		host.inspector.handleInput(CTRL_HOME);
		assert.equal(firstMessage(host.frame()), "M-050");
		host.frame();
		await flush();
		host.inspector.handleInput(CTRL_HOME);
		assert.equal(firstMessage(host.frame()), "M-000");
		host.frame();
		await flush();
		assert.equal(reads.length, 3, "nothing is left to load before the first retained message");
	} finally {
		await host.dispose();
	}
});

test("a transcript read again on each change holds still while the reader is above its end and follows once they return (#4521)", async () => {
	const session = SessionManager.inMemory();
	const append = (i: number) =>
		session.appendMessage({ role: "user", content: `M-${String(i).padStart(3, "0")}`, timestamp: i });
	for (let i = 0; i < 250; i++) await append(i);
	const reads: Array<string | undefined> = [];
	let taskChanged = () => {};
	const host = await openTranscript(session, {
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				readTaskTranscript: (id: TaskId, cursor?: string) => {
					reads.push(cursor);
					return owner.readTaskTranscript(id, cursor);
				},
				subscribe: (listener: () => void) => {
					taskChanged = listener;
					return owner.subscribe(listener);
				},
			}),
	});
	const change = async (i: number) => {
		await append(i);
		taskChanged();
		await flush();
	};
	try {
		assert.match(host.text(), /M-249/);
		assert.equal(host.inspector.handleInput(PAGE_UP), true);
		const above = firstMessage(host.frame());
		const readsAbove = reads.length;
		await change(250);
		assert.equal(reads.length, readsAbove, "nothing is read again while the reader is above the end");
		assert.equal(firstMessage(host.frame()), above, "the rows the reader is looking at stay put");
		assert.doesNotMatch(host.text(), /M-250/);

		host.inspector.handleInput(CTRL_END);
		await flush();
		assert.equal(reads.length, readsAbove + 1, "returning to the end reads the latest page once");
		assert.match(host.text(), /M-250/);
		await change(251);
		assert.match(host.text(), /M-251/, "at the end each change is followed");

		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.ok(
			reads.some((cursor) => cursor !== undefined),
			"earlier history loaded near the top",
		);
		await change(252);
		host.inspector.handleInput(CTRL_END);
		await flush();
		assert.match(host.text(), /M-252/, "loading earlier history does not stop the transcript following");
		await change(253);
		assert.match(host.text(), /M-253/);
	} finally {
		await host.dispose();
	}
});

test("Home, End, Up, Down and x are composer keys in a task transcript, and x stops only from the detail page (#4521)", async () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 40; i++)
		await session.appendMessage({ role: "user", content: `M-${String(i).padStart(3, "0")}`, timestamp: i });
	const host = await openTranscript(session);
	try {
		const before = firstMessage(host.frame());
		await host.type("abc");
		for (const key of ["\x1b[A", "\x1b[B", "\x1b[F", "\x1b[H"]) assert.equal(host.inspector.handleInput(key), true);
		await host.type("x");
		assert.match(host.text(), /xabc/, "Home moved the composer cursor and x was typed");
		assert.equal(firstMessage(host.frame()), before, "Home, Up and Down did not scroll the transcript");
		assert.equal(host.fixture.runners[0].context.signal.aborted, false);
		assert.doesNotMatch(host.text(), /confirm/);
		host.inspector.handleInput("\x1b[D");
		assert.match(host.text(), /^Transcript/, "Left edits a draft rather than leaving");
		host.inspector.handleInput("\x1b");
		assert.match(host.text(), /Inspect transcript/, "Escape leaves the transcript, draft or not");
		host.inspector.handleInput("x");
		assert.match(host.text(), /confirm/, "x still stops from the detail page");
		host.inspector.handleInput("n");
	} finally {
		await host.dispose();
	}
});

test("Left with an empty composer goes back to the task's detail page (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "M-000", timestamp: 0 });
	const host = await openTranscript(session);
	try {
		assert.match(host.text(), /^Transcript/);
		host.inspector.handleInput("\x1b[D");
		assert.match(host.text(), /Inspect transcript/);
	} finally {
		await host.dispose();
	}
});

test("Ctrl+T is offered to the host, Ctrl+O toggles the inherited tool output, and both re-render (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Run the tool", timestamp: 0 });
	await session.appendMessage(
		assistant(
			[
				{ type: "thinking", thinking: "SECRET-REASONING-LINE" },
				{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "seq 1 40" } },
			],
			"toolUse",
		),
	);
	await session.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `OUTPUT-${i}`).join("\n") }],
		isError: false,
		timestamp: 2,
	});
	let hideThinkingBlock = true;
	let toolOutputExpanded = false;
	const host = await openTranscript(session, {
		height: 80,
		environment: {
			getChatRenderSettings: () => ({ hideThinkingBlock, toolOutputExpanded, hiddenThinkingLabel: "Thinking..." }),
			getToolsExpanded: () => toolOutputExpanded,
			setToolsExpanded: (expanded) => {
				toolOutputExpanded = expanded;
			},
		},
	});
	try {
		const collapsed = host.text();
		assert.doesNotMatch(collapsed, /SECRET-REASONING-LINE/, "hidden thinking shows the placeholder only");
		assert.match(collapsed, /Thinking\.\.\./);
		assert.match(collapsed, /OUTPUT-39/);
		assert.doesNotMatch(collapsed, /OUTPUT-0\b/, "collapsed tool output shows its tail preview only");
		assert.equal(host.inspector.handleInput("\x14"), false, "Ctrl+T belongs to the host's thinking toggle");
		hideThinkingBlock = false;
		assert.match(host.text(), /SECRET-REASONING-LINE/, "the transcript follows the host's thinking display");
		assert.equal(host.inspector.handleInput("\x0f"), true);
		assert.equal(toolOutputExpanded, true);
		assert.match(host.text(), /OUTPUT-0\b[\s\S]*OUTPUT-39/, "Ctrl+O expands the tool output in place");
	} finally {
		await host.dispose();
	}
});

test("where the host owns tool output, Ctrl+O is left to it and the transcript follows its setting (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Run the listing", timestamp: 0 });
	await session.appendMessage(
		assistant([{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "seq 1 40" } }], "toolUse"),
	);
	await session.appendMessage({
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `OUTPUT-${i}`).join("\n") }],
		isError: false,
		timestamp: 2,
	});
	let toolOutputExpanded = false;
	const host = await openTranscript(session, {
		height: 80,
		environment: {
			getChatRenderSettings: () => ({ hideThinkingBlock: false, toolOutputExpanded }),
			getToolsExpanded: () => toolOutputExpanded,
		},
	});
	try {
		assert.doesNotMatch(host.text(), /OUTPUT-0\b/);
		assert.equal(host.inspector.handleInput("\x0f"), false, "Ctrl+O goes to the host that owns tool output");
		assert.doesNotMatch(host.text(), /OUTPUT-0\b/, "declining does not toggle anything itself");
		toolOutputExpanded = true;
		assert.match(host.text(), /OUTPUT-0\b[\s\S]*OUTPUT-39/, "the transcript follows the host's tool output");
	} finally {
		await host.dispose();
	}
});

test("compaction boundaries, branch summaries and extension notices appear in a reopened transcript (#4521)", async () => {
	const session = SessionManager.inMemory();
	const prompt = await session.appendMessage({ role: "user", content: "Long task", timestamp: 0 });
	await session.appendCustomMessageEntry("extension-notice", "EXTENSION-NOTICE-TEXT", true);
	await session.appendCustomMessageEntry("hidden-context", "HIDDEN-CONTEXT-TEXT", false);
	await session.appendCompaction("kept line", prompt, 12_345, verbatimDetails);
	await session.branchWithSummary(prompt, "BRANCH-SUMMARY-TEXT");
	const host = await openTranscript(session, { height: 60 });
	try {
		const text = host.text();
		assert.match(text, /EXTENSION-NOTICE-TEXT/);
		assert.doesNotMatch(text, /HIDDEN-CONTEXT-TEXT/);
		assert.match(text, /Context compacted/);
		assert.match(text, /BRANCH-SUMMARY-TEXT|Branch summary/i);
	} finally {
		await host.dispose();
	}
});

test("a transcript opened mid-compaction shows the compaction status, and live events update it (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Compact soon", timestamp: 0 });
	let compacting: "threshold" | undefined = "threshold";
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const host = await openTranscript({
		getSessionId: () => session.getSessionId(),
		getEntries: () => session.getEntries(),
		getCompactionReason: () => compacting,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	});
	try {
		assert.match(host.text(), /compact/i, "the hydrated status names the running compaction");
		compacting = undefined;
		for (const listener of listeners)
			listener({
				type: "compaction_end",
				reason: "threshold",
				aborted: false,
				willRetry: false,
			} as AgentSessionEvent);
		assert.doesNotMatch(host.text(), /Compacting/i);
		for (const listener of listeners) listener({ type: "compaction_start", reason: "manual" } as AgentSessionEvent);
		assert.match(host.text(), /Compacting/i);
	} finally {
		await host.dispose();
	}
});

test("Enter sends the composer text to the task, and a refusal keeps the draft and says why (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Waiting for guidance", timestamp: 0 });
	const sent: Array<{ id: TaskId; text: string }> = [];
	let refuse = false;
	const host = await openTranscript(session, {
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				sendTaskMessage: async (id: TaskId, text: string) => {
					sent.push({ id, text });
					if (refuse) throw new TaskMessageError("delivery-refused", { taskId: id, target: "worker-1" });
				},
			}),
	});
	try {
		await host.type("please continue");
		host.inspector.handleInput("\r");
		await flush();
		assert.deepEqual(
			sent.map((message) => message.text),
			["please continue"],
		);
		assert.equal(sent[0]?.id, host.fixture.store.tasks[0]?.ref.taskId);
		assert.doesNotMatch(host.text(), /please continue/, "no optimistic copy: the task records what it receives");
		refuse = true;
		await host.type("second note");
		host.inspector.handleInput("\r");
		await flush();
		const text = host.text();
		assert.match(text, /Intercom did not deliver the message: worker-1 \(delivery-refused\)/);
		assert.match(text, /second note/, "the refused draft comes back to the composer");
	} finally {
		await host.dispose();
	}
});

test("a transcript whose source cannot message tasks is read-only (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Read only", timestamp: 0 });
	const host = await openTranscript(session, {
		source: (owner) => Object.assign(Object.create(owner) as TaskViewSource, { sendTaskMessage: undefined }),
	});
	try {
		await host.type("ignored");
		host.inspector.handleInput("\r");
		await flush();
		assert.doesNotMatch(host.text(), /Enter messages the agent/, "the footer only offers what works");
		assert.match(host.text(), /This task cannot receive messages: .* \(messages-unsupported\)/);
	} finally {
		await host.dispose();
	}
});
