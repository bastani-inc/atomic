import { test } from "bun:test";
import assert from "node:assert/strict";
import { AsyncJobManager } from "../../packages/coding-agent/src/core/async/job-manager.js";
import type { ManagedBashJob } from "../../packages/coding-agent/src/core/tools/bash-async-jobs.js";


test("completed jobs enter their registered delivery handler synchronously at receipt", () => {
	const delivered: string[] = [];
	const manager = new AsyncJobManager({ onJobComplete: () => { delivered.push("default"); } });
	const sessionId = manager.registerSession();
	const running: ManagedBashJob = {
		jobId: "job-received",
		command: "echo done",
		cwd: process.cwd(),
		status: "running",
		output: "",
		startedAt: Date.now(),
	};
	manager.registerBashJob(running, (message) => { delivered.push(message.details.jobId); }, sessionId);
	manager.completeBashJob({ ...running, status: "completed", output: "done", exitCode: 0, endedAt: Date.now() });

	assert.deepEqual(delivered, ["job-received"]);
	manager.releaseSession(sessionId);
});

test("fallback transfer admits completion through the replacement stage session", () => {
	const delivered: string[] = [];
	const manager = new AsyncJobManager({ onJobComplete: () => { delivered.push("default"); } });
	const source = manager.registerSession();
	const target = manager.registerSession();
	const running: ManagedBashJob = {
		jobId: "job-fallback",
		command: "echo done",
		cwd: process.cwd(),
		status: "running",
		output: "",
		startedAt: Date.now(),
	};
	manager.registerBashJob(running, () => { delivered.push("old-stage"); }, source);
	manager.transferSessionDeliveries(source, target, () => { delivered.push("replacement-stage"); });
	manager.completeBashJob({ ...running, status: "completed", output: "done", exitCode: 0, endedAt: Date.now() });

	assert.deepEqual(delivered, ["replacement-stage"]);
	manager.releaseSession(source);
	manager.releaseSession(target);
});
