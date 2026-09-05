import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { stagePostgresRuntime } from "../../scripts/stage-postgres-runtime.mjs";

/** The smallest buffer `validatePostgresArchitecture` accepts as an x64 PE: MZ, e_lfanew, "PE\0\0", machine. */
function minimalX64PortableExecutable(): Buffer {
	const binary = Buffer.alloc(0x48);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(0x40, 0x3c);
	binary.write("PE\0\0", 0x40, "binary");
	binary.writeUInt16LE(0x8664, 0x44);
	return binary;
}

// Regression: the Windows ARM64 leg of publish.yml ran this under Git Bash, whose
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
		writeFileSync(join(source, "package", "LICENSE.md"), "upstream license\n");
		const archive = join(root, "windows-x64-test.tgz");
		execFileSync("tar", ["-czf", "windows-x64-test.tgz", "-C", "source", "package"], { cwd: root });

		const packageRoot = join(root, "leaf");
		mkdirSync(packageRoot);
		writeFileSync(join(packageRoot, "package.json"), `${JSON.stringify({ name: "leaf", files: ["native"] })}\n`);

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
