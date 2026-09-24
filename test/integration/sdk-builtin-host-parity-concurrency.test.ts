import assert from "node:assert/strict";
import { test } from "vitest";
import { type ManagedResult, RealPostgresHome, reserveListener } from "../helpers/real-postgres.js";
import { expectDrainedFixture, expectVerifiedFixture, runBuiltNodeFixture } from "./sdk-builtin-host-parity-helpers.js";

// Declared in-file: the duration guard resolves timeout expressions only from numeric consts in this file.
const BUILT_NODE_HOST_PROCESS_TIMEOUT_MS = 60_000;

test("retained workflow fixture rejects an unowned home before host initialization", () => {
	const result = runBuiltNodeFixture("sdk-host-concurrent-replacements.mjs", ["new", "dispose", "workflow"], [], {
		...process.env,
		ATOMIC_MANAGED_TEST_HOME: undefined,
	});
	assert.notEqual(result.exitCode, 0);
	assert.match(result.stderr.toString(), /requires a disposable managed HOME/);
});

// #3105: every admitted successor remains owned through reverse publication and failure.
// The duration guard expands only literal scalar test.each tables with a %s
// title, so the operation × outcome table is one declaration per operation.
// Titles reproduce vitest's quoted $variable rendering.
test.each(["success", "failure", "both-fail", "dispose", "cleanup", "startup"])(
	"built Node concurrent replacement 'new' '%s'",
	(outcome) => {
		expectDrainedFixture("sdk-host-concurrent-replacements.mjs", ["new", outcome]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["success", "failure", "both-fail", "dispose", "cleanup", "startup"])(
	"built Node concurrent replacement 'resume' '%s'",
	(outcome) => {
		expectDrainedFixture("sdk-host-concurrent-replacements.mjs", ["resume", outcome]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["success", "failure", "both-fail", "dispose", "cleanup", "startup"])(
	"built Node concurrent replacement 'fork' '%s'",
	(outcome) => {
		expectDrainedFixture("sdk-host-concurrent-replacements.mjs", ["fork", outcome]);
	},
	BUILT_NODE_HOST_PROCESS_TIMEOUT_MS + 5_000,
);

test.each(["success", "failure", "both-fail", "dispose", "cleanup", "startup"])(
	"built Node concurrent replacement 'import' '%s'",
	(outcome) => {
		expectDrainedFixture("sdk-host-concurrent-replacements.mjs", ["import", outcome]);
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
	async (outcome) => {
		const home = new RealPostgresHome();
		const reserved = await reserveListener();
		await reserved.close();
		try {
			const client = home.client(reserved.port);
			const managed = await client.request<ManagedResult>("ensure");
			expectDrainedFixture("sdk-host-concurrent-replacements.mjs", ["new", outcome, "workflow"], {
				...process.env,
				HOME: home.path,
				USERPROFILE: home.path,
				ATOMIC_CODING_AGENT_DIR: `${home.path}/agent`,
				ATOMIC_MANAGED_TEST_HOME: home.path,
				ATOMIC_POSTGRES_PORT: String(managed.metadata.server.port),
				DBOS_SYSTEM_DATABASE_URL: undefined,
				ATOMIC_POSTGRES_RUNTIME_DIR: undefined,
				ATOMIC_POSTGRES_RUNTIME_CACHE_DIR: home.runtimeCache,
				// Embedded resolution supplies its own URL. Refuse Docker before it can start a container.
				PGPORT: "0",
			});
		} finally {
			await home.cleanup();
		}
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
