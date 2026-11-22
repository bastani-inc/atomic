import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL } from "node:url";
import { assignGroups, bundlePackageDist } from "./bundle-package-dist.mjs";

const roots = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** Writes `files` (path below `root` to contents) under a fresh directory. */
function writeTree(root, files) {
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), contents);
	}
}

/**
 * A compiled package: entries, a deep path, a module only a dynamic import reaches and that loads a package the entry
 * does not, `import.meta.url` users, a type-only module and a module kept standalone (which, like another package, is
 * evaluated when the shared file importing it loads, so it has no side effects). Each other module body records its
 * evaluation in `globalThis.order`, each fixture package its load in `globalThis.loaded`.
 */
function fixture() {
	const root = mkdtempSync(join(tmpdir(), "bundle-package-dist-"));
	roots.push(root);
	writeTree(root, {
		"node_modules/light-pkg/package.json": JSON.stringify({ name: "light-pkg", type: "module", main: "index.js" }),
		"node_modules/light-pkg/index.js": `(globalThis.loaded ??= []).push("light-pkg");\nexport const light = 1;\n`,
		"node_modules/heavy-pkg/package.json": JSON.stringify({ name: "heavy-pkg", type: "module", main: "index.js" }),
		"node_modules/heavy-pkg/index.js": `(globalThis.loaded ??= []).push("heavy-pkg");\nexport const heavy = 1;\n`,
		"pkg/package.json": JSON.stringify({
			name: "fixture",
			type: "module",
			main: "./dist/index.js",
			exports: {
				".": { module: "./dist/_modules/index.js", browser: "./dist/_modules/index.js", import: "./dist/index.js" },
				"./extra": {
					module: "./dist/_modules/extra.js",
					browser: "./dist/_modules/extra.js",
					import: "./dist/extra.js",
				},
				"./deep/*": {
					module: "./dist/_modules/deep/*.js",
					browser: "./dist/_modules/deep/*.js",
					import: "./dist/deep/*.js",
				},
			},
		}),
		"pkg/dist/log.js": `export function log(name) {\n\t(globalThis.order ??= []).push(name);\n}\n`,
		"pkg/dist/types.js": "export {};\n",
		"pkg/dist/shared.js": `import { log } from "./log.js";\nimport "light-pkg";\nlog("shared");\nexport const shared = { count: 0 };\nexport class Shared {}\n`,
		"pkg/dist/standalone.js": "export const standaloneUrl = import.meta.url;\n",
		"pkg/dist/index.js": [
			`import { log } from "./log.js";`,
			`import { shared, Shared } from "./shared.js";`,
			`import { standaloneUrl } from "./standalone.js";`,
			`import { nestedAssetUrl } from "./nested/asset-user.js";`,
			`import { exists } from "./fs-user.js";`,
			`export * from "./types.js";`,
			`log("index");`,
			`export { shared, Shared, standaloneUrl, nestedAssetUrl, exists };`,
			`export const assetUrl = new URL("./asset.txt", import.meta.url).href;`,
			`export const loadHeavy = () => import("./heavy-user.js");`,
			`export default "index-default";`,
			"",
		].join("\n"),
		"pkg/dist/extra.js": `import { log } from "./log.js";\nimport { shared, Shared } from "./shared.js";\nlog("extra");\nexport { shared, Shared };\n`,
		"pkg/dist/heavy-user.js": `import "heavy-pkg";\nimport { log } from "./log.js";\nimport { shared } from "./shared.js";\nlog("heavy-user");\nexport const sharedFromHeavy = shared;\n`,
		"pkg/dist/fs-user.js": `import { existsSync } from "node:fs";\nexport const exists = existsSync;\n`,
		"pkg/dist/nested/asset-user.js": `export const nestedAssetUrl = new URL("./data.txt", import.meta.url).href;\n`,
		"loads.mjs": [
			`import { registerHooks } from "node:module";`,
			`globalThis.urls = [];`,
			`registerHooks({ load(url, context, next) { globalThis.urls.push(url); return next(url, context); } });`,
			`await import("fixture");`,
			`await import("fixture/extra");`,
			`await import("fixture/deep/thing");`,
			"",
		].join("\n"),
		"pkg/dist/deep/thing.js": `import { log } from "../log.js";\nlog("deep-thing");\nexport const thingUrl = import.meta.url;\n`,
		// Two modules with functions and classes of the same names, which a shared file holds side by side.
		"pkg/dist/deep/named.js": "export function classify() {}\nexport class Stream {}\n",
		"pkg/dist/deep/named-again.js":
			"function classify() {}\nclass Stream {}\nexport const again = [classify, Stream];\n",
		// A module as tsc writes it with its source map, importing a JSON file.
		"pkg/dist/deep/answer.js": `import values from "../data/values.json" with { type: "json" };\nexport const answer = values.answer;\n//# sourceMappingURL=answer.js.map\n`,
		"pkg/dist/deep/answer.js.map": JSON.stringify({
			version: 3,
			file: "answer.js",
			sourceRoot: "",
			sources: ["../../src/deep/answer.ts"],
			names: [],
			mappings: "AAAA;AACA",
		}),
		"pkg/dist/data/values.json": JSON.stringify({ answer: 42 }),
	});
	return { root, pkg: join(root, "pkg") };
}

