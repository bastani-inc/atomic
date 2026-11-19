import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, renameSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { test } from "vitest";
import type { AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import {
	VERBATIM_COMPACTION_PROMPT_VERSION,
	type VerbatimCompactionDetails,
} from "../../packages/coding-agent/src/core/compaction/compaction-types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import {
	TASK_COMPLETION_MESSAGE_TYPE,
	type TaskCompletionEnvelope,
	taskCompletionNotice,
} from "../../packages/coding-agent/src/core/tasks/completion.js";
import type { Cleanup, TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	chatEntriesFromAgentMessages,
	renderChatMessageEntry,
} from "../../packages/coding-agent/src/modes/interactive/components/chat-message-renderer.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import type { TaskTranscriptEnvironment } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.ts";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.ts";

import { countingDatabase } from "../helpers/counting-database.js";
import { agent } from "../helpers/released-task-launch.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";
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
	parameters: { query: "test" },
	stats: {
		linesBefore: 2,
		linesDeleted: 1,
		linesKept: 1,
		rangeCount: 1,
		tokensBefore: 100,
		tokensAfter: 50,
		percentReduction: 50,
	},
	form: "cleared",
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
	inspector.handleInput(" ");
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

test("PageUp is a plain scroll and earlier history loads near the top under the reader, and one Ctrl+Home reaches the first message (#4521)", async () => {
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

		for (let i = 0; i < 40 && reads.length === 1; i++) {
			host.inspector.handleInput("\x1b[5~");
			host.frame();
		}
		const parked = host.frame();
		host.frame();
		assert.equal(reads.length, 2, "nearing the top asks for the earlier page once");
		assert.ok(reads[1] !== undefined);
		await flush();
		assert.equal(firstMessage(host.frame()), firstMessage(parked), "the earlier page loads above the reader");

		host.inspector.handleInput(CTRL_HOME);
		for (let i = 0; i < 5; i++) {
			host.frame();
			await flush();
		}
		assert.equal(firstMessage(host.frame()), "M-000", "one Ctrl+Home reaches the first retained message");
		assert.equal(reads.length, 3, "nothing is left to load before the first retained message");
	} finally {
		await host.dispose();
	}
});

test("paging a long failed reply in the local transcript shows its error only after the last block (#5651)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		...assistant(
			Array.from({ length: 101 }, (_, i) => ({ type: "text", text: `part-${String(i).padStart(3, "0")}` })),
			"error",
		),
		errorMessage: "request failed here",
	});
	const host = await openTranscript(session, { height: 480 });
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		const body = host.text();
		assert.match(body, /part-000[\s\S]*part-100[\s\S]*request failed here/);
		assert.equal(body.split("request failed here").length - 1, 1);
	} finally {
		await host.dispose();
	}
});

test("paging back to an unfinished read keeps its failure even when the reply ends on the next page (#5651)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		...assistant(
			[
				{ type: "toolCall", id: "read-first", name: "read", arguments: { path: "unfinished-file" } },
				...Array.from({ length: 101 }, (_, i) => ({ type: "text" as const, text: `part-${i}` })),
			],
			"error",
		),
		errorMessage: "provider stopped the read",
	});
	const host = await openTranscript(session, { height: 480 });
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		const body = host.text();
		assert.match(body, /✗ Read\(unfinished-file\) · failed\s+⎿\s+provider stopped the read/);
		assert.match(body, /part-100[\s\S]*Error: provider stopped the read/);
	} finally {
		await host.dispose();
	}
});

test("when a source repeats a row, only the reply split by the page loses its earlier notice (#5651)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ ...assistant([], "error"), errorMessage: "short error" });
	await session.appendMessage({
		...assistant(
			Array.from({ length: 101 }, () => ({ type: "text" as const, text: "long reply" })),
			"error",
		),
		errorMessage: "long error",
	});
	const [short, long] = session.getEntries();
	const host = await openTranscript(
		{ getSessionId: () => session.getSessionId(), getEntries: () => [short, long, short] },
		{ height: 480 },
	);
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.equal(host.text().match(/Error: short error/g)?.length, 2);
		assert.equal(host.text().match(/Error: long error/g)?.length, 1);
	} finally {
		await host.dispose();
	}
});

