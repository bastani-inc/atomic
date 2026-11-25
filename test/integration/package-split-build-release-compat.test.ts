/**
 * Earlier-release compatibility in `split-dist.mjs`: preserving lazy module paths, `.impl.js`/`.code.js` gates and
 * aliases, and shared chunk paths imported on demand by processes from prior releases.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { dirname, join, posix, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, test } from "vitest";
import { compiledPackage, createInstalledLayoutScope, LAYOUT_TIMEOUT_MS } from "./package-split-build-helpers.js";

const layoutScope = createInstalledLayoutScope();
const { installedLayout } = layoutScope;

afterAll(() => {
	layoutScope.cleanup();
}, LAYOUT_TIMEOUT_MS);

test(
	"a module the compiled package imported lazily still has a file at its path, for a process of an earlier version",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "lazy-paths");
		compiledPackage(build);
		const compiledDist = join(build, "dist");
		const lazy = new Set<string>();
		for (const file of fs.readdirSync(compiledDist, { recursive: true }) as string[]) {
			const path = file.split(sep).join("/");
			if (!path.endsWith(".js") || path.startsWith("builtin/")) continue;
			const source = fs.readFileSync(join(compiledDist, file), "utf8");
			for (const match of source.matchAll(/\bimport\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g))
				lazy.add(posix.normalize(posix.join(posix.dirname(path), match[1] as string)));
		}
		assert.ok(lazy.size > 10, "the compiled package imports modules lazily");
		const result = spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const missing = [...lazy].filter((path) => !fs.existsSync(join(compiledDist, path)));
		assert.deepEqual(missing, [], "lazily imported modules without a file after the split");
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a module an earlier release imported on demand keeps its file, also once the package only bundles it",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "released-lazy-paths");
		compiledPackage(build);
		const split = () => spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		// A release that imported a module on demand that this package imports only statically, and bundles.
		const record = (path: string) =>
			fs.writeFileSync(
				join(build, "in-place-update", "0.0.1.json"),
				JSON.stringify({
					version: "0.0.1",
					packages: { "@bastani/atomic": { lazy: { [`@bastani/atomic:dist/${path}`]: ["dist/main.js"] } } },
				}),
			);
		record("core/agent-session.js");
		const kept = split();
		assert.equal(kept.status, 0, kept.stderr);
		assert.ok(
			fs.existsSync(join(build, "dist", "core", "agent-session.js")),
			"the module the release imported on demand",
		);
		// A module no longer in the package fails the build, which would otherwise leave the release without it.
		record("core/a-module-this-package-never-had.js");
		const failed = split();
		assert.notEqual(failed.status, 0);
		assert.match(
			failed.stderr,
			/0\.0\.1 imports dist\/core\/a-module-this-package-never-had\.js on demand, and no module of this package compiles to it/,
		);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a path an earlier release imported a module's code at stays, also when this build does not gate its module",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "released-impl-paths");
		compiledPackage(build);
		const split = () => spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		// The recorded 0.10.4 release imports its gated modules through `<module>.impl.js` paths.
		assert.ok(fs.existsSync(join(build, "in-place-update", "0.10.4.json")), "0.10.4 is recorded");
		const withRecorded = split();
		assert.equal(withRecorded.status, 0, withRecorded.stderr);
		// A release that imported a module's code at `<module>.impl.js`, whose module is now statically imported (not gated).
		const record = (path: string) =>
			fs.writeFileSync(
				join(build, "in-place-update", "0.0.1.json"),
				JSON.stringify({
					version: "0.0.1",
					packages: { "@bastani/atomic": { lazy: { [`@bastani/atomic:dist/${path}`]: ["dist/main.js"] } } },
				}),
			);
		record("core/agent-session.impl.js");
		const kept = split();
		assert.equal(kept.status, 0, kept.stderr);
		const implPath = join(build, "dist", "core", "agent-session.impl.js");
		const modulePath = join(build, "dist", "core", "agent-session.js");
		assert.ok(fs.existsSync(implPath), "the path stays");
		assert.ok(fs.existsSync(`${implPath}.map`), "with a source map");
		// That release does not guard its own imports, so its path is a gate, which gives the module's single copy (the
		// module is gated here too, as that release imports it on demand: its code is at `agent-session.code.js`).
		assert.match(fs.readFileSync(implPath, "utf8"), /module = await import\("\.\/agent-session\.code\.js"\)/);
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const impl = await import(${JSON.stringify(pathToFileURL(implPath).href)});
const current = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
process.stdout.write(JSON.stringify({ same: impl.AgentSession === current.AgentSession, hasClass: typeof impl.AgentSession === "function" }));`,
			],
			{ encoding: "utf8" },
		);
		assert.equal(probe.status, 0, probe.stderr);
		assert.deepEqual(JSON.parse(probe.stdout), { same: true, hasClass: true });
		// Running the split again over the gate succeeds cleanly.
		const again = split();
		assert.equal(again.status, 0, again.stderr);
		// A release that guards its own imports (0.10.5 and later) needs no gate at the path it imports; once no earlier
		// release imports the module on demand, this build does not gate it, and that path gives the module's exports.
		fs.writeFileSync(
			join(build, "in-place-update", "0.0.1.json"),
			JSON.stringify({ version: "0.0.1", packages: { "@bastani/atomic": { lazy: {} } } }),
		);
		fs.writeFileSync(
			join(build, "in-place-update", "0.10.5.json"),
			JSON.stringify({
				version: "0.10.5",
				packages: {
					"@bastani/atomic": { lazy: { "@bastani/atomic:dist/core/agent-session.code.js": ["dist/main.js"] } },
				},
			}),
		);
		const guarded = split();
		assert.equal(guarded.status, 0, guarded.stderr);
		const aliasPath = join(build, "dist", "core", "agent-session.code.js");
		const alias = fs.readFileSync(aliasPath, "utf8");
		assert.match(
			alias,
			/^export \* from "\.\/agent-session\.js";$/m,
			"a guarded release's path gives the module's exports",
		);
		assert.doesNotMatch(alias, /await import/, "and holds no gate");
		const guardedProbe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const alias = await import(${JSON.stringify(pathToFileURL(aliasPath).href)});
const current = await import(${JSON.stringify(pathToFileURL(modulePath).href)});
process.stdout.write(JSON.stringify({ same: alias.AgentSession === current.AgentSession }));`,
			],
			{ encoding: "utf8" },
		);
		assert.equal(guardedProbe.status, 0, guardedProbe.stderr);
		assert.deepEqual(JSON.parse(guardedProbe.stdout), { same: true });
		fs.rmSync(join(build, "in-place-update", "0.10.5.json"));
		// When the underlying module no longer compiles, the build still fails.
		record("core/a-module-this-package-never-had.impl.js");
		const failed = split();
		assert.notEqual(failed.status, 0);
		assert.match(
			failed.stderr,
			/0\.0\.1 imports dist\/core\/a-module-this-package-never-had\.impl\.js on demand, and no module of this package compiles to dist\/core\/a-module-this-package-never-had\.js/,
		);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a shared file an earlier release imported on demand stays, holding this build's code of its module",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "released-shared-paths");
		compiledPackage(build);
		const shared = join(build, "dist", "_shared");
		const split = () => spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		assert.equal(split().status, 0);
		const current = fs.readdirSync(shared).find((file) => /^compile-cache-warmup-host-[A-Z2-7]{8}\.js$/.test(file));
		assert.ok(
			current,
			"the shared file of the compile-cache helper's host module, which interactive startup imports on demand",
		);
		// A release whose file of that module, under another name, exported fewer names: as before its exports grew.
		const released = "compile-cache-warmup-host-AAAAAAAA.js";
		fs.writeFileSync(
			join(build, "in-place-update", "0.0.1.json"),
			JSON.stringify({
				version: "0.0.1",
				packages: {
					"@bastani/atomic": {
						files: { [`dist/_shared/${released}`]: ["warmCompileCache"] },
						lazy: { [`@bastani/atomic:dist/_shared/${released}`]: ["dist/_shared/chunk-AAAAAAAA.js"] },
					},
				},
			}),
		);
		const kept = split();
		assert.equal(kept.status, 0, kept.stderr);
		const probe = spawnSync(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const kept = await import(${JSON.stringify(pathToFileURL(join(shared, released)).href)});
const now = await import(${JSON.stringify(pathToFileURL(join(shared, current)).href)});
process.stdout.write(JSON.stringify({ names: Object.keys(kept), same: kept.warmCompileCache === now.warmCompileCache }));`,
			],
			{ encoding: "utf8" },
		);
		assert.equal(probe.status, 0, probe.stderr);
		assert.deepEqual(JSON.parse(probe.stdout), { names: ["warmCompileCache"], same: true });
	},
	LAYOUT_TIMEOUT_MS,
);
