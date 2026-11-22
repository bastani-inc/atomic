/**
 * Bundles the package's compiled module graph into a few files, run after `tsc` and before the assets are copied.
 *
 * Starting Atomic loads about a thousand of this package's modules, and Node pays a fixed cost for each file and each
 * import it resolves: on Windows several times what it pays on Linux. This build keeps every public entry at its path
 * and moves the code the entries share into `dist/_shared/`, so each module is still evaluated once per process, by
 * whichever entry loads it first: the CLI, the SDK (`@bastani/atomic`, `/rpc-entry`), an extension, or the extension
 * loader's aliases, which name those same entries. Other packages, TypeBox and Atomic's forked packages among them,
 * stay external and keep their own files and identities, but for the few dependencies in `INLINED_PACKAGES`, whose
 * code goes into the shared files too (their licenses go into `dist/THIRD_PARTY_NOTICES.md`).
 *
 * `@bastani/atomic/storage` and `/storage/testing`, whose classes the SDK entry exports too, keep the modules they load
 * as compiled files at their own paths; bundled code imports those by their paths. A process that loaded them from
 * an install later replaced in place therefore keeps one of each of their classes, whatever the release regrouped. The
 * modules they import only when they run become entries of their own, so that import reaches the bundled instance.
 *
 * Each bundled module keeps its own `import.meta.url`: the URL of its compiled file, from the file holding it, so it
 * finds its assets, siblings and workers as before, wherever the package is installed.
 * Dynamic imports become shared files loaded when they run, so what loaded lazily still does. The compiled file of each
 * bundled module is removed from `dist`, so the package holds each module once; a later split that runs without a fresh
 * compile bundles it from the copy saved in the build state. The modules that run by path in a thread or process of
 * their own (the workers and the compile-cache helper) keep their compiled files, and so do the modules they import.
 *
 * Source maps chain to the TypeScript sources through the compiled files' maps.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import { rolldown } from "rolldown";
import { assignStartupGroups, groupName, sharedFileName } from "./split-dist-names.mjs";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
const dist = join(packageDir, "dist");
/** The entries that are bundled: the bin, `main.js` (which the CLI imports), and the SDK's other export paths. */
const BUNDLED_ENTRIES = ["cli", "main", "index", "rpc-entry"];
/**
 * Modules defining what the host and its extensions both hold (the context's model registry and session manager, the
 * context retirement effects, and the session stores' errors): bundled entries at their own paths, which every other module imports by that path,
 * so their own code stays in that one file across releases.
 */
const OWNER_ENTRIES = [
	"core/model-registry",
	"core/session-manager-core",
	"core/extensions/runner-context",
	"core/storage/session/errors",
];
/** The public entries whose modules stay compiled files at their own paths. */
const COMPILED_PUBLIC_ENTRIES = ["core/storage/index", "core/storage/testing"];
/**
 * Modules the compile-cache helper (`utils/compile-cache-warmup.ts`) loads by path besides `main` and `index`: entries
 * at their own paths, so the helper compiles the files a session loads.
 */
const PATH_LOADED_ENTRIES = ["core/http-dispatcher", "cli/settings-startup", "modes/interactive-engine/engine-prewarm"];
/**
 * Modules that run from their compiled files in a thread or process of their own, each with the siblings it imports
 * by a computed path: the extension source transform worker, the image resize worker and the compile-cache helper.
 * They keep their compiled files, and so do the modules they import.
 */
const RUN_BY_PATH = {
	"core/extensions/ts-transform-worker": ["core/extensions/transform-graph", "core/extensions/ts-source-specifiers"],
	"utils/image-resize-worker": [],
	"utils/compile-cache-warmup": [],
};
/** Where shared code goes, below `dist`. */
export const SHARED_DIRECTORY = "_shared";
/**
 * Dependencies bundled into the shared files instead of loaded from `node_modules`: packages only this package's own
 * code imports by name (the extension loader hands none of them to extensions, and Atomic's other packages do not import
 * them), with no state another copy would need to share, that read no file beside their own. The build checks that what
 * each one's bundled code imports is bundled too, or is one of `INLINED_PACKAGE_EXTERNALS`. Kept out: `highlight.js`
 * (code that registers a language or plugin in the installed package changes what the SDK's `highlightCode` does),
 * `undici` (its fetch tells its own frames in error stacks by its file name) and `chalk` (it reads the terminal's color
 * support when it loads).
 */
