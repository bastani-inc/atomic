import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

test("package file operations preserve assets and permissions on the current platform", () => {
	const result = spawnSync(
		process.execPath,
		["--test", fileURLToPath(new URL("../../scripts/package-files.test.mjs", import.meta.url))],
		{
			encoding: "utf8",
		},
	);
	assert.equal(result.status, 0, result.stdout + result.stderr);
});
