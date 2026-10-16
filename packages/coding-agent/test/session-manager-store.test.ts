import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { parseArgs } from "../src/cli/args.ts";
import { _processAgentEvent } from "../src/core/agent-session-events.ts";
import type { AgentSessionInternalSurface } from "../src/core/agent-session-methods.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getDefaultSessionDirPath } from "../src/core/session-manager-paths.ts";
import type { SessionEntry } from "../src/core/session-manager-types.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { SessionConflictError } from "../src/core/storage/session/errors.js";
import { MemorySessionStore } from "../src/core/storage/session/memory-session-store.js";
import type { SessionRecordHeader, SessionWriteOptions } from "../src/core/storage/session/types.js";
import { createSessionManager } from "../src/main-session.ts";
import { createHarness } from "./suite/harness.ts";

class ControlledStore extends MemorySessionStore {
	entered = Promise.withResolvers<void>();
	release = Promise.withResolvers<void>();
	failure: SessionConflictError | undefined;
	blocked = false;

	override async create(header: SessionRecordHeader, entries: readonly SessionEntry[]) {
		if (this.blocked) {
			this.entered.resolve();
			await this.release.promise;
		}
		if (this.failure) throw this.failure;
		return super.create(header, entries);
	}

	override async append(id: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
		if (this.blocked) {
			this.entered.resolve();
			await this.release.promise;
		}
		if (this.failure) throw this.failure;
		return super.append(id, entries, options);
	}

	override async replace(
		id: string,
		header: SessionRecordHeader,
		entries: readonly SessionEntry[],
		options: SessionWriteOptions,
	) {
		if (this.failure) throw this.failure;
		return super.replace(id, header, entries, options);
	}
}

const message = (content: string) => ({ role: "user" as const, content, timestamp: Date.now() });

test("manager publishes the first message only after the store commits", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	await manager.appendModelChange("provider", "model");
	assert.equal((await store.readHeader(manager.getSessionId()))?.id, manager.getSessionId());
	assert.equal((await store.load(manager.getSessionId())).entries.length, 1);
	store.blocked = true;
	let settled = false;
	const pending = manager.appendMessage(message("first")).then((id) => {
		settled = true;
		return id;
	});
	await store.entered.promise;
	assert.equal(settled, false);
	assert.equal(manager.getEntries().length, 1);
	store.release.resolve();
	const id = await pending;
	assert.equal(manager.getLeafId(), id);
	assert.equal((await store.load(manager.getSessionId())).entries.length, 2);
});

test("a failed commit rejects the calling mutation unchanged and permits a later retry", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	await manager.appendMessage(message("first"));
	const before = manager.getEntries();
	const failure = new SessionConflictError(manager.getSessionId(), 1, 2);
	store.failure = failure;
	await assert.rejects(manager.appendMessage(message("failed")), (error) => error === failure);
	assert.deepEqual(manager.getEntries(), before);
	assert.equal(manager.getLeafId(), before[0].id);
	store.failure = undefined;
	const id = await manager.appendMessage(message("retry"));
	assert.equal(manager.getEntry(id)?.parentId, before[0].id);
	assert.equal((await store.load(manager.getSessionId())).entries.length, 2);
});

test("concurrent mutations preserve invocation order and branch parentage", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const root = await manager.appendMessage(message("root"));
	store.blocked = true;
	const first = manager.appendMessage(message("first"));
	await store.entered.promise;
	const branch = manager.branch(root);
	const second = manager.appendMessage(message("second"));
	store.release.resolve();
	const [firstId, , secondId] = await Promise.all([first, branch, second]);
	assert.equal(manager.getEntry(firstId)?.parentId, root);
	assert.equal(manager.getEntry(secondId)?.parentId, root);
	const reopened = await SessionManager.open(store, manager.getSessionId());
	assert.equal(reopened.getLeafId(), secondId);
	assert.deepEqual(
		reopened.getEntries().map((entry) => entry.id),
		[root, firstId, secondId],
	);
});

