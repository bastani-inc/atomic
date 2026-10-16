import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager, ModelRuntime } from "../../packages/coding-agent/dist/index.js";

// #3105: timers are released only by owned shutdown, never by the fixture finalizer.
const mode = process.argv[2];
const cwd = mkdtempSync(join(tmpdir(), "sdk-filtered-acquisition-"));
const settingsManager = SettingsManager.inMemory({ sessionSummary: { enabled: false } });
const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth"), modelsPath: null, allowModelNetwork: false });
const active = new Map();
const stopped = [], started = [];
let calls = 0;
let omittedCalls = 0;
const writes = new Map();
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: cwd, settingsManager, noExtensions: true,
  extensionFactories: ["keep", "omit"].map(name => pi => {
    active.set(name, setInterval(() => {}, 60_000));
    writes.set(name, () => pi.setSessionName("omitted-write"));
    pi.events.on("selected-ping", () => { if (name === "keep") calls++; else omittedCalls++; });
    pi.registerCommand(name, { description: name, handler: async (_args, ctx) => {
      await pi.setSessionName("selected"); assert.ok(ctx.getAgentTaskHost()); pi.events.emit("selected-ping");
    } });
    pi.on("session_start", () => { started.push(name); if (mode === "startup") throw new Error("selected startup failed"); });
    pi.on("session_shutdown", () => {
      clearInterval(active.get(name)); active.delete(name); stopped.push(name);
      if (mode === "cleanup" && name === "omit") throw new Error("omitted cleanup failed");
    });
  }),
  extensionsOverride: base => ({ ...base, extensions: mode === "all" ? base.extensions : base.extensions.slice(0, mode === "none" ? 0 : 1) }),
});
const messages = error => error instanceof AggregateError ? error.errors.map(messages).join(";") : String(error);
let session;
try {
  const creation = createAgentSession({ cwd, agentDir: cwd, settingsManager, modelRuntime, resourceLoader,
    sessionManager: SessionManager.inMemory(cwd), tools: [], builtins: { workflows: false, subagents: false, mcp: false, intercom: false, "web-access": false } });
  if (mode === "startup" || mode === "cleanup") {
    await assert.rejects(creation, error => {
      if (mode === "cleanup") assert.equal(error.code, "ShutdownFailed");
      assert.match(messages(error), mode === "cleanup" ? /omitted cleanup failed/ : /selected startup failed/);
      return true;
    });
  } else {
    ({ session } = await creation);
    assert.deepEqual(started, mode === "none" ? [] : mode === "all" ? ["keep", "omit"] : ["keep"]);
    assert.deepEqual(session.extensionRunner.getRegisteredCommands().map(command => command.name), started);
    if (mode !== "all") await assert.rejects(writes.get("omit"), /stale|no longer active/i);
    if (mode !== "none") {
      await session.prompt("/keep"); assert.equal(session.sessionManager.getSessionName(), "selected"); assert.equal(calls, 1);
      assert.equal(omittedCalls, mode === "all" ? 1 : 0);
    }
    await session.dispose();
  }
  assert.deepEqual([...active.keys()], []);
  assert.deepEqual(stopped.sort(), ["keep", "omit"]);
  console.log(JSON.stringify({ mode, verified: true, started, stopped }));
} finally {
  await session?.dispose();
  rmSync(cwd, { recursive: true, force: true });
}
