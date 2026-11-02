import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parse } from "yaml";

/**
 * A dependency that upstream pi declares in a package Atomic carries (pi's
 * root, ai, coding-agent and mcp manifests) moves only with a pi sync, never
 * through a Dependabot pull request (see "Dependabot and the pi sync" in
 * docs/ci.md). test/fixtures/pi-carried-dependencies.json records those pi
 * manifests; scripts/snapshot-pi-dependencies.mjs refreshes it on each sync.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

interface IgnoreRule {
	"dependency-name": string;
	versions?: unknown;
	"update-types"?: unknown;
}
interface UpdateEntry {
	"package-ecosystem": string;
	directory: string;
	ignore?: IgnoreRule[];
}

const config = parse(readFileSync(join(root, ".github/dependabot.yml"), "utf8")) as { updates: UpdateEntry[] };
const rootNpm = config.updates.find((entry) => entry["package-ecosystem"] === "npm" && entry.directory === "/");
assert.ok(rootNpm, "dependabot.yml has no npm entry for the root workspace");
const rules = rootNpm.ignore ?? [];

const snapshot = JSON.parse(readFileSync(join(root, "test/fixtures/pi-carried-dependencies.json"), "utf8")) as {
	commit: string;
	manifests: Record<string, string[]>;
};
const declaredByPi = new Set(Object.values(snapshot.manifests).flat());

const declaredByAtomic = new Set<string>();
for (const path of [
	"package.json",
	...readdirSync(join(root, "packages")).map((name) => `packages/${name}/package.json`),
]) {
	if (!existsSync(join(root, path))) continue;
	const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, Record<string, string>>;
	for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
		for (const name of Object.keys(manifest[field] ?? {})) declaredByAtomic.add(name);
	}
}

test("Dependabot ignores exactly the dependencies Atomic shares with the pi packages it carries", () => {
	const expected = [...declaredByAtomic].filter((name) => declaredByPi.has(name)).sort();
	const ignored = rules.map((rule) => rule["dependency-name"]).sort();
	assert.deepEqual(ignored, expected, `root npm ignore list differs from the pi ${snapshot.commit} snapshot`);
});

test("each pi-owned dependency is ignored by name for every version", () => {
	for (const rule of rules) {
		const name = rule["dependency-name"];
		assert.doesNotMatch(name, /\*/u, `${name}: a wildcard can cover names pi does not declare`);
		assert.equal(rule.versions, undefined, `${name}: a version-scoped ignore lets other bumps through`);
		assert.equal(rule["update-types"], undefined, `${name}: an update-type-scoped ignore lets other bumps through`);
	}
	// Each of these reached Atomic as a Dependabot PR that moved it away from
	// the version pi runs and had to be closed.
	const ignored = new Set(rules.map((rule) => rule["dependency-name"]));
	for (const name of ["typebox", "vitest", "minimatch", "@types/node", "@earendil-works/pi-tui"]) {
		assert.ok(ignored.has(name), `${name} is declared by upstream pi and must come only through the pi sync`);
	}
});
