import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "vitest";
import {
	runSynchronousCallback,
	setCallbackActivityReporter,
} from "../../packages/coding-agent/src/core/callback-activity.ts";
import {
	ActivityWatchdog,
	type ActivityWatchdogDiagnostic,
	shouldRenderEngineDiagnosticAsChatError,
} from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import { attachJsonlLineReader } from "../../packages/coding-agent/src/modes/rpc/jsonl.ts";
import { QueuedWriter } from "../../packages/coding-agent/src/modes/rpc/queued-writer.ts";
import { sleep } from "../helpers/runtime.js";

class SlowWritable extends Writable {
	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		setTimeout(callback, 2);
	}
}

test("interactive JSONL preserves large UTF-8 frames", async () => {
	const large = JSON.stringify({ value: "🙂".repeat(300_000) });
	const stream = Readable.from([`${large}\n{"type":"terminal"}\n`]);
	const lines: string[] = [];
	await new Promise<void>((resolve) => {
		attachJsonlLineReader(
			stream,
			(line) => {
				lines.push(line);
				if (lines.length === 2) resolve();
			},
			{ maxBytesPerTurn: 128 * 1024 },
		);
	});
	assert.equal(lines[0], large);
	assert.equal(lines[1], '{"type":"terminal"}');
});

test("queued writer preserves large critical frames", async () => {
	const writer = new QueuedWriter(new SlowWritable());
	const writes = [writer.write(`${JSON.stringify({ value: "x".repeat(2 * 1024 * 1024) })}\n`)];
	for (let index = 0; index < 100; index += 1) {
		writes.push(writer.write(`${JSON.stringify({ index, value: "x".repeat(400) })}\n`));
	}
	await Promise.all(writes);
	assert.equal(writer.pendingBytes, 0);
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
	await sleep(5);
	assert.equal(diagnostics[0]?.activity?.id, "inner-b");
	watchdog.activityFinished("inner-b");
	watchdog.heartbeat();
	now = 24;
	await sleep(5);
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
	await sleep(5);
	now = 24;
	await sleep(5);
	watchdog.stop();
	assert.deepEqual(
		diagnostics.map((diagnostic) => diagnostic.level),
		["blocking", "unresponsive"],
	);
	for (const diagnostic of diagnostics) {
		assert.equal(diagnostic.source, "watchdog");
		assert.match(diagnostic.message, /Engine callback unknown callback has not yielded/);
	}
});

test("chat-error policy: watchdog diagnostics stay internal while concrete failures surface", () => {
	const activity = { id: "a1", kind: "extension.hook" as const, name: "tool_execution_end", startedAt: 0 };
	const diagnostic = (overrides: Partial<ActivityWatchdogDiagnostic>): ActivityWatchdogDiagnostic => ({
		activity: undefined,
		elapsedMs: 1_011,
		level: "unresponsive",
		message: "Engine callback unknown callback has not yielded for 1011 ms; Esc interrupt · Ctrl+C terminate",
		...overrides,
	});

	// Heartbeat-watchdog gaps stay internal whether or not a callback was attributed.
	assert.equal(shouldRenderEngineDiagnosticAsChatError(diagnostic({ source: "watchdog" })), false);
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(
			diagnostic({
				source: "watchdog",
				activity,
				message:
					"Engine callback extension.hook tool_execution_end has not yielded for 1011 ms; Esc interrupt · Ctrl+C terminate",
			}),
		),
		false,
	);
	// Early 250 ms blocking signals stay internal regardless of attribution.
	assert.equal(shouldRenderEngineDiagnosticAsChatError(diagnostic({ source: "watchdog", level: "blocking" })), false);
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(diagnostic({ source: "watchdog", activity, level: "blocking" })),
		false,
	);
	// Engine recovery status is operational, not a failure: the death teardown has
	// already restored the editor, so it must never render as a chat error.
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(
			diagnostic({
				source: "recovery",
				level: "blocking",
				elapsedMs: 0,
				message: "Interactive engine stopped unexpectedly; restarting.",
			}),
		),
		false,
	);
	// Concrete failures carry no operational source and always surface.
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(
			diagnostic({
				elapsedMs: 0,
				message: "Interactive engine restart failed: Agent process exited (code=1 signal=null). Stderr: ",
			}),
		),
		true,
	);
	assert.equal(
		shouldRenderEngineDiagnosticAsChatError(
			diagnostic({ elapsedMs: 0, message: "Interactive engine set steering mode failed: closed" }),
		),
		true,
	);
});

test.sequential("synchronous callback publishes activity before entering user code", () => {
	let started = false;
	setCallbackActivityReporter({
		started: () => {
			started = true;
		},
		finished: () => {},
	});
	try {
		runSynchronousCallback({ kind: "tool.prepare", name: "sync" }, () => {
			assert.equal(started, true);
		});
	} finally {
		setCallbackActivityReporter(undefined);
	}
});