test("a tool on the final page doesn't erase the only standalone provider error on the previous page (#5651)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		...assistant(
			[
				...Array.from({ length: 101 }, (_, i) => ({ type: "text" as const, text: `part-${i}` })),
				{ type: "toolCall", id: "last", name: "read", arguments: { path: "last-file" } },
			],
			"error",
		),
		errorMessage: "provider stopped",
	});
	const host = await openTranscript(session, { height: 480 });
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.equal(host.text().match(/Error: provider stopped/g)?.length, 1);
		assert.match(host.text(), /✗ Read\(last-file\) · failed/);
	} finally {
		await host.dispose();
	}
});

test("rendering a page fragment independently keeps the error its task view already showed (#5651)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({
		...assistant(
			Array.from({ length: 101 }, () => ({ type: "text", text: "row" })),
			"error",
		),
		errorMessage: "provider outage",
	});
	let earlier: AssistantMessage | undefined;
	let mounted: ChatSessionHost | undefined;
	const host = await openTranscript(session, {
		height: 480,
		environment: {
			createChat(opts) {
				mounted = new ChatSessionHost(opts);
				return mounted;
			},
		},
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				async readTaskTranscript(id: TaskId, cursor?: string) {
					const page = await owner.readTaskTranscript(id, cursor);
					if (cursor && page.ok) earlier = page.value.messages.find((m) => m.role === "assistant");
					return page;
				},
			}),
	});
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.ok(earlier);
		Object.defineProperty(earlier, "diagnostics", {
			enumerable: true,
			get() {
				throw new Error("unrequested diagnostics");
			},
		});
		host.inspector.invalidate();
		assert.equal(host.text().match(/Error: provider outage/g)?.length, 1);
		const [entry] = chatEntriesFromAgentMessages([earlier]);
		assert.match(
			renderChatMessageEntry(entry, { ui: { requestRender() {} }, cwd: process.cwd() })
				.render(80)
				.join("\n"),
			/Error: provider outage/,
		);
		assert.ok(mounted);
		mounted.replaceMessages([earlier]);
		assert.match(host.text(), /Error: provider outage/, "replacing the mounted rows removes the later witness");
	} finally {
		await host.dispose();
	}
});

test("repainting a split reply restores the earlier failure when the later block becomes a tool (#5651)", async () => {
	const session = SessionManager.inMemory();
	const reply = {
		...assistant(
			Array.from({ length: 101 }, (_, i) => ({ type: "text" as const, text: `part-${i}` })),
			"error",
		),
		errorMessage: "provider outage",
	};
	await session.appendMessage(reply);
	const host = await openTranscript(session, { height: 480 });
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		Object.assign(reply.content[99], { type: "toolCall", id: "read", name: "read", arguments: { path: "file" } });
		host.inspector.invalidate();
		assert.match(host.text(), /part-0\s+Error: provider outage[\s\S]*part-100/);
	} finally {
		await host.dispose();
	}
});

function rewriteSavedReply(file: string, rename: boolean): void {
	execFileSync(process.execPath, [
		"-e",
		`const fs = require('node:fs');
		const [file, target] = process.argv.slice(1);
		fs.writeFileSync(target, fs.readFileSync(file, 'utf8').replaceAll('original-', 'restored-'));
		if (target !== file) fs.renameSync(target, file);`,
		file,
		rename ? `${file}.new` : file,
	]);
}

const savedHistoryCases = [
	"file",
	"replaced file",
	"file replaced with identical bytes",
	"file rewritten in place",
	"file rewritten during projection",
	"file replaced during projection",
	"memory",
	"sqlite",
] as const;

