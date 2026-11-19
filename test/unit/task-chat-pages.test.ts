import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import v8 from "node:v8";
import vm from "node:vm";
import { type AssistantMessage, fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import type {
	ChatRecordOwner,
	SessionChatRecords,
} from "../../packages/coding-agent/src/core/storage/session/chat-records.js";
import { LegacySessionStore } from "../../packages/coding-agent/src/core/storage/session/legacy-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { Cleanup, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import type { TaskTranscriptEnvironment } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";
import { agent } from "../helpers/released-task-launch.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});
const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const CTRL_HOME = "\x1b[1;5H";
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

/** Opens the first task's transcript from the task list, as `/tasks` → Enter → Enter does. */
async function openPage(
	transcript: TaskTranscriptSource,
	options: {
		height?: number;
		environment?: Partial<TaskTranscriptEnvironment>;
		/** Earlier pages wait for this, so the latest page can be seen alone. */
		earlier?: Promise<void>;
	} = {},
) {
	initTheme("dark");
	const height = options.height ?? 300;
	const previous = getKeybindings();
	const keys = new KeybindingsManager();
	setKeybindings(keys);
	const fixture = taskFixture();
	const environment = taskTranscriptEnvironment({
		tui: makeTestTui(height),
		keybindings: keys,
		...options.environment,
	});
	const owner = ownerTaskViewSource(fixture.store);
	const earlier = options.earlier;
	const source: TaskViewSource = earlier
		? Object.assign(Object.create(owner) as TaskViewSource, {
				async readTaskTranscript(id: TaskId, cursor?: string) {
					if (cursor) await earlier;
					return owner.readTaskTranscript(id, cursor);
				},
			})
		: owner;
	const inspector = new TaskInspector(
		source,
		() => {},
		() => {},
		undefined,
		() => environment,
	);
	await fixture.start("Inspect");
	fixture.runners[0].context.bindTranscript(transcript);
	inspector.handleInput(" ");
	inspector.handleInput("\r");
	await flush();
	inspector.handleInput("\r");
	await flush();
	const frame = () =>
		inspector
			.renderViewport(100, height)
			.map((line) => stripVTControlCharacters(line.replace(APPLICATION_COMMAND, "")).trim())
			.filter(Boolean);
	let disposed = false;
	const page = {
		frame,
		/** Paints, lets the reads the paint started settle, and paints again. */
		async lines() {
			for (let i = 0; i < 3; i++) {
				frame();
				await flush();
			}
			return frame();
		},
		async home() {
			inspector.handleInput(CTRL_HOME);
			for (let i = 0; i < 4; i++) {
				frame();
				await flush();
			}
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			inspector.dispose();
			await fixture.dispose();
			setKeybindings(previous);
		},
	};
	cleanups.push(() => page.dispose());
	return page;
}

/** The given texts in the order the page shows them, one per row that contains one. */
const order = (lines: readonly string[], texts: readonly string[]) =>
	lines.flatMap((line) => texts.filter((text) => line.includes(text)));

async function sqlChat() {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = await SqlSessionStore.open(db);
	cleanups.push(async () => {
		await store.close();
		await db.close();
	});
	const manager = await SessionManager.create(store, process.cwd());
	const scope = manager.chatRecordScope();
	assert.ok(scope);
	return { manager, scope };
}
const line = (text: string) => ({ kind: "line" as const, level: "error" as const, text });
/** A child whose session is in this process and has no live events, as a task source binds it. */
const childOf = (manager: SessionManager, members: Partial<TaskTranscriptSource> = {}): TaskTranscriptSource => ({
	getSessionId: () => manager.getSessionId(),
	getEntries: () => manager.getEntries(),
	chatSession: { sessionManager: manager } as never,
	...members,
});

test("a finished subagent's page on the default store draws the saved line of the snapshot it read (#5649)", async () => {
	const root = makeTempDirectory("task-chat-default-store-");
	cleanups.push(() => removeTempDirectory(root));
	const db = await openNodeSqliteDatabase(join(root, "sessions.db"));
	const store = new LegacySessionStore(await SqlSessionStore.open(db), {
		legacyDirectory: join(root, "sessions"),
		databasePath: join(root, "sessions.db"),
	});
	cleanups.push(async () => {
		clearSubagentControls();
		await store.close();
		await db.close();
	});
	const manager = await SessionManager.create(store, root);
	let finished: TaskTranscriptSource | undefined;
	let cleanup: Promise<Cleanup> | undefined;
	await runSingleInProcess(root, agent, "read the file", {
		cwd: root,
		sessionDir: root,
		runId: "default-store-page",
		sessionManager: manager,
		resumeSession: true,
		testSession: { output: "done" },
		taskExecution: {
			signal: new AbortController().signal,
			reportActivity() {},
			bindTranscript(source) {
				finished = source;
			},
			onExecution(run) {
				cleanup = run.cleanup;
			},
		},
	});
	await cleanup;
	assert.ok(finished?.loadHistory);
	assert.equal(finished.chatSession, undefined, "a finished child keeps no live session");
	const saved = await SessionManager.open(store, manager.getSessionId());
	const scope = saved.chatRecordScope();
	assert.ok(scope);
	await scope.store.append(scope.owner, saved.getLeafId()!, line("Error: Retry failed after 1 attempts: outage"));
	const page = await openPage(finished);
	assert.deepEqual(order(await page.lines(), ["read the file", "done", "Retry failed"]), [
		"read the file",
		"done",
		"Retry failed",
	]);
});

test("a subagent page draws each saved line after the row its source entry ends on, including tool and hidden entries (#5649)", async () => {
	const { manager, scope } = await sqlChat();
	const prompt = await manager.appendMessage({ role: "user", content: "PROMPT-ONE", timestamp: 1 });
	const call = await manager.appendMessage(
		assistant([{ type: "toolCall", id: "t1", name: "read", arguments: { path: "x" } }], "toolUse"),
	);
	const result = await manager.appendMessage({
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text: "RESULT" }],
		isError: false,
		timestamp: 2,
	});
	// A fallback model switch is the branch position when its retry gives up; the page never shows that entry.
	const fallback = await manager.appendModelChange("openai", "fallback");
	const reply = await manager.appendMessage(assistant([{ type: "text", text: "REPLY-TWO" }]));
	for (const [anchor, text] of [
		[prompt, "AT-PROMPT"],
		[call, "AT-CALL"],
		[result, "AT-RESULT"],
		[fallback, "AT-FALLBACK"],
		[reply, "AT-REPLY"],
	] as const)
		await scope.store.append(scope.owner, anchor, line(`Error: ${text}`));
	const page = await openPage(childOf(manager));
	const texts = ["PROMPT-ONE", "AT-PROMPT", "Read(x)", "AT-CALL", "AT-RESULT", "AT-FALLBACK", "REPLY-TWO", "AT-REPLY"];
	assert.deepEqual(order(await page.lines(), texts), texts);
});

