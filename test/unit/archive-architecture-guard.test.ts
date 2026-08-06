import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import {
	ARCHIVE_TARGETS,
	type ArchivePlatform,
	assertArchiveArchitecture,
	findArchiveArchitectureMismatches,
	MULTI_TARGET_PACKAGE_FAMILIES,
} from "../../packages/coding-agent/scripts/assert-archive-architecture.js";

/**
 * Atomic 0.9.12 shipped `@esbuild/linux-x64` inside `atomic-linux-arm64.tar.gz` and
 * `atomic-darwin-arm64.tar.gz` because every archive is built on one runner and gets that
 * runner's `node_modules` verbatim. These tests pin the guard that now runs before each
 * archive is created.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const buildScriptPath = join(repoRoot, "scripts/build-binaries.sh");

interface StagedPackage {
	readonly name: string;
	readonly os?: readonly string[];
	readonly cpu?: readonly string[];
	readonly libc?: readonly string[];
}

function stageArchive(packages: readonly StagedPackage[]): string {
	const archiveRoot = mkdtempSync(join(tmpdir(), "archive-arch-"));
	for (const staged of packages) {
		const directory = join(archiveRoot, "node_modules", ...staged.name.split("/"));
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({ name: staged.name, version: "1.0.0", os: staged.os, cpu: staged.cpu, libc: staged.libc }),
			"utf8",
		);
	}
	return archiveRoot;
}

describe("archive architecture guard", () => {
	test("rejects an arm64 archive containing @esbuild/linux-x64", () => {
		const archiveRoot = stageArchive([{ name: "@esbuild/linux-x64", os: ["linux"], cpu: ["x64"] }]);

		assert.throws(
			() => assertArchiveArchitecture({ archiveRoot, platform: "linux-arm64" }),
			(error: unknown) => {
				assert.ok(error instanceof Error);
				assert.match(error.message, /Wrong-architecture packages staged for the linux-arm64 archive/u);
				assert.ok(error.message.includes("node_modules/@esbuild/linux-x64"), error.message);
				assert.ok(error.message.includes("os=linux cpu=x64"), error.message);
				assert.ok(error.message.includes("expected os=linux cpu=arm64 libc=glibc"), error.message);
				return true;
			},
		);
	});

	test("rejects the same package in the darwin-arm64 archive that 0.9.12 shipped it in", () => {
		const archiveRoot = stageArchive([{ name: "@esbuild/linux-x64", os: ["linux"], cpu: ["x64"] }]);

		assert.throws(() => assertArchiveArchitecture({ archiveRoot, platform: "darwin-arm64" }), /@esbuild\/linux-x64/u);
	});

	test("accepts a package that matches the archive target", () => {
		const archiveRoot = stageArchive([{ name: "@esbuild/linux-arm64", os: ["linux"], cpu: ["arm64"] }]);

		assert.deepEqual(findArchiveArchitectureMismatches({ archiveRoot, platform: "linux-arm64" }), []);
		assertArchiveArchitecture({ archiveRoot, platform: "linux-arm64" });
	});

	test("accepts packages that declare no platform at all", () => {
		const archiveRoot = stageArchive([{ name: "jiti" }, { name: "@bastani/atomic-natives" }]);

		assert.deepEqual(findArchiveArchitectureMismatches({ archiveRoot, platform: "windows-arm64" }), []);
	});

	test("separates glibc from musl archives through the libc field", () => {
		const archiveRoot = stageArchive([
			{ name: "@bastani/atomic-natives-linux-x64-gnu", os: ["linux"], cpu: ["x64"], libc: ["glibc"] },
		]);

		assert.deepEqual(findArchiveArchitectureMismatches({ archiveRoot, platform: "linux-x64" }), []);
		assert.throws(() => assertArchiveArchitecture({ archiveRoot, platform: "linux-x64-musl" }), /libc=glibc/u);
	});

	test("honors npm's negated os entries", () => {
		const archiveRoot = stageArchive([{ name: "not-on-windows", os: ["!win32"] }]);

		assert.deepEqual(findArchiveArchitectureMismatches({ archiveRoot, platform: "linux-x64" }), []);
		assert.throws(() => assertArchiveArchitecture({ archiveRoot, platform: "windows-x64" }), /not-on-windows/u);
	});

	test("exempts only the families the build stages for every target on purpose", () => {
		assert.deepEqual(
			MULTI_TARGET_PACKAGE_FAMILIES.map((family) => family.prefix),
			["@mariozechner/clipboard-"],
		);
		for (const family of MULTI_TARGET_PACKAGE_FAMILIES) assert.ok(family.reason.length > 0);

		const archiveRoot = stageArchive([
			{ name: "@mariozechner/clipboard-darwin-arm64", os: ["darwin"], cpu: ["arm64"] },
			{ name: "@mariozechner/clipboard-linux-x64-gnu", os: ["linux"], cpu: ["x64"] },
		]);

		assert.deepEqual(findArchiveArchitectureMismatches({ archiveRoot, platform: "windows-x64" }), []);
	});

	test("reports every mismatch, not just the first", () => {
		const archiveRoot = stageArchive([
			{ name: "@esbuild/linux-x64", os: ["linux"], cpu: ["x64"] },
			{ name: "@embedded-postgres/linux-x64", os: ["linux"], cpu: ["x64"] },
			{ name: "jiti" },
		]);

		const mismatches = findArchiveArchitectureMismatches({ archiveRoot, platform: "darwin-arm64" });

		assert.deepEqual(
			mismatches.map((mismatch) => mismatch.name),
			["@embedded-postgres/linux-x64", "@esbuild/linux-x64"],
		);
	});

	test("covers every platform the build script can produce", () => {
		const buildScript = readFileSync(buildScriptPath, "utf8");
		const declared =
			buildScript
				.match(/PLATFORMS=\((darwin-arm64[^)]*)\)/u)?.[1]
				?.trim()
				.split(/\s+/u) ?? [];

		assert.ok(declared.length > 0);
		assert.deepEqual([...declared].sort(), Object.keys(ARCHIVE_TARGETS).sort());
		for (const platform of declared) {
			assert.ok(ARCHIVE_TARGETS[platform as ArchivePlatform] !== undefined, platform);
		}
	});

	test("the build script runs the guard for every archive before creating it", () => {
		const buildScript = readFileSync(buildScriptPath, "utf8");
		const stagingLoop = buildScript.slice(
			buildScript.indexOf('cp -r "$runtime_deps_dir" "binaries/$platform/node_modules"'),
			buildScript.indexOf("==> Creating release archives"),
		);

		assert.match(
			stagingLoop,
			/bun run \.\.\/\.\.\/packages\/coding-agent\/scripts\/assert-archive-architecture\.ts "binaries\/\$platform" --platform "\$platform"/u,
		);
		// Pruning the foreign embedded-postgres leaves is what lets the guard stay strict.
		assert.match(stagingLoop, /embedded_postgres_leaf="\$\(embedded_postgres_package_name "\$platform"\)"/u);

		const syntax = spawnSync("bash", ["-n", buildScriptPath], { encoding: "utf8" });
		assert.equal(syntax.status, 0, syntax.stderr);
	});
});

describe("npm platform-field semantics", () => {
	/**
	 * The first revision of this guard assumed every platform field was an array
	 * and treated a missing target value as a match. Both are wrong against real
	 * npm manifests, and the array assumption is the dangerous one: a valid
	 * `"os": "linux"` string threw `declared.filter is not a function`, which
	 * would have aborted the release build the first time the guard ran on a real
	 * archive rather than rejecting a bad package.
	 */
	const makeArchive = (packages: Record<string, object>): string => {
		const root = mkdtempSync(join(tmpdir(), "archive-platform-fields-"));
		for (const [name, manifest] of Object.entries(packages)) {
			const dir = join(root, "node_modules", name);
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
		}
		return root;
	};

	const flagged = (root: string, platform: ArchivePlatform): string[] =>
		findArchiveArchitectureMismatches({ archiveRoot: root, platform }).map((entry) => entry.name);

	test("a string-valued os/cpu field is accepted rather than throwing", () => {
		const root = makeArchive({ "str-form": { os: "linux", cpu: "arm64" } });
		assert.deepEqual(flagged(root, "linux-arm64"), []);
		assert.deepEqual(flagged(root, "darwin-arm64"), ["str-form"]);
	});

	test("npm's `any` wildcard matches every platform", () => {
		const root = makeArchive({ "wildcard-pkg": { os: ["any"], cpu: ["any"] } });
		for (const platform of Object.keys(ARCHIVE_TARGETS) as ArchivePlatform[]) {
			assert.deepEqual(flagged(root, platform), [], `expected no mismatch on ${platform}`);
		}
	});

	test("a libc-pinned package is rejected on a target with no libc", () => {
		// Treating an unknown target value as a match let `libc: ["glibc"]` pass a
		// Darwin archive, which is exactly the class of bug this guard exists for.
		const root = makeArchive({ "glibc-only": { libc: ["glibc"] } });
		assert.deepEqual(flagged(root, "darwin-arm64"), ["glibc-only"]);
	});

	test("negation still excludes, and a genuine mismatch is still caught", () => {
		const root = makeArchive({
			"not-darwin": { os: ["!darwin"] },
			"wrong-cpu": { os: ["linux"], cpu: ["x64"] },
		});
		assert.deepEqual(flagged(root, "darwin-arm64").sort(), ["not-darwin", "wrong-cpu"]);
		assert.deepEqual(flagged(root, "linux-arm64"), ["wrong-cpu"]);
	});

	test("an explicit exclusion outranks the `any` wildcard", () => {
		// npm treats `!x` as a hard deny, so a package that opts out of a platform
		// must be rejected there even when it also declares the wildcard. An
		// earlier revision returned as soon as it saw `any`, which accepted
		// exactly the package the author took the trouble to exclude.
		const root = makeArchive({
			"any-but-not-windows": { os: ["any", "!win32"] },
			"any-but-not-arm64": { cpu: ["any", "!arm64"] },
		});
		assert.deepEqual(flagged(root, "windows-x64"), ["any-but-not-windows"]);
		assert.deepEqual(flagged(root, "linux-arm64"), ["any-but-not-arm64"]);
		// Neither exclusion applies here, so the wildcard governs and both pass.
		assert.deepEqual(flagged(root, "darwin-x64"), []);
	});
});
