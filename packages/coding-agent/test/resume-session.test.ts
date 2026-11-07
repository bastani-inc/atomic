import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { clearWorktreeRootMappings } from "../src/core/resume/path-mapping.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { resolveToCwd } from "../src/core/tools/path-utils.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import type { WorktreeRootMapping, WorktreeSnapshot } from "../src/core/worktree-snapshot/types.ts";
import {
	type DirtyCheckoutChoice,
	type DirtyCheckoutPrompt,
	type EnsureResumeSetupOptions,
	ensureResumeSetup,
	GitProvisionTimeoutError,
	GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceSnapshotError,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	RESUME_SETUP_COMMAND_SETTING,
	RESUME_SETUP_HOOK_FILE,
	ResumePreconditionError,
	type ResumePreflightIo,
	ResumeSetupHookError,
	readResumeSetupLedger,
	setWorktreeSnapshotGit,
	WorkspaceDriftError,
} from "../src/index.ts";
import { appendLineCommand, nodeCommand, SLEEPING_COMMAND, SUCCEEDING_COMMAND } from "./helpers/hook-commands.ts";
import { missingGit } from "./helpers/missing-git.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
	clearWorktreeRootMappings();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	clearWorktreeRootMappings();
	sandbox.dispose();
});

async function sqlStore(name: string): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

/** A session on "node A" whose last turn recorded a snapshot of `root`, with its cwd at `cwd`. */
async function recordSession(root: string, cwd = root): Promise<SessionManager> {
	const store = await sqlStore("sessions");
	const manager = await SessionManager.create(store, cwd);
	await manager.appendMessage({ role: "user", content: "edit the files", timestamp: Date.now() });
	const capture = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(capture.status, "captured");
	if (capture.status !== "captured") throw new Error("unreachable");
	await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	return manager;
}

/** A clone with an unpushed commit, an uncommitted edit, an untracked file and a lockfile, as scenario 1 records. */
async function editedClone() {
	const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n", "package-lock.json": "{}\n" });
	sandbox.write(join(clone, "committed.txt"), "unpushed\n");
	const head = await sandbox.commitAll(clone, "unpushed commit");
	sandbox.write(join(clone, "README.md"), "edited\n");
	sandbox.write(join(clone, "notes", "untracked.txt"), "untracked\n");
	return { clone, head };
}

class CountingGitIo implements ResumePreflightIo {
	probes = 0;
	constructor(private readonly gitError?: GitUnavailableError) {}
	async loadAdapter(): Promise<void> {}
	async readText(): Promise<string> {
		return "";
	}
	env(): string | undefined {
		return undefined;
	}
	async probeGit(): Promise<GitUnavailableError | undefined> {
		this.probes++;
		return this.gitError;
	}
}

function options(overrides: Partial<PrepareSessionResumeOptions> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		setup: { command: appendLineCommand(sandbox.path("setup-runs.txt"), "ran"), trusted: () => false },
		...overrides,
	};
}

function cwdOf(prepared: PreparedSessionResume): string | undefined {
	return prepared.status === "ready" ? prepared.sessionManager.getCwd() : undefined;
}

/** The typed failure of a recorded root this user cannot read: Atomic's `unreadable-path`, caused by EACCES. */
function assertUnreadable(error: unknown): void {
	assert.ok(isWorkspaceSnapshotError(error), String(error));
	assert.equal(error.code, "unreadable-path");
	assert.equal((error.cause as NodeJS.ErrnoException).code, "EACCES");
}

function setupRuns(): number {
	return existsSync(sandbox.path("setup-runs.txt"))
		? readFileSync(sandbox.path("setup-runs.txt"), "utf8").trim().split("\n").length
		: 0;
}

describe("prepareSessionResume on a node without the recorded checkout (#4329)", () => {
	test("restores a byte-identical fresh worktree, runs the setup hook once and maps old-root tool paths", async () => {
		const { clone, head } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameSync(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();

		const prepared = await prepareSessionResume(manager, options({ io }));

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		const restoredRoot = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(restoredRoot.startsWith(sandbox.path("host")));
		assert.equal(cwdOf(prepared), join(restoredRoot, "notes"));
		assert.equal(readFileSync(join(restoredRoot, "README.md"), "utf8"), "edited\n");
		assert.equal(readFileSync(join(restoredRoot, "committed.txt"), "utf8"), "unpushed\n");
		assert.equal(readFileSync(join(restoredRoot, "notes", "untracked.txt"), "utf8"), "untracked\n");
		assert.equal(await sandbox.git(restoredRoot, "rev-parse", "HEAD"), head);
		assert.equal(io.probes, 1);
		assert.equal(setupRuns(), 1);
		assert.deepEqual(
			prepared.notices.map((notice) => notice.type),
			["info", "info"],
		);
		assert.match(prepared.notices[0]!.message, /^Restored worktree snapshot \w{12} of /);
		assert.ok(prepared.notices[0]!.message.includes(` of ${clone} into `), prepared.notices[0]!.message);
		assert.match(prepared.notices[1]!.message, new RegExp(`^Ran setup hook ${RESUME_SETUP_COMMAND_SETTING} in`));
		const ledger = await readResumeSetupLedger(sandbox.path("host"), restoredRoot);
		assert.equal(ledger?.exitStatus, 0);
		assert.equal(ledger?.hook, RESUME_SETUP_COMMAND_SETTING);
		assert.equal(resolveToCwd(join(clone, "README.md"), cwdOf(prepared)!), join(restoredRoot, "README.md"));

		const again = await prepareSessionResume(manager, options({ io }));
		assert.equal(cwdOf(again), cwdOf(prepared));
		assert.equal(setupRuns(), 1);
		assert.equal(io.probes, 1);
	});

	test("fails before any write when Git cannot be started and a restore is needed", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo(missingGit());
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		await assert.rejects(prepareSessionResume(manager, options({ io })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.equal(error.code, "preconditions-unmet");
			assert.deepEqual(
				error.problems.map((problem) => problem.code),
				["git-unavailable"],
			);
			assert.match(error.problems[0]!.why, /does not exist on this node/);
			assert.equal(error.hint, missingGit().hint);
			return true;
		});
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
	});

	test("Git that cannot be provisioned is probed once, before the launch checkout is read, and causes the precondition error", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("node-a-gone"));
		const timeout = new GitProvisionTimeoutError({ phase: "download", timeoutMs: 600_000, elapsedMs: 600_004 });
		const unavailable = new GitUnavailableError(
			{ code: "not-installed", platform: "linux", arch: "x64", installDir: "/home/u/.atomic/agent/bin/git" },
			{ cause: timeout },
		);
		const io = new CountingGitIo(unavailable);
		const launchCwd = sandbox.path("launch");
		mkdirSync(launchCwd);
		setWorktreeSnapshotGit(async () => {
			throw new Error("Git must not be resolved again after the probe failed");
		});

		await assert.rejects(prepareSessionResume(manager, options({ io, launchCwd })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.deepEqual(
				error.problems.map((problem) => [problem.code, problem.subject]),
				[["git-unavailable", "git (not-installed)"]],
			);
			assert.equal(error.cause, unavailable);
			return true;
		});
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("propagates #4245's typed drift error when the snapshot cannot be restored", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "deploy.key"), "PRIVATE\n");
		await sandbox.commitAll(clone, "unpushed key");
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("node-a-gone"));
		await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => {
			assert.ok(isWorkspaceDriftError(error));
			return true;
		});
		assert.equal(setupRuns(), 0);
	});

	test("does nothing when snapshots are disabled or the session recorded none", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();
		const disabled = await prepareSessionResume(manager, options({ io, settings: { ...settings, enabled: false } }));
		assert.deepEqual(disabled, { status: "ready", sessionManager: manager, notices: [] });
		const empty = await SessionManager.create(await sqlStore("empty"), sandbox.root);
		assert.deepEqual(await prepareSessionResume(empty, options({ io })), {
			status: "ready",
			sessionManager: empty,
			notices: [],
		});
		assert.equal(io.probes, 0);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("restores every recorded checkout when the session works outside all of them (review findings 1 and 2)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, sandbox.root);
		renameSync(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();

		const prepared = await prepareSessionResume(manager, options({ io }));

		assert.equal(prepared.status, "ready");
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => mapping.from),
			[clone],
		);
		assert.ok(mappings[0]!.to.startsWith(sandbox.path("host")));
		assert.equal(readFileSync(join(mappings[0]!.to, "README.md"), "utf8"), "edited\n");
		assert.equal(cwdOf(prepared), sandbox.root);
		assert.equal(io.probes, 1);
		assert.equal(setupRuns(), 1);
		assert.match(prepared.status === "ready" ? prepared.notices[0]!.message : "", /^Restored worktree snapshot/);
	});
});

