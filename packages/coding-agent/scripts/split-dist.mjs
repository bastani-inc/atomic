/**
 * Bundles the package's compiled module graph into a few files, run after `tsc` and before the assets are copied.
 *
 * Starting Atomic loads about a thousand of this package's modules, and Node pays a fixed cost for each file and each
 * import it resolves: on Windows several times what it pays on Linux. This build keeps every public entry at its path
 * and moves the code the entries share into `dist/_shared/`, so each module is still evaluated once per process, by
 * whichever entry loads it first: the CLI, the SDK (`@bastani/atomic`, `/rpc-entry`), an extension, or the extension
 * loader's aliases, which name those same entries. Other packages, TypeBox and Atomic's forked packages among them,
 * stay external and keep their own files and identities.
 *
 * `@bastani/atomic/storage` and `/storage/testing`, whose classes the SDK entry exports too, keep the modules they load
 * as compiled files at their own paths; bundled code imports those through `#dist/*`. A process that loaded them from
 * an install later replaced in place therefore keeps one of each of their classes, whatever the release regrouped. The
 * modules they import only when they run become entries of their own, so that import reaches the bundled instance.
 *
 * Each bundled module keeps its own `import.meta.url`: it reads the URL of its compiled file through
 * `#dist-module-url`, so it finds its assets, siblings and workers as before, wherever the package is installed.
 * Dynamic imports become shared files loaded when they run, so what loaded lazily still does. Every other compiled
 * file stays in place: worker entries and the modules they import by URL run from them, in their own threads.
 *
 * Source maps chain to the TypeScript sources through the compiled files' maps.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const dist = join(packageDir, "dist");
/** The entries that are bundled: the bin, `main.js` (which the CLI imports), and the SDK's other export paths. */
const BUNDLED_ENTRIES = ["cli", "main", "index", "rpc-entry"];
/** The public entries whose modules stay compiled files at their own paths. */
const COMPILED_PUBLIC_ENTRIES = ["core/storage/index", "core/storage/testing"];
/** Where shared code goes, below `dist`. */
export const SHARED_DIRECTORY = "_shared";
/** The package import (package.json `imports`) that gives a compiled module its own URL. */
const MODULE_URL_SPECIFIER = "#dist-module-url";
const MODULE_URL_FILE = join(dist, "dist-module-url.js");
/** The package import prefix (package.json `imports`) through which bundled code reaches a compiled module. */
const COMPILED_SPECIFIER_PREFIX = "#dist/";
const META_URL = "import.meta.url";
const META_URL_SYMBOL = "__atomicDistModuleUrl";

if (!existsSync(join(dist, "cli.js"))) throw new Error("split-dist: run tsc first; dist/cli.js is missing");

/**
 * What the last split wrote: the digest of each entry it bundled. An entry whose file still has that digest was not
 * compiled again since, and is bundled from the compiled copy saved before it was overwritten: the incremental build
 * compiles only what changed, and must still bundle what changed below an entry it left alone. Build state, kept
 * outside the package's files.
 */
const STATE_DIRECTORY = join(packageDir, "node_modules", ".cache", "atomic-split-dist");
const STATE_FILE = join(STATE_DIRECTORY, "state.json");
/** The compiled entries, saved before the split overwrites them. */
const COMPILED_ENTRIES = join(STATE_DIRECTORY, "compiled");
const digest = (content) => createHash("sha256").update(content).digest("hex");
/** @type {{ entries: Record<string, string> }} */
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { entries: {} };
/** Whether `dist/<entry>.js` is still what an earlier split wrote there, rather than compiled code. */
const writtenBySplit = (entry) => {
	const file = join(dist, `${entry}.js`);
	return state.entries[entry] !== undefined && existsSync(file) && state.entries[entry] === digest(readFileSync(file));
};
/** `dist/<path>` as compiled, also where an earlier split overwrote it. */
const compiledSource = (path) => {
	const entry = path.replace(/\.js$/, "");
	if (!writtenBySplit(entry)) return readFileSync(join(dist, path), "utf8");
	const saved = join(COMPILED_ENTRIES, path);
	if (!existsSync(saved))
		throw new Error(`split-dist: ${path} is an earlier split's output and its compiled copy is gone; rebuild from clean`);
	return readFileSync(saved, "utf8");
};

/**
 * The modules the compiled public entries load, by static imports (they stay compiled files), and the modules those
 * import dynamically outside that set (bundled entries of their own, so a dynamic import there reaches the bundle).
 */
