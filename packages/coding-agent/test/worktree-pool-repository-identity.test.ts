import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import {
	type PreparedSessionResume,
	type PrepareSessionResumeOptions,
	prepareSessionResume,
} from "../src/core/resume/session-resume.js";
import { SessionManager } from "../src/core/session-manager.js";
import { releaseSessionWorktrees } from "../src/core/session-worktree-snapshots.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import { sha256Hex } from "../src/core/worktree-snapshot/env-hash.js";
import {
	claimIdleWorktree,
	type PoolSlotRecord,
	pooledWorktreePath,
	type RepositoryId,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import {
	checkoutStoreIdOf,
	legacyRepositoryIdOf,
	normalizeRemoteUrl,
	repositoryIdOf,
	sharedRepositoryIdOf,
	sharedRepositoryIdsOf,
} from "../src/core/worktree-snapshot/repository-identity.js";
import { objectStorePath, restoreWorktree, restoreWorktreeAt } from "../src/core/worktree-snapshot/restore.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

useTemporaryAgentDir();

const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;
/** The identity every remote-less checkout had before #4989: `sha24` of no remotes. */
const EMPTY_IDENTITY = sha256Hex("").slice(0, 24) as RepositoryId;
const SECRET = '{"token":"A-SECRET"}\n';

let sandbox: GitSandbox;
let store: SqlSessionStore;
let database: Awaited<ReturnType<typeof openNodeSqliteDatabase>>;
const opened: SessionManager[] = [];

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

/** A repository at `path` made with `git init`, one commit of `files`, and the `origin` remote when given. */
async function repository(path: string, files: Record<string, string>, origin?: string): Promise<string> {
	const root = sandbox.path(path);
	mkdirSync(root, { recursive: true });
	await sandbox.git(root, "init", "-q");
	if (origin !== undefined) await sandbox.git(root, "remote", "add", "origin", origin);
	for (const [file, content] of Object.entries(files)) sandbox.write(join(root, file), content);
	await sandbox.commitAll(root, "initial");
	return root;
}

const IGNORING = { ".gitignore": "secrets/\nnode_modules/\n" };

async function capture(root: string): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(root, { settings, blobs: store.snapshotBlobs });
	assert.equal(result.status, "captured");
	if (result.status !== "captured") throw new Error("unreachable");
	return result.snapshot;
}

function prepareOptions(): PrepareSessionResumeOptions {
	return {
		entryPoint: "cli",
		launchCwd: sandbox.root,
		settings,
		storeDir: storeDir(),
		blueprint: { agentDir: sandbox.path("agent"), trusted: () => false },
		blueprints: "skip",
	};
}

/** Records a snapshot of the checkout at `root` in a new session, moves the checkout away, and resumes the session. */
async function resumeAway(root: string): Promise<{ snapshot: WorktreeSnapshot; cwd: string; manager: SessionManager }> {
	const snapshot = await capture(root);
	const manager = await SessionManager.create(store, root);
	await manager.appendWorktreeSnapshot(root, snapshot.id, snapshot);
	renameSync(root, `${root}-away`);
	const prepared: PreparedSessionResume = await prepareSessionResume(manager, prepareOptions());
	assert.equal(prepared.status, "ready");
	if (prepared.status !== "ready") throw new Error("unreachable");
	opened.push(prepared.sessionManager);
	const cwd = prepared.sessionManager.getCwd();
	assert.notEqual(resolve(cwd), resolve(root));
	return { snapshot, cwd, manager: prepared.sessionManager };
}

/** Leaves ignored files in a resumed worktree, as installing and configuring a project does, then closes its session. */
async function fillAndClose(resumed: { cwd: string; manager: SessionManager }): Promise<void> {
	sandbox.write(join(resumed.cwd, "secrets", "prod-token.json"), SECRET);
	sandbox.write(join(resumed.cwd, "node_modules", "a-dep", "index.js"), "A's dependency\n");
	await releaseSessionWorktrees(resumed.manager);
	opened.splice(opened.indexOf(resumed.manager), 1);
}

/** The object store the worktree at `root` belongs to. */
async function storeOf(root: string): Promise<string> {
	return resolve(root, await sandbox.git(root, "rev-parse", "--git-common-dir"));
}

