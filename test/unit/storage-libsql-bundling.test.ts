import assert from "node:assert/strict";
import { test } from "vitest";
import { getAllBuiltinPackageLocations } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { EXPECTED_BUILTIN_DIRECTORY_NAMES } from "../../scripts/assert-builtin-set.js";
import type { CodingAgentShrinkwrap as Shrinkwrap } from "../../scripts/generate-coding-agent-shrinkwrap.mjs";
import { readJson } from "../helpers/runtime.js";

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
