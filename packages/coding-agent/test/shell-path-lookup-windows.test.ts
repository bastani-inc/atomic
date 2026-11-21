import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, win32 } from "node:path";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

type ShellModule = typeof import("../src/utils/shell.js");

const systemRoot = process.env.SystemRoot ?? "C:\\Windows";

describe.skipIf(process.platform !== "win32")("PowerShell found on PATH on Windows", () => {
	let sandbox: string;
	let shell: ShellModule;

	beforeEach(async () => {
		sandbox = realpathSync(mkdtempSync(join(tmpdir(), "atomic-path-lookup-")));
		vi.stubEnv("ProgramFiles", undefined);
		vi.stubEnv("SystemRoot", undefined);
		vi.resetModules();
		shell = await import("../src/utils/shell.js");
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(sandbox, { recursive: true, force: true });
	});

	function fakePowerShell(directory: string): string {
		mkdirSync(directory, { recursive: true });
		const path = join(directory, "pwsh.exe");
		copyFileSync(join(systemRoot, "System32", "cmd.exe"), path);
		return path;
	}

	it("a relative PATH entry is never searched, and the PowerShell found starts from any working directory (#5324)", () => {
		const bin = join(sandbox, "relative-bin");
		fakePowerShell(bin);
		const entry = relative(process.cwd(), bin);
		assert.equal(win32.isAbsolute(entry), false, entry);
		const expected = fakePowerShell(join(sandbox, "absolute-bin"));
		vi.stubEnv("PATH", `${entry};${join(sandbox, "absolute-bin")}`);

		const found = shell.getPowerShellConfig().shell;
		const started = spawnSync(found, ["/c", "exit", "0"], { cwd: mkdtempSync(join(sandbox, "elsewhere-")) });

		assert.equal(found.toLowerCase(), expected.toLowerCase());
		assert.equal(started.error, undefined, String(started.error));
		assert.equal(started.status, 0);
	});

	it("a directory named pwsh.exe earlier on PATH does not hide the executable after it (#5324)", () => {
		const first = join(sandbox, "first");
		mkdirSync(join(first, "pwsh.exe"), { recursive: true });
		const valid = join(sandbox, "valid");
		const expected = fakePowerShell(valid);
		vi.stubEnv("PATH", `${first};${valid}`);

		assert.equal(shell.getPowerShellConfig().shell, expected);
	});

	it("a junction named pwsh.exe to a directory earlier on PATH does not hide the executable after it (#5324)", () => {
		const target = join(sandbox, "target");
		mkdirSync(target);
		const first = join(sandbox, "first");
		mkdirSync(first);
		symlinkSync(target, join(first, "pwsh.exe"), "junction");
		const valid = join(sandbox, "valid");
		const expected = fakePowerShell(valid);
		vi.stubEnv("PATH", `${first};${valid}`);

		assert.equal(shell.getPowerShellConfig().shell, expected);
	});
});
