import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { openNodeSqliteDatabase } from "../../packages/coding-agent/src/core/storage/node-sqlite.js";
import { JsonlSessionStore } from "../../packages/coding-agent/src/core/storage/session/jsonl-session-store.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.js";
import {
	bindSubagentChildCards,
	clearSubagentChildTranscriptCache,
	type SubagentChildTranscriptDetails,
	subagentChildCardRecord,
	subagentChildTranscriptDetails,
} from "../../packages/subagents/src/runs/foreground/subagent-child-card-state.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

const agentDir = useTemporaryAgentDir();

test("an explicitly expanded forked-child card reads its own displayed tool details and releases them on collapse (#5594)", async () => {
	const store = new MemorySessionStore();
	try {
		const owner = await SessionManager.create(store, process.cwd());
		const child = await SessionManager.create(store, process.cwd());
		const launch = await child.appendMessage({ role: "user", content: "inherited", timestamp: 1 });
		await child.appendMessage({ role: "user", content: "own task", timestamp: 2 });
		const usage = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		await child.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private-thinking".repeat(90000), thinkingSignature: "s" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "chosen" } },
			],
			provider: "anthropic",
			model: "test",
			api: "anthropic-messages",
			usage,
			stopReason: "toolUse",
			timestamp: 3,
		});
		await child.appendMessage({
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			isError: false,
			content: [{ type: "text", text: "shown" }],
			details: { token: "a raw extension object" },
			timestamp: 4,
		});
		await child.appendCustomEntry("unrelated-private-data", { payload: "not part of any card".repeat(90000) });
		await child.appendCompaction("clear", null, 100, {
			strategy: "verbatim-lines",
			form: "cleared",
			promptVersion: 7,
			parameters: { query: "clear" },
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 0,
				percentReduction: 100,
			},
		});
		await child.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "answer" }],
			provider: "anthropic",
			model: "test",
			api: "anthropic-messages",
			usage,
			stopReason: "stop",
			timestamp: 5,
		});
		const childId = "expanded-fork-case",
			taskId = "card-task";
		await owner.appendCustomEntry("subagent-child", {
			version: 1,
			childId,
			index: 0,
			runId: "card-run",
			agent: "worker",
			cwd: process.cwd(),
			state: "terminal",
			terminalStatus: "completed",
			taskId,
			childSessionId: child.getSessionId(),
			owner: { kind: "session", sessionId: owner.getSessionId() },
			launchLeafId: launch,
			launchLeafSeq: 1,
			forked: true,
		});
		bindSubagentChildCards({ sessionManager: owner });
		const record = subagentChildCardRecord(childId, taskId)!;
		assert.ok(record);
		const opened = vi.spyOn(store, "readResume");
		const snapshot = vi.spyOn(store, "load");
		const card = {};
		const ref = await (async () => {
			const shown = await vi.waitFor(
				() => {
					const d = subagentChildTranscriptDetails(card, record);
					assert.ok(d);
					return d;
				},
				{ timeout: 10000, interval: 10 },
			);
			assert.deepEqual(shown, {
				prompt: "own task",
				result: "answer",
				lines: ["› own task", "→ read", "answer"],
				toolCalls: [
					{
						id: "call",
						name: "read",
						args: { path: "chosen" },
						resultContent: [{ type: "text", text: "shown" }],
						resultDetails: { token: "a raw extension object" },
						resultText: "shown",
						isError: false,
						completed: true,
					},
				],
			});
			return new WeakRef(shown.toolCalls[0]!.resultDetails as object);
		})();
		assert.equal(opened.mock.calls.length, 0, "opening the card opened a session runtime");
		assert.equal(snapshot.mock.calls.length, 0, "opening the card loaded a whole saved session");
		clearSubagentChildTranscriptCache(card);
		await collectGarbage();
		assert.equal(ref.deref(), undefined);
	} finally {
		await store.close();
	}
});

