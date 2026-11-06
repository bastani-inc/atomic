import assert from "node:assert/strict";
import { AgentSessionBusyError, type AgentSessionEvent } from "@bastani/atomic";
import { test, vi } from "vitest";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";

const trace = vi.hoisted(() => vi.fn());
vi.mock("../../packages/workflows/src/workers/pooled-watch-trace.js", () => ({
	tracePooledWatch: trace,
	configurePooledWatchTrace: () => {},
}));

const { admitStageUserMessage } = await import("../../packages/workflows/src/workers/stage-watch.js");

test("a queued steer whose queueing call fails later traces that failure's type and code, not its text (#4327)", async () => {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let failQueueing: (error: Error) => void = () => {};
	const handle: StageControlHandle = {
		runId: "child",
		stageId: "stage",
		stageName: "stage",
		status: "running",
		sessionId: "session",
		sessionFile: undefined,
		isStreaming: true,
		messages: [],
		ensureAttached: async () => {},
		prompt: async () => {},
		steer: () => {
			for (const listener of listeners)
				listener({ type: "queue_update", steering: ["text"], followUp: [] } as never as AgentSessionEvent);
			return new Promise<void>((_resolve, reject) => {
				failQueueing = reject;
			});
		},
		followUp: async () => {},
		pause: async () => {},
		resume: async () => undefined,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};

	assert.deepEqual(await admitStageUserMessage(handle, "text", "steer", undefined), { action: "steer" });
	failQueueing(new AgentSessionBusyError());
	const settled = () => trace.mock.calls.filter(([step]) => step === "worker.deliver.queue-call-settled");
	await vi.waitFor(() => assert.equal(settled().length, 1));
	assert.deepEqual(settled()[0], [
		"worker.deliver.queue-call-settled",
		{ intent: "steer", ok: false, error: "AgentSessionBusyError", code: "agent_session_busy" },
	]);
});
