import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// PR #2887: model dependencies of other workspaces without relying on hoisting or npm's cache.
// Only declarations from the owning root package may back its smoke imports.
test("the smoke CLI reaches usage validation with npm's linked layout and an empty cache", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-smoke-dependencies-"));
	try {
		const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
		const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
		const dependencies = Object.fromEntries(
			["esbuild", "pg"].map((name) => [name, lock.packages[`node_modules/${name}`].version]),
		);
		// Import-only local packages: the real CLI must reject missing arguments before using either API.
		const fixtureDependencies = {};
		for (const [name, source] of Object.entries({
			esbuild: 'export function build() { throw new Error("unexpected fixture build"); }\n',
			pg: "export default {};\n",
		})) {
			const directory = join(root, "fixtures", name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({ name, version: dependencies[name], type: "module", main: "index.js" }),
			);
			writeFileSync(join(directory, "index.js"), source);
			fixtureDependencies[name] = `file:${directory}`;
		}
		writeFileSync(
			join(root, "package.json"),
			JSON.stringify({
				name: "smoke-owner",
				private: true,
				type: "module",
				workspaces: ["other"],
				devDependencies: Object.fromEntries(
					Object.keys(manifest.devDependencies)
						.filter((name) => name in dependencies)
						.map((name) => [name, fixtureDependencies[name]]),
				),
			}),
		);
		mkdirSync(join(root, "other"));
		writeFileSync(
			join(root, "other", "package.json"),
			JSON.stringify({ name: "other", dependencies: fixtureDependencies }),
		);
		mkdirSync(join(root, "scripts"));
		for (const name of ["smoke-postgres-runtime.mjs", "smoke-postgres-process.mjs", "stage-postgres-runtime.mjs"]) {
			copyFileSync(new URL(name, import.meta.url), join(root, "scripts", name));
		}
		execFileSync(
			"npm",
			[
				"install",
				"--install-strategy=linked",
				"--ignore-scripts",
				"--offline",
				"--no-audit",
				"--no-fund",
				"--cache",
				join(root, "npm-cache"),
			],
			{ cwd: root, stdio: "pipe" },
		);
		const result = spawnSync(process.execPath, [join(root, "scripts", "smoke-postgres-runtime.mjs")], {
			cwd: root,
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Error: usage: smoke-postgres-runtime\.mjs/u);
		assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
		for (const [name, version] of Object.entries(dependencies)) {
			assert.equal(manifest.devDependencies[name], version);
			assert.equal(lock.packages[""].devDependencies[name], version);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
