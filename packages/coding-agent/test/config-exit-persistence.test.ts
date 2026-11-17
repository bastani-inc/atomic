import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { bunExecutable, spawnProcess } from "../../../test/helpers/runtime.js";

const CONFIG_CHILD_TIMEOUT_MS = 60_000;

for (const closeKey of ["close", "exit"]) {
	for (const queryMode of ["unanswered", ...(process.platform === "win32" ? ["powershell"] : [])]) {
		test(
			`atomic config saves its last toggle before ${closeKey} with a cold ${queryMode} start read (#5315)`,
			async () => {
				const directory = mkdtempSync(join(tmpdir(), "atomic-config-exit-"));
				try {
					const child = spawnProcess(
						[
							bunExecutable(),
							fileURLToPath(new URL("./fixtures/config-exit-persistence.ts", import.meta.url)),
							directory,
							closeKey,
							queryMode,
						],
						{ env: { ...process.env, HOME: directory, USERPROFILE: directory }, stdout: "pipe", stderr: "pipe" },
					);
					const output = new Response(child.stdout).text();
					const errors = new Response(child.stderr).text();
					assert.equal(await child.exited, 0, `${await output}\n${await errors}`);
					const path = join(directory, "agent", "settings.json");
					assert.ok(existsSync(path), "the setting was written before the child exited");
					assert.deepEqual((JSON.parse(readFileSync(path, "utf8")) as { extensions?: string[] }).extensions, [
						"-builtin:codemode",
					]);
				} finally {
					rmSync(directory, { recursive: true, force: true });
				}
			},
			CONFIG_CHILD_TIMEOUT_MS,
		);
	}
}