test("a long reply split across three task pages draws its saved line once, after its last block (#5649)", async () => {
	const { manager, scope } = await sqlChat();
	await manager.appendMessage({ role: "user", content: "LONG-PROMPT", timestamp: 1 });
	const reply = await manager.appendMessage(
		assistant(
			Array.from({ length: 230 }, (_, i) => ({ type: "text" as const, text: `part-${String(i).padStart(3, "0")}` })),
		),
	);
	await scope.store.append(scope.owner, reply, line("Error: AFTER-LONG-REPLY"));
	const page = await openPage(childOf(manager), { height: 600 });
	assert.deepEqual(order(await page.lines(), ["part-229", "AFTER-LONG-REPLY"]), ["part-229", "AFTER-LONG-REPLY"]);
	await page.home();
	const lines = await page.lines();
	assert.deepEqual(order(lines, ["LONG-PROMPT", "part-000", "part-229", "AFTER-LONG-REPLY"]), [
		"LONG-PROMPT",
		"part-000",
		"part-229",
		"AFTER-LONG-REPLY",
	]);
});

/** Notices shown while their prompt's write was pending are stored before it; the edge restores the shown order. */
async function overtaken(fillers: number, notices: number, tail: number) {
	const { manager, scope } = await sqlChat();
	for (let i = 0; i < fillers; i++)
		await manager.appendMessage({ role: "user", content: `F-${String(i).padStart(3, "0")}`, timestamp: i });
	const ids: string[] = [];
	for (let i = 0; i < notices; i++)
		ids.push(
			await manager.appendCustomMessageEntry("note", `NOTICE-${String(i).padStart(3, "0")}`, true, undefined, true),
		);
	const prompt = await manager.appendMessage({ role: "user", content: "THE-PROMPT", timestamp: 1 });
	for (let i = 0; i < tail; i++)
		await manager.appendMessage({ role: "user", content: `T-${String(i).padStart(3, "0")}`, timestamp: i });
	await scope.store.append(scope.owner, ids[0]!, { kind: "promptBefore", promptId: prompt });
	return { manager, scope, prompt, first: ids[0]! };
}

