import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, vi } from "vitest";
import { getProjectTrustPath, ProjectTrustStore } from "../src/core/trust-manager.ts";

/** While set, the next write of trust data stops halfway, as a writer killed mid-write would leave it. */
const crash = vi.hoisted(() => ({ armed: false, fired: false, written: 0.5 }));
/** How many of the next lock attempts fail with EPERM, as Windows reports a lock directory being created or removed. */
const lockFaults = vi.hoisted(() => ({ eperm: 0, releaseThrows: false }));

vi.mock("proper-lockfile", async (importOriginal) => {
	const actual = (await importOriginal<{ default: typeof import("proper-lockfile") }>()).default;
	const lockSync: typeof actual.lockSync = (file, options) => {
		if (lockFaults.eperm > 0) {
			lockFaults.eperm--;
			throw Object.assign(new Error("EPERM: operation not permitted, mkdir"), { code: "EPERM" });
		}
		const release = actual.lockSync(file, options);
		return () => {
			release();
			// proper-lockfile throws ERELEASED for a lock it considers compromised or already released.
			if (lockFaults.releaseThrows)
				throw Object.assign(new Error("Lock is already released"), { code: "ERELEASED" });
		};
	};
	return { default: { ...actual, lockSync } };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
		if (crash.armed && typeof data === "string") {
			crash.armed = false;
			crash.fired = true;
			if (crash.written > 0)
				actual.writeFileSync(file, data.slice(0, Math.floor(data.length * crash.written)), options);
			throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
		}
		actual.writeFileSync(file, data, options);
	};
	return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

let agentDir: string;

beforeEach(() => {
	agentDir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-trust-crash-")));
	crash.armed = false;
	crash.fired = false;
	crash.written = 0.5;
	lockFaults.eperm = 0;
	lockFaults.releaseThrows = false;
});

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
	if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

it("keeps the previous trust.json intact when a write stops halfway (#4952)", () => {
	const store = new ProjectTrustStore(agentDir);
	const kept = join(agentDir, "kept");
	store.set(kept, true);
	const before = readFileSync(join(agentDir, "trust.json"), "utf8");

	crash.armed = true;
	assert.throws(() => store.set(join(agentDir, "interrupted"), false), /ENOSPC/);
	assert.equal(crash.fired, true);

	assert.equal(readFileSync(join(agentDir, "trust.json"), "utf8"), before);
	assert.deepEqual(JSON.parse(before), { [getProjectTrustPath(kept)]: true });
	assert.equal(store.get(kept), true);
	assert.deepEqual(readdirSync(agentDir).sort(), ["trust.json"]);
});

it("reports the write's own error when it fails before creating any file (#4952)", () => {
	const store = new ProjectTrustStore(agentDir);
	store.set(join(agentDir, "kept"), true);
	const before = readFileSync(join(agentDir, "trust.json"), "utf8");

	crash.armed = true;
	crash.written = 0;
	assert.throws(() => store.set(join(agentDir, "interrupted"), false), /ENOSPC/);
	assert.equal(crash.fired, true);

	assert.equal(readFileSync(join(agentDir, "trust.json"), "utf8"), before);
	assert.deepEqual(readdirSync(agentDir).sort(), ["trust.json"]);
});

it("retries the trust lock while Windows reports it as EPERM (#4952)", () => {
	const project = join(agentDir, "project");
	Object.defineProperty(process, "platform", { value: "win32" });
	lockFaults.eperm = 3;

	new ProjectTrustStore(agentDir).set(project, true);

	assert.equal(lockFaults.eperm, 0);
	assert.equal(new ProjectTrustStore(agentDir).get(project), true);
});

it("fails a save at once on EPERM from the trust lock outside Windows (#4952)", () => {
	Object.defineProperty(process, "platform", { value: "linux" });
	lockFaults.eperm = 1;

	assert.throws(() => new ProjectTrustStore(agentDir).set(join(agentDir, "project"), true), { code: "EPERM" });
});

it("reports a trust write as saved when releasing its lock throws afterwards (#5090)", () => {
	const project = join(agentDir, "project");
	lockFaults.releaseThrows = true;

	new ProjectTrustStore(agentDir).set(project, true);

	assert.equal(new ProjectTrustStore(agentDir).get(project), true);
});

it("reports a failed trust write's own error when releasing its lock also throws (#5090)", () => {
	const store = new ProjectTrustStore(agentDir);
	lockFaults.releaseThrows = true;
	crash.armed = true;

	assert.throws(() => store.set(join(agentDir, "project"), true), /ENOSPC/);
	assert.equal(crash.fired, true);
});
