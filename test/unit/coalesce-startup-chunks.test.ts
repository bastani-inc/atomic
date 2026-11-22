import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const DIST = join(ROOT, "packages/coding-agent/dist");
const CHILD_TIMEOUT_MS = 60_000;
const builtTest = existsSync(join(DIST, "startup-files.json")) ? test : test.skip;

builtTest(
	"dist/startup-files.json loads <= 25 dist/_shared chunks instead of ~160 Venn-diagram shards and keeps >= 8 startup stages",
	() => {
		const list = JSON.parse(readFileSync(join(DIST, "startup-files.json"), "utf8")) as {
			packages: [string, number][];
			files: [number, string][];
		};
		const sharedStartup = list.files
			.filter(([index, file]) => list.packages[index]?.[0] === "@bastani/atomic" && file.startsWith("dist/_shared/"))
			.map(([, file]) => file);
		assert.ok(
			sharedStartup.length <= 25,
			`expected <= 25 dist/_shared startup chunks, got ${sharedStartup.length}: ${sharedStartup.slice(0, 10).join(", ")}`,
		);
		const stages = JSON.parse(readFileSync(join(DIST, "startup-stages/stages.json"), "utf8")) as {
			stages: number;
		};
		assert.ok(
			stages.stages >= 8,
			`expected >= 8 startup stages for early-editor responsiveness, got ${stages.stages}`,
		);
	},
);

builtTest(
	"startup-shell.js loads <= 4 dist/_shared chunks and main.js loads <= 22 dist/_shared chunks",
	() => {
		const audit = (entry: string): string[] => {
			const script = `import { registerHooks } from "node:module";
const shared = [];
registerHooks({ load(url, ctx, next) { if (url.includes("/dist/_shared/")) shared.push(url); return next(url, ctx); } });
await import(${JSON.stringify(pathToFileURL(join(DIST, entry)).href)});
console.log(JSON.stringify(shared));`;
			const res = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
				cwd: ROOT,
				env: { ...process.env, NODE_OPTIONS: "" },
				timeout: CHILD_TIMEOUT_MS,
			});
			assert.equal(res.exitCode, 0, res.stderr.toString());
			return JSON.parse(res.stdout.toString()) as string[];
		};
		const shellShared = audit("modes/interactive/startup-shell.js");
		assert.ok(
			shellShared.length <= 4,
			`expected <= 4 dist/_shared chunks for startup-shell, got ${shellShared.length}`,
		);
		const mainShared = audit("main.js");
		assert.ok(mainShared.length <= 22, `expected <= 22 dist/_shared chunks for main.js, got ${mainShared.length}`);
	},
	CHILD_TIMEOUT_MS,
);
