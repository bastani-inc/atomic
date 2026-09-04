import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { stagePostgresRuntime } from "./stage-postgres-runtime.mjs";

const temporaryDirectories = [];
const repositoryRoot = new URL("..", import.meta.url).pathname;

function temporaryDirectory(prefix) {
	const directory = mkdtempSync(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function packageDirectory(root, extra = {}) {
	const directory = join(root, "leaf");
	mkdirSync(directory);
	writeFileSync(
		join(directory, "package.json"),
		`${JSON.stringify({ name: "@bastani/atomic-natives-linux-x64-musl", version: "0.0.0", os: ["linux"], cpu: ["x64"], libc: ["musl"], files: ["atomic_natives.linux-x64-musl.node"], ...extra }, null, 2)}\n`,
	);
	writeFileSync(join(directory, "atomic_natives.linux-x64-musl.node"), "binding");
	return directory;
}
function fakeMuslExecutable() {
	const binary = Buffer.alloc(128);
	binary.write("\x7fELF", 0, "binary");
	binary.writeUInt16LE(62, 18);
	binary.write("/lib/ld-musl-x86_64.so.1", 32, "ascii");
	return binary;
}

function fakeX64PortableExecutable() {
	const binary = Buffer.alloc(128);
	binary.write("MZ", 0, "ascii");
	binary.writeUInt32LE(0x40, 0x3c);
	binary.write("PE\0\0", 0x40, "binary");
	binary.writeUInt16LE(0x8664, 0x44);
	return binary;
}

function fakeZonkyArtifact(root) {
	const tree = join(root, "tree");
	mkdirSync(join(tree, "bin"), { recursive: true });
	mkdirSync(join(tree, "lib"), { recursive: true });
	for (const binary of ["postgres", "initdb", "pg_ctl"])
		writeFileSync(join(tree, "bin", binary), binary === "postgres" ? fakeMuslExecutable() : binary);
	writeFileSync(join(tree, "lib", "libpq.so.5.18"), "library");
	symlinkSync("libpq.so.5.18", join(tree, "lib", "libpq.so"));
	const innerEntry = "postgres-test.txz";
	const inner = join(root, innerEntry);
	execFileSync("tar", ["-cJf", inner, "-C", tree, "."]);
	const jar = join(root, "fake.jar");
	execFileSync("zip", ["-q", jar, innerEntry], { cwd: root });
	return {
		path: jar,
		artifact: {
			url: "https://example.invalid/fake.jar",
			sha256: sha256(jar),
			innerEntry,
			innerSha256: sha256(inner),
			version: "18.6.0-test",
			kind: "zonky",
		},
	};
}
function fakeWindowsArtifact(root) {
	const packageRoot = join(root, "windows", "package");
	mkdirSync(join(packageRoot, "native", "bin"), { recursive: true });
	for (const binary of ["postgres.exe", "initdb.exe", "pg_ctl.exe"])
		writeFileSync(
			join(packageRoot, "native", "bin", binary),
			binary === "postgres.exe" ? fakeX64PortableExecutable() : binary,
		);
	const license = "Exact upstream Windows package license\n";
	writeFileSync(join(packageRoot, "LICENSE.md"), license);
	const archive = join(root, "windows.tgz");
	execFileSync("tar", ["-czf", archive, "-C", join(root, "windows"), "package"]);
	return {
		path: archive,
		license,
		artifact: {
			url: "https://example.invalid/windows.tgz",
			sha256: sha256(archive),
			version: "18.4.0-test",
			kind: "windows-x64-emulated",
		},
	};
}

test("staging rejects an artifact whose checksum does not match", async () => {
	const root = temporaryDirectory("atomic-pg-stage-checksum-");
	const packageRoot = packageDirectory(root);
	const artifactFile = join(root, "bad.jar");
	writeFileSync(artifactFile, "corrupt");
	await assert.rejects(
		stagePostgresRuntime({
			target: "linux-x64-musl",
			packageRoot,
			artifactFile,
			artifact: { url: "https://example.invalid/bad.jar", sha256: "0".repeat(64), version: "test", kind: "zonky" },
		}),
		/checksum mismatch.*expected/u,
	);
});

test("staging records symlinks and copies exact licenses and provenance", async () => {
	const root = temporaryDirectory("atomic-pg-stage-layout-");
	const packageRoot = packageDirectory(root);
	const fixture = fakeZonkyArtifact(root);
	await stagePostgresRuntime({
		target: "linux-x64-musl",
		packageRoot,
		artifactFile: fixture.path,
		artifact: fixture.artifact,
	});
	const runtime = join(packageRoot, "postgres-runtime");
	assert.equal(existsSync(join(runtime, "bin", "postgres")), true);
	assert.equal(existsSync(join(runtime, "lib", "libpq.so")), false, "npm payload must not contain a symlink");
	assert.deepEqual(JSON.parse(readFileSync(join(runtime, "pg-symlinks.json"), "utf8")), [
		{ source: "lib/libpq.so.5.18", target: "lib/libpq.so" },
	]);
	assert.equal(
		readFileSync(join(runtime, "POSTGRESQL-LICENSE"), "utf8"),
		readFileSync(join(repositoryRoot, "scripts/postgres-runtime-licenses/POSTGRESQL-LICENSE"), "utf8"),
	);
	assert.equal(
		readFileSync(join(runtime, "ZONKY-APACHE-2.0-LICENSE"), "utf8"),
		readFileSync(join(repositoryRoot, "scripts/postgres-runtime-licenses/ZONKY-APACHE-2.0-LICENSE"), "utf8"),
	);
	assert.deepEqual(JSON.parse(readFileSync(join(runtime, "runtime-provenance.json"), "utf8")), {
		target: "linux-x64-musl",
		upstreamUrl: fixture.artifact.url,
		upstreamVersion: fixture.artifact.version,
		sha256: fixture.artifact.sha256,
		innerEntry: fixture.artifact.innerEntry,
		innerSha256: fixture.artifact.innerSha256,
		emulated: false,
	});
});

test("Windows staging preserves the upstream package license verbatim and records emulation", async () => {
	const root = temporaryDirectory("atomic-pg-stage-windows-");
	const packageRoot = packageDirectory(root, {
		name: "@bastani/atomic-natives-win32-arm64-msvc",
		os: ["win32"],
		cpu: ["arm64"],
		libc: undefined,
	});
	const fixture = fakeWindowsArtifact(root);
	await stagePostgresRuntime({
		target: "windows-arm64",
		packageRoot,
		artifactFile: fixture.path,
		artifact: fixture.artifact,
	});
	const runtime = join(packageRoot, "postgres-runtime");
	assert.equal(readFileSync(join(runtime, "EMBEDDED-POSTGRES-UPSTREAM-LICENSE.md"), "utf8"), fixture.license);
	const provenance = JSON.parse(readFileSync(join(runtime, "runtime-provenance.json"), "utf8"));
	assert.equal(provenance.emulated, true);
	assert.match(provenance.emulation, /Windows x64 PostgreSQL.*Windows 11 ARM64/u);
});

test("npm pack includes the staged payload only because the leaf files list names it", async () => {
	const root = temporaryDirectory("atomic-pg-stage-pack-");
	const packageRoot = packageDirectory(root);
	const fixture = fakeZonkyArtifact(root);
	await stagePostgresRuntime({
		target: "linux-x64-musl",
		packageRoot,
		artifactFile: fixture.path,
		artifact: fixture.artifact,
	});
	const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	assert.deepEqual(manifest.os, ["linux"]);
	assert.deepEqual(manifest.cpu, ["x64"]);
	assert.deepEqual(manifest.libc, ["musl"]);
	assert.ok(manifest.files.includes("postgres-runtime"));
	const output = join(root, "packed");
	mkdirSync(output);
	const result = spawnSync("npm", ["pack", packageRoot, "--pack-destination", output], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const tarball = join(
		output,
		readdirSync(output).find((name) => name.endsWith(".tgz")),
	);
	const entries = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" }).split("\n");
	assert.ok(entries.includes("package/postgres-runtime/bin/postgres"));
	assert.ok(entries.includes("package/postgres-runtime/POSTGRESQL-LICENSE"));
	assert.ok(entries.includes("package/postgres-runtime/runtime-provenance.json"));
	assert.equal(lstatSync(tarball).isFile(), true);
});
