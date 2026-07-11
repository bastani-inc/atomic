import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanupOldArtifacts } from "../../packages/subagents/src/shared/artifacts.js";

test("stale artifact cleanup recursively removes nested progress storage", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-artifact-cleanup-"));
	try {
		const progressRoot = join(root, "progress");
		const staleRunDir = join(progressRoot, "stale-run");
		mkdirSync(staleRunDir, { recursive: true });
		const staleProgressFile = join(staleRunDir, "progress.md");
		writeFileSync(staleProgressFile, "# Stale progress\n");
		const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		utimesSync(staleProgressFile, old, old);
		utimesSync(staleRunDir, old, old);

		const freshRunDir = join(progressRoot, "fresh-run");
		mkdirSync(freshRunDir);
		writeFileSync(join(freshRunDir, "progress.md"), "# Fresh progress\n");

		cleanupOldArtifacts(root, 1);

		assert.equal(existsSync(staleRunDir), false);
		assert.equal(existsSync(freshRunDir), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stale artifact cleanup retains an old parent containing a fresh descendant", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-artifact-cleanup-"));
	try {
		const oldParent = join(root, "progress", "old-parent");
		const freshProgress = join(oldParent, "nested", "progress.md");
		mkdirSync(dirname(freshProgress), { recursive: true });
		writeFileSync(freshProgress, "# Fresh progress\n");
		const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
		utimesSync(oldParent, old, old);

		cleanupOldArtifacts(root, 1);

		assert.equal(existsSync(oldParent), true);
		assert.equal(existsSync(freshProgress), true);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("stale artifact cleanup removes a directory symlink without traversing its target", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-artifact-cleanup-"));
	const external = mkdtempSync(join(tmpdir(), "atomic-subagent-artifact-target-"));
	try {
		const externalFile = join(external, "must-survive.md");
		writeFileSync(externalFile, "# Outside artifact root\n");
		const linkPath = join(root, "linked-directory");
		try {
			symlinkSync(external, linkPath, process.platform === "win32" ? "junction" : "dir");
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
			throw error;
		}

		cleanupOldArtifacts(root, -1);

		assert.equal(existsSync(linkPath), false);
		assert.equal(existsSync(externalFile), true, "cleanup must not traverse directory symlinks");
	} finally {
		rmSync(root, { recursive: true, force: true });
		rmSync(external, { recursive: true, force: true });
	}
});
