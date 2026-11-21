// Diagnostic preload: logs stdin activity of the process with timestamps to W7SM_STDIN_LOG.
const fs = require("node:fs");
const out = process.env.W7SM_STDIN_LOG;
if (out && !process.argv.some((a) => a.startsWith("--internal-"))) {
  const t0 = Date.now();
  const log = (what) => { try { fs.appendFileSync(out, `${Date.now() - t0} ${what}\n`); } catch {} };
  log(`start pid=${process.pid} argv=${process.argv.slice(2).join(" ")}`);
  const stdin = process.stdin;
  const emit = stdin.emit;
  stdin.emit = function (event, ...args) {
    if (event === "data") log(`data ${JSON.stringify(String(args[0])).slice(0, 40)}`);
    return emit.call(this, event, ...args);
  };
  for (const name of ["pause", "resume", "setRawMode", "setEncoding"]) {
    const orig = stdin[name];
    if (typeof orig === "function") stdin[name] = function (...args) { log(`${name}(${args.join(",")}) ${new Error().stack.split("\n").slice(2, 4).map((s) => s.trim().replace(/^at /, "")).join(" <- ").slice(0, 200)}`); return orig.apply(this, args); };
  }
  const on = stdin.on;
  stdin.on = function (event, ...args) { if (event === "data" || event === "readable") log(`on(${event})`); return on.call(this, event, ...args); };
  const off = stdin.off ?? stdin.removeListener;
  stdin.removeListener = function (event, ...args) { if (event === "data") log(`removeListener(${event})`); return off.call(this, event, ...args); };
  stdin.off = stdin.removeListener;
}
