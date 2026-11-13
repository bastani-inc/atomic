import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "vitest";
import { getBrokerSpawnLockPath, getIntercomDirPath } from "../../packages/intercom/broker/paths.js";
import { spawnBrokerIfNeeded } from "../../packages/intercom/broker/spawn.js";

/** Far longer than an aborted wait may take, so a wait that ignores its signal fails the test instead of passing late. */
const READY_TIMEOUT_MS = 20_000;
const ABORTED_WAIT_BOUND_MS = 2_000;

let agentDir: string;
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;

beforeEach(() => {
	agentDir = join(mkdtempSync(join(tmpdir(), "intercom-spawn-abort-")), "agent");
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	rmSync(join(agentDir, ".."), { recursive: true, force: true });
});

test("an aborted broker start writes nothing into the agent directory (#4727)", async () => {
	const controller = new AbortController();
	const reason = new Error("session disposed");
	controller.abort(reason);

	await assert.rejects(spawnBrokerIfNeeded("never-run", [], READY_TIMEOUT_MS, undefined, controller.signal), reason);
	assert.equal(existsSync(agentDir), false);
});

test("a broker start waiting for another spawner's broker stops when aborted (#4727)", async () => {
	mkdirSync(getIntercomDirPath(), { recursive: true });
	// A live spawner (this process) holds the lock, so this start waits for that spawner's broker.
	writeFileSync(getBrokerSpawnLockPath(), `${process.pid}\n${Date.now()}\n`);
	const controller = new AbortController();
	const reason = new Error("session disposed");
	const started = performance.now();
	const pending = spawnBrokerIfNeeded("never-run", [], READY_TIMEOUT_MS, undefined, controller.signal);
	controller.abort(reason);

	await assert.rejects(pending, reason);
	assert.ok(performance.now() - started < ABORTED_WAIT_BOUND_MS, "the aborted start kept waiting for the broker");
	assert.deepEqual(readdirSync(getIntercomDirPath()), ["broker.spawn.lock"]);
});