export const INLINED_PACKAGES = [
	"@borewit/text-codec",
	"@isaacs/nonrecursive-glob-match",
	"@mixmark-io/domino",
	"@nodable/entities",
	"@tokenizer/inflate",
	"@xmldom/xmldom",
	"anynum",
	"balanced-match",
	"base64-js",
	"brace-expansion",
	"content-type",
	"core-util-is",
	"cross-spawn",
	"debug",
	"diff",
	"dingbat-to-unicode",
	"exifr",
	"fast-sha256",
	"fast-xml-builder",
	"fast-xml-parser",
	"file-type",
	"hosted-git-info",
	"ieee754",
	"ignore",
	"immediate",
	"inherits",
	"is-unsafe",
	"isarray",
	"isexe",
	"jszip",
	"lie",
	"lop",
	"lovely-mermaid",
	"lru-cache",
	"mammoth",
	"markit-ai",
	"media-typer",
	"minimatch",
	"ms",
	"music-metadata",
	"option",
	"pako",
	"path-expression-matcher",
	"path-key",
	"process-nextick-args",
	"readable-stream",
	"safe-buffer",
	"semver",
	"setimmediate",
	"shebang-command",
	"shebang-regex",
	"stream-chain",
	"stream-json",
	"string_decoder",
	"strnum",
	"strtok3",
	"token-types",
	"turndown",
	"turndown-plugin-gfm",
	"uint8array-extras",
	"underscore",
	"util-deprecate",
	"which",
	"win-guid",
	"xml-naming",
	"xmlbuilder",
	"yaml",
];
/**
 * Packages an inlined package may import that stay in `node_modules`: `mupdf` loads its WebAssembly file from beside its
 * own module (`@bastani/atomic` declares it at the version markit-ai requires), and `debug` only probes for the optional
 * `supports-color`, which no install has, so the probe fails as before.
 */
export const INLINED_PACKAGE_EXTERNALS = ["mupdf", "supports-color"];
/** Computed imports in inlined packages that never run in Atomic, by the file that makes them, and why. */
const UNFOLLOWED_INLINED_IMPORTS = {
	"node_modules/markit-ai/dist/plugins/api.js": "markit-ai loads plugins only for its own CLI; Atomic loads none",
};
/**
 * The license section of a package's README, for a package that ships its license there instead of in a file of its
 * own: from its heading to the next heading of the same or a higher level.
 */
