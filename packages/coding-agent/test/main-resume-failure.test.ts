import assert from "node:assert/strict";
import { mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.ts";
import { resolveSessionStore } from "../src/core/session-storage.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import { setWorktreeSnapshotGit } from "../src/index.ts";
import { main } from "../src/main.ts";

useTemporaryAgentDir();

const opening = vi.hoisted(() => ({
	failure: undefined as Error | undefined,
	result: undefined as unknown,
	calls: [] as unknown[][],
	prompts: [] as unknown[],
}));

vi.mock("../src/main-session.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/main-session.ts")>();
	return {
		...actual,
		openCliSession: async (...args: Parameters<typeof actual.openCliSession>) => {
			opening.calls.push(args);
			if (opening.failure) throw opening.failure;
			if (opening.result !== undefined) return opening.result as Awaited<ReturnType<typeof actual.openCliSession>>;
			return actual.openCliSession(...args);
		},
		promptForDirtyCheckout: async (prompt: Parameters<typeof actual.promptForDirtyCheckout>[0]) => {
			opening.prompts.push(prompt);
			return "use" as const;
		},
	};
});

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	opening.failure = undefined;
	opening.result = undefined;
	opening.calls = [];
	opening.prompts = [];
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	sandbox.dispose();
});

/** A session recorded in the SQLite file `database` whose checkout then disappears from this machine. */
async function sessionRecordedElsewhere(database: string): Promise<string> {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	sandbox.write(join(clone, "README.md"), "edited on node A\n");
	const store = await resolveSessionStore(clone, {
		agentDir: sandbox.path("node-a-agent"),
		sessionStore: { kind: "sqlite", path: database },
	});
	cleanups.push(() => store.close());
	const manager = await SessionManager.create(store, clone);
	await manager.appendMessage({ role: "user", content: "edit", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: store.snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	renameSync(clone, sandbox.path("node-a-offline"));
	return manager.getSessionId();
}

test("atomic --session prints a resume failure with its fix once and exits 1 (#4329)", async () => {
	const database = sandbox.path("sessions.sqlite");
	const sessionId = await sessionRecordedElsewhere(database);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
	const previousGit = setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
	cleanups.push(() => {
		setWorktreeSnapshotGit(previousGit);
	});
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit);

	await assert.rejects(
		main(["--no-extensions", "--session-store", database, "--session", sessionId, "-p", "continue"]),
		/^Error: process\.exit\(1\)$/,
	);

	const printed = errors.mock.calls.map(([message]) => String(message));
	assert.equal(printed.length, 1);
	assert.match(
		printed[0] ?? "",
		/^\S*Error: Cannot resume here: git \(\S+\) \(git-unavailable\): session [0-9a-f-]+ must be restored/,
	);
});

test("a failure that is not a resume failure is not printed as one: it propagates (#4329)", async () => {
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
	opening.failure = new TypeError("a bug, not a resume failure");
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	const exit = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit);

	await assert.rejects(main(["--no-extensions", "--session", "abc", "-p", "continue"]), opening.failure);

	assert.equal(errors.mock.calls.length, 0);
	assert.equal(exit.mock.calls.length, 0);
});

test("a cancelled resume exits 0; an opened one continues with the session, and print mode never prompts (#4329)", async () => {
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
	vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
		throw new Error(`process.exit(${code})`);
	}) as typeof process.exit);

	opening.result = "cancelled";
	await assert.rejects(main(["--no-extensions", "--session", "abc", "-p", "continue"]), /^Error: process\.exit\(0\)$/);

	const used = new Error("the opened session was used");
	opening.result = {
		sessionManager: new Proxy(
			{},
			{
				get: () => () => {
					throw used;
				},
			},
		),
		notices: [],
	};
	await assert.rejects(main(["--no-extensions", "--session", "abc", "-p", "continue"]), used);
	const options = opening.calls.at(-1)?.[3] as { chooseDirtyCheckout?: unknown; agentDir?: string };
	assert.equal(options.chooseDirtyCheckout, undefined);
	assert.equal(options.agentDir, sandbox.path("agent"));
});

// main() exits through the mocked process.exit holding the session store it opened, and Windows cannot delete an open
// SQLite file when the sandbox is removed.
test.skipIf(process.platform === "win32")(
	"a database session whose directory is gone and has no snapshot to restore stops print mode with the missing directory (#4329)",
	async () => {
		const database = sandbox.path("sessions.sqlite");
		const gone = sandbox.path("deleted-project");
		mkdirSync(gone);
		const store = await resolveSessionStore(gone, {
			agentDir: sandbox.path("node-a-agent"),
			sessionStore: { kind: "sqlite", path: database },
		});
		const manager = await SessionManager.create(store, gone);
		await manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await store.close();
		rmSync(gone, { recursive: true });
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);

		await assert.rejects(
			main(["--no-extensions", "--session-store", database, "--session", manager.getSessionId(), "-p", "continue"]),
			/^Error: process\.exit\(1\)$/,
		);

		const printed = errors.mock.calls.map(([message]) => String(message)).join("\n");
		assert.ok(printed.includes(`Stored session working directory does not exist: ${gone}`), printed);
	},
);

test("interactive mode offers the dirty-checkout prompt to the resume (#4329)", async () => {
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
	const used = new Error("the opened session was used");
	opening.result = {
		sessionManager: new Proxy(
			{},
			{
				get: () => () => {
					throw used;
				},
			},
		),
		notices: [],
	};

	await assert.rejects(
		main(["--no-extensions", "--session", "abc"], {
			internalInteractiveHarness: { forceInteractive: true, terminal: {} as Terminal },
		}),
		used,
	);

	const options = opening.calls.at(-1)?.[3] as {
		chooseDirtyCheckout?: (prompt: { checkout: string; recordedRoot: string; snapshotId: string }) => Promise<string>;
	};
	const prompt = { checkout: "/node-b/repo", recordedRoot: "/node-a/repo", snapshotId: "0123456789ab" };
	assert.equal(await options.chooseDirtyCheckout?.(prompt), "use");
	assert.deepEqual(opening.prompts, [prompt]);
});
