import { test } from "vitest";
import { expectSilentVerifiedFixture, expectVerifiedFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

// #3105: local HTTP transport stays lazy and another session's close preserves its connection.
test(
	"built Node lazy MCP HTTP ownership",
	() => {
		expectVerifiedFixture("sdk-host-lazy-mcp.mjs");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: the built logger uses owner sinks, not process console, including default no-sink SDK usage.
test.each([false, true])(
	"built Node MCP diagnostics are quiet withoutSink=%s",
	(withoutSink) => {
		expectSilentVerifiedFixture("sdk-host-mcp-diagnostics.mjs", withoutSink ? ["--without-sink"] : []);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: borrowed builtin discovery must not share mutable web results or cleanup authority.
test(
	"built Node web result ownership across sibling reload and overlapping close",
	() => {
		expectSilentVerifiedFixture("sdk-host-web-owners.mjs");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: close unregisters one lease, never the shared broker or sibling identity.
test(
	"built Node Intercom lazy broker group authorization and independent leases",
	() => {
		expectSilentVerifiedFixture("sdk-host-intercom-owners.mjs", [], { allowSqliteWarning: true });
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

// #3105: missing optional providers/extractors must not become empty successful tool results.
test(
	"built Node unavailable web dependencies return explicit errors and exit naturally",
	() => {
		expectSilentVerifiedFixture("sdk-host-web-unavailable.mjs");
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);