function readmeLicense(directory, files) {
	const readme = files.find((file) => /^readme(\.|$)/i.test(file));
	if (readme === undefined) return undefined;
	const lines = readFileSync(join(directory, readme), "utf8").split(/\r?\n/);
	const start = lines.findIndex((line) => /^#{1,6}\s+licen[cs]e\b/i.test(line));
	if (start === -1) return undefined;
	const level = /^#+/.exec(lines[start] ?? "")?.[0].length ?? 1;
	const end = lines.findIndex((line, index) => index > start && (/^#+/.exec(line)?.[0].length ?? 7) <= level);
	const section = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
	return section === "" ? undefined : section;
}
/** The terms of the licenses a bundled package declares without shipping their text, by SPDX identifier. */
const LICENSE_TERMS = {
	MIT: `Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`,
	"BSD-2-Clause": `Redistribution and use in source and binary forms, with or without modification, are permitted provided that the
following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following
   disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following
   disclaimer in the documentation and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES,
INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY,
WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`,
};
/**
 * A package's license text when it ships none: the license section of its README, unless that only names the license
 * its manifest declares; else that license's terms with the manifest's author, or, for a license without terms here,
 * its name.
 */
function declaredLicense(directory, files, manifest) {
	const section = readmeLicense(directory, files);
	if (section !== undefined && section !== manifest.license) return section;
	const terms = LICENSE_TERMS[manifest.license];
	if (terms === undefined) return `License: ${manifest.license}`;
	const author = typeof manifest.author === "string" ? manifest.author : manifest.author?.name;
	const copyright = author ? `\n\nCopyright (c) ${author}` : "";
	return `${manifest.license} License (declared in its package.json; the package ships no license text)${copyright}\n\n${terms}`;
}
/** The package a bare specifier names: `name` of `name/sub` or `@scope/name` of `@scope/name/sub`. */
const packageOf = (specifier) => specifier.split("/").slice(0, specifier.startsWith("@") ? 2 : 1).join("/");
/**
 * Marks a path below `dist` in the bundle: once the files are named, each marked path becomes the path from the file
 * holding it, so it names the same file wherever the package is installed. Bundled code imports a compiled module or an
 * owner entry through it, and reads a module's own URL as `new URL(<marked path>, import.meta.url)`.
 */
const DIST_PATH_MARK = "__atomic_dist__/";
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
/** The compiled entries, saved before the split overwrites them, and the compiled bundled modules it removed. */
const COMPILED_ENTRIES = join(STATE_DIRECTORY, "compiled");
const digest = (content) => createHash("sha256").update(content).digest("hex");
/** @type {{ entries: Record<string, string> }} */
const state = existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, "utf8")) : { entries: {} };
/** Whether `dist/<entry>.js` is still what an earlier split wrote there, rather than compiled code. */
const writtenBySplit = (entry) => {
	const file = join(dist, `${entry}.js`);
	return state.entries[entry] !== undefined && existsSync(file) && state.entries[entry] === digest(readFileSync(file));
};
/** Whether `source` is a split's output rather than compiled code. */
const splitOutput = (source) => source.includes(`/${SHARED_DIRECTORY}/`);
/** Puts back `dist/<path>` and its map where an earlier split removed them. */
const restoreCompiled = (path) => {
	const saved = join(COMPILED_ENTRIES, path);
	if (existsSync(join(dist, path)) || !existsSync(saved)) return;
	for (const suffix of ["", ".map"])
		if (existsSync(`${saved}${suffix}`)) writeFileSync(join(dist, `${path}${suffix}`), readFileSync(`${saved}${suffix}`));
};
/** The error for `dist/<path>` holding an earlier split's output when the compiled code it came from is gone. */
const staleSplit = (path) =>
	new Error(
		`split-dist: dist/${path} is an earlier split's output, and the compiled code it was split from is gone, as after a fresh \`npm ci\`; run \`npm run build\` to compile and split again`,
	);
/** `dist/<path>` as compiled, also where an earlier split overwrote or removed it. */
const compiledSource = (path) => {
	const entry = path.replace(/\.js$/, "");
	if (!existsSync(join(dist, path))) {
		const saved = join(COMPILED_ENTRIES, path);
		if (!existsSync(saved))
			throw new Error(`split-dist: dist/${path} is missing and no earlier split saved it; run \`npm run build\` to compile and split again`);
		return readFileSync(saved, "utf8");
	}
	if (!writtenBySplit(entry)) {
		const source = readFileSync(join(dist, path), "utf8");
		if (splitOutput(source)) throw staleSplit(path);
		return source;
	}
	const saved = join(COMPILED_ENTRIES, path);
	if (!existsSync(saved)) throw staleSplit(path);
	return readFileSync(saved, "utf8");
};

/**
 * The modules the compiled public entries load, by static imports (they stay compiled files), and the modules those
 * import dynamically outside that set (bundled entries of their own, so a dynamic import there reaches the bundle).
 */
const compiledModules = new Set();
const lateImports = new Set();
/** Every import of a compiled module, static or dynamic, by its path in `dist`. */
const compiledImports = [];
const relativeImport = (from, specifier) => posix.normalize(posix.join(posix.dirname(from), specifier));
/** The modules of this package that compiled module `path` imports: statically, and dynamically by a literal path. */
const importsOf = (path, source) => {
	const imports = { static: [], dynamic: [] };
	for (const match of source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s*"(\.{1,2}\/[^"]+)"|^import\s*"(\.{1,2}\/[^"]+)"/gm))
		imports.static.push(relativeImport(path, match[1] ?? match[2]));
	for (const match of source.matchAll(/\bimport\(\s*([^)]*?)\s*\)/g)) {
		const literal = /^"(\.{1,2}\/[^"]+)"$/.exec(match[1]);
		if (literal !== null) imports.dynamic.push(relativeImport(path, literal[1]));
		else if (/^["'`]\.{1,2}\//.test(match[1]) || /^`/.test(match[1]))
			throw new Error(`split-dist: ${path} imports a computed path of this package: import(${match[1]})`);
	}
	return imports;
};
const visitCompiled = (path) => {
	if (compiledModules.has(path)) return;
	compiledModules.add(path);
	restoreCompiled(path);
	const imports = importsOf(path, compiledSource(path));
	for (const target of imports.static) {
		compiledImports.push({ from: path, target });
		visitCompiled(target);
	}
	for (const target of imports.dynamic) {
		compiledImports.push({ from: path, target });
		lateImports.add(target);
	}
};
for (const entry of COMPILED_PUBLIC_ENTRIES) visitCompiled(`${entry}.js`);
/** The modules that run by path in a thread or process of their own, and the modules they import. */
const threadModules = new Set();
const visitThread = (path) => {
	if (threadModules.has(path)) return;
	threadModules.add(path);
	restoreCompiled(path);
	const imports = importsOf(path, compiledSource(path));
	for (const target of [...imports.static, ...imports.dynamic]) visitThread(target);
};
for (const [root, siblings] of Object.entries(RUN_BY_PATH)) for (const path of [root, ...siblings]) visitThread(`${path}.js`);
/**
 * The modules the bundled code imports dynamically by a literal path. Each is an entry at its own path: a process of an
 * earlier version, still running from an install updated in place, imports such a module by that path when it first
 * needs it, and finds it there, as it found the compiled file before.
 */
