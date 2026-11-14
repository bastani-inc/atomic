import assert from "node:assert/strict";
import {
	appendFileSync,
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { runBlueprintCommand } from "../src/cli/blueprint-command.js";
import { blueprintCacheKeys } from "../src/core/resume/blueprint/cache.js";
import { type PrebuildOutcome, prebuildRepository } from "../src/core/resume/blueprint/prebuild.js";
import {
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
} from "../src/core/resume/session-resume.js";
import { latestResumeTimings } from "../src/core/resume/timings.js";
import { SessionManager } from "../src/core/session-manager.js";
import { releaseSessionWorktrees } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	type PoolSlotRecord,
	pooledWorktreeHolder,
	pooledWorktreePath,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import {
	legacyRepositoryIdOf,
	normalizeRemoteUrl,
	type RepositoryId,
	repositoryIdOf,
} from "../src/core/worktree-snapshot/repository-identity.js";
import { objectStorePath } from "../src/core/worktree-snapshot/restore.js";
import {
	adoptPrebuiltSeed,
	readSeedManifest,
	seedDirectory,
	seedManifestPath,
	writeSeedManifest,
} from "../src/core/worktree-snapshot/seeds.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** Prebuilds and resumes that run blueprint steps in a shell, several per test, on a loaded machine. */
const PREBUILD_TEST_TIMEOUT_MS = 60_000;
const SSH = "git@Example.COM:acme/widgets.git";
const HTTPS = "https://example.com/acme/widgets";
/** Maintenance that installs `node_modules` and builds `build/` only when they are missing, counting installs. */
const INSTALL =
	"test -f node_modules/.installed || { mkdir -p node_modules && echo installed > node_modules/.installed; }";
const BUILD = "test -f build/out.txt || { mkdir -p build && echo built > build/out.txt; }";

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const opened: SessionManager[] = [];

/** URL rewrites that send the SSH and HTTPS spellings of the fixture repository to its local remote. */
function insteadOf(remote: string): string {
	return `[url "${remote.replace(/\\/g, "/")}"]\n\tinsteadOf = ${SSH}\n\tinsteadOf = ${HTTPS}\n`;
}

beforeEach(async () => {
	sandbox = new GitSandbox();
	database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	store = await SqlSessionStore.open(database);
});
afterEach(async () => {
	while (opened.length > 0) await releaseSessionWorktrees(opened.pop()!);
	await store.close();
	await database.close();
	sandbox.dispose();
});

const storeDir = () => sandbox.path("host");
const agentDir = () => sandbox.path("agent");

/** A checkout whose blueprint installs `node_modules` and declares `build/` as build output. */
async function checkout(
	blueprint = `maintenance:\n  - ${JSON.stringify(INSTALL)}\n  - ${JSON.stringify(BUILD)}\ncache:\n  - path: build\n    kind: build\n`,
) {
	return sandbox.remoteWithClone("repo", {
		".gitignore": "node_modules/\nbuild/\n.env\nid_rsa\n",
		"README.md": "hello\n",
		".atomic/blueprint.yaml": blueprint,
	});
}

function prebuild(root: string, park = false): Promise<PrebuildOutcome> {
	return prebuildRepository(root, {
		agentDir: agentDir(),
		storeDir: storeDir(),
		settings,
		maxIdlePerRepository: 2,
		park,
	});
}

async function capture(root: string): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	if (result.status !== "captured") throw new Error(`capture ${result.status}`);
	return result.snapshot;
}

function slot(remotes: readonly string[], n: number): string {
	return pooledWorktreePath(storeDir(), repositoryIdOf(remotes), n as SlotNumber);
}

function recordOf(remotes: readonly string[], n: number): PoolSlotRecord {
	const file = join(storeDir(), "pool", repositoryIdOf(remotes), `${n}.json`);
	return JSON.parse(readFileSync(file, "utf8")) as PoolSlotRecord;
}

/** A session that recorded `snapshot` of `root`, whose checkout then moved away. */
async function sessionOf(root: string, snapshot: WorktreeSnapshot): Promise<SessionManager> {
	const manager = await SessionManager.create(store, root);
	await manager.appendWorktreeSnapshot(root, snapshot.id, snapshot);
	return manager;
}