test.each(savedHistoryCases)(
	"paging a settled child's %s history keeps failures attributed to its record (#5651)",
	async (backend) => {
		const duringRead =
			backend === "file rewritten during projection" || backend === "file replaced during projection";
		const replace = duringRead || backend === "replaced file" || backend === "file rewritten in place";
		const rename = backend === "replaced file" || backend === "file replaced during projection";
		const root = makeTempDirectory("task-chat-archive-");
		const gate = Promise.withResolvers<void>();
		let host: Awaited<ReturnType<typeof openTranscript>> | undefined;
		const database = backend === "sqlite" ? countingDatabase(await openNodeSqliteDatabase(":memory:")) : undefined;
		const shared = database
			? await SqlSessionStore.open(database.wrapped)
			: backend === "memory"
				? new MemorySessionStore()
				: undefined;
		try {
			const manager = shared && (await SessionManager.create(shared, root));
			let retained: TaskTranscriptSource | undefined;
			let cleanup: Promise<Cleanup> | undefined;
			const child = await runSingleInProcess(root, agent, "read the file", {
				cwd: root,
				sessionDir: root,
				runId: "paged-archive",
				...(manager && { sessionManager: manager, resumeSession: true }),
				testSession: { output: "done" },
				taskExecution: {
					signal: new AbortController().signal,
					reportActivity() {},
					bindTranscript(source) {
						retained = source;
					},
					onExecution(run) {
						cleanup = run.cleanup;
					},
				},
			});
			await cleanup;
			assert.ok(retained?.loadHistory);
			assert.ok(manager || child.sessionFile);
			const saved =
				shared && manager
					? await SessionManager.open(shared, manager.getSessionId())
					: await SessionManager.open(child.sessionFile!);
			try {
				await saved.appendMessage({
					...assistant(
						Array.from({ length: 101 }, (_, i) => ({ type: "text", text: `original-${i}` })),
						"error",
					),
					errorMessage: "provider outage",
				});
				const snapshot = await saved.getSessionStore().load(saved.getSessionId());
				assert.deepEqual(Reflect.ownKeys(snapshot).sort(), ["entries", "header", "lastSeq"]);
			} finally {
				if (!shared) await saved.getSessionStore().close();
			}
			let loadReads = 0;
			if (shared) {
				const load = shared.load;
				Object.defineProperty(shared, "load", {
					configurable: true,
					get() {
						++loadReads;
						return load;
					},
				});
			}
			const calls: (string | undefined)[] = [];
			const storeReads: number[] = [];
			const queries: number[] = [];
			const first = Promise.withResolvers<void>();
			const earlier = Promise.withResolvers<void>();
			const transcript = retained;
			host = await openTranscript(transcript, {
				height: 40,
				source: (owner) =>
					Object.assign(Object.create(owner) as TaskViewSource, {
						async readTaskTranscript(id: TaskId, cursor?: string) {
							if (cursor) await gate.promise;
							if (!cursor && duringRead) {
								// The page asks for its session ID after capturing the stored entries.
								const getId = transcript.getSessionId.bind(transcript);
								transcript.getSessionId = () => {
									transcript.getSessionId = getId;
									rewriteSavedReply(child.sessionFile!, rename);
									return getId();
								};
							}
							calls.push(cursor);
							const before = database?.statements.length ?? 0;
							const beforeLoads = loadReads;
							try {
								return await owner.readTaskTranscript(id, cursor);
							} finally {
								if (shared) storeReads.push(loadReads - beforeLoads);
								if (database) queries.push(database.statements.length - before);
								(cursor ? earlier : first).resolve();
							}
						},
					}),
			});
			await first.promise;
			await flush();
			assert.match(host.text(), /original-100/);
			host.inspector.handleInput(CTRL_HOME);
			host.frame();
			if (replace && !duringRead) rewriteSavedReply(child.sessionFile!, rename);
			if (backend === "file replaced with identical bytes") {
				const file = child.sessionFile!;
				copyFileSync(file, `${file}.new`);
				renameSync(`${file}.new`, file);
			}
			gate.resolve();
			await earlier.promise;
			await flush();
			const body = host.frame(80, 480).join("\n");
			assert.match(
				body,
				replace
					? /restored-0\s+Error: provider outage[\s\S]*original-100\s+Error: provider outage/
					: /original-0[\s\S]*original-100\s+Error: provider outage/,
			);
			assert.deepEqual(
				calls.map((cursor) => cursor !== undefined),
				[false, true],
			);
			if (shared) assert.deepEqual(storeReads, [1, 1], "one store load per page");
			if (database) assert.deepEqual(queries, [3, 3], "the header, entries batch and chunked answer per page");
			assert.equal(body.match(/Error: provider outage/g)?.length, replace ? 2 : 1);
		} finally {
			gate.resolve();
			await host?.dispose();
			await shared?.close();
			await database?.wrapped.close();
			clearSubagentControls();
			removeTempDirectory(root);
		}
	},
);

