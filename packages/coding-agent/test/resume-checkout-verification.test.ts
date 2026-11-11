import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../../../test/helpers/temporary-agent-dir.js";
import { GitSandbox } from "../../../test/helpers/worktree-snapshot.js";
import { prepareSessionResume, sessionResumeOptions } from "../src/core/resume/session-resume.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { openNodeSqliteDatabase } from "../src/core/storage/node-sqlite.js";
import { SqlSessionStore } from "../src/core/storage/session/sql-session-store.js";
import { captureWorktreeSnapshot } from "../src/core/worktree-snapshot/capture.js";
import type { VerifyWorktreeOptions } from "../src/core/worktree-snapshot/restore.js";
import type { WorktreeSnapshot } from "../src/core/worktree-snapshot/types.js";

const verification = vi.hoisted(() => ({ calls: 0, inFlight: 0, maxInFlight: 0 }));

vi.mock("../src/core/worktree-snapshot/restore.ts", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/core/worktree-snapshot/restore.ts")>();
	return {
		...original,
		verifyWorktree: async (snapshot: WorktreeSnapshot, root: string, options?: VerifyWorktreeOptions) => {
			verification.calls++;
			verification.inFlight++;
			verification.maxInFlight = Math.max(verification.maxInFlight, verification.inFlight);
			try {
				await new Promise((resolve) => setTimeout(resolve, 25));
				return await original.verifyWorktree(snapshot, root, options);
			} finally {
				verification.inFlight--;
			}
		},
	};
});

useTemporaryAgentDir();

let sandbox: GitSandbox;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
	sandbox = new GitSandbox();
	verification.calls = 0;
	verification.inFlight = 0;
	verification.maxInFlight = 0;
});
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	sandbox.dispose();
});

/** A session that recorded snapshots of a project and `siblings` worktrees of it, all still as recorded. */
async function sessionWithCheckouts(siblings: number): Promise<{ manager: SessionManager; project: string }> {
	const { clone: project } = await sandbox.remoteWithClone("repo", { "README.md": "hello\n" });
	const roots = [project];
	for (let index = 0; index < siblings; index++) {
		const worktree = sandbox.path(`sibling-${index}`);
		await sandbox.git(project, "worktree", "add", "-q", "-b", `sibling-${index}`, worktree);
		sandbox.write(`${worktree}/work.txt`, `work ${index}\n`);
		roots.push(worktree);
	}
	const database = await openNodeSqliteDatabase(sandbox.path("sessions.sqlite"));
	const store = await SqlSessionStore.open(database);
	cleanups.push(async () => {
		await store.close();
		await database.close();
	});
	const manager = await SessionManager.create(store, project);
	await manager.appendMessage({ role: "user", content: "work", timestamp: Date.now() });
	for (const root of roots) {
		const capture = await captureWorktreeSnapshot(root, { blobs: store.snapshotBlobs });
		if (capture.status !== "captured") throw new Error(capture.status);
		await manager.appendWorktreeSnapshot(root, capture.snapshot.id, capture.snapshot);
	}
	return { manager, project };
}

test("a resume compares each recorded checkout with its snapshot once, several at a time (#4660)", async () => {
	const { manager, project } = await sessionWithCheckouts(3);
	const options = sessionResumeOptions("cli", project, sandbox.path("agent"), SettingsManager.inMemory(), () => true);

	const prepared = await prepareSessionResume(manager, { ...options, blueprints: "skip" });

	assert.equal(prepared.status === "ready" && prepared.sessionManager.getCwd(), project);
	assert.equal(verification.calls, 4);
	assert.ok(verification.maxInFlight > 1, `at most ${verification.maxInFlight} at once`);
});
