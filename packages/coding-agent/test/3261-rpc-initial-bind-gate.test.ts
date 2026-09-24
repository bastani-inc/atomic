import assert from "node:assert/strict";
import { afterEach, describe, it, vi } from "vitest";
import { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

async function createRuntime(harness: Harness) {
	return new AgentSessionRuntime(
		harness.session,
		{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
	);
}

describe("RPC initial extension bind gate (#3261)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("holds a prompt arriving before the initial extension bind completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const prompt = vi.spyOn(harness.session, "prompt").mockImplementation(async (_text, options) => {
			options?.preflightResult?.(true);
		});
		const gate = deferred<void>();
		let bindReady = false;
		const runtime = await createRuntime(harness);
		const output = vi.fn();
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output,
			waitForInitialBind: () => (bindReady ? undefined : gate.promise),
		});

		const handled = handle({ id: "early-prompt", type: "prompt", message: "hello" });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(prompt.mock.calls.length, 0, "prompt must not reach the session before the bind gate resolves");

		bindReady = true;
		gate.resolve();
		await handled;
		await vi.waitFor(() => assert.equal(prompt.mock.calls.length, 1));
		assert.equal(prompt.mock.calls[0]?.[0], "hello");
	});

	it("holds steer and follow_up arriving before the initial extension bind completes", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const steer = vi.spyOn(harness.session, "steer").mockResolvedValue();
		const followUp = vi.spyOn(harness.session, "followUp").mockResolvedValue();
		const gate = deferred<void>();
		let bindReady = false;
		const runtime = await createRuntime(harness);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: vi.fn(),
			waitForInitialBind: () => (bindReady ? undefined : gate.promise),
		});

		const steerHandled = handle({ id: "steer-1", type: "steer", message: "steer text" });
		const followUpHandled = handle({ id: "follow-1", type: "follow_up", message: "follow up text" });
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(steer.mock.calls.length, 0);
		assert.equal(followUp.mock.calls.length, 0);

		bindReady = true;
		gate.resolve();
		await steerHandled;
		await followUpHandled;
		assert.equal(steer.mock.calls.length, 1);
		assert.equal(followUp.mock.calls.length, 1);
	});

	it("does not gate control commands behind the initial extension bind", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const gate = deferred<void>();
		const runtime = await createRuntime(harness);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => harness.session,
			rebindSession: async () => {},
			output: vi.fn(),
			waitForInitialBind: () => gate.promise,
		});

		const response = await handle({ id: "state", type: "get_state" });
		assert.equal(response?.success, true);
	});
});
