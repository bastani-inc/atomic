/**
 * A process keeps every module it has loaded and loads the rest from the installation on disk, which an in-place update
 * (`npm install -g`, `bun add -g`) replaces while the process runs. A module the process loads after the update links
 * against the copies it loaded before: it may name only exports those copies have. These tests hold this build to the
 * exports of the modules a 0.10.3 process has loaded (`test/fixtures/atomic-0.10.3/exports.json`).
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { type ImportDeclaration, type ImportExpression, type Node, parse } from "acorn";
import { simple } from "acorn-walk";
import { afterEach, test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const DIST = join(PACKAGE, "dist");
const RELEASED = JSON.parse(readFileSync(join(ROOT, "test/fixtures/atomic-0.10.3/exports.json"), "utf8")) as {
	entry: Record<string, string[]>;
	modules: Record<string, string[]>;
	host: Record<string, string[]>;
};
/** One child process that loads part of the application: structural, not a slow test. */
const CHILD_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/** A `dist/`-relative path the way the fixture names modules. */
function packagePath(file: string): string {
	return relative(PACKAGE, file).split(sep).join("/");
}

interface ModuleImports {
	/** Static imports and re-exports, each with the names it takes (`default` for a default import). */
	readonly named: { specifier: string; names: string[] }[];
	/** Specifiers of `import()` with a literal argument. */
	readonly dynamic: string[];
}

function moduleImports(file: string): ModuleImports {
	const program = parse(readFileSync(file, "utf8"), {
		ecmaVersion: "latest",
		sourceType: "module",
		allowHashBang: true,
	});
	const named: ModuleImports["named"] = [];
	for (const node of program.body) {
		if (node.type === "ImportDeclaration") {
			const names: string[] = [];
			for (const specifier of (node as ImportDeclaration).specifiers) {
				if (specifier.type === "ImportSpecifier")
					names.push(
						specifier.imported.type === "Identifier" ? specifier.imported.name : String(specifier.imported.value),
					);
				else if (specifier.type === "ImportDefaultSpecifier") names.push("default");
			}
			named.push({ specifier: String(node.source.value), names });
		} else if (node.type === "ExportNamedDeclaration" && node.source) {
			const names = node.specifiers.map((specifier) =>
				specifier.local.type === "Identifier" ? specifier.local.name : String(specifier.local.value),
			);
			named.push({ specifier: String(node.source.value), names });
		} else if (node.type === "ExportAllDeclaration") {
			named.push({ specifier: String(node.source.value), names: [] });
		}
	}
	const dynamic: string[] = [];
	simple(program as Node, {
		ImportExpression(node) {
			const source = (node as ImportExpression).source;
			if (source.type === "Literal" && typeof source.value === "string") dynamic.push(source.value);
		},
	});
	return { named, dynamic };
}

function relativeTarget(file: string, specifier: string): string | undefined {
	if (!specifier.startsWith("./") && !specifier.startsWith("../")) return undefined;
	const target = resolve(dirname(file), specifier.replace(/\.ts$/, ".js"));
	return existsSync(target) ? target : undefined;
}

/** Every module of the package a process can load, from its entries, through static and literal dynamic imports. */
function loadableModules(): Set<string> {
	const entries = ["cli.js", "index.js", "rpc-entry.js", "core/storage/index.js"].map((entry) => join(DIST, entry));
	const seen = new Set(entries);
	const queue = [...entries];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		const { named, dynamic } = moduleImports(file);
		for (const specifier of [...named.map((entry) => entry.specifier), ...dynamic]) {
			const target = relativeTarget(file, specifier);
			if (target && !seen.has(target)) {
				seen.add(target);
				queue.push(target);
			}
		}
	}
	return seen;
}

test("modules a 0.10.3 process loads after an update name only exports its startup modules have", () => {
	const missing: string[] = [];
	for (const file of loadableModules()) {
		const path = packagePath(file);
		// The process keeps its own copy of a startup module (and of the entry): the update's copy never loads there.
		if (path === "dist/cli.js" || RELEASED.entry[path]) continue;
		for (const { specifier, names } of moduleImports(file).named) {
			const target = relativeTarget(file, specifier);
			const released = target ? RELEASED.entry[packagePath(target)] : undefined;
			if (!released) continue;
			for (const name of names)
				if (!released.includes(name)) missing.push(`${path} imports ${name} from ${packagePath(target!)}`);
		}
	}
	assert.deepEqual(missing, []);
});

test("builtin extensions name only host exports a 0.10.3 process has", () => {
	const hostNames: Record<string, string[] | undefined> = {
		...RELEASED.host,
		"@earendil-works/pi-coding-agent": RELEASED.host["@bastani/atomic"],
		"@mariozechner/pi-coding-agent": RELEASED.host["@bastani/atomic"],
	};
	const bundles: string[] = [];
	const collect = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// The Intercom broker runs as its own process, from the files of one version.
				if (entry.name !== "node_modules" && entry.name !== "broker") collect(path);
			} else if (entry.name.endsWith(".bundle.mjs")) bundles.push(path);
		}
	};
	collect(join(DIST, "builtin"));
	assert.ok(bundles.length >= 4, `builtin bundles: ${bundles.join(", ")}`);
	const missing: string[] = [];
	for (const bundle of bundles) {
		for (const { specifier, names } of moduleImports(bundle).named) {
			const released = hostNames[specifier];
			if (!released) continue;
			for (const name of names)
				if (!released.includes(name)) missing.push(`${packagePath(bundle)} imports ${name} from ${specifier}`);
		}
	}
	assert.deepEqual(missing, []);
});

