import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import { getReleasedStageBlobDir, removeReleasedStageBlobs } from "../src/core/tools/tool-output-blobs.ts";

const roots: string[] = [];
afterEach(() => {
	while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

function agentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "released-blobs-"));
	roots.push(dir);
	return dir;
}

function withBlob(dir: string, sessionId: string): string {
	const blobDir = getReleasedStageBlobDir(dir, sessionId);
	mkdirSync(blobDir, { recursive: true });
	const file = join(blobDir, "result.txt");
	writeFileSync(file, "saved output");
	return file;
}

test("removing a session's blobs removes only that session's directory (#4326)", async () => {
	const dir = agentDir();
	const gone = withBlob(dir, "session-a");
	const kept = withBlob(dir, "session-b");
	await removeReleasedStageBlobs(dir, "session-a");
	assert.equal(existsSync(gone), false);
	assert.equal(existsSync(getReleasedStageBlobDir(dir, "session-a")), false);
	assert.equal(existsSync(kept), true);
});

test("a session that never had blobs is not an error, and nothing else is removed (#4326)", async () => {
	const dir = agentDir();
	const kept = withBlob(dir, "session-b");
	await assert.doesNotReject(removeReleasedStageBlobs(dir, "session-without-blobs"));
	await assert.doesNotReject(
		removeReleasedStageBlobs(agentDir(), "session-without-blobs"),
		"not even a blob root yet",
	);
	assert.equal(existsSync(kept), true);
});
