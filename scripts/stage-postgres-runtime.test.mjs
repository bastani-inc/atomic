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
import {
	download,
	POSTGRES_RUNTIME_ARTIFACTS,
	stagePostgresRuntime,
	validatePostgresRuntime,
} from "./stage-postgres-runtime.mjs";

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
	binary[4] = 2;
	binary[5] = 1;
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
		writeFileSync(join(tree, "bin", binary), fakeMuslExecutable());
	writeFileSync(join(tree, "lib", "libpq.so.5.18"), "library");
	symlinkSync("libpq.so.5.18", join(tree, "lib", "libpq.so"));
	mkdirSync(join(tree, "share"));
	writeFileSync(join(tree, "share", "postgres.bki"), "catalog");
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
		writeFileSync(join(packageRoot, "native", "bin", binary), fakeX64PortableExecutable());
	mkdirSync(join(packageRoot, "native", "share"));
	writeFileSync(join(packageRoot, "native", "share", "postgres.bki"), "catalog");
	mkdirSync(join(packageRoot, "native", "lib"));
	writeFileSync(join(packageRoot, "native", "lib", "libpq.dll"), "library");
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

test("download retries a transient transport failure and then succeeds", async () => {
	const root = temporaryDirectory("atomic-pg-download-retry-");
	const destination = join(root, "artifact");
	let attempts = 0;
	await download("https://example.invalid/artifact", destination, {
		fetchImpl: async () => {
			attempts += 1;
			if (attempts === 1) throw new TypeError("temporary network failure");
			return new Response("artifact payload");
		},
		delay: async () => {},
	});
	assert.equal(attempts, 2);
	assert.equal(readFileSync(destination, "utf8"), "artifact payload");
});

test("download aborts never-settling requests after a finite deadline", async () => {
	const root = temporaryDirectory("atomic-pg-download-timeout-");
	const destination = join(root, "artifact");
	const signals = [];
	await assert.rejects(
		download("https://example.invalid/artifact", destination, {
			fetchImpl: async (_url, options) => {
				signals.push(options.signal);
				return new Promise((_, reject) => {
					options.signal.addEventListener("abort", () => reject(options.signal.reason), { once: true });
				});
			},
			delay: async () => {},
			timeoutMs: 5,
		}),
		(error) => error?.name === "TimeoutError",
	);
	assert.equal(signals.length, 3);
	assert.equal(
		signals.every((signal) => signal instanceof AbortSignal),
		true,
	);
	assert.equal(
		signals.every((signal) => signal.aborted),
		true,
	);
});

test("download bounds retries for persistent transient failures", async () => {
	const root = temporaryDirectory("atomic-pg-download-bounded-");
	const destination = join(root, "artifact");
	let attempts = 0;
	await assert.rejects(
		download("https://example.invalid/artifact", destination, {
			fetchImpl: async () => {
				attempts += 1;
				throw new TypeError("persistent network failure");
			},
			delay: async () => {},
		}),
		/persistent network failure/u,
	);
	assert.equal(attempts, 3);
});

test("download retries HTTP 429 and then succeeds", async () => {
	const root = temporaryDirectory("atomic-pg-download-rate-limit-");
	const destination = join(root, "artifact");
	let attempts = 0;
	await download("https://example.invalid/rate-limited", destination, {
		fetchImpl: async () => {
			attempts += 1;
			if (attempts === 1) return new Response("retry", { status: 429, statusText: "Too Many Requests" });
			return new Response("artifact payload");
		},
		delay: async () => {},
	});
	assert.equal(attempts, 2);
	assert.equal(readFileSync(destination, "utf8"), "artifact payload");
});

test("download retries a transient HTTP failure and preserves the final error shape", async () => {
	const root = temporaryDirectory("atomic-pg-download-http-retry-");
	const destination = join(root, "artifact");
	let attempts = 0;
	await assert.rejects(
		download("https://example.invalid/unavailable", destination, {
			fetchImpl: async () => {
				attempts += 1;
				return new Response("unavailable", { status: 503, statusText: "Service Unavailable" });
			},
			delay: async () => {},
		}),
		/download failed \(503 Service Unavailable\): https:\/\/example\.invalid\/unavailable/u,
	);
	assert.equal(attempts, 3);
});