const compiledModules = new Set();
const lateImports = new Set();
const relativeImport = (from, specifier) => posix.normalize(posix.join(posix.dirname(from), specifier));
const visitCompiled = (path) => {
	if (compiledModules.has(path)) return;
	compiledModules.add(path);
	const source = compiledSource(path);
	for (const match of source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"(\.{1,2}\/[^"]+)"|^import\s*"(\.{1,2}\/[^"]+)"/gm))
		visitCompiled(relativeImport(path, match[1] ?? match[2]));
	for (const match of source.matchAll(/\bimport\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g)) lateImports.add(relativeImport(path, match[1]));
};
for (const entry of COMPILED_PUBLIC_ENTRIES) visitCompiled(`${entry}.js`);
const SPLIT_ENTRIES = [
	...BUNDLED_ENTRIES,
	...[...lateImports].filter((path) => !compiledModules.has(path)).map((path) => path.replace(/\.js$/, "")),
];
if (SPLIT_ENTRIES.some((entry) => compiledModules.has(`${entry}.js`)))
	throw new Error("split-dist: a bundled entry is also loaded by a compiled public entry");

// A compiled module an earlier split overwrote gets its compiled code back.
for (const path of compiledModules) {
	const entry = path.replace(/\.js$/, "");
	if (!writtenBySplit(entry)) continue;
	for (const suffix of ["", ".map"]) {
		const saved = join(COMPILED_ENTRIES, `${path}${suffix}`);
		if (existsSync(saved)) writeFileSync(join(dist, `${path}${suffix}`), readFileSync(saved));
	}
}

/** Each bundled entry's compiled code with its compiled source map inlined, by its path in `dist`. */
const compiledEntries = new Map();
for (const entry of SPLIT_ENTRIES) {
	const file = join(dist, `${entry}.js`);
	const saved = join(COMPILED_ENTRIES, `${entry}.js`);
	if (!writtenBySplit(entry)) {
		mkdirSync(dirname(saved), { recursive: true });
		writeFileSync(saved, readFileSync(file));
		if (existsSync(`${file}.map`)) writeFileSync(`${saved}.map`, readFileSync(`${file}.map`));
		else rmSync(`${saved}.map`, { force: true });
	} else if (!existsSync(saved)) {
		throw new Error(`split-dist: ${entry}.js is an earlier split's output and its compiled copy is gone; rebuild from clean`);
	}
	compiledEntries.set(file, inlineSourceMap(readFileSync(saved, "utf8"), `${saved}.map`));
}

/** `source` with the source map in `mapFile`, if there is one, inlined in place of its `sourceMappingURL` comment. */
function inlineSourceMap(source, mapFile) {
	if (!existsSync(mapFile)) return source;
	return source.replace(
		/\/\/# sourceMappingURL=[^\r\n]*\s*$/,
		`//# sourceMappingURL=data:application/json;base64,${readFileSync(mapFile).toString("base64")}\n`,
	);
}

