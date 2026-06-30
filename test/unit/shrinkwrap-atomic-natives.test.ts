import { test } from "bun:test";
import assert from "node:assert/strict";

test("checked-in coding-agent shrinkwrap includes generated atomic native optional packages", async () => {
	const shrinkwrap = await Bun.file("packages/coding-agent/npm-shrinkwrap.json").json();
	const atomicNatives = shrinkwrap.packages["node_modules/@bastani/atomic-natives"];
	assert.ok(atomicNatives, "@bastani/atomic-natives entry should be present");

	const optionalDependencies = atomicNatives.optionalDependencies ?? {};
	const expectedPackages = [
		"@bastani/atomic-natives-darwin-arm64",
		"@bastani/atomic-natives-darwin-x64",
		"@bastani/atomic-natives-linux-arm64-gnu",
		"@bastani/atomic-natives-linux-x64-gnu",
		"@bastani/atomic-natives-win32-arm64-msvc",
		"@bastani/atomic-natives-win32-x64-msvc",
	];

	assert.deepEqual(Object.keys(optionalDependencies).sort(), expectedPackages);
	for (const packageName of expectedPackages) {
		const entry = shrinkwrap.packages[`node_modules/${packageName}`];
		assert.ok(entry, `${packageName} entry should be present`);
		assert.equal(entry.version, optionalDependencies[packageName]);
		assert.equal(entry.optional, true);
		assert.ok(entry.resolved?.includes(`${packageName}/-/`), `${packageName} should resolve to its registry tarball`);
		assert.ok(entry.os?.length, `${packageName} should declare supported OS`);
		assert.ok(entry.cpu?.length, `${packageName} should declare supported CPU`);
		if (packageName.includes("linux")) {
			assert.deepEqual(entry.libc, ["glibc"], `${packageName} should constrain the GNU build to glibc`);
		}
	}
});
