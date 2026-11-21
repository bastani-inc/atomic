import assert from "node:assert/strict";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { ENV_AGENT_DIR, ENV_OFFLINE } from "../src/config.ts";

const windows = process.platform === "win32";

/**
 * A program named `name` in `directory` that answers `--version`: elsewhere a shell script that also records each run in
 * `marker`; on Windows a copy of this Node, so there a run shows only as a successful start.
 */
function plantProgram(directory: string, name: string): string {
	if (windows) {
		const file = join(directory, `${name}.exe`);
		try {
			linkSync(process.execPath, file);
		} catch {
			copyFileSync(process.execPath, file);
		}
		return file;
	}
	const file = join(directory, name);
	writeFileSync(file, '#!/bin/sh\necho "$0" >> "$PLANTED_PROGRAM_MARKER"\nexit 0\n');
	chmodSync(file, 0o755);
	return file;
}

let root: string;
let project: string;
let marker: string;
let previousCwd: string;

function runs(): string[] {
	return existsSync(marker) ? readFileSync(marker, "utf8").split(/\r?\n/).filter(Boolean) : [];
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "atomic-planted-helper-"));
	project = join(root, "project");
	const emptyBin = join(root, "empty-bin");
	mkdirSync(project);
	mkdirSync(emptyBin);
	marker = join(root, "runs.txt");
	vi.stubEnv("PLANTED_PROGRAM_MARKER", marker);
	vi.stubEnv(ENV_AGENT_DIR, join(root, "agent"));
	vi.stubEnv(ENV_OFFLINE, "1");
	// Windows looks in the working directory before PATH; elsewhere an empty PATH entry names it.
	vi.stubEnv("PATH", windows ? emptyBin : `${delimiter}${emptyBin}`);
	previousCwd = process.cwd();
	process.chdir(project);
	vi.resetModules();
});

afterEach(() => {
	process.chdir(previousCwd);
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("helper programs Atomic starts come only from PATH, never from the project folder", () => {
	test("an fd or rg in the project folder is never run to check the tools, and does not count as installed", async () => {
		for (const name of ["fd", "fdfind", "rg"]) plantProgram(project, name);
		const { ensureTool, getToolPath } = await import("../src/utils/tools-manager.ts");

		assert.equal(await getToolPath("rg"), null);
		assert.equal(await getToolPath("fd"), null);
		assert.equal(await ensureTool("rg"), undefined);
		assert.deepEqual(runs(), []);
	});

	test("an npm in the project folder is never run for a package command", async () => {
		plantProgram(project, "npm");
		const { runCommandCapture } = await import("../src/core/package-manager-command.ts");

		await assert.rejects(runCommandCapture("npm", ["--version"], { cwd: project }), { code: "ENOENT" });
		assert.deepEqual(runs(), []);
	});

	test.skipIf(windows)("spawnProcess through a shell still passes its command line to the shell", async () => {
		const { spawnProcessSync } = await import("../src/utils/child-process.ts");
		const result = spawnProcessSync(`${process.execPath} -e "process.stdout.write('ordinary')"`, [], {
			shell: true,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		assert.equal(result.stdout, "ordinary", result.stderr);
		assert.equal(result.status, 0);
	});

	test("the same programs in a PATH directory are found by their absolute path and run", async () => {
		const bin = join(root, "bin");
		mkdirSync(bin);
		const rg = plantProgram(bin, "rg");
		plantProgram(project, "rg");
		vi.stubEnv("PATH", windows ? bin : `${delimiter}${bin}`);
		const { getToolPath } = await import("../src/utils/tools-manager.ts");

		// Only a successful `rg --version` makes rg count as installed: the program ran.
		assert.equal(await getToolPath("rg"), rg);
		if (!windows) assert.equal(runs().length, 1);
	});
});