/*
 * One saved child, written as the released (pre-#5594) version wrote it: a clear boundary at seq 8 keeps a held
 * window of the model transition at seq 5 and the rows after the boundary. Its launch records carry each cursor shape
 * older versions saved. The expected cards are what the released card (main 1a29f40c7d, which reopened the child and
 * read its branch) showed for each of them, byte for byte and in the same key order.
 */
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const text = (value: string) => ({ type: "text", text: value });
const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
/** A raw extension object, with an own `__proto__` key and keys out of order, as a tool saved it. */
const rawDetails = () => ({ ["__proto__"]: { x: 1 }, b: [2, { c: null }], a: "é\u{1F600}" });
const savedChild = (() => {
	const rows: Record<string, unknown>[] = [];
	const add = (fields: Record<string, unknown>) => {
		const id = `row-${rows.length + 1}`;
		rows.push({
			id,
			parentId: rows.at(-1)?.id ?? null,
			timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, rows.length)).toISOString(),
			...fields,
		});
		return id;
	};
	const message = (role: string, content: unknown, extra: Record<string, unknown> = {}) =>
		add({ type: "message", message: { role, content, timestamp: rows.length + 1, ...extra } });
	const assistant = (content: unknown[]) =>
		message("assistant", content, { provider: "faux", model: "m1", api: "faux", usage, stopReason: "stop" });
	const result = (toolCallId: string, content: unknown, extra: Record<string, unknown> = {}) =>
		message("toolResult", content, { toolCallId, toolName: "tool", isError: false, ...extra });
	message("user", "inherited context"); // 1
	assistant([text("inherited answer")]); // 2
	const modelChange = add({ type: "model_change", provider: "p2", modelId: "m2" }); // 3
	const retired = message("user", "earlier question"); // 4
	assistant([text("earlier reply"), call("e1", "read", { path: "old" })]); // 5: held model transition
	result("e1", [text("old output")]); // 6
	assistant([text("last held answer")]); // 7
	add({
		type: "compaction",
		summary: "cleared",
		firstKeptEntryId: null,
		tokensBefore: 100,
		details: {
			strategy: "verbatim-lines",
			form: "cleared",
			promptVersion: 7,
			parameters: { query: "clear" },
			stats: {
				linesBefore: 1,
				linesDeleted: 1,
				linesKept: 0,
				rangeCount: 0,
				tokensBefore: 100,
				tokensAfter: 0,
				percentReduction: 100,
			},
		},
	}); // 8
	message("user", "resumed after clearing"); // 9
	message("user", "You are continuing from the parent session.\n\nTask:\nown task"); // 10
	assistant([
		{ type: "thinking", thinking: "private", thinkingSignature: "s" },
		call("c1", "read", { path: "chosen" }),
		call("c2", "bash", { command: "ls" }),
	]); // 11
	result("c1", [text("first")], { details: { first: true } }); // 12: superseded by 15
	result("c2", "ls out", { isError: true, durationMs: 7 }); // 13
	assistant([call("c1", "read", { path: "again" })]); // 14: the same call id issued again
	result("c1", [text("second")], { details: rawDetails() }); // 15
	add({ type: "custom", customType: "unrelated-private-data", data: { payload: "not part of any card" } }); // 16
	assistant([text("answer")]); // 17
	return {
		header: {
			id: "0195aaaa-0000-7000-8000-000000005594",
			version: 4,
			createdAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
			cwd: process.cwd(),
		},
		rows,
		modelChange,
		retired,
	};
})();