test("download does not retry a permanent HTTP failure", async () => {
	const root = temporaryDirectory("atomic-pg-download-permanent-");
	const destination = join(root, "artifact");
	let attempts = 0;
	await assert.rejects(
		download("https://example.invalid/missing", destination, {
			fetchImpl: async () => {
				attempts += 1;
				return new Response("missing", { status: 404, statusText: "Not Found" });
			},
			delay: async () => {},
		}),
		/download failed \(404 Not Found\): https:\/\/example\.invalid\/missing/u,
	);
	assert.equal(attempts, 1);
});

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
	const notice = readFileSync(join(runtime, "THIRD-PARTY-NOTICE"), "utf8");
	assert.match(notice, /Windows payload.*ICU.*OpenSSL.*libcurl.*wxWidgets/u);
	assert.match(notice, /additive.*does not replace.*exact upstream license/u);
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

test("all eight release targets have pinned offline artifacts", () => {
	assert.deepEqual(Object.keys(POSTGRES_RUNTIME_ARTIFACTS).sort(), [
		"darwin-arm64",
		"darwin-x64",
		"linux-arm64",
		"linux-arm64-musl",
		"linux-x64",
		"linux-x64-musl",
		"windows-arm64",
		"windows-x64",
	]);
	for (const artifact of Object.values(POSTGRES_RUNTIME_ARTIFACTS)) {
		assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
		assert.match(artifact.version, /^18\./u);
	}
});

function targetExecutable(target) {
	if (target.startsWith("windows")) return fakeX64PortableExecutable();
	const binary = Buffer.alloc(128);
	if (target.startsWith("darwin")) {
		binary.writeUInt32LE(0xfeedfacf, 0);
		binary.writeUInt32LE(target.endsWith("x64") ? 0x01000007 : 0x0100000c, 4);
	} else {
		binary.write("\x7fELF", 0, "binary");
		binary[4] = 2;
		binary[5] = 1;
		binary.writeUInt16LE(target.includes("x64") ? 62 : 183, 18);
		const loader = target.endsWith("musl")
			? `/lib/ld-musl-${target.includes("x64") ? "x86_64" : "aarch64"}.so.1`
			: target.includes("x64")
				? "/lib64/ld-linux-x86-64.so.2"
				: "/lib/ld-linux-aarch64.so.1";
		binary.write(loader, 32);
	}
	return binary;
}

function npmArtifact(root, target, mutate = () => {}) {
	const packageRoot = join(root, "source", "package");
	const native = join(packageRoot, "native");
	mkdirSync(join(native, "bin"), { recursive: true });
	mkdirSync(join(native, "lib"));
	mkdirSync(join(native, "share", "postgresql"), { recursive: true });
	writeFileSync(join(native, "share", "postgresql", "postgres.bki"), "cluster catalog");
	for (const name of ["postgres", "initdb", "pg_ctl"]) {
		writeFileSync(
			join(native, "bin", name + (target.startsWith("windows") ? ".exe" : "")),
			targetExecutable(target),
			{ mode: 0o755 },
		);
	}
	writeFileSync(join(native, "lib", "library.1"), "library");
	writeFileSync(
		join(native, "pg-symlinks.json"),
		JSON.stringify([{ source: "native/lib/library.1", target: "native/lib/library" }]),
	);
	writeFileSync(join(packageRoot, "LICENSE.md"), "exact upstream license\n");
	mutate(native, packageRoot);
	const path = join(root, "artifact.tgz");
	execFileSync("tar", ["-czf", "artifact.tgz", "-C", "source", "package"], { cwd: root });
	return {
		path,
		artifact: {
			url: "https://example.invalid/artifact.tgz",
			sha256: sha256(path),
			version: "18.4.0-test",
			kind: target === "windows-arm64" ? "windows-x64-emulated" : "npm",
		},
	};
}

