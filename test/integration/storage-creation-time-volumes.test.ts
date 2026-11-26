/**
 * File identities on macOS volumes other than APFS (#4319). APFS and HFS+ move a file's creation time back when its
 * modified time is set earlier, and never reuse an inode number, so there a file's identity leaves the creation time
 * out. FAT keeps creation times and hands a deleted file's inode number to the next new file, so there the identity
 * keeps the creation time, and a new database is not taken for a deleted one whose inode number it got.
 */

import assert from "node:assert/strict";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { resetStorageHomeCacheForTests } from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { makeTempDirectory, removeTempDirectory, sleep, spawnSyncCollect } from "../helpers/runtime.js";

/** Structural cost: making, attaching and detaching a disk image takes seconds. */
const VOLUME_TEST_TIMEOUT_MS = 120_000;
/** FAT keeps creation times to two seconds: a file made this much later has a later one. */
const FAT_CREATION_TIME_STEP_MS = 2_100;

beforeEach(() => {
	resetStorageHomeCacheForTests();
	for (const name of [
		"ATOMIC_STORAGE",
		"ATOMIC_SESSIONS_STORAGE",
		"ATOMIC_WORKFLOWS_JOURNAL",
		"ATOMIC_CODING_AGENT_SESSION_DIR",
		"ATOMIC_WORKFLOW_JOURNAL_PATH",
		"ATOMIC_PROFILE",
	])
		vi.stubEnv(name, "");
});

afterEach(() => {
	vi.unstubAllEnvs();
});

function hdiutil(...args: string[]): void {
	const result = spawnSyncCollect(["hdiutil", ...args], { timeout: VOLUME_TEST_TIMEOUT_MS });
	assert.equal(result.exitCode, 0, `hdiutil ${args.join(" ")}: ${result.stderr.toString()}`);
}

async function withFatVolume(body: (volume: string) => Promise<void>): Promise<void> {
	const scratch = makeTempDirectory("storage-fat-");
	const image = join(scratch, "volume.dmg");
	const volume = join(scratch, "volume");
	try {
		hdiutil("create", "-quiet", "-fs", "MS-DOS", "-size", "20m", "-volname", "STORAGE", image);
		hdiutil("attach", "-quiet", "-nobrowse", "-mountpoint", volume, image);
		try {
			await body(volume);
		} finally {
			hdiutil("detach", "-quiet", "-force", volume);
		}
	} finally {
		removeTempDirectory(scratch);
	}
}

test.skipIf(process.platform !== "darwin")(
	"on a FAT volume, a new database that got a deleted one's inode number is not the deleted one's owner's (#4319)",
	async () => {
		await withFatVolume(async (volume) => {
			const first = join(volume, "a1");
			const second = join(volume, "a2");
			for (const agent of [first, second]) mkdirSync(agent);
			const select = (agent: string, path: string) =>
				selectSessionStorage(volume, { agentDir: agent, settings: { sessions: { storage: { path } } } });
			writeFileSync(join(volume, "first.sqlite"), "first history");
			assert.deepEqual(select(first, "first.sqlite"), { kind: "sqlite", path: join(volume, "first.sqlite") });
			const { ino } = statSync(join(volume, "first.sqlite"), { bigint: true });
			rmSync(join(volume, "first.sqlite"));
			await sleep(FAT_CREATION_TIME_STEP_MS);
			writeFileSync(join(volume, "second.sqlite"), "second history");
			assert.equal(
				statSync(join(volume, "second.sqlite"), { bigint: true }).ino,
				ino,
				"FAT reused the inode number",
			);
			resetStorageHomeCacheForTests();
			assert.deepEqual(select(second, "second.sqlite"), { kind: "sqlite", path: join(volume, "second.sqlite") });
		});
	},
	VOLUME_TEST_TIMEOUT_MS,
);
