import { test } from "vitest";
import { expectVerifiedFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

// #3105: use built public exports and natural Node exit for all three final lifecycle roots.
test.each([
	"path",
	"path-reject",
	"path-cleanup",
	"reload",
	"reload-reject",
	"thinking",
	"name",
	"bus",
	"observer",
	"context",
	"shortcut",
])(
	"built Node factory, input and dispatch ownership (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-dispatch-lifecycle.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["persist", "prepare", "prepare-cleanup", "summary", "summary-superseded", "summary-reload"])(
	"built Node completion persistence and cleanup (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-completion-cleanup.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: candidate ownership includes publication and retired initialization failures.
test.each(["activate", "commit", "settings", "activate-cleanup", "control"])(
	"built Node publication and candidate cleanup (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-publication-cleanup.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// Native transport retirement and SDK cleanup-failure retention are independent contracts.
test.each(["mcp-failure", "mcp-control"])(
	"built Node native MCP retirement and SDK cleanup retention (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-publication-cleanup.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: transfer, rollback and self-reload retain all generation-owned execution.
test.each([
	"acquire-success",
	"acquire-failure",
	"acquire-cleanup",
	"candidate",
	"candidate-cleanup",
	"self",
	"self-cleanup",
	"self-ordinary",
	"self-twice",
])(
	"built Node reload acquisition and callback ownership (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-reload-ownership.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);
