import assert from "node:assert/strict";
import { join } from "node:path";
import type { ExtensionContext as Ctx } from "@bastani/atomic";
import { afterAll, test } from "vitest";
import { SessionManager as SM } from "../../packages/coding-agent/src/core/session-manager.js";
import { collectFeedbackDiagnostics as collect } from "../../packages/feedback/src/diagnostics.js";
import { makeTempDirectory, removeTempDirectory, spawnSyncCollect, writeTextSync } from "../helpers/runtime.js";

const root = makeTempDirectory("feedback-working-tree-");
afterAll(() => removeTempDirectory(root));
test("captures bounded path-only worktree changes before and after", async () => {
	const ctx = { cwd: root, mode: "print", model: undefined, sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	let status = `RM renamed.txt\0old\0${Array.from({ length: 110 }, (_, i) => `?? path-${String(i).padStart(3, "0")}`).join("\0")}\0`;
	const exec = async () => ({ code: 0, stdout: status });
	const runtime = { ctx, loadedExtensions: [], exec };
	const before = await collect({ report: "bug", phase: "before" }, runtime);
	assert.deepEqual([before.worktree.paths.length, before.worktree.paths[0]], [100, "renamed.txt"]);
	status += " M tracked.txt\0?? z-new\0";
	const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
	assert.deepEqual(after.createdPaths, ["z-new"]);
});

// #2799 / Greptile 3939723181: abandoned before calls must not retain unlimited baselines.
test("evicts the oldest pending baseline while preserving recent comparisons", async () => {
	const ctx = { cwd: root, mode: "print", sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	let status = "";
	const runtime = { ctx, loadedExtensions: [], exec: async () => ({ code: 0, stdout: status }) };
	const pending = [];
	for (let i = 0; i < 250; i++) pending.push(await collect({ report: "bug", phase: "before" }, runtime));
	status = "?? new.txt\0";
	for (const before of pending.slice(0, -8)) {
		const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
		assert.equal(after.createdPaths, undefined);
		assert.equal(after.baselineUnavailable, "missing");
	}
	for (const before of pending.slice(-8)) {
		const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
		assert.deepEqual(after.createdPaths, ["new.txt"]);
	}
});

// #2799 / Greptile 3939723181: cap retained paths and characters, not only snapshot count.
test("refuses oversized baselines instead of mislabeling truncated old paths as new", async () => {
	const ctx = { cwd: root, mode: "print", sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	for (const paths of [
		Array.from({ length: 10_001 }, (_, i) => `old-${i}`),
		Array.from({ length: 1_000 }, (_, i) => `${i}-${"x".repeat(300)}`),
	]) {
		let status = paths.map((path) => `?? ${path}\0`).join("");
		const runtime = { ctx, loadedExtensions: [], exec: async () => ({ code: 0, stdout: status }) };
		const before = await collect({ report: "bug", phase: "before" }, runtime);
		assert.equal(before.baselineUnavailable, "too-large");
		status += "?? genuinely-new\0";
		const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
		assert.equal(after.createdPaths, undefined);
		assert.equal(after.baselineUnavailable, "too-large");
	}
});

// #2799: unavailable or ambiguous evidence must never become invented debugger findings.
test("reports unavailable git status honestly before and after instead of claiming new paths", async () => {
	const ctx = { cwd: root, mode: "print", sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	for (const failure of [
		async () => ({ code: 128, stdout: "" }),
		async () => ({ code: 0, killed: true, stdout: "?? partial.txt\0" }),
		async () => ({ code: 0, stdout: "?? partial.txt" }),
		async () => ({ code: 0, stdout: "R  renamed.txt\0" }),
		async () => ({ code: 0, stdout: "garbage\0" }),
		async () => {
			throw new Error("git failed");
		},
	]) {
		const failed = { ctx, loadedExtensions: [], exec: failure };
		const healthy = { ctx, loadedExtensions: [], exec: async () => ({ code: 0, stdout: "?? old.txt\0" }) };
		const before = await collect({ report: "bug", phase: "before" }, failed);
		assert.equal(before.worktree.available, false);
		assert.equal(before.baselineUnavailable, "worktree-unavailable");
		const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, healthy);
		assert.equal(after.createdPaths, undefined);
		assert.equal(after.baselineUnavailable, "worktree-unavailable");
		const valid = await collect({ report: "bug", phase: "before" }, healthy);
		const failedAfter = await collect({ report: "bug", phase: "after", since: valid.snapshotId }, failed);
		assert.equal(failedAfter.worktree.available, false);
		assert.equal(failedAfter.createdPaths, undefined);
		assert.equal(failedAfter.baselineUnavailable, "worktree-unavailable");
	}
});

test("uses literal git paths for quoted filenames and rename destinations", async () => {
	const cwd = makeTempDirectory("feedback-git-paths-");
	try {
		const git = (...args: string[]) => {
			const result = spawnSyncCollect(["git", ...args], { cwd });
			assert.equal(result.exitCode, 0, result.stderr.toString());
			return result.stdout.toString();
		};
		git("init");
		writeTextSync(join(cwd, "old.txt"), "tracked content");
		git("add", "old.txt");
		git(
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-m",
			"fixture",
		);
		git("mv", "old.txt", "renamed name.txt");
		const oldPaths = [
			"space name.txt",
			"日本語.txt",
			...(process.platform === "win32" ? [] : ["line\nbreak.txt", "old -> name.txt"]),
		];
		for (const path of oldPaths) writeTextSync(join(cwd, path), "old");
		const ctx = { cwd, mode: "print", sessionManager: SM.inMemory(cwd) } as Partial<Ctx> as Ctx;
		const runtime = {
			ctx,
			loadedExtensions: [],
			exec: async (command: string, args: string[]) => {
				assert.equal(command, "git");
				return { code: 0, stdout: git(...args) };
			},
		};
		const before = await collect({ report: "bug", phase: "before" }, runtime);
		assert.deepEqual([...before.worktree.paths].sort(), ["renamed name.txt", ...oldPaths].sort());
		writeTextSync(join(cwd, "new name.txt"), "new");
		const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
		assert.deepEqual(after.createdPaths, ["new name.txt"]);
	} finally {
		removeTempDirectory(cwd);
	}
});

test("does not merge distinct newly-created paths that redact to the same display text", async () => {
	const ctx = { cwd: root, mode: "print", sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	const oldPath = `ghp_${"a".repeat(36)}`;
	const newPath = `ghp_${"b".repeat(36)}`;
	let status = `?? ${oldPath}\0`;
	const runtime = { ctx, loadedExtensions: [], exec: async () => ({ code: 0, stdout: status }) };
	const before = await collect({ report: "bug", phase: "before" }, runtime);
	status += `?? ${newPath}\0`;
	const after = await collect({ report: "bug", phase: "after", since: before.snapshotId }, runtime);
	assert.deepEqual(before.worktree.paths, ["[REDACTED]"]);
	assert.deepEqual(after.createdPaths, ["[REDACTED]"]);
	assert.ok(!JSON.stringify([before, after]).includes(oldPath));
	assert.ok(!JSON.stringify([before, after]).includes(newPath));
});

test("consumes snapshots once, isolates sessions, and ignores since during before", async () => {
	const ctx = { cwd: root, mode: "print", sessionManager: SM.inMemory(root) } as Partial<Ctx> as Ctx;
	let status = "";
	const runtime = { ctx, loadedExtensions: [], exec: async () => ({ code: 0, stdout: status }) };
	const first = await collect({ report: "bug", phase: "before" }, runtime);
	status = "?? new.txt\0";
	const other = { ...runtime, ctx: { ...ctx, sessionManager: SM.inMemory(root) } };
	const crossSession = await collect({ report: "bug", phase: "after", since: first.snapshotId }, other);
	assert.equal(crossSession.createdPaths, undefined);
	assert.equal(crossSession.baselineUnavailable, "missing");
	const second = await collect({ report: "bug", phase: "before", since: first.snapshotId }, runtime);
	assert.equal(second.createdPaths, undefined);
	assert.equal(second.baselineUnavailable, undefined);
	const after = await collect({ report: "bug", phase: "after", since: first.snapshotId }, runtime);
	assert.deepEqual(after.createdPaths, ["new.txt"]);
	const repeated = await collect({ report: "bug", phase: "after", since: first.snapshotId }, runtime);
	assert.equal(repeated.createdPaths, undefined);
	assert.equal(repeated.baselineUnavailable, "missing");
	const unchanged = await collect({ report: "bug", phase: "after", since: second.snapshotId }, runtime);
	assert.deepEqual(unchanged.createdPaths, []);
	assert.equal(unchanged.worktree.available, true);
});
