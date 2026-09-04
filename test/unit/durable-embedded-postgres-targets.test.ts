import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test } from "vitest";
import {
	hydrateBinaryLibraryLinks,
	loadEmbeddedPostgresBinaries,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";
import {
	detectLinuxLibc,
	resolveEmbeddedPostgresTarget,
} from "../../packages/workflows/src/durable/dbos-embedded-postgres-targets.js";

const originalRuntimeDirectory = process.env.ATOMIC_POSTGRES_RUNTIME_DIR;

afterEach(() => {
	if (originalRuntimeDirectory === undefined) delete process.env.ATOMIC_POSTGRES_RUNTIME_DIR;
	else process.env.ATOMIC_POSTGRES_RUNTIME_DIR = originalRuntimeDirectory;
});

function runtime(platform: "linux" | "win32" = "linux"): string {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-runtime-"));
	mkdirSync(join(root, "bin"), { recursive: true });
	const suffix = platform === "win32" ? ".exe" : "";
	for (const binary of ["pg_ctl", "initdb", "postgres"])
		writeFileSync(join(root, "bin", `${binary}${suffix}`), binary);
	return root;
}
function packagedRuntime(platform: "linux" | "win32" = "linux"): string {
	const packageRoot = mkdtempSync(join(tmpdir(), "atomic-pg-package-"));
	const root = join(packageRoot, "postgres-runtime");
	mkdirSync(join(root, "bin"), { recursive: true });
	const suffix = platform === "win32" ? ".exe" : "";
	for (const binary of ["pg_ctl", "initdb", "postgres"])
		writeFileSync(join(root, "bin", `${binary}${suffix}`), binary);
	return root;
}

function packageManifest(runtimeDirectory: string): string {
	const packageRoot = dirname(runtimeDirectory);
	const manifest = join(packageRoot, "package.json");
	writeFileSync(manifest, "{}\n");
	return manifest;
}

describe("embedded PostgreSQL target policy", () => {
	test("detects glibc, musl, and an unknown Linux libc from injected signals", () => {
		assert.equal(detectLinuxLibc({ glibcVersionRuntime: "2.39", muslLoaderExists: false }), "glibc");
		assert.equal(detectLinuxLibc({ muslLoaderExists: true }), "musl");
		assert.equal(detectLinuxLibc({ muslLoaderExists: false }), "unknown");
	});

	test("selects only matching native leaves for both musl architectures", () => {
		for (const arch of ["x64", "arm64"] as const) {
			const target = resolveEmbeddedPostgresTarget({ platform: "linux", arch, libc: "musl" });
			assert.equal(target.id, `linux-${arch}-musl`);
			assert.equal(target.nativeLeafPackageName, `@bastani/atomic-natives-linux-${arch}-musl`);
			assert.equal(target.npmPackageName, undefined, "musl must never select a glibc @embedded-postgres package");
			assert.equal(target.emulated, false);
		}
	});

	test("selects Windows x64 PostgreSQL explicitly for Windows ARM64 emulation", () => {
		const target = resolveEmbeddedPostgresTarget({ platform: "win32", arch: "arm64" });
		assert.equal(target.id, "windows-arm64");
		assert.equal(target.nativeLeafPackageName, "@bastani/atomic-natives-win32-arm64-msvc");
		assert.equal(target.npmPackageName, undefined);
		assert.equal(target.emulated, true);
		assert.match(target.reason ?? "", /Windows x64 PostgreSQL runtime.*Windows 11 x64 emulation/u);
	});

	test("keeps existing native package selection and rejects unsupported musl architectures", () => {
		assert.equal(
			resolveEmbeddedPostgresTarget({ platform: "darwin", arch: "arm64" }).npmPackageName,
			"@embedded-postgres/darwin-arm64",
		);
		assert.equal(
			resolveEmbeddedPostgresTarget({ platform: "linux", arch: "x64", libc: "glibc" }).npmPackageName,
			"@embedded-postgres/linux-x64",
		);
		assert.throws(
			() => resolveEmbeddedPostgresTarget({ platform: "linux", arch: "riscv64", libc: "musl" }),
			/Linux musl architecture riscv64/u,
		);
	});
});

describe("embedded PostgreSQL runtime resolution", () => {
	test("uses ATOMIC_POSTGRES_RUNTIME_DIR before the installed native leaf", async () => {
		const explicit = runtime();
		const leaf = packagedRuntime();
		process.env.ATOMIC_POSTGRES_RUNTIME_DIR = explicit;
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "linux", arch: "arm64", libc: "musl" },
			resolvePackage: (specifier) => {
				if (specifier === "@bastani/atomic-natives-linux-arm64-musl/package.json") return packageManifest(leaf);
				throw new Error(`not installed: ${specifier}`);
			},
		});
		assert.equal(result.postgres, join(explicit, "bin", "postgres"));
	});

	test("finds the payload in a simulated installed native leaf", async () => {
		const leaf = packagedRuntime();
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "linux", arch: "x64", libc: "musl" },
			resolvePackage: (specifier) => {
				if (specifier === "@bastani/atomic-natives-linux-x64-musl/package.json") return packageManifest(leaf);
				throw new Error(`not installed: ${specifier}`);
			},
		});
		assert.equal(result.pg_ctl, join(leaf, "bin", "pg_ctl"));
	});

	test("resolves a strict package-manager leaf through the atomic-natives dependency", async () => {
		const installation = mkdtempSync(join(tmpdir(), "atomic-pg-strict-install-"));
		const nativeRoot = join(installation, "node_modules", "@bastani", "atomic-natives");
		const leafRoot = join(nativeRoot, "node_modules", "@bastani", "atomic-natives-linux-arm64-musl");
		const leaf = join(leafRoot, "postgres-runtime");
		mkdirSync(join(leaf, "bin"), { recursive: true });
		for (const binary of ["pg_ctl", "initdb", "postgres"]) writeFileSync(join(leaf, "bin", binary), binary);
		mkdirSync(nativeRoot, { recursive: true });
		writeFileSync(join(nativeRoot, "package.json"), '{"name":"@bastani/atomic-natives"}\n');
		writeFileSync(join(leafRoot, "package.json"), '{"name":"@bastani/atomic-natives-linux-arm64-musl"}\n');
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "linux", arch: "arm64", libc: "musl" },
			moduleUrl: pathToFileURL(join(installation, "app", "extension.js")).href,
		});
		assert.equal(result.postgres, realpathSync(join(leaf, "bin", "postgres")));
	});

	test("uses the archive-local atomic-natives payload after the native leaf", async () => {
		const archive = packagedRuntime("win32");
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "win32", arch: "arm64" },
			resolvePackage: (specifier) => {
				if (specifier === "@bastani/atomic-natives/package.json") return packageManifest(archive);
				throw new Error(`not installed: ${specifier}`);
			},
		});
		assert.equal(result.postgres, join(archive, "bin", "postgres.exe"));
	});

	test("uses the existing platform package only after packaged runtime locations", async () => {
		const npmRuntime = runtime();
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "linux", arch: "x64", libc: "glibc" },
			resolvePackage: (specifier) => {
				throw new Error(`not installed: ${specifier}`);
			},
			importPackage: async (specifier) => {
				assert.equal(specifier, "@embedded-postgres/linux-x64");
				return {
					pg_ctl: join(npmRuntime, "bin", "pg_ctl"),
					initdb: join(npmRuntime, "bin", "initdb"),
				};
			},
		});
		assert.equal(result.postgres, join(npmRuntime, "bin", "postgres"));
	});

	test("reports incomplete and missing packaged runtimes with actionable remediation", async () => {
		const corrupt = mkdtempSync(join(tmpdir(), "atomic-pg-corrupt-"));
		mkdirSync(join(corrupt, "bin"));
		writeFileSync(join(corrupt, "bin", "pg_ctl"), "bad");
		await assert.rejects(
			loadEmbeddedPostgresBinaries({
				host: { platform: "linux", arch: "arm64", libc: "musl" },
				runtimeDirectory: corrupt,
				resolvePackage: (specifier) => {
					throw new Error(`not installed: ${specifier}`);
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /linux\/arm64\/musl \(target linux-arm64-musl\)/u);
				assert.match(error.message, /missing bin\/initdb/u);
				assert.match(error.message, /@bastani\/atomic-natives-linux-arm64-musl\/postgres-runtime/u);
				assert.match(error.message, /ATOMIC_POSTGRES_RUNTIME_DIR/u);
				assert.doesNotMatch(error.message, /lifecycle scripts/u);
				return true;
			},
		);
	});

	test("hydrates a staged symlink manifest", () => {
		const root = runtime();
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "lib", "libpq.so.5.18"), "library");
		writeFileSync(
			join(root, "pg-symlinks.json"),
			JSON.stringify([{ source: "lib/libpq.so.5.18", target: "lib/libpq.so" }]),
		);
		hydrateBinaryLibraryLinks(join(root, "bin", "pg_ctl"));
		assert.equal(existsSync(join(root, "lib", "libpq.so")), true);
	});

	test("copies a staged library when the filesystem refuses symlink creation", () => {
		const root = runtime();
		mkdirSync(join(root, "lib"));
		writeFileSync(join(root, "lib", "libpq.so.5.18"), "library");
		writeFileSync(
			join(root, "pg-symlinks.json"),
			JSON.stringify([{ source: "lib/libpq.so.5.18", target: "lib/libpq.so" }]),
		);
		hydrateBinaryLibraryLinks(join(root, "bin", "pg_ctl"), () => {
			throw new Error("symlinks unavailable");
		});
		assert.equal(readFileSync(join(root, "lib", "libpq.so"), "utf8"), "library");
	});

	test("preserves existing embedded-postgres native manifest paths", () => {
		const packageRoot = mkdtempSync(join(tmpdir(), "atomic-pg-existing-package-"));
		mkdirSync(join(packageRoot, "native", "bin"), { recursive: true });
		mkdirSync(join(packageRoot, "native", "lib"), { recursive: true });
		writeFileSync(join(packageRoot, "native", "bin", "pg_ctl"), "binary");
		writeFileSync(join(packageRoot, "native", "lib", "libpq.so.5"), "library");
		writeFileSync(
			join(packageRoot, "native", "pg-symlinks.json"),
			JSON.stringify([{ source: "native/lib/libpq.so.5", target: "native/lib/libpq.so" }]),
		);
		hydrateBinaryLibraryLinks(join(packageRoot, "native", "bin", "pg_ctl"));
		assert.equal(existsSync(join(packageRoot, "native", "lib", "libpq.so")), true);
	});
});
