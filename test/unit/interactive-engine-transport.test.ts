import { test } from "bun:test";
import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { runSynchronousCallback, setCallbackActivityReporter } from "../../packages/coding-agent/src/core/callback-activity.ts";
import { ActivityWatchdog, shouldRenderEngineDiagnosticAsChatError, type ActivityWatchdogDiagnostic } from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import { BoundedWriter } from "../../packages/coding-agent/src/modes/rpc/bounded-writer.ts";
import { attachJsonlLineReader } from "../../packages/coding-agent/src/modes/rpc/jsonl.ts";

class SlowWritable extends Writable {
	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		setTimeout(callback, 2);
	}
}

test("interactive JSONL limits UTF-8 bytes and preserves the following frame", async () => {
	const oversized = JSON.stringify({ value: "🙂".repeat(300_000) });
	const stream = Readable.from([`${oversized}\n{"type":"terminal"}\n`]);
	const lines: string[] = [];
	let violations = 0;
	attachJsonlLineReader(stream, (line) => lines.push(line), {
		maxFrameBytes: 1_048_576,
		maxBytesPerTurn: 128 * 1024,
		onOversizedLine: () => { violations += 1; },
	});
	await new Promise<void>((resolve) => stream.once("end", () => setTimeout(resolve, 10)));
	assert.equal(violations, 1);
	assert.deepEqual(lines, ['{"type":"terminal"}']);
});

test("bounded writer applies byte admission pressure without losing critical frames", async () => {
	const writer = new BoundedWriter(new SlowWritable(), { maxFrameBytes: 1024, maxQueuedBytes: 2048 });
	const writes: Promise<void>[] = [];
	let peak = 0;
	for (let index = 0; index < 100; index += 1) {
		writes.push(writer.write(`${JSON.stringify({ index, value: "x".repeat(400) })}\n`));
		peak = Math.max(peak, writer.pendingBytes);
	}
	await Promise.all(writes);
	assert.ok(peak <= 2048, `queued ${peak} bytes`);
});

test("activity watchdog retains nested and concurrent attribution", async () => {
	let now = 0;
	const diagnostics: ActivityWatchdogDiagnostic[] = [];
	const watchdog = new ActivityWatchdog({
		now: () => now,
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		thresholds: { diagnosticMs: 10, unresponsiveMs: 20, pollMs: 1 },
	});
	watchdog.activityStarted({ id: "outer", kind: "workflow.run", name: "outer", startedAt: 0 });
	watchdog.activityStarted({ id: "inner-a", kind: "workflow.ctx_tool", name: "a", startedAt: 1 });
	watchdog.activityStarted({ id: "inner-b", kind: "workflow.stage_adapter", name: "b", startedAt: 2 });
	watchdog.activityFinished("inner-a");
	watchdog.start();
	now = 12;
	await Bun.sleep(5);
	assert.equal(diagnostics[0]?.activity?.id, "inner-b");
	watchdog.activityFinished("inner-b");
	watchdog.heartbeat();
	now = 24;
	await Bun.sleep(5);
	assert.equal(diagnostics.at(-1)?.activity?.id, "outer");
	watchdog.stop();
});

test("watchdog diagnostics are tagged with their source at both thresholds", async () => {
	let now = 0;
	const diagnostics: ActivityWatchdogDiagnostic[] = [];
	const watchdog = new ActivityWatchdog({
		now: () => now,
		onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
		thresholds: { diagnosticMs: 10, unresponsiveMs: 20, pollMs: 1 },
	});
	watchdog.start();
	now = 12;
	await Bun.sleep(5);
	now = 24;
	await Bun.sleep(5);
	watchdog.stop();
	assert.deepEqual(diagnostics.map((diagnostic) => diagnostic.level), ["blocking", "unresponsive"]);
	for (const diagnostic of diagnostics) {
		assert.equal(diagnostic.source, "watchdog");
		assert.match(diagnostic.message, /Engine callback unknown callback has not yielded/);
	}
});

test("chat-error policy: watchdog diagnostics stay internal while concrete failures surface", () => {
	const activity = { id: "a1", kind: "extension.hook" as const, name: "tool_execution_end", startedAt: 0 };
	const diagnostic = (
		overrides: Partial<ActivityWatchdogDiagnostic>,
	): ActivityWatchdogDiagnostic => ({
		activity: undefined,
		elapsedMs: 1_011,
		level: "unresponsive",
		message: "Engine callback unknown callback has not yielded for 1011 ms; Esc interrupt · Ctrl+C terminate",
		...overrides,
	});

	// Heartbeat-watchdog gaps stay internal whether or not a callback was attributed.
	assert.equal(shouldRenderEngineDiagnosticAsChatError(diagnostic({ source: "watchdog" })), false);
	assert.equal(shouldRenderEngineDiagnosticAsChatError(diagnostic({
		source: "watchdog",
		activity,
		message: "Engine callback extension.hook tool_execution_end has not yielded for 1011 ms; Esc interrupt · Ctrl+C terminate",
	})), false);
	// Early 250 ms blocking signals stay internal regardless of attribution.
	assert.equal(shouldRenderEngineDiagnosticAsChatError(diagnostic({ source: "watchdog", level: "blocking" })), false);
	assert.equal(shouldRenderEngineDiagnosticAsChatError(diagnostic({ source: "watchdog", activity, level: "blocking" })), false);
	// Concrete termination and RPC failures are not watchdog-sourced and always surface.
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(diagnostic({
			elapsedMs: 0,
			message: "Engine terminated; engine callback result unknown; inspect side effects before retrying",
		})),
		true,
	);
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(diagnostic({ elapsedMs: 0, message: "Interactive engine set steering mode failed: closed" })),
		true,
	);
});

test.serial("synchronous callback publishes activity before entering user code", () => {
	let started = false;
	setCallbackActivityReporter({ started: () => { started = true; }, finished: () => {} });
	try {
		runSynchronousCallback({ kind: "tool.prepare", name: "sync" }, () => {
			assert.equal(started, true);
		});
	} finally {
		setCallbackActivityReporter(undefined);
	}
});
