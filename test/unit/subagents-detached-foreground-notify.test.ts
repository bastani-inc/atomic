import { test } from "bun:test";
import assert from "node:assert/strict";
import registerSubagentNotify from "../../packages/subagents/src/runs/background/notify.js";
import { notifyDetachedForegroundChildExit } from "../../packages/subagents/src/runs/foreground/subagent-executor-status.js";
import type { SingleResult } from "../../packages/subagents/src/shared/types.js";

function createHarness() {
	const listeners = new Map<string, Set<(data: unknown) => void>>();
	const sent: { customType: string; content: string }[] = [];
	const pi = {
		events: {
			on(event: string, handler: (data: unknown) => void) {
				const set = listeners.get(event) ?? new Set();
				set.add(handler);
				listeners.set(event, set);
				return () => set.delete(handler);
			},
			emit(event: string, payload: unknown) {
				for (const handler of listeners.get(event) ?? []) handler(payload);
			},
		},
		sendMessage(message: { customType: string; content: string }) {
			sent.push(message);
		},
	};
	return { pi, sent };
}

function makeResult(overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		agent: "codebase-analyzer",
		task: "audit",
		exitCode: 0,
		usage: {} as SingleResult["usage"],
		finalOutput: "Findings report content",
		sessionFile: "/tmp/sessions/child-0.jsonl",
		...overrides,
	};
}

test("detached foreground child exit delivers a completion notice to the parent session", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);

	notifyDetachedForegroundChildExit({
		pi: harness.pi as never,
		runId: "run-detach-1",
		mode: "parallel",
		index: 1,
		totalTasks: 4,
		result: makeResult(),
	});

	assert.equal(harness.sent.length, 1, "one notification is delivered");
	const message = harness.sent[0]!;
	assert.equal(message.customType, "subagent-notify");
	assert.match(message.content, /^Detached subagent task completed: \*\*codebase-analyzer\*\* \(2\/4\)/);
	assert.match(message.content, /Findings report content/);
	assert.match(message.content, /Session file: \/tmp\/sessions\/child-0\.jsonl/);
	unregister();
});

test("detached foreground completion notices dedupe per run and child index", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);
	const input = {
		pi: harness.pi as never,
		runId: "run-detach-2",
		mode: "single" as const,
		index: 0,
		result: makeResult(),
	};

	notifyDetachedForegroundChildExit(input);
	notifyDetachedForegroundChildExit(input);
	assert.equal(harness.sent.length, 1, "duplicate child exits deliver a single notice");

	notifyDetachedForegroundChildExit({ ...input, runId: "run-detach-3" });
	assert.equal(harness.sent.length, 2, "a different run still notifies");
	unregister();
});

test("failed and interrupted detached children report failed/paused status", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);

	notifyDetachedForegroundChildExit({
		pi: harness.pi as never,
		runId: "run-detach-4",
		mode: "chain",
		index: 0,
		result: makeResult({ exitCode: 1, error: "boom" }),
	});
	assert.match(harness.sent[0]!.content, /^Detached subagent task failed: \*\*codebase-analyzer\*\*/);
	assert.match(harness.sent[0]!.content, /boom/);

	notifyDetachedForegroundChildExit({
		pi: harness.pi as never,
		runId: "run-detach-5",
		mode: "single",
		index: 0,
		result: makeResult({ interrupted: true }),
	});
	assert.match(harness.sent[1]!.content, /^Detached subagent task paused: \*\*codebase-analyzer\*\*/);
	unregister();
});

test("async background notifications keep their original heading", () => {
	const harness = createHarness();
	const unregister = registerSubagentNotify(harness.pi as never);
	harness.pi.events.emit("subagent:async-complete", {
		id: "async-run",
		agent: "worker",
		success: true,
		summary: "done",
		timestamp: Date.now(),
	});
	assert.equal(harness.sent.length, 1);
	assert.match(harness.sent[0]!.content, /^Background task completed: \*\*worker\*\*/);
	unregister();
});
