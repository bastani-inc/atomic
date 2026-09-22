import assert from "node:assert/strict";
import { test } from "vitest";
import { expectVerifiedFixture, runBuiltNodeFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

// The duration guard expands only literal scalar test.each tables with a %s
// title, so each two-variable table below is written as one declaration per
// fixed first variable. Titles reproduce vitest's quoted $variable rendering.
function assertFailedRetirementFinalized(operation: string, failure: string): void {
	const result = runBuiltNodeFixture("sdk-host-retirement-failure.mjs", [operation, failure]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
		operation,
		failQuit: failure === "cleanup",
		finalized: true,
		creations: 0,
	});
}

test.each(["none", "cleanup"])(
	"built Node finalizes failed 'new' retirement with '%s' failure",
	(failure) => {
		assertFailedRetirementFinalized("new", failure);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test.each(["none", "cleanup"])(
	"built Node finalizes failed 'resume' retirement with '%s' failure",
	(failure) => {
		assertFailedRetirementFinalized("resume", failure);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test.each(["none", "cleanup"])(
	"built Node finalizes failed 'fork' retirement with '%s' failure",
	(failure) => {
		assertFailedRetirementFinalized("fork", failure);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test.each(["none", "cleanup"])(
	"built Node finalizes failed 'import' retirement with '%s' failure",
	(failure) => {
		assertFailedRetirementFinalized("import", failure);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: all existing replacement paths share terminal admission and tracked rollback.
function assertSuspendedReplacementDrained(phase: string, operation: string, failure: string): void {
	const result = runBuiltNodeFixture("sdk-host-replacement-drain.mjs", [phase, operation, failure]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
		phase,
		operation,
		failure,
		drained: true,
		active: 0,
	});
}

test.each(["new", "resume", "fork", "import"])(
	"built Node drains '%s' replacement suspended in 'preflight' with 'none' failure",
	(operation) => {
		assertSuspendedReplacementDrained("preflight", operation, "none");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test.each(["new", "resume", "fork", "import"])(
	"built Node drains '%s' replacement suspended in 'factory' with 'none' failure",
	(operation) => {
		assertSuspendedReplacementDrained("factory", operation, "none");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test.each(["new", "resume", "fork", "import"])(
	"built Node drains '%s' replacement suspended in 'startup' with 'none' failure",
	(operation) => {
		assertSuspendedReplacementDrained("startup", operation, "none");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test(
	"built Node drains 'resume' replacement suspended in 'prepare' with 'none' failure",
	() => {
		assertSuspendedReplacementDrained("prepare", "resume", "none");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test(
	"built Node drains 'new' replacement suspended in 'factory' with 'cleanup' failure",
	() => {
		assertSuspendedReplacementDrained("factory", "new", "cleanup");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

test(
	"built Node drains 'new' replacement suspended in 'startup' with 'rollback' failure",
	() => {
		assertSuspendedReplacementDrained("startup", "new", "rollback");
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
