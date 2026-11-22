import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, test } from "vitest";
import { systemSources } from "../../packages/intercom/broker/broker-instance.ts";

const saved = process.env.PSModulePath;

afterEach(() => {
	if (saved === undefined) delete process.env.PSModulePath;
	else process.env.PSModulePath = saved;
});

test("a host command starts without the parent's PSModulePath, which breaks Windows PowerShell's Get-Process under a PowerShell 7 parent", async () => {
	process.env.PSModulePath = "C:\\Program Files\\PowerShell\\7\\Modules";
	process.env.ATOMIC_HOST_COMMAND_ENV_PROBE = "kept";
	try {
		const output = await systemSources().run(process.execPath, [
			"-e",
			"process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^psmodulepath$/i.test(k)).concat(process.env.ATOMIC_HOST_COMMAND_ENV_PROBE ?? 'missing')))",
		]);
		assert.deepEqual(JSON.parse(output), ["kept"]);
	} finally {
		delete process.env.ATOMIC_HOST_COMMAND_ENV_PROBE;
	}
});

test.skipIf(process.platform !== "win32")(
	"an explicit-path host command still runs outside the project folder under a nonexistent, file, relative, bare-drive, or project SystemRoot",
	async () => {
		const originalSystemRoot = process.env.SystemRoot;
		const originalWindir = process.env.windir;
		const originalCwd = process.cwd();
		const realSystemRoot = originalSystemRoot || originalWindir || "C:\\Windows";
		const cmdExe = win32.join(realSystemRoot, "System32", "cmd.exe");
		const root = mkdtempSync(join(tmpdir(), "atomic-host-cwd-"));
		const project = join(root, "project");
		const relativeDirInsideProject = join(project, "Windows");
		const notADir = join(root, "not-a-dir.txt");
		mkdirSync(relativeDirInsideProject, { recursive: true });
		writeFileSync(notADir, "file");
		const isInside = (folder: string, candidate: string) => {
			const rel = win32.relative(folder.toLowerCase(), candidate.toLowerCase());
			return rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel);
		};
		try {
			process.chdir(project);
			for (const [label, badValue] of [
				["nonexistent", "Z:\\NoSuchWindowsDir"],
				["file", notADir],
				["relative", "Windows"],
				["bare-drive", "C:"],
				["drive-relative", "\\Windows"],
				["project-subdir", relativeDirInsideProject],
			] as const) {
				process.env.SystemRoot = badValue;
				process.env.windir = badValue;
				const output = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
				assert.ok(win32.isAbsolute(output), `${label}: expected absolute cwd, got ${JSON.stringify(output)}`);
				assert.ok(!isInside(project, output), `${label}: ran inside project folder (${output})`);
			}
		} finally {
			process.chdir(originalCwd);
			if (originalSystemRoot === undefined) delete process.env.SystemRoot;
			else process.env.SystemRoot = originalSystemRoot;
			if (originalWindir === undefined) delete process.env.windir;
			else process.env.windir = originalWindir;
			rmSync(root, { recursive: true, force: true });
		}
	},
);