const lazyTargets = new Set();
const bundledVisited = new Set();
const visitBundled = (path) => {
	if (bundledVisited.has(path) || compiledModules.has(path)) return;
	bundledVisited.add(path);
	const imports = importsOf(path, compiledSource(path));
	for (const target of imports.static) visitBundled(target);
	for (const target of imports.dynamic) {
		lazyTargets.add(target);
		visitBundled(target);
	}
};
for (const entry of [...BUNDLED_ENTRIES, ...OWNER_ENTRIES, ...lateImports]) visitBundled(entry.endsWith(".js") ? entry : `${entry}.js`);
/**
 * The modules an earlier release imports on demand by their paths, as each release's record holds them
 * (`in-place-update/<version>.json`, see `scripts/in-place-update-exports.mjs`). A process of that release, still running
 * from an install updated in place, imports each by that path when it first needs it, so each stays an entry at its
 * path, also once this package imports it statically or not at all. A shared file is left out: its name says what it
 * exports, and the release check reports one this build no longer writes.
 */
const RELEASE_RECORDS = join(packageDir, "in-place-update");
if (!existsSync(RELEASE_RECORDS))
	throw new Error(
		`split-dist: ${RELEASE_RECORDS} is missing; the split keeps the modules the releases recorded there import on demand`,
	);
const releasedLazyTargets = new Set();
for (const file of readdirSync(RELEASE_RECORDS).filter((name) => /^\d.*\.json$/.test(name))) {
	const record = JSON.parse(readFileSync(join(RELEASE_RECORDS, file), "utf8"));
	for (const key of Object.keys(record.packages["@bastani/atomic"]?.lazy ?? {})) {
		const prefix = "@bastani/atomic:dist/";
		if (!key.startsWith(prefix) || key.startsWith(`${prefix}${SHARED_DIRECTORY}/`)) continue;
		const path = key.slice(prefix.length);
		if (!existsSync(join(dist, path)) && !existsSync(join(COMPILED_ENTRIES, path)))
			throw new Error(
				`split-dist: ${record.version} imports dist/${path} on demand, and no module of this package compiles to it; keep a module at that path`,
			);
		releasedLazyTargets.add(path);
		visitBundled(path);
	}
}
const SPLIT_ENTRIES = [
	...new Set([
		...BUNDLED_ENTRIES,
		...OWNER_ENTRIES,
		...PATH_LOADED_ENTRIES,
		...[...lateImports, ...lazyTargets, ...releasedLazyTargets]
			.filter((path) => !compiledModules.has(path) && !threadModules.has(path))
			.map((path) => path.replace(/\.js$/, "")),
	]),
];
if (SPLIT_ENTRIES.some((entry) => compiledModules.has(`${entry}.js`)))
	throw new Error("split-dist: a bundled entry is also loaded by a compiled public entry");

// A file an earlier split wrote that is no entry now gets its compiled code back.
for (const entry of Object.keys(state.entries)) {
	if (SPLIT_ENTRIES.includes(entry) || !writtenBySplit(entry)) continue;
	const path = `${entry}.js`;
	for (const suffix of ["", ".map"]) {
		const saved = join(COMPILED_ENTRIES, `${path}${suffix}`);
		if (existsSync(saved)) writeFileSync(join(dist, `${path}${suffix}`), readFileSync(saved));
	}
}

/** Each bundled entry's compiled code and map file path, by its path in `dist`. */
const compiledEntries = new Map();
for (const entry of SPLIT_ENTRIES) {
	restoreCompiled(`${entry}.js`);
	const file = join(dist, `${entry}.js`);
	const saved = join(COMPILED_ENTRIES, `${entry}.js`);
	if (!writtenBySplit(entry)) {
		const compiled = readFileSync(file);
		if (splitOutput(compiled.toString("utf8"))) throw staleSplit(`${entry}.js`);
		mkdirSync(dirname(saved), { recursive: true });
		writeFileSync(saved, compiled);
		if (existsSync(`${file}.map`)) writeFileSync(`${saved}.map`, readFileSync(`${file}.map`));
		else rmSync(`${saved}.map`, { force: true });
	} else if (!existsSync(saved)) {
		throw staleSplit(`${entry}.js`);
	}
	compiledEntries.set(file, { code: readFileSync(saved, "utf8"), mapFile: `${saved}.map` });
}

/** `source` with the source map in `mapFile`, if there is one, inlined in place of its `sourceMappingURL` comment. */
function inlineSourceMap(source, mapFile) {
	if (!existsSync(mapFile)) return source;
	return source.replace(
		/\/\/# sourceMappingURL=[^\r\n]*\s*$/,
		`//# sourceMappingURL=data:application/json;base64,${readFileSync(mapFile).toString("base64")}\n`,
	);
}

const owners = new Set(OWNER_ENTRIES.map((entry) => `${entry}.js`));
const ownerEntryIds = OWNER_ENTRIES.map((entry) => join(dist, `${entry}.js`));
const entryFilesByName = Object.fromEntries(SPLIT_ENTRIES.map((entry) => [entry, join(dist, `${entry}.js`)]));
// Keep `cli.js` (parsed for dynamic entry imports by write-startup-files/stages) and `OWNER_ENTRIES` (external
// singletons whose code must stay in their own files across releases) inline in their own entry files.
const inlineEntryIds = new Set([join(dist, "cli.js"), ...ownerEntryIds]);
const toPosix = (value) => value.split(sep).join("/");
const normalizeId = (id) => (id.startsWith("\0") ? id : id.split("?")[0]);
const relFromPackage = (id) => {
	const rel = toPosix(relative(packageDir, id));
	const nm = rel.lastIndexOf("node_modules/");
	return nm === -1 ? rel : rel.slice(nm);
};
const isInDist = (id) => id.startsWith(dist + sep);

