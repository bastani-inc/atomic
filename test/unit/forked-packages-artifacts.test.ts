import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "vitest";
import {
	assertPiRuntimeAssets,
	expectedPiAiPackage,
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

/** Atomic's forks of pi's packages and the workspace directory each one lives in. */
const forkedPackages = new Map([
	["@bastani/atomic-agent-core", "packages/agent"],
	["@bastani/atomic-ai", "packages/ai"],
	["@bastani/atomic-codemode", "packages/codemode"],
	["@bastani/atomic-schema", "packages/schema"],
	["@bastani/atomic-telemetry", "packages/telemetry"],
	["@bastani/atomic-tui", "packages/tui"],
]);

const declarations = new Map([
	[
		"packages/coding-agent",
		["@bastani/atomic-agent-core", "@bastani/atomic-ai", "@bastani/atomic-codemode", "@bastani/atomic-tui"],
	],
	["packages/intercom", ["@bastani/atomic-tui"]],
	["packages/mcp", []],
	["packages/subagents", ["@bastani/atomic-agent-core", "@bastani/atomic-ai", "@bastani/atomic-tui"]],
	["packages/web-access", ["@bastani/atomic-tui"]],
]);

const publishArtifactTest = existsSync(distBuiltinDir) ? test : test.skip;
if (!existsSync(distBuiltinDir)) {
	console.warn(
		"[forked-packages-artifacts] generated publish-artifact checks skipped: packages/coding-agent/dist/builtin is not built",
	);
}

const binaryAppTest = existsSync(distAppPath) ? test : test.skip;
if (!existsSync(distAppPath)) {
	console.warn(
		"[forked-packages-artifacts] standalone app marker check skipped: packages/coding-agent/dist/app.js is not built",
	);
}

test("forked pi packages are versionless workspaces that Atomic depends on exactly (#5174)", async () => {
	for (const [name, workspace] of forkedPackages) {
		const manifest = await readJson<Manifest>(join(root, workspace, "package.json"));
		assert.equal(manifest.name, name, workspace);
		assert.equal(manifest.version, "0.0.0", workspace);
	}
	assert.equal((await readJson<Manifest>(join(root, "packages/ai/package.json"))).name, expectedPiAiPackage);
	for (const [workspace, names] of declarations) {
		const manifest = await readJson<Manifest>(join(root, workspace, "package.json"));
		assert.equal(manifest.version, "0.0.0", workspace);
		for (const name of names) {
			// The published CLI pins each fork at its own release version; bundled extensions take the host's copy.
			const range: string | undefined = workspace === "packages/coding-agent" ? manifest.version : "*";
			assert.equal(
				manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name],
				range,
				`${workspace}: ${name}`,
			);
		}
	}
	assert.equal(existsSync(join(root, "packages/cursor")), false, "removed Cursor workspace must not be recreated");

	const npmLock = await readJson<Lockfile>(join(root, "package-lock.json"));
	for (const [name, workspace] of forkedPackages) {
		assert.equal(npmLock.packages[`node_modules/${name}`]?.resolved, workspace, name);
	}
	for (const [packagePath, entry] of Object.entries(npmLock.packages)) {
		assert.equal(packagePath.includes("@earendil-works/"), false, `package-lock.json: ${packagePath}`);
		for (const name of Object.keys(entry.dependencies ?? {})) {
			assert.equal(name.startsWith("@earendil-works/"), false, `package-lock.json: ${packagePath} -> ${name}`);
		}
	}
});

test("protobufjs 7.6.6 is pinned in source and the lockfile", async () => {
	const rootManifest = await readJson<Manifest>(join(root, "package.json"));
	const codingAgentManifest = await readJson<Manifest>(join(root, "packages/coding-agent/package.json"));
	assert.equal(rootManifest.overrides?.protobufjs, "7.6.6");
	assert.equal(codingAgentManifest.overrides?.protobufjs, "7.6.6");

	const lock = await readJson<Lockfile>(join(root, "package-lock.json"));
	const entry = lock.packages["node_modules/protobufjs"];
	assert.equal(entry.version, "7.6.6");
	assert.equal(
		entry.integrity,
		"sha512-dYDWdjSl5RNb7SgPxGQcRU+GtvP7s2fpkrY0r432PcOIaZ0/rBcxEZnQN67iJhFuQiVw754JDoPruPCNdGsbjg==",
	);
});

// pi-ai 0.84.2 replaced the Mistral SDK with a native HTTP transport (upstream
// 9dd90a49). The dependency is gone from the tree; a stale lock entry would
// still be installed by `npm ci` and tested against.
test("the Mistral SDK is absent from the lockfile", async () => {
	const lock = await readJson<Lockfile>(join(root, "package-lock.json"));
	for (const [lockPath, entry] of Object.entries(lock.packages)) {
		assert.equal(lockPath.includes("@mistralai/mistralai"), false, lockPath);
		assert.equal(
			Object.hasOwn(entry.dependencies ?? {}, "@mistralai/mistralai"),
			false,
			`${lockPath} still depends on @mistralai/mistralai`,
		);
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

publishArtifactTest("generated publish artifacts match source declarations", async () => {
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

binaryAppTest("standalone app bundle embeds the model catalog and OAuth runtime markers", () => {
	assertPiRuntimeAssets({ nodeModulesRoot: join(root, "node_modules"), appBundlePath: distAppPath });
});
