import { test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";

import type { CodingAgentShrinkwrap as Shrinkwrap } from "../../scripts/generate-coding-agent-shrinkwrap.mjs";

interface PackageJson {
	name: string;
	version: string;
	dependencies?: Record<string, string>;
}

interface ShrinkwrapModule {
	generateShrinkwrap(): Promise<Shrinkwrap>;
}

const stampedReleaseVersion = "9.8.7-alpha.1";

const expectedNativeOptionalPackages = [
	"@bastani/atomic-natives-darwin-arm64",
	"@bastani/atomic-natives-darwin-x64",
	"@bastani/atomic-natives-linux-arm64-gnu",
	"@bastani/atomic-natives-linux-x64-gnu",
	"@bastani/atomic-natives-win32-arm64-msvc",
	"@bastani/atomic-natives-win32-x64-msvc",
];

function assertDeterministicNativeEntries(shrinkwrap: Shrinkwrap, expectedVersion?: string) {
	const atomicNatives = shrinkwrap.packages["node_modules/@bastani/atomic-natives"];
	assert.ok(atomicNatives, "@bastani/atomic-natives entry should be present");
	if (expectedVersion) {
		assert.equal(atomicNatives.version, expectedVersion);
	}
	const resolved = atomicNatives.resolved;
	assert.equal(typeof resolved, "string", "@bastani/atomic-natives resolved URL should be present");
	assert.match(
		resolved ?? "",
		/^https:\/\/registry\.npmjs\.org\/@bastani\/atomic-natives\/-\/atomic-natives-[^/]+\.tgz$/,
	);
	assert.equal(atomicNatives.integrity, undefined, "internal native root entry should not require registry integrity");

	const optionalDependencies = atomicNatives.optionalDependencies ?? {};
	assert.deepEqual(Object.keys(optionalDependencies).sort(), expectedNativeOptionalPackages);
	for (const packageName of expectedNativeOptionalPackages) {
		const entry = shrinkwrap.packages[`node_modules/${packageName}`];
		assert.ok(entry, `${packageName} entry should be present`);
		assert.equal(entry.version, optionalDependencies[packageName]);
		if (expectedVersion) {
			assert.equal(entry.version, expectedVersion);
			assert.equal(optionalDependencies[packageName], expectedVersion);
		}
		assert.equal(entry.optional, true);
		assert.equal(entry.integrity, undefined, `${packageName} should not require registry integrity`);
		assert.ok(entry.resolved?.includes(`${packageName}/-/`), `${packageName} should resolve to its registry tarball`);
		assert.ok(entry.os?.length, `${packageName} should declare supported OS`);
		assert.ok(entry.cpu?.length, `${packageName} should declare supported CPU`);
		if (packageName.includes("linux")) {
			assert.deepEqual(entry.libc, ["glibc"], `${packageName} should constrain the GNU build to glibc`);
		}
	}
}

async function readPackageJson(path: string): Promise<PackageJson> {
	return (await Bun.file(path).json()) as PackageJson;
}

async function writePackageJson(path: string, packageJson: PackageJson): Promise<void> {
	await Bun.write(path, `${JSON.stringify(packageJson, null, 2)}\n`);
}

async function createStampedShrinkwrapFixture(version: string): Promise<string> {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "atomic-shrinkwrap-test-"));
	mkdirSync(join(fixtureRoot, "scripts"), { recursive: true });
	mkdirSync(join(fixtureRoot, "packages/coding-agent"), { recursive: true });
	mkdirSync(join(fixtureRoot, "packages/natives"), { recursive: true });

	copyFileSync("scripts/generate-coding-agent-shrinkwrap.mjs", join(fixtureRoot, "scripts/generate-coding-agent-shrinkwrap.mjs"));
	copyFileSync("package-lock.json", join(fixtureRoot, "package-lock.json"));

	const codingAgentPackage = await readPackageJson("packages/coding-agent/package.json");
	codingAgentPackage.version = version;
	if (codingAgentPackage.dependencies?.["@bastani/atomic-natives"]) {
		codingAgentPackage.dependencies["@bastani/atomic-natives"] = version;
	}
	await writePackageJson(join(fixtureRoot, "packages/coding-agent/package.json"), codingAgentPackage);

	const nativesPackage = await readPackageJson("packages/natives/package.json");
	nativesPackage.version = version;
	await writePackageJson(join(fixtureRoot, "packages/natives/package.json"), nativesPackage);

	return fixtureRoot;
}

test("checked-in coding-agent shrinkwrap includes deterministic atomic native optional packages", async () => {
	const shrinkwrap = await Bun.file("packages/coding-agent/npm-shrinkwrap.json").json();
	assertDeterministicNativeEntries(shrinkwrap);
});

test("coding-agent shrinkwrap generation does not require npm metadata for a stamped native release version", async () => {
	const originalFetch = globalThis.fetch;
	const failFetchUse = (): never => {
		throw new Error("shrinkwrap generation must not query npm registry metadata");
	};
	const rejectingFetch: typeof fetch = Object.assign(failFetchUse, {
		preconnect: failFetchUse,
	});
	globalThis.fetch = rejectingFetch;
	const fixtureRoot = await createStampedShrinkwrapFixture(stampedReleaseVersion);

	try {
		const fixtureScriptUrl = `${pathToFileURL(join(fixtureRoot, "scripts/generate-coding-agent-shrinkwrap.mjs")).href}?stamped=${stampedReleaseVersion}`;
		const { generateShrinkwrap } = (await import(fixtureScriptUrl)) as ShrinkwrapModule;
		const shrinkwrap = await generateShrinkwrap();
		assert.equal(shrinkwrap.version, stampedReleaseVersion);
		assertDeterministicNativeEntries(shrinkwrap, stampedReleaseVersion);
	} finally {
		globalThis.fetch = originalFetch;
		rmSync(fixtureRoot, { recursive: true, force: true });
	}
});
