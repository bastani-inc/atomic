import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "vitest";
import * as bundledManifest from "../../packages/workflows/builtin/index.js";
import { discoverStartupWorkflowsSync } from "../../packages/workflows/src/extension/discovery.js";
import {
	resolveBuiltinDefinitionSource,
	scanPossibleStagesFromSource,
} from "../../packages/workflows/src/shared/possible-stages.js";
import type { WorkflowDefinition } from "../../packages/workflows/src/shared/types.js";
import { moduleDir } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
/** The shipped layout: each bundled workflow as a built chunk beside the extension bundle. */
const shippedBuiltinDir = join(repoRoot, "packages", "coding-agent", "dist", "builtin", "workflows", "builtin");

function bundledDefinitions(): readonly Pick<WorkflowDefinition, "normalizedName">[] {
	return Object.values(bundledManifest);
}

function assertScanFindsStages(path: string): void {
	const scan = scanPossibleStagesFromSource(path);
	assert.ok(scan.hasTrackedNodes || scan.stages.length > 0, `the static scan finds no stage in ${path}`);
}

// Startup registers the bundled workflows without the zero-stage lint, which would read and tokenize every bundled
// source on every start. It is skipped only because it can never fire for them: this is that guarantee.
test("the static scan finds stages in every bundled workflow source, so the startup lint has nothing to report", () => {
	const definitions = bundledDefinitions();
	assert.ok(definitions.length > 0);
	for (const definition of definitions) {
		const source = resolveBuiltinDefinitionSource(definition.normalizedName);
		assert.ok(source, `bundled workflow ${definition.normalizedName} has no source the lint could scan`);
		assertScanFindsStages(source);
	}
});

test("the static scan finds stages in every shipped bundled workflow chunk", (context) => {
	if (!existsSync(shippedBuiltinDir)) {
		context.skip("packages/coding-agent is not built");
		return;
	}
	for (const definition of bundledDefinitions()) {
		const chunk = join(shippedBuiltinDir, `${definition.normalizedName}.js`);
		assert.ok(existsSync(chunk), `the build ships no ${definition.normalizedName}.js`);
		assertScanFindsStages(chunk);
	}
});

test("startup discovery registers every bundled workflow with no diagnostics", () => {
	const { registry, sources, errors } = discoverStartupWorkflowsSync();
	assert.deepEqual(errors, []);
	assert.deepEqual(
		sources.map((source) => source.id),
		bundledDefinitions().map((definition) => definition.normalizedName),
	);
	for (const definition of bundledDefinitions()) assert.equal(registry.get(definition.normalizedName), definition);
});