test("a draft snapshot's text never stands in for the settled reply's tool card (#5651)", async () => {
	const session = SessionManager.inMemory();
	const texts = Array.from({ length: 101 }, (_, i) => ({ type: "text" as const, text: `part-${i}` }));
	await session.appendMessage(assistant(texts));
	const [draft] = session.getEntries();
	const settled = {
		...assistant(
			texts.map((part, i) => (i === 1 ? { type: "toolCall", name: "read", id: "call", arguments: {} } : part)),
			"error",
		),
		errorMessage: "provider outage",
	};
	const host = await openTranscript(
		{
			getSessionId: () => session.getSessionId(),
			getEntries: () => [draft, { ...draft, type: "message", message: settled }],
		},
		{
			height: 650,
			environment: {
				getChatRenderSettings: () => ({
					createToolComponent: (entry) => ({
						render: () => [entry.result?.isError ? "Compact failed read" : "Pending"],
						invalidate() {},
					}),
				}),
			},
		},
	);
	try {
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.match(host.text(), /Error: provider outage[\s\S]*Compact failed read/);
	} finally {
		await host.dispose();
	}
});

test("a provider error updated between page reads is not a repeated notice (#5651)", async () => {
	const session = SessionManager.inMemory();
	const reply = {
		...assistant(
			Array.from({ length: 101 }, () => ({ type: "text" as const, text: "row" })),
			"error",
		),
		errorMessage: "initial failure",
	};
	await session.appendMessage(reply);
	const host = await openTranscript(session, { height: 480 });
	try {
		assert.match(host.text(), /Error: initial failure/);
		reply.errorMessage = "updated failure";
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.match(host.text(), /Error: updated failure[\s\S]*Error: initial failure/);
	} finally {
		await host.dispose();
	}
});

