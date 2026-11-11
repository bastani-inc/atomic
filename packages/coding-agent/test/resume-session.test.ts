import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { holdsSnapshotCommit } from "../src/core/resume/session-resume.ts";
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
	GitProvisionTimeoutError,
	GitUnavailableError,
	isGitUnavailableError,
	isWorkspaceDriftError,
	isWorkspaceGitError,
	isWorkspaceSnapshotError,
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
	ResumePreconditionError,
	type ResumePreflightIo,
	setWorktreeSnapshotGit,
	WorkspaceDriftError,
	withWorktreeRootMappings,
} from "../src/index.ts";
import { appendLineCommand, nodeCommand, startedSleepingCommand } from "./helpers/hook-commands.ts";
import { missingGit } from "./helpers/missing-git.ts";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

/** `path` as the tools of the session `manager` resolve it for work in `cwd`. */
function resolveForSession(manager: SessionManager, path: string, cwd: string): string {
	return withWorktreeRootMappings(manager.getWorktreeRootMappings(), () => resolveToCwd(path, cwd));
}

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

/** Blueprint settings whose `resume.setupCommand` appends a line to `setup-runs.txt` in each restored worktree's build. */
function setupBlueprint(
	overrides: Partial<PrepareSessionResumeOptions["blueprint"]> = {},
): PrepareSessionResumeOptions["blueprint"] {
	return {
		agentDir: sandbox.path("agent"),
		trusted: () => true,
		setupCommand: appendLineCommand(sandbox.path("setup-runs.txt"), "ran"),
		...overrides,
	};
}

function options(overrides: Partial<PrepareSessionResumeOptions> = {}): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: sandbox.path("host"),
		blueprint: setupBlueprint(),
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
	test("restores a byte-identical fresh worktree, runs the setup command once and maps old-root tool paths", async () => {
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
			["info", "warning"],
		);
		assert.match(prepared.notices[0]!.message, /^Restored worktree snapshot \w{12} of /);
		assert.ok(prepared.notices[0]!.message.includes(` of ${clone} into `), prepared.notices[0]!.message);
		assert.match(prepared.notices[1]!.message, /^Deprecation warning: resume\.setupCommand is deprecated/);
		assert.deepEqual(prepared.blueprintNotices, [prepared.notices[1]]);
		assert.equal(existsSync(sandbox.path("host", "blueprint-builds", "ledger.json")), true);
		assert.equal(
			resolveForSession(manager, join(clone, "README.md"), cwdOf(prepared)!),
			join(restoredRoot, "README.md"),
		);

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
		const disabled = await prepareSessionResume(
			manager,
			options({
				io,
				settings: { ...settings, enabled: false },
				blueprint: setupBlueprint({ setupCommand: undefined }),
			}),
		);
		assert.deepEqual(disabled, {
			status: "ready",
			sessionManager: manager,
			notices: [],
			blueprintNotices: [],
			blueprintContext: undefined,
		});
		const empty = await SessionManager.create(await sqlStore("empty"), sandbox.root);
		assert.deepEqual(
			await prepareSessionResume(empty, options({ io, blueprint: setupBlueprint({ setupCommand: undefined }) })),
			{
				status: "ready",
				sessionManager: empty,
				notices: [],
				blueprintNotices: [],
				blueprintContext: undefined,
			},
		);
		assert.equal(io.probes, 0);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("restores every recorded checkout when the session works outside all of them (review findings 1 and 2)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, sandbox.root);
		renameSync(clone, sandbox.path("node-a-gone"));
		const io = new CountingGitIo();
		const launchClone = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), launchClone);

		const prepared = await prepareSessionResume(manager, options({ io, launchCwd: launchClone }));

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