describe("prepareSessionResume started in a checkout of the session's repository (#4329)", () => {
	async function movedCheckout() {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		return { clone, manager, checkout };
	}

	test("uses a matching checkout as-is and records the mapping without restoring or running setup", async () => {
		const { clone, manager, checkout } = await movedCheckout();
		const prompts: DirtyCheckoutPrompt[] = [];
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: join(checkout, "notes"),
				chooseDirtyCheckout: async (prompt) => {
					prompts.push(prompt);
					return "cancel";
				},
			}),
		);
		assert.deepEqual(cwdOf(prepared), join(checkout, "notes"));
		assert.equal(prepared.status === "ready" && prepared.notices[0]?.type, "info");
		assert.match(prepared.status === "ready" ? prepared.notices[0]!.message : "", /which matches snapshot/);
		assert.deepEqual(prompts, []);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[[clone, checkout]],
		);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
		assert.equal(resolveToCwd(join(clone, "README.md"), join(checkout, "notes")), join(checkout, "README.md"));
	});

	const dirtyCases: ReadonlyArray<[DirtyCheckoutChoice | "non-interactive", "use" | "restore" | "cancelled"]> = [
		["use", "use"],
		["restore", "restore"],
		["cancel", "cancelled"],
		["non-interactive", "restore"],
	];
	for (const [choice, outcome] of dirtyCases) {
		test(`a dirty checkout answered '${choice}' ends in '${outcome}' and never changes the checkout`, async () => {
			const { clone, manager, checkout } = await movedCheckout();
			sandbox.write(join(checkout, "README.md"), "user edit\n");
			const prompts: DirtyCheckoutPrompt[] = [];
			const prepared = await prepareSessionResume(
				manager,
				options({
					launchCwd: checkout,
					...(choice === "non-interactive"
						? {}
						: {
								chooseDirtyCheckout: async (prompt: DirtyCheckoutPrompt) => {
									prompts.push(prompt);
									return choice;
								},
							}),
				}),
			);
			assert.equal(readFileSync(join(checkout, "README.md"), "utf8"), "user edit\n");
			assert.equal(prompts.length, choice === "non-interactive" ? 0 : 1);
			if (prompts[0]) {
				assert.equal(prompts[0].checkout, checkout);
				assert.equal(prompts[0].recordedRoot, clone);
				assert.equal(prompts[0].snapshotId, manager.getLatestWorktreeSnapshots().get(clone)!.id);
			}
			const mappings = manager.getWorktreeRootMappings();
			if (outcome === "cancelled") {
				assert.deepEqual(prepared, { status: "cancelled" });
				assert.deepEqual(mappings, []);
				assert.equal(existsSync(sandbox.path("host")), false);
			} else if (outcome === "use") {
				assert.equal(cwdOf(prepared), join(checkout, "notes"));
				assert.equal(prepared.status === "ready" && prepared.notices[0]?.type, "warning");
				assert.match(
					prepared.status === "ready" ? prepared.notices[0]!.message : "",
					/which differs from snapshot/,
				);
				assert.deepEqual(
					mappings.map((mapping) => mapping.to),
					[checkout],
				);
				assert.equal(setupRuns(), 0);
			} else {
				assert.equal(prepared.status, "ready");
				assert.ok(mappings.at(-1)!.to.startsWith(sandbox.path("host")));
				assert.equal(readFileSync(join(mappings.at(-1)!.to, "README.md"), "utf8"), "edited\n");
				assert.equal(setupRuns(), 1);
			}
		});
	}

	test("a recorded checkout that is still here is resumed in place, even when started in another clone", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		const other = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), other);
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: other,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "use";
				},
			}),
		);
		assert.equal(cwdOf(prepared), join(clone, "notes"));
		assert.equal(asked, false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a matching checkout is used when the recorded path holds another tree here (review finding 11)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		const matching = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, matching);
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), clone);
		sandbox.write(join(clone, "README.md"), "node B's own tree at the recorded path\n");

		const prepared = await prepareSessionResume(manager, options({ launchCwd: matching }));

		assert.equal(cwdOf(prepared), join(matching, "notes"));
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[[clone, matching]],
		);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "node B's own tree at the recorded path\n");
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
	});

	test("a checkout where the recorded edits were committed is used as-is, without asking", async () => {
		const { clone, manager, checkout } = await movedCheckout();
		await sandbox.commitAll(checkout, "commit the recorded edits");
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: checkout,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "restore";
				},
			}),
		);
		assert.equal(asked, false);
		assert.equal(cwdOf(prepared), join(checkout, "notes"));
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => [mapping.from, resolve(mapping.to)]),
			[[clone, checkout]],
		);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a clean checkout at another commit restores a fresh worktree without asking; a dirty one asks", async () => {
		const { clone } = await editedClone();
		const [cleanSession, modifiedSession, untrackedSession] = [
			await recordSession(clone),
			await recordSession(clone),
			await recordSession(clone),
		] as const;
		renameSync(clone, sandbox.path("node-a-gone"));
		const prompts: DirtyCheckoutPrompt[] = [];
		const ask = async (prompt: DirtyCheckoutPrompt): Promise<DirtyCheckoutChoice> => {
			prompts.push(prompt);
			return "restore";
		};
		const teammateClone = async (name: string) => {
			const checkout = sandbox.path(name, "repo");
			mkdirSync(sandbox.path(name));
			await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), checkout);
			return checkout;
		};

		const clean = await prepareSessionResume(
			cleanSession,
			options({ launchCwd: await teammateClone("node-clean"), chooseDirtyCheckout: ask }),
		);
		assert.deepEqual(prompts, []);
		assert.ok(cwdOf(clean)?.startsWith(sandbox.path("host")), cwdOf(clean));

		const modified = await teammateClone("node-modified");
		sandbox.write(join(modified, "README.md"), "a local edit\n");
		await prepareSessionResume(modifiedSession, options({ launchCwd: modified, chooseDirtyCheckout: ask }));
		assert.deepEqual(
			prompts.map((prompt) => prompt.checkout),
			[modified],
		);

		const untracked = await teammateClone("node-untracked");
		sandbox.write(join(untracked, "scratch.txt"), "an untracked file\n");
		await prepareSessionResume(untrackedSession, options({ launchCwd: untracked, chooseDirtyCheckout: ask }));
		assert.deepEqual(
			prompts.map((prompt) => prompt.checkout),
			[modified, untracked],
		);
	});

	test("a checkout of another repository is never reused", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("node-a-gone"));
		const { clone: other } = await sandbox.remoteWithClone("other");
		let asked = false;
		await prepareSessionResume(
			manager,
			options({
				launchCwd: other,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "use";
				},
			}),
		);
		assert.equal(asked, false);
		assert.ok(manager.getWorktreeRootMappings().at(-1)!.to.startsWith(sandbox.path("host")));
	});
});

