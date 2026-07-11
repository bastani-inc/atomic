import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.js";
import {
	INTERCOM_DETACH_REQUEST_EVENT,
	type IntercomEventBus,
} from "../../packages/subagents/src/shared/types.js";
import { agentConfig, withFakeCli } from "./subagents-attempt-watchdog-helpers.js";

class TestEventBus implements IntercomEventBus {
	private readonly handlers = new Map<string, Set<(data: unknown) => void>>();

	on(channel: string, handler: (data: unknown) => void): () => void {
		const listeners = this.handlers.get(channel) ?? new Set();
		listeners.add(handler);
		this.handlers.set(channel, listeners);
		return () => listeners.delete(handler);
	}

	emit(channel: string, data: unknown): void {
		for (const handler of this.handlers.get(channel) ?? []) handler(data);
	}
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
		await Bun.sleep(10);
	}
}

test("intercom detach returns before child close and reports detached exit exactly once", async () => {
	await withFakeCli(`
		const fs = require("node:fs");
		const path = require("node:path");
		console.log(JSON.stringify({ type: "tool_execution_start", toolName: "intercom", args: { action: "ask" } }));
		setTimeout(() => {
			fs.writeFileSync(path.join(process.cwd(), "child-closed"), "closed");
		}, 300);
	`, async (dir) => {
		const events = new TestEventBus();
		let detachedExitCalls = 0;
		let reportToolStart: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => { reportToolStart = resolve; });
		const resultPromise = runSync(dir, [agentConfig()], "fake-worker", "Do work", {
			cwd: dir,
			runId: "intercom-detach-lifecycle",
			intercomSessionName: "child-a",
			allowIntercomDetach: true,
			intercomEvents: events,
			onUpdate: () => reportToolStart?.(),
			onDetachedExit: () => { detachedExitCalls += 1; },
		});

		await toolStarted;
		const route = { requestId: "detach-1", messageId: "detach-1", childIntercomTarget: "child-a", senderId: "child-id", runtimeGeneration: 1 };
		events.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "probe" });
		events.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		const result = await resultPromise;

		assert.equal(result.detached, true);
		assert.equal(existsSync(join(dir, "child-closed")), false, "detach must return before child close");
		assert.equal(detachedExitCalls, 0);

		await waitFor(() => detachedExitCalls === 1);
		assert.equal(existsSync(join(dir, "child-closed")), true, "callback must follow actual child close");
		await Bun.sleep(50);
		assert.equal(detachedExitCalls, 1);
	});
});

test("detached close preserves a control interruption through finalization", async () => {
	await withFakeCli(`
		process.on("SIGINT", () => {
			setTimeout(() => {
				console.error("late failure after interruption");
				process.exit(7);
			}, 100);
		});
		console.log(JSON.stringify({ type: "tool_execution_start", toolName: "intercom", args: { action: "ask" } }));
		setInterval(() => {}, 1000);
	`, async (dir) => {
		const events = new TestEventBus();
		const interrupt = new AbortController();
		let recovered: Awaited<ReturnType<typeof runSync>> | undefined;
		let reportToolStart: (() => void) | undefined;
		const toolStarted = new Promise<void>((resolve) => { reportToolStart = resolve; });
		const resultPromise = runSync(dir, [agentConfig()], "fake-worker", "Do work", {
			cwd: dir,
			runId: "interrupted-detach-lifecycle",
			intercomSessionName: "child-a",
			allowIntercomDetach: true,
			intercomEvents: events,
			interruptSignal: interrupt.signal,
			onUpdate: () => reportToolStart?.(),
			onDetachedExit: (result) => { recovered = result; },
		});

		await toolStarted;
		interrupt.abort();
		const route = { requestId: "detach-interrupted", messageId: "detach-interrupted", childIntercomTarget: "child-a", senderId: "child-id", runtimeGeneration: 1 };
		events.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "probe" });
		events.emit(INTERCOM_DETACH_REQUEST_EVENT, { ...route, phase: "commit" });
		assert.equal((await resultPromise).detached, true);

		await waitFor(() => recovered !== undefined);
		assert.equal(recovered?.interrupted, true);
		assert.equal(recovered?.exitCode, 0);
		assert.equal(recovered?.error, undefined);
		assert.equal(recovered?.finalOutput, "Interrupted. Waiting for explicit next action.");
	});
});
