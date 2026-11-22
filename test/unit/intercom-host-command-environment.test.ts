import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, test } from "vitest";
import { systemSources } from "../../packages/intercom/broker/broker-instance.ts";
import { resolveSafeWindowsWorkingDirectoryAsync } from "../../packages/intercom/broker/windows-cwd.js";

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
			const realFolder = realpathSync.native(folder);
			const realCandidate = realpathSync.native(candidate);
			const rel = win32.relative(realFolder.toLowerCase(), realCandidate.toLowerCase());
			return rel !== ".." && !rel.startsWith("..\\") && !win32.isAbsolute(rel);
		};
		const externalJunctionIntoProject = join(root, "ext-junc-win");
		const projectJunction = join(root, "proj-junc");
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", externalJunctionIntoProject, relativeDirInsideProject], {
			windowsHide: true,
		});
		execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", projectJunction, project], {
			windowsHide: true,
		});
		try {
			process.chdir(project);
			for (const [label, badValue] of [
				["nonexistent", "Z:\\NoSuchWindowsDir"],
				["file", notADir],
				["relative", "Windows"],
				["bare-drive", "C:"],
				["drive-relative", "\\Windows"],
				["project-subdir", relativeDirInsideProject],
				["external-junction-into-project", externalJunctionIntoProject],
				["extended-prefix-project-subdir", `\\\\?\\${realpathSync.native(relativeDirInsideProject)}`],
			] as const) {
				process.env.SystemRoot = badValue;
				process.env.windir = badValue;
				const output = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
				assert.ok(win32.isAbsolute(output), `${label}: expected absolute cwd, got ${JSON.stringify(output)}`);
				assert.ok(!isInside(project, output), `${label}: ran inside project folder (${output})`);
			}

			// When process.cwd() itself is reached through a junction, a candidate inside the real project target is rejected.
			process.chdir(projectJunction);
			process.env.SystemRoot = realpathSync.native(relativeDirInsideProject);
			process.env.windir = realpathSync.native(relativeDirInsideProject);
			const fromProjJunction = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
			assert.ok(win32.isAbsolute(fromProjJunction));
			assert.ok(!isInside(project, fromProjJunction), `project-junction: ran inside project (${fromProjJunction})`);

			// When process.cwd() is a genuine drive root, a drive-root SystemRoot candidate yields to Windows, and valid
			// SystemRoot stays selected rather than escaping to another directory.
			const driveRoot = win32.parse(realpathSync.native(realSystemRoot)).root;
			process.chdir(driveRoot);
			process.env.SystemRoot = driveRoot;
			process.env.windir = driveRoot;
			const fromDriveRootCandidate = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
			assert.equal(
				realpathSync.native(fromDriveRootCandidate).toLowerCase(),
				realpathSync.native(realSystemRoot).toLowerCase(),
				`drive-root candidate should prefer Windows directory, got ${fromDriveRootCandidate}`,
			);

			// Long (>260-char) \\?\ SystemRoot, long \\?\ TMP when cwd is Windows, and a short junction targeting a
			// >260-char directory all succeed without ENOENT or uncaught ENOTCONN.
			const uncaught: unknown[] = [];
			const onUncaught = (err: unknown) => uncaught.push(err);
			process.on("uncaughtException", onUncaught);
			const origTmp = process.env.TMP;
			const origTemp = process.env.TEMP;
			try {
				let longDir = join(root, "lp");
				for (let i = 0; i < 12; i++) {
					longDir = join(longDir, `seg_${String(i).padStart(2, "0")}_1234567890123456`);
				}
				const longExt = `\\\\?\\${longDir}`;
				mkdirSync(longExt, { recursive: true });
				const shortToLong = join(root, "j-long");
				execFileSync(cmdExe, ["/d", "/c", "mklink", "/J", shortToLong, longDir], { windowsHide: true });

				process.chdir(project);
				for (const [label, sr] of [
					["long-ext-SystemRoot", longExt],
					["short-junction-to-long", shortToLong],
				] as const) {
					process.env.SystemRoot = sr;
					process.env.windir = sr;
					const chosen = await resolveSafeWindowsWorkingDirectoryAsync({ commandPath: cmdExe, timeoutMs: 150 });
					assert.ok(
						chosen !== undefined && chosen.length < 248 && !chosen.startsWith("\\\\?\\"),
						`${label}: expected short cwd (<248 chars, works with LongPathsEnabled=0), got ${JSON.stringify(chosen)}`,
					);
					const out = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
					assert.ok(win32.isAbsolute(out), `${label}: expected absolute cwd, got ${JSON.stringify(out)}`);
					assert.ok(!isInside(project, out), `${label}: ran inside project (${out})`);
				}

				process.chdir(realSystemRoot);
				process.env.SystemRoot = realSystemRoot;
				if (originalWindir === undefined) delete process.env.windir;
				else process.env.windir = originalWindir;
				process.env.TMP = longExt;
				process.env.TEMP = longExt;
				const chosenFromLongTmp = await resolveSafeWindowsWorkingDirectoryAsync({
					commandPath: cmdExe,
					timeoutMs: 150,
				});
				assert.ok(
					chosenFromLongTmp !== undefined &&
						chosenFromLongTmp.length < 248 &&
						!chosenFromLongTmp.startsWith("\\\\?\\"),
					`long-ext-TMP: expected short cwd (<248 chars), got ${JSON.stringify(chosenFromLongTmp)}`,
				);
				const fromLongTmp = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
				assert.ok(win32.isAbsolute(fromLongTmp), `long-ext-TMP: got ${JSON.stringify(fromLongTmp)}`);
				assert.deepEqual(uncaught, [], "no uncaught ENOTCONN exceptions on long \\\\?\\ paths");

				// Also exercise a non-C: project drive (via subst when needed) with a >260-char SystemRoot.
				const substLetter = ["S:", "T:", "U:", "V:", "W:"].find(
					(letter) => spawnSync("subst", [letter, root], { windowsHide: true }).status === 0,
				);
				if (substLetter !== undefined) {
					try {
						const nonCProject = `${substLetter}\\project`;
						const nonCLong = `\\\\?\\${substLetter}\\${longDir.slice(root.length + 1)}`;
						process.chdir(nonCProject);
						process.env.SystemRoot = nonCLong;
						process.env.windir = nonCLong;
						const nonCChosen = await resolveSafeWindowsWorkingDirectoryAsync({
							commandPath: cmdExe,
							timeoutMs: 150,
						});
						assert.ok(
							nonCChosen !== undefined && nonCChosen.length < 248 && !nonCChosen.startsWith("\\\\?\\"),
							`non-C-long-SR: expected short cwd, got ${JSON.stringify(nonCChosen)}`,
						);
						const nonCOut = (await systemSources().run(cmdExe, ["/d", "/c", "cd"])).trim();
						assert.ok(win32.isAbsolute(nonCOut), `non-C-long-SR: got ${JSON.stringify(nonCOut)}`);
						assert.ok(!isInside(project, nonCOut), `non-C-long-SR: ran inside project (${nonCOut})`);
					} finally {
						process.chdir(originalCwd);
						spawnSync("subst", [substLetter, "/D"], { windowsHide: true });
					}
				}
			} finally {
				process.off("uncaughtException", onUncaught);
				if (origTmp === undefined) delete process.env.TMP;
				else process.env.TMP = origTmp;
				if (origTemp === undefined) delete process.env.TEMP;
				else process.env.TEMP = origTemp;
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
