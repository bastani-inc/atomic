/**
 * Bundles a package's compiled `dist` into a few shared files, run from the package directory after `tsc`.
 *
 * Loading a package module by module costs a file open, a read and several path lookups per module, and on Windows
 * each first open of a file is also scanned by antivirus software. This build keeps every compiled module's path
 * (each `dist/**.js` becomes a small file that re-exports the module) and moves the code into a few `dist/_*.js`
 * files, so every way of naming a module, by the package's exports, a deep path or a relative URL, still reaches one
 * instance:
 *
 * - Each module is placed in exactly one shared file and evaluated at most once per process.
 * - Module bodies run when, and in the order, they ran before (`strictExecutionOrder`): a shared file only defines
 *   them, and a module runs when something imports it. Placing a module in a shared file changes what is read from
 *   disk, never what runs.
 * - Modules share a file only with modules that load the same other packages, so importing a module, by any path,
 *   loads no package it did not load before (see `assignGroups`). Code the package's entry points import goes in
 *   `_main-*` files, code only dynamic imports or deep paths reach in `_lazy-*` files.
 * - `import.meta.url` is the URL of the module's own compiled file, so assets, workers and native modules beside it
 *   resolve as before, wherever the package is installed.
 * - A shared file is named by its first module, so an install updated in place keeps the names of files whose first
 *   module stays the same.
 * - A module named with `--standalone=<path below dist>,...` (or below a directory named with a trailing `/`) keeps its
 *   compiled file and code: the release build of the single-file binary copies such files beside the binary and loads
 *   them from there, and an export condition may name such a file for a runtime that should not load the bundle.
 * - A package named with `--inline=<package>,...` is bundled in, its modules grouped apart from the package's own:
 *   the package's compiled modules that import it then share one copy of it, loaded from the shared files.
 *
 * A package with an exports map also keeps its compiled modules, one file each, under `dist/_modules/`, and each of its
 * exports names them with the `module` and `browser` conditions, ahead of `import`. Bundlers resolve those conditions
 * and keep shaking unused modules out as before; Node and Bun resolve neither, so a process loads only the bundled
 * files. The build checks every export for this.
 *
 * The compiled files the build replaces are kept under `node_modules/.cache/atomic-bundle-dist`: an incremental
 * `tsc` writes only what changed, and the next bundle reads the others from there.
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Where a package with an exports map keeps its compiled modules for bundlers, below `dist`. */
export const MODULES_DIRECTORY = "_modules";
/** A shared file's name: `dist/_<group>-<eight base32 characters>.js`. */
const SHARED_FILE = /^_[a-zA-Z0-9.-]+-[A-Z2-7]{8}\.js$/;
const MODULE_URL = "__atomicModuleUrl";
/** Stands for a module's own URL in the bundled code until the file that holds the module is known. */
const MODULE_URL_MARKER = "__atomic_module_url__:";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** Eight base32 characters of the SHA-256 of `key`. @param {string} key */
export function stableName(key) {
	const bytes = createHash("sha256").update(key).digest();
	let name = "";
	for (let index = 0; index < 8; index++) name += BASE32[(bytes[index] ?? 0) % 32];
	return name;
}

const digest = (/** @type {string | Buffer} */ content) => createHash("sha256").update(content).digest("hex");
const toPosix = (/** @type {string} */ path) => path.split(sep).join("/");
/** A module id as a path in this platform's form, so ids compare whichever separators the bundler used. */
const normalizeId = (/** @type {string} */ id) => (isAbsolute(id) ? resolve(id) : id);

/** The compiled modules below `dist`: every `.js` file but the shared files. @param {string} dist */
function compiledFiles(dist, directory = dist) {
	/** @type {string[]} */
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (!(directory === dist && entry.name === MODULES_DIRECTORY)) files.push(...compiledFiles(dist, path));
		} else if (entry.name.endsWith(".js") && !(directory === dist && SHARED_FILE.test(entry.name))) files.push(path);
	}
	return files;
}

