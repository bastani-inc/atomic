import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { sweepSessionDirToolResults, sweepSessionTempRoot } from "../src/core/tools/session-temp-cleanup.ts";
import { acquireProtectedPaths, type ProtectedPathLease } from "../src/core/tools/session-temp-dir.ts";
import { TOOL_RESULTS_SUBDIR } from "../src/core/tools/tool-limits.ts";

const interleaving = vi.hoisted(() => ({ duringRead: undefined as ((path: string) => void) | undefined }));
vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return {
		...fs,
		readdir: async (path: string) => {
			interleaving.duringRead?.(path);
			return fs.readdir(path);
		},
	};
});

test.each(["session", "tool-results"] as const)(
	"keeps %s storage protected by a session while its asynchronous age scan is running",
	async (kind) => {
		const root = mkdtempSync(join(tmpdir(), "atomic-cleanup-interleaving-"));
		const target = join(root, kind === "session" ? "active" : TOOL_RESULTS_SUBDIR);
		mkdirSync(target);
		const file = join(target, "old.log");
		writeFileSync(file, "advertised to a live session");
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
		utimesSync(file, old, old);
		utimesSync(target, old, old);
		let lease: ProtectedPathLease | undefined;
		interleaving.duringRead = (path) => {
			if (path === target && lease === undefined) lease = acquireProtectedPaths([target]);
		};
		try {
			const options = { controlRoot: join(root, "control") };
			const outcome =
				kind === "session"
					? await sweepSessionTempRoot(root, options)
					: await sweepSessionDirToolResults(root, options);
			assert.equal(outcome, "swept");
			assert.ok(lease, "the session started using the directory during its age scan");
			assert.equal(existsSync(file), true, "the asynchronous scan must recheck live protection before deletion");
		} finally {
			interleaving.duringRead = undefined;
			lease?.release();
			rmSync(root, { recursive: true, force: true });
		}
	},
);
