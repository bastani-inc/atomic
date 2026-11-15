import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test, vi } from "vitest";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import type { RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness, getAssistantTexts, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.cleanup();
	harness = undefined;
});

async function rpcSession() {
	harness = await createHarness();
	const { session } = harness;
	const responses: RpcResponse[] = [];
	const handle = createRpcCommandHandler({
		runtimeHost: {} as never,
		getSession: () => session,
		rebindSession: async () => {},
		output: (record) => responses.push(record as RpcResponse),
	});
	/** The disposition the prompt was answered with, once its preflight settles. */
	const prompt = async (id: string, message: string) => {
		await handle({ id, type: "prompt", message });
		await vi.waitFor(() => assert.ok(responses.some((response) => response.id === id)));
		const response = responses.find((candidate) => candidate.id === id);
		return response?.success ? (response.data as { disposition: string }).disposition : response;
	};
	return { session, harness, handle, prompt };
}

describe("RPC abort holds queued messages like the TUI (#5166)", () => {
	test("abort holds the queue and the next prompt releases it and starts a turn (#5166)", async () => {
		const { session, harness, handle, prompt } = await rpcSession();
		harness.setResponses([fauxAssistantMessage("answered")]);

		assert.equal((await handle({ id: "stop", type: "abort" }))?.success, true);
		assert.equal(session.queuedMessagesPaused, true, "abort establishes the queue hold");

		assert.equal(await prompt("ask", "hello"), "started");
		await session.agent.waitForIdle();
		assert.deepEqual(
			{ paused: session.queuedMessagesPaused, replies: getAssistantTexts(harness) },
			{ paused: false, replies: ["answered"] },
		);
	});

	test("a queue hold the client set explicitly survives an abort and keeps the next prompt queued (#5166)", async () => {
		const { session, handle, prompt } = await rpcSession();

		await handle({ id: "hold", type: "pause_queued_messages" });
		await handle({ id: "stop", type: "abort" });

		assert.equal(await prompt("ask", "hello"), "queued");
		assert.equal(session.queuedMessagesPaused, true);
	});

	test("a client that takes over the hold after an abort keeps its prompts queued (#5166)", async () => {
		const { session, handle, prompt } = await rpcSession();

		await handle({ id: "stop", type: "abort" });
		await handle({ id: "hold", type: "pause_queued_messages" });

		assert.equal(await prompt("ask", "hello"), "queued");
		assert.equal(session.queuedMessagesPaused, true);
	});

	test("after the client resumes and pauses again, a prompt stays queued (#5166)", async () => {
		const { session, handle, prompt } = await rpcSession();

		await handle({ id: "stop", type: "abort" });
		await handle({ id: "release", type: "resume_queued_messages" });
		session.pauseQueuedMessages();

		assert.equal(await prompt("ask", "hello"), "queued");
	});
});
