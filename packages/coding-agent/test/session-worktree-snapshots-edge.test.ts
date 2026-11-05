import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, test } from "vitest";
import { GitSandbox, lfsPointer } from "../../../test/helpers/worktree-snapshot.js";
import type { ExtensionFactory } from "../src/core/extensions/index.js";
import type { SessionEntry, WorktreeSnapshotEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	adoptInlineSnapshotBlobs,
	compareWorktreeSnapshot,
	describeSnapshotExport,
	describeWorktreeSnapshot,
	formatWorktreeRestoreNotice,
	formatWorktreeRestoreWarning,
	inlineBlobStore,
	inlineSnapshotBlobs,
	mapRestoredPath,
	openSessionInWorktree,
	resumeSessionWorktree,
	sessionSnapshotBlobs,
	worktreeRestoreNotices,
} from "../src/core/session-worktree-snapshots.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.ts";
import { JsonlSessionStore } from "../src/core/storage/session/jsonl-session-store.ts";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.ts";
import type { SessionStore } from "../src/core/storage/session/types.ts";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.ts";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.ts";
import {
	isGitUnavailableError,
	isWorkspaceConfigError,
	isWorkspaceDriftError,
	isWorkspaceRestoreError,
	isWorkspaceSnapshotError,
	MemorySnapshotBlobStore,
	type SnapshotBlobStore,
	setWorktreeSnapshotGit,
	WorkspaceRestoreError,
	type WorktreeRootMapping,
	type WorktreeSnapshot,
} from "../src/index.ts";
import { createHarness, type Harness } from "./suite/harness.js";

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

async function sqlStore(name = "sessions", prefix?: string): Promise<SessionStore> {
	const database = await openNodeSqliteDatabase(sandbox.path(`${name}.sqlite`));
	const store = await SqlSessionStore.open(database, prefix === undefined ? {} : { prefix });
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	return store;
}

async function harnessFor(
	sessionManager: SessionManager,
	options: { extensionFactories?: ExtensionFactory[]; settings?: Record<string, unknown> } = {},
): Promise<Harness> {
	const harness = await createHarness({ sessionManager, ...options });
	cleanups.push(() => harness.cleanup());
	return harness;
}

/** A harness whose working directory, the one its tools run in, is a repository with a pushed commit. */
async function repoHarness(
	manager: SessionManager,
	options: { extensionFactories?: ExtensionFactory[]; settings?: Record<string, unknown> } = {},
): Promise<{ harness: Harness; cwd: string }> {
	const harness = await harnessFor(manager, options);
	const cwd = harness.tempDir;
	const remote = sandbox.path(`session-${manager.getSessionId()}.git`);
	await sandbox.git(sandbox.root, "init", "-q", "--bare", remote);
	await sandbox.git(cwd, "init", "-q", "-b", "main");
	sandbox.write(join(cwd, "README.md"), "session repo\n");
	await sandbox.git(cwd, "add", "-A");
	await sandbox.git(cwd, "commit", "-q", "-m", "initial");
	await sandbox.git(cwd, "remote", "add", "origin", remote);
	await sandbox.git(cwd, "push", "-q", "origin", "HEAD:main");
	await sandbox.git(cwd, "branch", "-q", "--set-upstream-to=origin/main");
	return { harness, cwd: realpathSync(cwd) };
}

const snapshotEntries = (manager: SessionManager): WorktreeSnapshotEntry[] =>
	manager.getEntries().filter((entry): entry is WorktreeSnapshotEntry => entry.type === "worktree_snapshot");

