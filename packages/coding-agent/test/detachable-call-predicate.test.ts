import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { harnessPool, persistedManager, toolResultIds } from "./helpers/detached-tools.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

interface ModalTool {
	readonly definition: ToolDefinition;
	readonly started: string[];
	finish(text: string): void;
}

function modalTool(): ModalTool {
	const started: string[] = [];
	const pending: PromiseWithResolvers<AgentToolResult>[] = [];
	return {
		started,
		finish(text) {
			for (const deferred of pending.splice(0))
				deferred.resolve({ content: [{ type: "text", text }], details: undefined });
		},
		definition: {
			name: "shell",
			label: "Shell",
			description: "Runs a command, or waits for one",
			parameters: Type.Object({ mode: Type.Union([Type.Literal("run"), Type.Literal("wait")]) }),
			detachable: (params: { mode: "run" | "wait" }) => params.mode === "wait",
			execute: async (toolCallId, params: { mode: "run" | "wait" }) => {
				started.push(`${toolCallId}:${params.mode}`);
				const deferred = Promise.withResolvers<AgentToolResult>();
				pending.push(deferred);
				return deferred.promise;
			},
		},
	};
}

describe("a tool that detaches only some of its calls (#4326)", () => {
	test("a call the tool's predicate accepts detaches once the policy elapses", async () => {
		const tool = modalTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("shell", { mode: "wait" }, { id: "w-1" })], { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("wait for the build");

		assert.deepEqual(
			harness.session.takeDetachedToolCalls().map((call) => call.toolCallId),
			["w-1"],
		);
		assert.deepEqual(toolResultIds(harness.sessionManager), []);
	});

	test("a call the predicate refuses runs inline to its result however long it takes, even with a policy", async () => {
		const tool = modalTool();
		const harness = await pool.harnessWith([tool.definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("shell", { mode: "run" }, { id: "r-1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("built"),
		]);

		const run = harness.session.prompt("build it");
		for (let turn = 0; turn < 50 && tool.started.length === 0; turn++)
			await new Promise((resolve) => setImmediate(resolve));
		for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(toolResultIds(harness.sessionManager), [], "the run is still waiting on the call inline");
		tool.finish("ok");
		await run;

		assert.deepEqual(harness.session.takeDetachedToolCalls(), []);
		assert.deepEqual(toolResultIds(harness.sessionManager), ["r-1"]);
	});

	test("after a restart only the calls the predicate accepts are started again", async () => {
		const tool = modalTool();
		const { manager, store } = await persistedManager();
		await manager.appendMessage({ role: "user", content: "build and wait", timestamp: 1 });
		await manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "r-1", name: "shell", arguments: { mode: "run" } },
				{ type: "toolCall", id: "w-1", name: "shell", arguments: { mode: "wait" } },
			],
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
			stopReason: "toolUse",
			timestamp: 2,
		});

		const reopened = await pool.harnessWith(
			[tool.definition],
			await SessionManager.open(store, manager.getSessionId()),
		);
		const redispatched = reopened.session.redispatchDetachedToolCalls();
		await new Promise((resolve) => setImmediate(resolve));

		assert.deepEqual(
			redispatched.map((call) => call.toolCallId),
			["w-1"],
		);
		assert.deepEqual(tool.started, ["w-1:wait"], "the command that is not safe to run twice is not run again");
		for (const call of redispatched) call.abort("test over");
	});
});
