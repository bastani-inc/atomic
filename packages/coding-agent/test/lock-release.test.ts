import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, vi } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../src/config.js";
import { flushDebugLog } from "../src/core/debug.js";
import { withInstallLock } from "../src/core/package-manager-lock.ts";

/** While set, releasing a lock rejects as proper-lockfile does for a lock it considers compromised. */
const lockFaults = vi.hoisted(() => ({ releaseRejects: false }));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = (await importOriginal<{ default: typeof import("proper-lockfile") }>()).default;
	const lock: typeof actual.lock = async (file, options) => {
		const release = await actual.lock(file, options);
		return async () => {
			await release();
			if (lockFaults.releaseRejects)
				throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
		};
	};
	return { default: { ...actual, lock } };
});

let sandbox: string;

beforeEach(() => {
	sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-lock-release-")));
	vi.stubEnv(ENV_AGENT_DIR, join(sandbox, "agent"));
	vi.stubEnv("ATOMIC_DEBUG", "1");
	lockFaults.releaseRejects = false;
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(sandbox, { recursive: true, force: true });
});

async function releaseFailures(): Promise<Array<{ lock: string; code: string }>> {
	await flushDebugLog();
	if (!existsSync(getDebugLogPath())) return [];
	return readFileSync(getDebugLogPath(), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { event: string; data: { lock: string; code: string } })
		.filter((record) => record.event === "lock-release-failed")
		.map((record) => ({ lock: record.data.lock, code: record.data.code }));
}

it("returns an operation's result when releasing its lock fails afterwards, and logs the failure (#5090)", async () => {
	const installPath = join(sandbox, "packages", "demo");
	lockFaults.releaseRejects = true;

	assert.equal(await withInstallLock(installPath, async () => "installed"), "installed");

	assert.deepEqual(await releaseFailures(), [{ lock: installPath, code: "ERELEASED" }]);
});

it("reports a failed operation's own error when releasing its lock also fails (#5090)", async () => {
	const installPath = join(sandbox, "packages", "demo");
	lockFaults.releaseRejects = true;

	await assert.rejects(
		withInstallLock(installPath, async () => {
			throw new Error("install failed");
		}),
		/install failed/,
	);

	assert.deepEqual(await releaseFailures(), [{ lock: installPath, code: "ERELEASED" }]);
});

it("logs nothing when the lock releases cleanly (#5090)", async () => {
	assert.equal(await withInstallLock(join(sandbox, "packages", "demo"), async () => 1), 1);

	assert.deepEqual(await releaseFailures(), []);
});