describe.skipIf(process.platform === "win32")(
	"prepareSessionResume when Git fails in the launch checkout (#4329)",
	() => {
		/** A Git that fails `command` with exit status 2, only when it runs in `dir`, and otherwise runs the real Git. */
		function gitFailingIn(dir: string, command: string): string {
			const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
			const shim = sandbox.path("failing-git");
			writeFileSync(
				shim,
				`#!/bin/sh\ncase "$(pwd -P):$*" in "${realpathSync(dir)}":*"${command}"*) echo "simulated failure" >&2; exit 2;; esac\nexec "${realGit}" "$@"\n`,
			);
			chmodSync(shim, 0o755);
			return shim;
		}

		async function launchedInAnotherClone() {
			const { clone } = await editedClone();
			const manager = await recordSession(clone);
			renameSync(clone, sandbox.path("node-a-gone"));
			const launch = sandbox.path("node-b", "repo");
			mkdirSync(sandbox.path("node-b"));
			await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), launch);
			return { manager, launch };
		}

		test("a Git failure while locating the launch checkout stops the resume instead of being read as no checkout", async () => {
			const { manager, launch } = await launchedInAnotherClone();
			const shim = gitFailingIn(launch, "rev-parse --show-toplevel");
			setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));
			await assert.rejects(prepareSessionResume(manager, options({ launchCwd: launch })), (error: unknown) => {
				assert.ok(isWorkspaceGitError(error), String(error));
				return true;
			});
			assert.equal(existsSync(sandbox.path("host")), false);
		});

		test("a Git failure while comparing the launch checkout stops the resume instead of being read as drift", async () => {
			const { manager, launch } = await launchedInAnotherClone();
			const shim = gitFailingIn(launch, "cat-file");
			setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));
			await assert.rejects(prepareSessionResume(manager, options({ launchCwd: launch })), (error: unknown) => {
				assert.ok(isWorkspaceGitError(error), String(error));
				return true;
			});
			assert.equal(existsSync(sandbox.path("host")), false);
		});
	},
);

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
		assert.equal(
			resolveForSession(manager, join(clone, "README.md"), join(checkout, "notes")),
			join(checkout, "README.md"),
		);
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

	test("a user checkout verified in place never runs the setup command", async () => {
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
		rmSync(sandbox.path("host", "blueprint-builds"), { recursive: true });
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));
		await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => isGitUnavailableError(error));
		assert.equal(setupRuns(), 1);
	});

	test("a restore with no setup command shows only the restore notice", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: undefined }) }),
		);
		assert.equal(prepared.status === "ready" && prepared.notices.length, 1);
		assert.equal(setupRuns(), 0);
	});
});

