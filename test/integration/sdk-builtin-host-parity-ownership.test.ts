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

// #3105: completion persistence and every candidate/provider acquisition survive closing until settled.
test.each(["persist", "prepare", "prepare-cleanup", "summary", "summary-superseded", "summary-reload"])(
	"built Node completion persistence and cleanup (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-completion-cleanup.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: candidate ownership includes publication and retired initialization failures.
test.each(["activate", "commit", "settings", "activate-cleanup", "control", "mcp-failure", "mcp-control"])(
	"built Node publication and MCP cleanup (%s)",
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

// #3105: filtered acquisition cleanup must preserve selected shared-runtime capabilities.
test.each(["subset", "none", "all", "startup", "cleanup"])(
	"built Node filtered creation ownership (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-filtered-acquisition.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: built exports preserve per-factory authority and direct action admission.
test.each(["subset", "none", "all", "rollback", "cleanup"])(
	"built Node filtered reload boundaries (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-filtered-reload.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["close", "reload", "rollback", "cancel", "drain"])(
	"built Node direct extension admission (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-direct-admission.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: natural Node exit and repeatable GC prove cleanup ownership beyond callback return.
test.each([
	"getter-ordinary",
	"getter-ordinary-cleanup",
	"getter-transaction",
	"getter-transaction-cleanup",
	"getter-control",
	"getter-creation",
	"getter-after-transfer",
	"spawn-close",
	"spawn-close-error",
	"spawn-control",
	"spawn-candidate",
	"spawn-candidate-error",
	"spawn-factory",
	"release-manual",
	"release-invalidate",
	"release-throwing",
	"release-invalidate-throwing",
])(
	"built Node cleanup ownership boundaries (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-cleanup-boundaries.mjs", [mode], ["--expose-gc"]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: failed factory batches seal together and drain before their cleanup hooks.
test.each([
	"drain-inline",
	"drain-path",
	"drain-error",
	"drain-control",
	"peer-creation",
	"peer-error",
	"peer-replay",
	"peer-ordinary",
	"peer-transaction",
	"peer-transaction-overlap",
	"subset",
	"subset-startup",
])(
	"built Node factory rollback ownership (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-factory-rollback.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: SDK-started refresh must settle before cleanup, including failed factory replay.
test.each(["dispose", "reload", "control", "error", "replay", "replay-error", "overlap", "self"])(
	"built Node workflow refresh ownership (%s)",
	(mode) => {
		expectVerifiedFixture("sdk-host-refresh-drain.mjs", [mode]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);
