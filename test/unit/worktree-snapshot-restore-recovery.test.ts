import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	removeRestoredWorktree,
	restoreWorktree,
	type WorktreeRestoreWarning,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

/**
 * Crash recovery of interrupted restores, driven the way a crash leaves things: a record under `restores/`, a staging
 * worktree registered in the shared store, and a lock directory whose age says whether its holder is alive. Locks are
 * aged with utimes instead of waiting out the 30-second stale window.
 */

const HEX24 = "0123456789abcdef01234567";
const RESTORE_LOCK_STALE_SECONDS = 30;

let sandbox: GitSandbox;
let remote: string;
let head: string;
beforeEach(async () => {
	sandbox = new GitSandbox();
	const fixture = await sandbox.remoteWithClone();
	remote = fixture.remote;
	head = await sandbox.git(fixture.clone, "rev-parse", "HEAD");
});
afterEach(() => sandbox.dispose());

interface Host {
	readonly storeDir: string;
	readonly store: string;
}

/** A host directory holding one shared bare store, named like the ones a restore creates. */
async function makeHost(name = "host"): Promise<Host> {
	return makeHostAt(sandbox.path(name));
}

async function makeHostAt(storeDir: string): Promise<Host> {
	const store = join(storeDir, "repositories", `${HEX24}.git`);
	mkdirSync(join(storeDir, "repositories"), { recursive: true });
	await sandbox.git(sandbox.root, "clone", "--bare", "-q", remote, store);
	return { storeDir, store };
}

/** Another bare store, as a clone of the first, for records that name a store they should not. */
async function makeStore(path: string): Promise<string> {
	mkdirSync(dirname(path), { recursive: true });
	await sandbox.git(sandbox.root, "clone", "--bare", "-q", remote, path);
	return path;
}

/** What an interrupted `git worktree add` leaves: a directory registered in `store`. */
async function stage(store: string, path: string): Promise<string> {
	await sandbox.git(
		sandbox.root,
		"--git-dir",
		store,
		"worktree",
		"add",
		"-q",
		"--detach",
		"--no-checkout",
		path,
		head,
	);
	return path;
}

async function registered(store: string): Promise<string[]> {
	const listing = await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "list", "--porcelain");
	return listing
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

const warning = (
	path: string,
	kind: "worktree" | "record" | "records-directory" = "worktree",
): WorktreeRestoreWarning => ({ code: "stale-restore-retained", path, kind });

function writeRecord(host: Host, id: string, fields: unknown, name = `${id}.json`): string {
	mkdirSync(join(host.storeDir, "restores"), { recursive: true });
	const path = join(host.storeDir, "restores", name);
	writeFileSync(path, JSON.stringify(fields));
	return path;
}

/** The lock directory a restore holds on its record, `ageSeconds` after its last refresh. */
function holdLock(record: string, ageSeconds: number): string {
	const lock = `${record}.lock`;
	mkdirSync(lock);
	const refreshed = new Date(Date.now() - ageSeconds * 1000);
	utimesSync(lock, refreshed, refreshed);
	return lock;
}

/** Runs the sweep that every restore and removal starts with, by removing a path that does not exist. */
async function sweep(host: Host): Promise<WorktreeRestoreWarning[]> {
	const warnings: WorktreeRestoreWarning[] = [];
	await removeRestoredWorktree(sandbox.path("nothing-to-remove"), {
		storeDir: host.storeDir,
		onWarning: (reported) => warnings.push(reported),
	});
	return warnings;
}

const defaultStaging = (host: Host, id: string) => join(host.storeDir, "worktrees", `.staging-${id}`);
const siblingStaging = (target: string, id: string) =>
	join(dirname(target), `.${basename(target)}.atomic-restore-${id}`);