const pending = { id: "e1", name: "read", args: { path: "old" }, completed: false };
const done = {
	id: "e1",
	name: "read",
	args: { path: "old" },
	resultContent: [text("old output")],
	resultText: "old output",
	isError: false,
	completed: true,
};
const superseding = (args: Record<string, unknown>) => ({
	id: "c1",
	name: "read",
	args,
	resultContent: [text("second")],
	resultDetails: rawDetails(),
	resultText: "second",
	isError: false,
	completed: true,
});
const bash = {
	id: "c2",
	name: "bash",
	args: { command: "ls" },
	resultContent: [],
	resultText: "ls out",
	isError: true,
	durationMs: 7,
	completed: true,
};
const ownCalls = [superseding({ path: "chosen" }), bash, superseding({ path: "again" })];
const ownLines = [
	"› resumed after clearing",
	"› You are continuing from the parent session. Task: own task",
	"→ read",
	"→ bash",
	"→ read",
	"answer",
];
const heldCard = {
	prompt: "resumed after clearing",
	toolCalls: [pending, ...ownCalls],
	result: "answer",
	lines: ["earlier reply", "→ read", ...ownLines],
};
const fullCard = {
	prompt: "resumed after clearing",
	toolCalls: [done, ...ownCalls],
	result: "answer",
	lines: ["earlier reply", "→ read", "last held answer", ...ownLines],
};
const launches: readonly { readonly shape: string; readonly launch: Record<string, unknown>; readonly card: object }[] =
	[
		{
			shape: "launch entry still held when reopened",
			launch: { launchLeafId: savedChild.modelChange },
			card: heldCard,
		},
		{ shape: "launch entry only in the full history", launch: { launchLeafId: savedChild.retired }, card: fullCard },
		{
			shape: "missing launch entry with its position",
			launch: { launchLeafId: "gone", launchLeafSeq: 4 },
			card: fullCard,
		},
		{
			shape: "missing launch entry, no position",
			launch: { launchLeafId: "gone" },
			card: { toolCalls: [], lines: [] },
		},
		{
			shape: "null launch entry with its position",
			launch: { launchLeafId: null, launchLeafSeq: 4 },
			card: heldCard,
		},
		{ shape: "launch position only", launch: { launchLeafSeq: 4 }, card: heldCard },
		{
			shape: "no launch cursor",
			launch: {},
			card: { prompt: "resumed after clearing", toolCalls: ownCalls, result: "answer", lines: ownLines },
		},
		{
			shape: "no launch cursor, forked",
			launch: { forked: true },
			card: { prompt: "own task", toolCalls: ownCalls, result: "answer", lines: ownLines.slice(1) },
		},
	];

async function savedChildStore(kind: "memory" | "sqlite" | "file"): Promise<{ store: SessionStore; file?: string }> {
	const dir = mkdtempSync(join(agentDir, `expanded-card-${kind}-`));
	if (kind === "sqlite") {
		const store = await SqlSessionStore.open(await openNodeSqliteDatabase(join(dir, "sessions.sqlite")));
		await store.create(savedChild.header as never, savedChild.rows as never);
		return { store };
	}
	if (kind === "memory") {
		const store = new MemorySessionStore();
		await store.create(savedChild.header as never, savedChild.rows as never);
		return { store };
	}
	const file = join(dir, "child.jsonl");
	writeFileSync(
		file,
		`${[{ type: "session", ...savedChild.header }, ...savedChild.rows].map((row) => JSON.stringify(row)).join("\n")}\n`,
	);
	return { store: new MemorySessionStore(), file };
}

async function expandedCard(card: object, childId: string, taskId: string): Promise<SubagentChildTranscriptDetails> {
	const record = subagentChildCardRecord(childId, taskId);
	assert.ok(record);
	return vi.waitFor(
		() => {
			const details = subagentChildTranscriptDetails(card, record);
			assert.ok(details);
			return details;
		},
		{ timeout: 10000, interval: 5 },
	);
}

