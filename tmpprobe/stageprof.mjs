// CPU profiles of natural vs staged (bench child), several runs each; prints the functions whose self time differs most.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const bench = fileURLToPath(new URL("./stagebench.mjs", import.meta.url));
const totals = { natural: new Map(), staged: new Map() };
const runs = 6;
for (let i = 0; i < runs; i++)
	for (const mode of ["natural", "staged"]) {
		const dir = mkdtempSync(join(tmpdir(), "w7prof-"));
		spawnSync(process.execPath, ["--cpu-prof", `--cpu-prof-dir=${dir}`, bench, mode], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
		const file = readdirSync(dir).find((f) => f.endsWith(".cpuprofile"));
		const p = JSON.parse(readFileSync(join(dir, file), "utf8"));
		const nodes = new Map(p.nodes.map((n) => [n.id, n]));
		for (let k = 0; k < p.samples.length; k++) {
			const n = nodes.get(p.samples[k]);
			const cf = n.callFrame;
			const key = `${cf.functionName || "(anon)"} ${cf.url.split("/").at(-1)}:${cf.lineNumber}`;
			totals[mode].set(key, (totals[mode].get(key) ?? 0) + p.timeDeltas[k] / 1000 / runs);
		}
	}
const keys = new Set([...totals.natural.keys(), ...totals.staged.keys()]);
const diffs = [...keys].map((k) => [k, (totals.staged.get(k) ?? 0) - (totals.natural.get(k) ?? 0), totals.natural.get(k) ?? 0, totals.staged.get(k) ?? 0]);
diffs.sort((a, b) => b[1] - a[1]);
const sum = (m) => [...m.values()].reduce((a, b) => a + b, 0);
console.log(`W7PROF total natural=${sum(totals.natural).toFixed(0)} staged=${sum(totals.staged).toFixed(0)} ms (per run, whole process)`);
for (const [k, d, n, s] of diffs.slice(0, 25)) console.log(`W7PROF +${d.toFixed(1)} (${n.toFixed(1)} -> ${s.toFixed(1)}) ${k}`);