describe("sweeping the records an interrupted restore left", () => {
	test("a default restore whose lock went stale is removed: staging, registration, record and lock, with nothing reported", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const staging = await stage(host.store, defaultStaging(host, id));
		const target = join(host.storeDir, "worktrees", "interrupted-final");
		const record = writeRecord(host, id, { staging, target, store: host.store, createdTarget: true });
		const lock = holdLock(record, RESTORE_LOCK_STALE_SECONDS * 2);
		assert.ok((await registered(host.store)).includes(staging));

		assert.deepEqual(await sweep(host), []);

		assert.equal(existsSync(staging), false);
		assert.equal((await registered(host.store)).includes(staging), false);
		assert.equal(existsSync(record), false);
		assert.equal(existsSync(lock), false);
		assert.equal(existsSync(target), false, "a target the restore had to create is not created by its cleanup");
		assert.deepEqual(readdirSync(join(host.storeDir, "restores")), []);
	});

	test("a restore into a chosen directory is removed through its sibling staging name", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const target = sandbox.path("chosen");
		const staging = await stage(host.store, siblingStaging(target, id));
		const record = writeRecord(host, id, { staging, target, store: host.store, createdTarget: true });

		assert.deepEqual(await sweep(host), []);

		assert.equal(existsSync(staging), false);
		assert.equal((await registered(host.store)).includes(staging), false);
		assert.equal(existsSync(record), false);
		assert.equal(existsSync(target), false);
	});

	test("an empty directory the restore had emptied is put back, and a file in its place is left alone", async () => {
		const host = await makeHost();
		const gone = sandbox.path("emptied");
		const id = randomUUID();
		const staging = await stage(host.store, siblingStaging(gone, id));
		writeRecord(host, id, { staging, target: gone, store: host.store, createdTarget: false });
		assert.deepEqual(await sweep(host), []);
		assert.equal(lstatSync(gone).isDirectory(), true);
		assert.deepEqual(readdirSync(gone), []);
		assert.equal(existsSync(staging), false);

		const taken = sandbox.path("taken");
		writeFileSync(taken, "a file the user put there\n");
		const otherId = randomUUID();
		const otherStaging = await stage(host.store, siblingStaging(taken, otherId));
		const otherRecord = writeRecord(host, otherId, {
			staging: otherStaging,
			target: taken,
			store: host.store,
			createdTarget: false,
		});
		assert.deepEqual(await sweep(host), []);
		assert.equal(readFileSync(taken, "utf8"), "a file the user put there\n");
		assert.equal(existsSync(otherStaging), false);
		assert.equal(existsSync(otherRecord), false);
	});

	test("a restore that died before git worktree add left only its record, and the record is removed quietly", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const target = join(host.storeDir, "worktrees", "never-added");
		const record = writeRecord(host, id, {
			staging: defaultStaging(host, id),
			target,
			store: host.store,
			createdTarget: true,
		});

		assert.deepEqual(await sweep(host), []);

		assert.equal(existsSync(record), false);
		assert.equal(existsSync(defaultStaging(host, id)), false);
	});

	test("a locked entry that a killed worktree add left behind is removed even though its directory is gone", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const staging = await stage(host.store, defaultStaging(host, id));
		await sandbox.git(sandbox.root, "--git-dir", host.store, "worktree", "lock", "--reason", "initializing", staging);
		rmSync(staging, { recursive: true });
		const record = writeRecord(host, id, {
			staging,
			target: join(host.storeDir, "worktrees", "killed-during-add"),
			store: host.store,
			createdTarget: true,
		});

		assert.deepEqual(await sweep(host), []);

		assert.equal((await registered(host.store)).includes(staging), false);
		assert.equal(existsSync(record), false);
	});

	test.each([
		["just refreshed", 0],
		["refreshed 20 seconds ago, inside the 30-second window", 20],
	])("a restore whose lock was %s is still running: nothing of it is touched or reported", async (_name, age) => {
		const host = await makeHost();
		const id = randomUUID();
		const staging = await stage(host.store, defaultStaging(host, id));
		const record = writeRecord(host, id, {
			staging,
			target: join(host.storeDir, "worktrees", "running"),
			store: host.store,
			createdTarget: true,
		});
		const lock = holdLock(record, age);

		assert.deepEqual(await sweep(host), []);

		assert.equal(existsSync(staging), true);
		assert.ok((await registered(host.store)).includes(staging));
		assert.equal(existsSync(record), true);
		assert.equal(existsSync(lock), true);
	});

	test("a record held through a symlink is locked under its own name, so a live restore is not mistaken for a dead one", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const staging = await stage(host.store, defaultStaging(host, id));
		const real = sandbox.path("elsewhere", "real-record.json");
		mkdirSync(dirname(real));
		writeFileSync(
			real,
			JSON.stringify({
				staging,
				target: join(host.storeDir, "worktrees", "running"),
				store: host.store,
				createdTarget: true,
			}),
		);
		mkdirSync(join(host.storeDir, "restores"), { recursive: true });
		const record = join(host.storeDir, "restores", `${id}.json`);
		symlinkSync(real, record);
		holdLock(record, 0);

		assert.deepEqual(await sweep(host), []);

		assert.equal(existsSync(staging), true);
		assert.equal(existsSync(real), true);
	});

	test("files in the records directory that are not records are ignored, whatever they contain", async () => {
		const host = await makeHost();
		const liveId = randomUUID();
		const liveStaging = await stage(host.store, defaultStaging(host, liveId));
		const live = writeRecord(host, liveId, {
			staging: liveStaging,
			target: join(host.storeDir, "worktrees", "live"),
			store: host.store,
			createdTarget: true,
		});
		holdLock(live, 0);
		const copyId = randomUUID();
		const copyStaging = await stage(host.store, defaultStaging(host, copyId));
		writeRecord(
			host,
			copyId,
			{
				staging: copyStaging,
				target: join(host.storeDir, "worktrees", "copy"),
				store: host.store,
				createdTarget: true,
			},
			`copy-of-${copyId}.json`,
		);
		writeRecord(host, randomUUID(), "not even json {", "notes.txt");
		writeRecord(host, randomUUID(), "{}", `${randomUUID()}.json.bak`);
		const before = readdirSync(join(host.storeDir, "restores")).sort();

		assert.deepEqual(await sweep(host), []);

		assert.deepEqual(readdirSync(join(host.storeDir, "restores")).sort(), before);
		assert.equal(existsSync(liveStaging), true);
		assert.equal(existsSync(copyStaging), true, "a record under a name Atomic never uses is not acted on");
	});

	test("a records path that cannot be listed is reported with its path instead of being skipped", async () => {
		const host = await makeHost();
		const restores = join(host.storeDir, "restores");
		writeFileSync(restores, "a file where the records directory belongs\n");

		assert.deepEqual(await sweep(host), [warning(restores, "records-directory")]);
	});

	test("with no callback the leftover is a process warning that names the path and the way out", async () => {
		const host = await makeHost();
		const restores = join(host.storeDir, "restores");
		writeFileSync(restores, "a file where the records directory belongs\n");
		const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
		let emitted: unknown[][];
		try {
			await removeRestoredWorktree(sandbox.path("nothing-to-remove"), { storeDir: host.storeDir });
		} finally {
			emitted = emit.mock.calls.map((call) => [...call]);
			emit.mockRestore();
		}
		assert.deepEqual(emitted, [
			[`A restore interrupted earlier left ${restores}; remove the directory and retry cleanup.`],
		]);
	});

	test.skipIf(process.platform === "win32")(
		"a host directory reached through a symlink is swept: the registered path is the physical one",
		async () => {
			const real = sandbox.path("real-host");
			mkdirSync(real);
			const link = sandbox.path("link-host");
			symlinkSync(real, link, "dir");
			const host = await makeHostAt(link);
			const id = randomUUID();
			const staging = await stage(host.store, defaultStaging(host, id));
			const record = writeRecord(host, id, {
				staging,
				target: join(host.storeDir, "worktrees", "through-link"),
				store: host.store,
				createdTarget: true,
			});

			assert.deepEqual(await sweep(host), []);

			assert.equal(existsSync(staging), false);
			assert.equal(existsSync(record), false);
		},
	);
});