for (const kind of ["memory", "sqlite", "file"] as const)
	test(`an expanded launch card from a ${kind} child shows exactly the released card for every saved launch cursor (#5594)`, async () => {
		const { store, file } = await savedChildStore(kind);
		const hydrated = [
			vi.spyOn(MemorySessionStore.prototype, "load"),
			vi.spyOn(MemorySessionStore.prototype, "readResume"),
			vi.spyOn(SqlSessionStore.prototype, "load"),
			vi.spyOn(SqlSessionStore.prototype, "readResume"),
			vi.spyOn(JsonlSessionStore.prototype, "load"),
			vi.spyOn(JsonlSessionStore.prototype, "loadFile"),
			vi.spyOn(JsonlSessionStore.prototype, "readResume"),
		];
		try {
			const owner = await SessionManager.create(store, process.cwd());
			const ids = launches.map((_, index) => ({
				childId: `cursor-${kind}-${index}`,
				taskId: `cursor-task-${kind}-${index}`,
			}));
			for (const [index, { launch }] of launches.entries())
				await owner.appendCustomEntry("subagent-child", {
					version: 1,
					childId: ids[index]!.childId,
					index: 0,
					runId: `cursor-run-${kind}`,
					agent: "worker",
					cwd: process.cwd(),
					state: "terminal",
					terminalStatus: "completed",
					taskId: ids[index]!.taskId,
					childSessionId: savedChild.header.id,
					...(file ? { childSessionFile: file } : {}),
					owner: { kind: "session", sessionId: owner.getSessionId() },
					...launch,
				});
			const release = bindSubagentChildCards({ sessionManager: owner });
			for (const [index, { shape, card: expected }] of launches.entries()) {
				const card = {};
				const shown = await expandedCard(card, ids[index]!.childId, ids[index]!.taskId);
				assert.deepStrictEqual(shown, expected, shape);
				assert.equal(JSON.stringify(shown), JSON.stringify(expected), `${shape}: key order`);
				const calls = shown.toolCalls.filter((c) => c.id === "c1");
				// As before, the result that superseded the first one is the one raw object both calls show.
				if (calls.length) assert.equal(calls[0]!.resultDetails, calls[1]!.resultDetails, shape);
				clearSubagentChildTranscriptCache(card);
			}
			release();
			for (const spy of hydrated)
				assert.equal(spy.mock.calls.length, 0, `a card hydrated the child through ${spy.getMockName()}`);
		} finally {
			for (const spy of hydrated) spy.mockRestore();
			await store.close();
		}
	});

test("an expanded card keeps none of its shown details once its session is switched or closed (#5594)", async () => {
	const { store } = await savedChildStore("memory");
	try {
		const owner = await SessionManager.create(store, process.cwd());
		for (const childId of ["switched-card", "closed-card"])
			await owner.appendCustomEntry("subagent-child", {
				version: 1,
				childId,
				index: 0,
				runId: "lifecycle-run",
				agent: "worker",
				cwd: process.cwd(),
				state: "terminal",
				terminalStatus: "completed",
				taskId: `${childId}-task`,
				childSessionId: savedChild.header.id,
				owner: { kind: "session", sessionId: owner.getSessionId() },
			});
		const other = await SessionManager.create(store, process.cwd());
		// The cards stay referenced, as a chat that has not been rebuilt yet still holds its components.
		const switchedCard = {},
			closedCard = {};
		const shownDetails = async (card: object, childId: string) =>
			new WeakRef((await expandedCard(card, childId, `${childId}-task`)).toolCalls[0]!.resultDetails as object);

		const releaseOwner = bindSubagentChildCards({ sessionManager: owner });
		const switched = await shownDetails(switchedCard, "switched-card");
		releaseOwner();
		const releaseOther = bindSubagentChildCards({ sessionManager: other });
		await collectGarbage();
		assert.equal(switched.deref(), undefined, "switching sessions kept an expanded card's details");

		releaseOther();
		const releaseAgain = bindSubagentChildCards({ sessionManager: owner });
		const closed = await shownDetails(closedCard, "closed-card");
		releaseAgain();
		await collectGarbage();
		assert.equal(closed.deref(), undefined, "closing the session kept an expanded card's details");
		assert.ok(switchedCard && closedCard);
	} finally {
		await store.close();
	}
});
