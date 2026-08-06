import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { type GraphViolation, runtimeRequestsOf, walkRuntimeGraph } from "./module-graph-walker.js";

/**
 * The intercom broker runs as a detached subprocess. It never inherits the host extension
 * loader's `@bastani/atomic` alias and standalone archives ship no physical copy of that
 * package, so any runtime edge from the broker entrypoint to a non-`node:` package makes the
 * broker fail to start (issue #2208).
 *
 * This walks the real import graph of the real source with a Babel parser, not a hand-written
 * file list and not a regex over import syntax. A regex scanner missed
 * `createRequire(import.meta.url)("@bastani/atomic")`, which loads the package just as surely
 * as a static import does.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const brokerEntrypoint = join(repoRoot, "packages/intercom/broker/broker.ts");
const spawnModulePath = join(repoRoot, "packages/intercom/broker/spawn.ts");
const groupModulePath = join(repoRoot, "packages/intercom/group.ts");

function describeViolations(violations: readonly GraphViolation[]): string[] {
	return violations.map((entry) => `${relative(repoRoot, entry.importer)} -> ${entry.description}`);
}

function fixture(files: Record<string, string>): string {
	const root = mkdtempSync(join(tmpdir(), "intercom-graph-fixture-"));
	for (const [name, contents] of Object.entries(files)) {
		const path = join(root, name);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, contents, "utf8");
	}
	return root;
}

describe("intercom broker runtime module graph", () => {
	test("no module reachable from broker.ts loads a non-node: package at runtime", () => {
		const walk = walkRuntimeGraph(brokerEntrypoint);

		assert.deepEqual(describeViolations(walk.unresolved), []);
		assert.deepEqual(describeViolations(walk.dynamic), []);
		assert.deepEqual(describeViolations(walk.externals), []);
	});

	test("the walk actually reaches group.ts and never reaches parent-side spawn.ts", () => {
		const walk = walkRuntimeGraph(brokerEntrypoint);

		// Without this the first test would pass vacuously if the walker stopped early.
		assert.ok(walk.visited.includes(groupModulePath), "group.ts not reached");
		assert.equal(walk.visited.includes(spawnModulePath), false);
		assert.ok(walk.visited.length >= 8, `unexpectedly small graph: ${walk.visited.length}`);
	});

	test("spawn.ts is parent-side and is allowed to keep its host-package import", () => {
		const specifiers = runtimeRequestsOf(spawnModulePath).map((request) => request.specifier);

		assert.ok(specifiers.includes("@bastani/atomic"));
	});
});

describe("runtime module-graph walker", () => {
	test("reports a reachable static external import", () => {
		const root = fixture({
			"broker/broker.ts": ['import { helper } from "../leaf.js";', "export const port = helper;", ""].join("\n"),
			"leaf.ts": ['import { getEnvValue } from "@bastani/atomic";', "export const helper = getEnvValue;", ""].join(
				"\n",
			),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(describeViolations(walk.externals), [
			`${relative(repoRoot, join(root, "leaf.ts"))} -> @bastani/atomic`,
		]);
	});

	test("reports a direct createRequire call, which a regex scanner missed", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import { createRequire } from "node:module";',
				'export const host = createRequire(import.meta.url)("@bastani/atomic");',
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(describeViolations(walk.externals), [
			`${relative(repoRoot, join(root, "broker/broker.ts"))} -> @bastani/atomic`,
		]);
	});

	test("follows a createRequire result through const aliases", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import { createRequire as makeRequire } from "node:module";',
				"const r = makeRequire(import.meta.url);",
				"const s = r;",
				'export const host = s("@bastani/atomic");',
				'export const resolved = r.resolve("@earendil-works/pi-tui");',
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(walk.externals.map((entry) => entry.description).sort(), [
			"@bastani/atomic",
			"@earendil-works/pi-tui",
		]);
	});

	test("reports module.createRequire and plain require", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import module from "node:module";',
				'export const host = module.createRequire(import.meta.url)("@bastani/atomic");',
				'export const other = require("typebox");',
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(walk.externals.map((entry) => entry.description).sort(), ["@bastani/atomic", "typebox"]);
	});

	test("reports computed string properties on loader objects", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import module from "node:module";',
				'export const host = module["createRequire"](import.meta.url)("@bastani/atomic");',
				'export const path = require["resolve"]("@earendil-works/pi-tui");',
				'export const builtin = process["getBuiltinModule"]("fs");',
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		// The builtin request is allowed; both package requests are reported.
		assert.deepEqual(walk.externals.map((entry) => entry.description).sort(), [
			"@bastani/atomic",
			"@earendil-works/pi-tui",
		]);
		assert.deepEqual(describeViolations(walk.dynamic), []);
	});

	test("follows aliases of loader functions", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import module from "node:module";',
				'const makeRequire = module["createRequire"];',
				"const r = makeRequire(import.meta.url);",
				'export const host = r("@bastani/atomic");',
				"const load = process.getBuiltinModule;",
				'export const builtin = load("fs");',
				"const resolvePath = r.resolve;",
				'export const path = resolvePath("typebox");',
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(walk.externals.map((entry) => entry.description).sort(), ["@bastani/atomic", "typebox"]);
		assert.deepEqual(describeViolations(walk.dynamic), []);
	});

	test("fails closed on a computed non-literal property of a loader object", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import module from "node:module";',
				"declare const key: string;",
				'export const a = module[key](import.meta.url)("@bastani/atomic");',
				'export const b = require[key]("@bastani/atomic");',
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.equal(walk.dynamic.length, 2, describeViolations(walk.dynamic).join(", "));
		for (const entry of walk.dynamic) assert.match(entry.description, /computed-loader-member/u);
	});

	test("ordinary computed calls on unrelated objects are not flagged", () => {
		const root = fixture({
			"broker/broker.ts": [
				"declare const handlers: Record<string, () => void>;",
				"declare const key: string;",
				"export const run = () => handlers[key]();",
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(describeViolations(walk.dynamic), []);
		assert.deepEqual(describeViolations(walk.externals), []);
	});

	test("fails closed on a non-literal request rather than ignoring it", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import { createRequire } from "node:module";',
				"const r = createRequire(import.meta.url);",
				"declare const name: string;",
				"export const a = r(name);",
				"export const b = require(name);",
				"export const c = process.getBuiltinModule(name);",
				"export const d = import(name);",
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.equal(walk.dynamic.length, 4, describeViolations(walk.dynamic).join(", "));
		for (const entry of walk.dynamic) assert.match(entry.description, /Identifier/u);
		assert.deepEqual(describeViolations(walk.externals), []);
	});

	test("type-only edges never become runtime edges", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import type { Absent } from "@types/absent";',
				'import { type AlsoAbsent } from "@types/also-absent";',
				'export type { Third } from "@types/third";',
				'export { type Fourth } from "@types/fourth";',
				'import type Legacy = require("@types/legacy");',
				'import { type Mixed, value } from "./mixed.js";',
				"export const used = value as unknown as Absent | AlsoAbsent | Mixed | Legacy;",
				"",
			].join("\n"),
			"broker/mixed.ts": ["export type Mixed = string;", "export const value = 1;", ""].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		// The mixed import keeps its runtime edge; every type-only form disappears.
		assert.deepEqual(describeViolations(walk.externals), []);
		assert.deepEqual(describeViolations(walk.unresolved), []);
		assert.equal(walk.visited.includes(join(root, "broker/mixed.ts")), true);
	});

	test("accepts builtins spelled with and without the node: prefix", () => {
		const root = fixture({
			"broker/broker.ts": [
				'import net from "node:net";',
				'import { readFileSync } from "fs";',
				'const os = require("node:os");',
				'const path = process.getBuiltinModule("path");',
				"export const used = [net, readFileSync, os, path];",
				"",
			].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(describeViolations(walk.externals), []);
		assert.deepEqual(describeViolations(walk.dynamic), []);
	});

	test("reports import.meta.resolve, which still performs package resolution", () => {
		const root = fixture({
			"broker/broker.ts": ['export const url = import.meta.resolve("@bastani/atomic");', ""].join("\n"),
		});

		const walk = walkRuntimeGraph(join(root, "broker/broker.ts"));

		assert.deepEqual(
			walk.externals.map((entry) => entry.description),
			["@bastani/atomic"],
		);
	});

	test("a parse failure is loud instead of degrading to text matching", () => {
		const root = fixture({ "broken.ts": "const = ;\n" });

		assert.throws(() => runtimeRequestsOf(join(root, "broken.ts")));
	});
});
