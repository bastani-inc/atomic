/**
 * Bundles the package's compiled module graph into a few files, run after `tsc` and before the assets are copied.
 *
 * Starting Atomic loads about a thousand of this package's modules, and Node pays a fixed cost for each file and each
 * import it resolves: on Windows several times what it pays on Linux. This build keeps every public entry at its path
 * and moves the code all entries share into `dist/_shared/`, so each module is still evaluated once per process, by
 * whichever entry loads it first: the CLI, the SDK (`@bastani/atomic`, `/storage`, `/storage/testing`, `/rpc-entry`),
 * an extension, or the extension loader's aliases, which name those same entries. Other packages, TypeBox and Atomic's
 * forked packages among them, stay external and keep their own files and identities.
 *
 * Each module keeps its own `import.meta.url`: it reads the URL of its compiled file through `#dist-module-url`, so a
 * module finds its assets, siblings and workers as before, wherever the package is installed. Dynamic imports become
 * chunks loaded when they run, so what loaded lazily still does. Every other compiled file stays in place: worker
 * entries and the modules they import by URL run from them, in their own threads.
 *
 * Source maps chain to the TypeScript sources through the compiled files' maps.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const dist = join(packageDir, "dist");
/** The package's entry points: its bin, the SDK's export paths, and `main.js`, which the CLI imports. */
export const SPLIT_ENTRIES = ["cli", "main", "index", "rpc-entry", "core/storage/index", "core/storage/testing"];
/** Where shared code goes, below `dist`. */
export const SHARED_DIRECTORY = "_shared";
/** The package import (package.json `imports`) that gives a compiled module its own URL. */
const MODULE_URL_SPECIFIER = "#dist-module-url";
const MODULE_URL_FILE = join(dist, "dist-module-url.js");
const META_URL = "import.meta.url";
const META_URL_SYMBOL = "__atomicDistModuleUrl";

if (!existsSync(join(dist, "cli.js"))) throw new Error("split-dist: run tsc first; dist/cli.js is missing");

/**
 * What the last split wrote: the digest of each entry. An entry whose file still has that digest was not compiled
 * again since, and is bundled from the compiled copy saved before it was overwritten: the incremental build compiles
 * only what changed, and must still bundle what changed below an entry it left alone. Build state, kept outside the
 * package's files.
 */
const STATE_DIRECTORY = join(packageDir, "node_modules", ".cache", "atomic-split-dist");
const STATE_FILE = join(STATE_DIRECTORY, "state.json");
/** The compiled entries, saved before the split overwrites them. */
const COMPILED_ENTRIES = join(STATE_DIRECTORY, "compiled");
const digest = (content) => createHash("sha256").update(content).digest("hex");
/** @type {{ entries: Record<string, string> }} */
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { entries: {} };
/** Each entry's compiled code with its compiled source map inlined, by its path in `dist`. */
const compiledEntries = new Map();
for (const entry of SPLIT_ENTRIES) {
	const file = join(dist, `${entry}.js`);
	const saved = join(COMPILED_ENTRIES, `${entry}.js`);
	const current = readFileSync(file);
	if (state.entries[entry] !== digest(current)) {
		mkdirSync(dirname(saved), { recursive: true });
		writeFileSync(saved, current);
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
// Shared files first and the entries last, so an entry never names a shared file not written yet.
const entryFiles = new Set(SPLIT_ENTRIES.flatMap((entry) => [join(dist, `${entry}.js`), join(dist, `${entry}.js.map`)]));
const ordered = [...result.outputFiles].sort((a, b) => Number(entryFiles.has(a.path)) - Number(entryFiles.has(b.path)));
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
