// natural vs staged, alternating: time from the end of cli.js's prefix imports until the entry modules are loaded.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const mode = process.argv[2];
if (!mode) {
	const modes = ["natural", "staged", "requireNoYield", "importYield"];
	const rows = Object.fromEntries(modes.map((m) => [m, []]));
	for (let i = 0; i < 12; i++)
		for (const m of i % 2 ? [...modes].reverse() : modes) {
			const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
			const v = JSON.parse(r.stdout.trim().split("\n").at(-1));
			rows[m].push(v);
		}
	const med = (xs, f) => xs.map((x) => x[f]).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
	for (const m of modes) console.log(`W7BENCH ${process.platform} ${m} ms=${med(rows[m], "ms")} cpu=${med(rows[m], "cpu")} inStages=${med(rows[m], "inStages")}`);
	const deltas = rows.staged.map((s, i) => s.ms - rows.natural[i].ms).sort((a, b) => a - b);
	console.log(`W7BENCH ${process.platform} paired-delta-median=${deltas[6]} range=${deltas[0]}..${deltas.at(-1)}`);
	process.exit(0);
}
const { cliImports } = await import(new URL("../packages/coding-agent/scripts/startup-stages-source.mjs", import.meta.url).href);
const imports = cliImports(fileURLToPath(new URL("../packages/coding-agent/dist", import.meta.url)));
for (const url of imports.before) await import(url);
const t0 = performance.now();
const c0 = process.cpuUsage();
let inStages = 0;
if (mode === "staged") await (await import(imports.loader)).loadStartupStages();
if (mode === "requireNoYield" || mode === "importYield") {
	const { createRequire } = await import("node:module");
	const { readFileSync } = await import("node:fs");
	const dir = new URL("../startup-stages/", imports.loader);
	const count = JSON.parse(readFileSync(new URL("stages.json", dir), "utf8")).stages;
	const req = createRequire(imports.loader);
	for (let i = 0; i < count; i++) {
		const t = performance.now();
		if (mode === "requireNoYield") req(fileURLToPath(new URL(`${i}.js`, dir)));
		else {
			await import(new URL(`${i}.js`, dir).href);
			await new Promise((r) => setImmediate(r));
		}
		inStages += performance.now() - t;
	}
}
await Promise.all(imports.entries.map((u) => import(u)));
const cu = process.cpuUsage(c0);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), cpu: Math.round((cu.user + cu.system) / 1000), inStages: Math.round(inStages) }));
process.exit(0);