test("paging back still works with a source that accepts only its existing page fields (#5651)", async () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 101; i++)
		await session.appendMessage({ role: "user", content: `M-${String(i).padStart(3, "0")}`, timestamp: i });
	const host = await openTranscript(session, {
		source: (source) =>
			Object.assign(Object.create(source) as TaskViewSource, {
				async readTaskTranscript(id: TaskId, cursor?: string) {
					const page = await source.readTaskTranscript(id, cursor);
					if (!page.ok) return page;
					const guarded = Proxy.revocable(
						{ ...page.value, nextCursor: page.value.nextCursor },
						{
							getOwnPropertyDescriptor(target, key) {
								if (!Reflect.has(target, key)) {
									guarded.revoke();
									throw new Error(`Unknown page field: ${String(key)}`);
								}
								return Reflect.getOwnPropertyDescriptor(target, key);
							},
						},
					);
					return { ok: true, value: guarded.proxy };
				},
			}),
	});
	try {
		assert.match(host.text(), /M-100/);
		host.inspector.handleInput(CTRL_HOME);
		host.frame();
		await flush();
		assert.equal(firstMessage(host.frame()), "M-000");
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
	const taskListeners = new Set<() => void>();
	const taskChanged = () => {
		for (const listener of taskListeners) listener();
	};
	const host = await openTranscript(session, {
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				readTaskTranscript: (id: TaskId, cursor?: string) => {
					reads.push(cursor);
					return owner.readTaskTranscript(id, cursor);
				},
				subscribe: (listener: () => void) => {
					taskListeners.add(listener);
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

test("a re-read that answers after the reader moved above the end leaves their rows until they return (#4521)", async () => {
	const session = SessionManager.inMemory();
	for (let i = 0; i < 250; i++)
		await session.appendMessage({ role: "user", content: `M-${String(i).padStart(3, "0")}`, timestamp: i });
	let slow: PromiseWithResolvers<void> | undefined;
	const taskListeners = new Set<() => void>();
	const taskChanged = () => {
		for (const listener of taskListeners) listener();
	};
	const host = await openTranscript(session, {
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				readTaskTranscript: async (id: TaskId, cursor?: string) => {
					const read = owner.readTaskTranscript(id, cursor);
					await slow?.promise;
					return read;
				},
				subscribe: (listener: () => void) => {
					taskListeners.add(listener);
					return owner.subscribe(listener);
				},
			}),
	});
	try {
		assert.match(host.text(), /M-249/);
		await session.appendMessage({ role: "user", content: "M-250", timestamp: 250 });
		slow = Promise.withResolvers<void>();
		taskChanged();
		host.inspector.handleInput(PAGE_UP);
		const above = firstMessage(host.frame());
		slow.resolve();
		await flush();
		assert.equal(firstMessage(host.frame()), above, "the answer does not move the rows under the reader");
		assert.doesNotMatch(host.text(), /M-250/);
		slow = undefined;
		host.inspector.handleInput(CTRL_END);
		await flush();
		assert.match(host.text(), /M-250/, "returning to the end reads the latest page");
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
		assert.match(host.text(), /^Transcript/, "Escape never leaves a task's chat (#5224)");
		host.inspector.handleInput("\x1b[F");
		host.inspector.handleInput("\x15");
		host.inspector.handleInput("\x1b[D");
		assert.match(host.text(), /Inspect transcript/, "Left on an empty prompt goes back one level");
		host.inspector.handleInput("x");
		assert.match(host.text(), /again within 3s to stop/, "x still stops from the detail page");
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

test("a transcript that cannot set tool output follows its environment's, and Ctrl+O changes nothing there (#4521)", async () => {
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
		assert.equal(host.inspector.handleInput("\x0f"), true, "Ctrl+O stays on the task page");
		assert.doesNotMatch(host.text(), /OUTPUT-0\b/, "and toggles nothing");
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
		assert.match(text, /⚛ Context cleared · 12.3k tokens/);
		assert.match(text, /BRANCH-SUMMARY-TEXT|Branch summary/i);
	} finally {
		await host.dispose();
	}
});

test("a reopened transcript shows requests that failed or were interrupted before any content, as the main chat does (#5529)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Fix the picker", timestamp: 0 });
	await session.appendMessage({
		...assistant([], "error"),
		errorMessage: "529 overloaded_error: Overloaded",
	});
	await session.appendMessage({ role: "user", content: "Try again", timestamp: 2 });
	await session.appendMessage(assistant([], "aborted"));
	const host = await openTranscript(session, { height: 40 });
	try {
		const text = host.text();
		assert.match(
			text,
			/Fix the picker[\s\S]*Error: 529 overloaded_error: Overloaded[\s\S]*Try again[\s\S]*Interrupted/,
		);
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

test("a refused message comes back above what the reader typed while it was on its way (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Waiting for guidance", timestamp: 0 });
	const answer = Promise.withResolvers<void>();
	const host = await openTranscript(session, {
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				sendTaskMessage: () => answer.promise,
			}),
	});
	try {
		await host.type("first note");
		host.inspector.handleInput("\r");
		await flush();
		await host.type("next idea");
		answer.reject(new TaskMessageError("delivery-refused", { taskId: "task" as TaskId, target: "worker-1" }));
		await flush();
		const text = host.text();
		assert.match(text, /first note/, "the refused text is not lost");
		assert.match(text, /next idea/, "what the reader typed meanwhile stays");
		assert.ok(text.indexOf("first note") < text.indexOf("next idea"));
	} finally {
		await host.dispose();
	}
});

test("a message that fails after the reader left its transcript is shown on the task pages and comes back on reopening (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Waiting for guidance", timestamp: 0 });
	const answer = Promise.withResolvers<void>();
	const notices: string[] = [];
	const host = await openTranscript(session, {
		environment: { notify: (message) => notices.push(message) },
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				sendTaskMessage: () => answer.promise,
			}),
	});
	try {
		await host.type("late note");
		host.inspector.handleInput("\r");
		await flush();
		host.inspector.handleInput("\x1b[D");
		assert.match(host.text(), /Inspect transcript/, "the reader left for the task's detail page");
		answer.reject(new TaskMessageError("delivery-refused", { taskId: "task" as TaskId, target: "worker-1" }));
		await flush();
		assert.match(host.text(), /Intercom did not deliver the message: worker-1 \(delivery-refused\)/);
		assert.deepEqual(notices, [], "the open task pages show it, so the host is not told as well");
		host.inspector.handleInput("\r");
		await flush();
		const reopened = host.text();
		assert.match(reopened, /late note/, "the text is back in the transcript's prompt");
		assert.match(reopened, /Intercom did not deliver the message/);
		host.inspector.handleInput("\x1b[F");
		host.inspector.handleInput("\x15");
		host.inspector.handleInput("\x1b[D");
		host.inspector.handleInput("\r");
		await flush();
		assert.doesNotMatch(host.text(), /late note/, "it comes back once");
	} finally {
		await host.dispose();
	}
});

