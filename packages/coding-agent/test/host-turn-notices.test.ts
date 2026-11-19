import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@bastani/atomic-agent-core";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { HOST_NOTICE_TYPE, type HostNotice, hostNoticeForEvent } from "../src/core/host-notices.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A persisted session in a temporary directory, and how to open it again from its file. */
async function persistedSession(): Promise<{ manager: SessionManager; reopen(): Promise<SessionManager> }> {
	const root = mkdtempSync(join(tmpdir(), "host-turn-notices-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const dir = join(root, "sessions");
	const manager = await SessionManager.create(root, dir);
	return { manager, reopen: () => SessionManager.open(manager.getSessionFile()!, dir, root) };
}

async function harnessFor(manager: SessionManager, settings: Parameters<typeof createHarness>[0]["settings"]) {
	const harness = await createHarness({ sessionManager: manager, settings });
	cleanups.push(() => harness.cleanup());
	return harness;
}

function messageText(message: AgentMessage): string {
	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => block?.type === "text")
		.map((block) => block.text)
		.join("");
}

/** The rows a chat shows for these messages: responses, request errors and the lines Atomic writes itself. */
function rows(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap((message) => {
		if (message.role === "assistant")
			return [message.stopReason === "error" ? `error: ${message.errorMessage}` : `reply: ${messageText(message)}`];
		if (message.role === "custom" && message.display) {
			const level = (message.details as { level?: string } | undefined)?.level ?? "";
			return [`${message.customType} ${level}: ${messageText(message)}`];
		}
		return [];
	});
}

/** The rows the session showed while it ran, from its events. */
function liveRows(harness: Harness): string[] {
	return rows(
		harness.events.flatMap((event: AgentSessionEvent) =>
			event.type === "message_end" && event.message.role !== "user" ? [event.message] : [],
		),
	);
}

test("standalone HTML, interactive HTML and JSONL exports contain each complete stored outcome (#5649)", async () => {
	const { manager } = await persistedSession();
	const harness = await harnessFor(manager, {});
	const texts = Array.from({ length: 3 }, (_, i) => `Compaction failed: ${"path/".repeat(500)}ENOSPC ${i}`);
	for (const text of texts) await manager.appendCustomEntry(HOST_NOTICE_TYPE, { level: "error", text });
	const input = manager.getSessionFile()!;
	for (const path of [
		await exportFromFile(input, `${input}.standalone.html`),
		await harness.session.exportToHtml(`${input}.html`),
		await harness.session.exportToJsonl(`${input}.export.jsonl`),
	]) {
		const file = readFileSync(path, "utf8");
		const entries = path.endsWith(".html")
			? JSON.parse(
					Buffer.from(
						/<script id="session-data" type="application\/json">([^<]+)/.exec(file)![1]!,
						"base64",
					).toString(),
				).entries
			: file
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
		assert.deepEqual(
			entries
				.filter((entry: { customType?: string }) => entry.customType === HOST_NOTICE_TYPE)
				.map((entry: { data: HostNotice }) => entry.data.text),
			texts,
			path,
		);
	}
});

test.each(["incomplete point read", "missing header"])(
	"a resumed chat shows a saved outcome inline when its link is unreadable: %s (#5649)",
	async (fault) => {
		const { manager } = await persistedSession();
		const store = manager.getSessionStore();
		const text = `Compaction failed: ${"long-directory/".repeat(55)} ENOSPC`;
		await manager.appendCustomEntry(HOST_NOTICE_TYPE, { level: "error", text });
		const read = store.readEntryRange!.bind(store);
		if (fault === "missing header") store.readHeader = async () => undefined;
		else
			store.readEntryRange = async (...args) => {
				const page = await read(...args);
				return {
					...page,
					entries: page.entries.map((row) =>
						row.entry.type === "custom"
							? { ...row, entry: { ...row.entry, data: { level: "error", text: text.slice(0, 100) } } }
							: row,
					),
				};
			};
		const resumed = await SessionManager.open(store, manager.getSessionId());
		const message = resumed.buildSessionProjection("transcript").messages.at(-1);
		assert.ok(message?.role === "custom");
		assert.equal(message.content, text);
		assert.equal((message.details as HostNotice).location, undefined);
	},
);

test("JSONL export reads individual saved outcomes without loading the complete session (#5649)", async () => {
	const { manager } = await persistedSession();
	const harness = await harnessFor(manager, {});
	const store = manager.getSessionStore();
	store.readRange = undefined;
	const texts = Array.from({ length: 40 }, (_, i) => `Failure ${i}: ${"path/".repeat(500)}ENOSPC`);
	for (const text of texts) await manager.appendCustomEntry(HOST_NOTICE_TYPE, { level: "error", text });
	const loads = vi.spyOn(store, "load");
	const path = await harness.session.exportToJsonl(`${manager.getSessionFile()}.export.jsonl`);
	const saved = readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(
		saved.filter((e) => e.customType === HOST_NOTICE_TYPE).map((e) => e.data.text),
		texts,
	);
	assert.equal(loads.mock.calls.length, 0);
});

const overloaded = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });

