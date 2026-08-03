/**
 * pi parity: repository scripts that Node can run are tested with Node's own
 * runner, not through the workspace suites.
 *
 * `node --test scripts/*.test.mjs` is the whole story -- no vitest, no config,
 * no transform. That matters most for this script in particular: it is the one
 * that turns the root `package-lock.json` into the shrinkwrap published inside
 * `@bastani/atomic`, so it now sits directly on the lockfile that `npm ci`
 * verifies rather than beside a second, unverified one.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateShrinkwrap } from "./generate-coding-agent-shrinkwrap.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

test("the generated shrinkwrap matches the committed one", async () => {
	const generated = await generateShrinkwrap();
	const committed = JSON.parse(readFileSync(join(root, "packages/coding-agent/npm-shrinkwrap.json"), "utf8"));
	assert.deepEqual(
		generated,
		committed,
		"packages/coding-agent/npm-shrinkwrap.json is stale; run `npm run shrinkwrap:coding-agent`",
	);
});

test("the shrinkwrap is derived from the lockfile npm ci verifies", async () => {
	const generated = await generateShrinkwrap();
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	assert.equal(generated.lockfileVersion, 3);
	assert.equal(generated.requires, true);
	assert.equal(generated.name, "@bastani/atomic");

	// Every resolved dependency must carry the exact version and integrity the
	// root lockfile pinned. A shrinkwrap that drifted from it would ship users a
	// dependency set no CI job ever installed -- which is precisely what two
	// coexisting lockfiles allowed before install moved to npm.
	let compared = 0;
	for (const [path, entry] of Object.entries(generated.packages)) {
		if (path === "" || entry.version === undefined) continue;
		const source = lock.packages[path];
		// Workspace packages are links in the root lockfile and carry no version of
		// their own; the shrinkwrap materialises them.
		if (source === undefined || source.link === true || source.version === undefined) continue;
		assert.equal(entry.version, source.version, path);
		if (entry.integrity !== undefined && source.integrity !== undefined) {
			assert.equal(entry.integrity, source.integrity, path);
		}
		compared += 1;
	}
	assert.ok(compared > 100, `expected the shrinkwrap to overlap the root lockfile broadly, compared ${compared}`);
});

test("no packaged dependency resolves outside the public npm registry", async () => {
	const generated = await generateShrinkwrap();
	for (const [path, entry] of Object.entries(generated.packages)) {
		if (entry.resolved === undefined) continue;
		assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//u, path);
	}
});
