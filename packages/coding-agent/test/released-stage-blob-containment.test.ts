/**
 * Defense in depth under the session id check (#4326): removeReleasedStageBlobs removes only a direct child of
 * `<agentDir>/blobs/tool-output`, even for an id the id check would have let through. The id check is switched off
 * here so that the containment check is the only thing that can refuse.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test, vi } from "vitest";
import { SessionIdError } from "../src/core/session-manager-errors.ts";
import { TOOL_RESULT_BLOBS_SUBDIR } from "../src/core/tools/tool-limits.ts";
import { getReleasedStageBlobDir, removeReleasedStageBlobs } from "../src/core/tools/tool-output-blobs.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, rm: vi.fn(actual.rm) };
});
vi.mock("../src/core/session-manager-validation.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/session-manager-validation.ts")>();
	return { ...actual, assertValidSessionId: () => {} };
});

const removals = vi.mocked(fsPromises.rm);
const directories: string[] = [];
afterEach(() => {
	removals.mockClear();
	while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function agentDirectory(): { readonly agentDir: string; readonly root: string; readonly kept: readonly string[] } {
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-blob-containment-"));
	directories.push(agentDir);
	const root = join(agentDir, TOOL_RESULT_BLOBS_SUBDIR);
	const sentinel = join(agentDir, "auth.json");
	writeFileSync(sentinel, "{}");
	const sibling = join(agentDir, "blobs", "sibling");
	mkdirSync(sibling, { recursive: true });
	const nested = join(root, "a", "b");
	mkdirSync(nested, { recursive: true });
	mkdirSync(getReleasedStageBlobDir(agentDir, "other-session"), { recursive: true });
	return {
		agentDir,
		root,
		kept: [sentinel, sibling, nested, root, getReleasedStageBlobDir(agentDir, "other-session")],
	};
}

const OUTSIDE_IDS: ReadonlyArray<readonly [string, string]> = [
	["the blob root itself", "."],
	["the blob root's parent", ".."],
	["a sibling of the blob root", "../sibling"],
	["a directory two levels below the root", "a/b"],
];

describe("with the id check bypassed, a directory that is not a direct child of the blob root is refused (#4309)", () => {
	for (const [description, id] of OUTSIDE_IDS) {
		test(`${description} is refused with a SessionIdError and nothing is removed`, async () => {
			const { agentDir, kept } = agentDirectory();

			await assert.rejects(removeReleasedStageBlobs(agentDir, id), (error: Error) => {
				assert.ok(error instanceof SessionIdError);
				assert.equal(error.sessionId, id);
				return true;
			});

			assert.equal(removals.mock.calls.length, 0, "no directory removal was attempted");
			for (const path of kept) assert.equal(existsSync(path), true, `${path} is kept`);
		});
	}

	test("a direct child of the blob root is still removed", async () => {
		const { agentDir, root } = agentDirectory();
		mkdirSync(getReleasedStageBlobDir(agentDir, "stage-session"), { recursive: true });

		await removeReleasedStageBlobs(agentDir, "stage-session");

		assert.equal(removals.mock.calls.length, 1);
		assert.equal(existsSync(getReleasedStageBlobDir(agentDir, "stage-session")), false);
		assert.equal(existsSync(getReleasedStageBlobDir(agentDir, "other-session")), true);
		assert.equal(existsSync(root), true);
	});
});
