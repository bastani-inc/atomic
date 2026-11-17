import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { MemorySnapshotBlobStore } from "../src/core/worktree-snapshot/blob-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import {
	pooledWorktreeHolder,
	pooledWorktreePath,
	repositoryIdOf,
	type SlotNumber,
} from "../src/core/worktree-snapshot/pool.js";
import {
	adoptPrebuiltSeed,
	readSeedManifest,
	type SeedManifest,
	seedDirectory,
	seedManifestPath,
	withSeedLock,
	writeSeedManifest,
} from "../src/core/worktree-snapshot/seeds.js";
import { DEFAULT_WORKTREE_SNAPSHOT_SETTINGS } from "../src/core/worktree-snapshot/settings.js";

const boundary = vi.hoisted(() => ({
	afterRemove: undefined as ((path: string) => Promise<void>) | undefined,
	onCompromised: undefined as ((path: string) => void) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const rm: typeof actual.rm = async (path, options) => {
		await actual.rm(path, options);
		await boundary.afterRemove?.(String(path));
	};
	return { ...actual, rm };
});

vi.mock("../src/core/worktree-snapshot/shared-clock.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/worktree-snapshot/shared-clock.js")>();
	const lockShared: typeof actual.lockShared = (path, options) =>
		actual.lockShared(path, {
			...options,
			onCompromised: (error) => {
				options.onCompromised?.(error);
				boundary.onCompromised?.(path);
			},
		});
	return { ...actual, lockShared };
});

useTemporaryAgentDir();
let sandbox: GitSandbox;

beforeEach(() => {
	sandbox = new GitSandbox();
});

afterEach(() => {
	boundary.afterRemove = undefined;
	boundary.onCompromised = undefined;
	vi.restoreAllMocks();
	sandbox.dispose();
});

test("withSeedLock rejects observed compromise even when its action returns successfully (#5320)", async () => {
	const storeDir = sandbox.path("store");
	const repository = repositoryIdOf(["https://example.com/acme/repo.git"]);
	const manifestFile = seedManifestPath(storeDir, repository);
	const compromised = new Promise<void>((resolve) => {
		boundary.onCompromised = (path) => {
			if (path === manifestFile) resolve();
		};
	});
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((
		fn: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => realSetTimeout(fn, typeof ms === "number" && ms >= 1_000 ? 40 : ms, ...args)) as typeof setTimeout);
	let finished = false;
	await assert.rejects(
		withSeedLock(storeDir, repository, false, async () => {
			await rm(`${manifestFile}.lock`, { recursive: true, force: true });
			await compromised;
			finished = true;
			return "finished";
		}),
		{ code: "ECOMPROMISED" },
	);
	assert.equal(finished, true);
});

test("adoption that loses its seed lock leaves a replacement generation untouched (#5320)", async () => {
	const { clone } = await sandbox.remoteWithClone("repo", { ".gitignore": "build/\n", "README.md": "first\n" });
	const captured = await captureWorktreeSnapshot(clone, {
		settings: DEFAULT_WORKTREE_SNAPSHOT_SETTINGS,
		blobs: new MemorySnapshotBlobStore(),
	});
	if (captured.status !== "captured") throw new Error(captured.status);
	const snapshot = captured.snapshot;
	const storeDir = sandbox.path("store");
	const repository = repositoryIdOf(snapshot.remotes);
	const slot = pooledWorktreePath(storeDir, repository, 0 as SlotNumber);
	const seeds = seedDirectory(storeDir, repository);
	const manifestFile = seedManifestPath(storeDir, repository);
	const manifest: SeedManifest = {
		version: 1,
		repository,
		head: snapshot.head,
		tree: snapshot.tree,
		envHash: snapshot.envHash,
		paths: ["build"],
		worktree: slot,
		parkedAt: "2026-01-01T00:00:00.000Z",
	};
	await mkdir(join(seeds, "build"), { recursive: true });
	await writeFile(join(seeds, "build", "out.txt"), "first generation\n");
	await writeSeedManifest(storeDir, manifest);

	sandbox.write(join(clone, "README.md"), "second\n");
	const replacementHead = await sandbox.commitAll(clone, "second generation");
	await sandbox.git(clone, "push", "-q", "origin", "HEAD:main");
	const replacement: SeedManifest = {
		...manifest,
		head: replacementHead,
		tree: await sandbox.git(clone, "rev-parse", "HEAD^{tree}"),
		parkedAt: "2026-01-02T00:00:00.000Z",
	};
	const compromised = new Promise<void>((resolve) => {
		boundary.onCompromised = (path) => {
			if (path === manifestFile) resolve();
		};
	});
	const realSetTimeout = globalThis.setTimeout;
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((
		fn: (...args: unknown[]) => void,
		ms?: number,
		...args: unknown[]
	) => realSetTimeout(fn, typeof ms === "number" && ms >= 1_000 ? 40 : ms, ...args)) as typeof setTimeout);
	let replaced = false;
	boundary.afterRemove = async (path) => {
		if (!path.startsWith(join(storeDir, "restores")) || !path.endsWith(".json") || replaced) return;
		replaced = true;
		await rm(`${manifestFile}.lock`, { recursive: true, force: true });
		await compromised;
		await withSeedLock(storeDir, repository, true, async () => {
			await rm(seeds, { recursive: true, force: true });
			await mkdir(join(seeds, "build"), { recursive: true });
			await writeFile(join(seeds, "build", "out.txt"), "second generation\n");
			await writeSeedManifest(storeDir, replacement);
		});
	};

	const result = await adoptPrebuiltSeed(snapshot, { storeDir });
	assert.equal(replaced, true, JSON.stringify(result));
	assert.deepEqual(result, { adopted: false, reason: "unavailable" });
	assert.deepEqual(await readSeedManifest(storeDir, repository), replacement);
	assert.equal(readFileSync(join(seeds, "build", "out.txt"), "utf8"), "second generation\n");
	assert.equal(existsSync(join(slot, "build", "out.txt")), false);
	assert.deepEqual(await pooledWorktreeHolder(storeDir, slot), {
		owner: { kind: "prebuild", id: "seed" },
		held: false,
	});
});
