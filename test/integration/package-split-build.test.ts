/**
 * The built package as npm packs it and as `split-dist.mjs` rebuilds it: entries, shared chunks, import closure,
 * fresh recompiles, missing build state, and leftover build outputs.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, join, posix } from "node:path";
import { afterAll, test } from "vitest";
import {
	compiledPackage,
	createInstalledLayoutScope,
	dist,
	LAYOUT_TIMEOUT_MS,
	packageDir,
	repoRoot,
} from "./package-split-build-helpers.js";

/** The package's public entry files and `main.js`, which the CLI imports. */
const ENTRIES = ["cli", "main", "index", "rpc-entry", "core/storage/index", "core/storage/testing"];
/**
 * The modules that run by path in a thread or process of their own: the extension source transform worker and the
 * siblings it imports by a computed path, the image resize worker, and the compile-cache helper.
 */
const RUN_BY_PATH = [
	"core/extensions/ts-transform-worker",
	"core/extensions/transform-graph",
	"core/extensions/ts-source-specifiers",
	"utils/image-resize-worker",
	"utils/compile-cache-warmup",
];

const layoutScope = createInstalledLayoutScope();
const { installedLayout } = layoutScope;

afterAll(() => {
	layoutScope.cleanup();
}, LAYOUT_TIMEOUT_MS);

/** The `dist` files an entry loads, statically or when a dynamic import runs, transitively through shared files. */
function loadedFrom(entries: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const pending = entries.map((entry) => `${entry}.js`);
	while (pending.length > 0) {
		const file = pending.pop() as string;
		if (seen.has(file)) continue;
		seen.add(file);
		// Comment lines are not code: a bundled dependency's documentation may name an import.
		const source = fs
			.readFileSync(join(dist, file), "utf8")
			.split("\n")
			.filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
			.join("\n");
		for (const match of source.matchAll(/(?:from|import\()\s*"(\.{1,2}\/[^"]+)"/g)) {
			pending.push(posix.normalize(posix.join(posix.dirname(file), match[1] as string)));
		}
	}
	return seen;
}

let packed: Set<string> | undefined;
/** The paths `npm pack` puts in the package. */
function packedPaths(): Set<string> {
	if (packed !== undefined) return packed;
	const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	const result = spawnSync(npm, ["pack", "--dry-run", "--json", "--ignore-scripts", packageDir], {
		cwd: repoRoot,
		encoding: "utf8",
		shell: process.platform === "win32",
		maxBuffer: 64 * 1024 * 1024,
	});
	assert.equal(result.status, 0, result.stderr);
	const [{ files }] = JSON.parse(result.stdout) as [{ files: { path: string }[] }];
	packed = new Set(files.map((file) => file.path));
	return packed;
}

