import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { assertPiRuntimeAssets } from "../../packages/coding-agent/scripts/assert-pi-runtime-assets.js";

const root = join(import.meta.dir, "../..");
const distBuiltinDir = join(root, "packages/coding-agent/dist/builtin");
const distAppPath = join(root, "packages/coding-agent/dist/app.js");
const piVersion = "0.82.1";
const expectedArtifacts = new Map([
	[
		"@earendil-works/pi-agent-core",
		{
			integrity: "sha512-Z3kloziJIE2dmrisRckZX8zDca/gIv9/YdFAzeoqpHiLV2wsni6bL4hInNSjVKLbqT+4kqLIkph2JQLKvSepjg==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-agent-core/-/pi-agent-core-0.82.1.tgz",
		},
	],
	[
		"@earendil-works/pi-ai",
		{
			integrity: "sha512-3WFYRhEp3lQB3444EhPMBcM7zSaEUE3eJgHOR7s4081NLqbw/FsWilIKWXSua0Gv3sRr7m9xMidR3pPDE7jI/A==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.82.1.tgz",
		},
	],
	[
		"@earendil-works/pi-tui",
		{
			integrity: "sha512-9yN8hALfKaxZq7n54EMxqhFCWnMi6LHkraMJ/1YjHiATq75XrI6XDMVppn9EDtiK7Fks8hUe1SDXUTrIvwRWfQ==",
			resolved: "https://registry.npmjs.org/@earendil-works/pi-tui/-/pi-tui-0.82.1.tgz",
		},
	],
]);

const declarations = new Map([
	["packages/coding-agent", ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/intercom", ["@earendil-works/pi-tui"]],
	["packages/mcp", ["@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/subagents", ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "@earendil-works/pi-tui"]],
	["packages/web-access", ["@earendil-works/pi-tui"]],
	["packages/workflows", ["@earendil-works/pi-tui"]],
]);
const workspacePaths = [...declarations.keys(), "packages/natives"];

const publishArtifactTest = existsSync(distBuiltinDir) ? test : test.skip;
if (!existsSync(distBuiltinDir)) {
	console.warn("[pi-0.82.1-artifacts] generated publish-artifact checks skipped: packages/coding-agent/dist/builtin is not built");
}

const binaryAppTest = existsSync(distAppPath) ? test : test.skip;
if (!existsSync(distAppPath)) {
	console.warn("[pi-0.82.1-artifacts] standalone app marker check skipped: packages/coding-agent/dist/app.js is not built");
}

test("Pi v0.82.1 source declarations and lockfiles stay synchronized", async () => {
	let declarationCount = 0;
	for (const [workspace, names] of declarations) {
		const manifest = await Bun.file(join(root, workspace, "package.json")).json();
		assert.equal(manifest.version, "0.0.0");
		for (const name of names) {
			assert.equal(manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name], "^0.82.1");
			declarationCount++;
		}
	}
	assert.equal(declarationCount, 11);
	assert.equal(existsSync(join(root, "packages/cursor")), false, "removed Cursor workspace must not be recreated");
	for (const workspace of workspacePaths) {
		const manifest = await Bun.file(join(root, workspace, "package.json")).json();
		assert.equal(manifest.version, "0.0.0", workspace);
	}

	const npmLock = await Bun.file(join(root, "package-lock.json")).json();
	const shrinkwrap = await Bun.file(join(root, "packages/coding-agent/npm-shrinkwrap.json")).json();
	const bunLock = await Bun.file(join(root, "bun.lock")).text();
	for (const [name, artifact] of expectedArtifacts) {
		for (const lock of [npmLock, shrinkwrap]) {
			const entry = lock.packages[`node_modules/${name}`];
			assert.equal(entry.version, piVersion);
			assert.equal(entry.resolved, artifact.resolved);
			assert.equal(entry.integrity, artifact.integrity);
		}
		assert.ok(bunLock.includes(`${name}@${piVersion}`));
		assert.ok(bunLock.includes(artifact.integrity));
	}
	for (const lock of [npmLock, shrinkwrap]) {
		assert.equal(
			lock.packages["node_modules/@earendil-works/pi-agent-core"].dependencies["@earendil-works/pi-ai"],
			"^0.82.1",
		);
	}
});

test("protobufjs 7.6.5 is pinned in source and every packaged lock", async () => {
	const rootManifest = await Bun.file(join(root, "package.json")).json();
	const codingAgentManifest = await Bun.file(join(root, "packages/coding-agent/package.json")).json();
	assert.equal(rootManifest.overrides?.protobufjs, "7.6.5");
	assert.equal(codingAgentManifest.overrides?.protobufjs, "7.6.5");

	for (const path of ["package-lock.json", "packages/coding-agent/npm-shrinkwrap.json"]) {
		const lock = await Bun.file(join(root, path)).json();
		const entry = lock.packages["node_modules/protobufjs"];
		assert.equal(entry.version, "7.6.5", path);
		assert.equal(entry.integrity, "sha512-/FPD0nUc9jH6rfFjji9IBqOz4pcSE3CsT1m7Ep6Mdb0LxSUMj8hgl6GomOvZzpNpAqqGaXA0P3VSrZLFzIhQrw==");
	}
	const bunLock = await Bun.file(join(root, "bun.lock")).text();
	assert.ok(bunLock.includes("protobufjs@7.6.5"));
	const generator = await Bun.file(join(root, "scripts/generate-coding-agent-shrinkwrap.mjs")).text();
	assert.ok(generator.includes('"protobufjs@7.6.5"'));
	assert.equal(generator.includes("protobufjs@7.6.4"), false);
});

test("installed Pi runtime includes generated model data and bundled OAuth adapters", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules") });
});

test("binary pipelines require generated Pi model data and OAuth assets", async () => {
	const packageManifest = await Bun.file(join(root, "packages/coding-agent/package.json")).json();
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../tui"), false);
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../ai"), false);
	assert.equal(packageManifest.scripts["build:binary"].includes("--cwd ../agent"), false);
	assert.ok(packageManifest.scripts["build:binary"].includes("assert-binary-assets"));
	const releaseBuilder = await Bun.file(join(root, "scripts/build-binaries.sh")).text();
	assert.ok(releaseBuilder.includes("assert-pi-runtime-assets.ts --node-modules"));
});

publishArtifactTest("Pi v0.82.1 generated publish artifacts match source declarations", async () => {
	for (const [workspace, names] of declarations) {
		if (workspace === "packages/coding-agent") continue;
		const source = await Bun.file(join(root, workspace, "package.json")).json();
		const builtinName = workspace.slice("packages/".length);
		const generated = await Bun.file(join(distBuiltinDir, builtinName, "package.json")).json();
		assert.equal(generated.version, source.version);
		for (const name of names) {
			assert.equal(
				generated.dependencies?.[name] ?? generated.peerDependencies?.[name],
				source.dependencies?.[name] ?? source.peerDependencies?.[name],
			);
		}
	}
});

binaryAppTest("standalone app bundle embeds Pi v0.82.1 catalog and OAuth runtime markers", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules"), appBundlePath: distAppPath });
});