test("a final retry failure reopens with the session, in its place, and never reaches the model (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	harness.setResponses([overloaded(), overloaded()]);

	await harness.session.prompt("hello");

	const live = liveRows(harness);
	assert.deepEqual(live, [
		"error: overloaded_error",
		"error: overloaded_error",
		"atomic.turn-outcome.v1 error: Retry failed after 1 attempts: overloaded_error",
	]);
	const reopened = await reopen();
	assert.deepEqual(rows(reopened.buildSessionProjection("transcript").messages), live, "reopened rows");
	const context = reopened.buildSessionContext().messages;
	assert.ok(!context.some((message) => message.role === "custom"), "the line is not model context");
	assert.doesNotMatch(JSON.stringify(convertToLlm(harness.session.messages)), /Retry failed/);
});

test("a retry cancelled during its wait reopens as the same line (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 3, baseDelayMs: 5_000 } });
	harness.setResponses([overloaded()]);
	harness.session.subscribe((event) => {
		if (event.type === "auto_retry_start") harness.session.abortRetry();
	});

	await harness.session.prompt("hello");

	const live = liveRows(harness);
	assert.deepEqual(live, [
		"error: overloaded_error",
		"atomic.turn-outcome.v1 error: Retry failed after 1 attempts: Retry cancelled",
	]);
	assert.deepEqual(rows((await reopen()).buildSessionProjection("transcript").messages), live);
});

test("the next prompt follows the saved line, and its request leaves the line out (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	let lastContext = "";
	harness.setResponses([
		overloaded(),
		overloaded(),
		(context) => {
			lastContext = JSON.stringify(context);
			return fauxAssistantMessage("fine");
		},
	]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");

	assert.match(lastContext, /second/);
	assert.doesNotMatch(lastContext, /Retry failed/);
	assert.deepEqual(rows((await reopen()).buildSessionProjection("transcript").messages).slice(-2), [
		"atomic.turn-outcome.v1 error: Retry failed after 1 attempts: overloaded_error",
		"reply: fine",
	]);
});

test("a healthy turn with boundary drafts never reads archived outcome bodies (#5649)", async () => {
	const { manager } = await persistedSession();
	for (let i = 0; i < 40; ++i) {
		await manager.appendCustomEntry(HOST_NOTICE_TYPE, {
			level: "error",
			text: `Compaction ${i}: ${"x".repeat(2500)}`,
		});
	}
	const visibleNotices = (entries: ReturnType<SessionManager["getEntries"]>) =>
		entries.flatMap((entry) =>
			entry.type === "custom" && entry.customType === HOST_NOTICE_TYPE ? [entry.data] : [],
		);
	const before = visibleNotices(manager.getEntries());
	let after: unknown[] = [];
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				pi.on("turn_end", () => ({ entries: [{ type: "custom", customType: "marker", data: { marked: true } }] }));
			},
			(pi) => {
				pi.on("turn_end", ({ context }) => {
					after = visibleNotices(context.contextEntries.map((e) => e.sourceEntry));
				});
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	const store = manager.getSessionStore();
	const read = store.readRange!.bind(store);
	let bodies = 0;
	store.readRange = async (...args) => {
		const page = await read(...args);
		bodies += page.entries.filter((e) => e.type === "custom" && e.customType === HOST_NOTICE_TYPE).length;
		return page;
	};
	const points = vi.spyOn(store, "readEntryRange");
	harness.setResponses([fauxAssistantMessage("ok")]);
	await harness.session.prompt("healthy follow-up");
	assert.equal(points.mock.calls.length, 0);
	assert.ok(manager.getEntries().some((e) => e.type === "custom" && e.customType === "marker"));
	assert.equal(bodies, 0);
	assert.deepEqual(after, before, "drafts preserve the diagnostic previews already visible to handlers");
});

test("a provider error longer than the notice bound is saved cut at a whole character (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	// A page of mixed-width text with a surrogate pair at every possible cut.
	const page = `overloaded ${"漢字😀e\u0301".repeat(20_000)}`;
	const failing = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: page });
	harness.setResponses([failing(), failing()]);

	await harness.session.prompt("hello");

	const reopened = await reopen();
	const notices = (await reopened.getSessionStore().load(reopened.getSessionId())).entries.flatMap((entry) =>
		entry.type === "custom" && entry.customType === "atomic.turn-outcome.v1" ? [entry] : [],
	);
	assert.equal(notices.length, 1);
	const text = (notices[0]!.data as { text: string }).text;
	assert.ok(Buffer.byteLength(text) <= 4096, `${Buffer.byteLength(text)} bytes`);
	assert.ok(text.isWellFormed(), "no lone surrogate");
	assert.ok(text.endsWith("…"));
	assert.ok(text.startsWith("Retry failed after 1 attempts: overloaded 漢字😀e\u0301"));
	const live = harness.events.flatMap((event) =>
		event.type === "message_end" && event.message.role === "custom" ? [messageText(event.message)] : [],
	);
	assert.deepEqual(live, [`Retry failed after 1 attempts: ${page}`], "the storage cap does not cut the live line");
});

