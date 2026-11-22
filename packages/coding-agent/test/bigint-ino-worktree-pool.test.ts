import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type * as nodeFs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";

const COLLIDING_INO_A = 0x00f9_0000_0003_9deen;
const COLLIDING_INO_B = 0x00f9_0000_0003_9defn;
const SAFE_INO_A = 123_456n;
const SAFE_INO_B = 789_012n;
const DEV = 42n;
const BIRTHTIME_NS = 1_795_343_551_522_500_700n;
const BIRTHTIME_MS_TRUNC = Math.trunc(
	Number(BIRTHTIME_NS / 1_000_000_000n) * 1000 + Number(BIRTHTIME_NS % 1_000_000_000n) / 1_000_000,
);

interface FakeStatOverride {
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}

const fakeStats = vi.hoisted(() => ({
	overrides: new Map<string, FakeStatOverride>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	const stat = (async (path: nodeFs.PathLike, options?: { bigint?: boolean }) => {
		const result = await actual.stat(path, options as never);
		const override = fakeStats.overrides.get(resolve(String(path)));
		if (override === undefined) return result;
		const birthtimeMs =
			Number(override.birthtimeNs / 1_000_000_000n) * 1000 +
			Number(override.birthtimeNs % 1_000_000_000n) / 1_000_000;
		if (options?.bigint === true) {
			return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
				dev: override.dev,
				ino: override.ino,
				birthtimeNs: override.birthtimeNs,
				birthtimeMs: override.birthtimeNs / 1_000_000n,
			});
		}
		return Object.assign(Object.create(Object.getPrototypeOf(result)), result, {
			dev: Number(override.dev),
			ino: Number(override.ino),
			birthtimeMs,
		});
	}) as typeof actual.stat;
	return {
		...actual,
		default: { ...actual, stat },
		stat,
	};
});

const { setAsideWorktree, worktreeSetAside } = await import("../src/core/worktree-snapshot/pool.js");

function setAsideNoteFile(storeDir: string, worktreePath: string): string {
	const key = createHash("sha256").update(resolve(worktreePath)).digest("hex").slice(0, 16);
	return join(resolve(storeDir), "pool", "set-aside", `${key}.json`);
}

let rootDir: string;
let storeDir: string;
let worktreeDir: string;

beforeEach(() => {
	rootDir = realpathSync(mkdtempSync(join(tmpdir(), "atomic-bigint-pool-")));
	storeDir = join(rootDir, "store");
	worktreeDir = join(rootDir, "wt-slot-0");
	mkdirSync(storeDir, { recursive: true });
	mkdirSync(worktreeDir, { recursive: true });
	fakeStats.overrides.clear();
});

afterEach(() => {
	fakeStats.overrides.clear();
	rmSync(rootDir, { recursive: true, force: true });
});

