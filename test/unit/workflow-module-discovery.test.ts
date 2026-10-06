import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { getWorkflowHostModules } from "../../packages/coding-agent/src/core/extensions/loader-host-modules.js";
import { extensionLoaderTestHooks } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.js";
import { discoverWorkflows } from "../../packages/workflows/src/extension/discovery.js";
import {
	loadWorkflowModule,
	validateWorkflowDefinitionShape,
	workflowModuleLoaderTestHooks,
} from "../../packages/workflows/src/extension/workflow-module-loader.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function isTypeBoxAlias(specifier: string): boolean {
	return (
		specifier === "typebox" ||
		specifier.startsWith("typebox/") ||
		specifier === "@sinclair/typebox" ||
		specifier.startsWith("@sinclair/typebox/")
	);
}

describe("workflow module host-peer aliases", () => {
	test("keeps TypeBox parity and only admits the approved workflow host aliases (#3454)", async () => {
		const extensionVirtualAliases = Object.keys(await extensionLoaderTestHooks.loadVirtualModules());
		const extensionNodeAliases = Object.keys(extensionLoaderTestHooks.getAliases());
		const hostModules = await getWorkflowHostModules();
		const workflowAliases = workflowModuleLoaderTestHooks.getVirtualModuleSpecifiers(hostModules);
		const workflowTypeBoxAliases = workflowAliases.filter(isTypeBoxAlias).sort();

		assert.deepEqual(
			workflowTypeBoxAliases,
			extensionVirtualAliases.filter(isTypeBoxAlias).sort(),
			"workflow aliases diverged from the extension loader's bundled/virtual path",
		);
		assert.deepEqual(
			workflowTypeBoxAliases,
			extensionNodeAliases.filter(isTypeBoxAlias).sort(),
			"workflow aliases diverged from the extension loader's Node/development path",
		);
		const workflowSpecificAliases = workflowAliases.filter((specifier) => !isTypeBoxAlias(specifier));
		assert.ok(workflowSpecificAliases.length > 0);
		assert.ok(
			workflowSpecificAliases.every(
				(specifier) =>
					Object.hasOwn(hostModules, specifier) ||
					specifier === "@bastani/atomic/workflows" ||
					specifier.startsWith("@bastani/atomic/workflows/") ||
					specifier === "@bastani/workflows" ||
					specifier.startsWith("@bastani/workflows/"),
			),
		);
		for (const extensionAliases of [extensionVirtualAliases, extensionNodeAliases]) {
			const sharedNonTypeBoxAliases = workflowAliases.filter(
				(specifier) => extensionAliases.includes(specifier) && !isTypeBoxAlias(specifier),
			);
			assert.deepEqual(
				sharedNonTypeBoxAliases.sort(),
				["@bastani/atomic", "@bastani/pi-ai", "@bastani/pi-ai/providers/all"].filter((specifier) =>
					extensionAliases.includes(specifier),
				),
			);
		}
		assert.ok(extensionVirtualAliases.includes("@bastani/pi-ai"));
		assert.ok(extensionNodeAliases.includes("@bastani/pi-ai"));
		assert.ok(workflowAliases.includes("@bastani/pi-ai/providers/all"));
	});
});

test("executes every TypeBox alias while discovering a production-only Git package workflow", () => {
	const packageRoot = tempDir("atomic-git-workflow-module-");
	const workflowsDir = join(packageRoot, "workflows");
	mkdirSync(workflowsDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "package.json"),
		JSON.stringify({
			name: "production-only-workflow-package",
			peerDependencies: { typebox: "*" },
			devDependencies: { typebox: "*" },
		}),
		"utf-8",
	);
	writeFileSync(
		join(workflowsDir, "typebox-aliases.ts"),
		[
			'import { Type as CanonicalType } from "typebox";',
			'import { Compile as CanonicalCompile } from "typebox/compile";',
			'import { Check as CanonicalCheck } from "typebox/value";',
			'import { Type as LegacyType } from "@sinclair/typebox";',
			'import { Compile as LegacyCompile } from "@sinclair/typebox/compile";',
			'import { Check as LegacyCheck } from "@sinclair/typebox/value";',
			"const canonicalSchema = CanonicalType.String();",
			"const legacySchema = LegacyType.String();",
			"export const aliasResults = {",
			"  canonicalRoot: canonicalSchema.type === 'string',",
			"  canonicalCompile: CanonicalCompile(canonicalSchema).Check('ok'),",
			"  canonicalValue: CanonicalCheck(canonicalSchema, 'ok'),",
			"  legacyRoot: legacySchema.type === 'string',",
			"  legacyCompile: LegacyCompile(legacySchema).Check('ok'),",
			"  legacyValue: LegacyCheck(legacySchema, 'ok'),",
			"};",
		].join("\n"),
		"utf-8",
	);
	const workflowPath = join(workflowsDir, "discovered.ts");
	writeFileSync(
		workflowPath,
		[
			'import { Type } from "typebox";',
			'import { workflow } from "@bastani/atomic/workflows";',
			'import { aliasResults } from "./typebox-aliases.js";',
			"export { aliasResults };",
			"export default workflow({ name: 'Production-only import', description: 'test', inputs: { value: Type.String() }, outputs: {}, run: async () => ({}) });",
		].join("\n"),
		"utf-8",
	);

	const loaded = loadWorkflowModule(workflowPath);
	const definition = loaded.default;
	assert.equal(validateWorkflowDefinitionShape(definition), null);
	assert.deepEqual(loaded.aliasResults, {
		canonicalRoot: true,
		canonicalCompile: true,
		canonicalValue: true,
		legacyRoot: true,
		legacyCompile: true,
		legacyValue: true,
	});
});

