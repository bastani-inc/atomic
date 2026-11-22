/**
 * A running process of each recorded release, updated in place to this build (`scripts/in-place-update-e2e.mjs`):
 * every module it imports on demand by its path loads or says to restart, and the modules a session loads for its own
 * work load. The releases are installed from npm as published; this build is packed as the release workflow packs it.
 * A running process of this build, updated to a later release whose code cannot load, says to restart at its own call
 * sites.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, test } from "vitest";
import { updateRunningBuild, updateRunningRelease } from "../../scripts/in-place-update-e2e.mjs";
import { moduleDir, npmSpawnPrefix, removePath, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "..", "..");
const RECORDS = join(ROOT, "packages/coding-agent/in-place-update");
/** Packing the seven packages of the build: structural. */
const PACK_TIMEOUT_MS = 300_000;
/** Installing a published release from npm, starting a process of it, updating it and removing it: structural. */
const UPDATE_TIMEOUT_MS = 300_000;
/** Removing the packed build and what an interrupted update left: a directory of thousands of files on Windows. */
const CLEANUP_TIMEOUT_MS = 120_000;

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

afterAll(async () => {
	if (work !== "") await removePath(work, { recursive: true, force: true, maxRetries: 10 });
}, CLEANUP_TIMEOUT_MS);

describe("a running process of a recorded release, updated in place to this build", () => {
	test(
		"the release check passes on the packed build for every recorded release, including 0.10.4",
		() => {
			// `0.10.5-0` sits directly above `0.10.4` in semver (below `0.10.5-alpha.1` and `0.10.5`), so the release
			// check always resolves `0.10.4` as the previous published release and verifies every recorded release.
			const result = spawnSyncCollect(
				[
					process.execPath,
					join(ROOT, "scripts/in-place-update-exports.mjs"),
					"release",
					"0.10.5-0",
					RECORDS,
					tarballs,
				],
				{ cwd: ROOT, timeout: PACK_TIMEOUT_MS },
			);
			assert.equal(result.exitCode, 0, result.stderr.toString());
			assert.match(result.stdout.toString(), /An in-place update from 0\.10\.4 breaks nothing\./);
		},
		PACK_TIMEOUT_MS,
	);

	test.each(records.map((record) => [record.version, record] as const))(
		"from %s loads each module it imports on demand or says to restart, and its core modules load",
		async (_version, record) => {
			const version = JSON.parse(readFileSync(join(ROOT, "packages/coding-agent/package.json"), "utf8")).version;
			const allowed = JSON.parse(readFileSync(join(RECORDS, "allowed.json"), "utf8")) as Record<
				string,
				Record<string, string>
			>;
			assert.deepEqual(await updateRunningRelease(record, tarballs, version, work, allowed[record.version]), []);
		},
		UPDATE_TIMEOUT_MS,
	);
});

test(
	"a running process of this build updated in place to a later release whose code cannot load says to restart at its own call sites",
	async () => {
		const version = JSON.parse(readFileSync(join(ROOT, "packages/coding-agent/package.json"), "utf8")).version;
		assert.deepEqual(await updateRunningBuild(tarballs, version, ROOT), []);
	},
	UPDATE_TIMEOUT_MS,
);