test("a message that fails after the task pages closed is reported through the host, once (#4521)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Waiting for guidance", timestamp: 0 });
	const answer = Promise.withResolvers<void>();
	const notices: string[] = [];
	const host = await openTranscript(session, {
		environment: { notify: (message) => notices.push(message) },
		source: (owner) =>
			Object.assign(Object.create(owner) as TaskViewSource, {
				sendTaskMessage: () => answer.promise,
			}),
	});
	try {
		await host.type("late note");
		host.inspector.handleInput("\r");
		await flush();
		host.inspector.dispose();
		answer.reject(new TaskMessageError("delivery-refused", { taskId: "task" as TaskId, target: "worker-1" }));
		await flush();
		assert.equal(notices.length, 1);
		assert.match(notices[0] ?? "", /Intercom did not deliver the message: worker-1 \(delivery-refused\)/);
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

test("Esc interrupts a running subagent's turn from its chat and never leaves; ← on an empty prompt returns (#5224)", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "fix the picker", timestamp: 0 });
	let running = true;
	let interrupts = 0;
	const transcript: TaskTranscriptSource = Object.assign(session, {
		subscribe: () => () => {},
		isRunning: () => running,
		async interruptTurn() {
			interrupts++;
			running = false;
		},
	});
	const host = await openTranscript(transcript);
	try {
		assert.match(host.text(), /← task · esc interrupt · pgup\/pgdn scroll · \? keys/);
		host.inspector.handleInput("\x1b");
		await flush();
		assert.equal(interrupts, 1, "Esc interrupted the subagent's current turn");
		assert.match(host.text(), /^Transcript/, "Esc never leaves the chat");
		assert.equal(host.fixture.runners[0].context.signal.aborted, false, "the subagent keeps running");
		assert.doesNotMatch(host.text(), /esc interrupt/, "an idle subagent has no turn to interrupt");
		host.inspector.handleInput("\x1b");
		assert.equal(interrupts, 1, "Esc on an idle subagent does nothing");
		await host.type("?");
		assert.match(host.text(), /keys · task chat/, "? on an empty prompt lists the chat's keys");
		host.inspector.handleInput("\x1b");
		assert.match(host.text(), /^Transcript/);
		await host.type("draft?");
		assert.match(host.text(), /draft\?/, "? after text is typed");
		host.inspector.handleInput("\x1b[D");
		assert.match(host.text(), /^Transcript/, "← with a draft edits it");
		host.inspector.handleInput("\x1b[F");
		host.inspector.handleInput("\x15");
		host.inspector.handleInput("\x1b[D");
		assert.match(host.text(), /Inspect transcript/, "← on an empty prompt goes back one level");
	} finally {
		await host.dispose();
	}
});

test("a subagent's view shows a finished task's notice with the main chat's notice line", async () => {
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Run the build in the background", timestamp: 1 });
	const envelope: TaskCompletionEnvelope = {
		completionId: "subagent-view-notice",
		ownerId: "owner-1-0" as TaskCompletionEnvelope["ownerId"],
		taskId: "task-1-0-7" as TaskId,
		terminalSequence: "3" as TaskCompletionEnvelope["terminalSequence"],
		result: { kind: "completed", output: undefined as never, exitCode: 0 },
		display: false,
	};
	const notice = taskCompletionNotice(envelope, {
		kind: "command",
		title: "npm run build",
		agentName: undefined,
		model: undefined,
		thinking: undefined,
		metrics: { elapsedMs: 42_000 },
	});
	await session.appendCustomMessageEntry(TASK_COMPLETION_MESSAGE_TYPE, "Background shell completed.", true, {
		...envelope,
		notification: notice,
	});
	const host = await openTranscript(session);
	try {
		const line = '● Background command "npm run build" completed (exit code 0) · 42s';
		assert.equal(
			host.frame().filter((row) => row.trim() === line).length,
			1,
			"the subagent's view shows the notice line",
		);
		const main = new TaskCompletionMessage(notice, false).render(80).map((row) => stripVTControlCharacters(row));
		assert.deepEqual(main, [` ${line}`], "the main chat renders the same line");
	} finally {
		await host.dispose();
	}
});
