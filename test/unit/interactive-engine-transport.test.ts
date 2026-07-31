import assert from "node:assert/strict";
import { Readable, Writable } from "node:stream";
import { test } from "vitest";
import {
	runSynchronousCallback,
	setCallbackActivityReporter,
} from "../../packages/coding-agent/src/core/callback-activity.ts";
import { isEngineSendFailure } from "../../packages/coding-agent/src/modes/interactive/interactive-prompt-restore.ts";
import {
	ActivityWatchdog,
	type ActivityWatchdogDiagnostic,
	shouldRenderEngineDiagnosticAsChatError,
} from "../../packages/coding-agent/src/modes/interactive-engine/activity-watchdog.ts";
import { attachJsonlLineReader } from "../../packages/coding-agent/src/modes/rpc/jsonl.ts";
import { QueuedWriter } from "../../packages/coding-agent/src/modes/rpc/queued-writer.ts";
import { isRpcTransportFailure } from "../../packages/coding-agent/src/modes/rpc/rpc-transport-error.ts";
import { sleep } from "../helpers/runtime.js";

class SlowWritable extends Writable {
	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		setTimeout(callback, 2);
	}
}

/** A writable that hands its `_write` callback back so a test can fail it. */
class ControlledWritable extends Writable {
	private callbacks: Array<(error?: Error | null) => void> = [];
	constructor() {
		super();
		// Failing a write callback destroys the stream and emits 'error'; the real
		// client attaches its own handler, so mirror that instead of crashing.
		this.on("error", () => {});
	}
	_write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.callbacks.push(callback);
	}
	failActive(error: Error): void {
		const callback = this.callbacks.shift();
		assert.ok(callback, "expected an in-flight write");
		callback(error);
	}
}

/**
 * A raw stream error is what a dying engine actually produces — `write EPIPE`,
 * `Cannot call write after a stream was destroyed` — and none of those messages
 * ever matched the host's send-failure text list, so a submission that failed
 * this way was reported as a red error and discarded. The transport boundary
 * classifies it instead, keeping the native error, its identity, and its `code`.
 */
test("a writer callback failure rejects every frame as a classified transport failure", async () => {
	const stream = new ControlledWritable();
	const writer = new QueuedWriter(stream);
	const first = writer.write('{"type":"prompt"}\n');
	const second = writer.write('{"type":"abort"}\n');
	await sleep(0);

	const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE", errno: -32, syscall: "write" });
	stream.failActive(epipe);

	for (const [label, pending] of [
		["active", first],
		["queued", second],
	] as const) {
		const error = await pending.then(
			() => undefined,
			(reason: unknown) => reason,
		);
		assert.ok(isRpcTransportFailure(error), `${label} frame was not classified as a transport failure`);
		assert.equal((error as { code?: string }).code, "EPIPE", `${label} frame lost its native code`);
		assert.equal(error, epipe, `${label} frame lost the original error identity`);
		assert.equal(isEngineSendFailure(error), true, `${label} frame would not restore the draft`);
	}
	assert.equal(writer.pendingBytes, 0);

	// The writer stays closed with the same classified error.
	const later = await writer.write('{"type":"prompt"}\n').then(
		() => undefined,
		(reason: unknown) => reason,
	);
	assert.ok(isRpcTransportFailure(later));
	assert.equal(writer.offerLatest("render:remote_component_1", "frame\n"), false);
});

test("a non-Error write rejection is wrapped without losing its cause or code", async () => {
	const stream = new ControlledWritable();
	const writer = new QueuedWriter(stream);
	const pending = writer.write('{"type":"prompt"}\n');
	await sleep(0);
	stream.failActive(
		Object.freeze(
			Object.assign(new Error("Cannot call write after a stream was destroyed"), { code: "ERR_STREAM_DESTROYED" }),
		) as Error,
	);
	const error = await pending.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	assert.ok(isRpcTransportFailure(error));
	assert.equal((error as { code?: string }).code, "ERR_STREAM_DESTROYED");
	assert.equal((error as { cause?: unknown }).cause instanceof Error, true, "the original error must be retained");
});

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
