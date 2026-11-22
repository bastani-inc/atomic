/**
 * A process of an earlier release that an in-place update caught loads this build's files against the copies it holds,
 * and its own code loads this build's files on demand (`scripts/in-place-update-exports.mjs`). These tests hold this
 * build to every release recorded in `packages/coding-agent/in-place-update/`.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { checkRelease, type ReleaseRecord, recordRelease } from "../../scripts/in-place-update-exports.mjs";
import { moduleDir } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const RECORDS = join(ROOT, "packages/coding-agent/in-place-update");
/** This build's packages, the application first, as a release records them. */
const PACKAGES = ["coding-agent", "ai", "agent", "tui", "codemode", "schema", "telemetry"].map((name) =>
	join(ROOT, "packages", name),
);
const builtTest = existsSync(join(ROOT, "packages/coding-agent/dist/index.js")) ? test : test.skip;
/** Reads and resolves the imports of every file of seven built packages, once per check. */
const CHECK_TIMEOUT_MS = 60_000;

const records = readdirSync(RECORDS)
	.filter((file) => /^\d.*\.json$/.test(file))
	.map((file) => JSON.parse(readFileSync(join(RECORDS, file), "utf8")) as ReleaseRecord);
const allowed = JSON.parse(readFileSync(join(RECORDS, "allowed.json"), "utf8")) as Record<
	string,
	Record<string, string>
>;

test("the releases this build is checked against are recorded", () => {
	assert.ok(
		records.some((record) => record.version === "0.10.3"),
		records.map((record) => record.version).join(", "),
	);
});

for (const record of records) {
	builtTest(
		`a process of ${record.version} that an in-place update caught can load what it needs from this build`,
		() => {
			assert.deepEqual(checkRelease(record, PACKAGES, allowed[record.version] ?? {}), []);
		},
		CHECK_TIMEOUT_MS,
	);

	builtTest(
		`every import this build may make against ${record.version}'s exports maps is still one it makes`,
		() => {
			const problems = checkRelease(record, PACKAGES);
			for (const specifier of Object.keys(allowed[record.version] ?? {}))
				assert.ok(
					problems.some((problem) => problem.includes(` imports ${specifier}, `)),
					`${specifier} is allowed for ${record.version} but nothing imports it any more: remove it from allowed.json`,
				);
		},
		CHECK_TIMEOUT_MS,
	);
}

builtTest(
	"this build, once released and recorded, can be updated in place to itself",
	() => {
		// What a later release checks this one against: a record of this build, which names only what it ships.
		assert.deepEqual(checkRelease(recordRelease(PACKAGES), PACKAGES), []);
	},
	CHECK_TIMEOUT_MS,
);

test("the 0.10.3 record names each file's exports as a 0.10.3 process's module namespaces had them", () => {
	const record = records.find((entry) => entry.version === "0.10.3");
	assert.ok(record);
	const runtime = JSON.parse(readFileSync(join(ROOT, "test/fixtures/atomic-0.10.3/exports.json"), "utf8")) as {
		entry: Record<string, string[]>;
		host: Record<string, string[]>;
	};
	const files = record.packages["@bastani/atomic"]!.files;
	for (const [path, names] of Object.entries(runtime.entry)) assert.deepEqual(files[path], names, path);
	assert.deepEqual(files["dist/index.js"], runtime.host["@bastani/atomic"]);
	assert.deepEqual(files["dist/core/storage/index.js"], runtime.host["@bastani/atomic/storage"]);
});
