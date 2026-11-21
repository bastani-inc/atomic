import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, test } from "vitest";
import { bunExecutable } from "./cli-test-helpers.ts";

const MODULE = fileURLToPath(new URL("../src/utils/process-exit-status.ts", import.meta.url));
/** STATUS_CONTROL_C_EXIT: the status Windows gives a process it ends when its console is closed. */
const STATUS_CONTROL_C_EXIT = 0xc000013a;
/** Starting Bun and loading the module, however loaded the machine. */
const CHILD_TIMEOUT_MS = 60_000;

// Bun keeps only the low byte of a status passed to process.exit; Windows statuses use all 32 bits.
describe.skipIf(process.platform !== "win32")("a Windows exit status", () => {
	test("reaches Windows whole under Bun, after the process's exit listeners", () => {
		const directory = mkdtempSync(join(tmpdir(), "atomic-exit-status-"));
		try {
			const marker = join(directory, "exit-listener");
			const script = `import { writeFileSync } from "node:fs";
import { exitWithStatus } from ${JSON.stringify(pathToFileURL(MODULE).href)};
process.on("exit", (code) => writeFileSync(${JSON.stringify(marker)}, String(code)));
exitWithStatus(${STATUS_CONTROL_C_EXIT});`;
			const result = spawnSync(bunExecutable(), ["--eval", script], {
				encoding: "utf8",
				timeout: CHILD_TIMEOUT_MS,
				windowsHide: true,
			});

			assert.equal(result.status, STATUS_CONTROL_C_EXIT, result.stderr);
			assert.ok(readFileSync(marker, "utf8").length > 0, "the exit listener ran first");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