/** Runs `script` in a fresh process with `module` imported as `m`, and returns what it prints as JSON. */
function inChild(module, script) {
	const source = `const m = await import(${JSON.stringify(pathToFileURL(module).href)});\n${script}`;
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" }));
}

const bundle = (pkg) => bundlePackageDist(pkg, { standalone: ["standalone.js"], log: () => {} });
/** Makes the fixture package importable by its name from `root`. */
const linkPackage = (root, pkg) => symlinkSync(pkg, join(root, "node_modules", "fixture"), "junction");
const sharedFiles = (pkg) =>
	readdirSync(join(pkg, "dist")).filter((name) => name.startsWith("_") && name.endsWith(".js"));

test("modules run in the same order and with the same exports as before bundling", async () => {
	const { pkg, root } = fixture();
	const unbundled = join(root, "unbundled");
	cpSync(pkg, unbundled, { recursive: true });
	await bundle(pkg);
	const report = "process.stdout.write(JSON.stringify({ order: globalThis.order, keys: Object.keys(m).sort() }));";
	for (const path of ["dist/index.js", "dist/extra.js", "dist/deep/thing.js", "dist/heavy-user.js"]) {
		assert.deepEqual(inChild(join(pkg, path), report), inChild(join(unbundled, path), report), path);
	}
	assert.deepEqual(inChild(join(pkg, "dist/index.js"), report), {
		order: ["shared", "index"],
		keys: ["Shared", "assetUrl", "default", "exists", "loadHeavy", "nestedAssetUrl", "shared", "standaloneUrl"],
	});
});

test("importing a module loads only the packages its own graph imports", async () => {
	const { pkg } = fixture();
	await bundle(pkg);
	const loaded = "process.stdout.write(JSON.stringify(globalThis.loaded ?? []));";
	assert.deepEqual(inChild(join(pkg, "dist/index.js"), loaded), ["light-pkg"]);
	// Neither a module that imports no package nor one beside it in the main entry's graph loads the entry's packages.
	assert.deepEqual(inChild(join(pkg, "dist/deep/thing.js"), loaded), []);
	assert.deepEqual(inChild(join(pkg, "dist/nested/asset-user.js"), loaded), []);
	assert.deepEqual(inChild(join(pkg, "dist/heavy-user.js"), loaded), ["light-pkg", "heavy-pkg"]);
});

test("every path of a module reaches one instance", async () => {
	const { pkg } = fixture();
	await bundle(pkg);
	const result = inChild(
		join(pkg, "dist/index.js"),
		`const base = ${JSON.stringify(pathToFileURL(join(pkg, "dist/")).href)};
		const other = await import(base + "extra.js");
		const heavy = await m.loadHeavy();
		process.stdout.write(JSON.stringify({ sameObject: other.shared === m.shared, sameClass: other.Shared === m.Shared,
			fromLazy: heavy.sharedFromHeavy === m.shared, order: globalThis.order }));`,
	);
	assert.deepEqual(result, {
		sameObject: true,
		sameClass: true,
		fromLazy: true,
		order: ["shared", "index", "extra", "heavy-user"],
	});
});