describe("a record is acted on only when it is exactly what Atomic writes", () => {
	interface Forged {
		readonly fields: unknown;
		/** A registered worktree that a wrongly trusted record would have deleted. */
		readonly staging?: string;
	}
	const forgeries: ReadonlyArray<readonly [string, (host: Host, id: string) => Promise<Forged>]> = [
		[
			"createdTarget is not a boolean",
			async (host, id) => {
				const staging = await stage(host.store, defaultStaging(host, id));
				return {
					staging,
					fields: {
						staging,
						target: join(host.storeDir, "worktrees", "x"),
						store: host.store,
						createdTarget: "yes",
					},
				};
			},
		],
		[
			"the target is not a normalized path",
			async (host, id) => {
				const target = `${sandbox.root}/a-directory/../final`;
				const staging = await stage(host.store, siblingStaging(target, id));
				return { staging, fields: { staging, target, store: host.store, createdTarget: true } };
			},
		],
		[
			"the store path ends with a separator",
			async (host, id) => {
				const staging = await stage(host.store, defaultStaging(host, id));
				return {
					staging,
					fields: {
						staging,
						target: join(host.storeDir, "worktrees", "x"),
						store: `${host.store}/`,
						createdTarget: true,
					},
				};
			},
		],
		[
			"the store is outside the repositories directory",
			async (host, id) => {
				const store = await makeStore(sandbox.path("elsewhere", `${HEX24}.git`));
				const staging = await stage(store, defaultStaging(host, id));
				return {
					staging,
					fields: { staging, target: join(host.storeDir, "worktrees", "x"), store, createdTarget: true },
				};
			},
		],
		[
			"the store name has something in front of the hash",
			async (host, id) => {
				const store = await makeStore(join(host.storeDir, "repositories", `Z${HEX24}.git`));
				const staging = await stage(store, defaultStaging(host, id));
				return {
					staging,
					fields: { staging, target: join(host.storeDir, "worktrees", "x"), store, createdTarget: true },
				};
			},
		],
		[
			"the store name has something after .git",
			async (host, id) => {
				const store = await makeStore(join(host.storeDir, "repositories", `${HEX24}.git.old`));
				const staging = await stage(store, defaultStaging(host, id));
				return {
					staging,
					fields: { staging, target: join(host.storeDir, "worktrees", "x"), store, createdTarget: true },
				};
			},
		],
		[
			"the default staging name carries another record's id",
			async (host) => {
				const staging = await stage(host.store, defaultStaging(host, randomUUID()));
				return {
					staging,
					fields: {
						staging,
						target: join(host.storeDir, "worktrees", "x"),
						store: host.store,
						createdTarget: true,
					},
				};
			},
		],
		[
			"the default staging name is paired with a target outside the worktrees directory",
			async (host, id) => {
				const staging = await stage(host.store, defaultStaging(host, id));
				return {
					staging,
					fields: { staging, target: sandbox.path("user-checkout"), store: host.store, createdTarget: true },
				};
			},
		],
		[
			"the staging path has neither of the names a restore uses",
			async (host) => {
				const staging = await stage(host.store, sandbox.path("any-worktree-at-all"));
				return {
					staging,
					fields: {
						staging,
						target: join(host.storeDir, "worktrees", "x"),
						store: host.store,
						createdTarget: true,
					},
				};
			},
		],
		["the record is a JSON string", async () => ({ fields: "just text" })],
		["the record is a JSON number", async () => ({ fields: 7 })],
		["the record is JSON null", async () => ({ fields: null })],
		["the record is an empty array", async () => ({ fields: [] })],
		[
			"the record has no store",
			async (host, id) => {
				const staging = await stage(host.store, defaultStaging(host, id));
				return {
					staging,
					fields: { staging, target: join(host.storeDir, "worktrees", "x"), createdTarget: true },
				};
			},
		],
	];

	test.each(forgeries)("%s: the record is reported and nothing is removed", async (_name, forge) => {
		const host = await makeHost();
		const id = randomUUID();
		const { fields, staging } = await forge(host, id);
		const record = writeRecord(host, id, fields);

		assert.deepEqual(await sweep(host), [warning(record, "record")]);

		assert.equal(existsSync(record), true);
		if (staging !== undefined) assert.equal(existsSync(join(staging, ".git")), true);
	});

	test("a staging worktree that someone locked is still removed, since a restore's own staging is never kept locked", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const staging = await stage(host.store, defaultStaging(host, id));
		await sandbox.git(sandbox.root, "--git-dir", host.store, "worktree", "lock", staging);
		const record = writeRecord(host, id, {
			staging,
			target: join(host.storeDir, "worktrees", "locked"),
			store: host.store,
			createdTarget: true,
		});
		assert.deepEqual(await sweep(host), []);
		assert.equal(existsSync(staging), false);
		assert.equal((await registered(host.store)).includes(staging), false);
		assert.equal(existsSync(record), false);
	});
});

