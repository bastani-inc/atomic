import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, test } from "vitest";
import { observeWorkspaceGitCommands } from "../../packages/coding-agent/src/core/workspace/git.ts";
import {
	isWorkspaceTimeoutError,
	resolveWorkspace,
	workspace,
} from "../../packages/coding-agent/src/core/workspace/index.ts";
import { withRepositoryLock } from "../../packages/coding-agent/src/core/workspace/lease.ts";
import { WORKTREE_ADDING_REASON } from "../../packages/coding-agent/src/core/workspace/resolve.ts";
import { bunExecutable, moduleDir } from "../helpers/runtime.js";
import {
	commitFile,
	createRemote,
	createRepository,
	git,
	type WorkspaceSandboxDirs,
	workspaceSandbox,
} from "../helpers/workspace-repos.ts";

/** Structural cost: every case starts real Bun processes that load the lease module and contend through SQLite. */
const CHAOS_TIMEOUT_MS = 120_000;
const WORKER = join(moduleDir(import.meta.url), "..", "fixtures", "workspace-lease-worker.ts");
const RESOLVER = join(moduleDir(import.meta.url), "..", "fixtures", "workspace-resolve-worker.ts");
const BINDERS = 8;
const CONTENDERS = 24;

interface Outcome {
	readonly outcome: "acquired" | "released" | "refused";
	readonly owner: string;
	readonly pid?: number;
	readonly code?: string;
	readonly name?: string;
}

interface Contender {
	readonly child: ChildProcessWithoutNullStreams;
	readonly first: Promise<Outcome | undefined>;
	readonly exited: Promise<void>;
}

const running = new Set<ChildProcessWithoutNullStreams>();
let dirs: WorkspaceSandboxDirs;

beforeEach(() => {
	dirs = workspaceSandbox("atomic-workspace-lease-chaos-");
});

afterEach(() => {
	for (const child of running) child.kill("SIGKILL");
	running.clear();
	dirs.cleanup();
});

function contend(worktree: string, owner: string, lockWaitMs?: number): Contender {
	const child = spawn(
		bunExecutable(),
		[WORKER, worktree, owner, ...(lockWaitMs === undefined ? [] : [String(lockWaitMs)])],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);
	running.add(child);
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	void exited.then(() => running.delete(child));
	const first = new Promise<Outcome | undefined>((resolve) => {
		let buffered = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			buffered += chunk;
			const line = buffered.split("\n")[0];
			if (buffered.includes("\n") && line !== undefined) resolve(JSON.parse(line) as Outcome);
		});
		child.once("close", () => resolve(undefined));
	});
	return { child, first, exited };
}

async function boundWorktree(name: string): Promise<string> {
	const repo = createRepository(dirs.root, name);
	return (await resolveWorkspace(workspace({ repo, branch: `${name}-work` }))).worktree;
}

