import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
			exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js", "./deep/*": "./dist/deep/*.js" },
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
			`export * from "./types.js";`,
			`log("index");`,
			`export { shared, Shared, standaloneUrl, nestedAssetUrl };`,
			`export const assetUrl = new URL("./asset.txt", import.meta.url).href;`,
			`export const loadHeavy = () => import("./heavy-user.js");`,
			`export default "index-default";`,
			"",
		].join("\n"),
		"pkg/dist/extra.js": `import { log } from "./log.js";\nimport { shared, Shared } from "./shared.js";\nlog("extra");\nexport { shared, Shared };\n`,
		"pkg/dist/heavy-user.js": `import "heavy-pkg";\nimport { log } from "./log.js";\nimport { shared } from "./shared.js";\nlog("heavy-user");\nexport const sharedFromHeavy = shared;\n`,
		"pkg/dist/nested/asset-user.js": `export const nestedAssetUrl = new URL("./data.txt", import.meta.url).href;\n`,
		"pkg/dist/deep/thing.js": `import { log } from "../log.js";\nlog("deep-thing");\nexport const thingUrl = import.meta.url;\n`,
	});
	return { root, pkg: join(root, "pkg") };
}

/** Runs `script` in a fresh process with `module` imported as `m`, and returns what it prints as JSON. */
function inChild(module, script) {
	const source = `const m = await import(${JSON.stringify(pathToFileURL(module).href)});\n${script}`;
	return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" }));
}

const bundle = (pkg) => bundlePackageDist(pkg, { standalone: ["standalone.js"], log: () => {} });
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
		keys: ["Shared", "assetUrl", "default", "loadHeavy", "nestedAssetUrl", "shared", "standaloneUrl"],
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

test("modules share a group only with modules of the same tier that load the same other packages", () => {
	const graph = {
		"/d/index.js": { internal: ["/d/a.js", "/d/leaf.js"], external: ["light", "node:fs"] },
		"/d/a.js": { internal: [], external: ["fs"] },
		"/d/leaf.js": { internal: [], external: [] },
		"/d/lazy-helper.js": { internal: ["/d/a.js"], external: [] },
		"/d/provider.js": { internal: ["/d/lazy-helper.js"], external: ["heavy-sdk"] },
		"/d/uses-provider.js": { internal: ["/d/provider.js"], external: [] },
	};
	const groups = assignGroups(Object.keys(graph), ["/d/index.js"], (id) => graph[id]);
	assert.deepEqual(Object.fromEntries(groups), {
		"/d/index.js": "main:light",
		"/d/a.js": "main:",
		"/d/leaf.js": "main:",
		"/d/lazy-helper.js": "lazy:",
		"/d/provider.js": "lazy:heavy-sdk",
		"/d/uses-provider.js": "lazy:heavy-sdk",
	});
});
