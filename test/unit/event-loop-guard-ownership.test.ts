import assert from "node:assert/strict";
import { test } from "vitest";
import type { OwnedArea } from "../../scripts/event-loop/policy.js";
import { type BlockRecord, blockOwner } from "../helpers/event-loop-guard-fixture.js";

const areas = [
	{ owner: "#5285", paths: ["packages/coding-agent/src/core/tools/windows-directory-security.ts"] },
	{ owner: "#5345", paths: ["packages/coding-agent/src/core/worktree-snapshot/"] },
];

const SQLITE_OWNER = "#5376 (node:sqlite statements off the event loop)";

/** An area owned by a change, by function, as `OWNED_ELSEWHERE` listed the node:sqlite driver's until #5376. */
const sqliteArea: readonly OwnedArea[] = [
	{
		owner: SQLITE_OWNER,
		functions: [
			"databaseNow",
			"NodeSqliteDatabase.createExecutor/statement",
			"NodeSqliteDatabase.createExecutor/<returned>.all/execute()",
		].map((name) => ({ file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name })),
		sampledCallersOfOwnedCalls: ["NodeSqliteDatabase.commitAlone", "NodeSqliteDatabase.commitMembers"].map(
			(name) => ({ file: "packages/coding-agent/src/core/storage/node-sqlite.ts", name }),
		),
	},
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
		"statement (file:///pkg/dist/core/storage/node-sqlite.js:1164:5)",
		"databaseNow (file:///pkg/dist/core/storage/node-sqlite.js:45:5)",
	]) {
		assert.equal(blockOwner(block(["prepare (node:sqlite:1:1)", frame]), sqliteArea), SQLITE_OWNER);
	}
	assert.equal(
		blockOwner(
			block([
				"prepare (node:sqlite:1:1)",
				"(anonymous) (file:///pkg/dist/core/storage/node-sqlite.js:1175:30)",
				"driver (file:///pkg/dist/core/storage/node-sqlite.js:935:16)",
				"execute (file:///pkg/dist/core/storage/node-sqlite.js:1161:21)",
				"all (file:///pkg/dist/core/storage/node-sqlite.js:1175:21)",
			]),
			[
				{
					owner: "#5376 (node:sqlite statements off the event loop)",
					functions: [
						{
							file: "packages/coding-agent/src/core/storage/node-sqlite.ts",
							name: "NodeSqliteDatabase.createExecutor/<returned>.all/execute()",
						},
					],
				},
			],
		),
		"#5376 (node:sqlite statements off the event loop)",
	);
});

test("a sampled caller of an owned call belongs to the area that owns the call, in sources and in the build", () => {
	for (const frame of [
		"commitAlone (file:///C:/w/0/atomic/packages/coding-agent/dist/core/storage/node-sqlite.js:1334:33)",
		"commitMembers (file:///repo/packages/coding-agent/src/core/storage/node-sqlite.ts:1539:20)",
	]) {
		assert.equal(
			blockOwner(block(["promiseInitHook (node:internal/async_hooks:329:3)", frame]), sqliteArea),
			SQLITE_OWNER,
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
					{ count: 3, frame: "rebuildIndex (file:///x/dist/builtin/workflows/src/fleet/controller.js:10:5)" },
				],
				stacks: [
					{
						count: 3,
						frames: [
							"rebuildIndex (file:///x/dist/builtin/workflows/src/fleet/controller.js:10:5)",
							"journalStep (file:///x/dist/builtin/workflows/src/fleet/controller.js:40:5)",
							"commitAlone (file:///x/dist/core/storage/node-sqlite.js:1500:5)",
							"runBatch (file:///x/dist/core/storage/node-sqlite.js:1420:5)",
						],
					},
				],
			},
			sqliteArea,
		),
		undefined,
	);
	for (const frames of [
		["rebuildIndex (file:///pkg/dist/builtin/workflows/src/extension/index.bundle.mjs:9120:5)"],
		["(anonymous) (file:///pkg/dist/builtin/workflows/src/extension/index.bundle.mjs:9120:5)"],
		["readdirSync (node:fs:1:1)", "liveTicketEntries (file:///pkg/dist/core/storage/node-sqlite.js:238:5)"],
		["realpathSync (node:fs:1:1)", "acquireOpenLockSync (file:///pkg/dist/core/storage/node-sqlite.js:615:5)"],
		["closeSync (node:fs:1:1)", "close (file:///pkg/dist/core/storage/node-sqlite.js:465:5)"],
		["prepare (node:sqlite:1:1)", "(anonymous) (file:///pkg/dist/core/storage/node-sqlite.js:1175:30)"],
	]) {
		assert.equal(blockOwner(block(frames), sqliteArea), undefined);
	}
});
