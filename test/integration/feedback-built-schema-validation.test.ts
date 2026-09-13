import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/feedback-schema-runtime.mjs", import.meta.url));

// Regression for #2799, review 3998253205. These use the actual built bundle and
// production bridge installer; npm run build is a prerequisite, not a skip.
test("built feedback schema preserves host string-field validation through the Bun bridge", () => {
	const result = spawnSyncCollect([bunExecutable(), fixture, "bridged"], {
		cwd: root,
		env: { ...process.env, ATOMIC_BUNDLED_BUILD: "1" },
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(
		result.stdout.toString().trim(),
		"bridged bundle preserves the shared string-field validation contract",
	);
});

test("built feedback schema preserves the same host string-field validation under native Node", () => {
	const result = spawnSyncCollect([process.execPath, fixture, "native"], { cwd: root });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(
		result.stdout.toString().trim(),
		"native Node bundle preserves the shared string-field validation contract",
	);
});
