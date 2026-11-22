/**
 * A running process of each recorded release, updated in place to this build (`scripts/in-place-update-e2e.mjs`):
 * every module it imports on demand by its path loads or says to restart, and `/export` says to restart. The releases
 * are installed from npm as published; this build is packed as the release workflow packs it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { updateRunningRelease } from "../../scripts/in-place-update-e2e.mjs";
import { moduleDir, npmSpawnPrefix, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "..", "..");
const RECORDS = join(ROOT, "packages/coding-agent/in-place-update");
/** Packing the seven packages of the build: structural. */
const PACK_TIMEOUT_MS = 300_000;
/** Installing a published release from npm, starting a process of it and updating it: structural. */
const UPDATE_TIMEOUT_MS = 300_000;

const records = readdirSync(RECORDS)
	.filter((file) => /^\d.*\.json$/.test(file))
	.map((file) => JSON.parse(readFileSync(join(RECORDS, file), "utf8")) as { version: string });

let work = "";
let tarballs = "";
beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "atomic-in-place-update-e2e-"));
	tarballs = mkdtempSync(join(work, "build-"));
	const packed = spawnSyncCollect(
		[
			...npmSpawnPrefix(),
			"pack",
			...[
				"@bastani/atomic",
				"@bastani/atomic-ai",
				"@bastani/atomic-agent-core",
				"@bastani/atomic-codemode",
				"@bastani/atomic-schema",
				"@bastani/atomic-telemetry",
				"@bastani/atomic-tui",
			].map((name) => `--workspace=${name}`),
			"--ignore-scripts",
			"--pack-destination",
			tarballs,
		],
		{ cwd: ROOT, timeout: PACK_TIMEOUT_MS },
	);
	assert.equal(packed.exitCode, 0, packed.stderr.toString());
}, PACK_TIMEOUT_MS);

afterAll(() => {
	if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("a running process of a recorded release, updated in place to this build", () => {
	test.each(records.map((record) => [record.version, record] as const))(
		"from %s loads each module it imports on demand or says to restart, and /export says to restart",
		async (_version, record) => {
			const version = JSON.parse(readFileSync(join(ROOT, "packages/coding-agent/package.json"), "utf8")).version;
			assert.deepEqual(await updateRunningRelease(record, tarballs, version, work), []);
		},
		UPDATE_TIMEOUT_MS,
	);
});