/**
 * The entry points a package's manifest names: `main` and each export without a wildcard. A package without an
 * exports map exposes every file, and its `main` is its entry point.
 * @param {string} packageDir
 * @param {{ main?: string, exports?: Record<string, string | { import?: string, default?: string }> }} manifest
 */
function namedEntries(packageDir, manifest) {
	const targets = new Set();
	if (manifest.main) targets.add(join(packageDir, manifest.main));
	for (const value of Object.values(manifest.exports ?? {})) {
		const target = typeof value === "string" ? value : (value.import ?? value.default);
		if (target?.endsWith(".js") && !target.includes("*")) targets.add(join(packageDir, target));
	}
	return [...targets];
}

/**
 * @typedef {object} ModuleImports A module's imports: of the package's own modules and of other modules, Node's
 *   built-in modules included, each statically and by dynamic `import()`.
 * @property {string[]} internal
 * @property {string[]} external
 * @property {string[]} dynamicInternal
 * @property {string[]} dynamicExternal
 */

/**
 * The other modules a module needs: `loaded`, those importing it loads (its static imports' and theirs), and
 * `reachable`, those its dynamic imports can load too, which a bundler following them has to resolve.
 * @param {(id: string) => ModuleImports} importsOf
 */
export function footprints(importsOf) {
	/** @type {Map<string, { loaded: string[], reachable: string[] }>} */
	const memo = new Map();
	const walk = (/** @type {string} */ root, /** @type {boolean} */ dynamic) => {
		const seen = new Set();
		const externals = new Set();
		const stack = [root];
		while (stack.length > 0) {
			const id = /** @type {string} */ (stack.pop());
			if (seen.has(id)) continue;
			seen.add(id);
			const imports = importsOf(id);
			for (const external of imports.external) externals.add(external);
			stack.push(...imports.internal);
			if (dynamic) {
				for (const external of imports.dynamicExternal) externals.add(external);
				stack.push(...imports.dynamicInternal);
			}
		}
		return [...externals].sort();
	};
	return (/** @type {string} */ id) => {
		let result = memo.get(id);
		if (!result) {
			result = { loaded: walk(id, false), reachable: walk(id, true) };
			memo.set(id, result);
		}
		return result;
	};
}

/**
 * Assigns each compiled module to a shared file. Modules share a file when they are in the same tier (`main`: what
 * the package's entry points import, `lazy`: what only dynamic imports or deep paths reach) and need the same other
 * modules, Node's built-in modules included (see {@link footprints}). A shared file imports what its modules import,
 * so a module shares a file only with modules that need what it needs: importing it, by any path, loads no other
 * module it did not load before, and a bundler following its imports, dynamic ones too, meets only the modules it
 * met before, so code that bundled for a browser still does.
 * @param {string[]} modules Compiled modules, absolute paths.
 * @param {string[]} entries The package's entry points, absolute paths.
 * @param {(id: string) => ModuleImports} importsOf
 * @returns {Map<string, string>} Module path to its group: `<tier>:<loaded>;<reachable>`.
 */
export function assignGroups(modules, entries, importsOf) {
	const known = new Set(modules);
	const eager = new Set();
	const stack = entries.filter((entry) => known.has(entry));
	while (stack.length > 0) {
		const id = /** @type {string} */ (stack.pop());
		if (eager.has(id)) continue;
		eager.add(id);
		stack.push(...importsOf(id).internal);
	}
	const footprintOf = footprints(importsOf);
	const groups = new Map();
	for (const id of modules) {
		const { loaded, reachable } = footprintOf(id);
		groups.set(id, `${eager.has(id) ? "main" : "lazy"}:${loaded.join(",")};${reachable.join(",")}`);
	}
	return groups;
}

/**
 * Each compiled module's export names and imports, from a build that keeps every module as its own entry. Imports are
 * its `import` declarations and `import()` expressions; a `require()` call stays one in the bundled code, so it is not
 * counted as an import.
 * @param {typeof import("esbuild")} esbuild
 * @param {string} packageDir
 * @param {Map<string, string>} sources
 * @param {(specifier: string) => boolean} isExternal Whether a bare specifier names a package that stays external.
 * @returns {Promise<{ exports: Map<string, string[]>, imports: Map<string, { static: string[], dynamic: string[], staticExternal: string[], dynamicExternal: string[] }> }>}
 */
