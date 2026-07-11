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
			allowIntercomDetach: true,
			intercomEvents: events,
			onUpdate: () => reportToolStart?.(),
			onDetachedExit: () => { detachedExitCalls += 1; },
		});

		await toolStarted;
		events.emit(INTERCOM_DETACH_REQUEST_EVENT, { requestId: "detach-1" });
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
