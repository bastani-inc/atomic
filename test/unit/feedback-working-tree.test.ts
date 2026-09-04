import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext as Ctx } from "@bastani/atomic";
import { afterAll, test } from "vitest";
import { SessionManager as SM } from "../../packages/coding-agent/src/core/session-manager.ts";
import { collectFeedbackDiagnostics as collect } from "../../packages/feedback/src/diagnostics.ts";

const root = mkdtempSync(join(tmpdir(), "feedback-working-tree-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("captures bounded path-only worktree changes before and after", async () => {
	const ctx = { cwd: root, mode: "print", model: undefined, sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	let status = `RM old -> renamed.txt\n${Array.from({ length: 110 }, (_, i) => `?? path-${String(i).padStart(3, "0")}`).join("\n")}`;
	const exec = async () => ({ code: 0, stdout: status });
	const runtime = { ctx, loadedExtensions: [], exec };
	const before = await collect({ report: "bug", phase: "before" }, runtime);
	assert.deepEqual([before.worktree.paths.length, before.worktree.paths[0]], [100, "renamed.txt"]);
	status += "\n M tracked.txt\n?? z-new";
	const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
	assert.deepEqual(after.createdPaths, ["z-new"]);
});