async function resume(
	manager: SessionManager,
	overrides: Partial<PrepareSessionResumeOptions> = {},
): Promise<Extract<PreparedSessionResume, { status: "ready" }>> {
	const prepared = await prepareSessionResume(manager, {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: storeDir(),
		blueprint: { agentDir: agentDir(), trusted: () => true },
		blueprints: "skip",
		...overrides,
	});
	assert.equal(prepared.status, "ready");
	if (prepared.status !== "ready") throw new Error("unreachable");
	opened.push(prepared.sessionManager);
	return prepared;
}

/** An edit of the checkout, captured, after which the checkout moves away so the session restores. */
async function editedSession(clone: string): Promise<{ manager: SessionManager; snapshot: WorktreeSnapshot }> {
	sandbox.write(join(clone, "README.md"), "edited\n");
	const snapshot = await capture(clone);
	const manager = await sessionOf(clone, snapshot);
	renameSync(clone, sandbox.path("repo-away"));
	return { manager, snapshot };
}

describe("atomic blueprint prebuild (#4748)", () => {
	test(
		"prebuild leaves an idle slot that a later resume claims with its install kept (#4748)",
		async () => {
			const { clone, remote } = await checkout();
			const outcome = await prebuild(clone);

			assert.equal(outcome.status, "built");
			assert.equal(outcome.path, slot([remote], 0));
			assert.equal(outcome.head, await sandbox.git(clone, "rev-parse", "HEAD"));
			assert.equal(readFileSync(join(slot([remote], 0), "node_modules", ".installed"), "utf8"), "installed\n");
			const record = recordOf([remote], 0);
			assert.deepEqual(record.holder, { kind: "prebuild", id: "prebuild" });
			assert.notEqual(record.releasedAt, null);
			assert.deepEqual(await pooledWorktreeHolder(storeDir(), slot([remote], 0)), {
				owner: { kind: "prebuild", id: "prebuild" },
				held: false,
			});
			const [restore] = outcome.timings.restores;
			assert.equal(restore?.mode, "fresh");
			assert.ok((restore?.phases.materialize ?? -1) >= 0);
			assert.deepEqual(
				outcome.timings.blueprint.map((step) => step.exit),
				["ok", "ok"],
			);

			const { manager } = await editedSession(clone);
			const prepared = await resume(manager);
			assert.equal(prepared.sessionManager.getCwd(), slot([remote], 0));
			assert.equal(readFileSync(join(slot([remote], 0), "README.md"), "utf8"), "edited\n");
			assert.equal(readFileSync(join(slot([remote], 0), "node_modules", ".installed"), "utf8"), "installed\n");
			assert.equal(latestResumeTimings(prepared.sessionManager)?.restores[0]?.mode, "claimed");
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test(
		"a failed prebuild removes its worktree and keeps the previous slot and seeds (#4748)",
		async () => {
			const { clone, remote } = await checkout();
			const first = await prebuild(clone, true);
			assert.equal(first.status, "built");
			const manifest = readFileSync(seedManifestPath(storeDir(), repositoryIdOf([remote])), "utf8");

			sandbox.write(join(clone, ".atomic", "blueprint.yaml"), "maintenance: exit 3\n");
			await sandbox.commitAll(clone, "break the build");
			const failed = await prebuild(clone, true);

			assert.equal(failed.status, "partial");
			assert.equal(failed.path, undefined);
			assert.equal(existsSync(slot([remote], 1)), false);
			assert.equal(existsSync(join(storeDir(), "pool", repositoryIdOf([remote]), "1.json")), false);
			assert.notEqual(recordOf([remote], 0).releasedAt, null);
			assert.equal(readFileSync(seedManifestPath(storeDir(), repositoryIdOf([remote])), "utf8"), manifest);
			assert.equal(
				readFileSync(join(seedDirectory(storeDir(), repositoryIdOf([remote])), "build", "out.txt"), "utf8"),
				"built\n",
			);
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test("prebuild refuses a checkout without a remote or with uncommitted tracked changes (#4748)", async () => {
		const { clone } = await checkout();
		sandbox.write(join(clone, "README.md"), "uncommitted\n");
		await assert.rejects(prebuild(clone), /uncommitted changes to tracked files/);
		await sandbox.git(clone, "checkout", "--", "README.md");
		await sandbox.git(clone, "remote", "remove", "origin");
		await assert.rejects(prebuild(clone), /has no Git remote/);
		assert.equal(existsSync(join(storeDir(), "pool")), false);
	});

	test(
		"secrets of the checkout never reach the prebuilt slot or the parked seeds (#4748)",
		async () => {
			const { clone, remote } = await checkout(
				`maintenance: mkdir -p build && echo out > build/out.txt && echo token > .env.local\ncache:\n  - path: build\n    kind: build\n  - path: .env.local\n    kind: build\n`,
			);
			sandbox.write(join(clone, ".env"), "SECRET=1\n");
			sandbox.write(join(clone, "id_rsa"), "PRIVATE KEY\n");
			sandbox.write(join(clone, "untracked.txt"), "not committed\n");

			const outcome = await prebuild(clone, true);

			assert.equal(outcome.status, "built");
			const built = slot([remote], 0);
			assert.equal(existsSync(join(built, ".env")), false);
			assert.equal(existsSync(join(built, "id_rsa")), false);
			assert.equal(existsSync(join(built, "untracked.txt")), false);
			assert.deepEqual(outcome.parked, ["build"]);
			assert.match(outcome.warnings.join("\n"), /'\.env\.local' is omitted/);
			const seeds = seedDirectory(storeDir(), repositoryIdOf([remote]));
			assert.deepEqual(readdirSync(seeds), ["build"]);
			const manifest = readFileSync(seedManifestPath(storeDir(), repositoryIdOf([remote])), "utf8");
			assert.doesNotMatch(manifest, /SECRET|PRIVATE|token|repo\.git/);
			const keys = await blueprintCacheKeys(clone, { agentDir: agentDir(), storeDir: storeDir() });
			const paths = keys.entries.flatMap((entry) => entry.paths);
			assert.ok(
				paths.every((path) => !/\.env|id_rsa/.test(path)),
				paths.join("\n"),
			);
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);
});

describe("seed adoption on resume (#4748)", () => {
	/**
	 * A prebuild that parked `build/`, then a new machine: only the cache paths `atomic blueprint cache-key` prints are
	 * restored into an empty store, as a runner's cache action restores them.
	 */
	async function restoredCache(clone: string): Promise<void> {
		const outcome = await prebuild(clone, true);
		assert.equal(outcome.status, "built");
		assert.deepEqual(outcome.parked, ["build"]);
		assert.equal(existsSync(join(outcome.path!, "build")), false, "parking moves the build output out");
		const keys = await blueprintCacheKeys(clone, { agentDir: agentDir(), storeDir: storeDir() });
		const saved = keys.entries.filter((entry) => entry.name === "build" || entry.name === "git");
		const paths = saved.flatMap((entry) => entry.paths);
		const cache = sandbox.path("cache");
		for (const [index, path] of paths.entries()) cpSync(path, join(cache, String(index)), { recursive: true });
		rmSync(storeDir(), { recursive: true, force: true });
		for (const [index, path] of paths.entries()) cpSync(join(cache, String(index)), path, { recursive: true });
	}

	test(
		"a resume with no idle slot adopts the seed of a restored cache, claims it and keeps the build output (#4748)",
		async () => {
			const { clone, remote } = await checkout();
			await restoredCache(clone);
			const { manager } = await editedSession(clone);

			const prepared = await resume(manager);

			const root = slot([remote], 0);
			assert.equal(prepared.sessionManager.getCwd(), root);
			assert.equal(readFileSync(join(root, "README.md"), "utf8"), "edited\n");
			assert.equal(readFileSync(join(root, "build", "out.txt"), "utf8"), "built\n");
			assert.equal(existsSync(seedManifestPath(storeDir(), repositoryIdOf([remote]))), false);
			assert.equal(existsSync(seedDirectory(storeDir(), repositoryIdOf([remote]))), false);
			const [restore] = latestResumeTimings(prepared.sessionManager)?.restores ?? [];
			assert.equal(restore?.mode, "seeded");
			assert.ok((restore?.phases.seed ?? -1) >= 0);
			assert.ok((restore?.phases.materialize ?? -1) >= 0);
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test(
		"a seed of another repository is not adopted, and the resume restores fresh (#4748)",
		async () => {
			const { clone, remote } = await checkout();
			await restoredCache(clone);
			const id = repositoryIdOf([remote]);
			const manifest = JSON.parse(readFileSync(seedManifestPath(storeDir(), id), "utf8"));
			writeFileSync(seedManifestPath(storeDir(), id), JSON.stringify({ ...manifest, repository: "f".repeat(24) }));
			const { manager } = await editedSession(clone);

			const prepared = await resume(manager);

			const root = slot([remote], 0);
			assert.equal(prepared.sessionManager.getCwd(), root);
			assert.equal(existsSync(join(root, "build")), false);
			assert.equal(readFileSync(join(seedDirectory(storeDir(), id), "build", "out.txt"), "utf8"), "built\n");
			assert.equal(latestResumeTimings(prepared.sessionManager)?.restores[0]?.mode, "fresh");
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test(
		"adoption skips a parked path whose place holds files and one it cannot move (#4748)",
		async () => {
			const { clone, remote } = await checkout();
			const head = await sandbox.git(clone, "rev-parse", "HEAD");
			const snapshot = await capture(clone);
			const id = repositoryIdOf([remote]);
			const seeds = seedDirectory(storeDir(), id);
			sandbox.write(join(seeds, "build", "out.txt"), "built\n");
			sandbox.write(join(seeds, ".atomic", "x"), "parked over tracked files\n");
			sandbox.write(join(seeds, "locked", "inner", "file"), "cannot move\n");
			await writeSeedManifest(storeDir(), {
				version: 1,
				repository: id,
				head,
				tree: snapshot.tree,
				envHash: snapshot.envHash,
				paths: ["build", ".atomic", "locked/inner", "absent"],
				parkedAt: new Date().toISOString(),
			});
			const posix = process.platform !== "win32";
			if (posix) chmodSync(join(seeds, "locked"), 0o555);
			try {
				const adoption = await adoptPrebuiltSeed(snapshot, { storeDir: storeDir() });
				assert.equal(adoption.adopted, true);
				if (!adoption.adopted) throw new Error("unreachable");
				assert.equal(adoption.path, slot([remote], 0));
				assert.deepEqual(adoption.moved, posix ? ["build"] : ["build", "locked/inner"]);
				assert.deepEqual(adoption.skipped, posix ? [".atomic", "locked/inner"] : [".atomic"]);
				assert.equal(readFileSync(join(adoption.path, "build", "out.txt"), "utf8"), "built\n");
				assert.equal(existsSync(join(adoption.path, ".atomic", "x")), false);
				assert.equal(readFileSync(join(adoption.path, ".atomic", "blueprint.yaml"), "utf8").length > 0, true);
				assert.deepEqual(recordOf([remote], 0).holder, { kind: "prebuild", id: "seed" });
				assert.notEqual(recordOf([remote], 0).releasedAt, null);
			} finally {
				if (posix) chmodSync(join(seeds, "locked"), 0o755);
			}
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test("a missing seed or one whose commit cannot be restored adopts nothing and leaves no slot (#4748)", async () => {
		const { clone, remote } = await checkout();
		const snapshot = await capture(clone);
		assert.deepEqual(await adoptPrebuiltSeed(snapshot, { storeDir: storeDir() }), {
			adopted: false,
			reason: "missing",
		});
		const id = repositoryIdOf([remote]);
		sandbox.write(join(seedDirectory(storeDir(), id), "build", "out.txt"), "built\n");
		await writeSeedManifest(storeDir(), {
			version: 1,
			repository: id,
			head: "1".repeat(40),
			tree: "2".repeat(40),
			envHash: snapshot.envHash,
			paths: ["build"],
			parkedAt: new Date().toISOString(),
		});

		assert.deepEqual(await adoptPrebuiltSeed(snapshot, { storeDir: storeDir() }), {
			adopted: false,
			reason: "restore-failed",
		});
		assert.deepEqual(
			readdirSync(join(storeDir(), "pool", id)).filter((name) => name.endsWith(".json")),
			[],
		);
		assert.equal(existsSync(slot([remote], 0)), false);
		assert.notEqual(await readSeedManifest(storeDir(), id), undefined);
	});
});

describe("repository identity across remote spellings (#4748)", () => {
	test("SSH, scp-like and HTTPS spellings of one repository normalize alike, credentials dropped (#4748)", () => {
		for (const spelling of [
			"git@github.com:acme/widgets.git",
			"git@GitHub.com:acme/widgets",
			"ssh://git@github.com/acme/widgets.git",
			"ssh://git@github.com:22/acme/widgets/",
			"git+ssh://git@github.com/acme/widgets.git",
			"https://github.com/acme/widgets",
			"https://token:x-oauth@GITHUB.com/acme/widgets.git",
			"http://github.com:80/acme/widgets.git",
			"https://github.com:443/acme/widgets.git/",
			"git://github.com/acme/widgets.git",
		]) {
			assert.equal(normalizeRemoteUrl(spelling), "https://github.com/acme/widgets", spelling);
		}
		assert.equal(normalizeRemoteUrl("ssh://git@host.example:2222/a/b.git"), "https://host.example:2222/a/b");
		assert.equal(normalizeRemoteUrl("git@host.example:/srv/b.git"), "https://host.example/srv/b");
		for (const kept of [
			"/srv/repo.git",
			"file:///srv/repo.git",
			"C:/repo.git",
			"C:\\repo",
			"./a:b",
			"ext::cmd",
			"git@host:",
		]) {
			assert.equal(normalizeRemoteUrl(kept), kept);
		}
		assert.notEqual(normalizeRemoteUrl("https://github.com/acme/Widgets"), "https://github.com/acme/widgets");
		assert.equal(repositoryIdOf([SSH]), repositoryIdOf([HTTPS]));
		assert.notEqual(legacyRepositoryIdOf([SSH]), legacyRepositoryIdOf([HTTPS]));
		assert.equal(repositoryIdOf(["/srv/repo.git"]), legacyRepositoryIdOf(["/srv/repo.git"]));
		assert.notEqual(repositoryIdOf([SSH, "https://example.com/acme/fork"]), repositoryIdOf([SSH]));
	});

	test("the cache keys of an SSH and an HTTPS checkout of one repository are the same (#4748)", async () => {
		const { clone } = await checkout(`cache:\n  - path: build\n    kind: build\n`);
		await sandbox.git(clone, "remote", "set-url", "origin", SSH);
		const ssh = await blueprintCacheKeys(clone, { agentDir: agentDir(), storeDir: storeDir() });
		await sandbox.git(clone, "remote", "set-url", "origin", HTTPS);
		const https = await blueprintCacheKeys(clone, { agentDir: agentDir(), storeDir: storeDir() });
		assert.deepEqual(ssh, https);
		const id = repositoryIdOf([HTTPS]);
		const git = ssh.entries.find((entry) => entry.name === "git");
		assert.equal(git?.restorePrefix, `atomic-git-v1-${git?.key.split("-")[3]}-${id}-`);
		assert.deepEqual(git?.paths, [join(storeDir(), "repositories", `${id}.git`)]);
		assert.deepEqual(ssh.entries.find((entry) => entry.name === "build")?.paths, [
			join(seedDirectory(storeDir(), id), "build"),
			seedManifestPath(storeDir(), id),
		]);
	});

	test("an object store an earlier version named after the remotes as spelled is still used (#4748)", () => {
		const legacy = join(storeDir(), "repositories", `${legacyRepositoryIdOf([SSH])}.git`);
		const current = join(storeDir(), "repositories", `${repositoryIdOf([SSH])}.git`);
		assert.equal(objectStorePath(storeDir(), [SSH]), current);
		mkdirSync(legacy, { recursive: true });
		assert.equal(objectStorePath(storeDir(), [SSH]), legacy);
		mkdirSync(current, { recursive: true });
		assert.equal(objectStorePath(storeDir(), [SSH]), current);
	});

	test(
		"a session recorded over HTTPS claims the idle slot a session recorded over SSH left (#4748)",
		async () => {
			const fixture = await checkout();
			appendFileSync(sandbox.globalConfig, insteadOf(fixture.remote));
			await sandbox.git(fixture.clone, "remote", "set-url", "origin", SSH);
			sandbox.write(join(fixture.clone, "file.txt"), "over SSH\n");
			const overSsh = await capture(fixture.clone);
			await sandbox.git(fixture.clone, "remote", "set-url", "origin", HTTPS);
			sandbox.write(join(fixture.clone, "file.txt"), "over HTTPS\n");
			const overHttps = await capture(fixture.clone);
			assert.deepEqual(overSsh.remotes, [SSH]);
			assert.deepEqual(overHttps.remotes, [HTTPS]);
			const x = await sessionOf(fixture.clone, overSsh);
			const y = await sessionOf(fixture.clone, overHttps);
			renameSync(fixture.clone, sandbox.path("repo-away"));

			const first = await resume(x);
			assert.equal(first.sessionManager.getCwd(), slot([SSH], 0));
			sandbox.write(join(slot([SSH], 0), "node_modules", ".installed"), "marker\n");
			await releaseSessionWorktrees(first.sessionManager);
			const second = await resume(y);

			assert.equal(slot([SSH], 0), slot([HTTPS], 0));
			assert.equal(second.sessionManager.getCwd(), slot([HTTPS], 0));
			assert.equal(readFileSync(join(slot([HTTPS], 0), "file.txt"), "utf8"), "over HTTPS\n");
			assert.equal(readFileSync(join(slot([HTTPS], 0), "node_modules", ".installed"), "utf8"), "marker\n");
			assert.equal(latestResumeTimings(second.sessionManager)?.restores[0]?.mode, "claimed");
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test(
		"a slot and store an earlier version keyed by the remotes as spelled are still claimed (#4748)",
		async () => {
			const fixture = await checkout();
			appendFileSync(sandbox.globalConfig, insteadOf(fixture.remote));
			await sandbox.git(fixture.clone, "remote", "set-url", "origin", SSH);
			sandbox.write(join(fixture.clone, "file.txt"), "A\n");
			const a = await capture(fixture.clone);
			sandbox.write(join(fixture.clone, "file.txt"), "B\n");
			const b = await capture(fixture.clone);
			const x = await sessionOf(fixture.clone, a);
			const y = await sessionOf(fixture.clone, b);
			renameSync(fixture.clone, sandbox.path("repo-away"));
			// An earlier version's store: named after the remote as spelled, so the restore uses it.
			const legacyId = legacyRepositoryIdOf([SSH]) as RepositoryId;
			const legacyStore = join(storeDir(), "repositories", `${legacyId}.git`);
			mkdirSync(join(storeDir(), "repositories"), { recursive: true });
			await sandbox.git(storeDir(), "init", "-q", "--bare", legacyStore);
			const first = await resume(x);
			sandbox.write(join(slot([SSH], 0), "node_modules", ".installed"), "marker\n");
			await releaseSessionWorktrees(first.sessionManager);
			// ...and its pool record and slot path, keyed the same way.
			const legacySlot = pooledWorktreePath(storeDir(), legacyId, 0 as SlotNumber);
			await sandbox.git(storeDir(), `--git-dir=${legacyStore}`, "worktree", "move", slot([SSH], 0), legacySlot);
			const record = recordOf([SSH], 0);
			mkdirSync(join(storeDir(), "pool", legacyId), { recursive: true });
			writeFileSync(
				join(storeDir(), "pool", legacyId, "0.json"),
				JSON.stringify({ ...record, repository: legacyId, path: legacySlot }),
			);
			rmSync(join(storeDir(), "pool", repositoryIdOf([SSH])), { recursive: true, force: true });

			const second = await resume(y);

			assert.equal(second.sessionManager.getCwd(), legacySlot);
			assert.equal(readFileSync(join(legacySlot, "file.txt"), "utf8"), "B\n");
			assert.equal(readFileSync(join(legacySlot, "node_modules", ".installed"), "utf8"), "marker\n");
			assert.equal(latestResumeTimings(second.sessionManager)?.restores[0]?.mode, "claimed");
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);
});

describe("atomic blueprint prebuild command (#4748)", () => {
	async function run(args: readonly string[], cwd: string) {
		let out = "";
		let err = "";
		const code = await runBlueprintCommand(args, {
			cwd,
			agentDir: agentDir(),
			stdout: (text) => {
				out += text;
			},
			stderr: (text) => {
				err += text;
			},
		});
		return { code, out, err };
	}

	test(
		"an untrusted project is refused, and --approve prebuilds and parks it (#4748)",
		async () => {
			const { clone } = await checkout();
			const refused = await run(["prebuild"], clone);
			assert.equal(refused.code, 1);
			assert.match(refused.err, /is not a trusted project.*--approve/);
			assert.equal(existsSync(join(agentDir(), "worktree-snapshots", "pool")), false);

			const built = await run(["prebuild", ".", "--approve", "--park"], clone);
			assert.equal(built.code, 0, built.err);
			assert.match(built.out, /^prebuilt [0-9a-f]{40} in .*worktrees/m);
			assert.match(built.out, /^parked build in \d+\.\d s$/m);
			assert.match(built.err, /^restored .* in \d+\.\d s/m);
			assert.match(built.err, /^blueprint \d+\.\d s/m);
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);

	test(
		"a failed build exits 1 and names its log (#4748)",
		async () => {
			const { clone } = await checkout("maintenance: exit 3\n");
			const failed = await run(["prebuild", "-a"], clone);
			assert.equal(failed.code, 1);
			assert.match(failed.err, /did not finish; earlier worktrees and seeds are kept \(log: /);
			assert.equal(failed.out, "");
		},
		PREBUILD_TEST_TIMEOUT_MS,
	);
});