test("failed new-session creation preserves the active session and permits retry", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const id = manager.getSessionId();
	await manager.appendThinkingLevelChange("high");
	const setup = manager.getEntries();
	const failure = new SessionConflictError(id, 0, 1);
	store.failure = failure;
	await assert.rejects(manager.newSession(), (error) => error === failure);
	assert.equal(manager.getSessionId(), id);
	assert.deepEqual(manager.getEntries(), setup);
	store.failure = undefined;
	await manager.newSession();
	assert.notEqual(manager.getSessionId(), id);
	assert.deepEqual((await store.load(manager.getSessionId())).entries, []);
});

test("header changes and label failures publish only successful commits", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const id = await manager.appendMessage(message("root"));
	const before = manager.getHeader();
	const failure = new SessionConflictError(manager.getSessionId(), 1, 2);
	store.failure = failure;
	await assert.rejects(
		manager.markSessionInternal({ runId: "run", stageId: "stage", stageName: "name" }),
		(error) => error === failure,
	);
	assert.equal(manager.getHeader(), before);
	await assert.rejects(manager.appendLabelChange(id, "label"), (error) => error === failure);
	assert.equal(manager.getLabel(id), undefined);
	store.failure = undefined;
	await manager.markSessionInternal({ runId: "run", stageId: "stage", stageName: "name" });
	assert.equal((await store.load(manager.getSessionId())).header.internal, true);
	await manager.appendLabelChange(id, "label");
	assert.equal(manager.getLabel(id), "label");
});

test("overlapping session names and label clears retain invocation order through reopen (#3678)", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const target = await manager.appendMessage(message("target"));
	const harness = await createHarness({ sessionManager: manager });
	try {
		store.blocked = true;
		const firstName = harness.session.setSessionName("first");
		await store.entered.promise;
		const lastName = harness.session.setSessionName("last");
		const setLabel = manager.appendLabelChange(target, "temporary");
		const clearLabel = manager.appendLabelChange(target, undefined);
		assert.equal(harness.session.sessionName, undefined);
		assert.equal(manager.getLabel(target), undefined);
		store.release.resolve();
		await Promise.all([firstName, lastName, setLabel, clearLabel]);
		const reopened = await SessionManager.open(store, manager.getSessionId());
		assert.equal(harness.session.sessionName, "last");
		assert.equal(reopened.getSessionName(), "last");
		assert.equal(reopened.getLabel(target), undefined);
		assert.deepEqual(
			reopened.getEntries().map((entry) => entry.type),
			["message", "session_info", "session_info", "label", "label"],
		);
	} finally {
		store.release.resolve();
		await harness.cleanup();
		await store.close();
	}
});

test("continueRecent selects and creates sessions through the supplied store", async () => {
	const store = new MemorySessionStore();
	const initial = await SessionManager.continueRecent(store, "/project");
	assert.equal((await store.load(initial.getSessionId())).header.id, initial.getSessionId());
	await initial.appendMessage(message("recent"));
	const other = await SessionManager.create(store, "/other-project");
	await other.appendMessage(message("other project"));
	const reopened = await SessionManager.continueRecent(store, "/project");
	assert.equal(reopened.getSessionId(), initial.getSessionId());
	assert.deepEqual(reopened.getEntries(), initial.getEntries());
	assert.equal(reopened.getLeafId(), initial.getLeafId());
});