describe("64-bit BigInt directory identity in worktree-snapshot/pool", () => {
	test("setAsideWorktree + worktreeSetAside distinguish a replaced directory whose 64-bit inode collides as Number", async () => {
		assert.equal(Number(COLLIDING_INO_A), Number(COLLIDING_INO_B));

		fakeStats.overrides.set(resolve(worktreeDir), {
			dev: DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: BIRTHTIME_NS,
		});
		await setAsideWorktree(storeDir, worktreeDir, { startedAt: "2026-11-22T00:00:00.000Z", logs: "logs" });
		assert.equal(await worktreeSetAside(storeDir, worktreeDir), true, "the set-aside directory itself matches");

		// Replace the worktree directory with a fresh one whose 64-bit inode collides as Number.
		fakeStats.overrides.set(resolve(worktreeDir), {
			dev: DEV,
			ino: COLLIDING_INO_B,
			birthtimeNs: BIRTHTIME_NS,
		});
		assert.equal(
			await worktreeSetAside(storeDir, worktreeDir),
			false,
			"a fresh replacement directory with a colliding 64-bit inode must not be treated as set aside",
		);

		// Persist both exact decimal-string identity and legacy directory string for older readers.
		const persisted = JSON.parse(readFileSync(setAsideNoteFile(storeDir, worktreeDir), "utf8")) as {
			directory?: string;
			directoryIdentity?: { dev: string; ino: string; birthtimeNs: string };
		};
		assert.deepEqual(persisted.directoryIdentity, {
			dev: String(DEV),
			ino: String(COLLIDING_INO_A),
			birthtimeNs: String(BIRTHTIME_NS),
		});
		assert.equal(
			persisted.directory,
			`${Number(DEV)}:${Number(COLLIDING_INO_A)}:${BIRTHTIME_MS_TRUNC}`,
			"older readers still recognize the set-aside directory through the legacy field",
		);
	});

	test("mixed-version compatibility: legacy set-aside notes without directoryIdentity are read safely and conservatively", async () => {
		const notePath = setAsideNoteFile(storeDir, worktreeDir);
		mkdirSync(join(storeDir, "pool", "set-aside"), { recursive: true });

		// 1. Legacy note for a safe inode (< 2^53)
		writeFileSync(
			notePath,
			JSON.stringify({
				path: resolve(worktreeDir),
				directory: `${DEV}:${SAFE_INO_A}:${BIRTHTIME_MS_TRUNC}`,
				startedAt: "2026-11-22T00:00:00.000Z",
				logs: "logs",
			}),
		);
		fakeStats.overrides.set(resolve(worktreeDir), {
			dev: DEV,
			ino: SAFE_INO_A,
			birthtimeNs: BIRTHTIME_NS,
		});
		assert.equal(await worktreeSetAside(storeDir, worktreeDir), true, "same directory matches legacy note");

		fakeStats.overrides.set(resolve(worktreeDir), {
			dev: DEV,
			ino: SAFE_INO_B,
			birthtimeNs: BIRTHTIME_NS,
		});
		assert.equal(
			await worktreeSetAside(storeDir, worktreeDir),
			false,
			"different non-colliding directory clears legacy note",
		);

		// 2. Legacy note for a 64-bit inode (> 2^53) whose Number(ino) collides: ambiguous -> conservative true.
		writeFileSync(
			notePath,
			JSON.stringify({
				path: resolve(worktreeDir),
				directory: `${Number(DEV)}:${Number(COLLIDING_INO_A)}:${BIRTHTIME_MS_TRUNC}`,
				startedAt: "2026-11-22T00:00:00.000Z",
				logs: "logs",
			}),
		);
		fakeStats.overrides.set(resolve(worktreeDir), {
			dev: DEV,
			ino: COLLIDING_INO_B,
			birthtimeNs: BIRTHTIME_NS,
		});
		assert.equal(
			await worktreeSetAside(storeDir, worktreeDir),
			true,
			"colliding legacy Number(ino) note is ambiguous and must stay conservative",
		);

		// 3. Unrecognized/malformed legacy directory format -> conservative true.
		writeFileSync(
			notePath,
			JSON.stringify({
				path: resolve(worktreeDir),
				directory: "unrecognized-format",
				startedAt: "2026-11-22T00:00:00.000Z",
				logs: "logs",
			}),
		);
		assert.equal(await worktreeSetAside(storeDir, worktreeDir), true);

		// 4. Deleted directory with valid legacy note -> false.
		writeFileSync(
			notePath,
			JSON.stringify({
				path: resolve(worktreeDir),
				directory: `${Number(DEV)}:${Number(COLLIDING_INO_A)}:${BIRTHTIME_MS_TRUNC}`,
				startedAt: "2026-11-22T00:00:00.000Z",
				logs: "logs",
			}),
		);
		rmSync(worktreeDir, { recursive: true, force: true });
		assert.equal(await worktreeSetAside(storeDir, worktreeDir), false);
	});

	test("cold disk reads honor exact directoryIdentity and stay conservative on malformed directoryIdentity", async () => {
		// Use a fresh worktree path never inserted into the in-memory setAsideHere map.
		const coldWorktree = join(rootDir, "wt-cold-slot");
		mkdirSync(coldWorktree, { recursive: true });
		const notePath = setAsideNoteFile(storeDir, coldWorktree);
		mkdirSync(join(storeDir, "pool", "set-aside"), { recursive: true });

		writeFileSync(
			notePath,
			JSON.stringify({
				path: resolve(coldWorktree),
				directory: `${Number(DEV)}:${Number(COLLIDING_INO_A)}:${BIRTHTIME_MS_TRUNC}`,
				directoryIdentity: {
					dev: String(DEV),
					ino: String(COLLIDING_INO_A),
					birthtimeNs: String(BIRTHTIME_NS),
				},
				startedAt: "2026-11-22T00:00:00.000Z",
				logs: "logs",
			}),
		);

		fakeStats.overrides.set(resolve(coldWorktree), {
			dev: DEV,
			ino: COLLIDING_INO_A,
			birthtimeNs: BIRTHTIME_NS,
		});
		assert.equal(await worktreeSetAside(storeDir, coldWorktree), true);

		fakeStats.overrides.set(resolve(coldWorktree), {
			dev: DEV,
			ino: COLLIDING_INO_B,
			birthtimeNs: BIRTHTIME_NS,
		});
		assert.equal(await worktreeSetAside(storeDir, coldWorktree), false);

		// Malformed directoryIdentity -> conservative true.
		writeFileSync(
			notePath,
			JSON.stringify({
				path: resolve(coldWorktree),
				directory: `${Number(DEV)}:${Number(COLLIDING_INO_A)}:${BIRTHTIME_MS_TRUNC}`,
				directoryIdentity: { dev: String(DEV), ino: "not-digits", birthtimeNs: String(BIRTHTIME_NS) },
				startedAt: "2026-11-22T00:00:00.000Z",
				logs: "logs",
			}),
		);
		assert.equal(await worktreeSetAside(storeDir, coldWorktree), true);
	});
});