/** @type {Map<string, string>} */
let groups = new Map();
/** @type {Array<{ text: string, location?: { file?: string } }>} */
const bundleWarnings = [];
/** @type {Map<string, Set<string>>} */
const nodeModulesExternalImports = new Map();
/** @type {Set<string>} */
const allBundledIds = new Set();

const bundle = await rolldown({
	cwd: packageDir,
	input: entryFilesByName,
	platform: "node",
	treeshake: false,
	preserveEntrySignatures: "allow-extension",
	onLog(level, log) {
		if (log.code === "CIRCULAR_DEPENDENCY" || log.code === "INEFFECTIVE_DYNAMIC_IMPORT") return;
		if (level === "warn") {
			bundleWarnings.push({
				text: log.message ?? String(log),
				location: { file: log.id ? relFromPackage(normalizeId(log.id)) : undefined },
			});
		}
	},
	plugins: [
		{
			name: "dist-module-url",
			resolveId(source, importer) {
				if (!importer) return null;
				const cleanImporter = normalizeId(importer);
				const recordNodeModuleExternal = (specifier) => {
					if (/(?:^|\/)node_modules\//.test(toPosix(cleanImporter))) {
						let set = nodeModulesExternalImports.get(cleanImporter);
						if (!set) {
							set = new Set();
							nodeModulesExternalImports.set(cleanImporter, set);
						}
						set.add(specifier);
					}
				};
				if (/^\.{1,2}\//.test(source)) {
					if (!isInDist(cleanImporter)) return null;
					const target = toPosix(relative(dist, join(dirname(cleanImporter), source)));
					if (compiledModules.has(target) || owners.has(target)) {
						return { id: `${DIST_PATH_MARK}${target}`, external: true };
					}
					const file = join(dist, target);
					if (!existsSync(file) && existsSync(join(COMPILED_ENTRIES, target))) return file;
					return null;
				}
				if (isAbsolute(source)) return null;
				if (isBuiltin(source)) return { id: source, external: true };
				if (INLINED_PACKAGES.includes(packageOf(source))) return null;
				recordNodeModuleExternal(source);
				return { id: source, external: true };
			},
			async load(rawId) {
				const id = normalizeId(rawId);
				if (!isInDist(id) || !id.endsWith(".js")) return null;
				const entry = compiledEntries.get(id);
				let code;
				let mapFile;
				if (entry !== undefined) {
					code = entry.code;
					mapFile = entry.mapFile;
				} else if (existsSync(id)) {
					code = readFileSync(id, "utf8");
					mapFile = `${id}.map`;
				} else {
					const saved = join(COMPILED_ENTRIES, relative(dist, id));
					if (!existsSync(saved)) return null;
					code = readFileSync(saved, "utf8");
					mapFile = `${saved}.map`;
				}
				if (!code.includes("import.meta")) {
					return { code, map: existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : null };
				}
				const withMap = inlineSourceMap(code, mapFile);
				const options = {
					loader: "js",
					format: "esm",
					target: "esnext",
					sourcefile: id,
					define: { [META_URL]: META_URL_SYMBOL },
				};
				// Token-aware: a mention in a comment is not a use. Any meta property but `url` stops the build.
				const probe = (await transform(withMap, { ...options, sourcemap: false, minifyWhitespace: true })).code;
				if (probe.includes("import.meta")) {
					throw new Error(`split-dist: ${toPosix(relative(dist, id))} uses import.meta beyond import.meta.url`);
				}
				if (!probe.includes(META_URL_SYMBOL)) {
					return { code, map: existsSync(mapFile) ? JSON.parse(readFileSync(mapFile, "utf8")) : null };
				}
				const url = relative(dist, id).split(sep).map(encodeURIComponent).join("/");
				const transformed = await transform(withMap, {
					...options,
					sourcemap: "external",
					banner: `const ${META_URL_SYMBOL} = new URL(${JSON.stringify(`${DIST_PATH_MARK}${url}`)}, import.meta.url).href;`,
				});
				return { code: transformed.code, map: JSON.parse(transformed.map) };
			},
			buildEnd() {
				const moduleIds = [...this.getModuleIds()].map(normalizeId).filter((id) => !id.startsWith("\0"));
				for (const id of moduleIds) allBundledIds.add(id);
				const staticDepsOf = (id) => {
					const info = this.getModuleInfo(id);
					if (!info) return [];
					const deps = [];
					for (const rawDep of info.importedIds) {
						const dep = normalizeId(rawDep);
						if (dep.startsWith("\0")) continue;
						if (dep.startsWith(DIST_PATH_MARK)) {
							const target = dep.slice(DIST_PATH_MARK.length);
							if (owners.has(target)) deps.push(join(dist, target));
							continue;
						}
						deps.push(dep);
					}
					return deps;
				};
				const entryIfPresent = (names) =>
					names.filter((name) => SPLIT_ENTRIES.includes(name)).map((name) => join(dist, `${name}.js`));
				groups = assignStartupGroups(
					moduleIds,
					inlineEntryIds,
					ownerEntryIds,
					{
						shell: entryIfPresent([
							"cli",
							"modes/interactive/startup-shell",
							"cli/settings-startup",
							"modes/interactive-engine/engine-prewarm",
						]),
						http: entryIfPresent(["core/http-dispatcher"]),
						main: entryIfPresent(["main"]),
						modeInteractive: entryIfPresent(["modes/interactive/interactive-mode"]),
						modeRpc: entryIfPresent(["modes/rpc/rpc-mode"]),
						sdk: entryIfPresent(["index", "rpc-entry"]),
					},
					staticDepsOf,
				);
			},
		},
	],
});

