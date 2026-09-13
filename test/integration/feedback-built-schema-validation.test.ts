import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("../fixtures/feedback-schema-runtime.mjs", import.meta.url));

// Regression for #2799, review 3998253205. These use the actual built bundle and
// production bridge installer; npm run build is a prerequisite, not a skip.
test("built feedback schema normalizes numeric titles through the Bun host bridge", () => {
	const result = spawnSyncCollect([bunExecutable(), fixture, "bridged"], {
		cwd: root,
		env: { ...process.env, ATOMIC_BUNDLED_BUILD: "1" },
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(result.stdout.toString().trim(), "bridged bundle normalizes numeric titles");
});

test("built feedback schema rejects numeric titles under native Node", () => {
	const result = spawnSyncCollect([process.execPath, fixture, "native"], { cwd: root });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(result.stdout.toString().trim(), "native Node bundle rejects numeric titles");
});