async function toolTurn(harness: Harness, name: string, args: Record<string, unknown>): Promise<void> {
	harness.appendResponses([
		fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await harness.session.prompt(`run ${name}`);
}

const reasons = (harness: Harness) =>
	harness.eventsOfType("worktree_snapshot_unavailable").map((event) => event.reason);

describe("which turns record, and where", () => {
	test("write and edit record the checkout of the file they name, relative or absolute, deduplicated with the session's own", async () => {
		const other = await sandbox.remoteWithClone("other");
		const manager = await SessionManager.create(await sqlStore(), sandbox.root);
		const { harness, cwd } = await repoHarness(manager);
		await toolTurn(harness, "write", { path: join(other.clone, "new", "file.txt"), content: "other\n" });
		await toolTurn(harness, "write", { path: "relative/new.txt", content: "own\n" });
		const roots = snapshotEntries(manager).map((entry) => entry.root);
		assert.deepEqual(roots.sort(), [cwd, cwd, other.clone].sort());
		assert.deepEqual(reasons(harness), []);
	});

	test("an empty path argument adds no directory beyond the session's own", async () => {
		const manager = await SessionManager.create(await sqlStore(), sandbox.root);
		const { harness, cwd } = await repoHarness(manager);
		await toolTurn(harness, "write", { path: "", content: "ignored\n" });
		assert.deepEqual(reasons(harness), []);
		assert.ok(snapshotEntries(manager).every((entry) => entry.root === cwd));
	});

	test("each distinct reason is reported once, and distinct subjects are distinct reasons", async () => {
		const plainOne = sandbox.path("plain-one");
		const plainTwo = sandbox.path("plain-two");
		mkdirSync(plainOne);
		mkdirSync(plainTwo);
		const manager = await SessionManager.create(await sqlStore(), sandbox.root);
		const { harness } = await repoHarness(manager);
		await toolTurn(harness, "write", { path: join(plainTwo, "a.txt"), content: "a\n" });
		await toolTurn(harness, "write", { path: join(plainTwo, "b.txt"), content: "b\n" });
		await toolTurn(harness, "write", { path: join(plainOne, "c.txt"), content: "c\n" });
		const seen = reasons(harness).map((reason) => [reason.code, reason.fields.subject]);
		assert.deepEqual(seen.sort(), [
			["not-a-repository", plainOne],
			["not-a-repository", plainTwo],
		]);
	});

	test("a turn that only reads records nothing and reports nothing, even where recording is impossible", async () => {
		const store = await JsonlSessionStore.open(sandbox.path("jsonl"), { exactDirectory: true });
		cleanups.push(() => store.close());
		const manager = await SessionManager.create(store, sandbox.root);
		const { harness, cwd } = await repoHarness(manager);
		await toolTurn(harness, "read", { path: join(cwd, "README.md") });
		harness.appendResponses([fauxAssistantMessage("just talking")]);
		await harness.session.prompt("hello");
		assert.deepEqual(reasons(harness), []);
		assert.equal(snapshotEntries(manager).length, 0);
	});

	test("an in-memory session never records or reports", async () => {
		const manager = SessionManager.inMemory(sandbox.root);
		const { harness, cwd } = await repoHarness(manager);
		await toolTurn(harness, "write", { path: join(cwd, "a.txt"), content: "a\n" });
		assert.deepEqual(reasons(harness), []);
		assert.equal(snapshotEntries(manager).length, 0);
	});

	test("snapshots.enabled false stops recording; an invalid setting is reported once as a typed config error", async () => {
		const store = await sqlStore();
		const off = await SessionManager.create(store, sandbox.root);
		const { harness: offHarness, cwd } = await repoHarness(off, { settings: { snapshots: { enabled: false } } });
		await toolTurn(offHarness, "write", { path: join(cwd, "a.txt"), content: "a\n" });
		assert.equal(snapshotEntries(off).length, 0);
		assert.deepEqual(reasons(offHarness), []);

		const broken = await SessionManager.create(store, sandbox.root);
		const { harness: brokenHarness, cwd: brokenCwd } = await repoHarness(broken, {
			settings: { snapshots: { fullEvery: 0 } },
		});
		await toolTurn(brokenHarness, "write", { path: join(brokenCwd, "b.txt"), content: "b\n" });
		await toolTurn(brokenHarness, "write", { path: join(brokenCwd, "c.txt"), content: "c\n" });
		const [reason, ...rest] = reasons(brokenHarness);
		assert.equal(rest.length, 0);
		assert.ok(reason);
		assert.equal(reason.code, "invalid-setting");
		assert.deepEqual(reason.fields, {
			source: "settings",
			field: "snapshots.fullEvery",
			expected: "a positive integer",
		});
		assert.equal(snapshotEntries(broken).length, 0);
	});

	test("Git disappearing between locating the checkout and capturing it is reported, not recorded", async () => {
		const manager = await SessionManager.create(await sqlStore(), sandbox.root);
		const { harness, cwd } = await repoHarness(manager);
		let lookups = 0;
		setWorktreeSnapshotGit(async () => {
			lookups++;
			return lookups <= 2 ? sandbox.executable : { path: sandbox.path("vanished-git"), env: {} };
		});
		await toolTurn(harness, "write", { path: join(cwd, "a.txt"), content: "a\n" });
		const [reason, ...rest] = reasons(harness);
		assert.equal(rest.length, 0);
		assert.ok(isGitUnavailableError(reason));
		assert.equal(snapshotEntries(manager).length, 0);
	});

	test("an extension tool that declares writesFiles records the checkout of its session", async () => {
		const manager = await SessionManager.create(await sqlStore(), sandbox.root);
		const target = { dir: "" };
		const tool =
			(name: string, writesFiles: boolean): ExtensionFactory =>
			(pi) => {
				pi.registerTool({
					name,
					label: name,
					description: name,
					parameters: Type.Object({}),
					...(writesFiles ? { writesFiles } : {}),
					execute: async () => {
						writeFileSync(join(target.dir, `${name}.txt`), `${name}\n`);
						return { content: [{ type: "text", text: "ok" }], details: {} };
					},
				});
			};
		const { harness, cwd } = await repoHarness(manager, {
			extensionFactories: [tool("quiet", false), tool("loud", true)],
		});
		target.dir = cwd;
		await toolTurn(harness, "quiet", {});
		assert.equal(snapshotEntries(manager).length, 0);
		await toolTurn(harness, "loud", {});
		assert.equal(snapshotEntries(manager).length, 1);
		assert.equal(snapshotEntries(manager)[0]?.root, cwd);
	});
});

describe("mapRestoredPath", () => {
	const mapping = (from: string, to: string): WorktreeRootMapping => ({
		from,
		to,
		snapshotId: "s",
		tree: "t",
		restoredAt: "2026-01-01T00:00:00.000Z",
	});

	test("moves a path under a restored root to the same place under its replacement, through every restore in order", () => {
		assert.equal(mapRestoredPath("/old/repo/src/a.ts", [mapping("/old/repo", "/new/repo")]), "/new/repo/src/a.ts");
		assert.equal(mapRestoredPath("/old/repo", [mapping("/old/repo", "/new/repo")]), "/new/repo");
		assert.equal(
			mapRestoredPath("/old/repo/src", [mapping("/old/repo", "/mid/repo"), mapping("/mid/repo", "/final/repo")]),
			"/final/repo/src",
		);
	});

	test("a sibling that merely shares a prefix, a parent and an unrelated path stay where they are", () => {
		const mappings = [mapping("/old/repo", "/new/repo")];
		assert.equal(mapRestoredPath("/old/repo-two/src", mappings), "/old/repo-two/src");
		assert.equal(mapRestoredPath("/old", mappings), "/old");
		assert.equal(mapRestoredPath("/elsewhere/repo", mappings), "/elsewhere/repo");
		assert.equal(mapRestoredPath("/old/repo/x", []), "/old/repo/x");
	});

	test("a relative path is resolved against the working directory first", () => {
		assert.equal(mapRestoredPath("rel/dir", []), resolve("rel/dir"));
	});
});

describe("choosing the checkout a resumed session belongs to", () => {
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

	test("the innermost recorded checkout containing the working directory is restored, whatever order roots were recorded in", async () => {
		const outer = await sandbox.remoteWithClone("outer");
		const innerPath = join(outer.clone, "inner");
		await sandbox.git(sandbox.root, "init", "-q", innerPath);
		sandbox.write(join(innerPath, "src", "a.txt"), "inner\n");
		await sandbox.git(innerPath, "add", "-A");
		await sandbox.git(innerPath, "commit", "-q", "-m", "inner");
		const store = await sqlStore();
		const outerSnapshot = (await captureWorktreeSnapshot(outer.clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		const innerSnapshot = (await captureWorktreeSnapshot(innerPath, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		for (const order of [
			[outerSnapshot.snapshot, innerSnapshot.snapshot],
			[innerSnapshot.snapshot, outerSnapshot.snapshot],
		]) {
			const manager = await SessionManager.create(store, join(innerPath, "src"));
			for (const snapshot of order) await manager.appendWorktreeSnapshot(snapshot.root, snapshot.id, snapshot);
			writeFileSync(join(innerPath, "drift.txt"), `${Math.random()}\n`);
			let calls = 0;
			setWorktreeSnapshotGit(async () => {
				calls++;
				return sandbox.executable;
			});
			const restoredRoots: string[] = [];
			try {
				const resume = await resumeSessionWorktree(manager, {
					settings,
					storeDir: sandbox.path(`host-${restoredRoots.length}`),
				});
				assert.equal(resume.status, "restored");
				if (resume.status === "restored") assert.ok(resume.mappings.some((mapping) => mapping.from === innerPath));
			} finally {
				rmSync(join(innerPath, "drift.txt"), { force: true });
			}
			assert.ok(calls > 0);
		}
	});

	test("disabled or absent snapshots touch no Git; recorded roots outside the working directory are still verified", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		const manager = await SessionManager.create(store, clone);
		const capture = (await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		let lookups = 0;
		setWorktreeSnapshotGit(async () => {
			lookups++;
			return sandbox.executable;
		});
		assert.deepEqual(await resumeSessionWorktree(manager, { settings: { ...settings, enabled: false } }), {
			status: "none",
		});
		const elsewhere = await SessionManager.create(store, sandbox.root);
		assert.deepEqual(await resumeSessionWorktree(elsewhere, { settings }), { status: "none" });
		const parentOnly = await SessionManager.create(store, join(sandbox.root, "unrelated"));
		await parentOnly.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		assert.equal((await resumeSessionWorktree(parentOnly, { settings })).status, "verified");
		assert.ok(lookups > 0);
	});

	test("verification applies the settings the snapshot was captured with", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		const lean = { ...settings, includeUntracked: false };
		const capture = (await captureWorktreeSnapshot(clone, {
			blobs: store.snapshotBlobs,
			settings: lean,
		})) as { snapshot: WorktreeSnapshot };
		const manager = await SessionManager.create(store, clone);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		sandbox.write(join(clone, "untracked.txt"), "x\n");
		const same = await resumeSessionWorktree(manager, { settings: lean, storeDir: sandbox.path("host") });
		assert.equal(same.status, "verified");
		const different = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(different.status, "restored");
	});

	test("resuming twice on a host that excludes a recorded file reuses the first restored worktree (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "notes.log"), "recorded\n");
		const store = await sqlStore();
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		const manager = await SessionManager.create(store, clone);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		renameSync(clone, sandbox.path("original-away"));
		const excludes = sandbox.path("excludes");
		writeFileSync(excludes, "*.log\n");
		writeFileSync(
			sandbox.globalConfig,
			`${readFileSync(sandbox.globalConfig, "utf8")}\n[core]\n\texcludesFile = ${excludes}\n`,
		);
		const storeDir = sandbox.path("host");
		const first = await resumeSessionWorktree(manager, { settings, storeDir });
		assert.equal(first.status, "restored");
		if (first.status !== "restored") return;
		assert.equal(readFileSync(join(first.mappings[0]!.to, "notes.log"), "utf8"), "recorded\n");
		const second = await resumeSessionWorktree(manager, { settings, storeDir });
		assert.equal(second.status, "verified");
		assert.deepEqual(readdirSync(join(storeDir, "worktrees")), [first.mappings[0]!.to.split(/[\\/]/).at(-1)]);
		assert.equal(manager.getWorktreeRootMappings().length, 1);
	});

	test("a checkout that no longer exists is restored from its snapshot, keeping the working subdirectory", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "src/a.txt": "a\n" });
		const store = await sqlStore();
		const capture = (await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		const manager = await SessionManager.create(store, join(clone, "src"));
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		renameSync(clone, sandbox.path("moved-away"));
		const resume = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(resume.status, "restored");
		if (resume.status !== "restored") return;
		const mapping = resume.mappings[0]!;
		assert.equal(resume.cwd, join(mapping.to, "src"));
		assert.equal(mapping.from, clone);
		assert.equal(mapping.snapshotId, capture.snapshot.id);
		assert.equal(mapping.tree, capture.snapshot.tree);
		assert.match(mapping.restoredAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
		assert.equal(readFileSync(join(resume.cwd, "a.txt"), "utf8"), "a\n");
		assert.deepEqual(manager.getWorktreeRootMappings(), [mapping]);
		const entry = snapshotEntries(manager).at(-1);
		assert.equal(entry?.root, mapping.to);
		assert.equal(entry?.snapshotId, capture.snapshot.id);
		assert.equal(entry?.snapshot, undefined);
		assert.deepEqual(entry?.restore, mapping);
	});

	test("a replaced checkout without repository history is restored into a fresh worktree", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		const capture = (await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		const manager = await SessionManager.create(store, clone);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		rmSync(join(clone, ".git"), { recursive: true });
		await sandbox.git(clone, "init", "-q");
		const result = await resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(result.status, "restored");
		if (result.status === "restored") assert.notEqual(result.cwd, clone);
	});

	test("a failure that is not a typed workspace error propagates unchanged instead of being wrapped as drift", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const capture = (await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		const controller = new AbortController();
		const reason = new Error("operator cancelled");
		const aborting: SnapshotBlobStore = {
			putBlobs: (blobs) => store.snapshotBlobs!.putBlobs(blobs),
			listBlobHashes: () => store.snapshotBlobs!.listBlobHashes(),
			deleteBlobs: (hashes, options) => store.snapshotBlobs!.deleteBlobs(hashes, options),
			getBlob: async (hash) => {
				controller.abort(reason);
				return store.snapshotBlobs!.getBlob(hash);
			},
		};
		const wrapped = Object.create(store, { snapshotBlobs: { value: aborting } }) as SessionStore;
		const manager = await SessionManager.create(wrapped, clone);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		writeFileSync(join(clone, "x.txt"), "drifted\n");
		await assert.rejects(
			resumeSessionWorktree(manager, { settings, storeDir: sandbox.path("host"), signal: controller.signal }),
			(error: unknown) => error === reason,
		);
	});

	test("a snapshot that cannot be restored fails with the drift it would have repaired, and its cause", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		const capture = (await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		const unreachable = { ...capture.snapshot, remotes: [sandbox.path("nowhere.git")], head: "5".repeat(40) };
		const detached = await SessionManager.create(store, sandbox.path("gone"));
		await detached.appendWorktreeSnapshot(sandbox.path("gone"), unreachable.id, unreachable);
		await assert.rejects(
			resumeSessionWorktree(detached, { settings, storeDir: sandbox.path("host") }),
			(error: unknown) => {
				assert.ok(isWorkspaceDriftError(error));
				assert.equal(error.root, sandbox.path("gone"));
				assert.equal(error.expectedHead, "5".repeat(40));
				assert.equal(error.expectedTree, unreachable.tree);
				assert.equal(error.snapshotId, unreachable.id);
				assert.equal(error.actualHead, null);
				assert.equal(error.actualTree, null);
				assert.ok(isWorkspaceRestoreError(error.cause));
				assert.equal(error.reason, "restore-failed");
				assert.equal(error.restoreCode, "commits-unavailable");
				assert.equal(
					error.message,
					`Worktree drifted from its recorded snapshot: ${sandbox.path("gone")} has tree none at no HEAD, expected ${unreachable.tree} at ${"5".repeat(40)}, and the automatic restore failed: Cannot restore snapshot ${unreachable.id}: commit ${"5".repeat(40)} could not be fetched from ${sandbox.path("nowhere.git")} (tree-drift). Check access with \`git ls-remote ${sandbox.path("nowhere.git")}\` and that ${"5".repeat(40)} is pushed, then retry.`,
				);
				return true;
			},
		);
		assert.deepEqual(detached.getWorktreeRootMappings(), []);
	});
});

describe("opening a session where it continues", () => {
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

	test("a verified checkout keeps the same session; a mapped one is reopened at its new directory", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const capture = (await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs })) as {
			snapshot: WorktreeSnapshot;
		};
		const manager = await SessionManager.create(store, clone);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		const inPlace = await openSessionInWorktree(manager, { settings, storeDir: sandbox.path("host") });
		assert.equal(inPlace.sessionManager, manager);
		assert.deepEqual(inPlace.notices, []);

		writeFileSync(join(clone, "x.txt"), "drift\n");
		const restored = await openSessionInWorktree(manager, { settings, storeDir: sandbox.path("host") });
		const [mapping] = manager.getWorktreeRootMappings();
		assert.ok(mapping);
		assert.notEqual(restored.sessionManager, manager);
		assert.equal(restored.sessionManager.getCwd(), mapping.to);
		assert.equal(restored.notices.length, 1);

		const original = await SessionManager.open(store, manager.getSessionId());
		assert.equal(original.getCwd(), clone);
		const verifiedElsewhere = await openSessionInWorktree(original, { settings, storeDir: sandbox.path("host") });
		assert.notEqual(verifiedElsewhere.sessionManager, original);
		assert.equal(verifiedElsewhere.sessionManager.getCwd(), mapping.to);
		assert.deepEqual(verifiedElsewhere.notices, []);
	});

	test("a stale-restore warning appears once when a session resumes without duplicating snapshot warnings (#4245)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		const store = await sqlStore();
		sandbox.write(join(clone, "x.txt"), "recorded\n");
		sandbox.write(join(clone, ".env"), "omitted secret\n");
		const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
		assert.equal(capture.status, "captured");
		if (capture.status !== "captured") return;
		const manager = await SessionManager.create(store, clone);
		await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
		writeFileSync(join(clone, "x.txt"), "drift\n");
		const storeDir = sandbox.path("host");
		mkdirSync(join(storeDir, "restores"), { recursive: true });
		const brokenRecord = join(storeDir, "restores", `${randomUUID()}.json`);
		writeFileSync(brokenRecord, "{");
		const resumed = await openSessionInWorktree(manager, { settings, storeDir });
		assert.deepEqual(resumed.notices, [
			{ type: "info", message: formatWorktreeRestoreNotice(manager.getWorktreeRootMappings()[0]!) },
			{ type: "warning", message: "The restored snapshot left out 1 item(s): .env (denied)" },
			{
				type: "warning",
				message: `A restore interrupted earlier left the crash record ${brokenRecord}, which cannot be read; delete the file`,
			},
		]);
		assert.equal(existsSync(brokenRecord), true);
	});

	test.skipIf(process.platform === "win32")(
		"LFS objects a resume could not fetch are named once, after the snapshot's own notices (#4245)",
		async () => {
			const { clone } = await sandbox.remoteWithClone("repo", {
				".gitattributes": "*.bin filter=lfs -text\n",
				"data.bin": lfsPointer("base\n"),
			});
			sandbox.write(join(clone, "data.bin"), lfsPointer("edited\n"));
			const store = await sqlStore();
			const capture = await captureWorktreeSnapshot(clone, { blobs: store.snapshotBlobs });
			assert.equal(capture.status, "captured");
			if (capture.status !== "captured") return;
			const manager = await SessionManager.create(store, clone);
			await manager.appendWorktreeSnapshot(clone, capture.snapshot.id, capture.snapshot);
			writeFileSync(join(clone, "data.bin"), "drift\n");
			const bin = sandbox.path("lfs-bin");
			mkdirSync(bin);
			writeFileSync(join(bin, "git-lfs"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
			const executable = sandbox.executable;
			setWorktreeSnapshotGit(async () => ({
				path: "git",
				env: { ...executable.env, PATH: `${bin}:${process.env.PATH}` },
			}));
			const resumed = await openSessionInWorktree(manager, { settings, storeDir: sandbox.path("host") });
			assert.deepEqual(resumed.notices, [
				{ type: "info", message: formatWorktreeRestoreNotice(manager.getWorktreeRootMappings()[0]!) },
				{
					type: "warning",
					message: formatWorktreeRestoreWarning({
						code: "filters",
						filters: { autocrlf: null, eol: null, drivers: ["lfs"] },
					}),
				},
				{
					type: "warning",
					message: formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: ["data.bin"] }),
				},
			]);
		},
	);
});