/** The lease database is intact and holds at most one writer. */
function assertLeaseStore(worktree: string): readonly { readonly owner: string; readonly pid: number }[] {
	const database = new DatabaseSync(
		join(git(worktree, "rev-parse", "--absolute-git-dir"), "atomic-writer-lease.sqlite"),
	);
	try {
		assert.equal(database.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
		return database
			.prepare("SELECT owner, pid FROM writer")
			.all()
			.map((row) => ({ owner: String(row.owner), pid: Number(row.pid) }));
	} finally {
		database.close();
	}
}

describe.skipIf(process.platform === "win32")("workspace writer lease under process chaos (#3109)", () => {
	test(
		"every writer queued behind a held lease transaction is refused with writer-conflict (#3109)",
		async () => {
			const worktree = await boundWorktree("queued-lease");
			const lockFile = join(git(worktree, "rev-parse", "--absolute-git-dir"), "atomic-writer-lease.sqlite");
			const seed = contend(worktree, "seed");
			assert.equal((await seed.first)?.outcome, "acquired");
			seed.child.stdin.write("release\n");
			await seed.exited;
			const holder = new DatabaseSync(lockFile);
			holder.exec("BEGIN IMMEDIATE");
			try {
				const first = contend(worktree, "queued-first", 1500).first;
				await new Promise((resolve) => setTimeout(resolve, 500));
				const later = Array.from({ length: 2 }, (_, index) => contend(worktree, `queued-${index}`, 500).first);
				const outcomes = await Promise.all([first, ...later]);
				for (const outcome of outcomes) {
					assert.equal(outcome?.outcome, "refused", JSON.stringify(outcome));
					assert.equal(outcome?.code, "writer-conflict", JSON.stringify(outcome));
				}
			} finally {
				holder.exec("ROLLBACK");
				holder.close();
			}
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"many concurrent writers see exactly one winner; a SIGKILLed holder is taken over (#3109)",
		async () => {
			const worktree = await boundWorktree("race");
			const contenders = Array.from({ length: CONTENDERS }, (_, index) => contend(worktree, `writer-${index}`));
			const outcomes = await Promise.all(contenders.map((contender) => contender.first));
			const winners = outcomes.filter((outcome) => outcome?.outcome === "acquired");
			const refused = outcomes.filter((outcome) => outcome?.outcome === "refused");
			assert.equal(winners.length, 1, "exactly one writer holds the lease");
			assert.equal(refused.length, CONTENDERS - 1);
			for (const outcome of refused) assert.equal(outcome?.code, "writer-conflict");
			assert.deepEqual(
				assertLeaseStore(worktree).map((row) => row.owner),
				[winners[0]!.owner],
			);

			const holder = contenders[outcomes.indexOf(winners[0])]!;
			holder.child.kill("SIGKILL");
			await holder.exited;
			const successor = contend(worktree, "successor");
			assert.equal((await successor.first)?.outcome, "acquired", "recovery needs no manual step");
			successor.child.stdin.write("release\n");
			await successor.exited;
			assert.equal(assertLeaseStore(worktree).length, 0);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"a SIGSTOPped holder keeps its lease until it continues and releases (#3109)",
		async () => {
			const worktree = await boundWorktree("stopped");
			const holder = contend(worktree, "stopped-holder");
			assert.equal((await holder.first)?.outcome, "acquired");
			holder.child.kill("SIGSTOP");
			const blocked = contend(worktree, "while-stopped");
			const refused = await blocked.first;
			assert.equal(refused?.outcome, "refused");
			assert.equal(refused?.code, "writer-conflict");
			holder.child.kill("SIGCONT");
			holder.child.stdin.write("release\n");
			await holder.exited;
			const next = contend(worktree, "after-continue");
			assert.equal((await next.first)?.outcome, "acquired");
			next.child.kill("SIGKILL");
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"SIGKILL at random points of contention never corrupts the store or yields two holders (#3109)",
		async () => {
			const worktree = await boundWorktree("killed");
			for (let round = 0; round < 6; round++) {
				const contenders = Array.from({ length: 8 }, (_, index) => contend(worktree, `round-${round}-${index}`));
				await Promise.all(
					contenders.map(
						(contender, index) =>
							new Promise<void>((resolve) =>
								setTimeout(
									() => {
										if (index % 2 === 0) contender.child.kill("SIGKILL");
										resolve();
									},
									5 + ((round * 7 + index * 13) % 60),
								),
							),
					),
				);
				const outcomes = await Promise.all(contenders.map((contender) => contender.first));
				const live = outcomes.filter((outcome, index) => outcome?.outcome === "acquired" && index % 2 === 1);
				assert.ok(live.length <= 1, `round ${round}: at most one surviving holder`);
				const rows = assertLeaseStore(worktree);
				assert.ok(rows.length <= 1, `round ${round}: one writer row at most`);
				for (const contender of contenders) contender.child.kill("SIGKILL");
				await Promise.all(contenders.map((contender) => contender.exited));
			}
			const recovered = contend(worktree, "recovered");
			assert.equal((await recovered.first)?.outcome, "acquired", "every killed holder is recoverable");
			recovered.child.kill("SIGKILL");
		},
		CHAOS_TIMEOUT_MS,
	);
});

interface BinderOutcome {
	readonly outcome: string;
	readonly worktree?: string;
	readonly head?: string;
	readonly tree?: string;
	readonly code?: string;
	readonly name?: string;
	readonly message?: string;
	readonly fields?: Readonly<Record<string, unknown>>;
	readonly causeName?: string;
}

/**
 * Bind in this process and report it as the binders do, as plain data: a failure becomes its name, code and fields, so
 * an assertion on it prints a readable diff rather than a typed error the test runner cannot render.
 */
async function bindHere(repo: string, branch: string): Promise<BinderOutcome> {
	try {
		const binding = await resolveWorkspace(workspace({ repo, branch }));
		return { outcome: "bound", worktree: binding.worktree, head: binding.head, tree: binding.tree };
	} catch (error) {
		const { name, code, message, fields } = error as Partial<Record<"name" | "code" | "message", string>> & {
			readonly fields?: Readonly<Record<string, unknown>>;
		};
		return JSON.parse(JSON.stringify({ outcome: "failed", name, code, message, fields })) as BinderOutcome;
	}
}

/** Start the binding fixture; `first` resolves with its first JSON line. */
function binder(args: readonly string[]): {
	readonly child: ChildProcessWithoutNullStreams;
	readonly first: Promise<BinderOutcome>;
} {
	const child = spawn(bunExecutable(), [RESOLVER, ...args], { stdio: ["pipe", "pipe", "pipe"] });
	running.add(child);
	const first = new Promise<BinderOutcome>((resolve, reject) => {
		let output = "";
		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => {
			output += chunk;
			if (output.includes("\n")) resolve(JSON.parse(output.split("\n")[0]!) as BinderOutcome);
		});
		child.once("error", reject);
		child.once("close", () => resolve(output === "" ? { outcome: "silent" } : JSON.parse(output.split("\n")[0]!)));
	});
	return { child, first };
}

function allBound(outcomes: readonly BinderOutcome[]): void {
	assert.deepEqual(
		outcomes.map((outcome) => outcome.outcome),
		outcomes.map(() => "bound"),
		JSON.stringify(outcomes.find((outcome) => outcome.outcome !== "bound")),
	);
}

/**
 * Every binder got the one worktree, fully checked out: the tree each recorded is its HEAD's, every file of HEAD is
 * there unchanged, and no lock is left. A binder that used a worktree another process was still adding fails this.
 */
function assertOneCompleteWorktree(outcomes: readonly BinderOutcome[]): string {
	allBound(outcomes);
	const worktrees = new Set(outcomes.map((outcome) => outcome.worktree));
	assert.equal(worktrees.size, 1, "one worktree for the branch");
	const [worktree] = worktrees as Set<string>;
	const tree = git(worktree, "rev-parse", "HEAD^{tree}");
	assert.deepEqual(
		new Set(outcomes.map((outcome) => outcome.tree)),
		new Set([tree]),
		"every binder recorded HEAD's tree",
	);
	assert.equal(git(worktree, "status", "--porcelain"), "", "every file of HEAD is checked out");
	assert.equal(existsSync(join(git(worktree, "rev-parse", "--absolute-git-dir"), "locked")), false);
	return worktree;
}

/** Files that take a while to check out: each one passes a smudge filter that sleeps. */
const SLOW_FILES = 60;

/**
 * A repository whose files take a while to check out, and whose checkouts do not start before `openCheckouts`: a test
 * acts on an addition it knows is still running, however slowly a loaded machine runs the test itself. A checkout also
 * stops waiting once the sandbox is gone, so a test that fails before opening the gate leaves no git behind: git runs
 * in its own process group, which teardown does not kill, and fails once it writes into the removed worktree.
 */
function slowCheckoutRepository(name: string): { readonly repo: string; readonly openCheckouts: () => void } {
	const repo = createRepository(dirs.root, name);
	const gate = join(dirs.root, `${name}-checkouts-open`);
	git(
		repo,
		"config",
		"filter.slow.smudge",
		`until [ -e '${gate}' ] || [ ! -d '${dirs.root}' ]; do sleep 0.01; done; sleep 0.05; cat`,
	);
	writeFileSync(join(repo, ".gitattributes"), "*.txt filter=slow\n");
	for (let index = 0; index < SLOW_FILES; index++) writeFileSync(join(repo, `file-${index}.txt`), `${index}\n`);
	git(repo, "add", ".");
	git(repo, "commit", "-q", "-m", "slow to check out");
	return { repo, openCheckouts: () => writeFileSync(gate, "") };
}

/** Wait until Atomic has started adding a worktree to `repo`: git wrote Atomic's lock into its admin directory. */
async function additionStarted(repo: string): Promise<void> {
	const admin = join(repo, ".git", "worktrees");
	const marked = (): boolean =>
		existsSync(admin) &&
		readdirSync(admin).some((id) => {
			const lock = join(admin, id, "locked");
			return existsSync(lock) && readFileSync(lock, "utf-8").trim() === WORKTREE_ADDING_REASON;
		});
	while (!marked()) await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Wait until Atomic has recorded the git adding a worktree to `repo`, and return that git's pid. Atomic records it just
 * after starting git, so a binder killed before then leaves an addition no later bind can tell is over.
 */
async function recordedAdder(repo: string): Promise<number> {
	const records = join(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"), "atomic-worktree-adders");
	const named = (): string[] =>
		existsSync(records) ? readdirSync(records).filter((name) => name.endsWith(".json")) : [];
	while (named().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
	return (JSON.parse(readFileSync(join(records, named()[0]!), "utf-8")) as { readonly pid: number }).pid;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { readonly code?: unknown }).code === "EPERM";
	}
}

/** SIGKILL every git process group whose command line names `path`, as a machine crash would. */
function killGitGroups(path: string): void {
	const pids = spawnSync("pgrep", ["-f", "--", path], { encoding: "utf-8" })
		.stdout.split("\n")
		.filter((line) => line.trim() !== "")
		.map(Number);
	assert.ok(pids.length > 0, "git is still adding the worktree");
	for (const pid of pids)
		for (const target of [-pid, pid]) {
			try {
				process.kill(target, "SIGKILL");
				break;
			} catch (error) {
				if ((error as { readonly code?: string }).code !== "ESRCH") throw error;
			}
		}
}

describe("workspace binding across processes (#3109)", () => {
	test(
		"processes binding one new branch at once all get its one worktree (#3109)",
		async () => {
			const { repo, openCheckouts } = slowCheckoutRepository("shared-branch");
			openCheckouts();
			const outcomes = await Promise.all(
				Array.from({ length: BINDERS }, () => binder(["bind", repo, "together"]).first),
			);
			const worktree = assertOneCompleteWorktree(outcomes);
			assert.equal(git(worktree, "symbolic-ref", "--short", "HEAD"), "together");
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"processes binding new branches while the remote keeps moving all fetch and bind cleanly (#3109)",
		async () => {
			const remote = createRemote(dirs.root, "moving-remote");
			const bare = remote.url.replace(/^file:\/\//, "");
			await resolveWorkspace(workspace({ repo: remote.url, branch: "store" }));
			let pushing = true;
			const pusher = (async () => {
				for (let step = 0; pushing; step++) {
					commitFile(remote.seed, `moving-${step}.txt`, `${step}\n`);
					git(remote.seed, "push", "-q", bare, "HEAD:refs/heads/main");
					await new Promise((resolve) => setTimeout(resolve, 5));
				}
			})();
			const outcomes = await Promise.all(
				Array.from({ length: BINDERS }, (_, index) => binder(["bind", remote.url, `moving-${index}`]).first),
			);
			pushing = false;
			await pusher;
			allBound(outcomes);
			assert.equal(new Set(outcomes.map((outcome) => outcome.worktree)).size, BINDERS);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"processes restoring one deleted worktree all get it, also after the lock holder is SIGKILLed (#3109)",
		async () => {
			const remote = createRemote(dirs.root, "restore-race");
			const binding = await resolveWorkspace(workspace({ repo: remote.url, branch: "restored" }));
			const recorded = join(dirs.root, "binding.json");
			writeFileSync(recorded, JSON.stringify(binding));
			rmSync(binding.worktree, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
			const holder = binder(["hold-lock", binding.repository]);
			assert.equal((await holder.first).outcome, "locked");
			const restorers = Array.from({ length: BINDERS }, () => binder(["restore", recorded]));
			await new Promise((resolve) => setTimeout(resolve, 500));
			assert.equal(existsSync(binding.worktree), false, "nobody adds the worktree while the lock is held");
			holder.child.kill("SIGKILL");
			const outcomes = await Promise.all(restorers.map((restorer) => restorer.first));
			allBound(outcomes);
			assert.deepEqual(new Set(outcomes.map((outcome) => outcome.worktree)), new Set([binding.worktree]));
			assert.equal(git(binding.worktree, "symbolic-ref", "--short", "HEAD"), "restored");
		},
		CHAOS_TIMEOUT_MS,
	);
});

// POSIX: the crash is a SIGKILL of the binder and of git's own process group, found with pgrep.
describe.skipIf(process.platform === "win32")("worktree additions under process chaos (#3109)", () => {
	test(
		"binders after a SIGKILL in the middle of an addition repair it and all get one complete worktree (#3109)",
		async () => {
			const { repo, openCheckouts } = slowCheckoutRepository("killed-mid-add");
			const first = binder(["bind", repo, "cut"]);
			await additionStarted(repo);
			await recordedAdder(repo);
			first.child.kill("SIGKILL");
			killGitGroups(join(dirs.home, "worktrees"));
			assert.equal((await first.first).outcome, "silent", "the first binder died before binding");
			const admin = join(repo, ".git", "worktrees");
			assert.equal(readdirSync(admin).length, 1, "the killed addition left its worktree behind");
			openCheckouts();
			const outcomes = await Promise.all(Array.from({ length: BINDERS }, () => binder(["bind", repo, "cut"]).first));
			const worktree = assertOneCompleteWorktree(outcomes);
			assert.equal(readdirSync(worktree).filter((name) => name.endsWith(".txt")).length, SLOW_FILES);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"a bind after only the binder is SIGKILLed waits for its still-running git, then gets the worktree complete (#3109)",
		async () => {
			const { repo, openCheckouts } = slowCheckoutRepository("orphaned-git");
			const first = binder(["bind", repo, "orphan"]);
			await additionStarted(repo);
			const orphan = await recordedAdder(repo);
			first.child.kill("SIGKILL");
			assert.equal((await first.first).outcome, "silent");
			assert.equal(alive(orphan), true, "only the binder died; its git is still checking out");
			const removals: boolean[] = [];
			const stop = observeWorkspaceGitCommands((command) => {
				if (command.args[0] === "worktree" && command.args[1] === "remove") removals.push(alive(orphan));
			});
			try {
				const bound = bindHere(repo, "orphan");
				openCheckouts();
				const outcome = await bound;
				assert.deepEqual(outcome, {
					outcome: "bound",
					worktree: outcome.worktree,
					head: git(repo, "rev-parse", "orphan"),
					tree: git(repo, "rev-parse", "orphan^{tree}"),
				});
				const worktree = outcome.worktree!;
				assert.equal(outcome.tree, git(worktree, "rev-parse", "HEAD^{tree}"));
				assert.equal(git(worktree, "status", "--porcelain"), "");
				assert.equal(readdirSync(worktree).filter((name) => name.endsWith(".txt")).length, SLOW_FILES);
			} finally {
				stop();
			}
			assert.deepEqual(
				removals.filter((orphanAlive) => orphanAlive),
				[],
				"nothing was removed while the orphaned git was still adding it",
			);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"binders wait while the process adding a worktree is stopped, then all get it complete (#3109)",
		async () => {
			const { repo, openCheckouts } = slowCheckoutRepository("stopped-mid-add");
			const first = binder(["bind", repo, "paused"]);
			await additionStarted(repo);
			first.child.kill("SIGSTOP");
			const others = Array.from({ length: BINDERS }, () => binder(["bind", repo, "paused"]).first);
			const early = await Promise.race([
				Promise.race(others).then(() => "a binder finished"),
				new Promise((resolve) => setTimeout(() => resolve("all waiting"), 1_500)),
			]);
			assert.equal(early, "all waiting", "nobody binds a worktree whose addition has not finished");
			openCheckouts();
			first.child.kill("SIGCONT");
			assertOneCompleteWorktree([await first.first, ...(await Promise.all(others))]);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"every process queued behind a stopped repository-lock holder times out typed, naming the holder (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "queued-lock");
			const commonDir = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
			const holder = binder(["hold-lock", commonDir]);
			assert.equal((await holder.first).outcome, "locked");
			holder.child.kill("SIGSTOP");
			try {
				// The first waiter queues for the lock; the later ones find it waiting and queue behind it without a try.
				const first = binder(["wait-lock", commonDir, "1500"]).first;
				await new Promise((resolve) => setTimeout(resolve, 500));
				const later = Array.from({ length: 2 }, () => binder(["wait-lock", commonDir, "500"]).first);
				const waiters = await Promise.all([first, ...later]);
				for (const waiter of waiters) {
					assert.equal(waiter.outcome, "failed", JSON.stringify(waiter));
					assert.equal(waiter.name, "WorkspaceTimeoutError", JSON.stringify(waiter));
					assert.equal(waiter.code, "timeout");
					assert.equal(waiter.fields?.phase, "repository-lock");
					assert.ok(waiter.fields?.timeoutMs === 500 || waiter.fields?.timeoutMs === 1500);
					assert.equal(waiter.fields?.holderPid, holder.child.pid);
					assert.equal(waiter.causeName, "StorageWriteLockTimeoutError");
				}
			} finally {
				holder.child.kill("SIGCONT");
			}
			assert.ok(
				existsSync(join(commonDir, "atomic-repository-lock.sqlite-writers")),
				"the writers' queue lives in .git",
			);
			git(repo, "fsck", "--no-progress");
			assert.equal(
				git(repo, "worktree", "list", "--porcelain").split("\n\n").length,
				1,
				"git sees no extra worktree",
			);
		},
		CHAOS_TIMEOUT_MS,
	);

	test(
		"a wait for a repository lock that a stopped process holds ends with a timeout naming that process (#3109)",
		async () => {
			const repo = createRepository(dirs.root, "held-lock");
			const commonDir = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
			const holder = binder(["hold-lock", commonDir]);
			assert.equal((await holder.first).outcome, "locked");
			holder.child.kill("SIGSTOP");
			let ran = false;
			const error = await withRepositoryLock(
				commonDir,
				async () => {
					ran = true;
				},
				400,
			).then(
				() => undefined,
				(failure: unknown) => failure,
			);
			holder.child.kill("SIGCONT");
			assert.ok(isWorkspaceTimeoutError(error), String(error));
			assert.equal(ran, false);
			assert.equal(error.phase, "repository-lock");
			assert.equal(error.timeoutMs, 400);
			assert.ok(error.elapsedMs >= 400);
			assert.equal(error.fields.holderPid, holder.child.pid);
			assert.equal(error.fields.command, join(commonDir, "atomic-repository-lock.sqlite"));
			assert.match(error.message, new RegExp(`process ${holder.child.pid} held .* for \\d+ms, limit 400ms`));
			assert.match(error.hint, new RegExp(`Wait for process ${holder.child.pid} to finish`));
		},
		CHAOS_TIMEOUT_MS,
	);
});