test("JSONL managers retain explicitly selected default and custom directory placement", async () => {
	const directory = await mkdtemp(join(tmpdir(), "session-manager-paths-"));
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(directory, "agent");
	try {
		const cwd = join(directory, "project");
		const explicit = join(directory, "chosen");
		for (const selected of [getDefaultSessionDirPath(cwd), explicit]) {
			const manager = await SessionManager.create(cwd, selected);
			const expected = selected;
			assert.equal(manager.getSessionDir(), expected);
			assert.equal(dirname(manager.getSessionFile()!), expected);
			await manager.appendMessage(message("persisted"));
			const header = JSON.parse(
				(await readFile(manager.getSessionFile()!, "utf8")).split("\n")[0],
			) as SessionRecordHeader;
			assert.equal(header.version, 4);
			assert.equal(header.id, manager.getSessionId());
			assert.equal(typeof header.createdAt, "string");
			const reopened = await SessionManager.open(manager.getSessionFile()!);
			assert.equal(reopened.getSessionId(), manager.getSessionId());
			assert.deepEqual(reopened.getEntries(), manager.getEntries());
			await reopened.getSessionStore().close();
			await manager.getSessionStore().close();
		}
	} finally {
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("CLI and TUI session defaults stay persistent for create, resume, and fork", async () => {
	const directory = await mkdtemp(join(tmpdir(), "session-manager-defaults-"));
	const previous = process.env.ATOMIC_CODING_AGENT_DIR;
	process.env.ATOMIC_CODING_AGENT_DIR = join(directory, "agent");
	const managers: SessionManager[] = [];
	try {
		const settings = SettingsManager.inMemory();
		const create = async (args: string[]) => {
			const manager = await createSessionManager(parseArgs(args), directory, undefined, settings);
			managers.push(manager);
			return manager;
		};
		const initial = await create([]);
		assert.equal(initial.isPersisted(), true);
		assert.deepEqual(initial.getSessionStore().descriptor, {
			adapter: "node-sqlite",
			location: join(directory, "workflows", "journal.sqlite"),
		});
		assert.equal((await initial.getSessionStore().load(initial.getSessionId())).header.version, 4);
		await initial.appendMessage(message("default session"));
		const resumed = await create(["--continue"]);
		assert.equal(resumed.isPersisted(), true);
		assert.equal(resumed.getSessionId(), initial.getSessionId());
		const selected = await create(["--session", initial.getSessionId()]);
		assert.equal(selected.isPersisted(), true);
		assert.equal(selected.getSessionId(), initial.getSessionId());
		const forked = await create(["--fork", initial.getSessionId()]);
		assert.equal(forked.isPersisted(), true);
		assert.notEqual(forked.getSessionId(), initial.getSessionId());
		assert.equal(forked.getHeader()?.parentSessionId, initial.getSessionId());
		const memory = await create(["--no-session"]);
		assert.equal(memory.isPersisted(), false);
		assert.equal(memory.getSessionFile(), undefined);
	} finally {
		for (const manager of managers) await manager.getSessionStore().close();
		if (previous === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previous;
		await rm(directory, { recursive: true, force: true });
	}
});

test("fork listings resolve canonical parent IDs to the parent's display path", async () => {
	const directory = await mkdtemp(join(tmpdir(), "session-manager-parent-"));
	try {
		const parent = await SessionManager.create(directory, directory);
		await parent.appendMessage(message("parent"));
		const child = await SessionManager.forkFrom(parent.getSessionFile()!, directory, directory);
		const listed = await SessionManager.list(directory, directory);
		assert.equal(
			listed.find((entry) => entry.id === child.getSessionId())?.parentSessionPath,
			parent.getSessionFile(),
		);
		assert.equal(child.getHeader()?.parentSessionId, parent.getSessionId());
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("extension entry events and the visible index wait for commit and stay unchanged on rejection", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	let api!: ExtensionAPI;
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	try {
		await harness.session.bindExtensions({ mode: "print" });
		const before = manager.getEntries();
		const eventsBefore = harness.eventsOfType("entry_appended").length;
		store.blocked = true;
		const write = api.appendEntry("committed", { count: 1 });
		await store.entered.promise;
		assert.deepEqual(manager.getEntries(), before);
		assert.equal(harness.eventsOfType("entry_appended").length, eventsBefore);
		store.release.resolve();
		await write;
		assert.equal(manager.getEntries().length, before.length + 1);
		assert.equal(harness.eventsOfType("entry_appended").length, eventsBefore + 1);
		const committed = manager.getEntries();
		store.entered = Promise.withResolvers<void>();
		store.release = Promise.withResolvers<void>();
		const failure = new SessionConflictError(manager.getSessionId(), committed.length, committed.length + 1);
		store.failure = failure;
		const rejected = api.appendEntry("rejected", { count: 2 });
		await store.entered.promise;
		assert.deepEqual(manager.getEntries(), committed);
		assert.equal(harness.eventsOfType("entry_appended").length, eventsBefore + 1);
		store.release.resolve();
		await assert.rejects(rejected, (error) => error === failure);
		assert.deepEqual(manager.getEntries(), committed);
		assert.equal(harness.eventsOfType("entry_appended").length, eventsBefore + 1);
	} finally {
		store.blocked = false;
		store.failure = undefined;
		await harness.cleanup();
	}
});

test("session disposal waits for an admitted extension entry to commit", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	let api!: ExtensionAPI;
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				api = pi;
			},
		],
	});
	let closing: Promise<void> | undefined;
	let write: Promise<void> | undefined;
	try {
		await harness.session.bindExtensions({ mode: "print" });
		store.blocked = true;
		write = api.appendEntry("workflow.run.end", { status: "completed" });
		await store.entered.promise;
		let disposed = false;
		closing = harness.session.dispose().then(() => {
			disposed = true;
		});
		await nextEventLoopTurn();
		assert.equal(disposed, false, "disposal must retain ownership of the pending session write");
		store.release.resolve();
		await Promise.all([write, closing]);
		assert.ok(
			manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "workflow.run.end"),
		);
	} finally {
		store.release.resolve();
		await write;
		await closing;
		await harness.cleanup();
	}
});

