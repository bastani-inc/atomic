import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync } from "node:fs";
import { win32 } from "node:path";
import { describe, it } from "vitest";
import { getPowerShellConfig } from "../src/utils/shell.ts";

/** The first path `where` prints for `executable`, or undefined when it finds none. */
function where(executable: string): string | undefined {
	const result = spawnSync("where", [executable], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined;
}

function exists(path: string | undefined): path is string {
	if (!path) return false;
	try {
		accessSync(path);
		return true;
	} catch {
		return false;
	}
}

// Atomic finds PowerShell by scanning PATH itself instead of starting `where`. On a real Windows host the scan must
// pick what `where` picks, in the same precedence getPowerShellConfig documents.
describe.runIf(process.platform === "win32")("PowerShell lookup without `where`", () => {
	it("picks the PowerShell that `where` and the installation directories pick", () => {
		const programFiles = process.env.ProgramFiles;
		const systemRoot = process.env.SystemRoot;
		const pwsh7 = programFiles ? win32.join(programFiles, "PowerShell", "7", "pwsh.exe") : undefined;
		const windowsPowerShell = systemRoot
			? win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
			: undefined;
		const expected =
			where("pwsh.exe") ??
			(exists(pwsh7) ? pwsh7 : undefined) ??
			where("powershell.exe") ??
			(exists(windowsPowerShell) ? windowsPowerShell : undefined);
		assert.ok(expected, "this Windows host has no PowerShell");
		assert.equal(getPowerShellConfig().shell.toLowerCase(), expected.toLowerCase());
	});
});
