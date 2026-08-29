import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { extensionLoaderTestHooks } from "../../packages/coding-agent/src/core/extensions/loader-virtual-modules.js";
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
	test("keeps TypeBox aliases in parity without importing extension-only host modules", async () => {
		const extensionVirtualAliases = Object.keys(await extensionLoaderTestHooks.loadVirtualModules());
		const extensionNodeAliases = Object.keys(extensionLoaderTestHooks.getAliases());
		const workflowAliases = workflowModuleLoaderTestHooks.getVirtualModuleSpecifiers();
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
			assert.deepEqual(sharedNonTypeBoxAliases, []);
		}
		assert.ok(extensionVirtualAliases.includes("@bastani/pi-ai"));
		assert.ok(extensionNodeAliases.includes("@bastani/pi-ai"));
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
