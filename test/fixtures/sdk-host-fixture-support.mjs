import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Node 22 emits this runtime-owned notice when node:sqlite is first loaded.
// Keep all operational diagnostics and all other warnings visible to assertions.
export function withoutSqliteExperimentalWarning(stderr) {
	return stderr.replace(/^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n(?:\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n)?/gm, "");
}

// The fixture owns its disposable agentDir, but a persisted PID is not a
// process handle. Never signal it: it could have been reused. After disposal,
// the broker retires naturally after its five-second idle grace period.
export async function awaitFixtureBrokerExit(agentDir) {
	const pidPath = join(agentDir, "intercom", "broker.pid");
	if (!existsSync(pidPath)) return;
	const pid = Number(readFileSync(pidPath, "utf8").trim());
	assert.ok(Number.isInteger(pid) && pid > 0);
	const deadline = Date.now() + 10_000;
	for (;;) {
		try { process.kill(pid, 0); }
		catch (error) { if (error.code !== "ESRCH") throw error; return; }
		assert.ok(Date.now() < deadline, "fixture broker did not exit; retaining its directory");
		await delay(20);
	}
}

// On Windows the broker runs under `cmd.exe /s /c "... 2>>broker.log"`, so the
// recorded PID is the broker itself while the cmd wrapper owns the log handle and
// exits a moment after it. That handle has no delete sharing, so unlinking
// broker.log in that window fails with EBUSY. Retry the removal rather than racing
// the wrapper; Node's rm retries EBUSY/ENOTEMPTY/EPERM only when maxRetries is set.
export async function removeFixtureRoot(root) {
	await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
}