describe("a setup command or blueprint never blocks a restore (#4329)", () => {
	const hostWorktrees = () => sandbox.path("host", "worktrees");

	test("an untrusted restore runs nothing and still succeeds, with only the restore notice (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ trusted: () => false }) }),
		);

		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.ok(cwdOf(prepared)?.startsWith(hostWorktrees()), cwdOf(prepared));
		assert.ok(existsSync(restored));
		assert.equal(setupRuns(), 0);
		assert.deepEqual(prepared.status === "ready" && prepared.notices.map((notice) => notice.type), ["info"]);
		assert.deepEqual(prepared.status === "ready" && prepared.blueprintNotices, []);
	});

	test("a checkout whose recorded edits were committed here resumes in place, with no restore", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		await sandbox.commitAll(clone, "commit the recorded edits");
		const io = new CountingGitIo();
		const prepared = await prepareSessionResume(manager, options({ io }));
		assert.equal(cwdOf(prepared), clone);
		assert.equal(io.probes, 0);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
	});

	test("the session's own checkout that changed since the snapshot is resumed in place without a notice, even without Git (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
		const io = new CountingGitIo(missingGit());
		let asked = false;
		const prepared = await prepareSessionResume(
			manager,
			options({
				io,
				chooseDirtyCheckout: async () => {
					asked = true;
					return "restore";
				},
			}),
		);
		assert.equal(cwdOf(prepared), join(clone, "notes"));
		assert.equal(asked, false);
		assert.equal(io.probes, 0);
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed after the snapshot\n");
	});

	test("the session's own clean checkout at a later commit is resumed in place, not restored into a worktree (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		sandbox.write(join(clone, "README.md"), "merged later\n");
		sandbox.write(join(clone, "notes", "untracked.txt"), "merged later\n");
		await sandbox.commitAll(clone, "work merged after the snapshot");
		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));
		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
	});

	test("a session moved into a restored worktree returns to the checkout it was restored from (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameSync(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(cwdOf(first), join(worktree, "notes"));
		renameSync(sandbox.path("away"), clone);
		sandbox.write(join(clone, "README.md"), "merged later\n");
		await sandbox.commitAll(clone, "work merged after the snapshot");

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), join(clone, "notes"));
		const id = reopened.getLatestWorktreeSnapshots().get(worktree)!.id;
		assert.deepEqual(second.status === "ready" && second.notices, [
			{
				type: "info",
				message: `Resuming in ${clone}, the checkout this session was restored from, instead of the worktree ${worktree}. It has changed since snapshot ${id.slice(0, 12)}; that snapshot was not restored.`,
			},
		]);
		assert.deepEqual(
			reopened.getWorktreeRootMappings().map((mapping) => [mapping.from, mapping.to]),
			[
				[clone, worktree],
				[worktree, clone],
			],
		);
		assert.equal(
			resolveForSession(reopened, join(worktree, "README.md"), join(clone, "notes")),
			join(clone, "README.md"),
		);
	});

	test("a resume reports each slow step as it starts it (#4660)", async () => {
		const { clone } = await editedClone();
		const restored = await recordSession(clone);
		const inPlace = await recordSession(clone);
		const id = restored.getLatestWorktreeSnapshots().get(clone)!.id.slice(0, 12);
		const steps: string[] = [];
		await prepareSessionResume(inPlace, options({ onProgress: (step) => steps.push(step) }));
		assert.deepEqual(steps, ["Checking 1 checkout against the session's snapshots"]);

		steps.length = 0;
		renameSync(clone, sandbox.path("away"));
		await prepareSessionResume(restored, options({ onProgress: (step) => steps.push(step) }));
		assert.deepEqual(steps, [
			"Checking 1 checkout against the session's snapshots",
			`Restoring ${clone} from snapshot ${id}`,
			"Setting up the blueprints of restored worktrees",
		]);
	});

	test("a Git failure while looking for the checkout a session came from keeps it where it is, and the resume completes (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameSync(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		rmSync(sandbox.path("away"), { recursive: true, force: true });
		writeFileSync(clone, "not a directory");

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), join(worktree, "notes"));
		assert.deepEqual(second.status === "ready" && second.notices, []);
	});

	test("progress counts several checkouts and skips the blueprint step when blueprints are skipped (#4660)", async () => {
		const { clone } = await editedClone();
		const { clone: second } = await sandbox.remoteWithClone("second");
		const manager = await recordSession(clone);
		const capture = await captureWorktreeSnapshot(second, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		await manager.appendWorktreeSnapshot(second, capture.snapshot.id, capture.snapshot);
		const steps: string[] = [];
		await prepareSessionResume(manager, options({ onProgress: (step) => steps.push(step) }));
		assert.deepEqual(steps, ["Checking 2 checkouts against the session's snapshots"]);

		const restoring = await recordSession(clone);
		renameSync(clone, sandbox.path("away"));
		steps.length = 0;
		await prepareSessionResume(restoring, options({ blueprints: "skip", onProgress: (step) => steps.push(step) }));
		assert.equal(steps.length, 2);
		assert.match(steps[1] ?? "", /^Restoring /);
	});

	test("a session in a restored worktree whose latest snapshot is a later one stays there (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		renameSync(sandbox.path("away"), clone);
		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const current = reopened.getLatestWorktreeSnapshots().get(worktree)!;
		await reopened.appendWorktreeSnapshot(worktree, "abcdef012345", { ...current, id: "abcdef012345" });

		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), worktree);
	});

	/** A Git that fails the commands matching the shell `pattern` with exit status 2 only when it runs in `dir`; otherwise the real Git. */
	function gitFailingCommandIn(dir: string, pattern: string): string {
		const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
		const shim = sandbox.path("failing-git-4660");
		writeFileSync(
			shim,
			`#!/bin/sh\ncase "$(pwd -P):$*" in "${realpathSync(dir)}":*${pattern}*) echo "simulated failure" >&2; exit 2;; esac\nexec "${realGit}" "$@"\n`,
		);
		chmodSync(shim, 0o755);
		return shim;
	}

	test("when looking for the session's own checkout throws, the session stays in it and nothing is restored (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		sandbox.write(join(clone, "README.md"), "changed after the snapshot\n");
		const shim = gitFailingCommandIn(clone, "cat-file*^{commit}");
		setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));

		const prepared = await prepareSessionResume(manager, options());

		assert.equal(cwdOf(prepared), join(clone, "notes"));
		assert.deepEqual(prepared.status === "ready" && prepared.notices, []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
	});

	test("when examining the checkout a session came from throws, the session still goes back to it (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, join(clone, "notes"));
		renameSync(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		renameSync(sandbox.path("away"), clone);
		const shim = gitFailingCommandIn(clone, "cat-file*^{commit}");
		setWorktreeSnapshotGit(async () => ({ path: shim, env: {} }));

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), join(clone, "notes"));
		assert.deepEqual(second.status === "ready" && second.notices, [
			{
				type: "info",
				message: `Resuming in ${clone}, the checkout this session was restored from, instead of the worktree ${worktree}.`,
			},
		]);
	});

	test("a session that worked in its restored worktree stays there (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		renameSync(sandbox.path("away"), clone);
		sandbox.write(join(worktree, "README.md"), "the session's own work\n");

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), worktree);
		assert.equal(readFileSync(join(worktree, "README.md"), "utf8"), "the session's own work\n");
	});

	test("a restored worktree is kept when the checkout it came from is another clone (#4660)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("away"));
		const first = await prepareSessionResume(manager, options());
		const worktree = manager.getWorktreeRootMappings().at(-1)!.to;
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("repo.git"), clone);

		const reopened = first.status === "ready" ? first.sessionManager : manager;
		const second = await prepareSessionResume(reopened, options());

		assert.equal(cwdOf(second), worktree);
	});

	test("a repository with no blueprint and no setup command is restored, recorded and kept (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const trustedPaths: string[] = [];

		const prepared = await prepareSessionResume(
			manager,
			options({
				blueprint: setupBlueprint({
					setupCommand: undefined,
					trusted: (path) => {
						trustedPaths.push(path);
						return true;
					},
				}),
			}),
		);

		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[clone],
		);
		assert.deepEqual(trustedPaths, [mappings[0]!.to]);
		assert.ok(mappings[0]!.to.startsWith(hostWorktrees()), mappings[0]!.to);
		assert.equal(cwdOf(prepared), mappings[0]!.to);
		assert.equal(readdirSync(hostWorktrees()).length, 1);
		assert.deepEqual(prepared.status === "ready" && prepared.notices.map((notice) => notice.type), ["info"]);
	});

	test("a failing setup command keeps the restored worktree and warns; the next resume builds it again (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));

		const failed = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: nodeCommand("console.log('broken');process.exit(3)") }) }),
		);

		assert.equal(failed.status, "ready");
		if (failed.status !== "ready") return;
		const restored = manager.getWorktreeRootMappings().at(-1)!.to;
		assert.equal(cwdOf(failed), restored);
		assert.ok(existsSync(restored));
		assert.equal(readFileSync(join(restored, "README.md"), "utf8"), "edited\n");
		assert.equal(failed.notices[0]?.type, "info");
		assert.ok(failed.blueprintNotices.length > 0);
		assert.ok(failed.blueprintNotices.every((notice) => notice.type === "warning"));
		assert.deepEqual(failed.notices.slice(1), failed.blueprintNotices);

		const fixed = await prepareSessionResume(manager, options());

		assert.equal(cwdOf(fixed), restored);
		assert.equal(manager.getWorktreeRootMappings().length, 1);
		assert.equal(setupRuns(), 1);

		await prepareSessionResume(manager, options());
		assert.equal(setupRuns(), 1);
	});

	test("a setup command stopped before it finished runs again on the next resume", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const controller = new AbortController();
		const started = sandbox.path("setup-started");
		const pending = prepareSessionResume(
			manager,
			options({
				signal: controller.signal,
				blueprint: setupBlueprint({ setupCommand: startedSleepingCommand(started) }),
			}),
		);
		// Stopped once it runs: on Windows a tree kill that lands while Git Bash is still starting it can miss it.
		for (let waited = 0; !existsSync(started); waited += 50) {
			if (waited > 20_000) assert.fail("the setup command never started");
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		controller.abort(new Error("stop"));
		await assert.rejects(pending, /stop/);

		const prepared = await prepareSessionResume(manager, options());

		assert.ok(cwdOf(prepared)?.startsWith(hostWorktrees()), cwdOf(prepared));
		assert.equal(setupRuns(), 1);
	});

	test("a worktree an earlier resume restored and built is not built again after the session changes its files", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		renameSync(clone, sandbox.path("gone"));
		const first = await prepareSessionResume(manager, options());
		if (first.status !== "ready") throw new Error(first.status);
		const restored = cwdOf(first)!;
		assert.equal(setupRuns(), 1);
		sandbox.write(join(restored, "package-lock.json"), '{ "changed": true }\n');
		const capture = await captureWorktreeSnapshot(restored, {
			settings,
			blobs: first.sessionManager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await first.sessionManager.appendWorktreeSnapshot(restored, capture.snapshot.id, capture.snapshot);

		const prepared = await prepareSessionResume(first.sessionManager, options());

		assert.equal(cwdOf(prepared), restored);
		assert.equal(setupRuns(), 1);
	});
});