const generated = await bundle.generate({
	format: "esm",
	entryFileNames: "[name].js",
	chunkFileNames: (chunk) => {
		const realIds = chunk.moduleIds.map(normalizeId).filter((id) => !id.startsWith("\0"));
		const relInputs = Object.fromEntries(realIds.map((id) => [relFromPackage(id), {}]));
		let filename;
		if (realIds.length === 0) {
			// Synthetic runtime helper chunk (e.g. rolldown:runtime) or empty re-export facade: hash module id/facade
			// plus sorted exports so new helpers produce a fresh filename and never collide with an earlier release.
			const first = chunk.facadeModuleId
				? `entry:${relFromPackage(normalizeId(chunk.facadeModuleId))}`
				: `runtime:${[...chunk.moduleIds].sort()[0] ?? chunk.name}`;
			const stem = chunk.name.replace(/[^a-zA-Z0-9.-]/g, "_");
			filename = `${stem}-${groupName(`${first}\0${[...chunk.exports].sort().join(",")}`)}.js`;
		} else {
			const groupNames = new Set(realIds.map((id) => groups.get(id)).filter((g) => g !== undefined));
			const stem = groupNames.size === 1 ? [...groupNames][0] : chunk.name.replace(/[^a-zA-Z0-9.-]/g, "_");
			const entryPoint = chunk.facadeModuleId ? relFromPackage(normalizeId(chunk.facadeModuleId)) : undefined;
			filename = sharedFileName(stem, { inputs: relInputs, exports: chunk.exports, entryPoint }, chunk.name);
		}
		return `${SHARED_DIRECTORY}/${filename}`;
	},
	keepNames: true,
	strictExecutionOrder: true,
	sourcemap: true,
	sourcemapExcludeSources: true,
	minifyInternalExports: false,
	codeSplitting: {
		groups: [
			{
				name: (id) => groups.get(normalizeId(id)) ?? null,
				debugName: "startup tiers",
				includeDependenciesRecursively: false,
			},
		],
	},
});
await bundle.close();

// Each file is written whole before it takes its name. Shared files of earlier builds stay: a process started from
// them may still load one. A fresh build, as a release's, has none.
// On the main thread, a module is either compiled or bundled, never both: the compiled modules' code stays out of the
// bundle, and every module a compiled module imports is compiled too or an entry whose file the bundle writes.
const bundledModules = new Set(
	[...allBundledIds].filter(isInDist).map((id) => toPosix(relative(dist, id))),
);
for (const path of compiledModules)
	if (bundledModules.has(path)) throw new Error(`split-dist: ${path} is both a compiled file and bundled`);
for (const { from, target } of compiledImports) {
	if (compiledModules.has(target) || SPLIT_ENTRIES.includes(target.replace(/\.js$/, ""))) continue;
	throw new Error(`split-dist: compiled ${from} imports ${target}, whose code is also bundled`);
}

