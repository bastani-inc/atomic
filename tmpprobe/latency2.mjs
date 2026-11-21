const dist = process.argv[2];
const { startupFilePaths } = await import(new URL("utils/startup-prefetch-reader.js", dist).href);
const { readFile, stat } = await import("node:fs/promises");
const { fileURLToPath } = await import("node:url");
const { modules } = await startupFilePaths(fileURLToPath(new URL("startup-files.json", dist)), fileURLToPath(new URL("..", dist)));
const last = modules.slice(-16);
for (let rep = 0; rep < 5; rep++) {
  const times = [];
  for (const p of last) { const t = performance.now(); try { await stat(p); await readFile(p); } catch {} times.push(performance.now() - t); }
  times.sort((a, b) => a - b);
  console.log(`W7SEQ median=${times[7].toFixed(3)} p90=${times[14].toFixed(3)} max=${times[15].toFixed(3)}`);
}
