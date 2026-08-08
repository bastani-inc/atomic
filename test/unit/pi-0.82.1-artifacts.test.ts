import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import { assertPiRuntimeAssets } from "../../packages/coding-agent/scripts/assert-pi-runtime-assets.js";
import { moduleDir, readJson, readText } from "../helpers/runtime.js";

/**
 * `Bun.file().json()` returned `any`; the Node helper returns `unknown` on
 * purpose. These are the two shapes this file actually reads.
 */
interface Manifest {
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
const piVersion = "0.84.1";
const expectedArtifacts = new Map([
	[
		"@earendil-works/pi-agent-core",
		{
			integrity: "sha512-evyzXYWCLQGmcaBYHlmSku02r8qoN4SGI60GZABo6iV+H+nqX+P9ud8fEZ4GmRq9mUSREvvfX+w9dA9ThF9C6w==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.84.1.tgz",
		},
	],
	[
		"@earendil-works/pi-ai",
		{
			integrity: "sha512-wMsAdJMxuNri08vLqTyYVI201DQQezGhPSTkzYsHdw5dYX3rCNwEmSvpaAwhi7ELKI/2tE/CEgSWg/6iRxSgdQ==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.84.1.tgz",
		},
	],
	[
		"@earendil-works/pi-client",
		{
			integrity: "sha512-/V5hGHE4Zq+jG0GtwIB9PyBUOGd6gBLZ7lkQYFKchKnxYHeH3rmWC5xw4kpnZKKBuBuFTdLVbU9vEjlAGMMb2A==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-client/-/pi-client-0.84.1.tgz",
		},
	],
	[
		"@earendil-works/pi-protocol",
		{
			integrity: "sha512-Ox1pciyeSPGEEUcxvR0/dJcrY7C6hrEGA8y71rOsvSIUlXN1Cbp/be/eoL71OGDBk5O97TeQPfWN6Ju/2Ehjww==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-protocol/-/pi-protocol-0.84.1.tgz",
		},
	],
	[
		"@earendil-works/pi-tui",
		{
			integrity: "sha512-udeXFbgEhJ6JiB0uguwNVNkDy2FENfmtQwPcY+/iJ8GWeq18wkal1tKqa5YyeH0IqtX1vG0cGh8zfSYzyzVuLA==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.84.1.tgz",
		},
	],
	[
		"@earendil-works/pi-telemetry",
		{
			integrity: "sha512-180/xGJtsq7IoR3p9EKWjRd0e9M4DkxInhlo9xyD7prDC7Qrhqq+nhvwrW0lFjPfXcEI2FSHmGCSyvSJE9GsaQ==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-telemetry/-/pi-telemetry-0.84.1.tgz",
		},
	],
]);

const declarations = new Map([
	[
		"packages/coding-agent",
		[
			"@earendil-works/pi-agent-core",
			"@earendil-works/pi-ai",
			"@earendil-works/pi-client",
			"@earendil-works/pi-protocol",
			"@earendil-works/pi-tui",
		],
	],
	["packages/intercom", ["@earendil-works/pi-tui"]],
	["packages/mcp", ["@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/subagents", ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
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

test("Pi v0.84.1 source declarations and lockfiles stay synchronized", async () => {
	let declarationCount = 0;
	for (const [workspace, names] of declarations) {
		const manifest = await readJson<Manifest>(join(root, workspace, "package.json"));
		assert.equal(manifest.version, "0.0.0");
		for (const name of names) {
			assert.equal(manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name], "^0.84.1");
			declarationCount++;
		}
	}
	assert.equal(declarationCount, 13);
	assert.equal(existsSync(join(root, "packages/cursor")), false, "removed Cursor workspace must not be recreated");
	for (const workspace of workspacePaths) {
		const manifest = await readJson<Manifest>(join(root, workspace, "package.json"));
		assert.equal(manifest.version, "0.0.0", workspace);
	}

	// bun.lock was deleted when install moved to `npm ci`. package-lock.json is
	// now the single verified lockfile: `npm ci` refuses to install when it and
	// package.json disagree, which nothing enforced while two lockfiles coexisted.
	const npmLock = await readJson<Lockfile>(join(root, "package-lock.json"));
	const shrinkwrap = await readJson<Lockfile>(join(root, "packages/coding-agent/npm-shrinkwrap.json"));
	for (const [name, artifact] of expectedArtifacts) {
		for (const lock of [npmLock, shrinkwrap]) {
			const entry = lock.packages[`node_modules/${name}`];
			assert.equal(entry.version, piVersion);
			assert.equal(entry.resolved, artifact.resolved);
			assert.equal(entry.integrity, artifact.integrity);
		}
	}
	for (const lock of [npmLock, shrinkwrap]) {
		assert.equal(
			lock.packages["node_modules/@earendil-works/pi-agent-core"]?.dependencies?.["@earendil-works/pi-ai"],
			"^0.84.1",
		);
	}
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

publishArtifactTest("Pi v0.84.1 generated publish artifacts match source declarations", async () => {
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

binaryAppTest("standalone app bundle embeds Pi v0.84.1 catalog and OAuth runtime markers", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules"), appBundlePath: distAppPath });
});