test("message transformations precede commit while public completion waits for durability", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	let transformed = 0;
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				pi.on("message_end", (event) => {
					if (event.message.role !== "user") return;
					transformed++;
					return { message: { ...event.message, content: "transformed" } };
				});
			},
		],
	});
	const session = harness.session as AgentSessionInternalSurface;
	try {
		await harness.session.bindExtensions({ mode: "print" });
		const before = manager.getEntries();
		store.blocked = true;
		const pending = _processAgentEvent.call(session, { type: "message_end", message: message("original") });
		await store.entered.promise;
		assert.equal(transformed, 1);
		assert.deepEqual(manager.getEntries(), before);
		assert.equal(harness.eventsOfType("message_end").length, 0);
		store.release.resolve();
		await pending;
		const committed = manager.getEntries();
		assert.equal(committed.length, before.length + 1);
		assert.equal(harness.eventsOfType("message_end").length, 1);
		const entry = committed.at(-1)!;
		assert.equal(entry.type, "message");
		if (entry.type === "message") assert.equal(entry.message.content, "transformed");
		store.entered = Promise.withResolvers<void>();
		store.release = Promise.withResolvers<void>();
		const failure = new SessionConflictError(manager.getSessionId(), committed.length, committed.length + 1);
		store.failure = failure;
		const rejected = _processAgentEvent.call(session, { type: "message_end", message: message("rejected") });
		await store.entered.promise;
		assert.equal(transformed, 2);
		assert.deepEqual(manager.getEntries(), committed);
		assert.equal(harness.eventsOfType("message_end").length, 1);
		store.release.resolve();
		await assert.rejects(rejected, (error) => error === failure);
		assert.deepEqual(manager.getEntries(), committed);
		assert.equal(harness.eventsOfType("message_end").length, 1);
	} finally {
		store.blocked = false;
		store.failure = undefined;
		await harness.cleanup();
	}
});

