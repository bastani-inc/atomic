import assert from "node:assert/strict";
import { test } from "vitest";
import { runBuiltNodeFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

// #3105: supported shared buses do not transfer workflow lifetime ownership.
test.each(["bus", "loader", "facade", "subclass"])(
	"built Node shared-%s sibling reload and disposal preserve a pending workflow and exit naturally",
	(shared) => {
		const result = runBuiltNodeFixture("sdk-host-shared-bus.mjs", [shared]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			distinctOwners: true,
			siblingReloadedAndClosed: true,
			retained: "running",
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: initial owners and queue admission use the same lifecycle in a real Node process.
test.each(["owner", "steer", "followUp"])(
	"built Node review %s lifecycle closes naturally",
	(mode) => {
		const result = runBuiltNodeFixture("sdk-host-review-lifecycle.mjs", [mode]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), { mode, closed: true });
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: release admitted callbacks while disposal is pending, then require real cleanup and natural exit.
test.each(["prompt", "reload", "compact", "compact-provider"] as const)(
	"built Node drains suspended %s admission before completing disposal",
	(scenario) => {
		const result = runBuiltNodeFixture("sdk-host-admission-drain.mjs", [scenario]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			scenario,
			drained: true,
			providerCalls: scenario === "compact-provider" ? 1 : 0,
			active: 0,
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);

// #3105: initial public bind/start owns work before shutdown, with independent release.
test.each(["none", "startup", "cleanup"])(
	"built Node drains initial startup with %s failure",
	(failure) => {
		const result = runBuiltNodeFixture("sdk-host-initial-startup.mjs", [failure]);
		assert.equal(result.exitCode, 0, result.stderr.toString());
		assert.deepEqual(JSON.parse(result.stdout.toString().trim()), {
			drained: true,
			active: false,
			shutdowns: 1,
			failure,
		});
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS,
);
