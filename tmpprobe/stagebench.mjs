// natural vs staged, alternating: time from the end of cli.js's prefix imports until the entry modules are loaded.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const mode = process.argv[2];
if (!mode) {
	const rows = { natural: [], staged: [] };
	for (let i = 0; i < 12; i++)
		for (const m of i % 2 ? ["staged", "natural"] : ["natural", "staged"]) {
			const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), m], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
			const v = JSON.parse(r.stdout.trim().split("\n").at(-1));
			rows[m].push(v);
		}
	const med = (xs, f) => xs.map((x) => x[f]).sort((a, b) => a - b)[Math.floor(xs.length / 2)];
	for (const m of ["natural", "staged"]) console.log(`W7BENCH ${process.platform} ${m} ms=${med(rows[m], "ms")} cpu=${med(rows[m], "cpu")}`);
	const deltas = rows.staged.map((s, i) => s.ms - rows.natural[i].ms).sort((a, b) => a - b);
	console.log(`W7BENCH ${process.platform} paired-delta-median=${deltas[6]} range=${deltas[0]}..${deltas.at(-1)}`);
	process.exit(0);
}
const { cliImports } = await import(new URL("../packages/coding-agent/scripts/startup-stages-source.mjs", import.meta.url).href);
const imports = cliImports(fileURLToPath(new URL("../packages/coding-agent/dist", import.meta.url)));
for (const url of imports.before) await import(url);
const t0 = performance.now();
const c0 = process.cpuUsage();
if (mode === "staged") await (await import(imports.loader)).loadStartupStages();
await Promise.all(imports.entries.map((u) => import(u)));
const cu = process.cpuUsage(c0);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), cpu: Math.round((cu.user + cu.system) / 1000) }));
process.exit(0);