async function analyzeModules(esbuild, packageDir, sources, isExternal) {
	const dist = join(packageDir, "dist");
	const result = await esbuild.build({
		absWorkingDir: packageDir,
		entryPoints: [...sources.keys()],
		outdir: join(packageDir, ".bundle-exports"),
		outbase: dist,
		bundle: true,
		splitting: true,
		format: "esm",
		platform: "node",
		metafile: true,
		write: false,
		logLevel: "silent",
		plugins: [
			{
				name: "compiled-sources",
				setup(build) {
					build.onResolve({ filter: /^[^./]/ }, ({ path }) =>
						isExternal(path) ? { path, external: true } : undefined,
					);
					build.onLoad({ filter: /\.js$/ }, ({ path }) => {
						const contents = sources.get(path);
						return contents === undefined ? undefined : { contents, loader: "js" };
					});
				},
			},
		],
	});
	/** @type {Map<string, string[]>} */
	const exports = new Map();
	for (const output of Object.values(result.metafile.outputs)) {
		if (output.entryPoint) exports.set(join(packageDir, output.entryPoint), [...output.exports].sort());
	}
	const imports = new Map();
	for (const [path, input] of Object.entries(result.metafile.inputs)) {
		const edges = { static: [], dynamic: [], staticExternal: [], dynamicExternal: [] };
		for (const edge of input.imports) {
			if (edge.kind !== "import-statement" && edge.kind !== "dynamic-import") continue;
			const dynamic = edge.kind === "dynamic-import";
			if (edge.external) (dynamic ? edges.dynamicExternal : edges.staticExternal).push(edge.path);
			else (dynamic ? edges.dynamic : edges.static).push(join(packageDir, edge.path));
		}
		imports.set(join(packageDir, path), edges);
	}
	return { exports, imports };
}

/**
 * Bundles `packageDir`'s compiled `dist` in place.
 * @param {string} packageDir
 * @param {{ standalone?: readonly string[], inline?: readonly string[], cacheDir?: string, log?: (message: string) => void }} [options]
 *   `standalone`: modules, by path below `dist`, that keep their compiled files. `inline`: packages bundled in.
 */