test(
	"the packed package holds its entries, every shared file they load and none of the build's own state",
	() => {
		const paths = packedPaths();
		for (const file of loadedFrom(ENTRIES)) assert.ok(paths.has(`dist/${file}`), `dist/${file} is not packed`);
		for (const entry of ENTRIES) assert.ok(paths.has(`dist/${entry}.js.map`), `dist/${entry}.js.map is not packed`);
		assert.ok(
			[...paths].every((path) => !path.includes("atomic-split-dist")),
			"the split's build state stays out of the package",
		);
		const manifest = JSON.parse(fs.readFileSync(join(packageDir, "package.json"), "utf8")) as {
			exports: Record<string, Record<string, string>>;
			bin: Record<string, string>;
		};
		for (const target of [
			...Object.values(manifest.exports).flatMap((conditions) => Object.values(conditions)),
			...Object.values(manifest.bin),
		])
			assert.ok(paths.has(posix.normalize(target)), `${target} is not packed`);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"the packed package holds each bundled module once, and every file that runs by path with what it loads",
	() => {
		const paths = packedPaths();
		for (const file of loadedFrom(RUN_BY_PATH)) assert.ok(paths.has(`dist/${file}`), `dist/${file} is not packed`);
		const state = join(packageDir, "node_modules", ".cache", "atomic-split-dist", "state.json");
		const splitEntries = (JSON.parse(fs.readFileSync(state, "utf8")) as { entries: Record<string, string> }).entries;
		// Classes the SDK entry exports from its bundle: no compiled copy a deep path could load as a second class. A
		// module kept at its path as an entry, because the package imports it lazily, holds the bundle's code there.
		for (const module of [
			"core/agent-session",
			"core/session-manager",
			"core/settings-manager",
			"core/extensions/loader",
		]) {
			if (paths.has(`dist/${module}.js`)) {
				const digest = createHash("sha256")
					.update(fs.readFileSync(join(dist, `${module}.js`)))
					.digest("hex");
				assert.equal(digest, splitEntries[module], `dist/${module}.js is a compiled copy beside the bundle`);
			}
			assert.ok(paths.has(`dist/${module}.d.ts`), `dist/${module}.d.ts is not packed`);
		}
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"every module the package ships finds the files it imports in the package",
	() => {
		const paths = packedPaths();
		const missing: string[] = [];
		for (const path of paths) {
			if (!/^dist\/.*\.m?js$/.test(path) || path.startsWith("dist/builtin/")) continue;
			// Comment lines are not code: a bundled dependency's documentation may name an import.
			const source = fs
				.readFileSync(join(packageDir, path), "utf8")
				.split("\n")
				.filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
				.join("\n");
			for (const match of source.matchAll(
				/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s*["'](\.{1,2}\/[^"']+)["']|(?:^|\n)\s*import\s*["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g,
			)) {
				const target = posix.normalize(
					posix.join(posix.dirname(path), (match[1] ?? match[2] ?? match[3]) as string),
				);
				if (!paths.has(target)) missing.push(`${path} -> ${target}`);
			}
		}
		assert.deepEqual(missing, []);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a split after a fresh compile bundles the compiled code, not the copy an earlier split saved",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "recompiled");
		compiledPackage(build);
		const split = () => {
			const result = spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		};
		const module = join(build, "dist", "core", "agent-session.js");
		const compiled = fs.readFileSync(module, "utf8");
		split();
		assert.equal(fs.existsSync(module), false, "the split removes the compiled file of a bundled module");

		// The next compile emits the module again, changed, with its map.
		const marker = 'globalThis.atomicSplitRevision = "recompiled";';
		const recompiled = compiled.replace(/^\/\/# sourceMappingURL=.*$/m, `${marker}\n$&`);
		assert.notEqual(recompiled, compiled);
		fs.writeFileSync(module, recompiled);
		const saved = join(
			build,
			"node_modules",
			".cache",
			"atomic-split-dist",
			"compiled",
			"core",
			"agent-session.js.map",
		);
		fs.copyFileSync(saved, `${module}.map`);
		split();
		assert.equal(fs.existsSync(module), false, "the split removes it again");
		const shared = join(build, "dist", "_shared");
		const bundled = fs
			.readdirSync(shared)
			.filter((file) => file.endsWith(".js"))
			.some((file) => fs.readFileSync(join(shared, file), "utf8").includes(marker));
		assert.ok(bundled, "the bundle holds the recompiled module");
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a split build whose build state is gone, as after a fresh npm ci, is refused with the file and the command that rebuilds it",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "state-gone");
		compiledPackage(build);
		const split = () => spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		assert.equal(split().status, 0);
		fs.rmSync(join(build, "node_modules", ".cache", "atomic-split-dist"), { recursive: true, force: true });
		const again = split();
		assert.notEqual(again.status, 0);
		assert.match(again.stderr, /dist\/cli\.js is an earlier split's output/);
		assert.match(again.stderr, /run `npm run build`/);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a module that mentions import.meta only in a comment inside an object literal splits",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "comment-meta");
		compiledPackage(build);
		const module = join(build, "dist", "core", "agent-session.js");
		const compiled = fs.readFileSync(module, "utf8");
		const commented = compiled.replace(
			/^\/\/# sourceMappingURL=.*$/m,
			"export const splitCommentProbe = {\n\t// reads import.meta.dirname nowhere\n\tvalue: 1,\n};\n$&",
		);
		assert.notEqual(commented, compiled);
		fs.writeFileSync(module, commented);
		const result = spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	},
	LAYOUT_TIMEOUT_MS,
);

test(
	"a split over files an earlier build left gates and stubs what a split of a clean dist does",
	() => {
		const { nodeModules } = installedLayout();
		const build = join(dirname(nodeModules), "stale-leftovers");
		compiledPackage(build);
		const distDir = join(build, "dist");
		const split = () => spawnSync(process.execPath, [join(build, "scripts", "split-dist.mjs")], { encoding: "utf8" });
		/** The gated modules, the stubs and the modules a gate asks for a release, as the split wrote them. */
		const decisions = () => {
			const { gateFiles } = JSON.parse(
				fs.readFileSync(join(build, "node_modules", ".cache", "atomic-split-dist", "state.json"), "utf8"),
			) as { gateFiles: Record<string, string> };
			const files = Object.keys(gateFiles).filter((path) => path.endsWith(".js"));
			const gate = fs.readFileSync(join(distDir, "core", "export-html", "index.js"), "utf8");
			return {
				gated: files.filter((path) => path.endsWith(".code.js")).sort(),
				aliases: files.filter((path) => path.endsWith(".impl.js")).sort(),
				stubs: files.filter((path) => !/\.(?:code|impl)\.js$/.test(path)).sort(),
				probes: /for \(const path of (\[[^\]]*\])\)/.exec(gate)?.[1],
			};
		};
		const clean = split();
		assert.equal(clean.status, 0, clean.stderr);
		const expected = decisions();
		assert.ok(expected.stubs.includes("_shared/chunk-CDOYTDYM.js"), "0.10.4-alpha.1's module path holds a stub");
		assert.ok(expected.gated.includes("core/export-html/index.code.js"), "the export module is gated");
		// What an earlier build leaves: its own shared file at 0.10.4-alpha.1's module path, a shared file that imports
		// the export module statically, and the export module's code as an earlier build wrote it beside its gate.
		fs.writeFileSync(
			join(distDir, "_shared", "chunk-CDOYTDYM.js"),
			'export const VERSION = "0.10.4-alpha.1";\nexport const APP_NAME = "atomic";\n',
		);
		fs.writeFileSync(
			join(distDir, "_shared", "chunk-AAAAAAAA.js"),
			'import { exportSessionToHtml } from "../core/export-html/index.js";\nexport { exportSessionToHtml };\n',
		);
		fs.writeFileSync(
			join(distDir, "core", "export-html", "index.code.js"),
			"export const exportSessionToHtml = 1;\n",
		);
		const over = split();
		assert.equal(over.status, 0, over.stderr);
		assert.deepEqual(decisions(), expected);
	},
	LAYOUT_TIMEOUT_MS,
);