test("a prompt that starts the latest task page moves above the overtaking notices ending the earlier page (#5649)", async () => {
	// 10 fillers and 2 notices fill the earlier page; the prompt and 99 later rows fill the latest page.
	const { manager } = await overtaken(10, 2, 99);
	const earlier = Promise.withResolvers<void>();
	const page = await openPage(childOf(manager), { height: 600, earlier: earlier.promise });
	const texts = ["F-009", "NOTICE-000", "NOTICE-001", "THE-PROMPT", "T-000"];
	assert.deepEqual(order(await page.lines(), texts), ["THE-PROMPT", "T-000"]);
	earlier.resolve();
	assert.deepEqual(order(await page.lines(), texts), ["F-009", "THE-PROMPT", "NOTICE-000", "NOTICE-001", "T-000"]);
});

/** The store's prompt-order index, as the metadata-only reverse lookup reads it. */
function withOrderIndex(store: SessionChatRecords, edges: Map<string, string>, asked: string[][]): SessionChatRecords {
	return {
		has: (owner) => store.has(owner),
		read: (owner, anchors) => store.read(owner, anchors),
		append: (owner, anchor, record) => store.append(owner, anchor, record),
		async readOrders(_owner: ChatRecordOwner, prompts: readonly string[]) {
			asked.push([...prompts]);
			return prompts.flatMap((promptId) => {
				const anchor = edges.get(promptId);
				return anchor ? [{ anchor, promptId }] : [];
			});
		},
	} as SessionChatRecords;
}

test("the latest task page alone shows a prompt above the visible part of a run that began on the earlier page (#5649)", async () => {
	// 150 notices: the first 51 are on the earlier page, the last 99 and the prompt fill the latest one.
	const { manager, scope, prompt, first } = await overtaken(0, 150, 0);
	const asked: string[][] = [];
	const indexed = { store: withOrderIndex(scope.store, new Map([[prompt, first]]), asked), owner: scope.owner };
	const earlier = Promise.withResolvers<void>();
	const page = await openPage(
		childOf(manager, { chatSession: { sessionManager: { chatRecordScope: () => indexed } } as never }),
		{ height: 1000, earlier: earlier.promise },
	);
	const texts = ["NOTICE-000", "NOTICE-050", "NOTICE-051", "NOTICE-149", "THE-PROMPT"];
	assert.deepEqual(order(await page.lines(), texts), ["THE-PROMPT", "NOTICE-051", "NOTICE-149"]);
	assert.deepEqual(asked, [[prompt]], "one metadata lookup, for the shown prompt only");
	earlier.resolve();
	assert.deepEqual(order(await page.lines(), texts), [
		"THE-PROMPT",
		"NOTICE-000",
		"NOTICE-050",
		"NOTICE-051",
		"NOTICE-149",
	]);
});

test.each(["absent", "refused", "unreadable"] as const)(
	"a subagent page whose chat records are %s shows its transcript and asks the store once (#5649)",
	async (kind) => {
		const manager = SessionManager.inMemory();
		for (let i = 0; i < 150; i++)
			await manager.appendMessage({ role: "user", content: `M-${String(i).padStart(3, "0")}`, timestamp: i });
		const calls = { has: 0, read: 0 };
		const store: SessionChatRecords = {
			has(): Promise<boolean> {
				calls.has++;
				if (kind === "refused") throw new Error("chat records refused");
				return Promise.resolve(kind !== "absent");
			},
			read: async () => {
				calls.read++;
				throw new Error("chat records unreadable");
			},
			append: async () => {},
		};
		const owner = { id: manager.getSessionId(), epoch: "epoch" };
		const page = await openPage(
			childOf(manager, { chatSession: { sessionManager: { chatRecordScope: () => ({ store, owner }) } } as never }),
			{ height: 40 },
		);
		assert.ok((await page.lines()).some((text) => text.includes("M-149")));
		await page.home();
		assert.ok((await page.lines()).some((text) => text.includes("M-000")));
		assert.equal(calls.has, 1);
		if (kind !== "unreadable") assert.equal(calls.read, 0);
	},
);

