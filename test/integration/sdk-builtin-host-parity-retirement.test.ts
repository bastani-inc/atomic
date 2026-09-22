import assert from "node:assert/strict";
import { test } from "vitest";
import { expectVerifiedFixture, runBuiltNodeFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

test.each(
	["new", "resume", "fork", "import"].flatMap((operation) =>
		["none", "cleanup"].map((failure) => ({ operation, failure })),
	),
)(
	"built Node finalizes failed $operation retirement with $failure failure",
	({ operation, failure }) => {
		const result = runBuiltNodeFixture("sdk-host-retirement-failure.mjs", [operation, failure]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			operation,
			failQuit: failure === "cleanup",
			finalized: true,
			creations: 0,
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: all existing replacement paths share terminal admission and tracked rollback.
test.each([
	...["preflight", "factory", "startup"].flatMap((phase) =>
		["new", "resume", "fork", "import"].map((operation) => ({ phase, operation, failure: "none" })),
	),
	{ phase: "prepare", operation: "resume", failure: "none" },
	{ phase: "factory", operation: "new", failure: "cleanup" },
	{ phase: "startup", operation: "new", failure: "rollback" },
])(
	"built Node drains $operation replacement suspended in $phase with $failure failure",
	({ phase, operation, failure }) => {
		const result = runBuiltNodeFixture("sdk-host-replacement-drain.mjs", [phase, operation, failure]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			phase,
			operation,
			failure,
			drained: true,
			active: 0,
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: command retirement hands off its caller without losing terminal cleanup.
test.each([
	"command",
	"command-cleanup",
	"command-create-failure",
	"command-retired",
	"ordinary",
	"ordinary-cleanup",
	"tool",
	"tool-control",
])(
	"built Node retirement and admitted completion (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-retirement-completion.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test(
	"built Node concurrent replacement commands retain terminal cleanup",
	() => {
		expectVerifiedFixture("sdk-host-retirement-completion.mjs", ["command-dual"]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: the installed candidate and retiring runner remain owned after rebuild failure.
test.each(["failure", "shutdown", "invalidation", "control"])(
	"built Node postcommit retiring cleanup (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-postcommit-cleanup.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);