test("overlapping public prompts commit each deferred bash result exactly once", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const harness = await createHarness({ sessionManager: manager });
	try {
		const session = harness.session;
		session.agent.state.isStreaming = true;
		await session.recordBashResult("printf first", {
			output: "first",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});
		session.agent.state.isStreaming = false;
		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);
		store.blocked = true;
		const first = session.prompt("first prompt");
		await store.entered.promise;
		const second = session.prompt("second prompt", { streamingBehavior: "followUp" });
		const results = Promise.allSettled([first, second]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		store.release.resolve();
		const outcomes = await results;
		assert.equal(outcomes[0].status, "fulfilled");
		assert.equal(outcomes[1].status, "rejected");
		const snapshot = await store.load(manager.getSessionId());
		const bashEntries = snapshot.entries.filter(
			(entry) => entry.type === "message" && entry.message.role === "bashExecution",
		);
		assert.equal(bashEntries.length, 1);
		assert.deepEqual(
			manager.getEntries().map((entry) => entry.id),
			snapshot.entries.map((entry) => entry.id),
		);
		assert.equal(session.messages.filter((entry) => entry.role === "bashExecution").length, 1);
	} finally {
		store.blocked = false;
		store.release.resolve();
		await harness.cleanup();
	}
});

test("a failed deferred bash drain retries only its uncommitted suffix in order", async () => {
	class PartiallyFailingStore extends ControlledStore {
		failAfterAppend: SessionConflictError | undefined;

		override async append(id: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
			const result = await super.append(id, entries, options);
			if (this.failAfterAppend) {
				this.failure = this.failAfterAppend;
				this.failAfterAppend = undefined;
			}
			return result;
		}
	}
	const store = new PartiallyFailingStore();
	const manager = await SessionManager.create(store, "/project");
	const harness = await createHarness({ sessionManager: manager });
	try {
		const session = harness.session;
		session.agent.state.isStreaming = true;
		for (const command of ["first", "second", "third"]) {
			await session.recordBashResult(command, { output: command, exitCode: 0, cancelled: false, truncated: false });
		}
		session.agent.state.isStreaming = false;
		const failure = new SessionConflictError(manager.getSessionId(), 1, 2);
		store.failAfterAppend = failure;
		store.blocked = true;
		const first = session.prompt("first attempt");
		await store.entered.promise;
		const second = session.prompt("overlapping attempt", { streamingBehavior: "followUp" });
		const rejected = [first, second].map((pending) => assert.rejects(pending, (error) => error === failure));
		await new Promise<void>((resolve) => setImmediate(resolve));
		store.release.resolve();
		await Promise.all(rejected);
		assert.deepEqual(
			session.messages.filter((entry) => entry.role === "bashExecution").map((entry) => entry.command),
			["first"],
		);
		store.blocked = false;
		store.failure = undefined;
		harness.setResponses([fauxAssistantMessage("retried")]);
		await session.prompt("retry");
		const reopened = await SessionManager.open(store, manager.getSessionId());
		assert.deepEqual(
			reopened
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "bashExecution" ? [entry.message.command] : [],
				),
			["first", "second", "third"],
		);
		assert.deepEqual(
			session.messages.filter((entry) => entry.role === "bashExecution").map((entry) => entry.command),
			["first", "second", "third"],
		);
	} finally {
		store.blocked = false;
		store.failure = undefined;
		store.release.resolve();
		await harness.cleanup();
	}
});