describe("ensureResumeSetup (#4329)", () => {
	const envHash = "a".repeat(64);
	function worktree(files: Record<string, string> = { "package-lock.json": "{}\n" }): string {
		const root = sandbox.path("host", "worktrees", "wt");
		for (const [file, content] of Object.entries(files)) sandbox.write(join(root, file), content);
		return root;
	}
	const base = (root: string, command?: string, trusted = false) => ({
		entryPoint: "cli" as const,
		worktree: root,
		envHash,
		storeDir: sandbox.path("host"),
		config: { command, trusted: () => trusted, timeoutMs: 20_000 },
	});

	test("a worktree without dependency inputs needs no hook", async () => {
		const root = worktree({ "README.md": "x\n" });
		assert.deepEqual(await ensureResumeSetup(base(root)), { status: "not-needed" });
		assert.equal(await readResumeSetupLedger(sandbox.path("host"), root), undefined);
	});

	test("dependency inputs without a configured hook fail with setup-hook-missing before anything runs", async () => {
		const root = worktree();
		await assert.rejects(ensureResumeSetup(base(root)), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.equal(error.problems[0]?.code, "setup-hook-missing");
			assert.equal(error.problems[0]?.subject, "setup hook");
			assert.match(error.hint, /\.atomic\/setup/);
			assert.match(error.hint, /resume\.setupCommand/);
			return true;
		});
		assert.equal(await readResumeSetupLedger(sandbox.path("host"), root), undefined);
	});

	test("the repository's hook runs only in a trusted project", async () => {
		const root = worktree({
			"package-lock.json": "{}\n",
			[RESUME_SETUP_HOOK_FILE]: "#!/bin/sh\necho hook > hook-ran\n",
		});
		chmodSync(join(root, RESUME_SETUP_HOOK_FILE), 0o755);
		await assert.rejects(ensureResumeSetup(base(root)), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.equal(error.problems[0]?.subject, ".atomic/setup (untrusted project)");
			assert.match(error.hint, /--approve/);
			return true;
		});
		const ran = await ensureResumeSetup(base(root, undefined, true));
		assert.equal(ran.status === "ran" && ran.hook, RESUME_SETUP_HOOK_FILE);
		assert.equal(readFileSync(join(root, "hook-ran"), "utf8"), "hook\n");
		const ledger = await readResumeSetupLedger(sandbox.path("host"), root);
		assert.deepEqual([ledger?.envHash, ledger?.exitStatus, ledger?.hook], [envHash, 0, RESUME_SETUP_HOOK_FILE]);
	});

	test("a failing hook is typed, recorded, and runs again on the next resume", async () => {
		const root = worktree();
		await assert.rejects(
			ensureResumeSetup(base(root, nodeCommand("console.log('broken');process.exit(3)"))),
			(error: unknown) => {
				assert.ok(error instanceof ResumeSetupHookError);
				assert.equal(error.code, "setup-hook-failed");
				assert.equal(error.exitStatus, 3);
				assert.equal(error.hook, RESUME_SETUP_COMMAND_SETTING);
				assert.equal(readFileSync(error.logPath, "utf8"), "broken\n");
				return true;
			},
		);
		assert.equal((await readResumeSetupLedger(sandbox.path("host"), root))?.exitStatus, 3);
		const fixed = await ensureResumeSetup(base(root, SUCCEEDING_COMMAND));
		assert.equal(fixed.status, "ran");
		assert.deepEqual(await ensureResumeSetup(base(root, "exit 9")), { status: "not-needed" });
		const changed = await ensureResumeSetup({ ...base(root, SUCCEEDING_COMMAND), envHash: "b".repeat(64) });
		assert.equal(changed.status, "ran");
	});

	test("a hook that runs past its timeout is stopped and typed", async () => {
		const root = worktree();
		await assert.rejects(
			ensureResumeSetup({
				...base(root, SLEEPING_COMMAND),
				config: { command: SLEEPING_COMMAND, trusted: () => false, timeoutMs: 200 },
			}),
			(error: unknown) => {
				assert.ok(error instanceof ResumeSetupHookError);
				assert.equal(error.code, "setup-hook-timed-out");
				assert.equal(error.timeoutMs, 200);
				assert.ok(error.elapsedMs >= 200);
				assert.equal(error.signal, process.platform === "win32" ? null : "SIGKILL");
				return true;
			},
		);
	});

	test("cancellation stops the hook and rejects with the signal's reason, unwrapped", async () => {
		const root = worktree();
		const controller = new AbortController();
		const reason = new Error("user cancelled");
		const pending = ensureResumeSetup({
			...base(root, SLEEPING_COMMAND),
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(reason), 50);
		await assert.rejects(pending, (error: unknown) => error === reason);
		const aborted = new AbortController();
		aborted.abort(reason);
		await assert.rejects(
			ensureResumeSetup({ ...base(root, SUCCEEDING_COMMAND), signal: aborted.signal }),
			(error: unknown) => error === reason,
		);
	});

	test("a repository hook the shell cannot run is a typed failure with its exit status", async () => {
		const root = worktree({ "package-lock.json": "{}\n", [RESUME_SETUP_HOOK_FILE]: "not executable\n" });
		chmodSync(join(root, RESUME_SETUP_HOOK_FILE), 0o644);
		await assert.rejects(ensureResumeSetup(base(root, undefined, true)), (error: unknown) => {
			assert.ok(error instanceof ResumeSetupHookError);
			assert.equal(error.code, "setup-hook-failed");
			assert.ok(typeof error.exitStatus === "number" && error.exitStatus !== 0, String(error.exitStatus));
			return true;
		});
	});

	test("a hook that could not be started says so instead of an exit status", () => {
		const error = new ResumeSetupHookError("setup-hook-failed", {
			hook: RESUME_SETUP_HOOK_FILE,
			worktree: "/w",
			envHash,
			exitStatus: null,
			signal: null,
			logPath: "/w.log",
			timeoutMs: 1000,
			elapsedMs: 1,
		});
		assert.ok(error.message.startsWith("The setup hook .atomic/setup could not be started in /w"), error.message);
	});
});

