import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, test } from "vitest";
import { makeTempDirectory, moduleDir, removeTempDirectory, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = join(moduleDir(import.meta.url), "../..");
const DIST = join(ROOT, "packages/coding-agent/dist");
/** One child process that loads the prewarm module: structural, not a slow test. */
const CHILD_TIMEOUT_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/** The relative static imports of a built module (`import … from "./x.js"`, `import "./x.js"`, `export … from`). */
function relativeImports(source: string): string[] {
	return [...source.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?["'](\.{1,2}\/[^"']+)["']/g)].map(
		(match) => match[1]!,
	);
}

test("a session started before an update loads the updated engine prewarm module beside its earlier bootstrap module", () => {
	// This build's prewarm module and everything it imports, at the same places, as an update leaves them on disk.
	const dir = makeTempDirectory("atomic-prewarm-cross-version-");
	dirs.push(dir);
	const dist = join(dir, "dist");
	const copy = (path: string) => {
		const target = join(dist, relative(DIST, path));
		if (existsSync(target)) return;
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(path, target);
		for (const specifier of relativeImports(readFileSync(path, "utf8"))) copy(join(dirname(path), specifier));
	};
	const prewarm = join(DIST, "modes/interactive-engine/engine-prewarm.js");
	copy(prewarm);
	symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"), "junction");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	// The bootstrap module of the version the session started with: every name the prewarm module of 0.10.3 needed,
	// none added since.
	const bootstrap = join(dist, "utils/interactive-engine-bootstrap.js");
	const current = readFileSync(bootstrap, "utf8");
	const earlier = current.replace(/^export const INTERACTIVE_ENGINE_PREWARM_NO_DATABASE = .*$/m, "");
	assert.notEqual(earlier, current, "the earlier bootstrap module lacks the name added since");
	const script = join(dir, "session.mjs");
	writeFileSync(
		script,
		`import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(bootstrap)}, ${JSON.stringify(earlier)});
await import(${JSON.stringify(pathToFileURL(bootstrap).href)});
// The update replaces the installation's files; the session keeps the bootstrap module it loaded.
writeFileSync(${JSON.stringify(bootstrap)}, ${JSON.stringify(current)});
const { prewarmInteractiveEngine } = await import(${JSON.stringify(pathToFileURL(join(dist, relative(DIST, prewarm))).href)});
process.stdout.write(typeof prewarmInteractiveEngine);
`,
	);
	const result = spawnSyncCollect([process.execPath, script], {
		env: { ...process.env, NODE_OPTIONS: "" },
		timeout: CHILD_TIMEOUT_MS,
	});
	assert.equal(result.exitCode, 0, result.stderr.toString());
	assert.equal(result.stdout.toString(), "function");
});
