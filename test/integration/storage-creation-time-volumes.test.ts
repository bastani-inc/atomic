/**
 * File identities on macOS volumes other than APFS (#4319). APFS and HFS+ move a file's creation time back when its
 * modified time is set earlier, and never reuse an inode number, so there a file's identity leaves the creation time
 * out. FAT keeps creation times and can hand a deleted file's inode number to the next new file, so there the identity
 * keeps the creation time. The identity names a database's claim file, which other agent directories look up.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { selectSessionStorage } from "../../packages/coding-agent/src/core/session-storage.js";
import { resetStorageHomeCacheForTests } from "../../packages/coding-agent/src/core/storage/file-identity.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

/** Structural cost: making, attaching and detaching a disk image takes seconds. */
const VOLUME_TEST_TIMEOUT_MS = 120_000;

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

/** Which of a database's two possible file claims an agent directory's selection made: with or without its creation time. */
function fileClaim(root: string, agent: string): { readonly withCreationTime: boolean; readonly without: boolean } {
	writeFileSync(join(root, "history.sqlite"), "history");
	assert.deepEqual(
		selectSessionStorage(root, { agentDir: agent, settings: { sessions: { storage: { path: "history.sqlite" } } } }),
		{ kind: "sqlite", path: join(root, "history.sqlite") },
	);
	const stats = statSync(join(root, "history.sqlite"), { bigint: true });
	const claim = (identity: string) =>
		existsSync(join(root, `.atomic-storage-target-${createHash("sha256").update(`file:${identity}`).digest("hex")}`));
	return {
		withCreationTime: claim(`${stats.dev}:${stats.ino}:${stats.birthtimeNs}`),
		without: claim(`${stats.dev}:${stats.ino}`),
	};
}

test.skipIf(process.platform !== "darwin")(
	"a database's identity keeps its creation time on a FAT volume and leaves it out on APFS (#4319)",
	async () => {
		await withFatVolume(async (volume) => {
			mkdirSync(join(volume, "agent"));
			assert.deepEqual(fileClaim(volume, join(volume, "agent")), { withCreationTime: true, without: false });
		});
		const apfs = makeTempDirectory("storage-apfs-");
		try {
			mkdirSync(join(apfs, "agent"));
			resetStorageHomeCacheForTests();
			assert.deepEqual(fileClaim(apfs, join(apfs, "agent")), { withCreationTime: false, without: true });
		} finally {
			removeTempDirectory(apfs);
		}
	},
	VOLUME_TEST_TIMEOUT_MS,
);
