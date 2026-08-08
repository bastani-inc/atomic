import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { test } from "vitest";
import { repositoryRoot } from "../../vitest.base.js";

/**
 * vitest runs `setupFiles` once per test file, each with a fresh module
 * registry. Every relative import reachable from the setup file is therefore
 * transformed and instantiated ~600 times per unit run, whether or not the test
 * under it touches workflows.
 *
 * This guard exists because that cost is invisible at the call site: adding one
 * `import { SOME_CONSTANT } from "…/workflow-artifacts.js"` to the setup file
 * looks free and silently drags fifty modules — including `@bastani/atomic`
 * itself — into every test process. Measured before that import was removed:
 * a single trivial test file cost 28.37s, of which 27.79s was setup.
 *
 * The bound is deliberately close to the current graph rather than generous. It
 * is a ratchet: if a change legitimately needs a larger graph, re-measure the
 * per-file cost first and move the number with the evidence in the commit
 * message. Do not raise it to make a red test green.
 */
const SETUP_FILE = "test/setup-workflow-durability.ts";

/**
 * Current reachable count is 39, dominated by `durable/factory.ts` pulling the
 * DBOS backend. 45 leaves headroom for incidental churn inside that existing
 * subsystem while still failing loudly if another hub module is imported.
 */
const MAX_REACHABLE_MODULES = 45;

/**
 * Every static and dynamic import form that can pull a module into the graph.
 *
 * A guard that only recognizes `from "…"` can be walked straight past: a
 * side-effect import or a dynamic `import()` is a real edge that costs the same
 * transform, and matching one narrow source form would let an expensive module
 * in without tripping the ceiling. Biome enforces double quotes repo-wide, but
 * single quotes are matched too so the guard does not depend on lint ordering.
 */
const RELATIVE_SPECIFIER_PATTERNS: readonly RegExp[] = [
	/\bfrom\s*["'](\.[^"']+)["']/g, // import … from "x" / export … from "x"
	/^\s*import\s+["'](\.[^"']+)["']/gm, // side effect: import "x"
	/\bimport\s*\(\s*["'](\.[^"']+)["']/g, // dynamic: import("x")
];

/** Relative specifiers in a TypeScript source, as written (`.js` per ESM convention). */
function relativeImports(source: string): string[] {
	const found = new Set<string>();
	for (const pattern of RELATIVE_SPECIFIER_PATTERNS) {
		for (const match of source.matchAll(pattern)) {
			const specifier = match[1];
			if (specifier !== undefined) found.add(specifier);
		}
	}
	return [...found];
}

/** Every repository module transitively reachable from `entry` through relative imports. */
function reachableModules(entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [entry];

	while (pending.length > 0) {
		const current = pending.pop();
		if (current === undefined || seen.has(current)) continue;

		const absolute = join(repositoryRoot, current);
		if (!existsSync(absolute)) continue;

		seen.add(current);
		for (const specifier of relativeImports(readFileSync(absolute, "utf8"))) {
			const resolved = normalize(join(dirname(current), specifier.replace(/\.js$/, ".ts")));
			pending.push(resolved);
		}
	}

	return seen;
}

test("the vitest setup file's import graph stays small", () => {
	const reachable = reachableModules(SETUP_FILE);

	assert.ok(
		reachable.size <= MAX_REACHABLE_MODULES,
		`${SETUP_FILE} reaches ${reachable.size} modules, above the ${MAX_REACHABLE_MODULES} ceiling. ` +
			"Every one is transformed once per test file. Import a dependency-free leaf instead of a hub " +
			`module, or re-measure and move the ceiling deliberately. Reachable:\n${[...reachable].sort().join("\n")}`,
	);
});

test("the setup file does not import the workflow-artifacts hub", () => {
	const source = readFileSync(join(repositoryRoot, SETUP_FILE), "utf8");

	assert.ok(
		!source.includes("shared/workflow-artifacts.js"),
		`${SETUP_FILE} imports shared/workflow-artifacts.js, which reaches ~50 modules including ` +
			"@bastani/atomic, to read a string constant. Import shared/workflow-artifact-env.js instead.",
	);
});

test("the workflow-artifact-env leaf has no relative imports", () => {
	const leaf = "packages/workflows/src/shared/workflow-artifact-env.ts";
	const imports = relativeImports(readFileSync(join(repositoryRoot, leaf), "utf8"));

	assert.deepEqual(
		imports,
		[],
		`${leaf} must stay dependency-free: it exists so the vitest setup file can read constants ` +
			`without transforming a module graph. Found: ${imports.join(", ")}`,
	);
});

test("the leaf and the hub agree on the constants", async () => {
	const leaf = await import("../../packages/workflows/src/shared/workflow-artifact-env.js");
	const hub = await import("../../packages/workflows/src/shared/workflow-artifacts.js");

	assert.equal(hub.ENV_WORKFLOW_ARTIFACT_DIR, leaf.ENV_WORKFLOW_ARTIFACT_DIR);
	assert.equal(hub.WORKFLOW_ARTIFACT_RETENTION_MS, leaf.WORKFLOW_ARTIFACT_RETENTION_MS);
});
