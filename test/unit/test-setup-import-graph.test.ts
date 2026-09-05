import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { test } from "vitest";
import tsconfig from "../../tsconfig.json";
import { atomicSrcIndex, repositoryRoot, sharedAliases } from "../../vitest.base.js";
import { runtimeRequestsOf } from "./module-graph-walker.js";

/**
 * Isolated test files each evaluate the setup's runtime graph. Vite can share
 * transforms, but an eager host-barrel import still instantiates that graph in
 * every worker, even for tests that never use workflows. Follow Vitest aliases
 * as well as relative imports: the old regex missed the @bastani/atomic edge.
 */
const SETUP_FILE = "test/setup-workflow-durability.ts";
// Preserve the existing ceiling; only imports erased by the configured emit are excluded.
const MAX_REACHABLE_MODULES = 49;

function runtimeImports(file: string): string[] {
	try {
		return runtimeRequestsOf(file, tsconfig.compilerOptions).flatMap((request) =>
			request.specifier === undefined ? [] : [request.specifier],
		);
	} catch (cause) {
		throw new Error(`Cannot inspect runtime imports in ${file}`, { cause });
	}
}

function resolveImport(importer: string, specifier: string): string | undefined {
	const alias = sharedAliases.find(({ find }) =>
		typeof find === "string" ? specifier === find || specifier.startsWith(`${find}/`) : find.test(specifier),
	);
	const target = alias === undefined ? specifier : specifier.replace(alias.find, alias.replacement);
	if (!target.startsWith(".") && !isAbsolute(target)) return undefined;
	const absolute = resolve(dirname(importer), target);
	return [absolute.replace(/\.js$/u, ".ts"), absolute].find((candidate) => existsSync(candidate));
}

function reachableModules(entry: string): Set<string> {
	const seen = new Set<string>();
	const pending = [resolve(repositoryRoot, entry)];
	// Once over budget, the guard already has a counterexample; do not parse the whole host.
	while (pending.length > 0 && seen.size <= MAX_REACHABLE_MODULES) {
		const current = pending.pop();
		if (current === undefined || seen.has(current)) continue;
		seen.add(current);
		for (const specifier of runtimeImports(current)) {
			const resolved = resolveImport(current, specifier);
			if (resolved !== undefined && /\.[cm]?[jt]sx?$/u.test(resolved)) pending.push(resolved);
		}
	}
	return seen;
}

test("the vitest setup file's import graph stays small", () => {
	const reachable = reachableModules(SETUP_FILE);
	assert.ok(
		reachable.size <= MAX_REACHABLE_MODULES,
		`${SETUP_FILE} reaches ${reachable.size} modules, above the ${MAX_REACHABLE_MODULES} ceiling. ` +
			"Every one is evaluated once per isolated test file. Import a leaf instead of a hub. Reachable:\n" +
			[...reachable]
				.map((file) => relative(repositoryRoot, file))
				.sort()
				.join("\n"),
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
	assert.deepEqual(runtimeImports(join(repositoryRoot, leaf)), [], `${leaf} must stay dependency-free`);
});

test("the leaf and the hub agree on the constants", async () => {
	const leaf = await import("../../packages/workflows/src/shared/workflow-artifact-env.js");
	const hub = await import("../../packages/workflows/src/shared/workflow-artifacts.js");
	assert.equal(hub.ENV_WORKFLOW_ARTIFACT_DIR, leaf.ENV_WORKFLOW_ARTIFACT_DIR);
	assert.equal(hub.WORKFLOW_ARTIFACT_RETENTION_MS, leaf.WORKFLOW_ARTIFACT_RETENTION_MS);
});

test("the setup graph resolves the same host alias and relative source paths as Vitest", () => {
	const importer = join(repositoryRoot, SETUP_FILE);
	assert.equal(resolveImport(importer, "@bastani/atomic"), atomicSrcIndex);
	assert.equal(resolveImport(importer, "node:fs"), undefined);
	assert.equal(resolveImport(importer, "vitest"), undefined);
	assert.equal(
		resolveImport(importer, "../packages/workflows/src/durable/backend.js"),
		join(repositoryRoot, "packages/workflows/src/durable/backend.ts"),
	);
});

test("the setup graph follows runtime imports and exports but erases type-only edges", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-setup-graph-"));
	try {
		const entry = join(root, "entry.ts");
		writeFileSync(
			entry,
			[
				'import { value } from "./leaf.js";',
				'import { type Shape, mixed } from "./mixed.js";',
				'import type { OnlyType } from "./missing-type.js";',
				'import { type InlineType } from "./inline-type.js";',
				'export { value as exported } from "./export.js";',
				'export { type Shape, mixed } from "./mixed-export.js";',
				'export type * from "./missing-export-type.js";',
				'export { type InlineType } from "./missing-export-inline.js";',
				'export * from "./star.js";',
				'import "./side.js";',
				'async function load() { return import("./dynamic.js"); }',
				"const comment = 'import \"./not-an-import.js\"';",
			].join("\n"),
		);
		const expected = ["leaf", "mixed", "inline-type", "export", "mixed-export", "star", "side", "dynamic"];
		for (const name of expected) writeFileSync(join(root, `${name}.ts`), 'import "./entry.js";');
		assert.deepEqual(
			runtimeImports(entry),
			expected.map((name) => `./${name}.js`),
		);
		assert.deepEqual(reachableModules(entry), new Set([entry, ...expected.map((name) => join(root, `${name}.ts`))]));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the setup graph matches Vite's executed inline-type import side effects", async () => {
	const { transformWithOxc } = await import("vite");
	const root = mkdtempSync(join(tmpdir(), "atomic-setup-type-effects-"));
	try {
		writeFileSync(join(root, "side.mjs"), 'console.log("side-effect");');
		for (const statement of [
			'import { type Shape } from "./side.mjs";',
			'import type { Shape } from "./side.mjs";',
			'export { type Shape } from "./side.mjs";',
			'export type { Shape } from "./side.mjs";',
		]) {
			const entry = join(root, "entry.ts");
			writeFileSync(entry, statement);
			// Resolve the real repository tsconfig, rather than the temp directory's defaults.
			const { code } = await transformWithOxc(statement, join(repositoryRoot, "test/unit/type-effects.ts"));
			const runtime = join(root, "entry.mjs");
			writeFileSync(runtime, code);
			const result = spawnSync(process.execPath, [runtime], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
			const executes = result.stdout.trim() === "side-effect";
			assert.equal(executes, statement.startsWith("import {"), `${statement}\n${code}`);
			assert.deepEqual(runtimeImports(entry), executes ? ["./side.mjs"] : [], `${statement}\n${code}`);
			assert.deepEqual(runtimeRequestsOf(entry), [], "non-verbatim callers retain type erasure");
			assert.deepEqual(runtimeRequestsOf(entry, { verbatimModuleSyntax: false }), []);
			assert.equal(reachableModules(entry).has(join(root, "side.mjs")), executes);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
