import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { removeTempRootReleasingBroker, stopDetachedBroker } from "../helpers/detached-broker.js";
import { sleep, spawnProcess } from "../helpers/runtime.js";

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("stopDetachedBroker is a no-op when no broker pid is recorded", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-broker-teardown-missing-"));
	mkdirSync(join(root, "agent"), { recursive: true });
	stopDetachedBroker(join(root, "agent"));
	removeTempRootReleasingBroker(root);
	assert.equal(existsSync(root), false);
});

test("removeTempRootReleasingBroker deletes a disposable agent tree", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-broker-teardown-tree-"));
	mkdirSync(join(root, "agent", "intercom"), { recursive: true });
	writeFileSync(join(root, "agent", "intercom", "broker.log"), "held\n");
	removeTempRootReleasingBroker(root);
	assert.equal(existsSync(root), false);
});

test("stopDetachedBroker terminates the pid recorded under the agent dir", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-broker-teardown-pid-"));
	const agentDir = join(root, "agent");
	mkdirSync(join(agentDir, "intercom"), { recursive: true });
	const child = spawnProcess({
		cmd: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
		stdin: "ignore",
		stdout: "ignore",
		stderr: "ignore",
	});
	const pid = child.pid;
	try {
		assert.ok(pid !== undefined);
		writeFileSync(join(agentDir, "intercom", "broker.pid"), String(pid));
		assert.equal(processExists(pid), true);
		stopDetachedBroker(agentDir);
		const deadline = Date.now() + 2_000;
		while (Date.now() < deadline && processExists(pid)) await sleep(20);
		assert.equal(processExists(pid), false);
	} finally {
		if (pid !== undefined && processExists(pid)) {
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// Already reaped.
			}
		}
		removeTempRootReleasingBroker(root, agentDir);
	}
});
