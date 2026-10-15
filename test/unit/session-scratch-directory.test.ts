import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { test } from "vitest";
import { sessionScratchDir } from "../../packages/coding-agent/src/core/storage/session/scratch-directory.js";
import { getHomeDir } from "../../packages/coding-agent/src/utils/paths.ts";
import { fileExists, makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

test("session scratch paths are project-scoped without creating directories", async () => {
	const root = makeTempDirectory("atomic-session-scratch-");
	try {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project", "nested");
		const projectName = `--${resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
		const expected = join(agentDir, "sessions", projectName);
		assert.equal(sessionScratchDir(agentDir, cwd, "first"), expected);
		assert.equal(sessionScratchDir(agentDir, cwd, "second"), expected);
		assert.equal(sessionScratchDir(agentDir, cwd, "../unusual/session"), expected);
		assert.equal(await fileExists(agentDir), false);
		assert.equal(await fileExists(expected), false);
		assert.notEqual(sessionScratchDir(agentDir, join(root, "other"), "first"), expected);
	} finally {
		removeTempDirectory(root);
	}
});

test("session scratch paths resolve relative paths and encode both separator styles", () => {
	const name = (cwd: string) =>
		`--${resolve(cwd)
			.replace(/^[/\\]/, "")
			.replace(/[/\\:]/g, "-")}--`;
	assert.equal(
		sessionScratchDir(".agent", "project/../project", ""),
		join(resolve(".agent"), "sessions", name("project")),
	);
	assert.equal(
		sessionScratchDir(".agent", "project\\nested:folder", "session"),
		join(resolve(".agent"), "sessions", name("project\\nested:folder")),
	);
});

test("session scratch paths expand home directories without trimming project names", () => {
	const home = getHomeDir();
	const cwd = join(home, " project ");
	const name = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	assert.equal(sessionScratchDir("~/agent", "~/ project ", "session"), join(home, "agent", "sessions", name));
});