test("a package only a dynamic import reaches loads when that import runs, not with the entry", async () => {
	const { pkg } = fixture();
	await bundle(pkg);
	const result = inChild(
		join(pkg, "dist/index.js"),
		`const before = [...globalThis.loaded]; await m.loadHeavy(); process.stdout.write(JSON.stringify({ before, after: globalThis.loaded }));`,
	);
	assert.deepEqual(result, { before: ["light-pkg"], after: ["light-pkg", "heavy-pkg"] });
	for (const name of sharedFiles(pkg).filter((file) => file.startsWith("_main-"))) {
		assert.doesNotMatch(readFileSync(join(pkg, "dist", name), "utf8"), /heavy-pkg/);
	}
});

test("import.meta.url stays each module's own file, and a standalone module keeps its compiled file", async () => {
	const { pkg } = fixture();
	const standalone = readFileSync(join(pkg, "dist/standalone.js"), "utf8");
	await bundle(pkg);
	const dist = pathToFileURL(join(pkg, "dist")).href;
	assert.deepEqual(
		inChild(
			join(pkg, "dist/index.js"),
			"process.stdout.write(JSON.stringify([m.assetUrl, m.nestedAssetUrl, m.standaloneUrl]));",
		),
		[`${dist}/asset.txt`, `${dist}/nested/data.txt`, `${dist}/standalone.js`],
	);
	assert.equal(
		inChild(join(pkg, "dist/deep/thing.js"), "process.stdout.write(JSON.stringify(m.thingUrl));"),
		`${dist}/deep/thing.js`,
	);
	assert.equal(readFileSync(join(pkg, "dist/standalone.js"), "utf8"), standalone);
});

test("a module that reaches no Node built-in module still bundles for a browser", async () => {
	const { pkg } = fixture();
	await bundle(pkg);
	const esbuild = await import("esbuild");
	const result = await esbuild.build({
		entryPoints: [join(pkg, "dist/nested/asset-user.js")],
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		logLevel: "silent",
	});
	assert.deepEqual(result.errors, []);
	assert.match(result.outputFiles[0]?.text ?? "", /data\.txt/);
});

test("bundlers get the package's compiled modules, one file each, and Node never loads them", async () => {
	const { root, pkg } = fixture();
	const unbundled = join(root, "unbundled");
	cpSync(pkg, unbundled, { recursive: true });
	await bundle(pkg);
	linkPackage(root, pkg);
	const esbuild = await import("esbuild");
	/** The bundled output of `export { names } from "<specifier>"` as a bundler targeting `platform` builds it. */
	const bundleImport = async (specifier, names, platform) => {
		const result = await esbuild.build({
			stdin: { contents: `export { ${names} } from ${JSON.stringify(specifier)};`, resolveDir: root, loader: "js" },
			bundle: true,
			minify: true,
			platform,
			format: "esm",
			write: false,
			logLevel: "silent",
			external: ["light-pkg", "heavy-pkg"],
		});
		return result.outputFiles[0]?.text ?? "";
	};
	for (const platform of ["browser", "node"]) {
		const viaPackage = await bundleImport("fixture/extra", "Shared", platform);
		assert.equal(viaPackage, await bundleImport(join(unbundled, "dist/extra.js"), "Shared", platform), platform);
		assert.doesNotMatch(viaPackage, /__esmMin|init_/);
	}
	const loaded = inChild(
		join(root, "loads.mjs"),
		"process.stdout.write(JSON.stringify(globalThis.urls.filter((url) => url.includes('/dist/_modules/'))));",
	);
	assert.deepEqual(loaded, []);
});

