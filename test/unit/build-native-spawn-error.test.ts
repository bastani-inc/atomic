import assert from "node:assert/strict";
import { test } from "vitest";
import { formatNativeSpawnFailure } from "../../packages/natives/scripts/spawn-error.js";

test("native build failures retain the operating-system spawn error", () => {
	assert.equal(
		formatNativeSpawnFailure("napi", {
			status: null,
			error: Object.assign(new Error("spawn bunx ENOENT"), { code: "ENOENT" }),
		}),
		"napi exited null; spawn error: spawn bunx ENOENT",
	);
});