describe("prepareSessionResume details (#4329)", () => {
	test("latestSessionSnapshot picks the innermost recorded root that contains the mapped cwd", async () => {
		const { latestSessionSnapshot } = await import("../src/core/resume/session-resume.ts");
		const outer = { id: "outer" } as WorktreeSnapshot;
		const inner = { id: "inner" } as WorktreeSnapshot;
		const source = (cwd: string, mappings: WorktreeRootMapping[] = []) => ({
			getCwd: () => cwd,
			getWorktreeRootMappings: () => mappings,
			getLatestWorktreeSnapshots: () =>
				new Map([
					["/repo", outer],
					["/repo/vendor/lib", inner],
				]),
		});
		assert.equal(latestSessionSnapshot(source("/repo/vendor/lib/src"))?.snapshot.id, "inner");
		const reversed = {
			...source("/repo/vendor/lib/src"),
			getLatestWorktreeSnapshots: () =>
				new Map([
					["/repo/vendor/lib", inner],
					["/repo", outer],
				]),
		};
		assert.equal(latestSessionSnapshot(reversed)?.snapshot.id, "inner");
		assert.equal(latestSessionSnapshot(source("/repo/src"))?.snapshot.id, "outer");
		assert.equal(latestSessionSnapshot(source("/elsewhere")), undefined);
		const moved = latestSessionSnapshot(
			source("/node-a/repo/src", [
				{ from: "/node-a/repo", to: "/repo", snapshotId: "s", tree: "t", restoredAt: "x" },
			]),
		);
		assert.deepEqual([moved?.root, moved?.cwd], ["/repo", resolve("/repo/src")]);
	});

	test("notices name the 12-character snapshot id and the checkouts", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const id = manager.getLatestWorktreeSnapshots().get(clone)!.id;
		const checkout = sandbox.path("moved");
		renameSync(clone, checkout);
		const matched = await prepareSessionResume(manager, options({ launchCwd: checkout }));
		assert.deepEqual(matched.status === "ready" && matched.notices, [
			{ type: "info", message: `Resuming in ${checkout}, which matches snapshot ${id.slice(0, 12)} of ${clone}` },
		]);
	});

	test("the dirty-checkout warning names the 12-character snapshot id", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const id = manager.getLatestWorktreeSnapshots().get(clone)!.id;
		const checkout = sandbox.path("moved");
		renameSync(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		const used = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, chooseDirtyCheckout: async () => "use" }),
		);
		assert.deepEqual(used.status === "ready" && used.notices, [
			{
				type: "warning",
				message: `Resuming in ${checkout}, which differs from snapshot ${id.slice(0, 12)} of ${clone}`,
			},
		]);
	});

	test("a checkout sharing one of several remotes with the snapshot is the same repository", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const checkout = sandbox.path("moved");
		renameSync(clone, checkout);
		await sandbox.git(checkout, "remote", "add", "mirror", sandbox.path("mirror.git"));
		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));
		assert.equal(cwdOf(prepared), checkout);
	});

	test("a snapshot of a repository without remotes is never matched to a checkout; it is restored", async () => {
		const root = sandbox.path("local-only");
		mkdirSync(root);
		await sandbox.git(root, "init", "-q");
		sandbox.write(join(root, "a.txt"), "a\n");
		await sandbox.commitAll(root, "initial");
		const manager = await recordSession(root);
		const checkout = sandbox.path("moved");
		renameSync(root, checkout);
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: checkout,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "use";
				},
			}),
		);
		assert.equal(asked, false);
		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host")));
	});

	test("the checkout is compared under the session's snapshot settings", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "scratch.txt"), "untracked\n");
		const narrow = { ...settings, includeUntracked: false };
		const store = await sqlStore("narrow");
		const manager = await SessionManager.create(store, clone);
		await manager.appendMessage({ role: "user", content: "x", timestamp: Date.now() });
		const capture = await captureWorktreeSnapshot(clone, { settings: narrow, blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const checkout = sandbox.path("moved");
		renameSync(clone, checkout);
		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout, settings: narrow }));
		assert.equal(prepared.status === "ready" && prepared.notices[0]?.type, "info");
		assert.equal(cwdOf(prepared), checkout);
	});

	test("recorded restores apply to tool paths even when snapshots are turned off", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const first = await prepareSessionResume(manager, options());
		const restored = cwdOf(first)!;
		clearWorktreeRootMappings();
		await prepareSessionResume(manager, options({ settings: { ...settings, enabled: false } }));
		assert.equal(resolveToCwd(join(clone, "README.md"), restored), join(restored, "README.md"));
	});

	test("a user checkout verified in place never runs the setup hook", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const prepared = await prepareSessionResume(manager, options());
		assert.equal(cwdOf(prepared), clone);
		assert.equal(setupRuns(), 0);
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a recorded root under a file is absent; one that cannot be checked fails instead of restoring",
		async () => {
			const { clone } = await editedClone();
			const manager = await recordSession(clone);
			renameSync(clone, sandbox.path("gone"));
			mkdirSync(dirname(clone), { recursive: true });
			writeFileSync(clone, "now a file");
			const underFile = await prepareSessionResume(manager, options());
			assert.ok(cwdOf(underFile)?.startsWith(sandbox.path("host")));

			const { clone: second } = await sandbox.remoteWithClone("second");
			const locked = await recordSession(second);
			chmodSync(dirname(second), 0o000);
			cleanups.push(() => chmodSync(dirname(second), 0o755));
			await assert.rejects(
				prepareSessionResume(locked, options({ storeDir: sandbox.path("host-2") })),
				(error: unknown) => {
					assertUnreadable(error);
					return true;
				},
			);
		},
	);
});