describe.skipIf(process.platform === "win32")(
	"a staging path is only removed when it is the registered worktree itself",
	() => {
		test("a staging path swapped for a symlink to a directory with a valid worktree link is retained, and that directory is untouched", async () => {
			const host = await makeHost();
			const id = randomUUID();
			const staging = await stage(host.store, defaultStaging(host, id));
			const victim = sandbox.path("victim");
			mkdirSync(victim);
			writeFileSync(join(victim, "keep.txt"), "user data\n");
			writeFileSync(join(victim, ".git"), readFileSync(join(staging, ".git")));
			rmSync(staging, { recursive: true });
			symlinkSync(victim, staging, "dir");
			const record = writeRecord(host, id, {
				staging,
				target: join(host.storeDir, "worktrees", "swapped"),
				store: host.store,
				createdTarget: true,
			});

			assert.deepEqual(await sweep(host), [warning(staging)]);

			assert.equal(readFileSync(join(victim, "keep.txt"), "utf8"), "user data\n");
			assert.equal(lstatSync(staging).isSymbolicLink(), true);
			assert.equal(existsSync(record), true);
		});

		test("a worktree that Git refuses to remove is retained with its files, not deleted behind Git's back", async () => {
			const host = await makeHost();
			const id = randomUUID();
			const staging = await stage(host.store, defaultStaging(host, id));
			writeFileSync(join(staging, ".git"), "gitdir: /nonexistent\n");
			writeFileSync(join(staging, "work.txt"), "unsaved work\n");
			const record = writeRecord(host, id, {
				staging,
				target: join(host.storeDir, "worktrees", "refused"),
				store: host.store,
				createdTarget: true,
			});

			assert.deepEqual(await sweep(host), [warning(staging)]);

			assert.equal(readFileSync(join(staging, "work.txt"), "utf8"), "unsaved work\n");
			assert.equal(existsSync(record), true);
		});
	},
);

