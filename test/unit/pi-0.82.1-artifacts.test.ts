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
		"@earendil-works/pi-agent-core",
		{
			version: "0.85.1",
			integrity: "sha512-hIXIP3eAWueAYiAl8aMvWCvvZ8Q5gT3Dip5bE5uJyIGh4+YlWRjtMLI4BaeoXoSs93zndjue61u1B/vhefLnuA==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.85.1.tgz",
		},
	],
	[
		"@earendil-works/pi-ai",
		{
			version: "0.85.1",
			integrity: "sha512-+VgVIJDkDO2efYJKEEqvPTH4zmnIaXdAppGbO+vKFA9qy5PdhFiAenuFAkU+oiCSfOC4dMHDyrjdQeL4ZoC5CQ==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.85.1.tgz",
		},
	],
	[
		"@earendil-works/pi-client",
		{
			version: "0.85.1",
			integrity: "sha512-YKZeFZTcpH7SWdeJ9IeJO+AhW5EVGRYZV2WuZ9jgMGD1hSe3+vDPlcsVqOUmYbyl/vvzPe9SzvPz+HzlYhvCLA==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-client/-/pi-client-0.85.1.tgz",
		},
	],
	[
		"@earendil-works/pi-protocol",
		{
			version: "0.85.1",
			integrity: "sha512-w+pPvmw54Z8oFmJiSbPT4OwV4Hl97PA3vaLTp7KUwVLbPx3ucaAIldGrlNVt5F3k4C/reT4I39FKmuJIyrmKdg==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-protocol/-/pi-protocol-0.85.1.tgz",
		},
	],
	[
		"@earendil-works/pi-tui",
		{
			version: "0.85.1",
			integrity: "sha512-OIzw9efInmO4WOBnD4TxcTdBjmzvYJpzslkgoUro946nEGoYWg5rwv1p4fDt3/JvMx9QybryUCUwlm7j8Dreig==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.85.1.tgz",
		},
	],
	[
		"@earendil-works/pi-telemetry",
		{
			version: "0.85.1",
			integrity: "sha512-Bg/YN6kA7Swja/NQxka8xFdecb4E/auIEGF2G5A25EaQXhRnPj300/7/KpgsDDMYUzHTDAv4RyUxaQPJKW81Rw==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-telemetry/-/pi-telemetry-0.85.1.tgz",
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
			"@earendil-works/pi-protocol",
			"@earendil-works/pi-tui",
		],
	],
	["packages/intercom", ["@earendil-works/pi-tui"]],
	["packages/mcp", ["@bastani/pi-ai", "@earendil-works/pi-tui"]],
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

test("Pi v0.85.1 source declarations and lockfiles stay synchronized", async () => {
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
	assert.equal(declarationCount, 13);
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
				assert.match(range, /^\^?0\.85\.1$/, `${lockPath}: ${packagePath} -> ${name}`);
			}
		}
	}
	assert.equal(npmLock.packages["node_modules/@bastani/pi-ai"]?.resolved, "packages/ai");
});

test("protobufjs 7.6.5 is pinned in source and every packaged lock", async () => {
	const rootManifest = await readJson<Manifest>(join(root, "package.json"));
	const codingAgentManifest = await readJson<Manifest>(join(root, "packages/coding-agent/package.json"));
	assert.equal(rootManifest.overrides?.protobufjs, "7.6.5");
	assert.equal(codingAgentManifest.overrides?.protobufjs, "7.6.5");

	for (const path of ["package-lock.json", "packages/coding-agent/npm-shrinkwrap.json"]) {
		const lock = await readJson<Lockfile>(join(root, path));
		const entry = lock.packages["node_modules/protobufjs"];
		assert.equal(entry.version, "7.6.5", path);
		assert.equal(
			entry.integrity,
			"sha512-/FPD0nUc9jH6rfFjji9IBqOz4pcSE3CsT1m7Ep6Mdb0LxSUMj8hgl6GomOvZzpNpAqqGaXA0P3VSrZLFzIhQrw==",
		);
	}
	// The bun.lock half of this assertion went with the file; the two locks above
	// already cover every published surface.
	const generator = await readText(join(root, "scripts/generate-coding-agent-shrinkwrap.mjs"));
	assert.ok(generator.includes('"protobufjs@7.6.5"'));
	assert.equal(generator.includes("protobufjs@7.6.4"), false);
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

test("binary pipelines require generated Pi model data and OAuth assets", async () => {
	const packageManifest = await readJson<Manifest>(join(root, "packages/coding-agent/package.json"));
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../tui"), false);
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../ai"), false);
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../agent"), false);
	assert.ok(packageManifest.scripts["build:binary"].includes("assert-binary-assets"));
	const releaseBuilder = await readText(join(root, "scripts/build-binaries.sh"));
	assert.ok(releaseBuilder.includes("assert-pi-runtime-assets.ts --node-modules"));
});

publishArtifactTest("Pi v0.85.1 generated publish artifacts match source declarations", async () => {
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

binaryAppTest("standalone app bundle embeds Pi v0.85.1 catalog and OAuth runtime markers", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules"), appBundlePath: distAppPath });
});
