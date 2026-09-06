import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { test, vi } from "vitest";
import { stagePostgresRuntime } from "../../scripts/stage-postgres-runtime.mjs";

// Observe the OS boundaries without replacing real extraction or temporary directories.
vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, mkdtempSync: vi.fn(actual.mkdtempSync) };
});

/** The smallest buffer `validatePostgresArchitecture` accepts as an x64 PE: MZ, e_lfanew, "PE\0\0", machine. */
function minimalX64PortableExecutable(): Buffer {
	const binary = Buffer.alloc(0x48);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(0x40, 0x3c);
	binary.write("PE\0\0", 0x40, "binary");
	binary.writeUInt16LE(0x8664, 0x44);
	return binary;
}

// Regression for PR #2877: the Windows ARM64 leg of publish.yml ran this under Git Bash, whose
// GNU tar parsed the absolute `C:\Users\...` archive path as `host:path` and
// failed with "Cannot connect to C: resolve failed". The archive is now extracted
// with paths relative to the work directory, which every tar accepts.
test("stages a Windows-shaped PostgreSQL tarball end to end from a caller-supplied artifact", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-stage-postgres-windows-"));
	try {
		const source = join(root, "source");
		const native = join(source, "package", "native", "bin");
		mkdirSync(native, { recursive: true });
		for (const binary of ["postgres", "initdb", "pg_ctl"]) {
			writeFileSync(join(native, `${binary}.exe`), minimalX64PortableExecutable());
		}
		mkdirSync(join(source, "package", "native", "lib"));
		writeFileSync(join(source, "package", "native", "lib", "libpq.dll"), "library");
		mkdirSync(join(source, "package", "native", "share"));
		writeFileSync(join(source, "package", "native", "share", "postgres.bki"), "catalog");
		writeFileSync(join(source, "package", "LICENSE.md"), "upstream license\n");
		const archive = join(root, "windows-x64-test.tgz");
		execFileSync("tar", ["-czf", "windows-x64-test.tgz", "-C", "source", "package"], { cwd: root });

		const packageRoot = join(root, "leaf");
		mkdirSync(packageRoot);
		writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: "leaf", files: ["native"] })}\n`);

		vi.mocked(spawnSync).mockClear();
		vi.mocked(mkdtempSync).mockClear();
		const callerCwd = process.cwd();
		const destination = await stagePostgresRuntime({
			target: "windows-arm64",
			packageRoot,
			artifactFile: archive,
			artifact: {
				url: "https://example.invalid/windows-x64-test.tgz",
				sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"),
				version: "0.0.0-test",
				kind: "windows-x64-emulated",
			},
		});

		const tarCalls = vi.mocked(spawnSync).mock.calls.filter(([command]) => command === "tar");
		assert.equal(tarCalls.length, 1, "staging must execute the observed tar extraction");
		const [, args, options] = tarCalls[0]!;
		assert.deepEqual(args, ["-xzf", basename(archive), "-C", "."]);
		for (const arg of args) {
			assert.ok(!posix.isAbsolute(arg) && !win32.isAbsolute(arg), `tar argument must be relative: ${arg}`);
		}
		const [work] = vi.mocked(mkdtempSync).mock.results;
		assert.equal(work?.type, "return");
		assert.equal(options?.cwd, work?.value, "tar must run inside the staging work directory");
		assert.equal(process.cwd(), callerCwd, "only the tar child changes working directory");

		assert.equal(destination, join(packageRoot, "postgres-runtime"));
		for (const binary of ["postgres", "initdb", "pg_ctl"]) {
			assert.ok(existsSync(join(destination, "bin", `${binary}.exe`)), `staged bin/${binary}.exe`);
		}
		assert.ok(existsSync(join(destination, "runtime-provenance.json")));
		const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { files: string[] };
		assert.ok(manifest.files.includes("postgres-runtime"));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