describe("restore notices", () => {
	const mapping: WorktreeRootMapping = {
		from: "/old/repo",
		to: "/new/repo",
		snapshotId: "0123456789abcdef0123456789abcdef",
		tree: "t",
		restoredAt: "2026-02-03T04:05:06.000Z",
	};
	const record = (overrides: Partial<WorktreeSnapshot>) =>
		({ id: mapping.snapshotId, omitted: [], filters: null, ...overrides }) as WorktreeSnapshot;
	const restoreEntry: SessionEntry = {
		type: "worktree_snapshot",
		id: "restore",
		parentId: null,
		timestamp: mapping.restoredAt,
		root: mapping.to,
		snapshotId: mapping.snapshotId,
		restore: mapping,
	};
	const manager = (snapshot?: WorktreeSnapshot) => ({
		getBranch: () => [restoreEntry],
		getWorktreeSnapshotRecords: () => new Map(snapshot ? [[snapshot.id, snapshot]] : []),
	});

	test("the notice names the snapshot, the old root and the new worktree", () => {
		assert.equal(
			formatWorktreeRestoreNotice(mapping),
			"Restored worktree snapshot 0123456789ab of /old/repo into /new/repo",
		);
	});

	test("a restore is announced from the moment this resume began, with the snapshot's warnings after it", () => {
		const snapshot = record({
			omitted: [{ reason: "denied", path: ".env" }],
			filters: { autocrlf: "true", eol: null, drivers: [] },
		});
		const lines = worktreeRestoreNotices(manager(snapshot), mapping.restoredAt);
		assert.deepEqual(lines, [
			{ type: "info", message: formatWorktreeRestoreNotice(mapping) },
			{ type: "warning", message: "The restored snapshot left out 1 item(s): .env (denied)" },
			{
				type: "warning",
				message:
					"The source checkout used conversion settings (core.autocrlf=true); the restore holds Git's stored content with LF line endings",
			},
		]);
		assert.deepEqual(worktreeRestoreNotices(manager(snapshot), "2026-02-03T04:05:06.001Z"), []);
		assert.deepEqual(
			worktreeRestoreNotices({ getBranch: () => [], getWorktreeSnapshotRecords: () => new Map() }, "0"),
			[],
		);
		assert.deepEqual(worktreeRestoreNotices(manager(), "2000-01-01T00:00:00.000Z"), [
			{ type: "info", message: formatWorktreeRestoreNotice(mapping) },
		]);
	});

	test("each restore warning renders its own sentence", () => {
		assert.equal(
			formatWorktreeRestoreWarning({
				code: "omitted-content",
				omitted: [
					{ reason: "denied", path: ".env" },
					{ reason: "over-file-cap", path: "big.bin", bytes: 9 },
					{ reason: "unpushed-history-denied", commits: ["c1"], paths: ["a.pem"] },
					{ reason: "bundle-over-cap", commits: ["c2"], bytes: 9 },
				],
			}),
			"The restored snapshot left out 4 item(s): .env (denied), big.bin (over-file-cap), unpushed-history-denied, bundle-over-cap",
		);
		const filters = (autocrlf: string | null, eol: string | null, drivers: string[]) =>
			formatWorktreeRestoreWarning({ code: "filters", filters: { autocrlf, eol, drivers } });
		const tail = "; the restore holds Git's stored content with LF line endings";
		assert.equal(
			filters("true", "lf", ["lfs", "zeta"]),
			`The source checkout used conversion settings (core.autocrlf=true, core.eol=lf, filter=lfs, filter=zeta)${tail}`,
		);
		assert.equal(filters(null, "crlf", []), `The source checkout used conversion settings (core.eol=crlf)${tail}`);
		assert.equal(filters(null, null, ["lfs"]), `The source checkout used conversion settings (filter=lfs)${tail}`);
		assert.equal(filters("", null, []), `The source checkout used conversion settings (core.autocrlf=)${tail}`);
		assert.equal(
			formatWorktreeRestoreWarning({ code: "lfs-objects-unavailable", paths: ["a.bin", "docs/b.bin"] }),
			"Git LFS objects could not be fetched; these files hold LFS pointers: a.bin, docs/b.bin",
		);
		assert.equal(
			formatWorktreeRestoreWarning({ code: "stale-restore-retained", path: "/work/unfinished", kind: "worktree" }),
			"A restore interrupted earlier left /work/unfinished; remove it with removeRestoredWorktree or delete the directory",
		);
		assert.equal(
			formatWorktreeRestoreWarning({
				code: "stale-restore-retained",
				path: "/host/restores/r.json",
				kind: "record",
			}),
			"A restore interrupted earlier left the crash record /host/restores/r.json, which cannot be read; delete the file",
		);
		assert.equal(
			formatWorktreeRestoreWarning({
				code: "stale-restore-retained",
				path: "/host/restores",
				kind: "records-directory",
			}),
			"The restore crash records in /host/restores cannot be read; make the directory readable or remove it",
		);
	});
});

