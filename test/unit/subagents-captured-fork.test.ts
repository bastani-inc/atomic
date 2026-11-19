import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.js";
import { collectGarbage } from "../helpers/collect-garbage.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();
const clear = (manager: SessionManager) =>
	manager.appendCompaction("cleared", null, 100, {
		strategy: "verbatim-lines",
		promptVersion: 7,
		parameters: { query: "clear" },
		form: "cleared",
		stats: {
			linesBefore: 10,
			linesDeleted: 10,
			linesKept: 0,
			rangeCount: 0,
			tokensBefore: 100,
			tokensAfter: 0,
			percentReduction: 100,
		},
	});

test("a delayed child inherits the settled launch turn after the parent clears again, without a full history read (#5594)", async () => {
	const store = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(store, process.cwd());
		await parent.appendModelChange("anthropic", "chosen");
		await parent.appendThinkingLevelChange("high");
		for (let i = 0; i < 128; i++) await parent.appendMessage({ role: "user", content: `retired ${i}`, timestamp: i });
		await clear(parent);
		await parent.appendMessage({ role: "user", content: "my launch task", timestamp: 200 });
		const atLaunch = parent.buildSessionContext();
		await parent.appendMessage({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "signed", thinkingSignature: "signature" },
				{ type: "toolCall", id: "new", name: "subagent", arguments: {} },
			],
			api: "anthropic-messages",
			model: "chosen",
			provider: "anthropic",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 201,
		});
		const launch = createForkContextResolver(parent, "fork");
		await clear(parent);
		await parent.appendMessage({ role: "user", content: "after launch", timestamp: 202 });
		const reads = vi.spyOn(store, "load");
		const child = await launch.sessionManagerForIndex(1);
		assert.ok(child);
		assert.deepEqual(child.buildSessionContext(), atLaunch);
		assert.equal(reads.mock.calls.length, 0);
		assert.ok(child.getEntries().length < 10);
	} finally {
		await store.close();
	}
});

test("a launch releases a completed child's manager, but a retry reopens the same child (#5594)", async () => {
	const store = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(store, process.cwd());
		await parent.appendMessage({ role: "user", content: "task", timestamp: 1 });
		const launch = createForkContextResolver(parent, "fork");
		const previous = await (async () => {
			const child = await launch.sessionManagerForIndex(0);
			assert.ok(child);
			const marker = await child.appendMessage({
				role: "user",
				content: "already worked in this fork",
				timestamp: 2,
			});
			return { id: child.getSessionId(), marker, ref: new WeakRef(child) };
		})();
		await collectGarbage();
		assert.equal(previous.ref.deref(), undefined);
		const [retry, same] = await Promise.all([launch.sessionManagerForIndex(0), launch.sessionManagerForIndex(0)]);
		assert.ok(retry);
		assert.equal(retry, same);
		assert.equal(retry.getSessionId(), previous.id);
		assert.equal(retry.getLeafId(), previous.marker);
	} finally {
		await store.close();
	}
});

test("forked children inherit request content without acquiring parent-owned deliveries or superseded tool output (#5594)", async () => {
	const store = new MemorySessionStore();
	try {
		const parent = await SessionManager.create(store, process.cwd());
		const old = await parent.appendMessage({ role: "user", content: "raw superseded content", timestamp: 0 });
		await parent.appendContextEdit(old, { content: "reduced" });
		await parent.appendCustomEntry("subagent-child", { childId: "parent-child" });
		const shopping = await parent.appendCustomMessageEntry("task.shopping-list", "milk", true, {
			rendererSetting: "highlight",
		});
		await parent.appendMessage({
			role: "bashExecution",
			command: "private operator command",
			output: "private operator output",
			excludeFromContext: true,
			exitCode: 0,
			cancelled: false,
			truncated: false,
			timestamp: 2,
		});
		await parent.appendCustomMessageEntry(
			"intercom_message",
			"visible reply",
			true,
			{ message: { id: "parent-delivery" } },
			false,
			{ delivery: "followUp" },
			"parent-key",
		);
		const before = await store.load(parent.getSessionId());
		const child = await createForkContextResolver(parent, "fork").sessionManagerForIndex(0);
		assert.ok(child);
		assert.deepEqual(
			convertToLlm(child.buildSessionContext().messages),
			convertToLlm(parent.buildSessionContext().messages),
		);
		const rows = (await store.load(child.getSessionId())).entries;
		assert.ok(!JSON.stringify(rows).includes("parent-delivery"));
		assert.ok(!JSON.stringify(rows).includes("private operator output"));
		const copied = child.getEntry(shopping);
		assert.ok(copied?.type === "custom_message");
		assert.deepEqual(
			[copied.customType, copied.display, copied.details],
			["task.shopping-list", true, { rendererSetting: "highlight" }],
		);
		assert.ok(!JSON.stringify(rows).includes("raw superseded content"));
		assert.ok(!rows.some((e) => e.type === "custom" && e.customType === "subagent-child"));
		assert.deepEqual(await store.load(parent.getSessionId()), before);
	} finally {
		await store.close();
	}
});