function assertHoldsNothingOfA(root: string): void {
	assert.equal(existsSync(join(root, "secrets", "prod-token.json")), false, "B sees A's ignored secret");
	assert.equal(existsSync(join(root, "node_modules", "a-dep")), false, "B sees A's ignored dependencies");
}

describe("pooled worktrees and object stores belong to one repository (#4989)", () => {
	test("two unrelated remote-less repositories never share a slot or an object store (#4989)", async () => {
		const a = await repository("project-a", { ...IGNORING, "a.txt": "A\n" });
		const b = await repository("project-b", { ...IGNORING, "b.txt": "B\n" });
		const resumedA = await resumeAway(a);
		await fillAndClose(resumedA);

		const resumedB = await resumeAway(b);

		assert.notEqual(resumedB.cwd, resumedA.cwd);
		assertHoldsNothingOfA(resumedB.cwd);
		assert.equal(readFileSync(join(resumedB.cwd, "b.txt"), "utf8"), "B\n");
		assert.notEqual(await storeOf(resumedB.cwd), await storeOf(resumedA.cwd));
		// B's store never received A's commits, so nothing of A's history is readable from B's worktree.
		assert.equal(
			(await sandbox.git(resumedB.cwd, "cat-file", "-t", resumedA.snapshot.head).catch(() => "missing")) ===
				"commit",
			false,
		);
		// A's worktree keeps what A left in it.
		assert.equal(readFileSync(join(resumedA.cwd, "secrets", "prod-token.json"), "utf8"), SECRET);
	});

	test("two clones of one remote-less repository each resume their own snapshot (#4989)", async () => {
		const original = await repository("original", { ...IGNORING, "shared.txt": "shared\n" });
		const first = sandbox.path("clone-1");
		const second = sandbox.path("clone-2");
		for (const clone of [first, second]) {
			await sandbox.git(sandbox.root, "clone", "-q", original, clone);
			await sandbox.git(clone, "remote", "remove", "origin");
		}
		sandbox.write(join(first, "work.txt"), "first\n");
		sandbox.write(join(second, "work.txt"), "second\n");

		const resumedFirst = await resumeAway(first);
		await fillAndClose(resumedFirst);
		const resumedSecond = await resumeAway(second);

		assert.equal(readFileSync(join(resumedFirst.cwd, "work.txt"), "utf8"), "first\n");
		assert.equal(readFileSync(join(resumedSecond.cwd, "work.txt"), "utf8"), "second\n");
		assert.equal(readFileSync(join(resumedSecond.cwd, "shared.txt"), "utf8"), "shared\n");
		assert.notEqual(resumedSecond.cwd, resumedFirst.cwd);
		assertHoldsNothingOfA(resumedSecond.cwd);
	});

	test("repositories whose origin is ../upstream in different directories never share a slot (#4989)", async () => {
		const a = await repository(join("one", "project"), { ...IGNORING, "a.txt": "A\n" }, "../upstream");
		const b = await repository(join("two", "project"), { ...IGNORING, "b.txt": "B\n" }, "../upstream");
		const resumedA = await resumeAway(a);
		await fillAndClose(resumedA);

		const resumedB = await resumeAway(b);

		assert.notEqual(resumedB.cwd, resumedA.cwd);
		assertHoldsNothingOfA(resumedB.cwd);
		assert.equal(readFileSync(join(resumedB.cwd, "b.txt"), "utf8"), "B\n");
		assert.notEqual(await storeOf(resumedB.cwd), await storeOf(resumedA.cwd));
	});

	test("a slot an earlier version pooled under the shared empty identity is never claimed by another repository (#4989)", async () => {
		const a = await repository("project-a", { ...IGNORING, "a.txt": "A\n" });
		const b = await repository("project-b", { ...IGNORING, "b.txt": "B\n" });
		// What an earlier version left: A's idle slot under the identity every remote-less checkout shared.
		const snapshotA = await capture(a);
		const legacy = pooledWorktreePath(storeDir(), EMPTY_IDENTITY, 0 as SlotNumber);
		await restoreWorktreeAt(snapshotA, legacy, { storeDir: storeDir(), blobs: store.snapshotBlobs });
		sandbox.write(join(legacy, "secrets", "prod-token.json"), SECRET);
		const record: PoolSlotRecord = {
			version: 1,
			repository: EMPTY_IDENTITY,
			slot: 0 as SlotNumber,
			path: legacy,
			holder: { kind: "session", id: "session-a" },
			lastState: { snapshotId: snapshotA.id, head: snapshotA.head, tree: snapshotA.tree },
			envHash: snapshotA.envHash,
			blueprintDigest: null,
			releasedAt: new Date().toISOString(),
			tenancy: "tenancy-a",
		};
		const recordFile = join(storeDir(), "pool", EMPTY_IDENTITY, "0.json");
		mkdirSync(join(storeDir(), "pool", EMPTY_IDENTITY), { recursive: true });
		writeFileSync(recordFile, JSON.stringify(record));
		const snapshotB = await capture(b);

		const claim = await claimIdleWorktree(snapshotB, {
			storeDir: storeDir(),
			owner: { kind: "session", id: "session-b" },
			settings,
			blobs: store.snapshotBlobs,
		});
		const resumedB = await resumeAway(b);

		assert.equal(claim.claimed, false);
		assert.notEqual(resumedB.cwd, legacy);
		assertHoldsNothingOfA(resumedB.cwd);
		// A's slot is untouched: its record, its files, and what A left in it.
		assert.deepEqual(JSON.parse(readFileSync(recordFile, "utf8")), record);
		assert.equal(readFileSync(join(legacy, "a.txt"), "utf8"), "A\n");
		assert.equal(readFileSync(join(legacy, "secrets", "prod-token.json"), "utf8"), SECRET);
		assert.deepEqual(readdirSync(join(storeDir(), "pool", EMPTY_IDENTITY)).sort(), ["0.json"]);
	});

	test("a claim never resets a slot whose worktree belongs to another repository's store (#4989)", async () => {
		const a = await sandbox.remoteWithClone("repo-a", { ...IGNORING, "a.txt": "A\n" });
		const b = await sandbox.remoteWithClone("repo-b", { ...IGNORING, "b.txt": "B\n" });
		const resumedA = await resumeAway(a.clone);
		await fillAndClose(resumedA);
		const snapshotB = await capture(b.clone);
		// A's idle slot, recorded under B's identity, as a record of an identity several repositories shared may be.
		const repositoryB = repositoryIdOf(snapshotB.remotes);
		const foreign = pooledWorktreePath(storeDir(), repositoryB, 0 as SlotNumber);
		renameSync(resumedA.cwd, foreign);
		const fromA = join(storeDir(), "pool", repositoryIdOf(resumedA.snapshot.remotes), "0.json");
		const record = { ...(JSON.parse(readFileSync(fromA, "utf8")) as PoolSlotRecord), repository: repositoryB };
		const recordFile = join(storeDir(), "pool", repositoryB, "0.json");
		mkdirSync(join(storeDir(), "pool", repositoryB), { recursive: true });
		writeFileSync(recordFile, JSON.stringify({ ...record, path: foreign }));

		const claim = await claimIdleWorktree(snapshotB, {
			storeDir: storeDir(),
			owner: { kind: "session", id: "session-b" },
			settings,
			blobs: store.snapshotBlobs,
		});

		assert.deepEqual(claim, { claimed: false, reason: "foreign" });
		assert.deepEqual(JSON.parse(readFileSync(recordFile, "utf8")), { ...record, path: foreign });
		assert.equal(readFileSync(join(foreign, "a.txt"), "utf8"), "A\n");
		assert.equal(readFileSync(join(foreign, "secrets", "prod-token.json"), "utf8"), SECRET);
	});

	test("a binding of a checkout without remotes restores only with the snapshot that names its checkout (#4989)", async () => {
		const a = await repository("project-a", { "a.txt": "A\n" });
		const snapshot = await capture(a);
		const binding = { remotes: [], head: snapshot.head, tree: snapshot.tree, envHash: snapshot.envHash };
		await restoreWorktree(snapshot, { storeDir: storeDir(), blobs: store.snapshotBlobs });

		await assert.rejects(restoreWorktree(binding, { storeDir: storeDir(), blobs: store.snapshotBlobs }), {
			code: "commits-unavailable",
		});
		const restored = await restoreWorktree(binding, {
			storeDir: storeDir(),
			blobs: store.snapshotBlobs,
			snapshots: [snapshot],
		});
		assert.equal(readFileSync(join(restored.path, "a.txt"), "utf8"), "A\n");
		assert.deepEqual(
			readdirSync(join(storeDir(), "repositories")).filter((name) => !name.startsWith(".")),
			[`${checkoutStoreIdOf(snapshot.root)}.git`],
		);
	});
});