describe("ensureResumeSetup details (#4329)", () => {
	const envHash = "c".repeat(64);
	const worktree = () => {
		const root = sandbox.path("host", "worktrees", "wt");
		sandbox.write(join(root, "package-lock.json"), "{}\n");
		return root;
	};
	const base = (root: string, command?: string, trusted: (path: string) => boolean = () => false) => ({
		entryPoint: "cli" as const,
		worktree: root,
		envHash,
		storeDir: sandbox.path("host"),
		config: { command, trusted, timeoutMs: 20_000 },
	});

	test("a blank command is no hook at all", async () => {
		await assert.rejects(ensureResumeSetup(base(worktree(), "   ")), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.equal(error.problems[0]?.code, "setup-hook-missing");
			return true;
		});
	});

	test("the missing-hook problem explains both ways to configure one", async () => {
		const root = worktree();
		await assert.rejects(ensureResumeSetup(base(root)), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.deepEqual(error.problems[0], {
				code: "setup-hook-missing",
				subject: "setup hook",
				why: `the worktree restored at ${root} has dependency inputs (envHash ${envHash.slice(0, 12)}) that were never installed on this node, and neither .atomic/setup nor resume.setupCommand is configured`,
				fix: 'Add an executable .atomic/setup to the repository, or set "resume.setupCommand" (for example "npm ci") in ~/.atomic/agent/settings.json, then resume again.',
			});
			return true;
		});
		sandbox.write(join(root, RESUME_SETUP_HOOK_FILE), "#!/bin/sh\n");
		await assert.rejects(ensureResumeSetup(base(root)), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.equal(
				error.problems[0]?.why,
				`the worktree restored at ${root} has dependency inputs (envHash ${envHash.slice(0, 12)}) that were never installed on this node, and .atomic/setup runs only in a trusted project`,
			);
			assert.equal(
				error.problems[0]?.fix,
				'Trust the project (start with --approve, or set "defaultProjectTrust": "always"), or set "resume.setupCommand" in ~/.atomic/agent/settings.json, then resume again.',
			);
			return true;
		});
	});

	test("the repository hook runs with no arguments, the worktree as cwd and the resume environment", async () => {
		const root = worktree();
		sandbox.write(
			join(root, RESUME_SETUP_HOOK_FILE),
			'#!/bin/sh\nprintf "%s|%s|%s|%s\\n" "$#" "$(pwd -W 2>/dev/null || pwd)" "$ATOMIC_ENV_HASH" "$ATOMIC_RESUME_WORKTREE" > ../hook-env\necho hook-output\n',
		);
		chmodSync(join(root, RESUME_SETUP_HOOK_FILE), 0o755);
		const trustedPaths: string[] = [];
		const ran = await ensureResumeSetup(
			base(root, "false", (path) => {
				trustedPaths.push(path);
				return true;
			}),
		);
		assert.deepEqual(trustedPaths, [root]);
		const [count, cwd, hash, worktreeVariable] = readFileSync(join(root, "..", "hook-env"), "utf8")
			.trim()
			.split("|");
		assert.deepEqual([count, resolve(cwd!), hash, worktreeVariable], ["0", root, envHash, root]);
		assert.equal(ran.status === "ran" && readFileSync(ran.logPath, "utf8"), "hook-output\n");
		const ledger = await readResumeSetupLedger(sandbox.path("host"), root);
		assert.deepEqual(
			[ledger?.worktree, ledger?.signal, ledger?.logPath],
			[root, null, ran.status === "ran" && ran.logPath],
		);
		assert.ok(Date.parse(ledger!.ranAt) > 0);
	});

	test("a timed-out hook reports how long it ran", async () => {
		const root = worktree();
		const started = Date.now();
		await assert.rejects(
			ensureResumeSetup({ ...base(root), config: { command: "sleep 30", trusted: () => false, timeoutMs: 150 } }),
			(error: unknown) => {
				assert.ok(error instanceof ResumeSetupHookError);
				assert.ok(error.elapsedMs >= 150 && error.elapsedMs <= Date.now() - started, String(error.elapsedMs));
				return true;
			},
		);
	});
});

