import assert from "node:assert/strict";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "vitest";
import {
	captureWorktreeSnapshot,
	MemorySnapshotBlobStore,
	setWorktreeSnapshotGit,
	type WorktreeSnapshot,
} from "../../packages/coding-agent/src/core/worktree-snapshot/index.ts";
import { GitSandbox } from "../helpers/worktree-snapshot.js";

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => sandbox.dispose());

/**
 * Routes snapshot Git through a wrapper that, on the bundle step, runs `before-bundle.sh` once just before it and
 * `after-bundle.sh <bundle file>` once just after it, when those scripts exist.
 */
function interceptBundleStep(): { before: (script: string) => void; after: (script: string) => void } {
	const wrapper = sandbox.path("git-bundle-window");
	const before = sandbox.path("before-bundle.sh");
	const after = sandbox.path("after-bundle.sh");
	writeFileSync(
		wrapper,
		[
			"#!/bin/sh",
			'case " $* " in',
			'*" bundle create "*)',
			`  if [ -f "${before}" ]; then mv "${before}" "${before}.ran"; sh "${before}.ran" || exit 90; fi`,
			'  git "$@" || exit $?',
			`  if [ -f "${after}" ]; then`,
			"    file=; next=",
			'    for arg; do if [ -n "$next" ]; then file=$arg; next=; fi; [ "$arg" = -q ] && next=1; done',
			`    mv "${after}" "${after}.ran"; sh "${after}.ran" "$file" || exit 91`,
			"  fi",
			"  exit 0;;",
			"esac",
			'exec git "$@"',
			"",
		].join("\n"),
	);
	chmodSync(wrapper, 0o755);
	setWorktreeSnapshotGit(async () => ({ ...sandbox.executable, path: wrapper }));
	return {
		before: (script) => writeFileSync(before, `set -e\n${script}\n`),
		after: (script) => writeFileSync(after, `set -e\n${script}\n`),
	};
}

async function capturedWith(clone: string, blobs: MemorySnapshotBlobStore): Promise<WorktreeSnapshot> {
	const result = await captureWorktreeSnapshot(clone, { blobs });
	assert.equal(result.status, "captured");
	return (result as { snapshot: WorktreeSnapshot }).snapshot;
}

/** The heads of the stored bundle, and every commit a repository holding only the remote and the bundle has. */
async function storedBundle(
	snapshot: WorktreeSnapshot,
	blobs: MemorySnapshotBlobStore,
	remote: string,
): Promise<{ heads: string; commits: string[] }> {
	assert.notEqual(snapshot.bundle, null);
	const file = sandbox.path("stored.bundle");
	writeFileSync(file, (await blobs.getBlob(snapshot.bundle!.blob))!);
	const probe = sandbox.path("probe.git");
	await sandbox.git(sandbox.root, "init", "-q", "--bare", probe);
	await sandbox.git(probe, "fetch", "-q", remote, "main:refs/remotes/origin/main");
	await sandbox.git(probe, "fetch", "-q", file, "HEAD:refs/heads/restored");
	return {
		heads: await sandbox.git(probe, "bundle", "list-heads", file),
		commits: (await sandbox.git(probe, "rev-list", "--all")).split("\n").filter(Boolean),
	};
}

