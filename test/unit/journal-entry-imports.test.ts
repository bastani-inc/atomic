import assert from "node:assert/strict";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

for (const entry of ["extension/workflow-instance-owner", "durable/journal/journal-backend"]) {
	test(`journal ownership errors initialize from ${entry} (#3647)`, () => {
		const result = spawnSyncCollect([
			process.execPath,
			"--input-type=module",
			"-e",
			`import assert from "node:assert/strict";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { fsCache: false });
await jiti.import("./packages/workflows/src/${entry}.ts");
const { WorkflowInstanceOwnershipError } = await jiti.import("./packages/workflows/src/extension/workflow-instance-owner.ts");
const { JournalOwnershipError } = await jiti.import("./packages/workflows/src/durable/journal/journal-backend.ts");
assert.ok(new JournalOwnershipError("run", "holder") instanceof WorkflowInstanceOwnershipError);`,
		]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
	});
}
