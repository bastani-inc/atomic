import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, vi } from "vitest";
import { getProjectTrustPath, ProjectTrustStore } from "../src/core/trust-manager.ts";

/** While set, the next write of trust data stops halfway, as a writer killed mid-write would leave it. */
const crash = vi.hoisted(() => ({ armed: false, fired: false }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	const writeFileSync: typeof actual.writeFileSync = (file, data, options) => {
		if (crash.armed && typeof data === "string") {
			crash.armed = false;
			crash.fired = true;
			actual.writeFileSync(file, data.slice(0, Math.floor(data.length / 2)), options);
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
