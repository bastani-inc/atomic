import assert from "node:assert/strict";
import { test } from "vitest";
import { type BlockRecord, blockOwner } from "../helpers/event-loop-guard-fixture.ts";

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
});
