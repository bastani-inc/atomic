import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, test, vi } from "vitest";
import { startHostProcessesThroughChildProcess } from "../helpers/host-spawn.js";

/** Runs once, just before the next `git bundle create` the code under test starts. */
const hooks = vi.hoisted(() => ({ beforeBundle: undefined as (() => void) | undefined }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		spawn: (command: string, args: readonly string[], options: object) => {
			const words = args.filter((arg, index) => arg !== "-c" && args[index - 1] !== "-c");
			if (hooks.beforeBundle !== undefined && words[0] === "bundle" && words[1] === "create") {
				const hook = hooks.beforeBundle;
				hooks.beforeBundle = undefined;
				hook();
			}
			return (actual.spawn as (...parameters: unknown[]) => unknown)(command, args, options);
		},
	};
});

import {
	captureWorktreeSnapshot,
	type WorktreeSnapshotCapture,
} from "../../packages/coding-agent/src/core/worktree-snapshot/capture.ts";
import { GitSandbox, startedGitProcesses } from "../helpers/worktree-snapshot.js";

startHostProcessesThroughChildProcess();

let sandbox: GitSandbox;
beforeEach(() => {
	sandbox = new GitSandbox();
});
afterEach(() => {
	hooks.beforeBundle = undefined;
	sandbox.dispose();
});

function captured(result: WorktreeSnapshotCapture): Extract<WorktreeSnapshotCapture, { status: "captured" }> {
	assert.equal(result.status, "captured", JSON.stringify(result));
	return result as Extract<WorktreeSnapshotCapture, { status: "captured" }>;
}

test("history repacked while it was bundled is bundled again, also once the packs are back as they were", async () => {
	const { clone } = await sandbox.remoteWithClone();
	sandbox.write(join(clone, "data.txt"), "unique content that will not compress to nothing\n".repeat(20));
	await sandbox.commitAll(clone, "data");
	await sandbox.git(clone, "repack", "-a", "-d", "-q");
	const packs = join(clone, ".git", "objects", "pack");
	const saved = sandbox.path("saved-packs");
	// The repository is repacked, into packs of other content, just before the commits are bundled.
	hooks.beforeBundle = () => {
		cpSync(packs, saved, { recursive: true });
		execFileSync("git", ["-c", "pack.compression=0", "repack", "-a", "-d", "-F", "-q"], {
			cwd: clone,
			env: { ...process.env, ...sandbox.executable.env },
			stdio: "ignore",
		});
	};
	const settings = { maxSnapshotBytes: 64 };
	const first = captured(await captureWorktreeSnapshot(clone, { settings }));
	assert.equal(hooks.beforeBundle, undefined, "the commits were bundled");
	assert.equal(first.snapshot.omitted[0]?.reason, "bundle-over-cap");

	// The packs the commits were bundled from are gone, and those from before are back.
	rmSync(packs, { recursive: true, force: true });
	cpSync(saved, packs, { recursive: true });
	const trace = sandbox.traceGitProcesses();
	sandbox.write(join(clone, "edit.txt"), "edit\n");
	const second = captured(await captureWorktreeSnapshot(clone, { settings }));
	assert.equal(second.snapshot.omitted[0]?.reason, "bundle-over-cap");
	const bundled = existsSync(trace)
		? startedGitProcesses(trace).filter(({ argv = [] }) => argv.includes("bundle") && argv.includes("create")).length
		: 0;
	assert.equal(bundled, 1, "the commits are bundled again");
});

test("history whose packing setting changed while it was bundled is bundled again once the setting is back", async () => {
	const { clone } = await sandbox.remoteWithClone();
	// Text that compresses well: uncompressed its bundle is far over the cap, compressed far under it.
	sandbox.write(join(clone, "data.txt"), "a line that repeats and compresses well\n".repeat(4096));
	const commit = await sandbox.commitAll(clone, "data");
	await sandbox.git(clone, "config", "core.compression", "9");
	// Compression is turned off just before the commits are bundled: their bundle is over the cap.
	hooks.beforeBundle = () => {
		execFileSync("git", ["config", "core.compression", "0"], {
			cwd: clone,
			env: { ...process.env, ...sandbox.executable.env },
			stdio: "ignore",
		});
	};
	const settings = { maxSnapshotBytes: 32 * 1024 };
	const first = captured(await captureWorktreeSnapshot(clone, { settings }));
	assert.equal(hooks.beforeBundle, undefined, "the commits were bundled");
	assert.equal(first.snapshot.omitted[0]?.reason, "bundle-over-cap");

	// Back at the setting the capture started with, the commits' bundle fits under the cap.
	await sandbox.git(clone, "config", "core.compression", "9");
	sandbox.write(join(clone, "edit.txt"), "edit\n");
	const second = captured(await captureWorktreeSnapshot(clone, { settings }));
	assert.deepEqual(second.snapshot.omitted, []);
	assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
});

test("history whose attributes turned delta compression off while it was bundled is bundled again once they are back", async () => {
	const data = `${randomBytes(48 * 1024)
		.toString("base64")
		.replace(/.{76}/g, "$&\n")}\n`;
	const { clone } = await sandbox.remoteWithClone("repo", { "sub/data.txt": data });
	sandbox.write(join(clone, "sub", "data.txt"), `edited ${data}`);
	const commit = await sandbox.commitAll(clone, "edit data");
	const attributes = join(clone, ".git", "info", "attributes");
	// Delta compression is turned off for the file just before the commit is bundled: its bundle is over the cap.
	hooks.beforeBundle = () => sandbox.write(attributes, "sub/data.txt -delta\n");
	const settings = { maxSnapshotBytes: 16 * 1024 };
	sandbox.write(join(clone, "edit.txt"), "one\n");
	const first = captured(await captureWorktreeSnapshot(clone, { settings }));
	assert.equal(hooks.beforeBundle, undefined, "the commit was bundled");
	assert.equal(first.snapshot.omitted[0]?.reason, "bundle-over-cap");

	// Back to the attributes the capture started with, the commit's bundle fits under the cap.
	rmSync(attributes);
	sandbox.write(join(clone, "edit.txt"), "two\n");
	const second = captured(await captureWorktreeSnapshot(clone, { settings }));
	assert.deepEqual(second.snapshot.omitted, []);
	assert.deepEqual(second.snapshot.bundle?.commits, [commit]);
});