describe.skipIf(process.platform === "win32")("the bundle holds exactly the checked commit (#4900)", () => {
	test("a commit adding a denied .env that lands just before the bundle step is never bundled (#4900)", async () => {
		const { clone, remote } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "work.txt"), "work\n");
		const checked = await sandbox.commitAll(clone, "work");
		const window = interceptBundleStep();
		window.before(`cd "${clone}"\nprintf 'SECRET-ENV-BYTES\\n' > .env\ngit add -f .env\ngit commit -q -m "add .env"`);
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capturedWith(clone, blobs);

		const sneaked = await sandbox.git(clone, "rev-parse", "HEAD");
		assert.notEqual(sneaked, checked, "the commit landed in the window");
		assert.equal(snapshot.head, checked);
		assert.deepEqual(snapshot.bundle?.commits, [checked]);
		const bundle = await storedBundle(snapshot, blobs, remote);
		assert.equal(bundle.heads, `${checked} HEAD`);
		assert.ok(bundle.commits.includes(checked));
		assert.ok(!bundle.commits.includes(sneaked), "the unchecked .env commit is not in the stored bundle");
	});

	test("HEAD moved to an unrelated branch in the window still bundles the recorded commit (#4900)", async () => {
		const { clone, remote } = await sandbox.remoteWithClone();
		await sandbox.git(clone, "checkout", "-q", "--orphan", "unrelated");
		await sandbox.git(clone, "rm", "-rqf", "--cached", ".");
		sandbox.write(join(clone, "other.txt"), "other\n");
		await sandbox.git(clone, "add", "other.txt");
		await sandbox.git(clone, "commit", "-q", "-m", "unrelated root");
		const unrelated = await sandbox.git(clone, "rev-parse", "HEAD");
		await sandbox.git(clone, "checkout", "-q", "-f", "main");
		await sandbox.git(clone, "clean", "-qfd");
		sandbox.write(join(clone, "work.txt"), "work\n");
		const checked = await sandbox.commitAll(clone, "work");
		interceptBundleStep().before(`git -C "${clone}" symbolic-ref HEAD refs/heads/unrelated`);
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capturedWith(clone, blobs);

		assert.equal(await sandbox.git(clone, "rev-parse", "HEAD"), unrelated, "HEAD moved in the window");
		assert.equal(snapshot.head, checked);
		assert.deepEqual(snapshot.bundle?.commits, [checked]);
		const bundle = await storedBundle(snapshot, blobs, remote);
		assert.equal(bundle.heads, `${checked} HEAD`);
		assert.ok(!bundle.commits.includes(unrelated));
	});

	test("an undisturbed capture bundles HEAD's unpushed commits and leaves no ref behind (#4900)", async () => {
		const { clone, remote } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "one.txt"), "one\n");
		const first = await sandbox.commitAll(clone, "one");
		sandbox.write(join(clone, "two.txt"), "two\n");
		const second = await sandbox.commitAll(clone, "two");
		const refsBefore = await sandbox.git(clone, "for-each-ref");
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capturedWith(clone, blobs);

		assert.equal(snapshot.head, second);
		assert.deepEqual(snapshot.bundle?.commits, [second, first]);
		assert.deepEqual(snapshot.omitted, []);
		const bundle = await storedBundle(snapshot, blobs, remote);
		assert.equal(bundle.heads, `${second} HEAD`);
		assert.ok(bundle.commits.includes(first) && bundle.commits.includes(second));
		assert.equal(await sandbox.git(clone, "for-each-ref"), refsBefore);
	});

	test("a bundle whose tip is not the recorded commit is discarded and the capture still records (#4900)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		await sandbox.git(clone, "branch", "-q", "elsewhere");
		sandbox.write(join(clone, "elsewhere.txt"), "elsewhere\n");
		await sandbox.git(clone, "checkout", "-q", "elsewhere");
		await sandbox.commitAll(clone, "elsewhere");
		await sandbox.git(clone, "checkout", "-q", "main");
		sandbox.write(join(clone, "work.txt"), "work\n");
		const checked = await sandbox.commitAll(clone, "work");
		interceptBundleStep().after(
			`rm -f "$1"\ngit -C "${clone}" bundle create -q "$1" refs/heads/elsewhere --not refs/remotes/origin/main`,
		);
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capturedWith(clone, blobs);

		assert.ok(existsSync(sandbox.path("after-bundle.sh.ran")), "the bundle was replaced");
		assert.equal(snapshot.head, checked);
		assert.equal(snapshot.bundle, null);
		assert.deepEqual(snapshot.omitted, []);
		assert.equal((await blobs.listBlobHashes()).length, 0, "no bundle was stored");
		assert.equal(await sandbox.git(clone, "for-each-ref", "refs/atomic"), "");
	});

	test("a bundle at the recorded tip that holds other commits than were checked is discarded (#4900)", async () => {
		const { clone } = await sandbox.remoteWithClone();
		sandbox.write(join(clone, "one.txt"), "one\n");
		await sandbox.commitAll(clone, "one");
		sandbox.write(join(clone, "two.txt"), "two\n");
		const checked = await sandbox.commitAll(clone, "two");
		interceptBundleStep().after(`rm -f "$1"\ngit -C "${clone}" bundle create -q "$1" main --not main~1`);
		const blobs = new MemorySnapshotBlobStore();

		const snapshot = await capturedWith(clone, blobs);

		assert.ok(existsSync(sandbox.path("after-bundle.sh.ran")), "the bundle was replaced");
		assert.equal(snapshot.head, checked);
		assert.equal(snapshot.bundle, null);
		assert.equal((await blobs.listBlobHashes()).length, 0, "no bundle was stored");
	});
});
