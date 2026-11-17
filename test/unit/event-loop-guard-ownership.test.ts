import assert from "node:assert/strict";
import { test } from "vitest";
import { OWNED_ELSEWHERE } from "../../scripts/event-loop/policy.js";
import { type BlockRecord, blockOwner } from "../helpers/event-loop-guard-fixture.js";

const areas = [
	{ owner: "#5285", paths: ["packages/coding-agent/src/core/tools/windows-directory-security.ts"] },
	{ owner: "#5345", paths: ["packages/coding-agent/src/core/worktree-snapshot/"] },
];

function block(...stacks: string[][]): BlockRecord {
	return {
		type: "block",
		role: "host",
		at: "2026-11-17T00:00:00.000Z",
		durationMs: 300,
		samples: stacks.length,
		hotFrames: [],
		stacks: stacks.map((frames) => ({ count: 1, frames })),
	};
}

test("a block whose every stack runs in another change's area belongs to that change, in sources and in the build", () => {
	assert.equal(
		blockOwner(
			block(
				[
					"spawnSync node:child_process",
					"readWindowsDirectorySecurity file:///x/dist/core/tools/windows-directory-security.js:40",
				],
				[
					"verifyWindowsDirectorySecurity file:///x/packages/coding-agent/src/core/tools/windows-directory-security.ts:90",
				],
			),
			areas,
		),
		"#5285",
	);
	assert.equal(blockOwner(block(["capture file:///x/dist/core/worktree-snapshot/capture.js:1"]), areas), "#5345");
	for (const frame of [
		"confirmRetiredShardUnused file:///repo/packages/workflows/src/workers/ship-shard.ts:120:5",
		"confirmRetiredShardUnused file:///pkg/dist/builtin/workflows/src/workers/ship-shard.js:120:5",
		"confirmRetiredShardUnused file:///pkg/dist/builtin/workflows/src/extension/index.bundle.mjs:9120:5",
	]) {
		assert.equal(
			blockOwner(block(["prepare node:sqlite", frame]), OWNED_ELSEWHERE),
			"#5376 (node:sqlite statements off the event loop)",
		);
	}
});

test("a block with any stack in this code's own modules, or in two areas, is not deferred", () => {
	assert.equal(
		blockOwner(
			block(
				["readWindowsDirectorySecurity file:///x/dist/core/tools/windows-directory-security.js:40"],
				["render file:///x/dist/modes/interactive/components/assistant-message.js:67"],
			),
			areas,
		),
		undefined,
	);
	assert.equal(
		blockOwner(
			block(
				["readWindowsDirectorySecurity file:///x/dist/core/tools/windows-directory-security.js:40"],
				["capture file:///x/dist/core/worktree-snapshot/capture.js:1"],
			),
			areas,
		),
		undefined,
	);
	assert.equal(
		blockOwner(
			{
				type: "block",
				role: "engine",
				at: "2026-11-17T00:00:00.000Z",
				durationMs: 400,
				samples: 3,
				hotFrames: [
					{ count: 3, frame: "rebuildIndex file:///x/dist/builtin/workflows/src/fleet/controller.js:10" },
				],
				stacks: [
					{
						count: 3,
						frames: [
							"rebuildIndex file:///x/dist/builtin/workflows/src/fleet/controller.js:10",
							"journalStep file:///x/dist/builtin/workflows/src/fleet/controller.js:40",
							"commitAlone file:///x/dist/core/storage/node-sqlite.js:1500",
							"runBatch file:///x/dist/core/storage/node-sqlite.js:1420",
						],
					},
				],
			},
			OWNED_ELSEWHERE,
		),
		undefined,
	);
});
