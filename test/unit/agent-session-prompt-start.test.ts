import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { _runAgentPrompt } from "../../packages/coding-agent/src/core/agent-session-prompt.js";

import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";

describe("AgentSession prompt-start handshake", () => {
	test("reports prompt ownership only after agent.prompt is invoked and before the turn settles", async () => {
		const turn = Promise.withResolvers<void>();
		const events: string[] = [];
		let streaming = false;
		const session = {
			_pendingCustomMessages: [],
			_pendingToolNames: new Set<string>(),
			_flushPendingCustomMessages() {},
			agent: {
				prompt() {
					events.push("agent.prompt");
					streaming = true;
					return turn.promise;
				},
			},
			get isStreaming() {
				return streaming;
			},
			async waitForRetry() {
				events.push("retry-complete");
			},
			async _continueQueuedAgentMessages() {
				events.push("queues-complete");
			},
			async _awaitPendingPostCompactionContinuation() {
				events.push("compaction-complete");
			},
			_runSystemPromptOptions: "override" as string | undefined,
		};

		const running = _runAgentPrompt.call(session as never, [], () => events.push("prompt-started"));

		assert.deepEqual(events, ["agent.prompt", "prompt-started"]);
		assert.equal(session._runSystemPromptOptions, "override");

		turn.resolve();
		await running;
		assert.deepEqual(events, [
			"agent.prompt",
			"prompt-started",
			"retry-complete",
			"queues-complete",
			"compaction-complete",
		]);
		assert.equal(session._runSystemPromptOptions, undefined);
	});

	test("does not report prompt ownership when agent.prompt throws synchronously", async () => {
		let promptStarted = false;
		const session = {
			_pendingCustomMessages: [],
			_pendingToolNames: new Set<string>(),
			_flushPendingCustomMessages() {},
			agent: {
				prompt() {
					throw new Error("startup failed");
				},
			},
			isStreaming: false,
			abortSessionSummary: () => {},
			async waitForRetry() {},
			async _continueQueuedAgentMessages() {},
			async _awaitPendingPostCompactionContinuation() {},
			_runSystemPromptOptions: "override" as string | undefined,
		};

		await assert.rejects(
			_runAgentPrompt.call(session as never, [], () => {
				promptStarted = true;
			}),
			/startup failed/,
		);
		assert.equal(promptStarted, false);
		assert.equal(session._runSystemPromptOptions, undefined);
	});

	test("does not report prompt ownership when startup rejects before streaming", async () => {
		let promptStarted = false;
		const session = {
			_pendingCustomMessages: [],
			_pendingToolNames: new Set<string>(),
			_flushPendingCustomMessages() {},
			agent: { prompt: () => Promise.reject(new Error("startup rejected")) },
			isStreaming: false,
			abortSessionSummary: () => {},
			async waitForRetry() {},
			async _continueQueuedAgentMessages() {},
			async _awaitPendingPostCompactionContinuation() {},
			_runSystemPromptOptions: "override" as string | undefined,
		};

		await assert.rejects(
			_runAgentPrompt.call(session as never, [], () => {
				promptStarted = true;
			}),
			/startup rejected/,
		);
		assert.equal(promptStarted, false);
		assert.equal(session._runSystemPromptOptions, undefined);
	});
});

test("an async extension input handler reports its preflight disposition once, after handling the prompt", async () => {
	const handlerStarted = Promise.withResolvers<void>();
	const finishHandler = Promise.withResolvers<void>();
	const events: string[] = [];
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("input", async () => {
					events.push("handler started");
					handlerStarted.resolve();
					await finishHandler.promise;
					events.push("handler finished");
					return { action: "handled" };
				});
			},
		],
	});
	try {
		const accepted = harness.session.prompt("handle this locally", {
			preflightResult: (success, disposition) => events.push(`${success}:${disposition}`),
		});
		await handlerStarted.promise;
		assert.deepEqual(events, ["handler started"]);
		finishHandler.resolve();
		await accepted;
		assert.deepEqual(events, ["handler started", "handler finished", "true:handled"]);
		assert.equal(harness.eventsOfType("agent_start").length, 0);
	} finally {
		finishHandler.resolve();
		await harness.cleanup();
	}
});