describe("whether a checkout holds a snapshot's commit (#4329)", () => {
	test("the recorded checkout does; a node without Git does not; a cancelled check rejects", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const snapshot = manager.getLatestWorktreeSnapshots().get(clone)!;
		assert.equal(await holdsSnapshotCommit(snapshot, clone), true);
		const cancelled = new AbortController();
		cancelled.abort(new Error("cancelled"));
		await assert.rejects(holdsSnapshotCommit(snapshot, clone, cancelled.signal), /cancelled/);

		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		assert.equal(await holdsSnapshotCommit(snapshot, clone), false);
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

	test("every checkout a resume restores gets its setup command", async () => {
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

	test("a checkout kept in place is neither verified nor restored after it changed, while its missing sibling is (#4329)", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		sandbox.write(join(clone, "README.md"), "changed after the release\n");
		renameSync(second, sandbox.path("second-gone"));
		const prompts: DirtyCheckoutPrompt[] = [];

		const prepared = await prepareSessionResume(
			manager,
			options({
				launchCwd: clone,
				keepInPlace: new Set([clone]),
				chooseDirtyCheckout: async (prompt) => {
					prompts.push(prompt);
					return "cancel";
				},
			}),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(prompts, []);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.equal(readFileSync(join(clone, "README.md"), "utf8"), "changed after the release\n");
		assert.equal(setupRuns(), 1);
	});

	test("a setup command that fails in every restored checkout keeps both worktrees and warns (#4588)", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: nodeCommand("process.exit(3)") }) }),
		);

		assert.equal(prepared.status, "ready");
		if (prepared.status !== "ready") return;
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(mappings.map((mapping) => resolve(mapping.from)).sort(), [clone, second].sort());
		for (const mapping of mappings) assert.ok(existsSync(mapping.to), mapping.to);
		assert.equal(readdirSync(sandbox.path("host", "worktrees")).length, 2);
		assert.ok(prepared.blueprintNotices.length > 0);
		assert.ok(prepared.blueprintNotices.every((notice) => notice.type === "warning"));
	});

	test("continuing in a matching checkout records nothing when the restore of another checkout cannot start", async () => {
		const { clone } = await editedClone();
		const { second, manager } = await twoCheckoutSession(clone);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		renameSync(second, sandbox.path("second-gone"));
		setWorktreeSnapshotGit(async () => ({ path: sandbox.path("no-git"), env: {} }));

		await assert.rejects(
			prepareSessionResume(manager, options({ launchCwd: checkout, io: new CountingGitIo(missingGit()) })),
			(error: unknown) => error instanceof ResumePreconditionError && error.problems[0]?.code === "git-unavailable",
		);

		assert.deepEqual(manager.getWorktreeRootMappings(), []);
	});

	test("continuing in a matching checkout leaves out another checkout whose restore fails (#4584)", async () => {
		const { clone } = await editedClone();
		const { clone: keyed } = await sandbox.remoteWithClone("keyed", { "README.md": "keyed\n" });
		sandbox.write(join(keyed, "deploy.key"), "PRIVATE\n");
		await sandbox.commitAll(keyed, "unpushed key");
		const manager = await recordSession(clone);
		const capture = await captureWorktreeSnapshot(keyed, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(keyed, capture.snapshot.id, capture.snapshot);
		const checkout = sandbox.path("node-b", "repo");
		mkdirSync(sandbox.path("node-b"));
		renameSync(clone, checkout);
		renameSync(keyed, sandbox.path("keyed-gone"));

		const prepared = await prepareSessionResume(manager, options({ launchCwd: checkout }));

		assert.equal(cwdOf(prepared), checkout);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[clone],
		);
		const warnings =
			prepared.status === "ready" ? prepared.notices.filter((notice) => notice.type === "warning") : [];
		assert.equal(warnings.filter((notice) => notice.message.includes(keyed)).length, 1);
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
			readFileSync(resolveForSession(manager, join(second, "README.md"), checkout), "utf8"),
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
				`Continuing without restoring ${second} (snapshot ${manager.getLatestWorktreeSnapshots().get(second)!.id.slice(0, 12)}): it does not exist on this node, and the session continues in the checkout you chose, which restores nothing else`,
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

/** Records a snapshot of a further clone `name` with an edited README, as a second checkout of `manager`'s session. */
async function recordOtherCheckout(
	manager: SessionManager,
	name: string,
	files: Record<string, string> = { "README.md": `${name}\n`, "Cargo.lock": "# lock\n" },
): Promise<string> {
	const { clone } = await sandbox.remoteWithClone(name, files);
	sandbox.write(join(clone, "README.md"), `edited in ${name}\n`);
	const capture = await captureWorktreeSnapshot(clone, {
		settings,
		blobs: manager.getSessionStore().snapshotBlobs,
	});
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
	return clone;
}

function warningsOf(prepared: PreparedSessionResume): string[] {
	return prepared.status === "ready"
		? prepared.notices.filter((notice) => notice.type === "warning").map((notice) => notice.message)
		: [];
}

function restoredWorktrees(): string[] {
	const worktrees = sandbox.path("host", "worktrees");
	return existsSync(worktrees) ? readdirSync(worktrees) : [];
}

function warningsNaming(prepared: PreparedSessionResume, root: string): string[] {
	return warningsOf(prepared).filter((message) => message.includes(root));
}

/** The warnings that are not the deprecation notice of the `resume.setupCommand` alias. */
function withoutDeprecation(messages: readonly string[]): string[] {
	return messages.filter((message) => !message.startsWith("Deprecation warning: resume.setupCommand"));
}

/** An outer clone and, inside it, a nested clone of another repository, each with an edited README and `files`. */
async function nestedCheckouts(outerFiles: Record<string, string>, innerFiles: Record<string, string>) {
	const { clone: outer } = await sandbox.remoteWithClone("outer", { "README.md": "outer\n", ...outerFiles });
	const { remote } = await sandbox.remoteWithClone("inner-source", { "README.md": "inner\n", ...innerFiles });
	const inner = join(outer, "inner");
	await sandbox.git(sandbox.root, "clone", "-q", remote, inner);
	for (const checkout of [outer, inner]) sandbox.write(join(checkout, "README.md"), "edited\n");
	return { outer, inner };
}

/** A session that works in `inner`, a checkout nested in `outer`, and recorded a snapshot of both. */
async function recordNestedSession(outer: string, inner: string): Promise<SessionManager> {
	const manager = await recordSession(inner);
	const capture = await captureWorktreeSnapshot(outer, { settings, blobs: manager.getSessionStore().snapshotBlobs });
	if (capture.status !== "captured") throw new Error(capture.status);
	await manager.appendWorktreeSnapshot(outer, capture.snapshot.id, capture.snapshot);
	return manager;
}

describe("prepareSessionResume when a checkout other than the current one needs a restore (#4584)", () => {
	test("an unchanged current checkout resumes when another recorded checkout is gone and Git is unavailable (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(prepared.status, "ready");
		assert.equal(prepared.status === "ready" ? prepared.sessionManager : undefined, manager);
		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
		const warnings = warningsNaming(prepared, second);
		assert.equal(warnings.length, 1, warningsOf(prepared).join("\n"));
		assert.equal(warningsOf(prepared).length, 1);
		assert.ok(warnings[0]!.includes(manager.getLatestWorktreeSnapshots().get(second)!.id.slice(0, 12)), warnings[0]);
		assert.match(warnings[0]!, /does not exist on this node/);
		assert.match(warnings[0]!, /Git is unavailable here \(not-installed\)/);
	});

	test("an unchanged current checkout resumes when another recorded checkout changed since its snapshot, leaving it as it is (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.equal(setupRuns(), 0);
		assert.equal(readFileSync(join(second, "README.md"), "utf8"), "changed after the snapshot\n");
		assert.equal(warningsOf(prepared).length, 1);
		assert.equal(warningsNaming(prepared, second).length, 1);
		assert.match(warningsOf(prepared)[0]!, /changed since/);
	});

	test("sibling git worktrees that were changed or removed after quitting never refuse the resume (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const siblings = [sandbox.path("repo-slice-changed"), sandbox.path("repo-slice-removed")];
		for (const [index, sibling] of siblings.entries()) {
			await sandbox.git(clone, "worktree", "add", "-q", "-b", `slice-${index}`, sibling);
			sandbox.write(join(sibling, "slice.txt"), `slice ${index}\n`);
			const capture = await captureWorktreeSnapshot(sibling, {
				settings,
				blobs: manager.getSessionStore().snapshotBlobs,
			});
			if (capture.status !== "captured") throw new Error(capture.status);
			await manager.appendWorktreeSnapshot(sibling, capture.snapshot.id, capture.snapshot);
		}
		sandbox.write(join(siblings[0]!, "slice.txt"), "changed after quitting\n");
		await sandbox.git(clone, "worktree", "remove", "--force", siblings[1]!);

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(setupRuns(), 0);
		assert.equal(readFileSync(join(siblings[0]!, "slice.txt"), "utf8"), "changed after quitting\n");
		assert.deepEqual(
			siblings.map((sibling) => warningsNaming(prepared, sibling).length),
			[1, 1],
		);
		assert.equal(warningsOf(prepared).length, 2);
	});

	test("every other checkout that cannot be restored is named once in the warnings (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const removed = await recordOtherCheckout(manager, "removed");
		const alsoRemoved = await recordOtherCheckout(manager, "also-removed");
		const changed = await recordOtherCheckout(manager, "changed");
		renameSync(removed, sandbox.path("removed-gone"));
		renameSync(alsoRemoved, sandbox.path("also-removed-gone"));
		sandbox.write(join(changed, "README.md"), "changed after the snapshot\n");

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, io: new CountingGitIo(missingGit()) }),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(
			[removed, alsoRemoved, changed].map((root) => warningsNaming(prepared, root).length),
			[1, 1, 1],
		);
		assert.equal(warningsOf(prepared).length, 3);
		assert.equal(setupRuns(), 0);
	});

	test("a checkout the session runs in that cannot be restored refuses the resume with the missing Git as its one problem (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));
		const io = new CountingGitIo(missingGit());

		await assert.rejects(prepareSessionResume(manager, options({ io })), (error: unknown) => {
			assert.ok(error instanceof ResumePreconditionError);
			assert.deepEqual(
				error.problems.map((problem) => [problem.code, problem.checkout]),
				[["git-unavailable", undefined]],
			);
			assert.ok(isGitUnavailableError(error.cause));
			assert.ok(error.problems[0]!.why.includes(`because ${clone} does not exist on this node`));
			assert.ok(error.problems[0]!.why.includes(`because ${second} does not exist on this node`));
			return true;
		});
		assert.equal(io.probes, 1);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(existsSync(sandbox.path("host")), false);
	});

	test("a failing setup command in the checkout the session runs in resumes with a warning and is not a refusal (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(clone, sandbox.path("first-gone"));
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ blueprint: setupBlueprint({ setupCommand: nodeCommand("process.exit(3)") }) }),
		);

		assert.ok(cwdOf(prepared)?.startsWith(sandbox.path("host", "worktrees")), cwdOf(prepared));
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[clone, second],
		);
		assert.equal(restoredWorktrees().length, 2);
		assert.ok(warningsOf(prepared).some((message) => !message.startsWith("Continuing without restoring")));
		assert.deepEqual(
			warningsOf(prepared).filter((message) => message.startsWith("Continuing without restoring")),
			[],
		);
	});

	test("a session that works outside every recorded checkout has no checkout whose restore can refuse the resume (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone, sandbox.root);
		renameSync(clone, sandbox.path("first-gone"));

		const prepared = await prepareSessionResume(manager, options({ io: new CountingGitIo(missingGit()) }));

		assert.equal(cwdOf(prepared), sandbox.root);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.equal(warningsNaming(prepared, clone).length, 1);
	});

	test("another checkout restored for a repository without a blueprint or setup command is kept without a warning (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, blueprint: { agentDir: sandbox.path("agent"), trusted: () => true } }),
		);

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.equal(restoredWorktrees().length, 1);
		assert.deepEqual(warningsOf(prepared), []);
	});

	test("a restore of another checkout that fails is skipped with its failure named, and the resume goes on (#4584)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const { clone: keyed } = await sandbox.remoteWithClone("keyed", { "README.md": "keyed\n" });
		sandbox.write(join(keyed, "deploy.key"), "PRIVATE\n");
		await sandbox.commitAll(keyed, "unpushed key");
		const capture = await captureWorktreeSnapshot(keyed, {
			settings,
			blobs: manager.getSessionStore().snapshotBlobs,
		});
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(keyed, capture.snapshot.id, capture.snapshot);
		renameSync(keyed, sandbox.path("keyed-gone"));

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.deepEqual(restoredWorktrees(), []);
		const warnings = warningsNaming(prepared, keyed);
		assert.equal(warnings.length, 1, warningsOf(prepared).join("\n"));
		assert.match(warnings[0]!, /restoring it failed/);
	});

	test("a setup command that fails in a restored checkout other than the current one is a warning, the worktree is kept, and the next resume runs it again (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(second, sandbox.path("second-gone"));

		const prepared = await prepareSessionResume(
			manager,
			options({ launchCwd: clone, blueprint: setupBlueprint({ setupCommand: nodeCommand("process.exit(3)") }) }),
		);

		assert.equal(cwdOf(prepared), clone);
		const mappings = manager.getWorktreeRootMappings();
		assert.deepEqual(
			mappings.map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.ok(existsSync(mappings[0]!.to));
		assert.equal(restoredWorktrees().length, 1);
		assert.deepEqual(
			warningsOf(prepared).filter((message) => message.startsWith("Continuing without restoring")),
			[],
		);
		assert.ok(withoutDeprecation(warningsOf(prepared)).length > 0, warningsOf(prepared).join("\n"));

		const again = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(again), clone);
		assert.equal(setupRuns(), 1);
		assert.deepEqual(withoutDeprecation(warningsOf(again)), []);
	});

	test("another clone at the recorded path of another checkout is restored into a fresh worktree, not left out, when Git is available (#4588)", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(second, sandbox.path("second-original"));
		await sandbox.git(sandbox.root, "clone", "-q", sandbox.path("second.git"), second);

		const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.deepEqual(
			manager.getWorktreeRootMappings().map((mapping) => resolve(mapping.from)),
			[second],
		);
		assert.equal(readFileSync(join(second, "README.md"), "utf8"), "second\n");
		assert.equal(warningsNaming(prepared, second).filter((m) => m.startsWith("Continuing without")).length, 0);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"another checkout that Git fails to compare is skipped with its typed failure named (#4584)",
		async () => {
			const { clone } = await editedClone();
			const manager = await recordSession(clone);
			const second = await recordOtherCheckout(manager, "second");
			sandbox.write(join(second, "README.md"), "changed after the snapshot\n");
			chmodSync(join(second, "README.md"), 0o000);
			cleanups.push(() => chmodSync(join(second, "README.md"), 0o644));

			const prepared = await prepareSessionResume(manager, options({ launchCwd: clone }));

			assert.equal(cwdOf(prepared), clone);
			assert.deepEqual(manager.getWorktreeRootMappings(), []);
			const warnings = warningsNaming(prepared, second);
			assert.equal(warnings.length, 1, warningsOf(prepared).join("\n"));
			assert.match(warnings[0]!, /could not be compared with the snapshot/);
			assert.match(warnings[0]!, /\(git-failed\)/);
		},
	);
});