test("a chat that reads the transcript while the line is still being saved shows it once, and once after (#5649)", async () => {
	const { manager } = await persistedSession();
	const harness = await harnessFor(manager, { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } });
	const append = manager.appendCustomEntry.bind(manager);
	const saving = Promise.withResolvers<void>();
	manager.appendCustomEntry = (async (customType: string, data?: unknown) => {
		await saving.promise;
		return append(customType, data);
	}) as typeof manager.appendCustomEntry;
	const shown = Promise.withResolvers<void>();
	harness.session.subscribe((event) => {
		if (event.type === "message_start" && event.message.role === "custom") shown.resolve();
	});
	harness.setResponses([overloaded(), overloaded()]);
	const notices = () =>
		rows(harness.session.transcriptMessages).filter((row) => row.startsWith("atomic.turn-outcome.v1"));
	const expected = ["atomic.turn-outcome.v1 error: Retry failed after 1 attempts: overloaded_error"];

	const prompt = harness.session.prompt("hello");
	await shown.promise;
	assert.deepEqual(notices(), expected, "while it is being saved");
	saving.resolve();
	await prompt;
	assert.deepEqual(notices(), expected, "once it is saved");
});

test("a cancelled manual compaction reopens as the line the chat showed (#5649)", async () => {
	const { manager, reopen } = await persistedSession();
	const started = Promise.withResolvers<void>();
	const harness = await createHarness({
		sessionManager: manager,
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					started.resolve();
					await new Promise<void>((resolve) =>
						event.signal.addEventListener("abort", () => resolve(), { once: true }),
					);
					return { cancel: true };
				});
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	harness.setResponses([fauxAssistantMessage("hi")]);
	await harness.session.prompt("hello");

	const compaction = harness.session.compact().catch((error: Error) => error);
	await started.promise;
	harness.session.abortCompaction();
	assert.match(String(await compaction), /Compaction cancelled/);

	const live = liveRows(harness);
	assert.deepEqual(live, ["reply: hi", "atomic.turn-outcome.v1 error: Compaction cancelled"]);
	await vi.waitFor(async () =>
		assert.deepEqual(rows((await reopen()).buildSessionProjection("transcript").messages), live),
	);
	// A stage chat opened now reads the live session's transcript, which edits nothing here.
	assert.deepEqual(rows(harness.session.transcriptMessages), live);
});

test("which session events leave a line in the chat, and which say nothing (#5649)", () => {
	const snapshot = (code: string) =>
		({
			type: "worktree_snapshot_unavailable",
			reason: { name: "WorkspaceSnapshotError", code, message: `${code} reason` },
		}) as never;
	const cases: Array<[unknown, string | undefined, HostNotice | undefined]> = [
		[{ type: "auto_retry_end", success: true, attempt: 2 }, undefined, undefined],
		[
			{ type: "auto_retry_end", success: false, attempt: 2 },
			undefined,
			{ level: "error", text: "Retry failed after 2 attempts: Unknown error" },
		],
		[
			{ type: "agent_continue_error", source: "post_compaction", errorMessage: "provider failed" },
			undefined,
			{ level: "error", text: "provider failed" },
		],
		[
			{ type: "agent_continue_error", source: "post_compaction", errorMessage: "held", queuedMessage: true },
			undefined,
			undefined,
		],
		[
			{ type: "compaction_end", reason: "manual", aborted: true, willRetry: false },
			undefined,
			{ level: "error", text: "Compaction cancelled" },
		],
		[
			{ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false },
			undefined,
			{ level: "status", text: "Auto-compaction cancelled" },
		],
		[
			{ type: "compaction_end", reason: "threshold", aborted: true, willRetry: false, manualTakeoverPending: true },
			undefined,
			undefined,
		],
		[
			{ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "failed" },
			"manual",
			undefined,
		],
		[
			{ type: "compaction_end", reason: "overflow", aborted: false, willRetry: false, errorMessage: "failed" },
			"overflow",
			{ level: "error", text: "failed" },
		],
		[
			{ type: "compaction_end", reason: "manual", aborted: false, willRetry: false, result: {} },
			undefined,
			undefined,
		],
		[snapshot("not-a-repository"), undefined, undefined],
		[snapshot("blob-store-unsupported"), undefined, { level: "warning", text: "blob-store-unsupported reason" }],
		[{ type: "agent_end", messages: [] }, undefined, undefined],
	];
	for (const [event, compactionReason, expected] of cases)
		assert.deepEqual(hostNoticeForEvent(event as never, compactionReason), expected, JSON.stringify(event));
});