test("a failed pending custom-message drain retains its uncommitted suffix for exactly-once retry", async () => {
	class RejectOnceStore extends ControlledStore {
		rejectOnce: SessionConflictError | undefined;

		override async append(id: string, entries: readonly SessionEntry[], options: SessionWriteOptions) {
			if (
				this.rejectOnce &&
				entries.some((entry) => entry.type === "custom_message" && entry.content === "second")
			) {
				const failure = this.rejectOnce;
				this.rejectOnce = undefined;
				throw failure;
			}
			return super.append(id, entries, options);
		}
	}
	const store = new RejectOnceStore();
	const manager = await SessionManager.create(store, "/project");
	const harness = await createHarness({ sessionManager: manager });
	try {
		const session = harness.session;
		session.agent.state.isStreaming = true;
		for (const content of ["first", "second", "third"]) {
			await session.sendCustomMessage({ customType: "pending", content, display: true }, { triggerTurn: false });
		}
		session.agent.state.isStreaming = false;
		const failure = new SessionConflictError(manager.getSessionId(), 1, 2);
		store.rejectOnce = failure;
		await assert.rejects(session.prompt("first attempt"), (error) => error === failure);
		assert.deepEqual(
			session.messages.flatMap((entry) => (entry.role === "custom" ? [entry.content] : [])),
			["first"],
		);
		harness.setResponses([fauxAssistantMessage("retried")]);
		await session.prompt("retry");
		const reopened = await SessionManager.open(store, manager.getSessionId());
		assert.deepEqual(
			reopened.getEntries().flatMap((entry) => (entry.type === "custom_message" ? [entry.content] : [])),
			["first", "second", "third"],
		);
		assert.deepEqual(
			harness
				.eventsOfType("message_end")
				.flatMap(({ message }) => (message.role === "custom" ? [message.content] : [])),
			["first", "second", "third"],
		);
	} finally {
		await harness.cleanup();
	}
});

test("overlapping public prompts share the pending custom-message drain", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const harness = await createHarness({ sessionManager: manager });
	try {
		const session = harness.session;
		session.agent.state.isStreaming = true;
		await session.sendCustomMessage(
			{ customType: "pending", content: "once", display: true },
			{ triggerTurn: false },
		);
		session.agent.state.isStreaming = false;
		harness.setResponses([fauxAssistantMessage("reply"), fauxAssistantMessage("follow-up reply")]);
		store.blocked = true;
		const first = session.prompt("first prompt");
		await store.entered.promise;
		const second = session.prompt("second prompt", { streamingBehavior: "followUp" });
		const results = Promise.allSettled([first, second]);
		await new Promise<void>((resolve) => setImmediate(resolve));
		store.release.resolve();
		const outcomes = await results;
		assert.equal(outcomes[0].status, "fulfilled");
		assert.equal(outcomes[1].status, "rejected");
		const reopened = await SessionManager.open(store, manager.getSessionId());
		assert.deepEqual(
			reopened.getEntries().flatMap((entry) => (entry.type === "custom_message" ? [entry.content] : [])),
			["once"],
		);
		assert.deepEqual(
			harness
				.eventsOfType("message_end")
				.flatMap(({ message }) => (message.role === "custom" ? [message.content] : [])),
			["once"],
		);
	} finally {
		store.blocked = false;
		store.release.resolve();
		await harness.cleanup();
	}
});

test.each(["user", "custom"] as const)(
	"a failed %s prompt preparation retains accepted nextTurn messages until their commits",
	async (starter) => {
		const store = new ControlledStore();
		const manager = await SessionManager.create(store, "/project");
		let prepareBash = true;
		const harness = await createHarness({
			sessionManager: manager,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async () => {
						if (!prepareBash) return;
						prepareBash = false;
						harness.session.agent.state.isStreaming = true;
						try {
							await harness.session.recordBashResult("deferred", {
								output: "deferred",
								exitCode: 0,
								cancelled: false,
								truncated: false,
							});
						} finally {
							harness.session.agent.state.isStreaming = false;
						}
					});
				},
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "print" });
			for (const content of ["next first", "next second"]) {
				await harness.session.sendCustomMessage(
					{ customType: "next", content, display: true },
					{ deliverAs: "nextTurn" },
				);
			}
			const failure = new SessionConflictError(manager.getSessionId(), 1, 2);
			store.failure = failure;
			const failed =
				starter === "user"
					? harness.session.prompt("failed prompt")
					: harness.session.sendCustomMessage(
							{ customType: "starter", content: "failed starter", display: true },
							{ triggerTurn: true },
						);
			await assert.rejects(failed, (error) => error === failure);
			store.failure = undefined;
			harness.setResponses([fauxAssistantMessage("retried"), fauxAssistantMessage("later")]);
			await harness.session.prompt("retry");
			await harness.session.prompt("later prompt");
			const reopened = await SessionManager.open(store, manager.getSessionId());
			assert.deepEqual(
				reopened.getEntries().flatMap((entry) => (entry.type === "custom_message" ? [entry.content] : [])),
				["next first", "next second"],
			);
		} finally {
			store.failure = undefined;
			await harness.cleanup();
		}
	},
);

