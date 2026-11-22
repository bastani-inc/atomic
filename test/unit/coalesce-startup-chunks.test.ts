import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { assignStartupGroups, startupDepthBucket } from "../../packages/coding-agent/scripts/split-dist-names.mjs";
import { moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const DIST = join(ROOT, "packages/coding-agent/dist");
const CHILD_TIMEOUT_MS = 60_000;
const builtTest = existsSync(join(DIST, "startup-files.json")) ? test : test.skip;

test("startupDepthBucket is monotonically non-decreasing for every ownerMask partition", () => {
	for (const mask of [0, 8, 10, 12, 14, 15]) {
		let prev = -1;
		for (let depth = 0; depth <= 40; depth++) {
			const bucket = startupDepthBucket(depth, mask);
			assert.ok(bucket >= prev, `bucket regressed for mask=${mask} at depth=${depth}: ${prev} -> ${bucket}`);
			prev = bucket;
		}
	}
});

test("assignStartupGroups keeps tiers disjoint, isolates http/mode overlaps, contracts private leaves, and keeps owner-private leaves ungrouped", () => {
	const baseGraph: Record<string, string[]> = {
		cli: ["shellA"],
		shellA: [],
		http: ["httpOnly", "httpMainShared"],
		httpOnly: [],
		httpMainShared: [],
		main: ["ownerA", "mainTop", "httpMainShared"],
		ownerA: ["ownerPrivate", "baseDep"],
		ownerPrivate: [],
		baseDep: [],
		mainTop: ["midDep"],
		midDep: ["baseDep"],
		interactive: ["interOnly", "modeBoth"],
		interOnly: [],
		modeBoth: [],
		rpc: ["rpcOnly", "modeBoth"],
		rpcOnly: [],
		sdk: ["sdkOnly"],
		sdkOnly: [],
		lazyFeature: ["lazyDep"],
		lazyDep: [],
	};
	const run = (graph: Record<string, string[]>) =>
		assignStartupGroups(
			Object.keys(graph),
			new Set(["cli", "ownerA"]),
			["ownerA"],
			{
				shell: ["cli"],
				http: ["http"],
				main: ["main"],
				modeInteractive: ["interactive"],
				modeRpc: ["rpc"],
				sdk: ["sdk"],
			},
			(id) => graph[id] ?? [],
		);

	const g1 = run(baseGraph);
	assert.equal(g1.get("shellA"), "shell");
	// Modules exclusive to http stay in `http`; shared http+main modules join mainCore so main never pulls httpOnly.
	assert.equal(g1.get("httpOnly"), "http");
	assert.ok(
		g1.get("httpMainShared")?.startsWith("startup-"),
		`expected startup-* for httpMainShared, got ${g1.get("httpMainShared")}`,
	);
	// Mode overlaps go to mode-shared so rpc never pulls interOnly and interactive never pulls rpcOnly.
	assert.equal(g1.get("modeBoth"), "mode-shared");
	assert.equal(g1.get("interOnly"), "mode-interactive");
	assert.equal(g1.get("rpcOnly"), "mode-rpc");
	assert.equal(g1.get("sdkOnly"), "sdk");
	// Lazy modules stay ungrouped (undefined).
	assert.equal(g1.get("lazyFeature"), undefined);
	assert.equal(g1.get("lazyDep"), undefined);
	// Owner entry and its private leaf stay ungrouped so the owner entry stays self-contained.
	assert.equal(g1.get("ownerA"), undefined);
	assert.equal(g1.get("ownerPrivate"), undefined);
	// Caller of ownerA (`main`) has a different ownerMask from ownerA's dependency (`baseDep`) -> acyclic across ownerA.
	assert.notEqual(g1.get("main"), g1.get("baseDep"));

	// Adding a single-importer private leaf under `baseDep` contracts into `baseDep`'s group without shifting any other group.
	const withPrivateLeaf: Record<string, string[]> = {
		...baseGraph,
		baseDep: ["zzPrivateLeaf"],
		zzPrivateLeaf: [],
	};
	const g2 = run(withPrivateLeaf);
	assert.equal(g2.get("zzPrivateLeaf"), g1.get("baseDep"));
	for (const [id, group] of g1) {
		assert.equal(g2.get(id), group, `adding a private leaf must not shift group of ${id}`);
	}
});

builtTest(
	"dist/startup-files.json loads <= 25 dist/_shared chunks instead of ~130-170 Venn-diagram shards and keeps >= 8 startup stages",
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
