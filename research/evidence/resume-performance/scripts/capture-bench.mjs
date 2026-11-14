// Times captureWorktreeSnapshot on a checkout: full, unchanged (no-op turn), and incremental after a one-file edit.
const { captureWorktreeSnapshot } = await import(`${process.env.ATOMIC_REPO ?? "/fast/github_work/atomic-wt/resume-perf"}/packages/coding-agent/dist/core/worktree-snapshot/index.js`);
import { appendFileSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2]; const file = process.argv[3] ?? "README.md"; const reps = Number(process.argv[4] ?? 5);
const t = async (f) => { const s = performance.now(); const r = await f(); return [performance.now() - s, r]; };
const original = readFileSync(join(dir, file));
const rows = { full: [], unchanged: [], incremental: [] };
try {
  for (let i = 0; i < reps; i++) {
    const [a, c1] = await t(() => captureWorktreeSnapshot(dir));
    if (c1.status !== "captured" && c1.status !== "unchanged") throw new Error(JSON.stringify(c1));
    const [b, c2] = await t(() => captureWorktreeSnapshot(dir, { previous: c1.snapshot }));
    appendFileSync(join(dir, file), `\nresume-perf edit ${i}\n`);
    const [c, c3] = await t(() => captureWorktreeSnapshot(dir, { previous: c1.snapshot }));
    rows.full.push(a); rows.unchanged.push(b); rows.incremental.push(c);
    if (i === 0) console.error(`statuses: ${c1.status} ${c2.status} ${c3.status}`);
  }
} finally { writeFileSync(join(dir, file), original); }
const med = (xs) => xs.sort((x, y) => x - y)[Math.floor(xs.length / 2)];
console.log(JSON.stringify({ dir, reps, median_ms: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, Math.round(med(v))])) }));
