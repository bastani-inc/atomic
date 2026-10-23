import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { getAllBuiltinPackageLocations } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { EXPECTED_BUILTIN_DIRECTORY_NAMES } from "../../scripts/assert-builtin-set.js";
import type { CodingAgentShrinkwrap as Shrinkwrap } from "../../scripts/generate-coding-agent-shrinkwrap.mjs";
import {
	makeTempDirectory,
	moduleDir,
	npmSpawnPrefix,
	readJson,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ADAPTER_PACKAGE = "@bastani/atomic-storage-libsql";
const DRIVER_PACKAGE = "@libsql/client";

interface PackageManifest {
	name: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	bundledDependencies?: string[];
}

test("the libSQL adapter and its driver stay out of the Atomic package, its shrinkwrap, and the builtin set (#3857)", async () => {
	const codingAgent = await readJson<PackageManifest>("packages/coding-agent/package.json");
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
		const names = Object.keys(codingAgent[field] ?? {});
		assert.deepEqual(
			names.filter((name) => name === ADAPTER_PACKAGE || name === DRIVER_PACKAGE),
			[],
			`@bastani/atomic ${field} must not pull in the libSQL adapter or driver`,
		);
	}
	assert.deepEqual(codingAgent.bundledDependencies ?? [], []);

	const shrinkwrap = await readJson<Shrinkwrap>("packages/coding-agent/npm-shrinkwrap.json");
	assert.deepEqual(
		Object.keys(shrinkwrap.packages).filter((path) => /libsql/i.test(path)),
		[],
		"the published shrinkwrap must not install libSQL",
	);

	assert.ok(!(EXPECTED_BUILTIN_DIRECTORY_NAMES as readonly string[]).includes("storage-libsql"));
	assert.ok(
		!getAllBuiltinPackageLocations().some(({ packageName }) => packageName === ADAPTER_PACKAGE),
		"the adapter package is not a builtin Atomic package",
	);
});

test("the libSQL adapter package installs its own driver and takes Atomic as a peer, never a second copy (#3856)", async () => {
	const adapter = await readJson<PackageManifest>("packages/storage-libsql/package.json");
	assert.equal(adapter.name, ADAPTER_PACKAGE);
	assert.ok(adapter.dependencies?.[DRIVER_PACKAGE], "the package installs its own driver");
	assert.equal(adapter.peerDependencies?.["@bastani/atomic"], "*");
	assert.equal(adapter.dependencies?.["@bastani/atomic"], undefined);
});

test("the libSQL adapter publishes as a tarball with its module, docs, and license and no source tree (#3857)", () => {
	// What `npm pack` selects is exactly what the release pipeline packs and publishes.
	const result = spawnSyncCollect([...npmSpawnPrefix(), "pack", "--dry-run", "--json", "--ignore-scripts"], {
		cwd: join(moduleDir(import.meta.url), "../../packages/storage-libsql"),
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const [packed] = JSON.parse(result.stdout.toString()) as { name: string; files: { path: string }[] }[];
	assert.equal(packed?.name, ADAPTER_PACKAGE);
	assert.deepEqual(packed?.files.map(({ path }) => path).sort(), [
		"CHANGELOG.md",
		"LICENSE",
		"README.md",
		"libsql.d.ts",
		"libsql.js",
		"package.json",
	]);
});

/** Packing the real npm artifact and launching its plain-Node consumer. */
const PACKED_ADAPTER_TIMEOUT_MS = 120_000;
test(
	"the packed libSQL adapter imports in plain Node outside the workspace (#3857)",
	() => {
		const root = join(moduleDir(import.meta.url), "../..");
		const directory = makeTempDirectory("libsql-packed-import-");
		try {
			const packed = spawnSyncCollect(
				[...npmSpawnPrefix(), "pack", "--json", "--ignore-scripts", "--pack-destination", directory],
				{ cwd: join(root, "packages/storage-libsql") },
			);
			assert.equal(packed.exitCode, 0, packed.stderr.toString());
			const [{ filename }] = JSON.parse(packed.stdout.toString()) as { filename: string }[];
			const packageDir = join(directory, "node_modules", ADAPTER_PACKAGE);
			mkdirSync(packageDir, { recursive: true });
			const extracted = spawnSyncCollect([
				"tar",
				"-xf",
				join(directory, filename!),
				"-C",
				packageDir,
				"--strip-components=1",
			]);
			assert.equal(extracted.exitCode, 0, extracted.stderr.toString());
			mkdirSync(join(directory, "node_modules/@libsql"), { recursive: true });
			const linkType = process.platform === "win32" ? "junction" : "dir";
			symlinkSync(
				join(root, "node_modules/@libsql/client"),
				join(directory, "node_modules/@libsql/client"),
				linkType,
			);
			symlinkSync(join(root, "packages/coding-agent"), join(directory, "node_modules/@bastani/atomic"), linkType);
			writeFileSync(
				join(directory, "smoke.mjs"),
				`import assert from "node:assert/strict";
import adapter, { openLibsqlDatabase } from "${ADAPTER_PACKAGE}";
assert.equal(typeof openLibsqlDatabase, "function");
assert.equal(adapter.atomicStorageAdapter, 1);
assert.equal(typeof adapter.openDatabase, "function");
`,
			);
			const consumer = spawnSyncCollect([process.execPath, "smoke.mjs"], { cwd: directory });
			assert.equal(consumer.exitCode, 0, consumer.stderr.toString());
		} finally {
			removeTempDirectory(directory);
		}
	},
	PACKED_ADAPTER_TIMEOUT_MS,
);
