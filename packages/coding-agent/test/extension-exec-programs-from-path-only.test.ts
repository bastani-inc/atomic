import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, onTestFinished, test, vi } from "vitest";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";
import { bunExecutable } from "./cli-test-helpers.ts";
import { createHarness, type Harness } from "./suite/harness.js";

const PROGRAM = "atomic-test-planted-program";

/** A copy of this Node named `PROGRAM` in `directory`, which a run shows by writing the file its argument names. */
function plantProgram(directory: string): void {
	mkdirSync(directory, { recursive: true });
	const file = join(directory, `${PROGRAM}.exe`);
	try {
		linkSync(process.execPath, file);
	} catch {
		copyFileSync(process.execPath, file);
	}
}

/** Arguments under which a planted program writes `marker`. */
const writes = (marker: string) => ["-e", 'require("node:fs").writeFileSync(process.argv[1], "ran")', marker];

let harness: Harness | undefined;

async function extensionApi(): Promise<{ pi: ExtensionAPI; folder: string }> {
	let api: ExtensionAPI | undefined;
	harness = await createHarness({
		extensionFactories: [
			(pi: ExtensionAPI) => {
				api = pi;
			},
		],
	});
	await harness.session.bindExtensions({});
	assert.ok(api);
	// The folder the extension's commands run in: a project that may never have been trusted.
	return { pi: api, folder: harness.tempDir };
}

afterEach(async () => {
	vi.unstubAllEnvs();
	await harness?.cleanup();
	harness = undefined;
});

/** How long the Bun child that runs one command through pi.exec's start may take on a loaded machine. */
const BUN_RUN_TIMEOUT_MS = 60_000;

/** What `execCommand` returns for `command` run from `cwd` in a Bun process, which is how the Windows binary runs. */
function execUnderBun(command: string, cwd: string, path: string): { stdout: string; stderr: string; code: number } {
	const script = join(cwd, "..", "exec-under-bun.ts");
	const exec = new URL("../src/core/exec.ts", import.meta.url).href;
	writeFileSync(
		script,
		`const { execCommand } = await import(${JSON.stringify(exec)});\nprocess.stdout.write(JSON.stringify(await execCommand(${JSON.stringify(command)}, ["one"], ${JSON.stringify(cwd)})));\n`,
	);
	const run = spawnSync(bunExecutable(), [script], {
		env: { ...process.env, PATH: path },
		encoding: "utf8",
		timeout: BUN_RUN_TIMEOUT_MS,
	});
	assert.equal(run.status, 0, run.stderr);
	return JSON.parse(run.stdout) as { stdout: string; stderr: string; code: number };
}

describe.skipIf(process.platform !== "win32")("pi.exec on Windows", () => {
	test("under Bun runs a .cmd shim from PATH by its name, as before, and never one the folder holds", async () => {
		const { folder } = await extensionApi();
		const bin = join(folder, "..", `shim-bin-${process.pid}`);
		mkdirSync(bin, { recursive: true });
		onTestFinished(() => rmSync(bin, { recursive: true, force: true }));
		writeFileSync(join(bin, "atomic-test-shim.cmd"), "@echo shim %1\r\n");
		const path = `${bin};${process.env.PATH ?? ""}`;

		const fromPath = execUnderBun("atomic-test-shim", folder, path);
		assert.deepEqual([fromPath.code, fromPath.stdout.trim()], [0, "shim one"]);

		writeFileSync(join(folder, "atomic-test-shim.cmd"), "@echo planted\r\n");
		const planted = execUnderBun("atomic-test-shim", folder, path);
		assert.notEqual(planted.code, 0);
		assert.doesNotMatch(planted.stdout, /planted/);
	});

	test("never runs a program the folder a command runs in holds, for a command named without a path", async () => {
		const { pi, folder } = await extensionApi();
		plantProgram(folder);
		const marker = join(folder, "ran.txt");

		const result = await pi.exec(PROGRAM, writes(marker));

		assert.notEqual(result.code, 0);
		assert.match(result.stderr, /ENOENT/);
		assert.equal(existsSync(marker), false, "the project's program ran");
	});

	test("runs the program from a PATH directory, and one named by a path as written", async () => {
		const { pi, folder } = await extensionApi();
		// An absolute PATH entry is searched even inside that folder: only the folder itself never is.
		const bin = join(folder, "bin");
		plantProgram(bin);
		vi.stubEnv("PATH", `${bin};${process.env.PATH ?? ""}`);
		const fromPath = join(folder, "from-path.txt");
		assert.equal((await pi.exec(PROGRAM, writes(fromPath))).code, 0);
		assert.equal(existsSync(fromPath), true);

		plantProgram(folder);
		const byPath = join(folder, "by-path.txt");
		assert.equal((await pi.exec(`.\\${PROGRAM}.exe`, writes(byPath))).code, 0);
		assert.equal(existsSync(byPath), true);
	});
});
