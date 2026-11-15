import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { SessionManager } from "../src/core/session-manager.js";
import { resolveSessionStore } from "../src/core/session-storage.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import { main } from "../src/main.js";

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

/**
 * A session recorded in the SQLite file `database` whose checkout then disappears from this machine. With `remotes`,
 * its snapshot record names those remotes instead of the clone's.
 */
async function sessionRecordedElsewhere(database: string, remotes?: readonly string[]): Promise<string> {
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
	const snapshot = remotes === undefined ? capture.snapshot : { ...capture.snapshot, remotes: [...remotes] };
	await manager.appendWorktreeSnapshot(clone, snapshot.id, snapshot);
	renameSync(clone, sandbox.path("node-a-offline"));
	return manager.getSessionId();
}

test("atomic --session prints a resume failure with its fix once and exits 1 (#4329, #4733)", async () => {
	const database = sandbox.path("sessions.sqlite");
	const sessionId = await sessionRecordedElsewhere(database, ["https://user:token@example.invalid/repo.git"]);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
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
	assert.match(printed[0] ?? "", /Invalid snapshot record [0-9a-f]+: remotes\[0\] is not .*\(invalid-snapshot\)/);
	assert.doesNotMatch(printed[0] ?? "", /token/);
	assert.equal(
		existsSync(sandbox.path("agent", "session-claims", `${sessionId}.json`)),
		false,
		"the failed resume released its claim of the session (#5135)",
	);
});

// main() exits through the mocked process.exit; Windows cannot delete a SQLite file a test still has open.
test.skipIf(process.platform === "win32")(
	"atomic --session of a session another live process holds prints who holds it and exits 75, changing nothing (#5135)",
	async () => {
		const database = sandbox.path("sessions.sqlite");
		const store = await resolveSessionStore(sandbox.root, {
			agentDir: sandbox.path("node-a-agent"),
			sessionStore: { kind: "sqlite", path: database },
		});
		// Recorded in the directory main() runs in, so it opens without offering a fork.
		const manager = await SessionManager.create(store, process.cwd());
		await manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const sessionId = manager.getSessionId();
		await store.close();
		const holder = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
		cleanups.push(() => void holder.kill("SIGKILL"));
		await new Promise<void>((resolve) => holder.once("spawn", () => resolve()));
		const claim = sandbox.path("agent", "session-claims", `${sessionId}.json`);
		mkdirSync(sandbox.path("agent", "session-claims"), { recursive: true });
		writeFileSync(claim, JSON.stringify({ token: "holder", pid: holder.pid, host: hostname() }));
		vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
			throw new Error(`process.exit(${code})`);
		}) as typeof process.exit);

		await assert.rejects(
			main(["--no-extensions", "--session-store", database, "--session", sessionId, "-p", "continue"]),
			/^Error: process\.exit\(75\)$/,
		);

		const printed = errors.mock.calls.map(([message]) => String(message));
		assert.equal(printed.length, 1, printed.join("\n"));
		assert.ok(
			printed[0]!.includes(`Error: Session ${sessionId} is already open in process ${holder.pid} on ${hostname()}.`),
			printed[0],
		);
		assert.equal(JSON.parse(readFileSync(claim, "utf8")).pid, holder.pid, "the holder keeps its claim");
		assert.equal((opening.calls.at(-1)?.[3] as { claim?: boolean } | undefined)?.claim, true);
		const reopened = await resolveSessionStore(sandbox.root, {
			agentDir: sandbox.path("node-a-agent"),
			sessionStore: { kind: "sqlite", path: database },
		});
		cleanups.push(() => reopened.close());
		assert.equal((await SessionManager.open(reopened, sessionId)).getEntries().length, 1, "nothing was written");
	},
);

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

test("print mode opens its session without startup progress, even on a terminal (#4660)", async () => {
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", sandbox.path("agent"));
	Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
	cleanups.push(() => {
		Reflect.deleteProperty(process.stderr, "isTTY");
	});
	opening.failure = new TypeError("stop after the session options are read");

	await assert.rejects(main(["--no-extensions", "--session", "abc", "-p", "continue"]), opening.failure);

	const options = opening.calls.at(-1)?.[3] as { progress?: unknown; blueprints?: string } | undefined;
	assert.equal(options?.progress, undefined);
	assert.equal(options?.blueprints, "build");
});