test.each(["new", "branched"] as const)(
	"cross-directory %s sessions remain appendable and reopenable without changing the source",
	async (transition) => {
		const directory = await mkdtemp(join(tmpdir(), "session-manager-transition-"));
		try {
			const source = await SessionManager.create(directory, join(directory, "source"));
			const sourceId = source.getSessionId();
			const sourcePath = source.getSessionFile()!;
			const leaf = await source.appendMessage(message("source"));
			await source.appendLabelChange(leaf, "source-label");
			const destination = join(directory, "destination");
			const manager = await SessionManager.open(sourcePath, destination);
			assert.equal(manager.getSessionId(), sourceId);
			assert.equal(manager.getLabel(leaf), "source-label");
			await manager.appendCustomEntry("source-still-writable", { value: 1 });
			const sourceBytes = await readFile(sourcePath, "utf8");
			if (transition === "new") await manager.newSession({ id: "destination-session" });
			else await manager.createBranchedSession(leaf);
			const id = manager.getSessionId();
			assert.notEqual(id, sourceId);
			if (transition === "new") assert.equal(id, "destination-session");
			assert.equal(manager.isPersisted(), true);
			assert.equal(manager.getSessionDir(), destination);
			assert.equal(dirname(manager.getSessionFile()!), destination);
			const appended = await manager.appendMessage(message("destination append"));
			assert.equal(manager.getSessionId(), id);
			const reopened = await SessionManager.open(manager.getSessionFile()!);
			assert.equal(reopened.getSessionId(), id);
			assert.deepEqual(reopened.getEntries(), manager.getEntries());
			assert.equal(reopened.getLeafId(), appended);
			const header = reopened.getHeader()!;
			assert.equal(header.version, 4);
			assert.equal(typeof header.createdAt, "string");
			assert.equal("timestamp" in header, false);
			assert.equal("parentSession" in header, false);
			assert.equal(header.parentSessionId, transition === "branched" ? sourceId : undefined);
			if (transition === "branched") assert.equal(reopened.getLabel(leaf), "source-label");
			assert.equal(await readFile(sourcePath, "utf8"), sourceBytes);
			assert.equal((await SessionManager.open(sourcePath)).getSessionId(), sourceId);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
);

test("refreshContext retains a user message while its async session append is pending", async () => {
	const store = new ControlledStore();
	const manager = await SessionManager.create(store, "/project");
	const harness = await createHarness({ sessionManager: manager });
	harness.setResponses([fauxAssistantMessage("setup reply"), fauxAssistantMessage("saved reply")]);
	await harness.session.prompt("setup");
	store.blocked = true;
	const prompt = harness.session.prompt("user awaiting commit");
	try {
		await store.entered.promise;
		const hasPendingUser = () =>
			harness.session.messages.some(
				(message) =>
					message.role === "user" &&
					Array.isArray(message.content) &&
					message.content.some((part) => part.type === "text" && part.text === "user awaiting commit"),
			);
		assert.ok(hasPendingUser(), "the agent has admitted the user message before the append commits");
		harness.session.refreshContext();
		assert.ok(hasPendingUser(), "refresh must not drop a message whose append is still pending");
		store.release.resolve();
		await prompt;
		harness.session.refreshContext();
		assert.equal(harness.session.messages.filter((message) => message.role === "user").length, 2);
	} finally {
		store.release.resolve();
		await prompt;
		await harness.cleanup();
	}
});
