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
 * - A module named with `--standalone=<path below dist>,...` keeps its compiled file and code: the release build of
 *   the single-file binary copies such files beside the binary and loads them from there.
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
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

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
		if (entry.isDirectory()) files.push(...compiledFiles(dist, path));
		else if (entry.name.endsWith(".js") && !(directory === dist && SHARED_FILE.test(entry.name))) files.push(path);
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
 * Assigns each compiled module to a shared file. Modules share a file when they are in the same tier (`main`: what
 * the package's entry points import, `lazy`: what only dynamic imports or deep paths reach) and need the same other
 * packages: the other packages a module's own code and everything it imports load (its footprint). A shared file
 * loads every package its modules import, and a module only shares a file with modules of its own footprint, so
 * importing a module loads no package it did not load before, whichever path it is imported by.
 * @param {string[]} modules Compiled modules, absolute paths.
 * @param {string[]} entries The package's entry points, absolute paths.
 * @param {(id: string) => { internal: string[], external: string[] }} importsOf A module's static imports.
 * @returns {Map<string, string>} Module path to its group, `<tier>:<footprint, comma-separated>`.
 */
export function assignGroups(modules, entries, importsOf) {
	const closure = (/** @type {string[]} */ roots) => {
		const seen = new Set();
		const stack = [...roots];
		while (stack.length > 0) {
			const id = /** @type {string} */ (stack.pop());
			if (seen.has(id)) continue;
			seen.add(id);
			stack.push(...importsOf(id).internal);
		}
		return seen;
	};
	const known = new Set(modules);
	const eager = closure(entries.filter((entry) => known.has(entry)));
	const groups = new Map();
	for (const id of modules) {
		const footprint = new Set();
		for (const reached of closure([id])) {
			for (const external of importsOf(reached).external) if (!isBuiltin(external)) footprint.add(external);
		}
		groups.set(id, `${eager.has(id) ? "main" : "lazy"}:${[...footprint].sort().join(",")}`);
	}
	return groups;
}

/**
 * The export names of each compiled module, from a build that keeps every module as its own entry.
 * @param {typeof import("esbuild")} esbuild
 * @param {string} packageDir
 * @param {Map<string, string>} sources
 */
async function exportNames(esbuild, packageDir, sources) {
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
		packages: "external",
		metafile: true,
		write: false,
		logLevel: "silent",
		plugins: [
			{
				name: "compiled-sources",
				setup(build) {
					build.onLoad({ filter: /\.js$/ }, ({ path }) => {
						const contents = sources.get(path);
						return contents === undefined ? undefined : { contents, loader: "js" };
					});
				},
			},
		],
	});
	/** @type {Map<string, string[]>} */
	const names = new Map();
	for (const output of Object.values(result.metafile.outputs)) {
		if (output.entryPoint) names.set(join(packageDir, output.entryPoint), [...output.exports].sort());
	}
	return names;
}

/**
 * Bundles `packageDir`'s compiled `dist` in place.
 * @param {string} packageDir
 * @param {{ standalone?: readonly string[], cacheDir?: string, log?: (message: string) => void }} [options]
 *   `standalone`: modules, by path below `dist`, that keep their compiled files.
 */
export async function bundlePackageDist(packageDir, options = {}) {
	const { rolldown } = await import("rolldown");
	const esbuild = await import("esbuild");
	const dist = join(packageDir, "dist");
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const cacheDir = options.cacheDir ?? join(packageDir, "node_modules", ".cache", "atomic-bundle-dist");
	const stateFile = join(cacheDir, "state.json");
	const compiledDir = join(cacheDir, "compiled");
	/** @type {{ facades: Record<string, string> }} */
	const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { facades: {} };
	const standalone = new Set((options.standalone ?? []).map((rel) => join(dist, rel)));
	for (const file of standalone) {
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

	const expectedExports = await exportNames(esbuild, packageDir, sources);
	const entries = namedEntries(packageDir, manifest);
	/** @type {Map<string, string>} */
	let groups = new Map();

	const bundle = await rolldown({
		cwd: packageDir,
		input: Object.fromEntries(
			[...sources.keys()].map((file) => [toPosix(relative(dist, file)).replace(/\.js$/, ""), file]),
		),
		platform: "node",
		external: (id) =>
			!id.startsWith(".") && !id.startsWith("/") && !/^[a-zA-Z]:[\\/]/.test(id) && !id.startsWith("\0"),
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
					/** @type {Map<string, string>} */
					const internal = new Map();
					for (const id of this.getModuleIds())
						if (normalizeId(id).startsWith(dist + sep)) internal.set(normalizeId(id), id);
					groups = assignGroups([...internal.keys()], entries, (id) => {
						const imported = (this.getModuleInfo(internal.get(id) ?? id)?.importedIds ?? []).map(normalizeId);
						return {
							internal: imported.filter((dep) => internal.has(dep)),
							external: imported.filter((dep) => !internal.has(dep)),
						};
					});
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
				.filter((id) => id.startsWith(dist + sep))
				.map((id) => toPosix(relative(packageDir, id)));
			const first = own.sort()[0] ?? [...chunk.moduleIds].sort()[0] ?? chunk.name;
			const group = groups.get(join(packageDir, first));
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
	mkdirSync(cacheDir, { recursive: true });
	writeFileSync(stateFile, JSON.stringify({ facades }));
	const shared = chunks.filter((chunk) => !chunk.isEntry).length;
	(options.log ?? console.log)(
		`bundle-package-dist: ${manifest.name}: ${sources.size} modules into ${shared} shared files`,
	);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
	const standalone = process.argv
		.slice(2)
		.filter((arg) => arg.startsWith("--standalone="))
		.flatMap((arg) => arg.slice("--standalone=".length).split(","))
		.filter(Boolean);
	await bundlePackageDist(process.cwd(), { standalone });
}