const result = await build({
	absWorkingDir: packageDir,
	entryPoints: Object.fromEntries(SPLIT_ENTRIES.map((entry) => [entry, join(dist, `${entry}.js`)])),
	outdir: dist,
	write: false,
	allowOverwrite: true,
	bundle: true,
	splitting: true,
	format: "esm",
	platform: "node",
	target: "node22",
	packages: "external",
	keepNames: true,
	sourcemap: "linked",
	sourcesContent: true,
	chunkNames: `${SHARED_DIRECTORY}/[name]-[hash]`,
	metafile: true,
	logLevel: "warning",
	plugins: [
		{
			name: "dist-module-url",
			setup(context) {
				context.onResolve({ filter: /^#dist-module-url$/ }, () => ({ path: MODULE_URL_SPECIFIER, external: true }));
				// A module a compiled public entry loads is imported from its compiled file, not bundled.
				context.onResolve({ filter: /^\.{1,2}\// }, ({ path, resolveDir }) => {
					const target = relative(dist, join(resolveDir, path)).split(sep).join("/");
					return compiledModules.has(target) ? { path: `${COMPILED_SPECIFIER_PREFIX}${target}`, external: true } : undefined;
				});
				context.onLoad({ filter: /\.js$/ }, async ({ path }) => {
					if (!path.startsWith(dist + sep) || path === MODULE_URL_FILE) return undefined;
					const entry = compiledEntries.get(path);
					const source = entry ?? readFileSync(path, "utf8");
					if (!source.includes("import.meta")) return entry === undefined ? undefined : { contents: entry, loader: "js" };
					// The compiled file's own map, inlined, so the transformed code still maps to its TypeScript source.
					const withMap = entry ?? inlineSourceMap(source, `${path}.map`);
					const options = {
						loader: "js",
						format: "esm",
						target: "esnext",
						sourcefile: path,
						sourcemap: "inline",
						define: { [META_URL]: META_URL_SYMBOL },
					};
					// Token-aware: a mention in a comment is not a use. Any meta property but `url` stops the build.
					const probe = (await transform(withMap, { ...options, sourcemap: false })).code;
					if (probe.includes("import.meta")) throw new Error(`split-dist: ${relative(dist, path)} uses import.meta beyond import.meta.url`);
					if (!probe.includes(META_URL_SYMBOL)) return entry === undefined ? undefined : { contents: entry, loader: "js" };
					const url = relative(dist, path).split(sep).map(encodeURIComponent).join("/");
					const transformed = await transform(withMap, {
						...options,
						banner: `import { distModuleUrl as ${META_URL_SYMBOL}Of } from ${JSON.stringify(MODULE_URL_SPECIFIER)};const ${META_URL_SYMBOL} = /* @__PURE__ */ ${META_URL_SYMBOL}Of(${JSON.stringify(url)});`,
					});
					return { contents: transformed.code, loader: "js", resolveDir: dirname(path) };
				});
			},
		},
	],
});

// Each file is written whole before it takes its name. Shared files of earlier builds stay: a process started from
// them may still load one. A fresh build, as a release's, has none.
// A shared file is named by the first of the modules it holds, by path (or, for one that only re-exports a dynamic
// import, by that import's module), not by its content: an install updated in place keeps the path of every shared
// file whose first module stays first, so a process still running from the earlier install resolves the new entries to
// the modules it already loaded, as it did when each compiled module had a file of its own. Modules a release adds
// after the first, or moves out of it, keep the name. esbuild names it by content; the name keeps esbuild's form and
// length, so no source map shifts.
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const groupName = (key) => {
	const bytes = createHash("sha256").update(key).digest();
	let name = "";
	for (let index = 0; index < 8; index++) name += BASE32[(bytes[index] ?? 0) % 32];
	return name;
};
const renames = new Map();
for (const [output, meta] of Object.entries(result.metafile.outputs)) {
	const match = /^(.*\/)?([^/]+)-([A-Z2-7]{8})\.js$/.exec(output);
	if (!output.startsWith(`dist/${SHARED_DIRECTORY}/`) || match === null) continue;
	// A file that only re-exports a dynamically imported module holds no module of its own: that module names it.
	const members = Object.keys(meta.inputs).sort();
	const renamed = `${match[2]}-${groupName(members.length > 0 ? `module:${members[0]}` : `entry:${meta.entryPoint ?? output}`)}.js`;
	if ([...renames.values()].includes(renamed)) throw new Error(`split-dist: two shared files would be named ${renamed}`);
	renames.set(`${match[2]}-${match[3]}.js`, renamed);
}
const contentNames = renames.size > 0 ? new RegExp([...renames.keys()].map((name) => name.replace(/[.]/g, "\\.")).join("|"), "g") : undefined;
const outputFiles = result.outputFiles.map((file) => {
	const base = file.path.slice(file.path.lastIndexOf(sep) + 1);
	const renamedBase = renames.get(base) ?? renames.get(base.replace(/\.map$/, ""))?.concat(".map");
	const text = contentNames === undefined ? file.text : file.text.replace(contentNames, (name) => renames.get(name) ?? name);
	return { path: renamedBase === undefined ? file.path : join(dirname(file.path), renamedBase), contents: text };
});

// Shared files first and the entries last, so an entry never names a shared file not written yet.
const entryFiles = new Set(SPLIT_ENTRIES.flatMap((entry) => [join(dist, `${entry}.js`), join(dist, `${entry}.js.map`)]));
const ordered = [...outputFiles].sort((a, b) => Number(entryFiles.has(a.path)) - Number(entryFiles.has(b.path)));
for (const file of ordered) {
	mkdirSync(dirname(file.path), { recursive: true });
	writeFileSync(`${file.path}.split`, file.contents);
	renameSync(`${file.path}.split`, file.path);
}
for (const entry of ["cli", "rpc-entry"]) chmodSync(join(dist, `${entry}.js`), 0o755);
mkdirSync(STATE_DIRECTORY, { recursive: true });
writeFileSync(
	STATE_FILE,
	JSON.stringify({
		entries: Object.fromEntries(SPLIT_ENTRIES.map((entry) => [entry, digest(readFileSync(join(dist, `${entry}.js`)))])),
	}),
);

const outputs = Object.keys(result.metafile.outputs).filter((output) => output.endsWith(".js"));
console.log(
	`split-dist: ${Object.keys(result.metafile.inputs).length} modules into ${SPLIT_ENTRIES.length} entries and ${outputs.length - SPLIT_ENTRIES.length} shared files`,
);