describe("describing snapshots", () => {
	const base = {
		id: "snap-1",
		root: "/work/repo",
		branch: "main",
		head: "0123456789abcdef0123",
		tree: "fedcba9876543210fedc",
		capturedAt: "2026-02-03T04:05:06.000Z",
		chain: [
			{ tree: "t1", patch: "p1", bytes: 100 },
			{ tree: "t2", patch: "p2", bytes: 23 },
		],
		bundle: null,
		omitted: [],
		filters: null,
	} as unknown as WorktreeSnapshot;

	test("lists the root, the capture, the position, the chain size and the bundle", () => {
		assert.deepEqual(describeWorktreeSnapshot("/work/repo", base), [
			"/work/repo",
			"  snapshot snap-1 captured 2026-02-03T04:05:06.000Z",
			"  main at 0123456789ab, tree fedcba987654",
			"  delta chain 2 link(s), 123 bytes; no unpushed commits bundled",
		]);
	});

	test("adds the bundle, a detached HEAD, omissions of both kinds and the conversion warnings", () => {
		const detailed = {
			...base,
			branch: null,
			bundle: { blob: "b", bytes: 5, commits: ["c1", "c2", "c3"] },
			omitted: [
				{ reason: "denied", path: ".env" },
				{ reason: "unpushed-history-denied", commits: ["c1", "c2"], paths: ["a.pem"] },
			],
			filters: { autocrlf: null, eol: null, drivers: ["lfs"] },
		} as unknown as WorktreeSnapshot;
		assert.deepEqual(describeWorktreeSnapshot("/elsewhere", detailed), [
			"/elsewhere",
			"  snapshot snap-1 captured 2026-02-03T04:05:06.000Z",
			"  detached at 0123456789ab, tree fedcba987654",
			"  delta chain 2 link(s), 123 bytes; 3 unpushed commit(s) bundled",
			"  omitted: .env (denied), 2 commit(s) (unpushed-history-denied)",
			"The source checkout used conversion settings (filter=lfs); the restore holds Git's stored content with LF line endings",
		]);
	});

	test("an export summary counts snapshots, roots, blob bytes once each and omissions once per snapshot", () => {
		const first = {
			...base,
			id: "s1",
			root: "/a",
			chain: [
				{ tree: "t", patch: "shared", bytes: 10 },
				{ tree: "t2", patch: null, bytes: 0 },
			],
			bundle: { blob: "bundle-1", bytes: 7, commits: ["c"] },
			omitted: [{ reason: "denied", path: ".env" }],
		} as unknown as WorktreeSnapshot;
		const second = {
			...base,
			id: "s2",
			root: "/b",
			chain: [{ tree: "t", patch: "shared", bytes: 10 }],
			omitted: [
				{ reason: "denied", path: "a" },
				{ reason: "denied", path: "b" },
			],
		} as unknown as WorktreeSnapshot;
		const entry = (id: string, snapshotId: string, snapshot?: WorktreeSnapshot): SessionEntry => ({
			type: "worktree_snapshot",
			id,
			parentId: null,
			timestamp: "t",
			root: snapshot?.root ?? "/x",
			snapshotId,
			...(snapshot ? { snapshot } : {}),
		});
		const records = new Map([
			["s1", first],
			["s2", second],
		]);
		const entries: SessionEntry[] = [
			entry("e1", "s1", first),
			entry("e2", "s1"),
			entry("e3", "s2"),
			entry("e4", "ghost"),
			{ type: "label", id: "e5", parentId: null, timestamp: "t", targetId: "e1", label: "x" },
		];
		assert.equal(
			describeSnapshotExport(entries, records),
			"Includes 3 worktree snapshot(s) of /a, /b: 17 bytes of patch and bundle content, 3 omitted item(s) not included",
		);
		assert.equal(
			describeSnapshotExport([entry("e1", "s2", second)], records),
			"Includes 1 worktree snapshot(s) of /b: 10 bytes of patch and bundle content, 2 omitted item(s) not included",
		);
		assert.equal(
			describeSnapshotExport([entry("e1", "s1", { ...first, omitted: [] })], new Map()),
			"Includes 1 worktree snapshot(s) of /a: 17 bytes of patch and bundle content",
		);
		assert.equal(describeSnapshotExport([entries[4]!], records), undefined);
		assert.equal(describeSnapshotExport([], records), undefined);
	});
});

