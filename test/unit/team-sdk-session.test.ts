import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { StorageConfigError } from "../../packages/coding-agent/src/core/storage/errors.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

/** createAgentSession composes the session's extension runtime before it returns. */
const SESSION_CREATION_TIMEOUT_MS = 60_000;
const NO_BUILTINS = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;

let root: string;
let agentDir: string;

beforeEach(() => {
	root = makeTempDirectory("team-sdk-session-");
	agentDir = join(root, "agent");
	mkdirSync(join(root, "project"), { recursive: true });
	for (const name of ["ATOMIC_STORAGE", "ATOMIC_SESSIONS_STORAGE", "ATOMIC_WORKFLOWS_JOURNAL", "ATOMIC_PROFILE"]) {
		vi.stubEnv(name, "");
	}
});

afterEach(() => {
	vi.unstubAllEnvs();
	removeTempDirectory(root);
});

test(
	"createAgentSession({ storage }) selects the session store and the workflow journal, and sessionStore and journal outrank it (#4320)",
	async () => {
		const storage = { path: join(root, "sdk-storage.sqlite") };
		const { session } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir,
			storage,
			builtins: NO_BUILTINS,
		});
		try {
			assert.equal(session.sessionManager.getSessionStore().descriptor.location, join(root, "sdk-storage.sqlite"));
			assert.equal((session as unknown as { _workflowJournal: object })._workflowJournal, storage);
		} finally {
			await session.dispose();
		}
		const journal = { memory: true } as const;
		const { session: explicit } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir,
			storage,
			journal,
			sessionStore: { kind: "sqlite", path: join(root, "explicit.sqlite") },
			builtins: NO_BUILTINS,
		});
		try {
			assert.equal(explicit.sessionManager.getSessionStore().descriptor.location, join(root, "explicit.sqlite"));
			assert.equal((explicit as unknown as { _workflowJournal: object })._workflowJournal, journal);
		} finally {
			await explicit.dispose();
		}
		const { session: plain } = await createAgentSession({
			cwd: join(root, "project"),
			agentDir,
			builtins: NO_BUILTINS,
		});
		try {
			assert.equal(
				plain.sessionManager.getSessionStore().descriptor.location,
				join(root, "workflows", "journal.sqlite"),
			);
			assert.equal((plain as unknown as { _workflowJournal?: object })._workflowJournal, undefined);
		} finally {
			await plain.dispose();
		}
	},
	SESSION_CREATION_TIMEOUT_MS,
);

test(
	"an invalid createAgentSession({ storage }) is a config error naming the option (#4320)",
	async () => {
		const error = await createAgentSession({
			cwd: join(root, "project"),
			agentDir,
			storage: { adapter: "" },
			builtins: NO_BUILTINS,
		}).then(
			() => assert.fail("created a session with an invalid storage selection"),
			(caught: Error) => caught,
		);
		assert.ok(error instanceof StorageConfigError);
		assert.deepEqual([error.source, error.field, error.reason], ["sdk", "storage", "invalid-adapter"]);
	},
	SESSION_CREATION_TIMEOUT_MS,
);
