#!/usr/bin/env node
// Records the files an interactive session's startup loads, in the order it loads them, as dist/startup-files.json.
// At startup Atomic reads them in parallel ahead of the module loader (src/utils/startup-prefetch.ts), so a cold start
// does not wait for each file in turn. Each file is named by its package and its path inside that package, so the
// list holds wherever npm or Bun put the packages.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(packageRoot, "dist");
const output = join(dist, "startup-files.json");
const workspaceRoot = resolve(packageRoot, "..", "..");
const workspacePackages = new Map();

if (process.argv[2] !== "--trace") {
	// Trace in a process of its own, so no module this script loads is counted.
	const traceFile = `${output}.trace`;
	const traced = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--trace", traceFile], {
		cwd: packageRoot,
		stdio: ["ignore", "inherit", "inherit"],
		env: { ...process.env, NODE_OPTIONS: "" },
	});
	if (traced.status !== 0) throw new Error(`Tracing the startup files failed with status ${traced.status}`);
	const files = JSON.parse(readFileSync(traceFile, "utf8"));
	rmSync(traceFile);
	writeFileSync(output, `${JSON.stringify(toEntries(files))}\n`);
	console.log(`Recorded ${files.length} startup files -> ${relative(packageRoot, output)}`);
} else {
	const { registerHooks } = await import("node:module");
	const seen = new Set();
	const files = [];
	const record = (url) => {
		if (!url.startsWith("file:")) return;
		const path = fileURLToPath(url);
		if (seen.has(path)) return;
		seen.add(path);
		files.push(path);
	};
	registerHooks({
		load(url, context, nextLoad) {
			record(url);
			return nextLoad(url, context);
		},
	});
	const load = (path) => import(pathToFileURL(join(dist, path)).href);
	// What `cli.js` loads for an interactive session, then what the session loads before its first frame: the host
	// module map an extension sees, the extension loader and the bundled packages' extensions.
	for (const entry of [
		"cli/settings-startup.js",
		"core/http-dispatcher.js",
		"core/storage/node-sqlite-thread.js",
		"modes/interactive-engine/engine-prewarm.js",
		"main.js",
		"index.js",
		"core/extensions/loader-virtual-modules.js",
	])
		await load(entry);
	await (await load("core/extensions/loader-host-modules.js")).getVirtualModules();
	await import("jiti");
	const builtin = join(dist, "builtin");
	for (const bundle of [
		"intercom/index.bundle.mjs",
		"subagents/src/extension/index.bundle.mjs",
		"mcp/index.bundle.mjs",
		"web-access/index.bundle.mjs",
	]) {
		const path = join(builtin, bundle);
		if (existsSync(path)) record(pathToFileURL(path).href);
	}
	writeFileSync(process.argv[3], JSON.stringify(files));
	process.exit(0);
}

/**
 * The package a file belongs to and its path inside it: the package under the last `node_modules` in its path, or the
 * workspace package it is in (bundled extensions under `dist/builtin` belong to Atomic's own package).
 */
function packagePathOf(path) {
	const parts = path.split(sep);
	const last = parts.lastIndexOf("node_modules");
	if (last !== -1) {
		const nameParts = parts[last + 1]?.startsWith("@") ? 2 : 1;
		const name = parts.slice(last + 1, last + 1 + nameParts).join("/");
		return { name, path: parts.slice(last + 1 + nameParts).join("/") };
	}
	const inWorkspace = relative(join(workspaceRoot, "packages"), path).split(sep);
	if (inWorkspace[0] === ".." || inWorkspace.length < 2) return undefined;
	const dir = inWorkspace[0];
	let name = workspacePackages.get(dir);
	if (name === undefined) {
		name = JSON.parse(readFileSync(join(workspaceRoot, "packages", dir, "package.json"), "utf8")).name;
		workspacePackages.set(dir, name);
	}
	return { name, path: inWorkspace.slice(1).join("/") };
}

function toEntries(files) {
	const packages = [];
	const indexes = new Map();
	const entries = [];
	for (const file of files) {
		const found = packagePathOf(file);
		if (found === undefined) continue;
		let index = indexes.get(found.name);
		if (index === undefined) {
			index = packages.push(found.name) - 1;
			indexes.set(found.name, index);
		}
		entries.push([index, found.path]);
	}
	const self = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).name;
	return { version: 1, self, packages, files: entries };
}
