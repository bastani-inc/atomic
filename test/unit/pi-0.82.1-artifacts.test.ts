import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	assertPiRuntimeAssets,
	expectedPiAiPackage,
	expectedPiVersion,
} from "../../packages/coding-agent/scripts/assert-pi-runtime-assets.js";
import { moduleDir, readJson, readText } from "../helpers/runtime.js";

/**
 * `Bun.file().json()` returned `any`; the Node helper returns `unknown` on
 * purpose. These are the two shapes this file actually reads.
 */
interface Manifest {
	name?: string;
	version?: string;
	scripts: Record<string, string>;
	overrides?: Record<string, string>;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
}

interface Lockfile {
	packages: Record<
		string,
		{ version: string; resolved: string; integrity: string; dependencies?: Record<string, string> }
	>;
}

const root = join(moduleDir(import.meta.url), "../..");
const distBuiltinDir = join(root, "packages/coding-agent/dist/builtin");
const distAppPath = join(root, "packages/coding-agent/dist/app.js");
/**
 * One constant drives the whole version contract: the runtime-asset assertion
 * (which reads the installed `@bastani/pi-ai`), the lockfile entries, and
 * the workspace manifest ranges below.
 */
const piVersion = expectedPiVersion;
const expectedArtifacts = new Map([
	[
		"@earendil-works/chord",
		{
			version: "1.0.0",
			integrity: "sha512-BIfWfrByM0pKq6tfKYXuwx0ed2CvaqIM3EDA7Dps+fP+d3CiPWdlHi1cDsJC05llqKJoRz5//G0hz0yQwwjISQ==",
			resolved: "https://registry.npmjs.org/@earendil-works/chord/-/chord-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-agent-core",
		{
			version: "1.0.0",
			integrity: "sha512-bHFONjtEBDqiV+g1DmmtkSlfAaqHELr+XO+6I5Nah4gswwZrLJO4yZB/JjsnlI4AKWTayBLfgS6DCbeBBz9e2Q==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-ai",
		{
			version: "1.0.0",
			integrity: "sha512-3/W1vdDaVtpeMd23ElvJC12HLA5yS/BGqqcXF+0SK082dN7cbgNcCwguTBRBC258Ke8SzSvUW1B75iAf8w8IxA==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-client",
		{
			version: "1.0.0",
			integrity: "sha512-vK7v5eyD+e0JWk8UWWwTRATXVxjqL811cDjoqfXcd2mhe8rC8eHoRQw6d4Zfh857KrWVLNSR0v7snPX3Gu8FSQ==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-client/-/pi-client-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-protocol",
		{
			version: "1.0.0",
			integrity: "sha512-RzBfALctfmvVE7IyZy4tr5N0GgHDSt+U4opzPbbcqunZxB7V6MG8HT1wsKRX6/KphXh39NddG1A5Z/Xjf3zrGg==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-protocol/-/pi-protocol-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-tui",
		{
			version: "1.0.0",
			integrity: "sha512-JsT7kXnpZA2YOtQu6RyriyxEO0eJIzPyfiH09bH+OLN5+s18HYkwaUD/tBkjhnSfMu6/50CQPRYJagzSP6HdPw==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-telemetry",
		{
			version: "1.0.0",
			integrity: "sha512-WjNBj5TYIiPZFQEz2WlULcDwPLaKwIlmsKjVeYM+LJSbnSp38kWsHUJysIDGnu23IcLbKoPtywsvYfUJCeZePA==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-telemetry/-/pi-telemetry-1.0.0.tgz",
		},
	],
	[
		"@earendil-works/pi-codemode",
		{
			version: "1.0.0",
			integrity: "sha512-LPpFI4+T9NzDnhBDs15izWAolaoM8xnwqdziRd6Zx8BQeoEPvzefD2vMMzSyF0rOtq34TfQqkZ0ki16f6cGdMg==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-codemode/-/pi-codemode-1.0.0.tgz",
		},
	],
]);

const declarations = new Map([
	[
		"packages/coding-agent",
		[
			"@earendil-works/pi-agent-core",
			"@bastani/pi-ai",
			"@earendil-works/pi-client",
			"@earendil-works/pi-codemode",
			"@earendil-works/pi-protocol",
			"@earendil-works/pi-tui",
		],
	],
	["packages/intercom", ["@earendil-works/pi-tui"]],
	["packages/mcp", []],
	["packages/subagents", ["@earendil-works/pi-agent-core", "@bastani/pi-ai", "@earendil-works/pi-tui"]],
	["packages/web-access", ["@earendil-works/pi-tui"]],
	["packages/workflows", ["@earendil-works/pi-tui"]],
]);
const workspacePaths = [...declarations.keys(), "packages/natives"];

const publishArtifactTest = existsSync(distBuiltinDir) ? test : test.skip;
if (!existsSync(distBuiltinDir)) {
	console.warn(
		"[pi-0.82.1-artifacts] generated publish-artifact checks skipped: packages/coding-agent/dist/builtin is not built",
	);
}

const binaryAppTest = existsSync(distAppPath) ? test : test.skip;
if (!existsSync(distAppPath)) {
	console.warn(
		"[pi-0.82.1-artifacts] standalone app marker check skipped: packages/coding-agent/dist/app.js is not built",
	);
}

test("Pi v1.0.0 source declarations and lockfiles stay synchronized", async () => {
	let declarationCount = 0;
	let externalDeclarationCount = 0;
	for (const [workspace, names] of declarations) {
		const manifest = await readJson<Manifest>(join(root, workspace, "package.json"));
		assert.equal(manifest.version, "0.0.0");
		for (const name of names) {
			const range =
				name === expectedPiAiPackage
					? workspace === "packages/coding-agent"
						? "0.0.0"
						: "*"
					: workspace === "packages/coding-agent"
						? piVersion
						: `^${piVersion}`;
			assert.equal(manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name], range);
			declarationCount++;
			if (name.startsWith("@earendil-works/pi-")) externalDeclarationCount++;
		}
	}
	const piAiManifest = await readJson<Manifest>(join(root, "packages/ai/package.json"));
	assert.equal(piAiManifest.dependencies?.["@earendil-works/pi-telemetry"], piVersion);
	externalDeclarationCount++;
	assert.equal(declarationCount, 12);
	assert.equal(externalDeclarationCount, 11);
	assert.equal(existsSync(join(root, "packages/cursor")), false, "removed Cursor workspace must not be recreated");
	for (const workspace of [...workspacePaths, "packages/ai"]) {
		const manifest = await readJson<Manifest>(join(root, workspace, "package.json"));
		assert.equal(manifest.version, "0.0.0", workspace);
	}
	assert.equal(piAiManifest.name, expectedPiAiPackage);

	// bun.lock was deleted when install moved to `npm ci`. package-lock.json is
	// now the single verified lockfile: `npm ci` refuses to install when it and
	// package.json disagree, which nothing enforced while two lockfiles coexisted.
	const npmLock = await readJson<Lockfile>(join(root, "package-lock.json"));
	const shrinkwrap = await readJson<Lockfile>(join(root, "packages/coding-agent/npm-shrinkwrap.json"));
	for (const [name, artifact] of expectedArtifacts) {
		for (const lock of [npmLock, shrinkwrap]) {
			const entry = lock.packages[`node_modules/${name}`];
			assert.equal(entry.version, artifact.version);
			assert.equal(entry.resolved, artifact.resolved);
			assert.equal(entry.integrity, artifact.integrity);
		}
	}
	for (const [lockPath, lock] of [
		["package-lock.json", npmLock],
		["packages/coding-agent/npm-shrinkwrap.json", shrinkwrap],
	] as const) {
		for (const [packagePath, entry] of Object.entries(lock.packages)) {
			for (const [name, range] of Object.entries(entry.dependencies ?? {})) {
				if (!name.startsWith("@earendil-works/pi-")) continue;
				assert.match(range, /^\^?1\.0\.0$/, `${lockPath}: ${packagePath} -> ${name}`);
			}
		}
	}
	assert.equal(npmLock.packages["node_modules/@bastani/pi-ai"]?.resolved, "packages/ai");
});

test("protobufjs 7.6.6 is pinned in source and every packaged lock", async () => {
	const rootManifest = await readJson<Manifest>(join(root, "package.json"));
	const codingAgentManifest = await readJson<Manifest>(join(root, "packages/coding-agent/package.json"));
	assert.equal(rootManifest.overrides?.protobufjs, "7.6.6");
	assert.equal(codingAgentManifest.overrides?.protobufjs, "7.6.6");

	for (const path of ["package-lock.json", "packages/coding-agent/npm-shrinkwrap.json"]) {
		const lock = await readJson<Lockfile>(join(root, path));
		const entry = lock.packages["node_modules/protobufjs"];
		assert.equal(entry.version, "7.6.6", path);
		assert.equal(
			entry.integrity,
			"sha512-dYDWdjSl5RNb7SgPxGQcRU+GtvP7s2fpkrY0r432PcOIaZ0/rBcxEZnQN67iJhFuQiVw754JDoPruPCNdGsbjg==",
		);
	}
	// The bun.lock half of this assertion went with the file; the two locks above
	// already cover every published surface.
	const generator = await readText(join(root, "scripts/generate-coding-agent-shrinkwrap.mjs"));
	assert.ok(generator.includes('"protobufjs@7.6.6"'));
	assert.equal(generator.includes("protobufjs@7.6.5"), false);
});

// pi-ai 0.84.2 replaced the Mistral SDK with a native HTTP transport (upstream
// 9dd90a49). The dependency is gone from the tree; a stale entry in either lock
// would still be installed for users, because npm-shrinkwrap.json ships inside
// @bastani/atomic.
test("the Mistral SDK is absent from every packaged lock", async () => {
	for (const path of ["package-lock.json", "packages/coding-agent/npm-shrinkwrap.json"]) {
		const lock = await readJson<Lockfile>(join(root, path));
		for (const [lockPath, entry] of Object.entries(lock.packages)) {
			assert.equal(lockPath.includes("@mistralai/mistralai"), false, `${path}: ${lockPath}`);
			assert.equal(
				Object.hasOwn(entry.dependencies ?? {}, "@mistralai/mistralai"),
				false,
				`${path}: ${lockPath} still depends on @mistralai/mistralai`,
			);
		}
	}
});

test("installed Pi runtime includes generated model data and bundled OAuth adapters", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules") });
});

test("binary and release asset gates use only the unified generated model catalog", async () => {
	for (const path of ["packages/coding-agent/scripts/assert-pi-runtime-assets.ts", ".github/workflows/publish.yml"]) {
		const source = await readText(join(root, path));
		assert.ok(source.includes("models.generated.js"), path);
		assert.equal(source.includes("image-models.generated.js"), false, path);
	}
});

test("binary pipelines require generated Pi model data and OAuth assets", async () => {
	const packageManifest = await readJson<Manifest>(join(root, "packages/coding-agent/package.json"));
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../tui"), false);
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../ai"), false);
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../agent"), false);
	assert.ok(packageManifest.scripts["build:binary"].includes("assert-binary-assets"));
	const releaseBuilder = await readText(join(root, "scripts/build-binaries.sh"));
	assert.ok(releaseBuilder.includes("assert-pi-runtime-assets.ts --node-modules"));
});

publishArtifactTest("Pi v1.0.0 generated publish artifacts match source declarations", async () => {
	for (const [workspace, names] of declarations) {
		if (workspace === "packages/coding-agent") continue;
		const source = await readJson<Manifest>(join(root, workspace, "package.json"));
		const builtinName = workspace.slice("packages/".length);
		const generated = await readJson<Manifest>(join(distBuiltinDir, builtinName, "package.json"));
		assert.equal(generated.version, source.version);
		for (const name of names) {
			assert.equal(
				generated.dependencies?.[name] ?? generated.peerDependencies?.[name],
				source.dependencies?.[name] ?? source.peerDependencies?.[name],
			);
		}
	}
});

binaryAppTest("standalone app bundle embeds Pi v1.0.0 catalog and OAuth runtime markers", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules"), appBundlePath: distAppPath });
});
