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
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
test("the published tree keeps coding-agent dependencies on satisfying versions", async () => {
	const generated = await generateShrinkwrap();
	assert.equal(generated.packages["node_modules/chalk"]?.version, "6.0.0");
	assert.equal(generated.packages["node_modules/retry"]?.version, "0.13.1");
	assert.equal(generated.packages["node_modules/proper-lockfile/node_modules/retry"]?.version, "0.12.0");
});

test("the published tree preserves internal workspace-local dependencies and their nested tree", async () => {
	const generated = await generateShrinkwrap();
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	const workspacePrefix = "packages/ai/";
	let compared = 0;
	for (const [path, entry] of Object.entries(lock.packages)) {
		if (!path.startsWith(`${workspacePrefix}node_modules/`) || entry.dev) continue;
		const publishedPath = `node_modules/@bastani/atomic-ai/${path.slice(workspacePrefix.length)}`;
		assert.equal(generated.packages[publishedPath]?.version, entry.version, publishedPath);
		assert.equal(generated.packages[publishedPath]?.integrity, entry.integrity, publishedPath);
		compared += 1;
	}
	assert.ok(compared > 0, "expected workspace-local dependencies with versions distinct from root dependencies");
	assert.ok(Object.keys(generated.packages).every((path) => path === "" || path.startsWith("node_modules/")));
});

test("the shrinkwrap is derived from the lockfile npm ci verifies", async () => {
	const generated = await generateShrinkwrap();
	const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
	assert.equal(generated.lockfileVersion, 3);
	assert.equal(generated.requires, true);
	assert.equal(generated.name, "@bastani/atomic");

	// Every resolved dependency must carry the exact version and integrity the
	// root lockfile pinned. Remapped workspace-local paths are matched by their
	// integrity because the published tree is rooted at packages/coding-agent.
	// A shrinkwrap that drifted from the root lock would ship users a dependency
	// set no CI job ever installed -- which is precisely what two coexisting
	// lockfiles allowed before install moved to npm.
	let compared = 0;
	for (const [path, entry] of Object.entries(generated.packages)) {
		if (path === "" || entry.version === undefined) continue;
		const pathSource = lock.packages[path];
		const source =
			pathSource?.integrity === entry.integrity
				? pathSource
				: Object.values(lock.packages).find(
						(candidate) => candidate.integrity !== undefined && candidate.integrity === entry.integrity,
					);
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

test("--root writes another checkout's shrinkwrap with this checkout's script", () => {
	const checkout = mkdtempSync(join(tmpdir(), "atomic-shrinkwrap-root-"));
	try {
		const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
		cpSync(join(root, "package-lock.json"), join(checkout, "package-lock.json"));
		for (const path of Object.keys(lock.packages)) {
			if (!path.startsWith("packages/") || path.includes("/node_modules/")) continue;
			cpSync(join(root, path, "package.json"), join(checkout, path, "package.json"), { force: true });
		}
		const manifestPath = join(checkout, "packages/coding-agent/package.json");
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
		writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: "9.9.9-root" }, null, "\t")}\n`);
		const committedPath = join(root, "packages/coding-agent/npm-shrinkwrap.json");
		const committed = readFileSync(committedPath, "utf8");

		const script = join(root, "scripts/generate-coding-agent-shrinkwrap.mjs");
		const run = spawnSync(process.execPath, [script, "--root", checkout], {
			cwd: dirname(checkout),
			encoding: "utf8",
		});

		assert.equal(run.status, 0, run.stderr);
		const written = JSON.parse(readFileSync(join(checkout, "packages/coding-agent/npm-shrinkwrap.json"), "utf8"));
		assert.equal(written.version, "9.9.9-root");
		assert.equal(written.packages[""].version, "9.9.9-root");
		assert.equal(readFileSync(committedPath, "utf8"), committed);
	} finally {
		rmSync(checkout, { recursive: true, force: true });
	}
});