test("shares exact host exports across workflow files instead of evaluating project packages (#3454)", async () => {
	const host = await extensionLoaderTestHooks.loadVirtualModules();
	const providers = await import("@bastani/pi-ai/providers/all");
	const modules = await getWorkflowHostModules();
	assert.equal(modules["@bastani/atomic"], host["@bastani/atomic"]);
	assert.equal(modules["@bastani/pi-ai"], host["@bastani/pi-ai"]);
	assert.equal(modules["@bastani/pi-ai/providers/all"], providers);
	const project = tempDir("atomic-workflow-host-identity-");
	for (const name of ["atomic", "pi-ai"]) {
		const dir = join(project, "node_modules/@bastani", name);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: `@bastani/${name}`, main: "index.js" }));
		writeFileSync(join(dir, "index.js"), 'throw new Error("project module was evaluated");');
	}
	for (const name of ["first", "second"]) {
		const path = join(project, `${name}.ts`);
		writeFileSync(
			path,
			[
				'import { AuthStorage } from "@bastani/atomic";',
				'import { createModels } from "@bastani/pi-ai";',
				'import { builtinModels } from "@bastani/pi-ai/providers/all";',
				"export { AuthStorage, createModels, builtinModels };",
			].join("\n"),
		);
		const loaded = loadWorkflowModule(path, modules);
		assert.equal(loaded.AuthStorage, Reflect.get(modules["@bastani/atomic"], "AuthStorage"));
		assert.equal(loaded.createModels, Reflect.get(modules["@bastani/pi-ai"], "createModels"));
		assert.equal(loaded.builtinModels, providers.builtinModels);
	}
});

test("acquires host modules once per discovery and not for an empty project (#3454)", async () => {
	const project = tempDir("atomic-workflow-host-lazy-");
	let acquisitions = 0;
	const options = {
		cwd: project,
		homeDir: project,
		includeBundled: false,
		getWorkflowHostModules: async () => {
			acquisitions++;
			return getWorkflowHostModules();
		},
	};
	await discoverWorkflows(options);
	assert.equal(acquisitions, 0);
	const dir = join(project, ".atomic/workflows");
	mkdirSync(dir, { recursive: true });
	for (const name of ["first", "second"]) {
		writeFileSync(
			join(dir, `${name}.ts`),
			[
				'import { workflow } from "@bastani/atomic/workflows";',
				'import { AuthStorage } from "@bastani/atomic";',
				`export default workflow({ name: "${name}", description: AuthStorage.name, inputs: {}, outputs: {}, run: async () => ({}) });`,
			].join("\n"),
		);
	}
	const result = await discoverWorkflows(options);
	assert.deepEqual(
		result.errors.filter((diagnostic) => diagnostic.level === "error"),
		[],
	);
	assert.deepEqual(result.registry.names().sort(), ["first", "second"]);
	assert.equal(acquisitions, 1);
});

test("unaliased deep imports still resolve from project packages (#3454)", async () => {
	const project = tempDir("atomic-workflow-deep-import-");
	const dir = join(project, "node_modules/@bastani/pi-ai");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name: "@bastani/pi-ai", exports: { "./custom": "./custom.js" } }),
	);
	writeFileSync(join(dir, "custom.js"), 'exports.value = "project-deep-export";');
	const path = join(project, "deep.ts");
	writeFileSync(path, 'export { value } from "@bastani/pi-ai/custom";');
	assert.equal(loadWorkflowModule(path, await getWorkflowHostModules()).value, "project-deep-export");
});
