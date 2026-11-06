import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, onTestFinished, vi } from "vitest";
import {
	RPC_OUTPUT_AFTER_READY_TIMEOUT_MS,
	RPC_OUTPUT_POLL_INTERVAL_MS,
	type RpcBashOutputWaitClock,
	RpcBashOutputWaitError,
	realClock,
	waitForRpcBashOutput,
} from "./helpers/rpc-bash-output-wait.js";

/** Bounds the synchronous stall below so a child that never starts fails the test instead of freezing the worker. */
const CHILD_WRITE_STALL_LIMIT_MS = 60_000;

function manualClock(onDrain: () => void = () => {}) {
	const counts = { sleeps: 0, drains: 0 };
	let now = 0;
	const clock: RpcBashOutputWaitClock = {
		now: () => now,
		sleep: async (ms) => {
			counts.sleeps++;
			now += ms;
		},
		drainPendingIo: async () => {
			counts.drains++;
			onDrain();
		},
	};
	return { clock, counts, elapsed: () => now };
}

const unsettled = () => new Promise<object>(() => {});

async function failureOf(pending: Promise<void>): Promise<RpcBashOutputWaitError> {
	const error = await pending.then(
		() => undefined,
		(failure: Error) => failure,
	);
	assert.ok(error instanceof RpcBashOutputWaitError, `expected an RpcBashOutputWaitError, got ${String(error)}`);
	return error;
}

function fieldsOf(failure: RpcBashOutputWaitError) {
	const { reason, id, expectedPrefix, observed, settlement } = failure;
	return { reason, id, expectedPrefix, observed, settlement };
}

function stallUntil(done: () => boolean): void {
	const parked = new Int32Array(new SharedArrayBuffer(4));
	const limit = Date.now() + CHILD_WRITE_STALL_LIMIT_MS;
	while (!done()) {
		if (Date.now() > limit) throw new Error("the child never wrote its output");
		Atomics.wait(parked, 0, 0, 5);
	}
}

describe("waitForRpcBashOutput", () => {
	it("keeps waiting for a shell that has not signalled readiness, with no startup budget (#4477)", async () => {
		const { clock, counts, elapsed } = manualClock();
		const startupMs = 3 * RPC_OUTPUT_AFTER_READY_TIMEOUT_MS;
		await waitForRpcBashOutput({
			id: "slow-start",
			expectedPrefix: "before",
			observed: () => (elapsed() >= startupMs ? "beforeafter" : ""),
			execution: unsettled(),
			isReady: () => false,
			clock,
		});
		assert.deepEqual(counts, { sleeps: startupMs / RPC_OUTPUT_POLL_INTERVAL_MS, drains: 0 });
	});

	it("fails at the next poll with the response when the request settles before its prefix (#4477)", async () => {
		const { clock, counts } = manualClock();
		const response = { id: "exited", type: "response", success: true, data: { output: "", exitCode: 1 } };
		const failure = await failureOf(
			waitForRpcBashOutput({
				id: "exited",
				expectedPrefix: "before",
				observed: () => "bef",
				execution: Promise.resolve(response),
				clock,
			}),
		);
		assert.deepEqual(fieldsOf(failure), {
			reason: "settled-before-output",
			id: "exited",
			expectedPrefix: "before",
			observed: "bef",
			settlement: { response },
		});
		assert.deepEqual(counts, { sleeps: 1, drains: 0 });
	});

	it("reports a rejected request as its settlement (#4477)", async () => {
		const { clock } = manualClock();
		const error = new Error("spawn failed");
		const failure = await failureOf(
			waitForRpcBashOutput({
				id: "rejected",
				expectedPrefix: "before",
				observed: () => "",
				execution: Promise.reject(error),
				clock,
			}),
		);
		assert.equal(failure.reason, "settled-before-output");
		assert.deepEqual(failure.settlement, { error });
	});

	it("fails once a ready shell stays silent for the post-readiness budget, after draining pending I/O (#4477)", async () => {
		const { clock, counts } = manualClock();
		const failure = await failureOf(
			waitForRpcBashOutput({
				id: "silent",
				expectedPrefix: "before",
				observed: () => "",
				execution: unsettled(),
				isReady: () => true,
				clock,
			}),
		);
		assert.deepEqual(fieldsOf(failure), {
			reason: "silent-after-ready",
			id: "silent",
			expectedPrefix: "before",
			observed: "",
			settlement: undefined,
		});
		assert.deepEqual(counts, { sleeps: RPC_OUTPUT_AFTER_READY_TIMEOUT_MS / RPC_OUTPUT_POLL_INTERVAL_MS, drains: 1 });
		assert.equal(
			failure.message,
			'RPC bash "silent" did not stream output prefix "before" (silent-after-ready); observed accumulated output: ""; settlement: "pending"',
		);
	});

	it("starts the post-readiness budget when the shell signals readiness (#4477)", async () => {
		const { clock, counts, elapsed } = manualClock();
		const startupMs = 3 * RPC_OUTPUT_POLL_INTERVAL_MS,
			afterReadyTimeoutMs = 4 * RPC_OUTPUT_POLL_INTERVAL_MS;
		const failure = await failureOf(
			waitForRpcBashOutput({
				id: "late-ready",
				expectedPrefix: "before",
				observed: () => "",
				execution: unsettled(),
				isReady: () => elapsed() >= startupMs,
				afterReadyTimeoutMs,
				clock,
			}),
		);
		assert.equal(failure.reason, "silent-after-ready");
		assert.equal(counts.sleeps, (startupMs + afterReadyTimeoutMs) / RPC_OUTPUT_POLL_INTERVAL_MS);
	});

	it("observes output that is already pending when the post-readiness verdict is due (#4477)", async () => {
		let observed = "";
		const { clock, counts } = manualClock(() => {
			observed = "before";
		});
		await waitForRpcBashOutput({
			id: "pending-io",
			expectedPrefix: "before",
			observed: () => observed,
			execution: unsettled(),
			isReady: () => true,
			afterReadyTimeoutMs: 0,
			clock,
		});
		assert.deepEqual(counts, { sleeps: 0, drains: 1 });
	});

	it("reads a pipe write that arrived while the test process was stalled before giving a verdict (#4477)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-rpc-output-wait-"));
		const written = join(dir, "written");
		const child = spawn(
			process.execPath,
			[
				"-e",
				`const fs = require("node:fs"); fs.writeSync(1, "before"); fs.writeFileSync(${JSON.stringify(written)}, ""); setInterval(() => {}, 1000);`,
			],
			{ stdio: ["ignore", "pipe", "inherit"] },
		);
		onTestFinished(() => {
			child.kill();
			rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
		});
		let observed = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			observed += chunk;
		});
		stallUntil(() => existsSync(written));
		assert.equal(observed, "");

		await waitForRpcBashOutput({
			id: "stalled",
			expectedPrefix: "before",
			observed: () => observed,
			execution: unsettled(),
			isReady: () => true,
			afterReadyTimeoutMs: 0,
		});
		assert.equal(observed, "before");
	});

	it("uses wall-clock time and timer sleeps by default", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: 1_000 });
		onTestFinished(() => {
			vi.useRealTimers();
		});
		assert.equal(realClock.now(), 1_000);
		let slept = false;
		const sleeping = realClock.sleep(RPC_OUTPUT_POLL_INTERVAL_MS).then(() => {
			slept = true;
		});
		await vi.advanceTimersByTimeAsync(RPC_OUTPUT_POLL_INTERVAL_MS - 1);
		assert.equal(slept, false);
		await vi.advanceTimersByTimeAsync(1);
		await sleeping;
		assert.equal(slept, true);
	});
});
