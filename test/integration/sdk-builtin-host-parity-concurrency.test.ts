import { test } from "vitest";
import { expectDrainedFixture, expectVerifiedFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

// #3105: every admitted successor remains owned through reverse publication and failure.
test.each(
	["new", "resume", "fork", "import"].flatMap((operation) =>
		["success", "failure", "both-fail", "dispose", "cleanup", "startup"].map((outcome) => ({ operation, outcome })),
	),
)(
	"built Node concurrent replacement $operation $outcome",
	({ operation, outcome }) => {
		expectDrainedFixture("sdk-host-concurrent-replacements.mjs", [operation, outcome]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["acquisition", "shell", "settings"])(
	"built Node owned cleanup %s",
	(mode) => {
		expectVerifiedFixture("sdk-host-acquisition-persistence.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["success", "failure", "both-fail", "dispose", "cleanup", "startup"])(
	"built Node overlapping retained workflow %s",
	(outcome) => {
		expectDrainedFixture("sdk-host-concurrent-replacements.mjs", ["new", outcome, "workflow"]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["overlap", "nested"])(
	"built Node replacement binding remains live without deadlock (%s)",
	(mode) => {
		expectDrainedFixture("sdk-host-replacement-binding-overlap.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);