test("a package whose exports do not name its compiled modules for bundlers is not bundled", async () => {
	const { pkg } = fixture();
	const manifestPath = join(pkg, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.exports["."] = {
		import: "./dist/index.js",
		module: "./dist/_modules/index.js",
		browser: "./dist/_modules/index.js",
	};
	writeFileSync(manifestPath, JSON.stringify(manifest));
	await assert.rejects(
		bundle(pkg),
		/export "\." must name \.\/dist\/_modules\/index\.js as "module", before "import"/,
	);
	manifest.exports["."] = "./dist/index.js";
	writeFileSync(manifestPath, JSON.stringify(manifest));
	await assert.rejects(bundle(pkg), /export "\." must name its compiled module for bundlers/);
});

test("a package bundled in is one copy, loaded from the shared files instead of its own", async () => {
	const { root, pkg } = fixture();
	writeTree(root, {
		"node_modules/inline-pkg/package.json": JSON.stringify({
			name: "inline-pkg",
			type: "module",
			exports: { ".": "./index.js", "./sub": "./sub.js" },
		}),
		"node_modules/inline-pkg/registry.js": "export const registry = new Map();\n",
		"node_modules/inline-pkg/index.js": `export { registry } from "./registry.js";\nexport default "inline-default";\n`,
		"node_modules/inline-pkg/sub.js": `import { registry } from "./registry.js";\nexport const register = (key) => registry.set(key, true);\n`,
		"pkg/dist/vendor.js": `export * from "inline-pkg";\nexport { default } from "inline-pkg";\n`,
		"pkg/dist/vendor-sub.js": `export * from "inline-pkg/sub";\n`,
	});
	await bundlePackageDist(pkg, { standalone: ["standalone.js"], inline: ["inline-pkg"], log: () => {} });
	const result = inChild(
		join(pkg, "dist/vendor.js"),
		`const { register } = await import(${JSON.stringify(pathToFileURL(join(pkg, "dist/vendor-sub.js")).href)});
		register("key");
		process.stdout.write(JSON.stringify({ shared: m.registry.has("key"), fallback: m.default, keys: Object.keys(m).sort() }));`,
	);
	assert.deepEqual(result, { shared: true, fallback: "inline-default", keys: ["default", "registry"] });
	for (const name of sharedFiles(pkg)) {
		assert.doesNotMatch(readFileSync(join(pkg, "dist", name), "utf8"), /from "inline-pkg/);
	}
	assert.doesNotMatch(readFileSync(join(pkg, "dist/vendor.js"), "utf8"), /inline-pkg/);
});

test("shared files are named by their group and first module, the same in every build", async () => {
	const first = fixture();
	const second = fixture();
	await bundle(first.pkg);
	await bundle(second.pkg);
	const names = sharedFiles(first.pkg).sort();
	assert.deepEqual(names, sharedFiles(second.pkg).sort());
	for (const name of names) assert.match(name, /^_(main|lazy|rolldown-runtime)-[A-Z2-7]{8}\.js$/);
	assert.ok(names.some((name) => name.startsWith("_main-")));
});

test("bundling again after an incremental compile keeps the unchanged modules and takes the changed one", async () => {
	const { pkg } = fixture();
	await bundle(pkg);
	const names = sharedFiles(pkg).sort();
	const index = readFileSync(join(pkg, "dist/index.js"), "utf8");
	await bundle(pkg);
	assert.equal(readFileSync(join(pkg, "dist/index.js"), "utf8"), index, "bundling bundled output changes nothing");
	// tsc rewrites only the module whose source changed.
	writeFileSync(
		join(pkg, "dist/extra.js"),
		`import { log } from "./log.js";\nimport { shared, Shared } from "./shared.js";\nlog("extra");\nexport { shared, Shared };\nexport const added = 2;\n`,
	);
	await bundle(pkg);
	// A shared file keeps its name when its modules' code changes.
	assert.deepEqual(sharedFiles(pkg).sort(), names);
	const result = inChild(
		join(pkg, "dist/extra.js"),
		`const index = await import(${JSON.stringify(pathToFileURL(join(pkg, "dist/index.js")).href)});
		process.stdout.write(JSON.stringify({ added: m.added, same: index.shared === m.shared, order: globalThis.order }));`,
	);
	assert.deepEqual(result, { added: 2, same: true, order: ["shared", "extra", "index"] });
});

test("modules share a group only with modules of the same tier that need the same other modules", () => {
	const none = { dynamicInternal: [], dynamicExternal: [] };
	const graph = {
		"/d/index.js": { internal: ["/d/a.js", "/d/leaf.js"], external: ["light"], ...none },
		"/d/a.js": { internal: [], external: ["node:fs"], ...none },
		"/d/leaf.js": { internal: [], external: [], ...none },
		"/d/loader.js": { internal: [], external: [], dynamicInternal: ["/d/provider.js"], dynamicExternal: [] },
		"/d/lazy-helper.js": { internal: ["/d/a.js"], external: [], ...none },
		"/d/provider.js": { internal: ["/d/lazy-helper.js"], external: ["heavy-sdk"], ...none },
		"/d/uses-provider.js": { internal: ["/d/provider.js"], external: [], ...none },
	};
	const groups = assignGroups(Object.keys(graph), ["/d/index.js"], (id) => graph[id]);
	assert.deepEqual(Object.fromEntries(groups), {
		"/d/index.js": "main:light,node:fs;light,node:fs",
		"/d/a.js": "main:node:fs;node:fs",
		"/d/leaf.js": "main:;",
		"/d/loader.js": "lazy:;heavy-sdk,node:fs",
		"/d/lazy-helper.js": "lazy:node:fs;node:fs",
		"/d/provider.js": "lazy:heavy-sdk,node:fs;heavy-sdk,node:fs",
		"/d/uses-provider.js": "lazy:heavy-sdk,node:fs;heavy-sdk,node:fs",
	});
});

test("functions and classes keep their names when a shared file holds two of the same name", async () => {
	const { pkg } = fixture();
	await bundle(pkg);
	const names = (path, values) =>
		inChild(join(pkg, path), `process.stdout.write(JSON.stringify(${values}.map((value) => value.name)));`);
	assert.deepEqual(names("dist/deep/named.js", "[m.classify, m.Stream]"), ["classify", "Stream"]);
	assert.deepEqual(names("dist/deep/named-again.js", "m.again"), ["classify", "Stream"]);
});

test("the package ships each source map once, named by the file it describes, and each imported JSON file once", async () => {
	const { root, pkg } = fixture();
	await bundle(pkg);
	const dist = join(pkg, "dist");
	const files = readdirSync(dist, { recursive: true, encoding: "utf8" }).map((name) => name.split(sep).join("/"));
	for (const map of files.filter((name) => name.endsWith(".map"))) {
		const described = readFileSync(join(dist, map.slice(0, -".map".length)), "utf8");
		assert.equal(/\/\/# sourceMappingURL=(\S+)\s*$/.exec(described)?.[1], map.split("/").at(-1), map);
	}
	// The copy bundlers read keeps the module's map, which still names the module's source.
	const map = JSON.parse(readFileSync(join(dist, "_modules/deep/answer.js.map"), "utf8"));
	assert.equal(resolve(dist, "_modules/deep", map.sources[0]), join(pkg, "src/deep/answer.ts"));
	assert.deepEqual(
		files.filter((name) => name.endsWith(".json")),
		["data/values.json"],
	);
	// Node and bundlers both still read the JSON file.
	assert.equal(inChild(join(dist, "deep/answer.js"), "process.stdout.write(JSON.stringify(m.answer));"), 42);
	linkPackage(root, pkg);
	const esbuild = await import("esbuild");
	const result = await esbuild.build({
		stdin: { contents: 'export { answer } from "fixture/deep/answer";', resolveDir: root, loader: "js" },
		bundle: true,
		platform: "browser",
		format: "esm",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	assert.ok(Object.keys(result.metafile.inputs).some((input) => input.endsWith("pkg/dist/_modules/deep/answer.js")));
	assert.match(result.outputFiles[0]?.text ?? "", /answer: 42/);
});

test("single-entry inlined packages coalesce their static modules into one chunk while keeping dynamic submodules lazy", async () => {
	const { root, pkg } = fixture();
	// Multi-file inlined SDK with distinct Node builtins across its static modules + a dynamic-only submodule.
	writeTree(root, {
		"node_modules/fake-sdk/package.json": JSON.stringify({
			name: "fake-sdk",
			type: "module",
			exports: { ".": "./index.mjs" },
		}),
		"node_modules/fake-sdk/index.mjs": `import { a } from "./a.mjs";\nimport { b } from "./b.mjs";\nexport class FakeClient { run() { return a() + ":" + b(); } }\nexport const loadDynamic = () => import("./dyn.mjs");\n`,
		"node_modules/fake-sdk/a.mjs": `import { basename } from "node:path";\nexport function a() { return basename("/x/y"); }\n`,
		"node_modules/fake-sdk/b.mjs": `import { platform } from "node:os";\nexport function b() { return typeof platform(); }\n`,
		"node_modules/fake-sdk/dyn.mjs": `import { readFileSync } from "node:fs";\nexport const hasFs = typeof readFileSync === "function";\n`,
		"pkg/dist/api-a.js": `import { FakeClient, loadDynamic } from "fake-sdk";\nexport { FakeClient, loadDynamic };\n`,
		"pkg/dist/api-b.js": `import { FakeClient, loadDynamic } from "fake-sdk";\nexport { FakeClient, loadDynamic };\n`,
	});
	const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
	manifest.exports["./api-a"] = {
		module: "./dist/_modules/api-a.js",
		browser: "./dist/_modules/api-a.js",
		import: "./dist/api-a.js",
	};
	manifest.exports["./api-b"] = {
		module: "./dist/_modules/api-b.js",
		browser: "./dist/_modules/api-b.js",
		import: "./dist/api-b.js",
	};
	writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));

	await bundlePackageDist(pkg, { inline: ["fake-sdk"], log: () => {} });
	const sdkChunks = sharedFiles(pkg).filter((name) =>
		readFileSync(join(pkg, "dist", name), "utf8").includes("FakeClient"),
	);
	assert.equal(sdkChunks.length, 1, `expected single coalesced fake-sdk chunk, got ${sdkChunks.join(", ")}`);
	// Dynamic-only submodule stays out of the static chunk (never hoists node:fs into static imports).
	assert.equal(
		readFileSync(join(pkg, "dist", sdkChunks[0]), "utf8").includes("node:fs"),
		false,
		"dynamic submodule must not hoist node:fs into the static SDK chunk",
	);
	const result = inChild(
		join(pkg, "dist/api-a.js"),
		`const b = await import(${JSON.stringify(pathToFileURL(join(pkg, "dist/api-b.js")).href)});
		process.stdout.write(JSON.stringify({ sameClass: m.FakeClient === b.FakeClient, out: new m.FakeClient().run() }));`,
	);
	assert.deepEqual(result, { sameClass: true, out: "y:string" });
	// Modules that do not import fake-sdk must not load fake-sdk's chunk.
	const unrelated = inChild(
		join(pkg, "dist/deep/thing.js"),
		`process.stdout.write(JSON.stringify(typeof m.thingUrl));`,
	);
	assert.equal(unrelated, "string");
	const thingCode = readFileSync(join(pkg, "dist/deep/thing.js"), "utf8");
	assert.equal(thingCode.includes(sdkChunks[0]), false, "unrelated entry must not import fake-sdk chunk");
});

test("strictExecutionOrder: false uses content-hashed chunks, isolates side effects, preserves shebangs, and supports in-place updates from strictExecutionOrder: true", async () => {
	const { pkg } = fixture();
	// Add a bin entry with shebang and a side-effectful module sharing an external footprint with a pure sibling.
	writeTree(pkg, {
		"dist/cli-entry.js": `#!/usr/bin/env node\nimport { shared } from "./shared.js";\nexport const cliShared = shared;\n`,
		"dist/pure-sibling.js": `import { shared } from "./shared.js";\nexport const pureVal = shared.count + 1;\n`,
		"dist/side-effect.js": `import { shared } from "./shared.js";\nglobalThis.__seCount = (globalThis.__seCount ?? 0) + 1;\nexport const seVal = shared.count + 2;\n`,
		"dist/side-effect-user.js": `import { seVal } from "./side-effect.js";\nexport { seVal };\n`,
	});
	const manifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
	manifest.sideEffects = ["./dist/side-effect.js", "./dist/_modules/side-effect.js"];
	manifest.exports["./pure-sibling"] = {
		module: "./dist/_modules/pure-sibling.js",
		browser: "./dist/_modules/pure-sibling.js",
		import: "./dist/pure-sibling.js",
	};
	manifest.exports["./side-effect-user"] = {
		module: "./dist/_modules/side-effect-user.js",
		browser: "./dist/_modules/side-effect-user.js",
		import: "./dist/side-effect-user.js",
	};
	writeFileSync(join(pkg, "package.json"), JSON.stringify(manifest));

	// First bundle with strictExecutionOrder: true (old release) to record legacy chunk names.
	await bundlePackageDist(pkg, {
		standalone: ["standalone.js"],
		strictExecutionOrder: true,
		log: () => {},
	});
	const legacyShared = sharedFiles(pkg);
	const legacyLazy = legacyShared.find((name) => name.startsWith("_lazy-"));
	assert.ok(legacyLazy, `expected a legacy _lazy-* chunk in ${legacyShared.join(", ")}`);

	// Re-bundle with strictExecutionOrder: false and a legacy compat shim for legacyLazy.
	await bundlePackageDist(pkg, {
		standalone: ["standalone.js"],
		strictExecutionOrder: false,
		compatNoopExports: { [legacyLazy]: ["init_legacy_compat"] },
		log: () => {},
	});
	const shared = sharedFiles(pkg);
	const eagerShared = shared.filter((name) => name !== legacyLazy);
	assert.ok(eagerShared.length > 0);
	for (const name of eagerShared) {
		assert.match(name, /^_[a-zA-Z0-9.-]+-e[0-9a-f]{7}\.js$/, `${name} must use content-hashed -e<7hex> name`);
		assert.equal(legacyShared.includes(name), false, `${name} must not collide with any legacy chunk path`);
		const code = readFileSync(join(pkg, "dist", name), "utf8");
		assert.equal(code.includes("__esmMin"), false, `${name} should not contain __esmMin wrappers`);
		assert.equal(code.includes(legacyLazy), false, `${name} must never import legacy compat shim ${legacyLazy}`);
	}
	const mainChunks = eagerShared.filter((name) => name.startsWith("_main-e"));
	assert.ok(
		mainChunks.some((name) => readFileSync(join(pkg, "dist", name), "utf8").includes('import("./heavy-user.js")')),
		"dynamic import must stay targeted at the public entry path ./heavy-user.js",
	);
	// Shebang preserved on virtual entry facade.
	assert.ok(
		readFileSync(join(pkg, "dist/cli-entry.js"), "utf8").startsWith("#!/usr/bin/env node\n"),
		"cli-entry.js must preserve its shebang",
	);
	// Compat shim exists at legacyLazy, re-exports from the new chunk, and provides callable no-op init_legacy_compat.
	const shimCode = readFileSync(join(pkg, "dist", legacyLazy), "utf8");
	assert.match(shimCode, /export function init_legacy_compat\(\)/);
	assert.match(shimCode, /from "\.\/_lazy-e[0-9a-f]{7}\.js"/);
	const compatCall = inChild(
		join(pkg, "dist", legacyLazy),
		`process.stdout.write(JSON.stringify({ type: typeof m.init_legacy_compat, ret: m.init_legacy_compat() === undefined }));`,
	);
	assert.deepEqual(compatCall, { type: "function", ret: true });

	// Side-effect isolation: importing pure-sibling must NOT run side-effect.js; importing side-effect-user MUST.
	const seCheck = inChild(
		join(pkg, "dist/pure-sibling.js"),
		`const before = globalThis.__seCount ?? 0;
		const user = await import(${JSON.stringify(pathToFileURL(join(pkg, "dist/side-effect-user.js")).href)});
		const after = globalThis.__seCount ?? 0;
		process.stdout.write(JSON.stringify({ before, after, pureVal: m.pureVal, seVal: user.seVal }));`,
	);
	assert.deepEqual(seCheck, { before: 0, after: 1, pureVal: 1, seVal: 2 });

	const result = inChild(
		join(pkg, "dist/index.js"),
		`const base = ${JSON.stringify(pathToFileURL(join(pkg, "dist/")).href)};
		const other = await import(base + "extra.js");
		const heavy = await m.loadHeavy();
		process.stdout.write(JSON.stringify({
			sameObject: other.shared === m.shared,
			sameClass: other.Shared === m.Shared,
			fromLazy: heavy.sharedFromHeavy === m.shared,
			standaloneOk: typeof m.standaloneUrl === "string" && m.standaloneUrl.endsWith("/dist/standalone.js"),
			assetOk: m.assetUrl.endsWith("/dist/asset.txt"),
			nestedAssetOk: m.nestedAssetUrl.endsWith("/dist/nested/data.txt"),
		}));`,
	);
	assert.deepEqual(result, {
		sameObject: true,
		sameClass: true,
		fromLazy: true,
		standaloneOk: true,
		assetOk: true,
		nestedAssetOk: true,
	});

	// Changing a module's output bytes must produce a new content-hashed shared chunk filename.
	writeFileSync(join(pkg, "dist/shared.js"), `export const shared = { count: 99 };\nexport class Shared {}\n`);
	await bundlePackageDist(pkg, {
		standalone: ["standalone.js"],
		strictExecutionOrder: false,
		compatNoopExports: { [legacyLazy]: ["init_legacy_compat"] },
		log: () => {},
	});
	const nextMainChunks = sharedFiles(pkg).filter((name) => name.startsWith("_main-e"));
	assert.notDeepEqual(
		nextMainChunks,
		mainChunks,
		"changing module output bytes must change content-hashed chunk names",
	);

	// Live in-place update simulation: a process loads index.js from strictExecutionOrder: true, disk swaps to
	// strictExecutionOrder: false, then the running process lazily imports extra.js and legacyLazy.
	const { pkg: livePkg } = fixture();
	await bundlePackageDist(livePkg, { standalone: ["standalone.js"], strictExecutionOrder: true, log: () => {} });
	const liveLegacyLazy = sharedFiles(livePkg).find((name) => name.startsWith("_lazy-"));
	assert.ok(liveLegacyLazy);
	const stagedNew = mkdtempSync(join(tmpdir(), "bundle-live-new-"));
	roots.push(stagedNew);
	const { pkg: newPkg } = fixture();
	await bundlePackageDist(newPkg, {
		standalone: ["standalone.js"],
		strictExecutionOrder: false,
		compatNoopExports: { [liveLegacyLazy]: ["init_heavy_user"] },
		log: () => {},
	});
	const swapOut = inChild(
		join(livePkg, "dist/index.js"),
		`import { cpSync, rmSync } from "node:fs";
		rmSync(${JSON.stringify(join(livePkg, "dist"))}, { recursive: true, force: true });
		cpSync(${JSON.stringify(join(newPkg, "dist"))}, ${JSON.stringify(join(livePkg, "dist"))}, { recursive: true });
		const extra = await import(${JSON.stringify(pathToFileURL(join(livePkg, "dist/extra.js")).href)});
		const heavy = await m.loadHeavy();
		const shim = await import(${JSON.stringify(pathToFileURL(join(livePkg, "dist", liveLegacyLazy)).href)});
		process.stdout.write(JSON.stringify({
			extraHasShared: typeof extra.shared === "object" && extra.shared !== null,
			extraHasClass: typeof extra.Shared === "function",
			heavyOk: typeof heavy.sharedFromHeavy === "object" && heavy.sharedFromHeavy !== null,
			shimInit: typeof shim.init_heavy_user === "function",
		}));`,
	);
	assert.deepEqual(swapOut, { extraHasShared: true, extraHasClass: true, heavyOk: true, shimInit: true });
});