describe("prepareSessionResume: failure paths and notices (#4329)", () => {
	test("a recorded root below a path component that is now a file is absent", async () => {
		const remote = sandbox.path("nested-remote.git");
		await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
		const clone = sandbox.path("nested", "repo");
		await sandbox.git(sandbox.root, "clone", "-q", remote, clone);
		sandbox.write(join(clone, "a.txt"), "a\n");
		await sandbox.commitAll(clone, "initial");
		await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
		const manager = await recordSession(clone);
		renameSync(dirname(clone), sandbox.path("gone"));
		writeFileSync(dirname(clone), "now a file");
		const prepared = await prepareSessionResume(manager, options());
		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host")));
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a recorded root that cannot be checked fails before Git is probed or anything is restored",
		async () => {
			const { clone } = await sandbox.remoteWithClone("locked/repo");
			const manager = await recordSession(clone);
			chmodSync(dirname(clone), 0o000);
			cleanups.push(() => chmodSync(dirname(clone), 0o755));
			const io = new CountingGitIo();
			await assert.rejects(prepareSessionResume(manager, options({ io })), (error: unknown) => {
				assertUnreadable(error);
				return true;
			});
			assert.equal(io.probes, 0);
			assert.equal(existsSync(sandbox.path("host")), false);
		},
	);

	test("a checkout that cannot be compared fails instead of being treated as dirty", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const checkout = sandbox.path("moved");
		renameSync(clone, checkout);
		let asked = false;
		await assert.rejects(
			prepareSessionResume(
				manager,
				options({
					launchCwd: checkout,
					settings: { ...settings, maxFileBytes: -1 },
					chooseDirtyCheckout: async () => {
						asked = true;
						return "use";
					},
				}),
			),
			(error: unknown) => (error as { name?: string }).name === "WorkspaceConfigError",
		);
		assert.equal(asked, false);
	});

	test("the git precondition names the session, the 12-character snapshot id and the missing root", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const id = manager.getLatestWorktreeSnapshots().get(clone)!.id;
		renameSync(clone, sandbox.path("gone"));
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(
			prepareSessionResume(manager, options({ io: new CountingGitIo(missingGit()) })),
			(error: unknown) => {
				assert.ok(error instanceof ResumePreconditionError);
				assert.equal(
					error.problems[0]?.why,
					`session ${manager.getSessionId()} must be restored from snapshot ${id.slice(0, 12)} because ${clone} does not exist on this node`,
				);
				return true;
			},
		);
	});

	test("without Git a session whose checkout is still here fails typed instead of resuming unverified (#4329)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => isGitUnavailableError(error));
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("without Git a session already in a restored worktree fails typed without running setup", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const first = await prepareSessionResume(manager, options());
		assert.equal(first.status, "ready");
		assert.equal(setupRuns(), 1);
		rmSync(sandbox.path("host", "setup-ledger"), { recursive: true });
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => isGitUnavailableError(error));
		assert.equal(setupRuns(), 1);
	});

	test("a restore that needs no setup shows only the restore notice", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const prepared = await prepareSessionResume(manager, options());
		assert.equal(prepared.status === "ready" && prepared.notices.length, 1);
		assert.equal(setupRuns(), 0);
	});
});

