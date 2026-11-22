import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, resolve } from "node:path";
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

test("assignStartupGroups keeps phases and tiers disjoint, isolates http/settingsStartup/mode overlaps, tracks owner-private transitive edges, and contracts private leaves", () => {
	const baseGraph: Record<string, string[]> = {
		cli: ["cliDep"],
		cliDep: [],
		prewarm: ["cliDep", "p1Both", "prewarmOnly"],
		p1Both: [],
		prewarmOnly: [],
		elig: ["cliDep", "p1Both", "eligShellBoth", "eligOnly"],
		eligShellBoth: [],
		eligOnly: [],
		shell: ["cliDep", "eligShellBoth", "shellHttpBoth", "shellMainBoth", "shellOnly"],
		shellHttpBoth: [],
		shellMainBoth: [],
		shellOnly: [],
		stages: ["stagesOnly"],
		stagesOnly: [],
		http: ["shellHttpBoth", "httpOnly"],
		httpOnly: [],
		settingsStartup: ["settingsStartupOnly"],
		settingsStartupOnly: [],
		main: ["ownerA", "mainTop", "shellMainBoth", "http", "settingsStartup"],
		ownerA: ["ownerPrivate", "baseDep"],
		ownerPrivate: ["sharedThroughOwnerPrivate"],
		sharedThroughOwnerPrivate: [],
		baseDep: [],
		mainTop: ["midDep", "sharedThroughOwnerPrivate"],
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
				cli: ["cli"],
				prewarm: ["prewarm"],
				elig: ["elig"],
				shell: ["shell"],
				stages: ["stages"],
				http: ["http"],
				settingsStartup: ["settingsStartup"],
				main: ["main"],
				modeInteractive: ["interactive"],
				modeRpc: ["rpc"],
				sdk: ["sdk"],
			},
			(id) => graph[id] ?? [],
		);

	const g1 = run(baseGraph);
	assert.equal(g1.get("cliDep"), "p0-cli");
	assert.equal(g1.get("p1Both"), "p1-shared");
	assert.equal(g1.get("prewarmOnly"), "p1a-prewarm");
	assert.equal(g1.get("eligShellBoth"), "p1-elig-shell");
	assert.equal(g1.get("eligOnly"), "p1b-elig");
	assert.equal(g1.get("shellHttpBoth"), "p2-common");
	assert.equal(g1.get("shellMainBoth"), "p2-shell-main");
	assert.equal(g1.get("shellOnly"), "p2-shell");
	assert.equal(g1.get("stagesOnly"), "p3a-stages");
	assert.equal(g1.get("httpOnly"), "http");
	assert.equal(g1.get("settingsStartupOnly"), "settings-startup");
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
	// A module reached both through `ownerA -> ownerPrivate` and directly from `mainTop` MUST NOT be contracted into
	// `mainTop` (that would create a TDZ cycle through `ownerA`); it must stay in the base ownerMask=0 layer.
	assert.equal(g1.get("sharedThroughOwnerPrivate"), "startup-0-0");

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
	"dist/startup-files.json loads <= 30 dist/_shared chunks instead of ~130-170 Venn-diagram shards and keeps >= 8 startup stages",
	() => {
		const list = JSON.parse(readFileSync(join(DIST, "startup-files.json"), "utf8")) as {
			packages: [string, number][];
			files: [number, string][];
		};
		const sharedStartup = list.files
			.filter(([index, file]) => list.packages[index]?.[0] === "@bastani/atomic" && file.startsWith("dist/_shared/"))
			.map(([, file]) => file);
		assert.ok(
			sharedStartup.length <= 30,
			`expected <= 30 dist/_shared startup chunks, got ${sharedStartup.length}: ${sharedStartup.slice(0, 10).join(", ")}`,
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

builtTest("all emitted dist JS files form a strictly acyclic static import graph", () => {
	const importRe = /^(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gm;
	const graph = new Map<string, string[]>();
	const scan = (rel: string) => {
		const code = readFileSync(join(DIST, rel), "utf8");
		const deps: string[] = [];
		for (const m of code.matchAll(importRe)) {
			const spec = m[1];
			if (!spec?.startsWith(".")) continue;
			const resolved = posix.normalize(posix.join(posix.dirname(rel), spec));
			if (resolved.endsWith(".js")) deps.push(resolved);
		}
		graph.set(rel, [...new Set(deps)]);
	};
	for (const file of readdirSync(join(DIST, "_shared")).filter((f) => f.endsWith(".js"))) {
		scan(`_shared/${file}`);
	}
	const walk = (dir: string, prefix = "") => {
		for (const ent of readdirSync(dir, { withFileTypes: true })) {
			if (ent.name === "_shared" || ent.name === "builtin" || ent.name === "startup-stages") continue;
			const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
			if (ent.isDirectory()) walk(join(dir, ent.name), rel);
			else if (ent.name.endsWith(".js")) scan(rel);
		}
	};
	walk(DIST);
	const state = new Map<string, number>();
	const stack: string[] = [];
	const cycles: string[][] = [];
	const dfs = (u: string) => {
		state.set(u, 1);
		stack.push(u);
		for (const v of graph.get(u) ?? []) {
			if (!graph.has(v)) continue;
			const st = state.get(v) ?? 0;
			if (st === 1) cycles.push([...stack.slice(stack.indexOf(v)), v]);
			else if (st === 0) dfs(v);
		}
		stack.pop();
		state.set(u, 2);
	};
	for (const u of [...graph.keys()].sort()) {
		if ((state.get(u) ?? 0) === 0) dfs(u);
	}
	assert.deepEqual(
		cycles,
		[],
		`expected 0 static import cycles across ${graph.size} dist JS files, found: ${cycles
			.slice(0, 3)
			.map((c) => c.join(" -> "))
			.join("; ")}`,
	);
});

builtTest(
	"pre-editor phases, standalone http-dispatcher/settings-startup, main, and SDK preserve phase isolation and compat singletons",
	() => {
		const audit = (entry: string): { shared: string[]; files: number; kb: number; externals: string[] } => {
			const script = `import { registerHooks } from "node:module";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
const shared = [];
const externals = new Set();
let files = 0, bytes = 0;
registerHooks({
	load(url, ctx, next) {
		if (url.startsWith("file:")) {
			const p = fileURLToPath(url);
			files++; bytes += statSync(p).size;
			if (url.includes("/dist/_shared/")) shared.push(p.split(/[/\\\\]/).at(-1));
			const nm = p.replace(/\\\\/g, "/").match(/node_modules\\/((?:@[^/]+\\/)?[^/]+)/);
			if (nm) externals.add(nm[1]);
		}
		return next(url, ctx);
	},
});
await import(${JSON.stringify(pathToFileURL(join(DIST, entry)).href)});
console.log(JSON.stringify({ shared, files, kb: Math.round(bytes / 1024), externals: [...externals].sort() }));`;
			const res = spawnSyncCollect([process.execPath, "--input-type=module", "-e", script], {
				cwd: ROOT,
				env: { ...process.env, NODE_OPTIONS: "" },
				timeout: CHILD_TIMEOUT_MS,
			});
			assert.equal(res.exitCode, 0, res.stderr.toString());
			return JSON.parse(res.stdout.toString()) as {
				shared: string[];
				files: number;
				kb: number;
				externals: string[];
			};
		};

		const prewarm = audit("modes/interactive-engine/engine-prewarm.js");
		assert.equal(
			prewarm.shared.filter((f) => f.startsWith("startup-")).length,
			0,
			`engine-prewarm pulled startup-* chunks: ${prewarm.shared.join(", ")}`,
		);
		assert.ok(prewarm.kb <= 250, `expected engine-prewarm <= 250 KB, got ${prewarm.kb} KB`);

		const elig = audit("modes/interactive/startup-shell-eligibility.js");
		assert.equal(
			elig.shared.filter((f) => f.startsWith("startup-")).length,
			0,
			`startup-shell-eligibility pulled startup-* chunks: ${elig.shared.join(", ")}`,
		);
		assert.ok(elig.kb <= 400, `expected startup-shell-eligibility <= 400 KB, got ${elig.kb} KB`);

		const shell = audit("modes/interactive/startup-shell.js");
		assert.equal(
			shell.shared.filter((f) => f.startsWith("startup-")).length,
			0,
			`startup-shell pulled startup-* chunks: ${shell.shared.join(", ")}`,
		);
		assert.ok(
			shell.shared.length <= 6,
			`expected <= 6 dist/_shared chunks for startup-shell, got ${shell.shared.length}: ${shell.shared.join(", ")}`,
		);
		assert.ok(
			!shell.externals.includes("proper-lockfile"),
			`standalone startup-shell must not pull proper-lockfile: ${shell.externals.join(", ")}`,
		);

		const http = audit("core/http-dispatcher.js");
		assert.equal(
			http.shared.filter((f) => f.startsWith("startup-") || f.startsWith("p2-shell")).length,
			0,
			`core/http-dispatcher pulled startup/shell chunks: ${http.shared.join(", ")}`,
		);
		assert.ok(
			http.shared.length <= 4,
			`expected <= 4 dist/_shared chunks for http-dispatcher, got ${http.shared.length}`,
		);

		const settingsStartup = audit("cli/settings-startup.js");
		assert.equal(
			settingsStartup.shared.filter((f) => f.startsWith("startup-")).length,
			0,
			`cli/settings-startup pulled startup-* chunks: ${settingsStartup.shared.join(", ")}`,
		);
		assert.ok(settingsStartup.kb <= 100, `expected cli/settings-startup <= 100 KB, got ${settingsStartup.kb} KB`);

		const main = audit("main.js");
		assert.ok(main.shared.length <= 25, `expected <= 25 dist/_shared chunks for main.js, got ${main.shared.length}`);

		// Importing the SDK entry must never execute rpc-entry (which would launch RPC mode and hang).
		const sdk = audit("index.js");
		assert.ok(sdk.shared.length <= 32, `expected <= 32 dist/_shared chunks for index.js, got ${sdk.shared.length}`);

		// Compat shared file for compile-cache-warmup-host must re-export the exact same bundled singleton as p0-cli,
		// not a duplicate copy from dist/utils/compile-cache-warmup-host.js.
		const singletonScript = `import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const dir = ${JSON.stringify(join(DIST, "_shared"))};
const p0 = readdirSync(dir).find((f) => f.startsWith("p0-cli-") && f.endsWith(".js"));
const compat = await import(pathToFileURL(dir + "/compile-cache-warmup-host-OQZHHQ2Z.js").href);
const p0Mod = await import(pathToFileURL(dir + "/" + p0).href);
const threadMod = await import(${JSON.stringify(pathToFileURL(join(DIST, "utils/compile-cache-warmup-host.js")).href)});
console.log(JSON.stringify({ sameAsBundled: compat.warmCompileCache === p0Mod.warmCompileCache, distinctFromThread: compat.warmCompileCache !== threadMod.warmCompileCache }));`;
		const sRes = spawnSyncCollect([process.execPath, "--input-type=module", "-e", singletonScript], {
			cwd: ROOT,
			env: { ...process.env, NODE_OPTIONS: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(sRes.exitCode, 0, sRes.stderr.toString());
		assert.deepEqual(JSON.parse(sRes.stdout.toString()), {
			sameAsBundled: true,
			distinctFromThread: true,
		});
	},
	CHILD_TIMEOUT_MS,
);
