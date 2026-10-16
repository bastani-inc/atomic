import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "../../packages/coding-agent/dist/index.js";

// #3105: selected and omitted factory lifetimes stay independent across reload.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-filtered-reload-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const records = [];
let generation = 0;
const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true,
  extensionFactories: ["keep", "omit"].map(name => pi => {
    if (name === "keep") generation++;
    const record = { name, generation, calls: 0, stops: 0, write: () => pi.setSessionName(`selected-${generation}`), timer: setInterval(() => {}, 60_000) };
    records.push(record);
    pi.events.on("selected-ping", () => { record.calls++; });
    pi.registerCommand(name, { description: name, handler: async (_args, ctx) => {
      await record.write(); assert.ok(ctx.getAgentTaskHost()); pi.events.emit("selected-ping");
    } });
    pi.on("session_shutdown", () => {
      record.stops++; clearInterval(record.timer);
      if (mode === "cleanup" && record.generation === 2 && name === "omit") throw new Error("omitted reload cleanup failed");
    });
  }),
  extensionsOverride: base => ({ ...base, extensions: mode === "all" ? base.extensions : base.extensions.slice(0, mode === "none" ? 0 : 1) }),
});
let session;
try {
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } }));
  const reload = session.reload({ beforeSessionStart: async () => { if (mode === "rollback") throw new Error("candidate rejected"); } });
  if (mode === "rollback" || mode === "cleanup") {
    await assert.rejects(reload, mode === "rollback" ? /candidate rejected/ : { code: "ShutdownFailed" });
    assert.equal(records.find(r => r.generation === 1 && r.name === "keep").stops, 0);
    for (const record of records.filter(r => r.generation === 2)) {
      assert.equal(record.stops, 1); await assert.rejects(record.write, /stale|no longer active/i);
    }
  } else await reload;
  if (mode !== "none") {
    await session.prompt("/keep");
    const current = mode === "rollback" || mode === "cleanup" ? 1 : 2;
    assert.equal(records.find(r => r.generation === current && r.name === "keep").calls, 1);
    assert.equal(records.find(r => r.generation === current && r.name === "omit").calls, mode === "all" ? 1 : 0);
  }
  for (const record of records.filter(r => r.stops > 0)) await assert.rejects(record.write, /stale|no longer active/i);
} finally {
  await session?.dispose().catch(error => { assert.equal(mode, "cleanup"); assert.equal(error.code, "ShutdownFailed"); });
  rmSync(cwd, { recursive: true, force: true });
}
assert.ok(records.every(r => r.stops === 1));
console.log(JSON.stringify({ mode, verified: true }));