test("ordinary target staging merges physical and inherited links after relocating native root", async () => {
	const root = temporaryDirectory("atomic-pg-inherited-");
	const packageRoot = packageDirectory(root);
	const fixture = npmArtifact(root, "linux-x64", (native) => {
		symlinkSync("library.1", join(native, "lib", "physical"));
	});
	const runtime = await stagePostgresRuntime({
		target: "linux-x64",
		packageRoot,
		artifactFile: fixture.path,
		artifact: fixture.artifact,
	});
	assert.deepEqual(JSON.parse(readFileSync(join(runtime, "pg-symlinks.json"), "utf8")), [
		{ source: "lib/library.1", target: "lib/library" },
		{ source: "lib/library.1", target: "lib/physical" },
	]);
	assert.equal(readFileSync(join(runtime, "lib", "library.1"), "utf8"), "library");
	assert.equal(lstatSync(join(runtime, "bin", "initdb")).mode & 0o111, 0o111);
});

for (const [label, mutate] of [
	["missing initdb", (native) => rmSync(join(native, "bin", "initdb"))],
	["wrong CPU", (native) => writeFileSync(join(native, "bin", "initdb"), targetExecutable("linux-arm64"))],
	["wrong libc", (native) => writeFileSync(join(native, "bin", "postgres"), targetExecutable("linux-x64-musl"))],
	["missing libraries", (native) => rmSync(join(native, "lib"), { recursive: true })],
	["missing catalog", (native) => rmSync(join(native, "share"), { recursive: true })],
	["missing license", (_native, root) => rmSync(join(root, "LICENSE.md"))],
	[
		"escaping link",
		(native) =>
			writeFileSync(
				join(native, "pg-symlinks.json"),
				JSON.stringify([{ source: "../../escape", target: "lib/link" }]),
			),
	],
	[
		"missing link source",
		(native) =>
			writeFileSync(
				join(native, "pg-symlinks.json"),
				JSON.stringify([{ source: "lib/missing", target: "lib/link" }]),
			),
	],
]) {
	test(`staging fails closed on ${label}`, async () => {
		const root = temporaryDirectory("atomic-pg-invalid-");
		const packageRoot = packageDirectory(root);
		const fixture = npmArtifact(root, "linux-x64", mutate);
		await assert.rejects(
			stagePostgresRuntime({
				target: "linux-x64",
				packageRoot,
				artifactFile: fixture.path,
				artifact: fixture.artifact,
			}),
		);
		assert.equal(existsSync(join(packageRoot, "postgres-runtime")), false);
	});
}

for (const target of Object.keys(POSTGRES_RUNTIME_ARTIFACTS)) {
	test(`${target} survives scriptless npm pack/install with its complete target payload`, async () => {
		const root = temporaryDirectory("atomic-pg-all-pack-");
		const platform = target.startsWith("windows") ? "win32" : target.split("-")[0];
		const arch = target.includes("x64") ? "x64" : "arm64";
		const libc = platform === "linux" ? (target.endsWith("musl") ? "musl" : "glibc") : undefined;
		const suffix =
			platform === "win32"
				? `win32-${arch}-msvc`
				: platform === "linux" && libc === "glibc"
					? `${target}-gnu`
					: target;
		const name = `@bastani/atomic-natives-${suffix}`;
		const packageRoot = packageDirectory(root, {
			name,
			os: [platform],
			cpu: [arch],
			libc: libc ? [libc] : undefined,
			scripts: { postinstall: 'node -e "process.exit(99)"' },
		});
		const fixture = npmArtifact(root, target);
		await stagePostgresRuntime({ target, packageRoot, artifactFile: fixture.path, artifact: fixture.artifact });
		const packed = JSON.parse(
			execFileSync("npm", ["pack", packageRoot, "--ignore-scripts", "--json", "--pack-destination", root], {
				encoding: "utf8",
			}),
		)[0];
		const install = join(root, "install");
		mkdirSync(install);
		writeFileSync(
			join(install, "package.json"),
			JSON.stringify({
				name: "isolated-probe",
				version: "0.0.0",
				private: true,
				optionalDependencies: { [name]: `file:${join(root, packed.filename)}` },
			}),
		);
		// Native leaves are optional dependencies. npm applies target overrides at
		// optional reification, not its required-dependency platform check.
		execFileSync(
			"npm",
			[
				"install",
				"--ignore-scripts",
				"--offline",
				"--no-audit",
				"--no-fund",
				`--os=${platform}`,
				`--cpu=${arch}`,
				...(libc ? [`--libc=${libc}`] : []),
			],
			{ cwd: install, stdio: "pipe" },
		);
		const runtime = join(install, "node_modules", name, "postgres-runtime");
		validatePostgresRuntime(runtime, target, fixture.artifact);
		assert.deepEqual(JSON.parse(readFileSync(join(runtime, "pg-symlinks.json"), "utf8")), [
			{ source: "lib/library.1", target: "lib/library" },
		]);
		assert.throws(() =>
			validatePostgresRuntime(runtime, target === "linux-x64" ? "linux-arm64" : "linux-x64", fixture.artifact),
		);
		writeFileSync(join(runtime, "lib", "library.1"), "corrupted library");
		assert.throws(() => validatePostgresRuntime(runtime, target, fixture.artifact), /checksum mismatch/u);
	});
}