describe("ensureResumeSetup: ledger, logs and cleanup (#4329)", () => {
	const envHash = "d".repeat(64);
	const worktreeAt = (name: string, files: Record<string, string> = { "package-lock.json": "{}\n" }) => {
		const root = sandbox.path("host", "worktrees", name);
		mkdirSync(root, { recursive: true });
		for (const [file, content] of Object.entries(files)) sandbox.write(join(root, file), content);
		return root;
	};
	const run = (root: string, command = SUCCEEDING_COMMAND, extra: Partial<EnsureResumeSetupOptions> = {}) =>
		ensureResumeSetup({
			entryPoint: "cli",
			worktree: root,
			envHash,
			storeDir: sandbox.path("host"),
			config: { command, trusted: () => false, timeoutMs: 20_000 },
			...extra,
		});

	test("each worktree has its own ledger entry, written readable only by the user", async () => {
		const first = worktreeAt("one");
		const second = worktreeAt("two");
		assert.equal((await run(first)).status, "ran");
		assert.equal((await run(second)).status, "ran");
		const ledgers = readdirSync(sandbox.path("host", "setup-ledger"));
		assert.equal(ledgers.length, 2);
		for (const ledger of ledgers) {
			if (process.platform === "win32") continue;
			assert.equal(statSync(sandbox.path("host", "setup-ledger", ledger)).mode & 0o777, 0o600);
		}
	});

	test("hook output goes to a .log file under setup-logs", async () => {
		const ran = await run(worktreeAt("logs"), nodeCommand("console.log('out')"));
		assert.ok(ran.status === "ran");
		if (ran.status !== "ran") return;
		assert.equal(dirname(ran.logPath), sandbox.path("host", "setup-logs"));
		assert.match(basename(ran.logPath), /^[0-9a-f]{12}-\d+\.log$/);
	});

	test("a ledger that cannot be read is an error, not a reason to run the hook again", async () => {
		const root = worktreeAt("corrupt");
		await run(root);
		const [ledger] = readdirSync(sandbox.path("host", "setup-ledger"));
		writeFileSync(sandbox.path("host", "setup-ledger", ledger!), "{");
		await assert.rejects(run(root), SyntaxError);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a lockfile path blocked by a file is no input; an unreadable worktree is an error",
		async () => {
			const blocked = worktreeAt("blocked", { ".devcontainer": "a file, not a directory\n" });
			assert.deepEqual(await run(blocked), { status: "not-needed" });
			const unreadable = worktreeAt("unreadable");
			chmodSync(unreadable, 0o000);
			cleanups.push(() => chmodSync(unreadable, 0o755));
			await assert.rejects(run(unreadable), (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES");
		},
	);

	test.skipIf(process.platform === "win32")("cancelling kills the hook and the processes it started", async () => {
		const marker = `${30 + Math.floor(Math.random() * 1000) / 1000}`;
		const controller = new AbortController();
		const command = `sleep 6${marker}; true`;
		const pending = run(worktreeAt("cancel"), command, {
			signal: controller.signal,
			config: { command, trusted: () => false, timeoutMs: 600_000 },
		});
		await new Promise((resolve) => setTimeout(resolve, 200));
		controller.abort(new Error("stop"));
		await assert.rejects(pending, /stop/);
		const alive = spawnSync("pgrep", ["-f", `sleep 6${marker}`]);
		assert.equal(alive.stdout.toString().trim(), "");
	});

	test("a finished hook leaves no timer behind", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			assert.equal((await run(worktreeAt("timers"))).status, "ran");
			assert.equal(vi.getTimerCount(), 0);
		} finally {
			vi.useRealTimers();
		}
	});

	test("cancelling after the hook finished signals no process", async () => {
		const controller = new AbortController();
		assert.equal(
			(await run(worktreeAt("finished"), SUCCEEDING_COMMAND, { signal: controller.signal })).status,
			"ran",
		);
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		cleanups.push(() => kill.mockRestore());
		controller.abort(new Error("late"));
		assert.equal(kill.mock.calls.length, 0);
	});

	test("a hook that fails is typed even with a cancellation signal attached, and leaves no timer", async () => {
		const root = worktreeAt("nostart", { "package-lock.json": "{}\n", [RESUME_SETUP_HOOK_FILE]: "x\n" });
		chmodSync(join(root, RESUME_SETUP_HOOK_FILE), 0o644);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		cleanups.push(() => vi.useRealTimers());
		await assert.rejects(
			ensureResumeSetup({
				entryPoint: "cli",
				worktree: root,
				envHash,
				storeDir: sandbox.path("host"),
				config: { trusted: () => true },
				signal: new AbortController().signal,
			}),
			(error: unknown) => {
				assert.ok(error instanceof ResumeSetupHookError);
				assert.equal(error.code, "setup-hook-failed");
				return true;
			},
		);
		assert.equal(vi.getTimerCount(), 0);
	});
});

describe("setup plan before restoring (#4329)", () => {
	const noSetup = (trusted: (path: string) => boolean = () => false) => ({ command: undefined, trusted });

	test("dependency inputs with no command and an untrusted restore fail before anything is written", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const io = new CountingGitIo();
		await assert.rejects(prepareSessionResume(manager, options({ io, setup: noSetup() })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.deepEqual(
				error.problems.map((problem) => problem.code),
				["setup-hook-missing"],
			);
			assert.match(error.hint, /resume\.setupCommand/);
			return true;
		});
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
	});

	test("a checkout whose recorded edits were committed here resumes in place, with no setup check or restore", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		await sandbox.commitAll(clone, "commit the recorded edits");
		const io = new CountingGitIo();
		const prepared = await prepareSessionResume(manager, options({ io, setup: noSetup() }));
		assert.equal(cwdOf(prepared), clone);
		assert.equal(io.probes, 0);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a checkout that is here but changed since the snapshot gets the same check before anything is restored", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
		const io = new CountingGitIo();
		await assert.rejects(prepareSessionResume(manager, options({ io, setup: noSetup() })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.deepEqual(
				error.problems.map((problem) => problem.code),
				["setup-hook-missing"],
			);
			return true;
		});
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed after the snapshot\n");

		const withoutGit = new CountingGitIo(missingGit());
		await assert.rejects(prepareSessionResume(manager, options({ io: withoutGit })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			const id = manager.getLatestWorktreeSnapshots().get(clone)!.id;
			assert.equal(
				error.problems[0]?.why,
				`session ${manager.getSessionId()} must be restored from snapshot ${id.slice(0, 12)} because ${clone} no longer matches it`,
			);
			return true;
		});
	});

	test("a missing Git and a missing setup hook are reported together in one pass", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const io = new CountingGitIo(missingGit());
		await assert.rejects(prepareSessionResume(manager, options({ io, setup: noSetup() })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.deepEqual(
				error.problems.map((problem) => problem.code),
				["git-unavailable", "setup-hook-missing"],
			);
			return true;
		});
		assert.equal(io.probes, 1);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a snapshot without dependency inputs needs no hook, so nothing is predicted missing", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const prepared = await prepareSessionResume(manager, options({ setup: noSetup() }));
		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host")));
	});

	test("a trusted restore whose repository turns out to have no hook is rolled back", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const trustedPaths: string[] = [];
		await assert.rejects(
			prepareSessionResume(
				manager,
				options({
					setup: noSetup((path) => {
						trustedPaths.push(path);
						return true;
					}),
				}),
			),
			(error: unknown) =>
				error instanceof ResumePreconditionError && error.problems[0]?.code === "setup-hook-missing",
		);
		assert.equal(trustedPaths[0], sandbox.path("host", "worktrees"));
		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(existsSync(restored), false);
		assert.deepEqual(readdirSync(sandbox.path("host", "worktrees")), []);
	});

	test("after a rolled-back restore, the next resume with a hook restores again with no manual step", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		await assert.rejects(
			prepareSessionResume(manager, options({ setup: noSetup(() => true) })),
			ResumePreconditionError,
		);
		const removed = manager.getWorktreeRootMappings().at(-1)!.to;

		const prepared = await prepareSessionResume(manager, options());

		const cwd = cwdOf(prepared)!;
		assert.ok(cwd.startsWith(sandbox.path("host", "worktrees")), cwd);
		assert.notEqual(cwd, removed);
		assert.equal(readFileSync(join(cwd, "README.md"), "utf8"), "edited\n");
		assert.equal(setupRuns(), 1);
		assert.equal(resolveToCwd(join(clone, "README.md"), cwd), join(cwd, "README.md"));
	});

	test("a blank setup command is no command; the predicted problem names the hook and the snapshot's inputs", async () => {
		const { predictedSetupProblem } = await import("../src/core/resume/setup-hook.ts");
		const problem = await predictedSetupProblem("e".repeat(64), sandbox.path("host", "worktrees"), {
			command: "   ",
			trusted: () => false,
		});
		assert.equal(problem?.code, "setup-hook-missing");
		assert.equal(problem?.subject, "setup hook");
		assert.equal(
			problem?.why,
			`the snapshot has dependency inputs (envHash ${"e".repeat(12)}) that a restored worktree must install, no resume.setupCommand is configured, and a restored worktree is not trusted to run .atomic/setup`,
		);
	});

	test("a failed hook keeps its fresh worktree, and a later missing hook never removes a worktree restored earlier", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		await assert.rejects(
			prepareSessionResume(
				manager,
				options({ setup: { command: nodeCommand("process.exit(3)"), trusted: () => false } }),
			),
			ResumeSetupHookError,
		);
		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(existsSync(restored));
		const error = await prepareSessionResume(manager, options({ setup: noSetup(() => true) })).then(
			() => assert.fail("the hook is missing"),
			(failure: Error) => failure,
		);
		assert.ok(error instanceof ResumePreconditionError);
		assert.equal(error.problems[0]?.code, "setup-hook-missing");
		assert.equal((error as Error & { cleanupCause?: unknown }).cleanupCause, undefined);
		assert.equal(manager.getWorktreeRootMappings().length, 1);
		assert.ok(existsSync(restored));
	});

	test("a user checkout verified in place never runs the setup hook", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const prepared = await prepareSessionResume(manager, options());
		assert.equal(cwdOf(prepared), clone);
		assert.equal(setupRuns(), 0);
	});
});