test("a saved line read after a live reply arrived stays with its own row, above the new reply (#5649)", async () => {
	const db = await openNodeSqliteDatabase(":memory:");
	const store = await SqlSessionStore.open(db);
	const records = store.chatRecords;
	const gate = Promise.withResolvers<void>();
	// Only the reader waits; the session's own writes are untouched.
	Object.defineProperty(store, "chatRecords", {
		value: {
			has: (owner: ChatRecordOwner) => records.has(owner),
			read: async (owner: ChatRecordOwner, anchors: readonly string[]) => {
				await gate.promise;
				return records.read(owner, anchors);
			},
			append: records.append.bind(records),
		} satisfies SessionChatRecords,
	});
	const harness = await createHarness({ sessionManager: await SessionManager.create(store, process.cwd()) });
	cleanups.push(async () => {
		gate.resolve();
		await harness.cleanup();
		await store.close();
		await db.close();
	});
	const child = harness.session;
	const prompt = await child.sessionManager.appendMessage({ role: "user", content: "FIRST-PROMPT", timestamp: 1 });
	const scope = child.sessionManager.chatRecordScope();
	assert.ok(scope);
	await records.append(scope.owner, prompt, line("Error: SAVED-AT-PROMPT"));
	const page = await openPage({
		getSessionId: () => child.sessionId,
		getEntries: () => child.sessionManager.getEntries(),
		chatSession: child,
		subscribe: (listener) => child.subscribe(listener),
	});
	await page.lines();
	harness.setResponses([fauxAssistantMessage("LIVE-REPLY")]);
	await child.prompt("SECOND-PROMPT");
	const texts = ["FIRST-PROMPT", "SAVED-AT-PROMPT", "SECOND-PROMPT", "LIVE-REPLY"];
	assert.deepEqual(order(await page.lines(), texts), ["FIRST-PROMPT", "SECOND-PROMPT", "LIVE-REPLY"]);
	gate.resolve();
	assert.deepEqual(order(await page.lines(), texts), texts);
});

function collectGarbage(): void {
	v8.setFlagsFromString("--expose-gc");
	try {
		const gc = vm.runInNewContext("gc") as () => void;
		for (let round = 0; round < 3; round++) gc();
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

test("a closed subagent page is not kept by a chat-record read its store never answers (#5649)", async () => {
	const manager = SessionManager.inMemory();
	await manager.appendMessage({ role: "user", content: "ONLY-PROMPT", timestamp: 1 });
	const unanswered: unknown[] = [];
	const store: SessionChatRecords = {
		has: async () => true,
		read: () => {
			const read = Promise.withResolvers<never>();
			unanswered.push(read);
			return read.promise;
		},
		append: async () => {},
	};
	const owner = { id: manager.getSessionId(), epoch: "epoch" };
	let chat: WeakRef<ChatSessionHost> | undefined;
	const page = await openPage(
		childOf(manager, { chatSession: { sessionManager: { chatRecordScope: () => ({ store, owner }) } } as never }),
		{
			height: 40,
			environment: {
				createChat(opts) {
					const host = new ChatSessionHost(opts);
					chat = new WeakRef(host);
					return host;
				},
			},
		},
	);
	assert.ok((await page.lines()).some((text) => text.includes("ONLY-PROMPT")));
	assert.equal(unanswered.length, 1, "the shown row asked for its records");
	await page.dispose();
	await flush();
	collectGarbage();
	assert.equal(chat?.deref(), undefined, "the pending read holds no reference to the closed chat");
	assert.equal(unanswered.length, 1);
});