describe("prepareSessionResume cases the other-checkout planning leaves as they are", () => {
	test("a local resume right after quitting needs no Git, no blueprint build and shows no warning", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		await recordOtherCheckout(manager, "second");
		const io = new CountingGitIo();

		const prepared = await prepareSessionResume(manager, options({ io, launchCwd: clone }));

		assert.equal(cwdOf(prepared), clone);
		assert.equal(io.probes, 0);
		assert.equal(setupRuns(), 0);
		assert.equal(existsSync(sandbox.path("host")), false);
		assert.deepEqual(manager.getWorktreeRootMappings(), []);
		assert.deepEqual(prepared.status === "ready" ? prepared.notices : undefined, []);
	});

	test("cancelling while another checkout is restored rejects with the reason instead of skipping it", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		renameSync(second, sandbox.path("second-gone"));
		const controller = new AbortController();
		const started = sandbox.path("setup-started");
		const pending = prepareSessionResume(
			manager,
			options({
				launchCwd: clone,
				signal: controller.signal,
				blueprint: setupBlueprint({ setupCommand: startedSleepingCommand(started) }),
			}),
		);
		// Stopped once it runs: on Windows a tree kill that lands while Git Bash is still starting it can miss it.
		for (let waited = 0; !existsSync(started); waited += 50) {
			if (waited > 20_000) assert.fail("the setup command never started");
			await new Promise((resolveWait) => setTimeout(resolveWait, 50));
		}
		controller.abort(new Error("stop"));

		await assert.rejects(pending, /stop/);
	});

	test("a setting that is wrong for every checkout stops the resume also when only another checkout is compared", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");

		await assert.rejects(
			prepareSessionResume(
				manager,
				options({ keepInPlace: new Set([clone]), settings: { ...settings, maxFileBytes: -1 } }),
			),
			(error: unknown) => (error as { name?: string }).name === "WorkspaceConfigError",
		);
	});

	test("a failure that is not a typed one is never read as a problem of another checkout", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");
		const bug = new TypeError("not a typed failure");
		setWorktreeSnapshotGit(async () => {
			throw bug;
		});

		await assert.rejects(
			prepareSessionResume(manager, options({ keepInPlace: new Set([clone]) })),
			(error: unknown) => error === bug,
		);
	});

	test("cancelling while another checkout is compared rejects with the signal's reason, even when it is a typed failure", async () => {
		const { clone } = await editedClone();
		const manager = await recordSession(clone);
		const second = await recordOtherCheckout(manager, "second");
		sandbox.write(join(second, "README.md"), "changed after the snapshot\n");
		const reason = missingGit();
		const controller = new AbortController();
		setWorktreeSnapshotGit(async () => {
			controller.abort(reason);
			throw reason;
		});

		await assert.rejects(
			prepareSessionResume(manager, options({ keepInPlace: new Set([clone]), signal: controller.signal })),
			(error: unknown) => error === reason,
		);
	});

	test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
		"a checkout containing the session's directory that Git fails to compare refuses the resume",
		async () => {
			const { outer, inner } = await nestedCheckouts({ "README.md": "outer\n" }, { "README.md": "inner\n" });
			const manager = await recordNestedSession(outer, inner);
			chmodSync(join(outer, "README.md"), 0o000);
			cleanups.push(() => chmodSync(join(outer, "README.md"), 0o644));

			await assert.rejects(prepareSessionResume(manager, options()), (error: unknown) => isWorkspaceGitError(error));
			assert.deepEqual(manager.getWorktreeRootMappings(), []);
		},
	);
});