test("target validation rejects a non-ELF64 payload even with the expected machine and loader text", async () => {
	const root = temporaryDirectory("atomic-pg-class-");
	const fixture = npmArtifact(root, "linux-x64", (native) => {
		const binary = targetExecutable("linux-x64");
		binary[4] = 1;
		writeFileSync(join(native, "bin", "postgres"), binary);
	});
	await assert.rejects(
		stagePostgresRuntime({
			target: "linux-x64",
			packageRoot: packageDirectory(root),
			artifactFile: fixture.path,
			artifact: fixture.artifact,
		}),
		/ELF/u,
	);
});

test("every archive assembly replaces host optional leaves with a complete target runtime", async () => {
	const root = temporaryDirectory("atomic-pg-archives-");
	const script = readFileSync(new URL("./build-binaries.sh", import.meta.url), "utf8");
	const start = script.indexOf("    # Acquire by archive target");
	const end = script.indexOf('    rm -rf "binaries/$platform/node_modules/@bastani/atomic-natives/npm"');
	assert.ok(start !== -1 && end > start);
	const staging = script.slice(start, end);
	// Use the producer's artifact seam for tiny, local binary fixtures. The shell
	// still executes the release script's real target dispatch and pruning block.
	const bridge = join(root, "stage.mjs");
	writeFileSync(
		bridge,
		`import { stagePostgresRuntime } from ${JSON.stringify(new URL("./stage-postgres-runtime.mjs", import.meta.url).href)}; await stagePostgresRuntime({ target: process.argv[2], packageRoot: process.argv[3], ...JSON.parse(process.env.FIXTURE) });`,
	);
	for (const target of Object.keys(POSTGRES_RUNTIME_ARTIFACTS)) {
		const fixtureRoot = join(root, target);
		mkdirSync(fixtureRoot);
		const fixture = npmArtifact(fixtureRoot, target);
		const native = join(root, "binaries", target, "node_modules", "@bastani", "atomic-natives");
		mkdirSync(native, { recursive: true });
		writeFileSync(join(native, "package.json"), '{"name":"@bastani/atomic-natives"}');
		const host = join(root, "binaries", target, "node_modules", "@embedded-postgres", "wrong-host");
		mkdirSync(host, { recursive: true });
		writeFileSync(join(host, "package.json"), '{"name":"wrong-host"}');
		execFileSync("bash", ["-c", `set -euo pipefail\nnode() { shift; command node "$BRIDGE" "$@"; }\n${staging}`], {
			cwd: root,
			env: {
				...process.env,
				platform: target,
				BRIDGE: bridge,
				FIXTURE: JSON.stringify({ artifactFile: fixture.path, artifact: fixture.artifact }),
			},
		});
		assert.equal(existsSync(host), false);
		const archive = join(root, `${target}.tar.gz`);
		execFileSync("tar", ["-czf", archive, "-C", join(root, "binaries"), target]);
		const extracted = join(root, `unpacked-${target}`);
		mkdirSync(extracted);
		execFileSync("tar", ["-xzf", archive, "-C", extracted]);
		validatePostgresRuntime(
			join(extracted, target, "node_modules", "@bastani", "atomic-natives", "postgres-runtime"),
			target,
			fixture.artifact,
		);
	}
});