describe("the identity a repository's checkouts share (#4989)", () => {
	const root = resolve("/work", "one", "project");
	const other = resolve("/work", "two", "project");

	test("a relative-path remote names the path it resolves to from the checkout's root (#4989)", () => {
		assert.equal(normalizeRemoteUrl("../upstream", root), resolve("/work", "one", "upstream"));
		assert.equal(normalizeRemoteUrl(" ./up\n", root), resolve(root, "up"));
		assert.equal(normalizeRemoteUrl("./a:b", root), resolve(root, "./a:b"));
		// A drive-relative Windows path is a path, not a host named by one letter.
		assert.equal(normalizeRemoteUrl("C:repo", root), resolve(root, "C:repo"));
		assert.equal(normalizeRemoteUrl("../upstream"), "../upstream");
		assert.equal(normalizeRemoteUrl("../upstream", "relative/root"), "../upstream");
		assert.notEqual(repositoryIdOf(["../upstream"], root), repositoryIdOf(["../upstream"], other));
		assert.equal(
			repositoryIdOf(["../upstream"], root),
			repositoryIdOf(["../../upstream"], resolve("/work", "one", "x", "y")),
		);
	});

	test("URLs, scp-like and absolute remotes ignore the checkout's root (#4989)", () => {
		for (const remote of [
			"https://github.com/acme/widgets",
			"git@github.com:acme/widgets.git",
			"alice@host.example:repo.git",
			"host.example:repo.git",
			"ext::cmd",
			"file:///srv/repo.git",
			"/srv/repo.git",
			"C:/repo.git",
			"C:\\repo",
			"\\\\server\\share\\repo",
		]) {
			assert.equal(normalizeRemoteUrl(remote, root), normalizeRemoteUrl(remote), remote);
			assert.equal(sharedRepositoryIdOf([remote]), repositoryIdOf([remote]), remote);
			assert.deepEqual(
				sharedRepositoryIdsOf([remote]),
				[...new Set([repositoryIdOf([remote]), legacyRepositoryIdOf([remote])])],
				remote,
			);
		}
		assert.equal(normalizeRemoteUrl("", root), "");
		assert.equal(normalizeRemoteUrl(" /srv/repo.git\n", root), " /srv/repo.git\n");
	});

	test("remotes that name no one repository have no shared identity (#4989)", () => {
		assert.equal(sharedRepositoryIdOf([], root), undefined);
		assert.deepEqual(sharedRepositoryIdsOf([], root), []);
		assert.equal(sharedRepositoryIdOf(["../upstream"]), undefined);
		assert.equal(sharedRepositoryIdOf(["https://github.com/acme/widgets", "../upstream"], "relative"), undefined);
		assert.deepEqual(sharedRepositoryIdsOf(["../upstream"]), []);
		// The identity earlier versions gave `../upstream` named every checkout's neighbour of that name.
		assert.deepEqual(sharedRepositoryIdsOf(["../upstream"], root), [repositoryIdOf(["../upstream"], root)]);
		assert.deepEqual(sharedRepositoryIdsOf(["https://github.com/acme/widgets", "../upstream"], root), [
			repositoryIdOf(["https://github.com/acme/widgets", "../upstream"], root),
		]);
		assert.equal(sharedRepositoryIdOf(["../upstream"], root), repositoryIdOf(["../upstream"], root));
	});

	test("a checkout without remotes has an object store of its own (#4989)", () => {
		const storeDir = resolve("/host");
		const own = objectStorePath(storeDir, [], root);
		assert.equal(own, join(storeDir, "repositories", `${checkoutStoreIdOf(root)}.git`));
		assert.notEqual(own, objectStorePath(storeDir, [], other));
		assert.notEqual(own, join(storeDir, "repositories", `${EMPTY_IDENTITY}.git`));
		assert.equal(checkoutStoreIdOf(join(root, "x", "..")), checkoutStoreIdOf(root));
		assert.equal(objectStorePath(storeDir, []), undefined);
		assert.equal(objectStorePath(storeDir, [], "relative"), undefined);
		assert.equal(objectStorePath(storeDir, ["../upstream"]), undefined);
		assert.equal(
			objectStorePath(storeDir, ["../upstream"], root),
			join(storeDir, "repositories", `${repositoryIdOf(["../upstream"], root)}.git`),
		);
	});
});
