import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { parse } from "yaml";

/**
 * Dependencies that upstream pi also declares move only with a pi sync, never
 * through a Dependabot pull request (see "Dependabot and the pi sync" in
 * docs/ci.md). A Dependabot bump of one of them puts Atomic on a version pi
 * does not run, and the next sync then has to reconcile or undo it.
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

type Manifest = Record<string, Record<string, string> | undefined>;
const manifestPaths = [
	"package.json",
	...readdirSync(join(root, "packages"))
		.map((name) => `packages/${name}/package.json`)
		.filter((path) => existsSync(join(root, path))),
];
/** Every dependency name a root-workspace manifest declares, with where it is declared. */
const declared = new Map<string, string[]>();
for (const path of manifestPaths) {
	const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as Manifest;
	for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies", "overrides"]) {
		for (const name of Object.keys(manifest[field] ?? {})) {
			declared.set(name, [...(declared.get(name) ?? []), `${path} ${field}`]);
		}
	}
}

function ignored(name: string): boolean {
	return rules.some((rule) => {
		const pattern = rule["dependency-name"]
			.split("*")
			.map((part) => part.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&"))
			.join(".*");
		return new RegExp(`^${pattern}$`, "u").test(name);
	});
}

test("pi-owned dependencies are ignored outright, so no version reaches Atomic outside a pi sync", () => {
	for (const rule of rules) {
		assert.equal(
			rule.versions,
			undefined,
			`${rule["dependency-name"]}: a version-scoped ignore lets other bumps through`,
		);
		assert.equal(
			rule["update-types"],
			undefined,
			`${rule["dependency-name"]}: an update-type-scoped ignore lets other bumps through`,
		);
	}
	// Each of these reached Atomic as a Dependabot PR that moved it away from
	// the version pi runs and had to be closed.
	for (const name of ["typebox", "vitest", "minimatch", "@types/node"]) {
		assert.ok(ignored(name), `${name} is declared by upstream pi and must come only through the pi sync`);
	}
});

test("pi's own packages are ignored wherever an Atomic workspace depends on them", () => {
	const piPackages = [...declared.keys()].filter((name) => name.startsWith("@earendil-works/"));
	assert.ok(piPackages.length > 0, "no workspace depends on a pi package; the ignore rule has nothing to cover");
	for (const name of piPackages) {
		assert.ok(ignored(name), `${name} (${declared.get(name)?.join(", ")}) must move only with a pi sync`);
	}
});

test("every ignored dependency is still declared by an Atomic workspace", () => {
	// A sync that drops a dependency must also drop its ignore entry, or the
	// list stops describing what pi and Atomic share.
	for (const rule of rules) {
		const name = rule["dependency-name"];
		if (name.includes("*")) continue;
		assert.ok(declared.has(name), `${name} is ignored but no root-workspace manifest declares it`);
	}
});