export async function bundlePackageDist(packageDir, options = {}) {
	const { rolldown } = await import("rolldown");
	const esbuild = await import("esbuild");
	const dist = join(packageDir, "dist");
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	if (manifest.exports) checkExports(manifest.exports);
	const cacheDir = options.cacheDir ?? join(packageDir, "node_modules", ".cache", "atomic-bundle-dist");
	const stateFile = join(cacheDir, "state.json");
	const compiledDir = join(cacheDir, "compiled");
	/** @type {{ facades: Record<string, string> }} */
	const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { facades: {} };
	const standaloneFiles = (options.standalone ?? []).filter((rel) => !rel.endsWith("/")).map((rel) => join(dist, rel));
	const standaloneDirs = (options.standalone ?? []).filter((rel) => rel.endsWith("/")).map((rel) => join(dist, rel));
	/** The standalone modules: those named, and those below a named directory. */
	const standalone = {
		has: (/** @type {string} */ file) =>
			standaloneFiles.includes(file) || standaloneDirs.some((dir) => file.startsWith(dir)),
	};
	const inline = options.inline ?? [];
	/** Whether a bare specifier names a package that stays external, rather than one bundled in. */
	const isExternal = (/** @type {string} */ id) =>
		!id.startsWith(".") &&
		!isAbsolute(id) &&
		!id.startsWith("\0") &&
		!inline.some((name) => id === name || id.startsWith(`${name}/`));
	const requireFromPackage = createRequire(join(packageDir, "package.json"));
	/** Each inlined package's directory, found from its main entry. */
	const inlinedRoots = inline.map((name) => {
		for (let dir = dirname(requireFromPackage.resolve(name)); dir !== dirname(dir); dir = dirname(dir)) {
			const manifestPath = join(dir, "package.json");
			if (existsSync(manifestPath) && JSON.parse(readFileSync(manifestPath, "utf8")).name === name) {
				return { name, dir: resolve(dir) };
			}
		}
		throw new Error(`bundle-package-dist: cannot find the directory of the inlined package ${name}`);
	});
	const inlinedRootOf = (/** @type {string} */ id) => inlinedRoots.find(({ dir }) => id.startsWith(dir + sep));
	/** Whether a module is bundled: the package's own, but for a standalone one, or an inlined package's. */
	const isBundled = (/** @type {string} */ id) =>
		(id.startsWith(dist + sep) && !standalone.has(id)) || inlinedRootOf(id) !== undefined;
	/** A module's name in shared files' names: its path in the package, or `<inlined package>/<path in it>`. */
	const memberName = (/** @type {string} */ id) => {
		const root = inlinedRootOf(id);
		return root ? `${root.name}/${toPosix(relative(root.dir, id))}` : toPosix(relative(packageDir, id));
	};
	for (const file of [...standaloneFiles, ...standaloneDirs]) {
		if (!existsSync(file))
			throw new Error(`bundle-package-dist: standalone module ${relative(dist, file)} does not exist`);
	}

	// Each module's compiled code: the file tsc wrote, or the copy saved when an earlier bundle replaced it.
	/** @type {Map<string, string>} */
	const sources = new Map();
	/** @type {Map<string, string>} */
	const maps = new Map();
	for (const file of compiledFiles(dist)) {
		if (standalone.has(file)) continue;
		const rel = toPosix(relative(dist, file));
		const saved = join(compiledDir, rel);
		const current = readFileSync(file);
		if (state.facades[rel] === digest(current)) {
			if (!existsSync(saved))
				throw new Error(
					`bundle-package-dist: ${rel} is an earlier bundle's output and its compiled copy is gone; rebuild from clean`,
				);
		} else {
			mkdirSync(dirname(saved), { recursive: true });
			writeFileSync(saved, current);
			if (existsSync(`${file}.map`)) writeFileSync(`${saved}.map`, readFileSync(`${file}.map`));
			else if (existsSync(`${saved}.map`)) writeFileSync(`${saved}.map`, "");
		}
		sources.set(file, readFileSync(saved, "utf8"));
		const map = existsSync(`${saved}.map`) ? readFileSync(`${saved}.map`, "utf8") : "";
		if (map !== "") maps.set(file, map);
	}

	const analysis = await analyzeModules(esbuild, packageDir, sources, isExternal);
	const expectedExports = analysis.exports;
	/** A standalone module, external to the bundle, as the bundled files name it: its path below dist. */
	const asImported = (/** @type {string} */ path) => `./${toPosix(relative(dist, path))}`;
	/** @type {(id: string) => ModuleImports} */
	const importsOf = (id) => {
		const edges = analysis.imports.get(id);
		if (!edges) return { internal: [], external: [], dynamicInternal: [], dynamicExternal: [] };
		return {
			internal: edges.static.filter((dep) => !standalone.has(dep)),
			external: [...edges.staticExternal, ...edges.static.filter((dep) => standalone.has(dep)).map(asImported)],
			dynamicInternal: edges.dynamic.filter((dep) => !standalone.has(dep)),
			dynamicExternal: [
				...edges.dynamicExternal,
				...edges.dynamic.filter((dep) => standalone.has(dep)).map(asImported),
			],
		};
	};
	const entries = namedEntries(packageDir, manifest);
	/** @type {Map<string, string>} */
	let groups = new Map();

	const bundle = await rolldown({
		cwd: packageDir,
		input: Object.fromEntries(
			[...sources.keys()].map((file) => [toPosix(relative(dist, file)).replace(/\.js$/, ""), file]),
		),
		// Not "node": the shared helpers would import `node:module` for a `require` no module makes.
		platform: "neutral",
		external: isExternal,
		makeAbsoluteExternalsRelative: true,
		preserveEntrySignatures: "allow-extension",
		treeshake: { moduleSideEffects: true },
		logLevel: "warn",
		onLog(level, log, handler) {
			// A module both imported and dynamically imported stays where its static importers need it.
			if (log.code === "INEFFECTIVE_DYNAMIC_IMPORT") return;
			if (level === "warn") throw new Error(`bundle-package-dist: ${log.message}`);
			handler(level, log);
		},
		plugins: [
			{
				name: "compiled-modules",
				async resolveId(source, importer, extra) {
					if (!importer || !source.startsWith(".")) return null;
					const resolved = await this.resolve(source, importer, { ...extra, skipSelf: true });
					return resolved && standalone.has(resolved.id) ? { id: resolved.id, external: true } : resolved;
				},
				transform(code, id) {
					// An inlined package's module keeps its code, so it cannot need its own URL once in a shared file.
					const root = inlinedRootOf(normalizeId(id));
					if (root && code.includes("import.meta")) {
						throw new Error(
							`bundle-package-dist: the inlined module ${memberName(normalizeId(id))} uses import.meta`,
						);
					}
					return null;
				},
				async load(id) {
					const code = sources.get(normalizeId(id));
					if (code === undefined) return null;
					const map = maps.get(normalizeId(id));
					if (!code.includes("import.meta")) return { code, map: map === undefined ? null : JSON.parse(map) };
					const options = /** @type {const} */ ({
						loader: "js",
						format: "esm",
						target: "esnext",
						sourcefile: id,
						define: { "import.meta.url": MODULE_URL },
					});
					// Token-aware: a mention in a comment or string is not a use. Any meta property but `url` stops the build.
					const probe = (await esbuild.transform(code, { ...options, sourcemap: false })).code;
					if (probe.includes("import.meta")) {
						throw new Error(`bundle-package-dist: ${relative(dist, id)} uses import.meta beyond import.meta.url`);
					}
					if (!probe.includes(MODULE_URL)) return { code, map: map === undefined ? null : JSON.parse(map) };
					const withMap =
						map === undefined
							? code
							: code.replace(
									/\/\/# sourceMappingURL=[^\r\n]*\s*$/,
									`//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString("base64")}\n`,
								);
					const transformed = await esbuild.transform(withMap, {
						...options,
						sourcemap: "external",
						banner: `const ${MODULE_URL} = ${JSON.stringify(`${MODULE_URL_MARKER}${toPosix(relative(dist, normalizeId(id)))}`)};`,
					});
					return { code: transformed.code, map: JSON.parse(transformed.map) };
				},
				buildEnd() {
					// Every module of the package, its JSON files included; anything else it imports is another package.
					const internal = [...this.getModuleIds()].map(normalizeId).filter(isBundled);
					groups = assignGroups(internal, entries, importsOf);
					// An inlined package's modules share files only with each other.
					for (const [id, group] of groups) {
						const root = inlinedRootOf(id);
						if (root) groups.set(id, `${group}|${root.name}`);
					}
				},
			},
		],
	});
	const output = await bundle.generate({
		format: "esm",
		entryFileNames: "[name].js",
		// Named by the group and its first module, never by content (see the file comment).
		chunkFileNames: (chunk) => {
			const own = chunk.moduleIds
				.map(normalizeId)
				.filter(isBundled)
				.map((id) => /** @type {const} */ ([memberName(id), id]))
				.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
			const first = own[0]?.[0] ?? [...chunk.moduleIds].sort()[0] ?? chunk.name;
			const group = own[0] === undefined ? undefined : groups.get(own[0][1]);
			const label =
				group === undefined ? chunk.name.replace(/[^a-zA-Z0-9.-]/g, "_") : group.slice(0, group.indexOf(":"));
			return `_${label}-${stableName(`module:${first}`)}.js`;
		},
		strictExecutionOrder: true,
		minifyInternalExports: false,
		keepNames: true,
		sourcemap: true,
		codeSplitting: {
			groups: [
				{
					name: (id) => groups.get(normalizeId(id)) ?? null,
					debugName: "compiled modules",
					includeDependenciesRecursively: false,
				},
			],
		},
	});
	await bundle.close();

	const chunks = output.output.filter((item) => item.type === "chunk");
	const entryFiles = new Set(chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName));
	for (const chunk of chunks) {
		// Nothing imports from an entry, so no entry gains an export its module lacks.
		const entryImport = chunk.imports.find((name) => entryFiles.has(name));
		if (entryImport) throw new Error(`bundle-package-dist: ${chunk.fileName} imports the entry ${entryImport}`);
		if (!chunk.isEntry || !chunk.facadeModuleId) continue;
		const expected = expectedExports.get(normalizeId(chunk.facadeModuleId)) ?? [];
		const actual = [...chunk.exports].sort();
		if (expected.join(",") !== actual.join(",")) {
			throw new Error(
				`bundle-package-dist: ${chunk.fileName} exports ${actual.join(", ")}, its module ${expected.join(", ")}`,
			);
		}
	}

	// Importing a module's file, statically or following dynamic imports too, reaches the same other modules as the
	// module did.
	const footprintOf = footprints(importsOf);
	const byName = new Map(chunks.map((chunk) => [chunk.fileName, chunk]));
	const fileReach = (/** @type {string} */ start, /** @type {boolean} */ dynamic) => {
		const seen = new Set();
		const externals = new Set();
		const stack = [start];
		while (stack.length > 0) {
			const name = /** @type {string} */ (stack.pop());
			if (seen.has(name)) continue;
			seen.add(name);
			const chunk = byName.get(name);
			if (!chunk) continue;
			for (const imported of dynamic ? [...chunk.imports, ...chunk.dynamicImports] : chunk.imports) {
				if (byName.has(imported)) stack.push(imported);
				// A standalone module is named by its path below dist.
				else externals.add(standalone.has(join(dist, imported)) ? `./${imported}` : imported);
			}
		}
		return [...externals].sort();
	};
	for (const chunk of chunks) {
		if (!chunk.isEntry || !chunk.facadeModuleId) continue;
		const expected = footprintOf(normalizeId(chunk.facadeModuleId));
		for (const [kind, actual, wanted] of /** @type {const} */ ([
			["loads", fileReach(chunk.fileName, false), expected.loaded],
			["reaches", fileReach(chunk.fileName, true), expected.reachable],
		])) {
			if (actual.join(",") !== wanted.join(",")) {
				throw new Error(
					`bundle-package-dist: ${chunk.fileName} ${kind} ${actual.join(", ")}; its module ${wanted.join(", ")}`,
				);
			}
		}
	}

	// Shared files first and the entries last, so an entry never names a shared file not written yet. Each file is
	// written whole before it takes its name.
	const ordered = [...output.output].sort(
		(a, b) =>
			Number(entryFiles.has(a.fileName.replace(/\.map$/, ""))) -
			Number(entryFiles.has(b.fileName.replace(/\.map$/, ""))),
	);
	/** @type {Record<string, string>} */
	const facades = {};
	for (const item of ordered) {
		const path = join(dist, item.fileName);
		let contents = item.type === "chunk" ? item.code : item.source;
		if (item.type === "chunk" && contents.includes(MODULE_URL_MARKER)) {
			const fromDir = dirname(path);
			contents = contents.replace(new RegExp(`"${MODULE_URL_MARKER}([^"]*)"`, "g"), (_, rel) => {
				const target = relative(fromDir, join(dist, rel)).split(sep).map(encodeURIComponent).join("/");
				return `new URL(${JSON.stringify(target.startsWith(".") ? target : `./${target}`)}, import.meta.url).href`;
			});
			if (contents.includes(MODULE_URL_MARKER)) {
				throw new Error(`bundle-package-dist: ${item.fileName} names a module URL the build could not replace`);
			}
		}
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(`${path}.bundle`, contents);
		const mode = existsSync(path) ? statSync(path).mode : undefined;
		renameSync(`${path}.bundle`, path);
		if (mode !== undefined && (mode & 0o111) !== 0) chmodSync(path, statSync(path).mode | (mode & 0o111));
		if (item.type === "chunk" && item.isEntry) facades[item.fileName] = digest(readFileSync(path));
	}
	if (manifest.exports) writeModulesCopy(dist, compiledDir, standalone);
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(stateFile, JSON.stringify({ facades }));
	const shared = chunks.filter((chunk) => !chunk.isEntry).length;
	(options.log ?? console.log)(
		`bundle-package-dist: ${manifest.name}: ${sources.size} modules into ${shared} shared files`,
	);
}