describe("resume failure presentation (#4329)", () => {
	test("a restore that cannot rebuild unpushed denied-path commits names the commit and the remedy in its message", async () => {
		const { resumeFailureMessage } = await import("../src/core/resume/failure.ts");
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "deploy.key"), "PRIVATE\n");
		const commit = await sandbox.commitAll(clone, "unpushed key");
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const error = await prepareSessionResume(manager, options()).then(
			() => assert.fail("restore must fail"),
			(failure: Error) => failure,
		);
		assert.ok(isWorkspaceDriftError(error));
		assert.deepEqual([error.reason, error.restoreCode], ["restore-failed", "commits-unavailable"]);
		assert.ok(error.message.includes(commit), error.message);
		assert.equal(resumeFailureMessage(error), error.message);
		assert.equal(resumeFailureMessage(new TypeError("bug")), undefined);
	});

	test("typed resume, workspace and Git failures are shown with their own message; anything else is not one", async () => {
		const { isResumeFailure, resumeFailureMessage } = await import("../src/core/resume/failure.ts");
		const precondition = new ResumePreconditionError({
			entryPoint: "cli",
			problems: [{ code: "git-unavailable", subject: "git", why: "w", fix: "f" }],
		});
		const drift = new WorkspaceDriftError({
			root: "/r",
			expectedHead: "h",
			actualHead: null,
			expectedTree: "t",
			actualTree: null,
			snapshotId: "s",
		});
		const git = missingGit();
		for (const failure of [precondition, drift, git]) {
			assert.ok(isResumeFailure(failure));
			assert.equal(resumeFailureMessage(failure), failure.message);
		}
		assert.equal(isResumeFailure(new Error("x")), false);
	});
});

describe("prepareSessionResume for a session that recorded two checkouts (#4329)", () => {
	/** A session whose cwd's checkout is `first` and that also recorded a second repository with a Cargo lockfile. */
	async function twoCheckoutSession(first: string) {
		const { clone: second } = await sandbox.remoteWithClone("second", {
			"README.md": "second\n",
			"Cargo.lock": "# lock\n",
		});
		sandbox.write(join(second, "README.md"), "edited in the second repository\n");
		const manager = await recordSession(first);
		const capture = await captureWorktreeSnapshot(second, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(second, capture.snapshot.id, capture.snapshot);
		return { second, manager };
	}

	test("every checkout a resume restores gets its setup hook", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(manager, options());

		assert.equal(prepared.status, "ready");
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(mappings.map((mapping) => resolve(mapping.from)).sort(), [clone, second].sort());
		assert.ok(mappings.every((mapping) => mapping.to.startsWith(sandbox.path("host"))));
		assert.equal(setupRuns(), 2);
	});

	test("a missing setup hook for any checkout to restore is reported before anything is restored", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "README.md": "no lockfile here\n" });
		const { second, manager } = await twoCheckoutSession(clone);
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));
		const io = new CountingGitIo();

		await assert.rejects(
			prepareSessionResume(manager, options({ io, setup: { command: undefined, trusted: () => false } })),
			(error: unknown) => {
				assert.ok(error instanceof ResumePreconditionError);
				assert.deepEqual(
					error.problems.map((problem) => problem.code),
					["setup-hook-missing"],
				);
				return true;
			},
		);
		assert.equal(io.probes, 1);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a hook missing for both checkouts is one problem, and one found missing after restoring removes both worktrees", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));

		await assert.rejects(
			prepareSessionResume(manager, options({ setup: { command: undefined, trusted: () => false } })),
			(error: unknown) => {
				assert.ok(error instanceof ResumePreconditionError);
				assert.deepEqual(
					error.problems.map((problem) => problem.code),
					["setup-hook-missing"],
				);
				return true;
			},
		);
		await assert.rejects(
			prepareSessionResume(manager, options({ setup: { command: undefined, trusted: () => true } })),
			ResumePreconditionError,
		);
		assert.equal(manager.getWorktreeRootMappings().length, 2);
		assert.deepEqual(readdirSync(sandbox.path("host", "worktrees")), []);
	});

	test("a matching checkout of the first repository is used and the second repository is still restored", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));

		assert.equal(cwdOf(prepared), checkout);
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[clone, second],
		);
		assert.equal(resolve(mappings[0]!.to), checkout);
		const restoredSecond = mappings[1]!.to;
		assert.ok(restoredSecond.startsWith(sandbox.path("host")), restoredSecond);
		assert.equal(
			readFileSync(resolveToCwd(join(second, "README.md"), checkout), "utf8"),
			"edited in the second repository\n",
		);
		assert.equal(setupRuns(), 1);
		const messages = prepared.status === "ready" ? prepared.notices.map((notice) => notice.message) : [];
		assert.equal(
			messages.filter((message) => message.includes(checkout) && message.startsWith("Restored")).length,
			0,
		);
		assert.ok(messages.some((message) => message.startsWith(`Resuming in ${checkout}, which matches`)));
	});

	test("continuing in a differing checkout by choice restores nothing else and says which checkouts were left out", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, chooseDirtyCheckout: async () => "use" }),
		);

		assert.equal(cwdOf(prepared), checkout);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.to)),
			[checkout],
		);
		assert.equal(existsSync(sandbox.path("host")), false);
		const warnings =
			prepared.status === "ready" ? prepared.notices.filter((notice) => notice.type === "warning") : [];
		assert.deepEqual(
			warnings.map((notice) => notice.message),
			[
				`Resuming in ${checkout}, which differs from snapshot ${manager.getLatestWorktreeSnapshots().get(clone)!.id.slice(0, 12)} of ${clone}`,
				`Continuing without restoring ${second}, which this session also recorded`,
			],
		);
	});

	test("continuing in a differing checkout by choice warns about nothing else when the other checkout is here", async () => {
		const { clone } = await editedClone();
		const { manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		sandbox.write(join(checkout, "README.md"), "user edit\n");

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: checkout, chooseDirtyCheckout: async () => "use" }),
		);

		assert.equal(cwdOf(prepared), checkout);
		assert.deepEqual(prepared.status === "ready" ? prepared.notices.map((notice) => notice.type) : [], ["warning"]);
	});

	test("a missing Git names every checkout the resume would restore", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));
		const snapshots = manager.getLatestWorktreeSnapshots();
		const io = new CountingGitIo(missingGit());

		await assert.rejects(prepareSessionResume(manager, options({ io })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.equal(
				error.problems[0]?.why,
				`session ${manager.getSessionId()} must be restored from snapshot ${snapshots.get(clone)!.id.slice(0, 12)} because ${clone} does not exist on this node, and from snapshot ${snapshots.get(second)!.id.slice(0, 12)} because ${second} does not exist on this node`,
			);
			return true;
		});
	});
});
