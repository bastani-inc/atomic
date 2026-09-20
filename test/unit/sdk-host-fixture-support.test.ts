import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	awaitFixtureBrokerExit,
	removeFixtureRoot,
	withoutSqliteExperimentalWarning,
} from "../fixtures/sdk-host-fixture-support.mjs";
import { spawnProcess } from "../helpers/runtime.js";

// #3111: only Node's exact SQLite notice is exempt, never SDK diagnostics.
test("quiet-host assertion retains operational errors and unrelated warnings", () => {
	const warning =
		"(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` to show where the warning was created)\n";
	assert.equal(withoutSqliteExperimentalWarning(warning), "");
	assert.equal(withoutSqliteExperimentalWarning(warning.replaceAll("\n", "\r\n")), "");
	const diagnostic = "Failed to load extension\n(node:123) ExperimentalWarning: something else\n";
	assert.equal(withoutSqliteExperimentalWarning(diagnostic + warning), diagnostic);
});

test("fixture broker cleanup awaits process exit before deleting its directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-fixture-broker-"));
	const child = spawnProcess([process.execPath, "-e", "setTimeout(() => {}, 100)"], {
		stdout: "ignore",
		stderr: "ignore",
	});
	try {
		const pid = child.pid;
		assert.ok(pid);
		mkdirSync(join(root, "intercom"));
		writeFileSync(join(root, "intercom", "broker.pid"), String(child.pid));
		await awaitFixtureBrokerExit(root);
		assert.throws(() => process.kill(pid, 0));
		assert.equal(await child.exited, 0, "cleanup must not signal a PID read from disk");
	} finally {
		child.kill("SIGKILL");
		await child.exited;
		rmSync(root, { recursive: true, force: true });
	}
});

// On Windows the broker's `cmd.exe /s /c "... 2>>broker.log"` wrapper outlives the
// broker PID and holds the log without delete sharing, so a bare rmSync right after
// awaitFixtureBrokerExit fails with EBUSY. Reproduce that with a shell redirect that
// is still open while the root is removed.
test("fixture root removal outlives a shell wrapper still holding broker.log", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-fixture-broker-log-"));
	const intercomDir = join(root, "intercom");
	mkdirSync(intercomDir);
	const logPath = join(intercomDir, "broker.log");
	const holder = spawn(`"${process.execPath}" -e "setTimeout(() => {}, 500)" 2>>"${logPath}"`, {
		shell: true,
		stdio: "ignore",
	});
	const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
	try {
		await removeFixtureRoot(root);
		assert.equal(existsSync(root), false);
	} finally {
		await exited;
		rmSync(root, { recursive: true, force: true });
	}
});
