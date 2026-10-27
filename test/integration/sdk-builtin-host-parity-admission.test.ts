import { test } from "vitest";
import { expectVerifiedFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

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
