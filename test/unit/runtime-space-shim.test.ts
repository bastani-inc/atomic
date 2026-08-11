import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { readStreamText, spawnProcess } from "../helpers/runtime.js";

const shimScript = process.platform === "win32" ? "@echo off\r\necho %~1\r\n" : "#!/bin/sh\nprintf '%s\\n' \"$1\"\n";

for (const extension of [".cmd", ".bat"]) {
	test(`runs a ${extension} shim when its path contains a space`, async () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic spawn shim-"));
		const executable = join(directory, `echo${extension}`);
		writeFileSync(executable, shimScript);
		if (process.platform !== "win32") chmodSync(executable, 0o755);

		try {
			const child = spawnProcess([executable, "quoted-shim-argument"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStreamText(child.stdout),
				readStreamText(child.stderr),
				child.exited,
			]);

			assert.equal(exitCode, 0, stderr);
			assert.equal(stdout.trim(), "quoted-shim-argument");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
}