/** Where the package build keeps the compiled code of the modules it bundles and no longer ships as files. */
const COMPILED = join(PACKAGE, "node_modules/.cache/atomic-split-dist/compiled");

/**
 * A module's `file:` URL as the process loads it (the real path, through the workspace's package links), its 0.10.3
 * exports, and whether this build ships a file there. A module the package now bundles has no file of its own: the
 * process still holds the copy it loaded, and nothing in this build imports it from that path.
 */
function releasedModule(path: string): [url: string, entry: { names: string[]; shipped: boolean }] {
	const names = RELEASED.modules[path] ?? RELEASED.entry[path];
	assert.ok(names, `no recorded 0.10.3 exports for ${path}`);
	const file = path.startsWith("@bastani/atomic-ai/utils/")
		? join(ROOT, "packages/ai/dist/utils", `${path.slice("@bastani/atomic-ai/utils/".length)}.js`)
		: path === "@bastani/atomic-tui"
			? join(ROOT, "packages/tui/dist/index.js")
			: join(PACKAGE, path);
	const shipped = existsSync(file);
	assert.ok(shipped || existsSync(join(COMPILED, relative(DIST, file))), file);
	return [pathToFileURL(file).href, { names, shipped }];
}

/**
 * A process that loaded the `cached` modules as 0.10.3 shipped them (their 0.10.3 exports, with this build's values)
 * when an update replaced the installation, then loads `lazy` from the update. Returns the child's outcome.
 */
function loadAfterUpdate(cached: string[], lazy: string): { exitCode: number | null; stdout: string; stderr: string } {
	const dir = makeTempDirectory("atomic-in-place-update-");
	dirs.push(dir);
	const script = join(dir, "session.mjs");
	writeFileSync(
		script,
		`import { registerHooks } from "node:module";
const released = new Map(${JSON.stringify(cached.map((path) => releasedModule(path)))});
let updated = false;
registerHooks({
	resolve(specifier, context, nextResolve) {
		const module = updated ? undefined : released.get(specifier);
		return module && !module.shipped ? { url: specifier, shortCircuit: true } : nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		const module = updated ? undefined : released.get(url);
		if (!module) return nextLoad(url, context);
		// A module this build no longer ships as a file keeps its 0.10.3 names; nothing here reads their values.
		const current = JSON.stringify(url + "?atomic-0.10.3");
		const source = module.shipped ? [\`import * as current from \${current};\`] : ["const current = {};"];
		for (const name of module.names) source.push(name === "default" ? "export default current.default;" : \`export const \${name} = current.\${name};\`);
		return { format: "module", source: source.join("\\n"), shortCircuit: true };
	},
});
for (const url of released.keys()) await import(url);
// The update replaces the installation: every module not loaded yet comes from it.
updated = true;
const loaded = await import(${JSON.stringify(pathToFileURL(join(DIST, lazy)).href)});
process.stdout.write(String(Object.keys(loaded).length));
`,
	);
	const result = spawnSyncCollect([process.execPath, script], {
		cwd: dir,
		env: { ...process.env, NODE_OPTIONS: "" },
		timeout: CHILD_TIMEOUT_MS,
	});
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

for (const { lazy, cached, path } of [
	{
		path: "the interactive engine prewarm",
		lazy: "modes/interactive-engine/engine-prewarm.js",
		cached: ["dist/utils/compile-cache.js", "dist/utils/interactive-engine-bootstrap.js"],
	},
	{
		// The package bundles interactive startup; a process reaches it through main.js, which the CLI imports lazily.
		path: "interactive startup",
		lazy: "main.js",
		cached: ["dist/utils/compile-cache.js", "dist/utils/interactive-engine-bootstrap.js"],
	},
	{
		path: "the compile cache helper",
		lazy: "utils/compile-cache-warmup-host.js",
		cached: ["dist/utils/compile-cache.js"],
	},
	{
		path: "a released session's history",
		lazy: "core/storage/session/released-history-files.js",
		cached: ["dist/core/process-start-token.js", "@bastani/atomic-tui"],
	},
	{
		path: "the HTTP dispatcher",
		lazy: "core/http-dispatcher.js",
		cached: ["@bastani/atomic-ai/utils/tls-certificate", "@bastani/atomic-ai/utils/node-http-proxy"],
	},
]) {
	test(
		`a process started on 0.10.3 loads ${path} after an update replaced its installation`,
		() => {
			const result = loadAfterUpdate(cached, lazy);
			assert.equal(result.exitCode, 0, result.stderr);
			assert.ok(Number(result.stdout) > 0, result.stdout);
		},
		CHILD_TIMEOUT_MS,
	);
}
