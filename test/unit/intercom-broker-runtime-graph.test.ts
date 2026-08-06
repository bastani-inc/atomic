import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

/**
 * The intercom broker runs as a detached subprocess. It never inherits the host extension
 * loader's `@bastani/atomic` alias and standalone archives ship no physical copy of that
 * package, so any runtime edge from the broker entrypoint to a non-`node:` package makes the
 * broker fail to start (issue #2208). This walks the real import graph from the real source,
 * rather than comparing against a hand-maintained list of files.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const brokerEntrypoint = join(repoRoot, "packages/intercom/broker/broker.ts");
const spawnModule = join(repoRoot, "packages/intercom/broker/spawn.ts");
const groupModule = join(repoRoot, "packages/intercom/group.ts");

const nodeBuiltins = new Set(builtinModules);

interface RuntimeImport {
	readonly specifier: string;
	readonly importer: string;
}

/** Replace comment bodies with spaces so import syntax inside comments is never matched. */
function blankComments(source: string): string {
	let output = "";
	let index = 0;
	while (index < source.length) {
		const two = source.slice(index, index + 2);
		if (two === "//") {
			const end = source.indexOf("\n", index);
			const stop = end === -1 ? source.length : end;
			output += " ".repeat(stop - index);
			index = stop;
			continue;
		}
		if (two === "/*") {
			const end = source.indexOf("*/", index + 2);
			const stop = end === -1 ? source.length : end + 2;
			output += source.slice(index, stop).replace(/[^\n]/gu, " ");
			index = stop;
			continue;
		}
		const char = source[index] ?? "";
		if (char === '"' || char === "'" || char === "`") {
			let cursor = index + 1;
			while (cursor < source.length) {
				if (source[cursor] === "\\") {
					cursor += 2;
					continue;
				}
				if (source[cursor] === char) break;
				cursor += 1;
			}
			const stop = Math.min(cursor + 1, source.length);
			output += source.slice(index, stop);
			index = stop;
			continue;
		}
		output += char;
		index += 1;
	}
	return output;
}

/**
 * `import type ...` and `export type ...` erase at runtime, and so does a named import whose
 * every specifier carries its own `type` keyword. Anything else keeps a runtime edge.
 */
function isTypeOnlyClause(clause: string): boolean {
	const trimmed = clause.trim();
	if (/^type\b/u.test(trimmed)) return true;
	const braces = trimmed.match(/^\{([\s\S]*)\}$/u);
	if (!braces) return false;
	const specifiers = (braces[1] ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (specifiers.length === 0) return false;
	return specifiers.every((entry) => /^type\b/u.test(entry));
}

function runtimeImportsOf(filePath: string): string[] {
	const source = blankComments(readFileSync(filePath, "utf8"));
	const specifiers: string[] = [];

	const fromDeclaration = /(?:^|\n)[ \t]*(?:import|export)\b([^;]*?)\bfrom\s*["']([^"']+)["']/gu;
	for (const match of source.matchAll(fromDeclaration)) {
		if (isTypeOnlyClause(match[1] ?? "")) continue;
		specifiers.push(match[2] ?? "");
	}

	const sideEffectImport = /(?:^|\n)[ \t]*import\s*["']([^"']+)["']/gu;
	for (const match of source.matchAll(sideEffectImport)) specifiers.push(match[1] ?? "");

	const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu;
	for (const match of source.matchAll(dynamicImport)) specifiers.push(match[1] ?? "");

	return specifiers;
}

function resolveRelative(importer: string, specifier: string): string | undefined {
	const base = resolve(dirname(importer), specifier);
	const candidates = [base.replace(/\.js$/u, ".ts"), `${base}.ts`, join(base, "index.ts"), base];
	return candidates.find((candidate) => existsSync(candidate) && candidate.endsWith(".ts"));
}

interface GraphWalk {
	readonly visited: string[];
	readonly externals: RuntimeImport[];
	readonly unresolved: RuntimeImport[];
}

function walkRuntimeGraph(entrypoint: string): GraphWalk {
	const visited = new Set<string>();
	const externals: RuntimeImport[] = [];
	const unresolved: RuntimeImport[] = [];
	const queue = [entrypoint];

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || visited.has(current)) continue;
		visited.add(current);

		for (const specifier of runtimeImportsOf(current)) {
			if (specifier.startsWith("node:")) continue;
			if (nodeBuiltins.has(specifier)) continue;
			if (specifier.startsWith(".") || specifier.startsWith("/")) {
				const resolved = resolveRelative(current, specifier);
				if (resolved === undefined) {
					unresolved.push({ specifier, importer: current });
					continue;
				}
				queue.push(resolved);
				continue;
			}
			externals.push({ specifier, importer: current });
		}
	}

	return { visited: [...visited], externals, unresolved };
}

function describeImports(imports: RuntimeImport[]): string[] {
	return imports.map((entry) => `${relative(repoRoot, entry.importer)} -> ${entry.specifier}`);
}

describe("intercom broker runtime module graph", () => {
	test("no module reachable from broker.ts imports a non-node: package at runtime", () => {
		const walk = walkRuntimeGraph(brokerEntrypoint);

		assert.deepEqual(describeImports(walk.unresolved), []);
		assert.deepEqual(describeImports(walk.externals), []);
	});

	test("the walk actually reaches group.ts and never reaches parent-side spawn.ts", () => {
		const walk = walkRuntimeGraph(brokerEntrypoint);

		// Without this the first test would pass vacuously if the walker stopped early.
		assert.ok(walk.visited.includes(groupModule), `group.ts not reached: ${describeImports([])}`);
		assert.equal(walk.visited.includes(spawnModule), false);
		assert.ok(walk.visited.length >= 8, `unexpectedly small graph: ${walk.visited.length}`);
	});

	test("spawn.ts is parent-side and is allowed to keep its host-package import", () => {
		assert.ok(runtimeImportsOf(spawnModule).includes("@bastani/atomic"));
	});

	test("the walker reports a reintroduced host-package import instead of ignoring it", () => {
		const fixtureRoot = mkdtempSync(join(tmpdir(), "intercom-graph-fixture-"));
		mkdirSync(join(fixtureRoot, "broker"), { recursive: true });
		const entry = join(fixtureRoot, "broker", "broker.ts");
		const leaf = join(fixtureRoot, "leaf.ts");
		writeFileSync(
			entry,
			[
				'import net from "node:net";',
				'import type { Unused } from "../types.js";',
				'import { helper } from "../leaf.js";',
				"export const port = net && helper && ({} as Unused);",
				"",
			].join("\n"),
			"utf8",
		);
		writeFileSync(
			leaf,
			['import { getEnvValue } from "@bastani/atomic";', "export const helper = getEnvValue;", ""].join("\n"),
			"utf8",
		);

		const walk = walkRuntimeGraph(entry);

		assert.deepEqual(describeImports(walk.externals), [`${relative(repoRoot, leaf)} -> @bastani/atomic`]);
		// The type-only `../types.js` edge erases, so it is not reported as unresolved.
		assert.deepEqual(describeImports(walk.unresolved), []);
	});
});
