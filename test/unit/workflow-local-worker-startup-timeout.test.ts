import assert from "node:assert/strict";
import { test } from "vitest";
import {
	BASE_STARTUP_TIMEOUT_MS,
	defaultStartupTimeoutMs,
	MAX_DEFAULT_STARTUP_TIMEOUT_MS,
	startupTimeoutMessage,
} from "../../packages/workflows/src/workers/startup-timeout.js";
import { untilOrRunEnds } from "../helpers/until-run.js";

test("the default worker startup deadline keeps 30 s on an idle machine with spare cores (#3962)", () => {
	assert.equal(defaultStartupTimeoutMs(2, { cpus: 8, load: 0 }), BASE_STARTUP_TIMEOUT_MS);
	assert.equal(defaultStartupTimeoutMs(1, { cpus: 0, load: 0 }), BASE_STARTUP_TIMEOUT_MS);
});

test("the default worker startup deadline scales with pool size and load per core (#3962)", () => {
	assert.equal(defaultStartupTimeoutMs(8, { cpus: 4, load: 12 }), BASE_STARTUP_TIMEOUT_MS * 5);
	assert.equal(defaultStartupTimeoutMs(16, { cpus: 4, load: 0 }), BASE_STARTUP_TIMEOUT_MS * 4);
	assert.equal(defaultStartupTimeoutMs(10_000, { cpus: 1, load: 0 }), MAX_DEFAULT_STARTUP_TIMEOUT_MS);
});

test("a worker startup timeout says workers were too slow and names the setting (#3962)", () => {
	const message = startupTimeoutMessage(30_000);
	assert.match(message, /^Local worker startup timed out after 30000 ms/);
	assert.match(message, /too slow to start/);
	assert.match(message, /workflows\.localWorkers\.startupTimeoutMs/);
});

test("waiting on a pooled run fails fast with the run's own error once the run has failed (#3962)", async () => {
	const execution = Promise.resolve({ status: "failed", error: "Local worker startup timed out after 30000 ms" });
	const started = performance.now();
	await assert.rejects(
		untilOrRunEnds(async () => false, execution, 60_000),
		/run ended with status failed before the condition held: Local worker startup timed out after 30000 ms/,
	);
	assert.ok(performance.now() - started < 5_000);
});

test("waiting on a pooled run surfaces a rejected run (#3962)", async () => {
	const execution = Promise.reject(new Error("coordinator exited"));
	await assert.rejects(
		untilOrRunEnds(async () => false, execution, 60_000),
		/coordinator exited/,
	);
});

test("waiting on a pooled run resolves once the condition holds while the run continues (#3962)", async () => {
	let polls = 0;
	await untilOrRunEnds(async () => ++polls >= 3, new Promise<never>(() => {}), 60_000);
	assert.equal(polls, 3);
});

test("waiting on a pooled run surfaces the run's error while a condition check is still pending (#3962)", async () => {
	let failRun: (run: { status: string; error: string }) => void = () => {};
	const execution = new Promise<{ status: string; error: string }>((resolve) => {
		failRun = resolve;
	});
	let rejectCondition: (error: Error) => void = () => {};
	const condition = () =>
		new Promise<boolean>((_resolve, reject) => {
			rejectCondition = reject;
			failRun({ status: "failed", error: "Local worker startup timed out after 30000 ms" });
		});
	const waiting = untilOrRunEnds(condition, execution, 60_000);
	await assert.rejects(waiting, /run ended with status failed before the condition held: Local worker startup/);
	rejectCondition(new Error("List sessions timeout"));
});

test("waiting on a pooled run surfaces a run rejection while a condition check is still pending (#3962)", async () => {
	const condition = () => new Promise<boolean>(() => {});
	await assert.rejects(
		untilOrRunEnds(condition, Promise.reject(new Error("coordinator exited")), 60_000),
		/coordinator exited/,
	);
});
