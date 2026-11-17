import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { getAncestorDirectories, loadProjectContextFilesAsync } from "../src/core/resource-loader-context-files.ts";

describe("project context ancestor traversal", () => {
	it("terminates at a Windows drive root using dirname fixed points", () => {
		expect(getAncestorDirectories("C:\\repo\\nested", win32.dirname)).toEqual([
			"C:\\repo\\nested",
			"C:\\repo",
			"C:\\",
		]);
	});

	it("keeps agent-first and root-to-cwd context precedence when directories are read concurrently", async () => {
		const root = await mkdtemp(join(tmpdir(), "atomic-context-order-"));
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const cwd = join(projectDir, "nested");
		try {
			await Promise.all([mkdir(agentDir), mkdir(cwd, { recursive: true })]);
			const expected = [
				{ path: join(agentDir, "AGENTS.md"), content: "agent" },
				{ path: join(root, "AGENTS.md"), content: "root" },
				{ path: join(projectDir, "AGENTS.override.md"), content: "project override" },
				{ path: join(cwd, "CLAUDE.md"), content: "nested" },
			];
			await Promise.all([
				...expected.map(({ path, content }) => writeFile(path, content)),
				writeFile(join(projectDir, "AGENTS.md"), "shadowed by the override"),
				writeFile(join(projectDir, "CLAUDE.md"), "also shadowed"),
			]);
			const loaded = await loadProjectContextFilesAsync({ cwd, agentDir });
			assert.deepEqual(
				loaded.filter(({ path }) => path.startsWith(root)),
				expected,
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