/**
 * Writes the package's compiled modules, one file each as tsc wrote them, under `dist/_modules/`, beside the files
 * they read (the package's other files in `dist`, copied), each with its source map inline.
 * @param {string} dist
 * @param {string} compiledDir The saved compiled modules.
 * @param {{ has(file: string): boolean }} standalone
 */
function writeModulesCopy(dist, compiledDir, standalone) {
	const modules = join(dist, MODULES_DIRECTORY);
	/** @param {string} directory */
	const copy = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			const rel = relative(dist, path);
			if (
				directory === dist &&
				(entry.name === MODULES_DIRECTORY || SHARED_FILE.test(entry.name.replace(/\.map$/, "")))
			)
				continue;
			if (entry.isDirectory()) {
				copy(path);
				continue;
			}
			// Declarations stay in dist. A module's source map goes inline, so the copy adds no files.
			if (/\.d\.ts$|\.map$/.test(entry.name)) continue;
			const target = join(modules, rel);
			const isModule = entry.name.endsWith(".js") && !standalone.has(path);
			const source = isModule ? join(compiledDir, rel) : path;
			/** @type {string | Buffer} */
			let contents = readFileSync(source);
			if (entry.name.endsWith(".js")) {
				const mapFile = `${source}.map`;
				const map = existsSync(mapFile) ? readFileSync(mapFile, "utf8") : "";
				let inline = "";
				if (map !== "") {
					const parsed = JSON.parse(map);
					// Its sources are named relative to the module, one directory deeper now.
					parsed.sources = parsed.sources.map((/** @type {string} */ name) =>
						isAbsolute(name) ? name : `../${name}`,
					);
					inline = `//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(parsed)).toString("base64")}\n`;
				}
				contents = contents.toString("utf8").replace(/\n\/\/# sourceMappingURL=[^\r\n]*\s*$/, "\n") + inline;
			}
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(`${target}.bundle`, contents);
			renameSync(`${target}.bundle`, target);
		}
	};
	copy(dist);
}