describe("comparing a snapshot with the current tree", () => {
	const settings = DEFAULT_WORKTREE_SNAPSHOT_SETTINGS;

	test("reports a match, a missing checkout, a drift with its diff, and a drift whose tree is not here", async () => {
		const { clone } = await sandbox.remoteWithClone("repo", { "a.txt": "one\n" });
		sandbox.write(join(clone, "a.txt"), "twelve\n");
		const { snapshot } = (await captureWorktreeSnapshot(clone)) as { snapshot: WorktreeSnapshot };
		const match = await compareWorktreeSnapshot(snapshot, clone, settings);
		assert.deepEqual(match, { status: "match", tree: snapshot.tree });

		const missing = await compareWorktreeSnapshot(snapshot, sandbox.path("nowhere"), settings);
		assert.equal(missing.status, "missing");
		assert.equal(missing.status === "missing" && missing.reason.code, "not-a-repository");

		writeFileSync(join(clone, "a.txt"), "three\n");
		const differs = await compareWorktreeSnapshot(snapshot, clone, settings);
		assert.equal(differs.status, "differs");
		assert.ok(differs.status === "differs");
		assert.equal(differs.head, snapshot.head);
		assert.notEqual(differs.tree, snapshot.tree);
		assert.match(differs.stat ?? "", /a\.txt \| 2 \+-\n 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)/);

		const foreign = { ...snapshot, tree: "3".repeat(40) };
		const unknownTree = await compareWorktreeSnapshot(foreign, clone, settings);
		assert.equal(unknownTree.status, "differs");
		assert.equal(unknownTree.status === "differs" && unknownTree.stat, undefined);
	});

	test("a moved HEAD descended from the recorded head with an unchanged tree is a match", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "x.txt"), "x\n");
		const { snapshot } = (await captureWorktreeSnapshot(clone)) as { snapshot: WorktreeSnapshot };
		const moved = await sandbox.commitAll(clone, "commit the edit");
		const result = await compareWorktreeSnapshot(snapshot, clone, settings);
		assert.deepEqual(result, { status: "match", tree: snapshot.tree, head: moved });
	});
});