// The compiled files of the bundled modules go, but for the entries and the modules run by path. A module that names
// a file of this package by its path, other than in an import the bundle follows, must name one that stays, and only
// a module run by path may compute one.
const removedModules = [...bundledModules].filter(
	(path) => !SPLIT_ENTRIES.includes(path.replace(/\.js$/, "")) && !threadModules.has(path),
);
const removedSet = new Set(removedModules);
/** The files of this package that a module names by its path. */
const named = new Set();
for (const path of new Set([...bundledModules, ...compiledModules, ...threadModules])) {
	const source = compiledSource(path);
	const computed = /\bnew URL\(\s*`\.{1,2}\/|\bimport\(\s*`/;
	if (!/["'`]\.{1,2}\/[^"'`\r\n]*\.js["'`]/.test(source) && !computed.test(source)) continue;
	// Token-aware: comments and the imports the bundle follows do not count. Minifying whitespace drops every comment, a
	// comment inside an object literal too; printing the result again puts each import on a line of its own.
	const minified = (await transform(source, { loader: "js", format: "esm", minifyWhitespace: true, legalComments: "none" }))
		.code;
	const code = (await transform(minified, { loader: "js", format: "esm" })).code
		.replace(/^(?:import|export)\b[^;]*?\bfrom\s*"[^"]+"|^import\s*"[^"]+"/gm, "")
		.replace(/\bimport\(\s*"[^"]+"\s*\)/g, "");
	if (computed.test(code) && !(path.replace(/\.js$/, "") in RUN_BY_PATH))
		throw new Error(`split-dist: ${path} computes the path of a file of this package; list it in RUN_BY_PATH`);
	for (const match of code.matchAll(/["'`](\.{1,2}\/[^"'`\r\n]*\.js)["'`]/g)) {
		const target = relativeImport(path, match[1]);
		named.add(target);
		if (removedSet.has(target))
			throw new Error(`split-dist: ${path} names ${match[1]}, whose compiled file the split removes`);
	}
}

// The packages bundled in are the inlined ones, and each one's own dependencies are bundled too: a dependency left
// external would resolve from the shared file, not from the package that depends on it.
const inlined = new Map();
for (const rawId of allBundledIds) {
	const input = toPosix(rawId);
	const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.replace(/.*\/node_modules\//, "node_modules/"));
	if (!match) continue;
	if (!INLINED_PACKAGES.includes(match[1])) throw new Error(`split-dist: ${input} is bundled, but ${match[1]} is not inlined`);
	inlined.set(
		match[1],
		rawId.slice(0, rawId.lastIndexOf(`${sep}node_modules${sep}${match[1].replace("/", sep)}${sep}`) + `${sep}node_modules${sep}${match[1].replace("/", sep)}`.length),
	);
}
// The bundle cannot follow an import or require of a computed name. In an inlined package that would run, it would
// resolve from the shared file at run time: only the ones known never to run are allowed.
for (const warning of bundleWarnings) {
	const file = warning.location?.file ?? "";
	if (!/(?:^|\/)node_modules\//.test(file) || !/will not be bundled|cannot be analyzed/i.test(warning.text)) continue;
	if (!Object.keys(UNFOLLOWED_INLINED_IMPORTS).some((suffix) => file.endsWith(suffix)))
		throw new Error(`split-dist: ${file}: ${warning.text}`);
}
// What an inlined package's bundled code imports is bundled too, or one of the few packages that stay external: an
// external import would resolve from the shared file, not from the package that made it. A dependency its bundled code
// never imports (markit-ai's command line's) does not count.
for (const [input, externals] of nodeModulesExternalImports) {
	for (const path of externals) {
		if (path.startsWith("<") || isBuiltin(path) || INLINED_PACKAGE_EXTERNALS.includes(packageOf(path))) continue;
		throw new Error(`split-dist: ${relFromPackage(input)} imports ${path}, which is neither inlined nor allowed to stay external`);
	}
}
const notices = [];
for (const [name, directory] of [...inlined].sort(([a], [b]) => (a < b ? -1 : 1))) {
	const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
	const files = readdirSync(directory);
	// LICENSE, LICENSE.md, LICENSE-MIT, COPYING and the like, else the README's license section.
	const licenseFile = files.find((file) => /^(licen[sc]e|copying)([.-]|$)/i.test(file));
	const noticeFile = files.find((file) => /^notice(\.|$)/i.test(file));
	const license = licenseFile
		? readFileSync(join(directory, licenseFile), "utf8").trim()
		: declaredLicense(directory, files, manifest);
	const notice = noticeFile ? `\n\n${readFileSync(join(directory, noticeFile), "utf8").trim()}` : "";
	notices.push(`## ${name} ${manifest.version}\n\n${license}${notice}\n`);
}

const outputFiles = [];
const emittedMaps = new Set(
	generated.output.filter((item) => item.type === "asset" && item.fileName.endsWith(".js.map")).map((item) => item.fileName),
);
for (const item of generated.output) {
	const path = join(dist, item.fileName);
	let contents = item.type === "chunk" ? item.code : item.source;
	if (item.type === "chunk" && typeof contents === "string") {
		const from = toPosix(relative(dist, dirname(path)));
		contents = contents.replace(new RegExp(`"${DIST_PATH_MARK}([^"]+)"`, "g"), (_, target) => {
			const local = posix.relative(from, target);
			return JSON.stringify(local.startsWith(".") ? local : `./${local}`);
		});
		if (contents.includes(DIST_PATH_MARK)) {
			throw new Error(`split-dist: ${item.fileName} retained an unrewritten ${DIST_PATH_MARK} path`);
		}
		// Synthetic runtime chunks (e.g. rolldown:runtime) emit no source map; write an empty valid v3 map beside
		// every shared chunk so tooling and tests inspecting `<shared>.js.map` always find a valid source map.
		if (item.fileName.startsWith(`${SHARED_DIRECTORY}/`) && !emittedMaps.has(`${item.fileName}.map`)) {
			const base = item.fileName.slice(item.fileName.lastIndexOf("/") + 1);
			outputFiles.push({
				path: `${path}.map`,
				contents: JSON.stringify({ version: 3, file: base, sources: [], names: [], mappings: "" }),
			});
		}
	}
	outputFiles.push({ path, contents });
}

// Verify generated chunk names are unique and startup chunks contain no lazy document-converter modules.
const seenOutputPaths = new Set();
for (const file of outputFiles) {
	if (seenOutputPaths.has(file.path)) throw new Error(`split-dist: duplicate output ${toPosix(relative(dist, file.path))}`);
	seenOutputPaths.add(file.path);
}
for (const item of generated.output) {
	if (item.type !== "chunk" || !item.fileName.startsWith(`${SHARED_DIRECTORY}/startup-`)) continue;
	const markitMod = item.moduleIds.find((id) => toPosix(id).includes("/node_modules/markit-ai/"));
	if (markitMod) throw new Error(`split-dist: startup chunk ${item.fileName} pulled in lazy module ${markitMod}`);
}

// Shared files first and the entries last, so an entry never names a shared file not written yet.
const entryFiles = new Set(SPLIT_ENTRIES.flatMap((entry) => [join(dist, `${entry}.js`), join(dist, `${entry}.js.map`)]));
const ordered = [...outputFiles].sort((a, b) => Number(entryFiles.has(a.path)) - Number(entryFiles.has(b.path)));
for (const file of ordered) {
	mkdirSync(dirname(file.path), { recursive: true });
	writeFileSync(`${file.path}.split`, file.contents);
	renameSync(`${file.path}.split`, file.path);
}
for (const entry of ["cli", "rpc-entry"]) chmodSync(join(dist, `${entry}.js`), 0o755);
writeFileSync(
	join(dist, "THIRD_PARTY_NOTICES.md"),
	`# Third-party notices\n\nThe shared files in \`dist/${SHARED_DIRECTORY}/\` include code from these packages.\n\n${notices.join("\n")}`,
);
mkdirSync(STATE_DIRECTORY, { recursive: true });
writeFileSync(
	STATE_FILE,
	JSON.stringify({
		entries: Object.fromEntries(SPLIT_ENTRIES.map((entry) => [entry, digest(readFileSync(join(dist, `${entry}.js`)))])),
	}),
);

// Each removed file is saved first, so a later split without a fresh compile still bundles it.
const removeCompiled = (path) => {
	const file = join(dist, path);
	if (!existsSync(file)) return;
	const saved = join(COMPILED_ENTRIES, path);
	mkdirSync(dirname(saved), { recursive: true });
	for (const suffix of ["", ".map"]) {
		if (existsSync(`${file}${suffix}`)) renameSync(`${file}${suffix}`, `${saved}${suffix}`);
		else rmSync(`${saved}${suffix}`, { force: true });
	}
};
for (const path of removedModules) removeCompiled(path);

// A compiled file nothing loads, that imports a removed one (a module of the standalone binary's own entry, an unused
// module), could not load either: it goes too, and so on, so that every file the package keeps finds what it imports.
const written = new Set(outputFiles.map((file) => toPosix(relative(dist, file.path))));
const leftovers = () =>
	readdirSync(dist, { recursive: true })
		.map((file) => String(file).split(sep).join("/"))
		.filter((file) => file.endsWith(".js") && !file.startsWith(`${SHARED_DIRECTORY}/`) && !file.startsWith("builtin/"))
		.filter((file) => !written.has(file));
const unloadable = [];
for (let changed = true; changed; ) {
	changed = false;
	for (const path of leftovers()) {
		const { static: imports, dynamic } = importsOf(path, readFileSync(join(dist, path), "utf8"));
		if ([...imports, ...dynamic].every((target) => existsSync(join(dist, target)))) continue;
		if (compiledModules.has(path) || threadModules.has(path) || named.has(path))
			throw new Error(`split-dist: ${path}, which the package loads, imports a file the split removes`);
		removeCompiled(path);
		unloadable.push(path);
		changed = true;
	}
}

const chunkOutputs = generated.output.filter((item) => item.type === "chunk");
console.log(
	`split-dist: ${allBundledIds.size} modules into ${SPLIT_ENTRIES.length} entries and ${chunkOutputs.length - SPLIT_ENTRIES.length} shared files; ${removedModules.length} compiled files removed, ${unloadable.length} more that could not load`,
);