/**
 * Checks that each export of the package names its compiled module under `dist/_modules/` with the `module` and
 * `browser` conditions, ahead of `import`, which names the bundled file.
 * @param {Record<string, string | Record<string, string>>} exportsMap
 */
function checkExports(exportsMap) {
	for (const [key, value] of Object.entries(exportsMap)) {
		if (typeof value === "string") {
			if (value.startsWith("./dist/"))
				throw new Error(`bundle-package-dist: export "${key}" must name its compiled module for bundlers`);
			continue;
		}
		if (!value.import?.startsWith("./dist/")) continue;
		const expected = `./dist/${MODULES_DIRECTORY}/${value.import.slice("./dist/".length)}`;
		const names = Object.keys(value);
		for (const condition of ["module", "browser"]) {
			if (value[condition] !== expected || names.indexOf(condition) > names.indexOf("import")) {
				throw new Error(
					`bundle-package-dist: export "${key}" must name ${expected} as "${condition}", before "import"`,
				);
			}
		}
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const list = (/** @type {string} */ flag) =>
		process.argv
			.slice(2)
			.filter((arg) => arg.startsWith(`--${flag}=`))
			.flatMap((arg) => arg.slice(flag.length + 3).split(","))
			.filter(Boolean);
	await bundlePackageDist(process.cwd(), { standalone: list("standalone"), inline: list("inline") });
}