describe("snapshot content carried inline by an exported session", () => {
	const hashOf = async (bytes: Uint8Array) =>
		(await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");

	async function fixture() {
		const store = new MemorySnapshotBlobStore();
		const dataA = new Uint8Array([1, 2, 3]);
		const dataB = new Uint8Array([250, 0, 9]);
		const hashA = await hashOf(dataA);
		const hashB = await hashOf(dataB);
		await store.putBlobs([
			{ hash: hashA, data: dataA },
			{ hash: hashB, data: dataB },
		]);
		const snapshot = {
			id: "snap",
			root: "/r",
			chain: [
				{ tree: "t1", patch: hashA, bytes: 3 },
				{ tree: "t2", patch: hashB, bytes: 3 },
			],
			bundle: null,
			omitted: [],
			filters: null,
		} as unknown as WorktreeSnapshot;
		const entry = (id: string, extra: object = {}): WorktreeSnapshotEntry => ({
			type: "worktree_snapshot",
			id,
			parentId: null,
			timestamp: "t",
			root: "/r",
			snapshotId: "snap",
			...extra,
		});
		return { store, dataA, dataB, hashA, hashB, snapshot, entry };
	}

	test("each record and each blob is carried once, base64-encoded, and other entries pass through untouched", async () => {
		const { store, hashA, hashB, snapshot, entry } = await fixture();
		const label: SessionEntry = {
			type: "label",
			id: "l",
			parentId: null,
			timestamp: "t",
			targetId: "e1",
			label: "x",
		};
		const out = await inlineSnapshotBlobs(
			[label, entry("e1"), entry("e2", { snapshot })],
			new Map([["snap", snapshot]]),
			store,
		);
		assert.equal(out[0], label);
		const [, first, second] = out as [SessionEntry, WorktreeSnapshotEntry, WorktreeSnapshotEntry];
		assert.deepEqual(first.snapshot, snapshot);
		assert.deepEqual(first.blobs, {
			[hashA]: Buffer.from([1, 2, 3]).toString("base64"),
			[hashB]: Buffer.from([250, 0, 9]).toString("base64"),
		});
		assert.equal(Object.hasOwn(second, "snapshot"), false);
		assert.equal(Object.hasOwn(second, "blobs"), false);
	});

	test("without a store only records travel; a blob the store lost is left out; stale inline blobs are replaced", async () => {
		const { store, hashA, snapshot, entry } = await fixture();
		const records = new Map([["snap", snapshot]]);
		const noStore = await inlineSnapshotBlobs([entry("e1", { blobs: { stale: "AA==" } })], records, undefined);
		assert.deepEqual((noStore[0] as WorktreeSnapshotEntry).snapshot, snapshot);
		assert.equal(Object.hasOwn(noStore[0]!, "blobs"), false);
		await store.deleteBlobs([(await store.listBlobHashes())[1]!], { olderThanSeconds: 0 });
		const partial = await inlineSnapshotBlobs([entry("e1", { blobs: { stale: "AA==" } })], records, store);
		assert.deepEqual(Object.keys((partial[0] as WorktreeSnapshotEntry).blobs ?? {}), [hashA]);
		const unknown = await inlineSnapshotBlobs([entry("e1")], new Map(), store);
		assert.equal(Object.hasOwn(unknown[0]!, "snapshot"), false);
		assert.equal(Object.hasOwn(unknown[0]!, "blobs"), false);
	});

	test("adopting verifies every blob against its hash, stores them once and strips them from the entries", async () => {
		const { dataA, dataB, hashA, hashB, entry } = await fixture();
		const target = new MemorySnapshotBlobStore();
		let puts = 0;
		const spying: SnapshotBlobStore = {
			putBlobs: async (blobs) => {
				puts++;
				assert.equal(blobs.length, 2);
				return target.putBlobs(blobs);
			},
			getBlob: (hash) => target.getBlob(hash),
			listBlobHashes: () => target.listBlobHashes(),
			deleteBlobs: (hashes, options) => target.deleteBlobs(hashes, options),
		};
		const carried = entry("e1", {
			blobs: { [hashA]: Buffer.from(dataA).toString("base64"), [hashB]: Buffer.from(dataB).toString("base64") },
		});
		const plain: SessionEntry = {
			type: "label",
			id: "l",
			parentId: null,
			timestamp: "t",
			targetId: "e1",
			label: "x",
		};
		const adopted = await adoptInlineSnapshotBlobs([plain, carried, entry("e2")], spying);
		assert.equal(puts, 1);
		assert.deepEqual([...(await target.listBlobHashes())].sort(), [hashA, hashB].sort());
		assert.equal(adopted[0], plain);
		assert.equal(Object.hasOwn(adopted[1]!, "blobs"), false);
		assert.equal((adopted[1] as WorktreeSnapshotEntry).snapshotId, "snap");
		assert.equal(adopted[2]!.id, "e2");
	});

	test("without a store the blobs stay inline; with nothing to adopt the store is not touched", async () => {
		const { dataA, hashA, entry } = await fixture();
		const carried = entry("e1", { blobs: { [hashA]: Buffer.from(dataA).toString("base64") } });
		const kept = await adoptInlineSnapshotBlobs([carried], undefined);
		assert.notEqual(kept, [carried]);
		assert.deepEqual(kept, [carried]);
		let touched = 0;
		const spying = new MemorySnapshotBlobStore();
		spying.putBlobs = async () => {
			touched++;
		};
		const untouched = await adoptInlineSnapshotBlobs([entry("e1")], spying);
		assert.equal(touched, 0);
		assert.equal(untouched.length, 1);
	});

	test("a blob that does not match its hash fails before anything is stored, naming the snapshot and blob", async () => {
		const { entry } = await fixture();
		const target = new MemorySnapshotBlobStore();
		await assert.rejects(
			adoptInlineSnapshotBlobs(
				[entry("e1", { blobs: { deadbeef: Buffer.from("tampered").toString("base64") } })],
				target,
			),
			(error: unknown) => {
				assert.ok(isWorkspaceRestoreError(error));
				assert.equal(error.code, "blob-corrupt");
				assert.deepEqual(error.fields, { snapshotId: "snap", blob: "deadbeef" });
				assert.equal(
					error.message,
					"Cannot restore snapshot snap: snapshot blob deadbeef does not match its hash (blob-corrupt). The stored snapshot is damaged; restore an earlier snapshot or re-import the session.",
				);
				return true;
			},
		);
		assert.deepEqual(await target.listBlobHashes(), []);
	});

	test("the inline view serves the carried blobs and refuses writes", async () => {
		const { dataA, dataB, hashA, hashB, entry } = await fixture();
		const carried = entry("e1", {
			blobs: { [hashA]: Buffer.from(dataA).toString("base64") },
		});
		const other = entry("e2", { blobs: { [hashB]: Buffer.from(dataB).toString("base64") } });
		const label: SessionEntry = {
			type: "label",
			id: "l",
			parentId: null,
			timestamp: "t",
			targetId: "e1",
			label: "x",
		};
		const view = inlineBlobStore([label, carried, other, entry("e3")]);
		assert.deepEqual([...(await view.getBlob(hashA))!], [1, 2, 3]);
		assert.deepEqual([...(await view.getBlob(hashB))!], [250, 0, 9]);
		assert.equal(await view.getBlob("absent"), undefined);
		assert.deepEqual([...(await view.listBlobHashes())].sort(), [hashA, hashB].sort());
		for (const write of [() => view.putBlobs([]), () => view.deleteBlobs([], { olderThanSeconds: 0 })]) {
			await assert.rejects(write(), (error: unknown) => {
				assert.ok(isWorkspaceSnapshotError(error));
				assert.equal(error.code, "blob-store-unsupported");
				assert.equal(error.subject, "inline");
				return true;
			});
		}
	});

	test("the session view reads the store first, falls back to inline blobs and delegates every write to the store", async () => {
		const { dataA, hashA, entry } = await fixture();
		const primary = new MemorySnapshotBlobStore();
		await primary.putBlobs([{ hash: "only-primary", data: new Uint8Array([7]) }]);
		const view = sessionSnapshotBlobs(primary, [
			entry("e1", { blobs: { [hashA]: Buffer.from(dataA).toString("base64") } }),
		]);
		assert.deepEqual([...(await view.getBlob("only-primary"))!], [7]);
		assert.deepEqual([...(await view.getBlob(hashA))!], [1, 2, 3]);
		assert.equal(await view.getBlob("absent"), undefined);
		await view.putBlobs([{ hash: "written", data: new Uint8Array([9]) }]);
		assert.deepEqual([...(await primary.listBlobHashes())].sort(), ["only-primary", "written"]);
		assert.deepEqual([...(await view.listBlobHashes())].sort(), ["only-primary", "written"]);
		await view.deleteBlobs(["written"], { olderThanSeconds: 0 });
		assert.deepEqual(await primary.listBlobHashes(), ["only-primary"]);
		const inlineOnly = sessionSnapshotBlobs(undefined, [
			entry("e1", { blobs: { [hashA]: Buffer.from(dataA).toString("base64") } }),
		]);
		assert.deepEqual([...(await inlineOnly.getBlob(hashA))!], [1, 2, 3]);
		await assert.rejects(inlineOnly.putBlobs([]), isWorkspaceSnapshotError);
		void realpathSync;
		void WorkspaceRestoreError;
		void isWorkspaceConfigError;
		void SettingsManager;
	});
});
