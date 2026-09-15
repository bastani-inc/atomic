import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { validateRuntimeSupplement } from "./postgres-runtime-supplement.mjs";

// #3073: the producer's sealed inventory must not substitute for pinned source provenance.
test("supplement validation rejects a runtime without its pinned input identities", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-supplement-provenance-"));
	try {
		writeFileSync(join(root, "supplement-provenance.json"), JSON.stringify({ inputs: {} }));
		assert.throws(() => validateRuntimeSupplement(root, "darwin-arm64"), /supplement provenance mismatch/u);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