/** Runs `action` with `process.platform` set to `platform`, the way a Windows host would see path comparisons. */
async function onPlatform<T>(platform: NodeJS.Platform, action: () => Promise<T>): Promise<T> {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...original, value: platform });
	try {
		return await action();
	} finally {
		Object.defineProperty(process, "platform", original);
	}
}

describe("comparing a staging path with the registered worktrees", () => {
	/** A record whose staging path is absent, while a worktree is registered under the same name in another case. */
	async function caseVariantFixture() {
		const host = await makeHost();
		const id = randomUUID();
		const target = sandbox.path("Chosen");
		const staging = siblingStaging(target, id);
		const lowerCase = join(dirname(staging), basename(staging).replace("Chosen", "chosen"));
		await stage(host.store, lowerCase);
		const record = writeRecord(host, id, { staging, target, store: host.store, createdTarget: true });
		return { host, staging, lowerCase, record };
	}

	test("on a case-sensitive platform a worktree under a differently cased name is another worktree", async () => {
		const { host, lowerCase, record } = await caseVariantFixture();
		assert.deepEqual(await sweep(host), []);
		assert.equal(existsSync(record), false);
		assert.equal(existsSync(lowerCase), true);
		assert.ok((await registered(host.store)).includes(lowerCase));
	});

	test("on Windows paths that differ only in case are one path, so the staging name still counts as registered", async () => {
		const { host, lowerCase, record, staging } = await caseVariantFixture();
		const warnings = await onPlatform("win32", () => sweep(host));
		assert.deepEqual(warnings, [warning(staging)]);
		assert.equal(existsSync(record), true);
		assert.equal(existsSync(lowerCase), true);
	});

	test("on Windows an interrupted restore is still swept by its exact registered path", async () => {
		const host = await makeHost();
		const id = randomUUID();
		const staging = await stage(host.store, defaultStaging(host, id));
		const record = writeRecord(host, id, {
			staging,
			target: join(host.storeDir, "worktrees", "final"),
			store: host.store,
			createdTarget: true,
		});

		assert.deepEqual(await onPlatform("win32", () => sweep(host)), []);

		assert.equal(existsSync(staging), false);
		assert.equal(existsSync(record), false);
	});
});

async function dirtyClone(): Promise<{ readonly snapshot: WorktreeSnapshot; readonly blobs: MemorySnapshotBlobStore }> {
	const { clone } = await sandbox.remoteWithClone("work");
	sandbox.write(join(clone, "dirty.txt"), "recorded\n");
	const blobs = new MemorySnapshotBlobStore();
	const captured = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(captured.status, "captured");
	if (captured.status !== "captured") throw new Error("capture failed");
	return { snapshot: captured.snapshot, blobs };
}

describe("publishing a restore", () => {
	test("restoring into an existing empty directory fills that directory and leaves no staging sibling or record", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host-restore");
		const into = sandbox.path("chosen-empty");
		mkdirSync(into);

		const restored = await restoreWorktree(snapshot, { blobs, storeDir, into });

		assert.equal(restored.path, into);
		assert.equal(readFileSync(join(into, "dirty.txt"), "utf8"), "recorded\n");
		assert.deepEqual(
			readdirSync(sandbox.root).filter((name) => name.includes("atomic-restore")),
			[],
		);
		assert.deepEqual(readdirSync(join(storeDir, "restores")), []);
	});

	test("removing a restored worktree that was locked still removes its directory", async () => {
		const { snapshot, blobs } = await dirtyClone();
		const storeDir = sandbox.path("host-locked");
		const restored = await restoreWorktree(snapshot, { blobs, storeDir });
		const store = join(storeDir, "repositories", readdirSync(join(storeDir, "repositories"))[0]!);
		await sandbox.git(sandbox.root, "--git-dir", store, "worktree", "lock", restored.path);

		await removeRestoredWorktree(restored.path, { storeDir });

		assert.equal(existsSync(restored.path), false);
	});
});
