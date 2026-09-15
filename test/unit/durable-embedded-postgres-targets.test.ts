import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
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
	test("ordinary targets resolve their native leaves without narrowing legacy host fallback", () => {
		for (const [platform, arch, suffix] of [
			["linux", "x64", "linux-x64-gnu"],
			["linux", "arm64", "linux-arm64-gnu"],
			["darwin", "x64", "darwin-x64"],
			["darwin", "arm64", "darwin-arm64"],
			["win32", "x64", "win32-x64-msvc"],
		] as const) {
			assert.equal(
				resolveEmbeddedPostgresTarget({ platform, arch }).nativeLeafPackageName,
				`@bastani/atomic-natives-${suffix}`,
			);
		}
		assert.equal(
			resolveEmbeddedPostgresTarget({ platform: "linux", arch: "ia32", libc: "unknown" }).npmPackageName,
			"@embedded-postgres/linux-ia32",
		);
		assert.equal(
			resolveEmbeddedPostgresTarget({ platform: "freebsd", arch: "x64" }).npmPackageName,
			"@embedded-postgres/freebsd-x64",
		);
		assert.equal(detectLinuxLibc({ glibcVersionRuntime: "2.39", muslLoaderExists: true }), "glibc");
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

	test("rejects an archive-local musl payload for a glibc host target", async () => {
		const archive = packagedRuntime();
		writeFileSync(join(archive, "runtime-provenance.json"), JSON.stringify({ target: "linux-x64-musl" }));
		await assert.rejects(
			loadEmbeddedPostgresBinaries({
				host: { platform: "linux", arch: "x64", libc: "glibc" },
				resolvePackage: (specifier) => {
					if (specifier === "@bastani/atomic-natives/package.json") return packageManifest(archive);
					throw new Error(`not installed: ${specifier}`);
				},
				importPackage: async (specifier) => {
					throw new Error(`not installed: ${specifier}`);
				},
			}),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /linux\/x64\/glibc \(target linux-x64\)/u);
				assert.match(error.message, /payload target linux-x64-musl does not match linux-x64/u);
				return true;
			},
		);
	});

	test("accepts an archive-local payload when provenance matches the host target", async () => {
		const archive = packagedRuntime();
		writeFileSync(join(archive, "runtime-provenance.json"), JSON.stringify({ target: "linux-x64-musl" }));
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "linux", arch: "x64", libc: "musl" },
			resolvePackage: (specifier) => {
				if (specifier === "@bastani/atomic-natives/package.json") return packageManifest(archive);
				throw new Error(`not installed: ${specifier}`);
			},
		});
		assert.equal(result.postgres, join(archive, "bin", "postgres"));
	});

	test("accepts a legacy archive-local payload without provenance", async () => {
		const archive = packagedRuntime("win32");
		const result = await loadEmbeddedPostgresBinaries({
			host: { platform: "win32", arch: "arm64" },
			resolvePackage: (specifier) => {
				if (specifier === "@bastani/atomic-natives/package.json") return packageManifest(archive);
				throw new Error(`not installed: ${specifier}`);
			},
		});
		assert.equal(result.pg_ctl, join(archive, "bin", "pg_ctl.exe"));
	});

	test("accepts an archive-local payload with unreadable provenance", async () => {
		const archive = packagedRuntime("win32");
		writeFileSync(join(archive, "runtime-provenance.json"), "not json");
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

	// #3073: first hydration must check aliases created earlier in the same call.
	test("rejects filesystem-equivalent conflicting targets on first hydration", () => {
		const root = runtime();
		try {
			mkdirSync(join(root, "lib"));
			writeFileSync(join(root, "lib/one"), "one");
			writeFileSync(join(root, "lib/two"), "two");
			const caseInsensitive = existsSync(join(root, "lib/ONE"));
			writeFileSync(
				join(root, "pg-symlinks.json"),
				JSON.stringify([
					{ source: "lib/one", target: "lib/Alias.dll" },
					{ source: "lib/two", target: "lib/alias.dll" },
				]),
			);
			if (caseInsensitive) {
				assert.throws(() => hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl")), /incomplete PostgreSQL runtime/u);
			} else {
				hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl"));
				assert.equal(readFileSync(join(root, "lib/Alias.dll"), "utf8"), "one");
				assert.equal(readFileSync(join(root, "lib/alias.dll"), "utf8"), "two");
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// #3073: npm manifests may refer to an alias created by an earlier entry.
	test("hydrates safe ordered alias chains with native links and copy fallback", () => {
		for (const copies of [false, true]) {
			const root = runtime();
			try {
				mkdirSync(join(root, "lib"));
				writeFileSync(join(root, "lib/base library"), "library");
				const manifest =
					'[{"source":"lib/base library","target":"lib/first"},{"source":"lib/first","target":"lib/second"}]';
				writeFileSync(join(root, "pg-symlinks.json"), manifest);
				hydrateBinaryLibraryLinks(
					join(root, "bin/pg_ctl"),
					copies
						? () => {
								throw new Error("no symlinks");
							}
						: symlinkSync,
				);
				hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl"));
				assert.equal(readFileSync(join(root, "lib/first"), "utf8"), "library");
				assert.equal(readFileSync(join(root, "lib/second"), "utf8"), "library");
				assert.equal(readFileSync(join(root, "pg-symlinks.json"), "utf8"), manifest);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	// #3073: hydration is idempotent and does not rewrite a permissive manifest.
	test("preserves duplicate entries, order, extra fields and manifest raw text", () => {
		const root = runtime();
		try {
			mkdirSync(join(root, "lib"));
			writeFileSync(join(root, "lib/library"), "library");
			const manifest =
				'[ {"source":"lib/library","target":"lib/z", "extra":true},\n {"target":"lib/a","source":"lib/library"}, {"source":"lib/library","target":"lib/z"} ]\n';
			writeFileSync(join(root, "pg-symlinks.json"), manifest);
			hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl"));
			hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl"));
			assert.equal(readFileSync(join(root, "lib/z"), "utf8"), "library");
			assert.equal(readFileSync(join(root, "lib/a"), "utf8"), "library");
			assert.equal(readFileSync(join(root, "pg-symlinks.json"), "utf8"), manifest);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// #3073: reject a dangling target without following it in the copy fallback.
	test("rejects dangling aliases without writing outside the runtime", () => {
		const root = runtime();
		try {
			mkdirSync(join(root, "lib"));
			writeFileSync(join(root, "lib/library"), "library");
			symlinkSync("../missing", join(root, "lib/alias"));
			writeFileSync(
				join(root, "pg-symlinks.json"),
				JSON.stringify([{ source: "lib/library", target: "lib/alias" }]),
			);
			assert.throws(() => hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl")), /incomplete PostgreSQL runtime/u);
			assert.equal(existsSync(join(root, "missing")), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	// #3073: malformed manifests must not silently leave a broken runtime usable.
	test("rejects malformed library aliases before hydration", () => {
		const root = runtime();
		writeFileSync(join(root, "pg-symlinks.json"), "{broken");
		assert.throws(() => hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl")), /incomplete PostgreSQL runtime/u);
	});

	// #3073: no missing or unsafe alias may be silently accepted.
	for (const alias of [
		{ source: "lib/missing", target: "lib/alias" },
		{ source: "../outside", target: "lib/alias" },
		{ source: "lib/library", target: "../outside" },
		{ source: "lib/library", target: "/absolute" },
		{ source: "lib/library", target: "C:\\outside" },
	]) {
		test(`rejects incomplete or unsafe library alias ${JSON.stringify(alias)}`, () => {
			const root = runtime();
			mkdirSync(join(root, "lib"));
			writeFileSync(join(root, "lib/library"), "library");
			writeFileSync(join(root, "pg-symlinks.json"), JSON.stringify([alias]));
			assert.throws(() => hydrateBinaryLibraryLinks(join(root, "bin/pg_ctl")), /incomplete PostgreSQL runtime/u);
		});
	}

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
