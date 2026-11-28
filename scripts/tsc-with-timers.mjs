#!/usr/bin/env node
// Sources import the private workspace; compiled packages ship a local copy instead.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const manifest = require.resolve("typescript/package.json");
const compiler = join(dirname(manifest), JSON.parse(readFileSync(manifest, "utf8")).bin.tsc);
const timerConfig = fileURLToPath(new URL("../packages/timers/tsconfig.build.json", import.meta.url));
const privateImport = /(["'])@bastani\/atomic-timers\1/g;

/** @param {string[]} args @param {string} [cwd] */
export function compileTypeScript(args, cwd) {
	const result = spawnSync(process.execPath, [compiler, ...args], { cwd, stdio: "inherit" });
	if (result.status !== 0) throw new Error(`tsc failed (${result.status ?? result.signal})`);
}

/** @param {string} outDir */
export function embedTimers(outDir) {
	// Keep the copy in a new directory so an older Bun process that cached dist can still find it after an update.
	const vendorDir = join(outDir, "__atomic_timers");
	compileTypeScript(["-p", timerConfig, "--outDir", vendorDir]);
	const target = join(vendorDir, "index.js");
	for (const entry of readdirSync(outDir, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(?:js|d\.ts)$/.test(entry.name)) continue;
		const file = join(entry.parentPath, entry.name);
		const original = readFileSync(file, "utf8");
		const path = relative(dirname(file), target).split(sep).join("/");
		const specifier = path.startsWith(".") ? path : `./${path}`;
		const rewritten = original.replace(privateImport, (_match, quote) => `${quote}${specifier}${quote}`);
		if (original !== rewritten) writeFileSync(file, rewritten);
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
	const [outDir, ...args] = process.argv.slice(2);
	if (!outDir) throw new Error("Usage: tsc-with-timers.mjs <outDir> <tsc args...>");
	compileTypeScript([...args, "--outDir", outDir]);
	embedTimers(resolve(outDir));
}
