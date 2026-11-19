import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
const record = JSON.parse(readFileSync(join(root, "test/helpers/test-file-durations.json"), "utf8")) as Record<
	string,
	Record<string, number>
>;
const PLATFORMS = ["linux", "win32"] as const;

/**
 * Files split for shard headroom (docs/ci.md). A split file without its own weight counts as the sequencer's 20 s
 * default, so the shards it lands in run far past their balanced share; the file it replaced keeps no weight.
 */
const SPLITS = [
	{
		replaced: "test/integration/sdk-builtin-host-parity-host-routing.test.ts",
		files: ["test/integration/sdk-builtin-host-parity-host-routing-children.test.ts"],
	},
	{
		replaced: undefined,
		files: [
			"packages/coding-agent/test/worktree-pool-claim.test.ts",
			"packages/coding-agent/test/worktree-pool-claim-candidates.test.ts",
			"packages/coding-agent/test/worktree-pool-claim-edges.test.ts",
		],
	},
] as const;

test("every file split for shard headroom has its own measured weight on each platform, and its original none", () => {
	for (const platform of PLATFORMS) {
		const weights = record[platform] ?? {};
		for (const { replaced, files } of SPLITS) {
			if (replaced !== undefined)
				assert.equal(weights[replaced], undefined, `${platform}: ${replaced} was split and keeps no weight`);
			for (const file of files)
				assert.ok((weights[file] ?? 0) > 0, `${platform}: ${file} has no measured duration in the record`);
		}
	}
});
