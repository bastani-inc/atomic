import assert from "node:assert/strict";
import { type AgentRehydrateError, AgentWakeDispatcher } from "@bastani/atomic";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import {
	pendingToolCalls,
	subagentWakeKey,
	subagentWakeNamespace,
	wakeReleasedChildWithHeldResults,
} from "../../packages/subagents/src/runs/foreground/released-children.js";

async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn++) await new Promise((resolve) => setImmediate(resolve));
}

test("the end of one run hands what its child holds over as one wake that carries no result of its own (#4326)", async () => {
	const dispatcher = new AgentWakeDispatcher();
	const seen: string[] = [];
	dispatcher.handle(subagentWakeNamespace("owner"), async (key, wakes) => {
		for (const wake of wakes) seen.push(`${key}|${wake.kind}|${wake.id}|${wake.toolResult === undefined}`);
	});

	wakeReleasedChildWithHeldResults(dispatcher, subagentWakeKey("owner", "run:0"), "task-1");
	wakeReleasedChildWithHeldResults(dispatcher, subagentWakeKey("owner", "run:0"), "task-1");
	await settle();

	assert.deepEqual(seen, ["subagents/owner:run:0|tool-result|held-results:task-1|true"]);
});

test("a held wake nobody handles is reported (#4326)", async () => {
	const failures: AgentRehydrateError[] = [];
	const dispatcher = new AgentWakeDispatcher({ onUnobservedFailure: (error) => failures.push(error) });

	wakeReleasedChildWithHeldResults(dispatcher, "subagents/gone:run:0", "task-9");
	await settle();
	assert.equal(failures.length, 1);
	assert.equal(failures[0]?.code, "no-wake-handler");
});

function assistant(content: object[], stopReason: string): Parameters<SessionManager["appendMessage"]>[0] {
	return {
		role: "assistant",
		content,
		api: "faux",
		provider: "faux",
		model: "faux",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 2,
	} as Parameters<SessionManager["appendMessage"]>[0];
}

test("calls of an assistant turn that did not stop on tool use are not pending (#4326)", async () => {
	for (const stopReason of ["stop", "aborted", "error", "length"]) {
		const manager = SessionManager.inMemory("/repo");
		await manager.appendMessage({ role: "user", content: "go", timestamp: 1 });
		await manager.appendMessage(
			assistant([{ type: "toolCall", id: "ci-1", name: "wait_for_ci", arguments: {} }], stopReason),
		);
		assert.deepEqual([...pendingToolCalls(manager)], [], stopReason);
	}
});
